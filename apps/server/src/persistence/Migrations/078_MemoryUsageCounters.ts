import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Fixed dimensions only. Head joins start with bounded json_each and use revision/payload PKs.
 * BEFORE/AFTER revision triggers also cover head references arriving before their revision.
 * All writers (including compaction and checkpoint SQL) share the transaction's accounting.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bytes = (column: string) => `length(CAST(${column} AS BLOB))`;
  const live = (p: string) =>
    `(SELECT coalesce(sum(${bytes("body_json")}),0) FROM memory_payloads WHERE space=${p}.space AND memory_id=${p}.memory_id AND payload_ref IN (SELECT r.payload_ref FROM json_each(${p}.heads_json) h JOIN memory_revisions r ON r.space=${p}.space AND r.revision_id=h.value))`;
  const summary = (p: string) =>
    `(${p}.status!='forgotten' AND EXISTS(SELECT 1 FROM json_each(${p}.heads_json) h JOIN memory_revisions r ON r.space=${p}.space AND r.revision_id=h.value WHERE json_extract(r.provenance_json,'$.sourceThread') IS NOT NULL))`;
  const payloadLive = (p: string) =>
    `EXISTS(SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h JOIN memory_revisions r ON r.space=i.space AND r.revision_id=h.value WHERE i.space=${p}.space AND i.memory_id=${p}.memory_id AND r.payload_ref=${p}.payload_ref)`;
  const unforgotten = (p: string) =>
    `NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=${p}.space AND t.memory_id=${p}.memory_id)`;
  // Negative deltas use UPDATE: SQLite checks an INSERT's nonnegative constraint before UPSERT.
  const delta = (space: string, dimension: string, scope: string, value: string, sign: number) =>
    sign < 0
      ? `UPDATE memory_quota_counters SET value=value-(${value}) WHERE space=${space} AND dimension='usage_${dimension}' AND scope_key=${scope};`
      : `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${space},'usage_${dimension}',${scope},${value}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`;
  const both = (space: string, dimension: string, value: string, sign: number) =>
    delta(space, dimension, "''", value, sign) +
    delta("'_usage_environment'", dimension, "''", value, sign);
  type Metrics = (p: string) => Record<string, string>;
  const tables: readonly [string, string, Metrics][] = [
    [
      "memory_items",
      "space",
      (p) => ({ items: `(${p}.status!='forgotten')`, live_bytes: live(p) }),
    ],
    ["memory_payloads", "space", (p) => ({ payload_bytes: bytes(`${p}.body_json`) })],
    [
      "memory_identity_ledger",
      "space",
      (p) => ({
        identities: "1",
        identity_bytes: `${p}.reserve_bytes`,
        reserved_keys: `${p}.reserve_keys`,
        reserved_receipts: unforgotten(p),
      }),
    ],
    ["memory_import_keys", "space", (p) => ({ keys: "1", key_bytes: bytes(`${p}.record_json`) })],
    ["memory_import_lineage", "space", (p) => ({ lineage_bytes: bytes(`${p}.record_json`) })],
    [
      "memory_outbox",
      "space",
      (p) => ({
        work_items: `(${p}.status IN ('pending','retry','running'))`,
        work_bytes: `CASE WHEN ${p}.status IN ('pending','retry','running') THEN ${bytes(`${p}.metadata_json`)} ELSE 0 END`,
      }),
    ],
    [
      "memory_events",
      "memory_space_id",
      (p) => ({
        log_rows: "1",
        log_bytes: `${bytes(`${p}.metadata_json`)}+${bytes(`${p}.receipt_json`)}`,
        receipts: `NOT EXISTS(SELECT 1 FROM memory_compact_receipts c WHERE c.space=${p}.memory_space_id AND c.operation_id=${p}.operation_id)`,
        receipt_bytes: `${M.MEMORY_COMPACT_RECEIPT_MAX_BYTES}*(NOT EXISTS(SELECT 1 FROM memory_compact_receipts c WHERE c.space=${p}.memory_space_id AND c.operation_id=${p}.operation_id))`,
      }),
    ],
    [
      "memory_compact_receipts",
      "space",
      (p) => ({
        receipts: "1",
        receipt_bytes: `coalesce(length(${p}.compact_blob),${bytes(`${p}.compact_json`)})-${M.MEMORY_COMPACT_RECEIPT_MAX_BYTES}*EXISTS(SELECT 1 FROM memory_events e WHERE e.memory_space_id=${p}.space AND e.operation_id=${p}.operation_id)`,
      }),
    ],
  ];
  // Receipt replacement can have a negative net delta. Remove the event fallback first,
  // then add actual compact bytes, never insert a negative counter value.
  const receiptDelta = (p: string, sign: number) => {
    const fallback = `${M.MEMORY_COMPACT_RECEIPT_MAX_BYTES}*EXISTS(SELECT 1 FROM memory_events e WHERE e.memory_space_id=${p}.space AND e.operation_id=${p}.operation_id)`;
    const actual = `coalesce(length(${p}.compact_blob),${bytes(`${p}.compact_json`)})`;
    return (
      both(`${p}.space`, "receipt_bytes", sign > 0 ? fallback : actual, -1) +
      both(`${p}.space`, "receipt_bytes", sign > 0 ? actual : fallback, 1)
    );
  };
  const scoped = (p: string, sign: number) =>
    delta(`${p}.space`, "items", `${p}.scope_key`, `(${p}.status!='forgotten')`, sign) +
    delta(`${p}.space`, "summaries", `${p}.scope_key`, summary(p), sign);
  for (const [table, spaceColumn, metrics] of tables) {
    for (const [dimension, value] of Object.entries(metrics("r"))) {
      if (table === "memory_compact_receipts" && dimension === "receipt_bytes") continue;
      yield* sql.unsafe(
        `INSERT INTO memory_quota_counters SELECT ${spaceColumn},'usage_${dimension}','',sum(${value}) FROM ${table} r GROUP BY ${spaceColumn} ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`,
      );
      yield* sql.unsafe(
        `INSERT INTO memory_quota_counters SELECT '_usage_environment','usage_${dimension}','',coalesce(sum(${value}),0) FROM ${table} r WHERE true ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`,
      );
    }
    for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
      const rowDelta = (p: string, sign: number) =>
        Object.entries(metrics(p))
          .map(([d, v]) =>
            table === "memory_compact_receipts" && d === "receipt_bytes"
              ? receiptDelta(p, sign)
              : table === "memory_compact_receipts" && d === "receipts"
                ? both(
                    `${p}.space`,
                    d,
                    `NOT EXISTS(SELECT 1 FROM memory_events e WHERE e.memory_space_id=${p}.space AND e.operation_id=${p}.operation_id)`,
                    sign,
                  )
                : both(`${p}.${spaceColumn}`, d, v, sign),
          )
          .join("") + (table === "memory_items" ? scoped(p, sign) : "");
      // Subtract OLD while its head/revision relation still exists. Add NEW afterwards.
      if (action !== "INSERT")
        yield* sql.unsafe(
          `CREATE TRIGGER usage_${table}_${action.toLowerCase()}_old BEFORE ${action}${table === "memory_items" && action === "UPDATE" ? " OF space,memory_id,scope_key,heads_json,status" : ""} ON ${table} BEGIN ${rowDelta("OLD", -1)} END`,
        );
      if (action !== "DELETE")
        yield* sql.unsafe(
          `CREATE TRIGGER usage_${table}_${action.toLowerCase()}_new AFTER ${action}${table === "memory_items" && action === "UPDATE" ? " OF space,memory_id,scope_key,heads_json,status" : ""} ON ${table} BEGIN ${rowDelta("NEW", 1)} END`,
        );
    }
  }
  yield* sql.unsafe(
    `INSERT INTO memory_quota_counters SELECT space,'usage_receipt_bytes','',sum(coalesce(length(compact_blob),length(CAST(compact_json AS BLOB)))) FROM memory_compact_receipts GROUP BY space ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`,
  );
  yield* sql.unsafe(
    `INSERT INTO memory_quota_counters SELECT '_usage_environment','usage_receipt_bytes','',coalesce(sum(coalesce(length(compact_blob),length(CAST(compact_json AS BLOB)))),0) FROM memory_compact_receipts WHERE true ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`,
  );
  for (const [d, v] of [
    ["items", "(r.status!='forgotten')"],
    ["summaries", summary("r")],
  ])
    yield* sql.unsafe(
      `INSERT INTO memory_quota_counters SELECT space,'usage_${d}',scope_key,sum(${v}) FROM memory_items r GROUP BY space,scope_key`,
    );
  // Payload mutation changes only this payload's live bytes. Item mutation accounts heads.
  for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
    if (action !== "INSERT")
      yield* sql.unsafe(
        `CREATE TRIGGER usage_payload_live_${action.toLowerCase()}_old BEFORE ${action} ON memory_payloads BEGIN ${both("OLD.space", "live_bytes", `CASE WHEN ${payloadLive("OLD")} THEN ${bytes("OLD.body_json")} ELSE 0 END`, -1)} END`,
      );
    if (action !== "DELETE")
      yield* sql.unsafe(
        `CREATE TRIGGER usage_payload_live_${action.toLowerCase()}_new AFTER ${action} ON memory_payloads BEGIN ${both("NEW.space", "live_bytes", `CASE WHEN ${payloadLive("NEW")} THEN ${bytes("NEW.body_json")} ELSE 0 END`, 1)} END`,
      );
  }
  for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
    // A revision can change either old or new item's head interpretation; at most two items.
    const affected = [
      action !== "INSERT" ? "(i.space=OLD.space AND i.memory_id=OLD.memory_id)" : null,
      action !== "DELETE" ? "(i.space=NEW.space AND i.memory_id=NEW.memory_id)" : null,
    ]
      .filter(Boolean)
      .join(" OR ");
    for (const [timing, sign] of [
      ["BEFORE", -1],
      ["AFTER", 1],
    ] as const) {
      const adjust = (d: string, scope: string, value: string, global = false) => {
        const target = global
          ? "memory_quota_counters.space='_usage_environment' AND scope_key=''"
          : scope === "scope_key"
            ? `(space,scope_key) IN (SELECT i.space,i.scope_key FROM memory_items i WHERE ${affected})`
            : `space IN (SELECT i.space FROM memory_items i WHERE ${affected}) AND scope_key=''`;
        return `UPDATE memory_quota_counters SET value=value${sign < 0 ? "-" : "+"}(SELECT coalesce(sum(${value}),0) FROM memory_items i WHERE (${affected})${global ? "" : ` AND i.space=memory_quota_counters.space${scope === "scope_key" ? " AND i.scope_key=memory_quota_counters.scope_key" : ""}`}) WHERE dimension='usage_${d}' AND ${target};`;
      };
      yield* sql.unsafe(
        `CREATE TRIGGER usage_revision_${action.toLowerCase()}_${timing.toLowerCase()} ${timing} ${action}${action === "UPDATE" ? " OF space,memory_id,revision_id,provenance_json,payload_ref" : ""} ON memory_revisions BEGIN ${adjust("live_bytes", "", live("i"))}${adjust("live_bytes", "", live("i"), true)}${adjust("summaries", "scope_key", summary("i"))} END`,
      );
    }
  }
  for (const action of ["INSERT", "DELETE"] as const) {
    const p = action === "INSERT" ? "NEW" : "OLD";
    const value = `coalesce((SELECT 1 FROM memory_identity_ledger l WHERE l.space=${p}.space AND l.memory_id=${p}.memory_id),0)`;
    yield* sql.unsafe(
      `CREATE TRIGGER usage_tombstone_${action.toLowerCase()} AFTER ${action} ON memory_tombstones BEGIN ${both(`${p}.space`, "reserved_receipts", value, action === "INSERT" ? -1 : 1)} END`,
    );
  }
});
