import {
  type HostStatusEntry,
  type ModelSelection,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { choosePlacement, type PlacementCandidate } from "../../channels/channelPlacement.ts";
import { isTerminalPhase } from "../../mcp/threadStatus.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { readLocalStatus, readRemoteStatus, type FleetThreadRef } from "./Health.ts";
import { HostHealthMonitor } from "./HostHealthMonitor.ts";
import { isSchedulable } from "./hostHealthModel.ts";
import {
  fenceNote,
  MAX_ATTEMPTS_PER_WORKER,
  resumeNote,
  type RescheduleReason,
} from "./reschedulePolicy.ts";

export type { RescheduleReason } from "./reschedulePolicy.ts";

/** "goal:<id>" or "thread:<id>". */
export type FleetOwnerKey = string;

export interface RescheduleRequest {
  readonly ref: FleetThreadRef;
  readonly owner: FleetOwnerKey;
  /** Fencing token of the attempt being replaced. */
  readonly attempt: number;
  readonly reason: RescheduleReason;
  readonly modelSelection: ModelSelection;
  /** The next attempt's worktree; branch is new per attempt. */
  readonly workspace: {
    readonly baseRef: string;
    readonly branch: string;
    readonly startFromOrigin: boolean;
  };
  /** The replaced attempt's pushed branch, when it has one on origin. */
  readonly previousBranch: string | null;
  readonly replica: { readonly ref: string; readonly commitOid: string } | null;
  readonly prompt: string;
  /** Already clamped to the owner's ceiling. */
  readonly runtimeMode: RuntimeMode;
  readonly clientRequestId: string;
  /** The project, so the same repository is found on the target. */
  readonly project?: { readonly cwd: string; readonly canonicalKey: string | null };
  /** A person's choice of destination; otherwise placement chooses. */
  readonly targetHost?: string | null;
  /** Skip only the wait for an unreachable host to be Lost. */
  readonly force?: boolean;
}

export type RescheduleRefusal =
  | "no_capacity"
  | "host_still_answers"
  | "budget"
  | "no_resume_point"
  | "unsupported_remote";

export type RescheduleResult =
  | {
      readonly _tag: "Rescheduled";
      readonly host: string | null;
      readonly threadId: ThreadId;
      readonly branch: string;
      readonly resumedFrom: "branch" | "replica" | "base";
    }
  | { readonly _tag: "Refused"; readonly reason: RescheduleRefusal; readonly message: string };

export interface ReschedulerShape {
  readonly reschedule: (request: RescheduleRequest) => Effect.Effect<RescheduleResult>;
}

/** Moves one attempt to another host (agentic-k8s.md "Resume from the branch or a replica"). */
export class Rescheduler extends Context.Service<Rescheduler, ReschedulerShape>()(
  "goat/fleet/health/Rescheduler",
) {}

const REMOTE_TIMEOUT_MS = 15_000;

const decodeThreadList = Schema.decodeUnknownEffect(
  Schema.Struct({
    threads: Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
  }),
);
const decodeProjects = Schema.decodeUnknownEffect(
  Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        workspaceRoot: Schema.String,
        repositoryIdentity: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
);

const canonicalKeyOf = (identity: unknown) => {
  if (typeof identity !== "object" || identity === null) return null;
  const key = (identity as { readonly canonicalKey?: unknown }).canonicalKey;
  return typeof key === "string" ? key : null;
};

/** The new thread's title: the attempt branch, so a retry can find a launch whose answer was lost. */
export const attemptTitle = (branch: string) => "Resume " + branch;

const refused = (reason: RescheduleRefusal, message: string): RescheduleResult => ({
  _tag: "Refused",
  reason,
  message,
});

const quotaWindows = (sample: HostStatusEntry | null, instanceId: string) => {
  const quota = sample?.metrics?.quotas.find((entry) => entry.instanceId === instanceId);
  if (quota === undefined || quota.limits.windows.length === 0) return null;
  return quota.limits.windows.map((window) => ({
    label: window.label,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
  }));
};

export const make = Effect.gen(function* () {
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const monitor = yield* HostHealthMonitor;
  const context = yield* Effect.context<
    | SshRemoteDispatch.SshRemoteDispatch
    | HostHealthMonitor
    | import("../../orchestration-v2/ThreadManagementService.ts").ThreadManagementService
  >();
  // One move at a time: a retry of the same request waits for the first and then finds its thread.
  const lock = yield* Semaphore.make(1);

  const call = (
    host: string,
    tool: string,
    args: Record<string, unknown>,
    writes: boolean,
    ceiling: RuntimeMode,
  ) =>
    dispatch
      .callHostTool(
        { host, tool, arguments: args, writes, timeoutMs: REMOTE_TIMEOUT_MS },
        Effect.succeed(ceiling),
      )
      .pipe(
        Effect.flatMap((raw) => {
          const result = SshRemoteDispatch.readRemoteToolResult(tool, raw);
          return result.ok
            ? Effect.succeed(result.value)
            : Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "remote_refused",
                  message: result.message,
                }),
              );
        }),
      );

  const schedulableHosts = (exclude: string | null) =>
    Effect.gen(function* () {
      // Connected hosts that were never contacted are Unknown; reading their conditions probes them.
      const known = yield* monitor.known;
      const connected = yield* dispatch.connectedHosts;
      const samples = new Map(known.map((entry) => [entry.host, entry.sample] as const));
      const hosts: Array<{ readonly host: string; readonly sample: HostStatusEntry | null }> = [];
      for (const host of new Set([...samples.keys(), ...connected])) {
        if (host === exclude) continue;
        const set = yield* monitor.conditions(host);
        if (!isSchedulable(set.conditions)) continue;
        const sample = (yield* monitor.known).find((entry) => entry.host === host)?.sample ?? null;
        hosts.push({ host, sample });
      }
      return hosts;
    });

  /** A thread this request already launched, found by its title on any candidate host. */
  const findLaunched = (hosts: ReadonlyArray<string>, title: string, ceiling: RuntimeMode) =>
    Effect.forEach(
      hosts,
      (host) =>
        call(
          host,
          "goat_thread_list",
          { allProjects: true, titleContains: title, limit: 20 },
          false,
          ceiling,
        ).pipe(
          Effect.flatMap(decodeThreadList),
          Effect.map((listed) => listed.threads.find((thread) => thread.title === title)),
          Effect.map((thread) =>
            thread === undefined ? null : { host, threadId: thread.threadId },
          ),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((found) => found.find((entry) => entry !== null) ?? null));

  const targetCwd = (request: RescheduleRequest, host: string) => {
    const project = request.project;
    if (project === undefined) return Effect.succeed(null);
    if (project.canonicalKey === null) return Effect.succeed(project.cwd);
    return call(host, "goat_project_list", { limit: 100 }, false, request.runtimeMode).pipe(
      Effect.flatMap(decodeProjects),
      Effect.map(
        (listed) =>
          listed.projects.find(
            (entry) => canonicalKeyOf(entry.repositoryIdentity) === project.canonicalKey,
          )?.workspaceRoot ?? project.cwd,
      ),
      Effect.orElseSucceed(() => project.cwd),
    );
  };

  /**
   * Work leaves a host only when the host is Lost, or answers and its attempt is confirmed
   * stopped. Null means the move may go ahead.
   */
  const gate = (request: RescheduleRequest) =>
    Effect.gen(function* () {
      const host = request.ref.host;
      const conditions = new Set(
        (yield* monitor.conditions(host)).conditions.map((condition) => condition.type),
      );
      if (conditions.has("Lost")) return null;
      if (conditions.has("Unreachable")) {
        return request.force === true
          ? null
          : refused(
              "host_still_answers",
              (host ?? "This machine") +
                " is unreachable but not Lost yet; work moves after 5 minutes.",
            );
      }
      if (request.reason === "host_unreachable") {
        return refused(
          "host_still_answers",
          (host ?? "This machine") + " answers again, so its work stays.",
        );
      }
      const status =
        host === null
          ? yield* readLocalStatus(request.ref.threadId)
          : yield* readRemoteStatus(host, request.ref.threadId, request.runtimeMode);
      if (status === null) {
        return refused(
          "host_still_answers",
          "Could not confirm the attempt stopped on " + (host ?? "this machine") + ".",
        );
      }
      if (isTerminalPhase(status.phase) || status.phase === "idle") return null;
      if (host === null) {
        return refused(
          "host_still_answers",
          "The attempt is still running on this machine; stop it first.",
        );
      }
      yield* call(
        host,
        "goat_thread_interrupt",
        {
          threadId: request.ref.threadId,
          reason: "GOAT is moving this work to another host.",
          clientRequestId: request.clientRequestId + ":interrupt",
        },
        true,
        request.runtimeMode,
      ).pipe(Effect.ignore);
      return refused(
        "host_still_answers",
        "Interrupt requested on " +
          host +
          "; the move happens on the next reschedule once it stops.",
      );
    });

  const reschedule: ReschedulerShape["reschedule"] = (request) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const from = request.ref.host;
        const newBranch = request.workspace.branch;
        const title = attemptTitle(newBranch);
        const resumedFrom =
          request.previousBranch !== null
            ? "branch"
            : request.replica !== null
              ? "replica"
              : "base";
        const candidates = yield* schedulableHosts(from);
        const requested = request.targetHost ?? null;
        const lookIn = [
          ...new Set([
            ...(requested === null ? [] : [requested]),
            ...candidates.map((entry) => entry.host),
          ]),
        ];
        const already = yield* findLaunched(lookIn, title, request.runtimeMode);
        if (already !== null) {
          return {
            _tag: "Rescheduled",
            host: already.host,
            threadId: already.threadId,
            branch: newBranch,
            resumedFrom,
          } satisfies RescheduleResult;
        }
        if (request.attempt >= MAX_ATTEMPTS_PER_WORKER) {
          return refused(
            "budget",
            "Attempt " + request.attempt + " was the last of " + MAX_ATTEMPTS_PER_WORKER + ".",
          );
        }
        const blocked = yield* gate(request);
        if (blocked !== null) return blocked;
        if (resumedFrom === "replica") {
          // Replica import at the destination lands with replica capture for goal attempts.
          return refused(
            "no_resume_point",
            "Resuming from a replica is not supported yet; push the branch or resume from base.",
          );
        }
        const baseRef = request.previousBranch ?? request.workspace.baseRef;

        let target = requested;
        if (target === null) {
          const now = yield* Clock.currentTimeMillis;
          const scored: Array<PlacementCandidate<string>> = candidates
            .filter((entry) => entry.sample?.reachability === "ok")
            .map((entry) => ({
              value: entry.host,
              host: entry.host,
              providerLabel: request.modelSelection.instanceId,
              preferred: false,
              windows: quotaWindows(entry.sample, request.modelSelection.instanceId),
              activeTasks: entry.sample?.metrics?.threads.running ?? 0,
            }));
          target = choosePlacement(scored, now)?.chosen.value ?? null;
        } else if (!isSchedulable((yield* monitor.conditions(target)).conditions)) {
          return refused(
            "no_capacity",
            target + " is not Ready or is cordoned; read goat_host_status.",
          );
        }
        if (target === null)
          return refused("no_capacity", "No Ready, uncordoned host can take the work.");
        const cwd = yield* targetCwd(request, target);
        if (cwd === null) return refused("no_resume_point", "The request names no project folder.");

        const launched = yield* dispatch
          .launchThread(
            {
              host: target,
              cwd,
              workspace: {
                type: "worktree",
                branch: newBranch,
                baseRef,
                startFromOrigin: request.workspace.startFromOrigin,
              },
              title,
              message: [
                request.prompt,
                "",
                resumeNote({
                  fromHost: from ?? "this machine",
                  fromThreadId: request.ref.threadId,
                  fromBranch: request.previousBranch,
                  resumedFrom,
                  newBranch,
                  reason: request.reason,
                }),
              ].join("\n"),
              modelSelection: request.modelSelection,
              runtimeMode: request.runtimeMode,
              callerRuntimeMode: request.runtimeMode,
            },
            Effect.void,
          )
          .pipe(Effect.result);
        if (launched._tag === "Failure") {
          const error = launched.failure;
          yield* Effect.logWarning("fleet.reschedule.launch_failed", {
            owner: request.owner,
            target,
            reason: error.reason,
          });
          return refused(
            error.reason === "remote_refused" && /worktree/i.test(error.message)
              ? "unsupported_remote"
              : "no_capacity",
            "Launch on " +
              target +
              " failed: " +
              Array.from(error.message).slice(0, 300).join("") +
              (error.launchMayHaveStarted === true
                ? " It may have started; the next reschedule finds it."
                : ""),
          );
        }
        yield* Effect.logInfo("fleet.reschedule", {
          owner: request.owner,
          from,
          to: target,
          branch: newBranch,
          reason: request.reason,
        });
        return {
          _tag: "Rescheduled",
          host: target,
          threadId: ThreadId.make(launched.success.threadId),
          branch: newBranch,
          resumedFrom,
        } satisfies RescheduleResult;
      }).pipe(Effect.provideContext(context)),
    );

  return Rescheduler.of({ reschedule });
});

export const layer = Layer.effect(Rescheduler, make);

/**
 * Stops a superseded attempt whose host came back: one interrupt whose reason says where the work
 * went. No message is sent, since a message would start another turn there. clientRequestId makes
 * a repeat a no-op on the remote. Fails when the host does not answer; call again later.
 */
export const fenceStaleAttempt = (input: {
  readonly ref: FleetThreadRef & { readonly host: string };
  readonly successorHost: string;
  readonly successorBranch: string;
  readonly clientRequestId: string;
  readonly ceiling: RuntimeMode;
}) =>
  Effect.gen(function* () {
    const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
    yield* dispatch.callHostTool(
      {
        host: input.ref.host,
        tool: "goat_thread_interrupt",
        arguments: {
          threadId: input.ref.threadId,
          reason: fenceNote({
            successorHost: input.successorHost,
            successorBranch: input.successorBranch,
          }),
          clientRequestId: input.clientRequestId,
        },
        writes: true,
        timeoutMs: REMOTE_TIMEOUT_MS,
      },
      Effect.succeed(input.ceiling),
    );
  });
