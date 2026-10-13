import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(memory_identity_ledger)`;
  if (!columns.some((column) => column.name === "reserve_keys")) {
    yield* sql`ALTER TABLE memory_identity_ledger ADD COLUMN reserve_keys INTEGER NOT NULL DEFAULT 0 CHECK(reserve_keys>=0)`;
  }
  // Backfill the same per-message union as the first-forget writer, including retained revisions.
  yield* sql`WITH fragments AS (
    SELECT DISTINCT r.space,r.memory_id,json_object(
      'memorySpaceId',r.space,'memoryId',r.memory_id,'deleteOperationId',json_extract(l.identity_json,'$.createOperationId'),
      'kind','sourceExclusion','exclusion',json_object(
        'sourceThread',json(json_extract(r.provenance_json,'$.sourceThread')),
        'sourceWatermark',json(json_extract(r.provenance_json,'$.sourceWatermark')),
        'messageIds',json_array(m.value))) AS record_json
    FROM memory_revisions r JOIN memory_identity_ledger l ON l.space=r.space AND l.memory_id=r.memory_id
    JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref
    JOIN json_each(p.body_json,'$.evidence') e JOIN json_each(e.value,'$.messageIds') m
    WHERE json_extract(r.provenance_json,'$.sourceThread') IS NOT NULL
    AND json_extract(r.provenance_json,'$.sourceWatermark') IS NOT NULL
  ) UPDATE memory_identity_ledger AS l SET
    reserve_keys=max(reserve_keys,(SELECT count(*) FROM fragments f WHERE f.space=l.space AND f.memory_id=l.memory_id)),
    reserve_bytes=max(reserve_bytes,${M.MEMORY_IDENTITY_CORE_MAX_BYTES + M.MEMORY_PAYLOAD_MAX_UTF8_BYTES},${M.MEMORY_IDENTITY_CORE_MAX_BYTES}+(SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM fragments f WHERE f.space=l.space AND f.memory_id=l.memory_id))
    WHERE NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=l.space AND t.memory_id=l.memory_id)`;
});
