import {
  OrchestratorMcpThreadStatusResult,
  type FleetWorkerView,
  type GoatThreadRescheduleResult,
  type HostStatusEntry,
  type ModelSelection,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { choosePlacement, type PlacementCandidate } from "../../channels/channelPlacement.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import * as FleetHealthStore from "./FleetHealthStore.ts";
import { Health } from "./HostHealthMonitor.ts";
import {
  backoffDelayMs,
  decide,
  fenceText,
  pushRequestText,
  RESCHEDULE_BUDGET,
  restartText,
  resumeBranchFor,
  resumePrompt,
  steerText,
  workerIdFor,
  type RescheduleDecision,
  type RescheduleReason,
} from "./reschedulePolicy.ts";
import { detectStall } from "./threadStallModel.ts";

type FleetWorker = FleetHealthStore.FleetWorker;

/** How often one worker's thread is read; the scheduler ticks every 5 s. */
export const CHECK_INTERVAL_MS = 30_000;
/** Remote side effects (sends, interrupts, launches) per tick, across all workers. */
export const MAX_ACTIONS_PER_TICK = 4;
/** How long the old thread gets to push before the move goes ahead without it. */
export const PUSH_GRACE_MS = 10 * 60_000;
const REMOTE_TIMEOUT_MS = 15_000;
/** Kill switch for every self-healing action; cordons stay readable. */
export const SELF_HEAL_ENV = "GOAT_FLEET_SELF_HEAL";

export class RescheduleError extends Data.TaggedError("RescheduleError")<{
  readonly code: "not_found" | "invalid_request";
  readonly message: string;
}> {}

class LauncherGone extends Data.TaggedError("FleetLauncherGone")<{}> {}

export interface WorkerRegistration {
  readonly launcherThreadId: ThreadId | null;
  readonly ceiling: RuntimeMode;
  readonly host: string;
  readonly threadId: ThreadId;
  readonly branch: string;
  readonly cwd: string;
  readonly title: string;
  readonly message: string | null;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
}

export interface ReschedulerShape {
  /** Idempotent: the same host and thread always name the same worker. */
  readonly register: (input: WorkerRegistration) => Effect.Effect<FleetWorkerView>;
  readonly reschedule: (input: {
    readonly host: string;
    readonly threadId: ThreadId;
    readonly targetHost: string | null;
    readonly reason: string;
  }) => Effect.Effect<GoatThreadRescheduleResult, RescheduleError>;
  readonly workersOn: (host: string) => Effect.Effect<ReadonlyArray<FleetWorkerView>>;
  /** One reconcile pass over every worker; registered on the shared Scheduler. */
  readonly tick: Effect.Effect<void>;
}

export class Rescheduler extends Context.Service<Rescheduler, ReschedulerShape>()(
  "goat/fleet/health/Rescheduler",
) {}

const decodeStatus = Schema.decodeUnknownEffect(OrchestratorMcpThreadStatusResult);
// Only what launch recovery reads, so a newer or older remote list still decodes.
const decodeThreadList = Schema.decodeUnknownEffect(
  Schema.Struct({
    threads: Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
  }),
);
const decodeProjects = Schema.decodeUnknownEffect(
  Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        id: Schema.String,
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

const shaFrom = (text: string | undefined) => text?.match(/\b[0-9a-f]{7,40}\b/u)?.[0] ?? null;

export const movedTitle = (title: string, generation: number) => title + " · r" + generation;

const quotaWindows = (sample: HostStatusEntry | null, instanceId: string | undefined) => {
  const quota = sample?.metrics?.quotas.find((entry) => entry.instanceId === instanceId);
  if (quota === undefined || quota.limits.windows.length === 0) return null;
  return quota.limits.windows.map((window) => ({
    label: window.label,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
  }));
};

export const make = Effect.gen(function* () {
  const store = yield* FleetHealthStore.FleetHealthStore;
  const health = yield* Health;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // Ticks and manual moves never interleave, so one move cannot be decided twice.
  const acting = yield* Semaphore.make(1);
  const lastChecked = new Map<string, number>();
  const lastFenceTry = new Map<string, number>();
  const keyLookups = new Set<string>();

  const enabled = Effect.sync(() => {
    const value = process.env[SELF_HEAL_ENV]?.trim().toLowerCase();
    return value !== "0" && value !== "false" && value !== "off";
  });

  /** The launcher's runtime mode now, or the outside caller's approved one; never more. */
  const authorize = (worker: FleetWorker) =>
    worker.launcherThreadId === null
      ? Effect.succeed<RuntimeMode>(worker.ceiling)
      : threads.getThreadShell(worker.launcherThreadId).pipe(
          Effect.mapError(() => new LauncherGone()),
          Effect.flatMap((shell): Effect.Effect<RuntimeMode, LauncherGone> =>
            shell === null || shell.deletedAt !== null || shell.archivedAt !== null
              ? Effect.fail(new LauncherGone())
              : Effect.succeed(shell.runtimeMode),
          ),
        );

  const call = (
    worker: FleetWorker,
    host: string,
    tool: string,
    args: Record<string, unknown>,
    writes: boolean,
  ) =>
    dispatch
      .callHostTool(
        { host, tool, arguments: args, writes, timeoutMs: REMOTE_TIMEOUT_MS },
        authorize(worker),
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

  /** Null when the host did not answer. */
  const readStatus = (worker: FleetWorker) =>
    call(worker, worker.host, "goat_thread_status", { threadId: worker.threadId }, false).pipe(
      Effect.flatMap(decodeStatus),
      Effect.option,
      Effect.map((option) => (option._tag === "Some" ? option.value : null)),
    );

  const save = (workerId: string, change: (worker: FleetWorker) => FleetWorker) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* store.update((document) => {
        const current = document.workers.find((worker) => worker.workerId === workerId);
        if (current === undefined) return [undefined, document] as const;
        const next = { ...change(current), updatedAt: now };
        return [
          next,
          {
            ...document,
            workers: document.workers.map((worker) =>
              worker.workerId === workerId ? next : worker,
            ),
          },
        ] as const;
      });
    });

  const find = (workerId: string) =>
    store.read.pipe(
      Effect.map((document) => document.workers.find((worker) => worker.workerId === workerId)),
    );

  const backoffUntil = (attempt: number) =>
    Effect.all([Clock.currentTimeMillis, Random.next]).pipe(
      Effect.map(([now, random]) => now + backoffDelayMs(attempt, random)),
    );

  // ── placement ──────────────────────────────────────────────────────

  const place = (worker: FleetWorker) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const known = yield* health.candidates;
      const candidates: Array<PlacementCandidate<string>> = [];
      for (const candidate of known) {
        if (candidate.host === worker.host || candidate.sample?.reachability !== "ok") continue;
        if (!(yield* health.schedulable(candidate.host))) continue;
        candidates.push({
          value: candidate.host,
          host: candidate.host,
          providerLabel: worker.modelSelection?.instanceId ?? "default",
          preferred: false,
          windows: quotaWindows(candidate.sample, worker.modelSelection?.instanceId),
          activeTasks: candidate.sample.metrics?.threads.running ?? 0,
        });
      }
      return choosePlacement(candidates, now)?.chosen.value ?? null;
    });

  /** The same repository on the target, by canonical key; otherwise the same folder path. */
  const targetCwd = (worker: FleetWorker, host: string) =>
    worker.canonicalKey === null
      ? Effect.succeed(worker.cwd)
      : call(worker, host, "goat_project_list", { limit: 100 }, false).pipe(
          Effect.flatMap(decodeProjects),
          Effect.map(
            (listed) =>
              listed.projects.find(
                (project) => canonicalKeyOf(project.repositoryIdentity) === worker.canonicalKey,
              )?.workspaceRoot ?? worker.cwd,
          ),
          Effect.orElseSucceed(() => worker.cwd),
        );

  const fillCanonicalKey = (worker: FleetWorker) =>
    Effect.gen(function* () {
      if (worker.canonicalKey !== null || keyLookups.has(worker.workerId)) return;
      keyLookups.add(worker.workerId);
      const listed = yield* call(
        worker,
        worker.host,
        "goat_project_list",
        { limit: 100 },
        false,
      ).pipe(Effect.flatMap(decodeProjects), Effect.option);
      if (listed._tag === "None") return;
      const project = listed.value.projects.find(
        (candidate) => candidate.workspaceRoot === worker.cwd,
      );
      const key = canonicalKeyOf(project?.repositoryIdentity);
      if (key !== null)
        yield* save(worker.workerId, (current) => ({ ...current, canonicalKey: key }));
    });

  // ── fencing ────────────────────────────────────────────────────────

  /** Tells each binding a move left behind to stop, once its host answers again. */
  const fenceOld = (worker: FleetWorker) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      let acted = false;
      for (const binding of worker.fenced) {
        if (binding.stoppedAt !== null) continue;
        const key = worker.workerId + "/" + binding.generation;
        if (now - (lastFenceTry.get(key) ?? Number.NEGATIVE_INFINITY) < CHECK_INTERVAL_MS) continue;
        lastFenceTry.set(key, now);
        if (yield* health.unreachable(binding.host)) continue;
        const stopped = yield* call(
          worker,
          binding.host,
          "goat_thread_interrupt",
          {
            threadId: binding.threadId,
            reason: "This work moved to another machine.",
          },
          true,
        ).pipe(
          Effect.andThen(
            call(
              worker,
              binding.host,
              "goat_thread_send",
              {
                threadId: binding.threadId,
                message: fenceText({
                  host: worker.host,
                  threadId: worker.threadId,
                  branch: worker.branch,
                  generation: worker.generation,
                }),
                clientRequestId: "fence-" + binding.generation,
              },
              true,
            ),
          ),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!stopped) continue;
        acted = true;
        yield* save(worker.workerId, (current) => ({
          ...current,
          fenced: current.fenced.map((entry) =>
            entry.generation === binding.generation && entry.threadId === binding.threadId
              ? { ...entry, stoppedAt: now }
              : entry,
          ),
        }));
      }
      return acted;
    });

  // ── moves ──────────────────────────────────────────────────────────

  const completeMove = (worker: FleetWorker, target: string, threadId: ThreadId, cwd: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const move = worker.move!;
      return yield* save(worker.workerId, (current) => ({
        ...current,
        fenced: [
          ...current.fenced,
          {
            host: current.host,
            threadId: current.threadId,
            generation: current.generation,
            stoppedAt: null,
          },
        ],
        host: target,
        threadId,
        cwd,
        branch: resumeBranchFor(current.rootBranch, move.generation),
        generation: move.generation,
        attempts: current.attempts + 1,
        phase: "watching",
        move: null,
        steersThisEpisode: 0,
        restartsThisEpisode: 0,
        lastProgressAt: now,
        nextAttemptAt: null,
        lastReason: "Moved from " + current.host + ": " + move.reason,
      }));
    });

  /** A launch that may already have happened (crash, timeout) is found by its title first. */
  const findLaunched = (worker: FleetWorker, target: string, title: string) =>
    call(
      worker,
      target,
      "goat_thread_list",
      { allProjects: true, titleContains: title, limit: 20 },
      false,
    ).pipe(
      Effect.flatMap(decodeThreadList),
      Effect.map((listed) => listed.threads.find((thread) => thread.title === title) ?? null),
    );

  const launchMove = (worker: FleetWorker) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const move = worker.move!;
      const target = move.targetHost ?? (yield* place(worker));
      if (target === null) {
        yield* save(worker.workerId, (current) => ({
          ...current,
          lastReason: "No Ready, uncordoned host can take it yet.",
        }));
        return false;
      }
      if (
        move.launchStartedAt !== null &&
        worker.nextAttemptAt !== null &&
        now < worker.nextAttemptAt
      ) {
        return false;
      }
      const newBranch = resumeBranchFor(worker.rootBranch, move.generation);
      const title = movedTitle(worker.title, move.generation);
      const cwd = yield* targetCwd(worker, target);
      if (move.launchStartedAt !== null) {
        const found = yield* findLaunched(worker, target, title).pipe(Effect.option);
        if (found._tag === "None") return false; // Cannot tell yet; never risk a second launch.
        if (found.value !== null) {
          yield* completeMove(worker, target, found.value.threadId, cwd);
          return true;
        }
      }
      const started = yield* save(worker.workerId, (current) => ({
        ...current,
        move: { ...move, targetHost: target, launchStartedAt: now },
      }));
      if (started === undefined) return false;
      const ceiling = yield* authorize(worker);
      const launched = yield* dispatch
        .launchThread(
          {
            host: target,
            cwd,
            workspace: {
              type: "worktree",
              branch: newBranch,
              baseRef: worker.branch,
              startFromOrigin: true,
            },
            title,
            message: resumePrompt({
              original: worker.message,
              fromBranch: worker.branch,
              fromHost: worker.host,
              commit: move.commit,
              newBranch,
              generation: move.generation,
              reason: move.reason,
            }),
            ...(worker.modelSelection === null ? {} : { modelSelection: worker.modelSelection }),
            runtimeMode: worker.runtimeMode,
            callerRuntimeMode: ceiling,
          },
          authorize(worker).pipe(Effect.asVoid),
        )
        .pipe(Effect.result);
      if (launched._tag === "Success") {
        yield* completeMove(started, target, ThreadId.make(launched.success.threadId), cwd);
        return true;
      }
      const until = yield* backoffUntil(worker.attempts + 1);
      const message =
        launched.failure instanceof SshRemoteDispatch.SshRemoteDispatchError
          ? launched.failure.message
          : "the launcher is gone";
      // Only a launch that may have reached the remote needs the title lookup before a retry.
      const mayHaveStarted =
        launched.failure instanceof SshRemoteDispatch.SshRemoteDispatchError &&
        launched.failure.launchMayHaveStarted !== false;
      yield* save(worker.workerId, (current) => ({
        ...current,
        move:
          current.move === null || mayHaveStarted
            ? current.move
            : { ...current.move, launchStartedAt: null },
        attempts: current.attempts + 1,
        nextAttemptAt: until,
        phase: current.attempts + 1 >= RESCHEDULE_BUDGET ? "exhausted" : current.phase,
        lastReason:
          "Launch on " + target + " failed: " + Array.from(message).slice(0, 300).join(""),
      }));
      return true;
    });

  const beginMove = (
    worker: FleetWorker,
    note: string,
    requested: string | null,
    status: OrchestratorMcpThreadStatusResult | null,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const target = requested ?? (yield* place(worker));
      if (target === null) {
        const until = yield* backoffUntil(worker.attempts);
        yield* save(worker.workerId, (current) => ({
          ...current,
          nextAttemptAt: until,
          lastReason: "Wants to move (" + note + ") but no Ready, uncordoned host can take it.",
        }));
        return false;
      }
      const move = {
        generation: worker.generation + 1,
        targetHost: target,
        reason: note,
        requestedAt: now,
        pushAfterRunId: status?.run?.runId ?? null,
        commit: null,
        launchStartedAt: null,
      };
      if (status !== null) {
        // The host answers: the old thread pushes its branch before anyone resumes it.
        const sent = yield* call(
          worker,
          worker.host,
          "goat_thread_send",
          {
            threadId: worker.threadId,
            message: pushRequestText(worker.branch),
            mode: status.terminal ? "auto" : "restart",
            clientRequestId: "push-" + move.generation,
          },
          true,
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        yield* save(worker.workerId, (current) => ({
          ...current,
          phase: "push_requested",
          move: sent ? move : { ...move, pushAfterRunId: null, requestedAt: now - PUSH_GRACE_MS },
          lastReason: note,
        }));
        return true;
      }
      const next = yield* save(worker.workerId, (current) => ({
        ...current,
        phase: "launching",
        move,
        lastReason: note,
      }));
      return next === undefined ? false : yield* launchMove(next);
    });

  const awaitPush = (worker: FleetWorker) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const move = worker.move!;
      const status = yield* readStatus(worker);
      const pushed =
        status !== null &&
        status.terminal &&
        status.run !== null &&
        status.run.runId !== move.pushAfterRunId;
      const timedOut = now - move.requestedAt >= PUSH_GRACE_MS;
      if (!pushed && !timedOut) return false;
      if (status !== null && !status.terminal) {
        yield* call(
          worker,
          worker.host,
          "goat_thread_interrupt",
          {
            threadId: worker.threadId,
            reason: "This work is moving to another machine.",
          },
          true,
        ).pipe(Effect.ignore);
      }
      const next = yield* save(worker.workerId, (current) => ({
        ...current,
        phase: "launching",
        move: { ...move, commit: pushed ? shaFrom(status?.lastMessage?.excerpt) : null },
      }));
      return next === undefined ? false : yield* launchMove(next);
    });

  // ── the decision step ──────────────────────────────────────────────

  const act = (
    worker: FleetWorker,
    reason: RescheduleReason,
    status: OrchestratorMcpThreadStatusResult | null,
    manualNote?: string,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const decision: RescheduleDecision = decide(reason, {
        now,
        hostAnswers: status !== null,
        hostEvictable: yield* health.evictable(worker.host),
        threadTerminal: status?.terminal ?? false,
        attempts: worker.attempts,
        budget: RESCHEDULE_BUDGET,
        steersThisEpisode: worker.steersThisEpisode,
        restartsThisEpisode: worker.restartsThisEpisode,
        nextAttemptAt: worker.nextAttemptAt,
      });
      let acted = false;
      switch (decision.action) {
        case "wait":
          if (worker.lastReason !== decision.note) {
            yield* save(worker.workerId, (current) => ({ ...current, lastReason: decision.note }));
          }
          break;
        case "give_up":
          yield* save(worker.workerId, (current) => ({
            ...current,
            phase: "exhausted",
            lastReason: decision.note,
          }));
          break;
        case "steer": {
          acted = yield* call(
            worker,
            worker.host,
            "goat_thread_send",
            {
              threadId: worker.threadId,
              message: steerText(reason.type === "no_progress" ? reason.idleMs : 0),
              mode: "steer",
            },
            true,
          ).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (acted) {
            const until = yield* backoffUntil(worker.attempts);
            yield* save(worker.workerId, (current) => ({
              ...current,
              steersThisEpisode: current.steersThisEpisode + 1,
              nextAttemptAt: until,
              lastReason: decision.note,
            }));
          }
          break;
        }
        case "restart": {
          acted = yield* call(
            worker,
            worker.host,
            "goat_thread_send",
            {
              threadId: worker.threadId,
              message: restartText,
              mode: status?.terminal === true ? "auto" : "restart",
              clientRequestId: "restart-" + worker.generation + "-" + (worker.attempts + 1),
            },
            true,
          ).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          const until = yield* backoffUntil(worker.attempts + 1);
          yield* save(worker.workerId, (current) => ({
            ...current,
            attempts: current.attempts + 1,
            restartsThisEpisode: current.restartsThisEpisode + 1,
            nextAttemptAt: until,
            lastReason: acted ? decision.note : "Restart could not be sent: " + decision.note,
          }));
          break;
        }
        case "move":
          acted = yield* beginMove(
            worker,
            manualNote ?? decision.note,
            reason.type === "manual" ? reason.targetHost : null,
            status,
          );
          break;
      }
      return { decision, acted };
    });

  const step = (workerId: string) =>
    Effect.gen(function* () {
      const worker = yield* find(workerId);
      if (worker === undefined) return false;
      const now = yield* Clock.currentTimeMillis;
      const fenced = yield* fenceOld(worker);
      if (worker.phase === "exhausted") return fenced;
      if (now - (lastChecked.get(workerId) ?? Number.NEGATIVE_INFINITY) < CHECK_INTERVAL_MS) {
        return fenced;
      }
      lastChecked.set(workerId, now);
      const fresh = (yield* find(workerId))!;
      if (fresh.phase === "launching") return (yield* launchMove(fresh)) || fenced;
      if (fresh.phase === "push_requested") return (yield* awaitPush(fresh)) || fenced;

      const status = yield* readStatus(fresh);
      let current = fresh;
      if (status !== null) {
        yield* fillCanonicalKey(current);
        // Only the agent's own reply or a completed run is progress; GOAT's nudges are not.
        const reply =
          status.lastMessage?.role === "assistant" ? Date.parse(status.lastMessage.at) || 0 : 0;
        const recovering = current.steersThisEpisode > 0 || current.restartsThisEpisode > 0;
        if (reply > (current.lastProgressAt ?? 0) || (status.phase === "completed" && recovering)) {
          current =
            (yield* save(workerId, (worker) => ({
              ...worker,
              steersThisEpisode: 0,
              restartsThisEpisode: 0,
              lastProgressAt: Math.max(reply, worker.lastProgressAt ?? 0),
            }))) ?? current;
        }
      }
      const drain = yield* health.draining(current.host);
      const reason: RescheduleReason | null =
        drain !== null
          ? { type: "host_draining", force: drain.force }
          : status !== null
            ? detectStall(status, now)
            : (yield* health.unreachable(current.host))
              ? { type: "host_unreachable" }
              : null;
      if (reason === null) return fenced;
      const { acted } = yield* act(current, reason, status);
      return acted || fenced;
    });

  const tick: ReschedulerShape["tick"] = acting.withPermits(1)(
    Effect.gen(function* () {
      yield* health.tick;
      if (!(yield* enabled)) return;
      const document = yield* store.read;
      let actions = 0;
      for (const worker of document.workers) {
        if (actions >= MAX_ACTIONS_PER_TICK) break;
        const acted = yield* step(worker.workerId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("self-heal step failed", { workerId: worker.workerId, cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
        if (acted) actions += 1;
      }
    }),
  );

  const register: ReschedulerShape["register"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const workerId = workerIdFor(input.host, input.threadId);
      return yield* store.update((document) => {
        const existing = document.workers.find((worker) => worker.workerId === workerId);
        if (existing !== undefined)
          return [FleetHealthStore.workerView(existing), document] as const;
        const worker: FleetWorker = {
          workerId,
          launcherThreadId: input.launcherThreadId,
          ceiling: input.ceiling,
          host: input.host,
          threadId: input.threadId,
          generation: 0,
          rootBranch: input.branch,
          branch: input.branch,
          cwd: input.cwd,
          canonicalKey: null,
          title: input.title,
          message:
            input.message === null ? null : Array.from(input.message).slice(0, 20_000).join(""),
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          phase: "watching",
          attempts: 0,
          steersThisEpisode: 0,
          restartsThisEpisode: 0,
          lastProgressAt: null,
          nextAttemptAt: null,
          lastReason: null,
          move: null,
          fenced: [],
          createdAt: now,
          updatedAt: now,
        };
        return [
          FleetHealthStore.workerView(worker),
          { ...document, workers: [...document.workers, worker] },
        ] as const;
      });
    });

  const reschedule: ReschedulerShape["reschedule"] = (input) =>
    acting.withPermits(1)(
      Effect.gen(function* () {
        const document = yield* store.read;
        const worker = document.workers.find(
          (candidate) => candidate.host === input.host && candidate.threadId === input.threadId,
        );
        if (worker === undefined) {
          return yield* new RescheduleError({
            code: "not_found",
            message:
              "Thread " +
              input.threadId +
              " on " +
              input.host +
              " is not a self-healing worker. Only threads launched with selfHeal:true (or goal workers) can be rescheduled.",
          });
        }
        if (worker.phase === "launching" || worker.phase === "push_requested") {
          return yield* new RescheduleError({
            code: "invalid_request",
            message: "That worker is already moving (" + worker.phase + ").",
          });
        }
        if (input.targetHost !== null) {
          if (input.targetHost === worker.host) {
            return yield* new RescheduleError({
              code: "invalid_request",
              message: "The worker already runs on " + input.targetHost + ".",
            });
          }
          if (!(yield* health.schedulable(input.targetHost))) {
            const conditions = yield* health.conditions(input.targetHost);
            return yield* new RescheduleError({
              code: "invalid_request",
              message:
                input.targetHost +
                " cannot take work now (" +
                (conditions.map((condition) => condition.type).join(", ") ||
                  "never answered goat_host_status") +
                "). Read goat_host_status, or uncordon it first.",
            });
          }
        }
        const status = yield* readStatus(worker);
        const { decision } = yield* act(
          worker.phase === "exhausted" ? { ...worker, phase: "watching" } : worker,
          { type: "manual", targetHost: input.targetHost },
          status,
          "moved by request: " + input.reason,
        );
        const after = (yield* find(worker.workerId)) ?? worker;
        return {
          action: decision.action,
          worker: FleetHealthStore.workerView(after),
          message: after.lastReason ?? decision.note,
        };
      }).pipe(
        Effect.catchTag(
          "FleetLauncherGone",
          () =>
            new RescheduleError({
              code: "invalid_request",
              message:
                "The thread that launched this worker is gone or archived, so nothing may act for it.",
            }),
        ),
      ),
    );

  return Rescheduler.of({
    register,
    reschedule,
    workersOn: (host) =>
      store.read.pipe(
        Effect.map((document) =>
          document.workers
            .filter((worker) => worker.host === host)
            .map(FleetHealthStore.workerView),
        ),
      ),
    tick,
  });
});

export const layerWithoutScheduler = Layer.effect(Rescheduler, make);

/** The live Rescheduler, reconciling on the shared 5 s Scheduler tick. */
export const layer = Layer.effect(
  Rescheduler,
  Effect.gen(function* () {
    const rescheduler = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("fleet-self-heal", rescheduler.tick);
    return rescheduler;
  }),
);
