/**
 * Host and thread health for fleet work (docs/internals/agentic-k8s.md, "Self-healing"). The
 * self-healing work provides the real layer; fleet/defaults.ts reads local thread projections and
 * reports anything on another machine as unknown.
 */
import type {
  IsoDateTime,
  OrchestrationV2ProviderFailureClass,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** One host condition. The self-healing work moves this type into contracts. */
export interface HostCondition {
  readonly type:
    | "Ready"
    | "Unreachable"
    | "Cordoned"
    | "Draining"
    | "VersionMismatch"
    | "QuotaExhausted";
  readonly status: "True" | "False" | "Unknown";
  readonly reason: string;
  readonly message: string;
}

export type HostConditionSet = {
  readonly host: string | null;
  readonly conditions: ReadonlyArray<HostCondition>;
  readonly observedAt: typeof IsoDateTime.Type;
};

export type ThreadHealth =
  | { readonly _tag: "healthy" | "waiting" | "unknown" }
  | { readonly _tag: "stalled"; readonly idleMs: number }
  | { readonly _tag: "host_lost"; readonly since: typeof IsoDateTime.Type }
  | {
      readonly _tag: "failed";
      readonly failureClass: OrchestrationV2ProviderFailureClass;
      readonly runId: RunId;
    };

export interface FleetThreadRef {
  readonly host: string | null;
  readonly threadId: ThreadId;
  readonly watchId: string | null;
}

export class Health extends Context.Service<
  Health,
  {
    readonly hostCondition: (host: string | null) => Effect.Effect<HostConditionSet>;
    readonly threadHealth: (ref: FleetThreadRef) => Effect.Effect<ThreadHealth>;
  }
  // @effect-diagnostics-next-line deterministicKeys:off -- the key is the T1/T2/T3 agreement in docs/internals/agentic-k8s.md.
>()("goat/fleet/Health") {}
