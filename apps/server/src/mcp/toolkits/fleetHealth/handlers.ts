import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as Health from "../../../fleet/health/HostHealthMonitor.ts";
import * as Rescheduler from "../../../fleet/health/Rescheduler.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FleetHealthToolkit } from "./tools.ts";

/** Cordons and moves change where everyone's work runs, so each needs a full-access caller. */
const hostResult = (host: string, message: string) =>
  Effect.gen(function* () {
    const health = yield* Health.Health;
    const rescheduler = yield* Rescheduler.Rescheduler;
    const conditions = yield* health.conditions(host);
    return {
      host,
      cordoned: conditions.some((condition) => condition.type === "Cordoned"),
      draining: conditions.some((condition) => condition.type === "Draining"),
      conditions: [...conditions],
      workers: [...(yield* rescheduler.workersOn(host))],
      message,
    };
  });

export const layer = McpToolAccess.toLayer(FleetHealthToolkit, {
  goat_host_cordon: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      yield* (yield* Health.Health).cordon(input.host, input.reason ?? null);
      return yield* hostResult(
        input.host,
        "No new self-healing or goal work is placed on " +
          input.host +
          ". Running threads are untouched.",
      );
    }),
  ),
  goat_host_uncordon: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      yield* (yield* Health.Health).uncordon(input.host);
      return yield* hostResult(input.host, input.host + " takes new placements again.");
    }),
  ),
  goat_host_drain: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        yield* (yield* Health.Health).drain(input.host, input.force === true);
        return yield* hostResult(
          input.host,
          input.force === true
            ? "Self-healing workers on " +
                input.host +
                " move on the next reconcile, interrupting their turn."
            : "Self-healing workers on " + input.host + " move once their current turn ends.",
        );
      }),
    ),
  ),
  goat_thread_reschedule: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        return yield* rescheduler
          .reschedule({
            host: input.host,
            threadId: input.threadId,
            targetHost: input.targetHost ?? null,
            reason: input.reason,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: error.code === "not_found" ? "thread_not_found" : "invalid_request",
                  message: error.message,
                }),
            ),
          );
      }),
    ),
  ),
});
