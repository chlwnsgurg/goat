import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  checkpointInventorySize,
  selectCheckpointMemory,
  selectCheckpointReceipt,
} from "./MemoryCheckpointInventory.ts";
import { futureForgetReserve } from "./MemoryCheckpointBound.ts";

export class CheckpointAccountingError extends Schema.TaggedError<CheckpointAccountingError>()(
  "CheckpointAccountingError",
  { stage: Schema.String },
) {}

/** Synchronous counter-cache invalidations, never asynchronous work or a corpus index.
 * The reserved space is the existing counters' PK prefix, so reading touched keys
 * does not scan the corpus or all cached counters. Refresh and delta commit together.
 */
export const refreshCheckpointAccounting = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const dirty = yield* sql<{
    dimension: string;
    scope_key: string;
  }>`SELECT dimension,scope_key FROM memory_quota_counters WHERE space='_checkpoint_dirty'`;
  for (const key of dirty) {
    const space = yield* Schema.decodeUnknownEffect(M.MemorySpaceId)(key.dimension);
    const memory = key.scope_key.startsWith("m:");
    const id = key.scope_key.slice(2);
    const inventory = memory
      ? yield* selectCheckpointMemory(space, yield* Schema.decodeUnknownEffect(M.MemoryId)(id), now)
      : yield* selectCheckpointReceipt(space, id);
    const size = checkpointInventorySize(inventory);
    if (memory) {
      const reserves = yield* sql<{
        reserve_bytes: number;
        reserve_keys: number;
      }>`SELECT reserve_bytes,reserve_keys FROM memory_identity_ledger i WHERE space=${space} AND memory_id=${id} AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)`;
      if (reserves[0]) {
        const reserve = futureForgetReserve(reserves[0].reserve_bytes, reserves[0].reserve_keys);
        size.bytes += reserve.bytes;
        size.rows += reserve.rows;
      }
    }
    for (const [dimension, value] of [
      ["hub_snapshot_bytes", size.bytes],
      ["hub_snapshot_rows", size.rows],
    ] as const) {
      const previous = yield* sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension=${dimension} AND scope_key=${key.scope_key}`;
      const delta = value - (previous[0]?.value ?? 0);
      yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${space},${dimension},'',${delta}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`;
      yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${space},${dimension},${key.scope_key},${value}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`;
    }
    yield* sql`DELETE FROM memory_quota_counters WHERE space='_checkpoint_dirty' AND dimension=${space} AND scope_key=${key.scope_key}`;
  }
  // The marker is installed only after the additive migration's atomic recalculation.
  const initialized = yield* sql<{
    value: number;
  }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='checkpoint_codec' AND scope_key=''`;
  if (initialized[0]?.value !== 1)
    return yield* new CheckpointAccountingError({ stage: "uninitialized" });
});
