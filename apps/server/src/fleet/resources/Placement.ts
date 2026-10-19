/**
 * Where fleet work runs (docs/internals/agentic-k8s.md, "Interfaces between T1, T2 and T3").
 * The resources work provides the real layer; fleet/defaults.ts places on this machine only.
 */
import type { FleetOwnerKey, HostSelector, ModelSelection, ProjectId } from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Why a host was not chosen. The resources work moves this type into contracts. */
export type PlacementRefusal =
  | "placement_unavailable"
  | "outside_selector"
  | "cordoned"
  | "unreachable"
  | "no_capacity"
  | "quota_exhausted"
  | "missing_instance"
  | "missing_project";

/** What goat_scheduler_status reports. The resources work moves this type into contracts. */
export interface SchedulerStatus {
  readonly hosts: ReadonlyArray<{
    readonly host: string | null;
    readonly placeable: boolean;
    readonly reason: PlacementRefusal | null;
  }>;
}

export interface PlacementRequest {
  readonly owner: FleetOwnerKey;
  readonly modelSelection: ModelSelection;
  readonly fallbackChain: string | null;
  readonly hostSelector: HostSelector;
  readonly project: {
    readonly host: string | null;
    readonly projectId: ProjectId | null;
    readonly cwd: string | null;
  };
  readonly avoidHosts: ReadonlyArray<string | null>;
}

export type PlacementResult =
  | {
      readonly _tag: "Placed";
      readonly host: string | null;
      readonly modelSelection: ModelSelection;
      readonly reason: string | undefined;
    }
  | {
      readonly _tag: "Refused";
      readonly reasons: ReadonlyArray<{
        readonly host: string | null;
        readonly reason: PlacementRefusal;
      }>;
    };

export class Placement extends Context.Service<
  Placement,
  {
    readonly place: (request: PlacementRequest) => Effect.Effect<PlacementResult>;
    readonly status: Effect.Effect<SchedulerStatus>;
  }
  // @effect-diagnostics-next-line deterministicKeys:off -- the key is the T1/T2/T3 agreement in docs/internals/agentic-k8s.md.
>()("goat/fleet/Placement") {}
