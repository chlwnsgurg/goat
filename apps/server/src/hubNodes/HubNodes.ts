import type {
  HubNode,
  HubNodeAddedBy,
  HubNodeId,
  HubNodeNotice,
  HubNodesAddInput,
  HubNodesAddResult,
  HubNodesCheckInput,
  HubNodesError,
  HubNodesImportInput,
  HubNodesImportResult,
  HubNodesRemoveInput,
  HubNodesRemoveResult,
  HubNodesSnapshot,
} from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

export interface HubNodesAddOptions<E, R> {
  readonly addedBy: HubNodeAddedBy;
  /** Re-checks the caller right before the node is saved, after any slow remote exchange. */
  readonly beforeSave: Effect.Effect<void, E, R>;
  /** Refuse instead of saving a node whose environment id the hub cannot read yet. */
  readonly requireIdentity?: boolean;
}

/**
 * The hub's node list: registered SSH hosts merged with LinkedHosts and owned cloud machines,
 * one node per environment id. Transports (WebSocket RPC, MCP) call these methods only.
 */
export class HubNodes extends Context.Service<
  HubNodes,
  {
    readonly snapshot: Effect.Effect<HubNodesSnapshot, HubNodesError>;
    /** The current snapshot, then a new one after every change to any source. */
    readonly changes: Stream.Stream<HubNodesSnapshot, HubNodesError>;
    readonly get: (nodeId: HubNodeId) => Effect.Effect<Option.Option<HubNode>, HubNodesError>;
    readonly add: <E, R>(
      input: HubNodesAddInput,
      options: HubNodesAddOptions<E, R>,
    ) => Effect.Effect<HubNodesAddResult, HubNodesError | E, R>;
    readonly remove: (
      input: HubNodesRemoveInput,
    ) => Effect.Effect<HubNodesRemoveResult, HubNodesError>;
    /** Probes routes without waking or extending a cloud machine. */
    readonly check: (input: HubNodesCheckInput) => Effect.Effect<HubNodesSnapshot, HubNodesError>;
    readonly importProfiles: (
      input: HubNodesImportInput,
    ) => Effect.Effect<HubNodesImportResult, HubNodesError>;
    readonly dismissNotice: (
      id: HubNodeNotice["id"],
    ) => Effect.Effect<{ readonly dismissed: boolean }, HubNodesError>;
  }
>()("goat/hubNodes/HubNodes") {}
