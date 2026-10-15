import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  checkpointInventorySize,
  validateCheckpointInventory,
  selectCheckpointMemory,
  selectCheckpointReceipt,
  selectCheckpointIndependent,
} from "./MemoryCheckpointInventory.ts";
import { futureForgetReserve } from "./MemoryCheckpointBound.ts";

const decodeSpace = Schema.decodeUnknownEffect(M.MemorySpaceId);
const decodeMemory = Schema.decodeUnknownEffect(M.MemoryId);

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
  // Any lifecycle address requires marker=1 and both totals, even without dirty keys.
  // DISTINCT walks three bounded index entries per healthy space; validation uses
  // three counter PK probes per space, never corpus/cache rows.
  const missing = yield* sql`SELECT i.space FROM (
    SELECT DISTINCT space FROM memory_quota_counters
    WHERE (dimension='hub_snapshot_rows' OR dimension='checkpoint_initialized' OR dimension='hub_snapshot_bytes') AND scope_key=''
  ) i WHERE
    NOT EXISTS(SELECT 1 FROM memory_quota_counters m WHERE m.space=i.space AND m.dimension='checkpoint_initialized' AND m.scope_key='' AND m.value=1)
    OR NOT EXISTS(SELECT 1 FROM memory_quota_counters b WHERE b.space=i.space AND b.dimension='hub_snapshot_bytes' AND b.scope_key='')
    OR NOT EXISTS(SELECT 1 FROM memory_quota_counters n WHERE n.space=i.space AND n.dimension='hub_snapshot_rows' AND n.scope_key='') LIMIT 1`;
  if (missing.length) return yield* new CheckpointAccountingError({ stage: "missing-total" });
  const now = yield* Clock.currentTimeMillis;
  const dirty = yield* sql<{
    dimension: string;
    scope_key: string;
  }>`SELECT dimension,scope_key FROM memory_quota_counters WHERE space='_checkpoint_dirty'`;
  for (const key of dirty) {
    const memory = key.scope_key.startsWith("m:");
    const id = key.scope_key.slice(2);
    if (memory) {
      const canonical =
        yield* sql`SELECT 1 FROM memory_identity_ledger WHERE space=${key.dimension} AND memory_id=${id}`;
      if (!canonical.length) {
        // Local drafts have no canonical identity and cannot appear in a hub checkpoint.
        yield* sql`DELETE FROM memory_quota_counters WHERE space='_checkpoint_dirty' AND dimension=${key.dimension} AND scope_key=${key.scope_key}`;
        continue;
      }
    }
    const space = yield* decodeSpace(key.dimension);
    const initialized =
      yield* sql`SELECT 1 FROM memory_quota_counters WHERE space=${space} AND dimension='checkpoint_initialized' AND scope_key=''`;
    if (!initialized.length) {
      // Only the first canonical write may create zero totals. Never upsert a lost
      // total with a new record's delta after a space has been initialized.
      const orphan =
        yield* sql`SELECT 1 FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows') LIMIT 1`;
      if (orphan.length) return yield* new CheckpointAccountingError({ stage: "missing-total" });
      yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES
        (${space},'hub_snapshot_bytes','',0),(${space},'hub_snapshot_rows','',0),(${space},'checkpoint_initialized','',1)`;
    }
    const independent = key.scope_key.startsWith("l:") || key.scope_key.startsWith("s:");
    const inventory = memory
      ? yield* selectCheckpointMemory(space, yield* decodeMemory(id), now, false)
      : independent
        ? yield* selectCheckpointIndependent(space, undefined, {
            kind: key.scope_key.startsWith("l:") ? "l" : "s",
            rowid: id,
          })
        : yield* selectCheckpointReceipt(space, id);
    yield* validateCheckpointInventory(space, inventory);
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
    const table = memory
      ? "memory_identity_ledger"
      : key.scope_key.startsWith("c:")
        ? "memory_compact_receipts"
        : key.scope_key.startsWith("l:")
          ? "memory_import_lineage"
          : "memory_import_keys";
    const column = memory ? "memory_id" : key.scope_key.startsWith("c:") ? "operation_id" : "rowid";
    const cached = yield* sql.unsafe<{ checkpoint_bytes: number; checkpoint_rows: number }>(
      `SELECT checkpoint_bytes,checkpoint_rows FROM ${table} WHERE space=? AND ${column}=?`,
      [space, id],
    );
    for (const [dimension, value] of [
      ["hub_snapshot_bytes", size.bytes],
      ["hub_snapshot_rows", size.rows],
    ] as const) {
      const previous =
        (dimension === "hub_snapshot_bytes"
          ? cached[0]?.checkpoint_bytes
          : cached[0]?.checkpoint_rows) ?? 0;
      const delta = value - previous;
      const updated =
        yield* sql`UPDATE memory_quota_counters SET value=value+${delta} WHERE space=${space} AND dimension=${dimension} AND scope_key='' RETURNING value`;
      if (!updated.length) return yield* new CheckpointAccountingError({ stage: "missing-total" });
    }
    if (cached.length)
      yield* sql.unsafe(
        `UPDATE ${table} SET checkpoint_bytes=?,checkpoint_rows=? WHERE space=? AND ${column}=?`,
        [size.bytes, size.rows, space, id],
      );
    yield* sql`DELETE FROM memory_quota_counters WHERE space='_checkpoint_dirty' AND dimension=${space} AND scope_key=${key.scope_key}`;
  }
  // Marker and recalculated counters become visible together on migration commit.
  const initialized = yield* sql<{
    value: number;
  }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='checkpoint_codec' AND scope_key=''`;
  if (initialized[0]?.value !== 1)
    return yield* new CheckpointAccountingError({ stage: "uninitialized" });
});
