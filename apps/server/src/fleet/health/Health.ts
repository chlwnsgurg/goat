import {
  OrchestratorMcpThreadStatusResult,
  type RuntimeMode,
  type ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { isTerminalPhase, threadPhase } from "../../mcp/threadStatus.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { HostHealthMonitor, type HostConditionSet } from "./HostHealthMonitor.ts";
import {
  classifyThread,
  type ThreadHealth,
  type ThreadStatusSnapshot,
} from "./threadHealthModel.ts";

export type { HostConditionSet } from "./HostHealthMonitor.ts";
export type { ThreadHealth } from "./threadHealthModel.ts";

export interface FleetThreadRef {
  readonly host: string | null;
  readonly threadId: ThreadId;
  readonly watchId: string | null;
}

export interface HealthShape {
  readonly hostCondition: (host: string | null) => Effect.Effect<HostConditionSet>;
  readonly threadHealth: (ref: FleetThreadRef) => Effect.Effect<ThreadHealth>;
}

/** The goal controller's view of hosts and attempts (agentic-k8s.md "Interfaces"). */
export class Health extends Context.Service<Health, HealthShape>()("goat/fleet/health/Health") {}

const REMOTE_TIMEOUT_MS = 15_000;
const decodeStatus = Schema.decodeUnknownEffect(OrchestratorMcpThreadStatusResult);

/**
 * A thread's status on another host, at most at ceiling. Null when the host did not answer or
 * the remote predates goat_thread_status; either way the call is recorded as a host contact.
 */
export const readRemoteStatus = (host: string, threadId: ThreadId, ceiling: RuntimeMode) =>
  Effect.gen(function* () {
    const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
    const monitor = yield* HostHealthMonitor;
    const raw = yield* dispatch
      .callHostTool(
        {
          host,
          tool: "goat_thread_status",
          arguments: { threadId },
          writes: false,
          timeoutMs: REMOTE_TIMEOUT_MS,
        },
        Effect.succeed(ceiling),
      )
      .pipe(Effect.result);
    if (raw._tag === "Failure") {
      if (raw.failure.reason === "host_unavailable" || raw.failure.reason === "ssh_failed") {
        yield* monitor.recordContact(host, raw.failure.message);
      }
      return null;
    }
    yield* monitor.recordContact(host, null);
    const result = SshRemoteDispatch.readRemoteToolResult("goat_thread_status", raw.success);
    if (!result.ok) return null;
    return yield* decodeStatus(result.value).pipe(Effect.orElseSucceed(() => null));
  });

/** A thread on this machine, from its shell row. */
export const readLocalStatus = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null) return null;
    const pending = shell.pendingRuntimeRequest ?? null;
    const runId = shell.activeRunId ?? shell.latestRunId;
    const phase = threadPhase(runId === null ? null : shell.status, pending?.kind ?? null);
    const snapshot: ThreadStatusSnapshot & { readonly terminal: boolean } = {
      phase,
      run: runId === null ? null : { runId },
      pendingRequest: pending,
      queuedRunId: null,
      lastActivityAt: DateTime.formatIso(shell.updatedAt),
      lastErrorClass: shell.lastErrorClass ?? null,
      terminal: isTerminalPhase(phase),
    };
    return snapshot;
  });

export const make = Effect.gen(function* () {
  const monitor = yield* HostHealthMonitor;
  const context = yield* Effect.context<
    | SshRemoteDispatch.SshRemoteDispatch
    | ThreadManagementService.ThreadManagementService
    | HostHealthMonitor
  >();

  const threadHealth: HealthShape["threadHealth"] = (ref) =>
    Effect.gen(function* () {
      const conditions = yield* monitor.conditions(ref.host);
      // Reads only, so the lowest runtime mode is enough and grants nothing.
      const status =
        ref.host === null
          ? yield* readLocalStatus(ref.threadId)
          : yield* readRemoteStatus(ref.host, ref.threadId, "approval-required");
      const after = ref.host === null ? conditions : yield* monitor.conditions(ref.host);
      return classifyThread({
        status,
        hostConditions: after.conditions,
        now: yield* Clock.currentTimeMillis,
      });
    }).pipe(Effect.provideContext(context));

  return Health.of({ hostCondition: monitor.conditions, threadHealth });
});

export const layer = Layer.effect(Health, make);
