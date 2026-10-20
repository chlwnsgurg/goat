/**
 * The default self-healing layers T1 ships so goals work before T2 lands
 * (docs/internals/agentic-k8s.md, "Interfaces between T1, T2 and T3"): health reads local thread
 * projections and calls everything else unknown, and rescheduling is refused. Placement and
 * fallback are the resources work's real layers (fleet/resources). T2 replaces these.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { Health, type ThreadHealth } from "./health/Health.ts";
import { Rescheduler } from "./health/Rescheduler.ts";
export const layerHealth = Layer.effect(
  Health,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return Health.of({
      hostCondition: (host) =>
        DateTime.now.pipe(
          Effect.map((now) => ({
            host,
            observedAt: DateTime.formatIso(now),
            conditions: [
              host === null
                ? { type: "Ready" as const, status: "True" as const, reason: "Local", message: "" }
                : {
                    type: "Ready" as const,
                    status: "Unknown" as const,
                    reason: "NoHealthMonitor",
                    message: "Host health for other machines arrives with self-healing.",
                  },
            ],
          })),
        ),
      threadHealth: (ref) =>
        ref.host !== null
          ? Effect.succeed<ThreadHealth>({ _tag: "unknown" })
          : threads.getThreadShell(ref.threadId).pipe(
              Effect.map((shell): ThreadHealth => {
                if (shell === null || shell.deletedAt !== null) return { _tag: "unknown" };
                if (shell.pendingRuntimeRequest !== null) return { _tag: "waiting" };
                if (
                  shell.activeRunId === null &&
                  shell.status === "failed" &&
                  shell.latestRunId !== null &&
                  shell.lastErrorClass !== undefined &&
                  shell.lastErrorClass !== null
                )
                  return {
                    _tag: "failed",
                    failureClass: shell.lastErrorClass,
                    runId: shell.latestRunId,
                  };
                return { _tag: "healthy" };
              }),
              Effect.orElseSucceed((): ThreadHealth => ({ _tag: "unknown" })),
            ),
    });
  }),
);

export const layerRescheduler = Layer.succeed(
  Rescheduler,
  Rescheduler.of({
    reschedule: () =>
      Effect.succeed({
        _tag: "Refused",
        reason: "unsupported_remote",
        message: "Rescheduling arrives with self-healing.",
      }),
  }),
);

export const layer = Layer.merge(layerHealth, layerRescheduler);
