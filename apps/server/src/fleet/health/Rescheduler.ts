/**
 * Moves a goal attempt to a new attempt elsewhere (docs/internals/agentic-k8s.md,
 * "Self-healing"). The self-healing work provides the real layer; fleet/defaults.ts refuses.
 */
import type { FleetOwnerKey, ModelSelection, RuntimeMode, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { FleetThreadRef } from "./Health.ts";

export type RescheduleReason =
  | "stalled"
  | "host_unreachable"
  | "failed"
  | "drain"
  | "fallback_relaunch"
  | "manual";

export interface RescheduleRequest {
  readonly ref: FleetThreadRef;
  readonly owner: FleetOwnerKey;
  /** Fencing token of the attempt being replaced. */
  readonly attempt: number;
  readonly reason: RescheduleReason;
  readonly modelSelection: ModelSelection;
  readonly workspace: {
    readonly baseRef: string;
    readonly branch: string;
    readonly startFromOrigin: boolean;
  };
  readonly previousBranch: string | null;
  readonly replica: { readonly ref: string; readonly commitOid: string } | null;
  readonly prompt: string;
  /** Already clamped to the owner's ceiling. */
  readonly runtimeMode: RuntimeMode;
  /** goal:<id>:s<slot>:a<attempt+1>:launch */
  readonly clientRequestId: string;
}

export type RescheduleResult =
  | {
      readonly _tag: "Rescheduled";
      readonly host: string | null;
      readonly threadId: ThreadId;
      readonly branch: string;
      readonly resumedFrom: "branch" | "replica" | "base";
    }
  | {
      readonly _tag: "Refused";
      readonly reason:
        | "no_capacity"
        | "host_still_answers"
        | "budget"
        | "no_resume_point"
        | "unsupported_remote";
      readonly message: string;
    };

export class Rescheduler extends Context.Service<
  Rescheduler,
  {
    readonly reschedule: (request: RescheduleRequest) => Effect.Effect<RescheduleResult>;
  }
>()("goat/fleet/health/Rescheduler") {}
