/**
 * Minimal Health and Rescheduler layers for tests that run goals on this machine only: health
 * reads local thread projections and calls everything else unknown, and rescheduling is refused.
 * The server provides the real ones from fleet/health/layer.ts.
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
                ? { type: "Ready" as const, since: DateTime.formatIso(now), message: "" }
                : {
                    type: "Unknown" as const,
                    since: DateTime.formatIso(now),
                    message: "This layer does not follow other machines.",
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
                return { _tag: "healthy", idle: shell.activeRunId === null };
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
        message: "This layer does not reschedule.",
      }),
  }),
);

export const layer = Layer.merge(layerHealth, layerRescheduler);
