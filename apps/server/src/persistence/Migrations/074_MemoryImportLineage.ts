import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Lifetime evidence is independent of revisions, receipt retention and payload deletion. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_import_lineage (
    space TEXT NOT NULL, memory_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('sourceKey','content')), key TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    PRIMARY KEY(space,memory_id,kind,key)
  )`;
  // Exact-copy/source lookup cannot use the per-memory primary-key prefix.
  yield* sql`CREATE INDEX memory_import_lineage_lookup ON memory_import_lineage(space,kind,key,memory_id)`;
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    VALUES ('_hub_global','import_lineage_bytes','',0)`;
  const counter = (space: string, dimension: string, value: string) => `
    INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    VALUES (${space},'${dimension}','',${value})
    ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`;
  const delta = (p: string, sign: number) => {
    const bytes = `length(CAST(${p}.record_json AS BLOB))`;
    // A suppression adds a bounded UUID deleteOperationId to the exact lineage record.
    // 64 bytes covers its JSON field, quotes, comma and the 36-byte operation ID.
    const reserve = `(${bytes}+64)`;
    return (
      counter("'_hub_global'", "import_lineage_bytes", `${sign}*${bytes}`) +
      counter("'_hub_global'", "hub_metadata", `${sign}*${bytes}`) +
      counter(`${p}.space`, "hub_snapshot_bytes", `${sign}*${bytes}`) +
      counter(`${p}.space`, "hub_snapshot_rows", `${sign}`) +
      `
      UPDATE memory_identity_ledger SET reserve_bytes=reserve_bytes+${sign}*${reserve},
        reserve_keys=reserve_keys+${sign}
      WHERE space=${p}.space AND memory_id=${p}.memory_id AND NOT EXISTS
        (SELECT 1 FROM memory_tombstones t WHERE t.space=${p}.space AND t.memory_id=${p}.memory_id);`
    );
  };
  const invalidate = (space: string) => `
    UPDATE memory_hub_retention SET published_pinned_bytes=published_pinned_bytes-
      (SELECT coalesce(sum(length(CAST(p.metadata_json AS BLOB))),0) FROM memory_inbox_pending p
       WHERE p.space=memory_hub_retention.space AND p.reason='hub_snapshot' AND p.checkpoint_id='hub:'||reserved_snapshot_id)
    WHERE space=${space} AND reserved_snapshot_id IS NOT NULL AND checkpoint_id IS NOT reserved_snapshot_id
      AND NOT EXISTS(SELECT 1 FROM json_each(handles_json) h WHERE json_extract(h.value,'$.checkpointId')=reserved_snapshot_id);
    DELETE FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot' AND checkpoint_id IN
      (SELECT 'hub:'||reserved_snapshot_id FROM memory_hub_retention WHERE space=${space}
       AND reserved_snapshot_id IS NOT NULL AND checkpoint_id IS NOT reserved_snapshot_id
       AND NOT EXISTS(SELECT 1 FROM json_each(handles_json) h WHERE json_extract(h.value,'$.checkpointId')=reserved_snapshot_id));
    UPDATE memory_hub_retention SET reserved_snapshot_id=NULL,snapshot_generation=-1
    WHERE space=${space} AND reserved_snapshot_id IS NOT NULL AND checkpoint_id IS NOT reserved_snapshot_id
      AND NOT EXISTS(SELECT 1 FROM json_each(handles_json) h WHERE json_extract(h.value,'$.checkpointId')=reserved_snapshot_id);
    ${counter(space, "hub_snapshot_generation", "1")}`;
  for (const [action, body] of [
    ["INSERT", delta("NEW", 1) + invalidate("NEW.space")],
    [
      "UPDATE",
      delta("OLD", -1) + delta("NEW", 1) + invalidate("OLD.space") + invalidate("NEW.space"),
    ],
    ["DELETE", delta("OLD", -1) + invalidate("OLD.space")],
  ] as const) {
    yield* sql.unsafe(`CREATE TRIGGER memory_import_lineage_${action.toLowerCase()} AFTER ${action}
      ON memory_import_lineage ${action === "UPDATE" ? "WHEN OLD.space IS NOT NEW.space OR OLD.memory_id IS NOT NEW.memory_id OR OLD.kind IS NOT NEW.kind OR OLD.key IS NOT NEW.key OR OLD.record_json IS NOT NEW.record_json" : ""}
      BEGIN ${body} END`);
  }
});
