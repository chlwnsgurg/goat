import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";

// One body-free latest attempt per resolution. Availability always comes from the item.
export const MemoryRevertSlot = Schema.Union([
  Schema.Struct({ status: Schema.Literal("accepted"), revisionId: M.MemoryRevisionId }),
  Schema.Struct({
    status: Schema.Literals(["pending", "forgotten", "revision_changed", "revert_expired"]),
  }),
]);
export type MemoryRevertSlot = typeof MemoryRevertSlot.Type;

export const revertSlotFromReceipt = (
  receipt: M.MemoryHubReceipt,
  revisionId: M.MemoryRevisionId | null,
): MemoryRevertSlot | undefined => {
  if (receipt.outcome === "accepted" && receipt.hubSequence !== null && revisionId !== null)
    return { status: "accepted", revisionId };
  if (receipt.outcome !== "rejected") return undefined;
  return {
    status:
      receipt.failureCode === "forgotten" || receipt.failureCode === "revert_expired"
        ? receipt.failureCode
        : "revision_changed",
  };
};
