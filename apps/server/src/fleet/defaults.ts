/**
 * The default fleet layers T1 ships so goals work before self-healing and resources land
 * (docs/internals/agentic-k8s.md, "Interfaces between T1, T2 and T3"). They keep the first
 * release a small, honest local slice: placement allows this machine only, health reads local
 * thread projections and calls everything else unknown, rescheduling is refused, and fallback is
 * exhausted. The self-healing and resources PRs replace these with their own layers.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { Health, type ThreadHealth } from "./health/Health.ts";
import { Rescheduler } from "./health/Rescheduler.ts";
import { Fallback } from "./resources/Fallback.ts";
import { Placement, type PlacementResult } from "./resources/Placement.ts";

export const layerPlacement = Layer.succeed(
  Placement,
  Placement.of({
    place: (request) =>
      Effect.sync((): PlacementResult => {
        const allowed = request.hostSelector.hosts ?? [null];
        const excluded = request.hostSelector.exclude ?? [];
        const local =
          request.project.host === null && allowed.includes(null) && !excluded.includes(null);
        return local
          ? {
              _tag: "Placed",
              host: null,
              modelSelection: request.modelSelection,
              reason: undefined,
            }
          : {
              _tag: "Refused",
              reasons: [
                ...allowed
                  .filter((host) => host !== null)
                  .map((host) => ({ host, reason: "placement_unavailable" as const })),
                ...(allowed.includes(null)
                  ? [{ host: null, reason: "outside_selector" as const }]
                  : []),
              ],
            };
      }),
    status: Effect.succeed({ hosts: [{ host: null, placeable: true, reason: null }] }),
  }),
);

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

export const layerFallback = Layer.succeed(
  Fallback,
  Fallback.of({
    next: () => Effect.succeed({ _tag: "Exhausted", reason: "No fallback chain is configured." }),
    reportFailure: () => Effect.void,
  }),
);

export const layer = Layer.mergeAll(layerPlacement, layerHealth, layerRescheduler, layerFallback);
