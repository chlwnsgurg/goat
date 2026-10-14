import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_hub_members (
    space TEXT NOT NULL, environment TEXT NOT NULL, credential_digest TEXT NOT NULL UNIQUE,
    credential_version INTEGER NOT NULL CHECK(credential_version>0),
    status TEXT NOT NULL CHECK(status IN ('active','revoked')), joined_at INTEGER,
    PRIMARY KEY(space,environment)
  )`;
  yield* sql`CREATE TABLE memory_hub_operations (
    hub_sequence INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL, operation_id TEXT NOT NULL,
    memory_id TEXT NOT NULL, origin_environment TEXT NOT NULL, operation_digest TEXT NOT NULL,
    entry_json TEXT NOT NULL, payload_ref TEXT, committed_at INTEGER NOT NULL,
    UNIQUE(space,operation_id)
  )`;
  yield* sql`CREATE INDEX memory_hub_operations_space_sequence ON memory_hub_operations(space,hub_sequence)`;
  yield* sql`CREATE TABLE memory_hub_leases (
    space TEXT NOT NULL, memory_id TEXT NOT NULL, highest_token INTEGER NOT NULL CHECK(highest_token>=0),
    lease_json TEXT, PRIMARY KEY(space,memory_id)
  )`;
  yield* sql`CREATE TABLE memory_hub_source_reads (
    space TEXT NOT NULL, request_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    requester TEXT NOT NULL, owner TEXT NOT NULL, credential_version INTEGER NOT NULL,
    request_digest TEXT NOT NULL, locator_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','completed','expired')),
    deadline INTEGER NOT NULL, response_digest TEXT, payload_ref TEXT,
    PRIMARY KEY(space,request_id)
  )`;
  yield* sql`CREATE INDEX memory_hub_source_reads_owner ON memory_hub_source_reads(space,owner,state,deadline)`;
  yield* sql`CREATE INDEX memory_hub_source_reads_memory ON memory_hub_source_reads(space,memory_id)`;
  yield* sql`CREATE TABLE memory_hub_retention (
    space TEXT PRIMARY KEY, checkpoint_id TEXT, checkpoint_sequence INTEGER NOT NULL DEFAULT 0,
    retention_floor INTEGER NOT NULL DEFAULT 0, boundary_json TEXT, handles_json TEXT NOT NULL DEFAULT '[]',
    compaction_json TEXT, reserved_snapshot_id TEXT, snapshot_generation INTEGER, last_snapshot_bytes INTEGER NOT NULL DEFAULT 0 CHECK(last_snapshot_bytes>=0), checkpoint_bytes INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_bytes>=0),
    published_pinned_bytes INTEGER NOT NULL DEFAULT 0 CHECK(published_pinned_bytes>=0),
    CHECK(retention_floor>=0 AND retention_floor<=checkpoint_sequence)
  )`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0 CHECK(sync_version>=0)`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN operation_digest TEXT`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN frozen_claim_json TEXT`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN ticket_json TEXT`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN admin_json TEXT`;
  yield* sql`UPDATE memory_outbox SET operation_digest=(
    (SELECT e.operation_digest FROM memory_events e WHERE e.memory_space_id=memory_outbox.space AND e.operation_id=json_extract(memory_outbox.metadata_json,'$.operationId'))
  ) WHERE kind IN ('sync','revert_intent')`;
  yield* sql`CREATE INDEX memory_outbox_sync_due ON memory_outbox(space,kind,status,next_attempt_at,claimed_until)`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN terminal_at INTEGER`;
  const counterSpace = "_hub_global";
  // Seed once from the upgrade snapshot. Every later row delta is maintained by SQLite in its writer transaction.
  const receiptBytes = 336;
  const privateInventory = [
    [
      "memory_hub_members",
      "length(CAST(space AS BLOB))+length(CAST(environment AS BLOB))+length(CAST(credential_digest AS BLOB))+length(CAST(credential_version AS TEXT))+length(CAST(status AS BLOB))+coalesce(length(CAST(joined_at AS TEXT)),0)",
    ],
    [
      "memory_hub_leases",
      "length(CAST(space AS BLOB))+length(CAST(memory_id AS BLOB))+length(CAST(highest_token AS TEXT))+coalesce(length(CAST(lease_json AS BLOB)),0)",
    ],
    [
      "memory_hub_source_reads",
      "length(CAST(locator_json AS BLOB))+length(CAST(request_digest AS BLOB))+coalesce(length(CAST(response_digest AS BLOB)),0)",
    ],
    [
      "memory_hub_retention",
      "coalesce(length(CAST(boundary_json AS BLOB)),0)+length(CAST(handles_json AS BLOB))+coalesce(length(CAST(compaction_json AS BLOB)),0)",
    ],
    [
      "memory_outbox",
      "coalesce(length(CAST(admin_json AS BLOB)),0)+coalesce(length(CAST(ticket_json AS BLOB)),0)+coalesce(length(CAST(frozen_claim_json AS BLOB)),0)",
    ],
    [
      "memory_report_outbox",
      "length(CAST(report_id AS BLOB))+length(CAST(operation_id AS BLOB))+length(CAST(resolving_environment_id AS BLOB))+coalesce(length(CAST(resolution_id AS BLOB)),0)+coalesce(length(CAST(report_thread_json AS BLOB)),0)+32",
    ],
  ] as const;
  const privateTotal = privateInventory
    .map(([table, expression]) => `(SELECT coalesce(sum(${expression}),0) FROM ${table})`)
    .join("+");
  const canonicalTotal = `(SELECT coalesce(sum(reserve_bytes),0) FROM memory_identity_ledger)+(SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM memory_import_keys)+(SELECT coalesce(sum(coalesce(length(compact_blob),length(CAST(compact_json AS BLOB)))),0) FROM memory_compact_receipts)+(SELECT count(*)*${receiptBytes} FROM memory_events e WHERE NOT EXISTS(SELECT 1 FROM memory_compact_receipts c WHERE c.space=e.memory_space_id AND c.operation_id=e.operation_id))+(SELECT count(*)*${receiptBytes} FROM memory_identity_ledger i WHERE NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id))`;
  const guardKinds =
    "('hub_attempt','hub_checkpoint_token','ticket_terminal','hub_admin','report_delivered')";
  const counts = [
    ["hub_metadata", `${canonicalTotal}+${privateTotal}`],
    ["hub_private_metadata", privateTotal],
    [
      "hub_receipts",
      `(SELECT count(*) FROM (SELECT memory_space_id AS space,operation_id FROM memory_events UNION SELECT space,operation_id FROM memory_compact_receipts))+(SELECT count(*) FROM memory_identity_ledger i WHERE NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id))+(SELECT count(*) FROM memory_import_keys WHERE key_kind IN ${guardKinds})+(SELECT count(*) FROM memory_outbox WHERE kind='admin')`,
    ],
    [
      "hub_checkpoint",
      "(SELECT coalesce(sum(checkpoint_bytes+published_pinned_bytes),0) FROM memory_hub_retention)",
    ],
    ["hub_ids", "(SELECT count(*) FROM memory_identity_ledger)"],
    [
      "hub_keys",
      "(SELECT count(*) FROM memory_import_keys)+(SELECT coalesce(sum(reserve_keys),0) FROM memory_identity_ledger)+(SELECT count(*) FROM memory_outbox WHERE kind='admin')",
    ],
  ] as const;
  for (const [dimension, expression] of counts)
    yield* sql.unsafe(
      `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT ?,?,'',${expression}`,
      [counterSpace, dimension],
    );
  const delta = (dimension: string, expression: string) =>
    `UPDATE memory_quota_counters SET value=value+(${expression}) WHERE space='${counterSpace}' AND dimension='${dimension}' AND scope_key='';`;
  const install = (table: string, insert: string, update: string, remove: string) =>
    Effect.gen(function* () {
      for (const [action, body] of [
        ["INSERT", insert],
        ["UPDATE", update],
        ["DELETE", remove],
      ] as const)
        yield* sql.unsafe(
          `CREATE TRIGGER ${table}_hub_account_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${body} END`,
        );
    });
  for (const [table, expression] of privateInventory) {
    const qualify = (prefix: string) =>
      expression.replace(
        /\b(space|environment|credential_digest|credential_version|status|joined_at|memory_id|highest_token|lease_json|locator_json|request_digest|response_digest|boundary_json|handles_json|compaction_json|admin_json|ticket_json|frozen_claim_json|report_id|operation_id|resolving_environment_id|resolution_id|report_thread_json)\b/g,
        `${prefix}.$1`,
      );
    const charge = (value: string) =>
      delta("hub_metadata", value) + delta("hub_private_metadata", value);
    const checkpoint = (expression: string) =>
      table === "memory_hub_retention" ? delta("hub_checkpoint", expression) : "";
    const adminOnly = (prefix: string) =>
      `CASE WHEN ${prefix}.kind='admin' AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space='_admin' AND g.key_kind='hub_admin' AND g.key=substr(${prefix}.id,7)) THEN 1 ELSE 0 END`;
    const adminReservation = (expression: string) =>
      table === "memory_outbox"
        ? delta("hub_receipts", expression) + delta("hub_keys", expression)
        : "";
    yield* install(
      table,
      charge(qualify("NEW")) +
        checkpoint("NEW.checkpoint_bytes+NEW.published_pinned_bytes") +
        adminReservation(adminOnly("NEW")),
      charge(`${qualify("NEW")}-(${qualify("OLD")})`) +
        checkpoint(
          "NEW.checkpoint_bytes+NEW.published_pinned_bytes-OLD.checkpoint_bytes-OLD.published_pinned_bytes",
        ) +
        adminReservation(`${adminOnly("NEW")}-${adminOnly("OLD")}`),
      charge(`-(${qualify("OLD")})`) +
        checkpoint("-OLD.checkpoint_bytes-OLD.published_pinned_bytes") +
        adminReservation(`-(${adminOnly("OLD")})`),
    );
  }
  const identityCharge = (prefix: string) =>
    `${prefix}.reserve_bytes+CASE WHEN NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=${prefix}.space AND t.memory_id=${prefix}.memory_id) THEN ${receiptBytes} ELSE 0 END`;
  const identityCount = (prefix: string) =>
    `CASE WHEN NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=${prefix}.space AND t.memory_id=${prefix}.memory_id) THEN 1 ELSE 0 END`;
  yield* install(
    "memory_identity_ledger",
    delta("hub_metadata", identityCharge("NEW")) +
      delta("hub_receipts", identityCount("NEW")) +
      delta("hub_ids", "1") +
      delta("hub_keys", "NEW.reserve_keys"),
    delta("hub_metadata", "NEW.reserve_bytes-OLD.reserve_bytes") +
      delta("hub_keys", "NEW.reserve_keys-OLD.reserve_keys"),
    delta("hub_metadata", `-(${identityCharge("OLD")})`) +
      delta("hub_receipts", `-(${identityCount("OLD")})`) +
      delta("hub_ids", "-1") +
      delta("hub_keys", "-OLD.reserve_keys"),
  );
  const tombstoneCharge = (prefix: string) =>
    `CASE WHEN EXISTS(SELECT 1 FROM memory_identity_ledger i WHERE i.space=${prefix}.space AND i.memory_id=${prefix}.memory_id) THEN 1 ELSE 0 END`;
  yield* install(
    "memory_tombstones",
    delta("hub_metadata", `-${receiptBytes}*(${tombstoneCharge("NEW")})`) +
      delta("hub_receipts", `-(${tombstoneCharge("NEW")})`),
    delta("hub_metadata", "0"),
    delta("hub_metadata", `${receiptBytes}*(${tombstoneCharge("OLD")})`) +
      delta("hub_receipts", tombstoneCharge("OLD")),
  );
  const eventOnly = (prefix: string) =>
    `CASE WHEN NOT EXISTS(SELECT 1 FROM memory_compact_receipts c WHERE c.space=${prefix}.memory_space_id AND c.operation_id=${prefix}.operation_id) THEN 1 ELSE 0 END`;
  yield* install(
    "memory_events",
    delta("hub_metadata", `${receiptBytes}*(${eventOnly("NEW")})`) +
      delta("hub_receipts", eventOnly("NEW")),
    delta("hub_metadata", "0"),
    delta("hub_metadata", `-${receiptBytes}*(${eventOnly("OLD")})`) +
      delta("hub_receipts", `-(${eventOnly("OLD")})`),
  );
  const compactBytes = (prefix: string) =>
    `coalesce(length(${prefix}.compact_blob),length(CAST(${prefix}.compact_json AS BLOB)))`;
  const compactOnly = (prefix: string) =>
    `CASE WHEN NOT EXISTS(SELECT 1 FROM memory_events e WHERE e.memory_space_id=${prefix}.space AND e.operation_id=${prefix}.operation_id) THEN 1 ELSE 0 END`;
  yield* install(
    "memory_compact_receipts",
    delta("hub_metadata", `${compactBytes("NEW")}-${receiptBytes}*(1-(${compactOnly("NEW")}))`) +
      delta("hub_receipts", compactOnly("NEW")),
    delta("hub_metadata", `${compactBytes("NEW")}-${compactBytes("OLD")}`),
    delta("hub_metadata", `-${compactBytes("OLD")}+${receiptBytes}*(1-(${compactOnly("OLD")}))`) +
      delta("hub_receipts", `-(${compactOnly("OLD")})`),
  );
  const guardCount = (prefix: string) =>
    `CASE WHEN ${prefix}.key_kind IN ${guardKinds} THEN CASE WHEN ${prefix}.key_kind='hub_admin' AND EXISTS(SELECT 1 FROM memory_outbox o WHERE o.kind='admin' AND o.id='admin:'||${prefix}.key) THEN 0 ELSE 1 END ELSE 0 END`;
  const keyCount = (prefix: string) =>
    `CASE WHEN ${prefix}.key_kind='hub_admin' AND EXISTS(SELECT 1 FROM memory_outbox o WHERE o.kind='admin' AND o.id='admin:'||${prefix}.key) THEN 0 ELSE 1 END`;
  yield* install(
    "memory_import_keys",
    delta("hub_metadata", "length(CAST(NEW.record_json AS BLOB))") +
      delta("hub_receipts", guardCount("NEW")) +
      delta("hub_keys", keyCount("NEW")),
    delta(
      "hub_metadata",
      "length(CAST(NEW.record_json AS BLOB))-length(CAST(OLD.record_json AS BLOB))",
    ) +
      delta("hub_receipts", `${guardCount("NEW")}-${guardCount("OLD")}`) +
      delta("hub_keys", `${keyCount("NEW")}-${keyCount("OLD")}`),
    delta("hub_metadata", "-length(CAST(OLD.record_json AS BLOB))") +
      delta("hub_receipts", `-(${guardCount("OLD")})`) +
      delta("hub_keys", `-(${keyCount("OLD")})`),
  );
  // Deliberately retain historical and private inputs too: expiry/compaction can only reduce this upper bound.
  const snapshotInputs = [
    ["memory_items", "space", "item_json,heads_json"],
    [
      "memory_revisions",
      "space",
      "space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref",
    ],
    ["memory_payloads", "space", "body_json"],
    [
      "memory_tombstones",
      "space",
      "space,memory_id,delete_operation_id,deleting_environment_id,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json",
    ],
    [
      "memory_conflicts",
      "space",
      "space,conflict_id,memory_id,heads_json,status,failure_code,attempt_id",
    ],
    ["memory_resolutions", "space", "resolution_json"],
    ["memory_identity_ledger", "space", "identity_json,fence_json"],
    ["memory_compact_receipts", "space", "compact_json,receipt_json"],
    ["memory_import_keys", "space", "record_json"],
    ["memory_events", "memory_space_id", "metadata_json,receipt_json"],
    ["memory_outbox", "space", "metadata_json,admin_json,ticket_json,frozen_claim_json"],
    ["memory_hub_members", "space", "space,environment,credential_digest,status"],
    ["memory_hub_leases", "space", "lease_json"],
    ["memory_hub_source_reads", "space", "locator_json,request_digest,response_digest"],
  ] as const;
  for (const [table, spaceColumn, columns] of snapshotInputs) {
    const rawBytes = (prefix: string) =>
      columns
        .split(",")
        .map((column) => `coalesce(length(CAST(${prefix}${column} AS BLOB)),0)`)
        .join("+") + (table === "memory_identity_ledger" ? `+${prefix}reserve_bytes` : "");
    const bytes = (prefix: string) =>
      table === "memory_import_keys"
        ? `CASE WHEN ${prefix}key_kind='hub_checkpoint_token' THEN 0 ELSE ${rawBytes(prefix)} END`
        : rawBytes(prefix);
    // The identity owns the future basic-forget rows and its source-key suppression records.
    const recordRows = (prefix: string) =>
      table === "memory_identity_ledger"
        ? `1+${prefix}reserve_keys+CASE WHEN NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=${prefix}space AND t.memory_id=${prefix}memory_id) THEN 8 ELSE 0 END`
        : table === "memory_import_keys"
          ? `CASE WHEN ${prefix}key_kind='hub_checkpoint_token' THEN 0 ELSE 1 END`
          : "1";
    for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
      const prefix = action === "DELETE" ? "OLD" : "NEW";
      yield* sql.unsafe(`CREATE TRIGGER ${table}_snapshot_generation_${action.toLowerCase()} AFTER ${action} ON ${table} ${table === "memory_import_keys" ? `WHEN ${prefix}.key_kind!='hub_checkpoint_token'` : ""} BEGIN
        INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${prefix}.${spaceColumn},'hub_snapshot_generation','',1)
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+1;
      END`);
    }
    for (const [dimension, expression] of [
      ["hub_snapshot_bytes", bytes("")],
      ["hub_snapshot_rows", recordRows("")],
    ] as const) {
      yield* sql.unsafe(
        `INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
        SELECT ${spaceColumn},?,'',sum(${expression}) FROM ${table} GROUP BY ${spaceColumn}
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`,
        [dimension],
      );
      const change = (prefix: string, sign: number) =>
        sign < 0
          ? `UPDATE memory_quota_counters SET value=value-(${dimension === "hub_snapshot_rows" ? recordRows(`${prefix}.`) : bytes(`${prefix}.`)}) WHERE space=${prefix}.${spaceColumn} AND dimension='${dimension}' AND scope_key='';`
          : `INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
        VALUES (${prefix}.${spaceColumn},'${dimension}','',${dimension === "hub_snapshot_rows" ? recordRows(`${prefix}.`) : bytes(`${prefix}.`)})
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`;
      for (const [action, body] of [
        ["INSERT", change("NEW", 1)],
        ["UPDATE", change("OLD", -1) + change("NEW", 1)],
        ["DELETE", change("OLD", -1)],
      ] as const)
        yield* sql.unsafe(
          `CREATE TRIGGER ${table}_${dimension}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${body} END`,
        );
    }
  }
  for (const [action, prefix, sign] of [
    ["INSERT", "NEW", -1],
    ["DELETE", "OLD", 1],
  ] as const)
    yield* sql.unsafe(`CREATE TRIGGER memory_tombstones_snapshot_forget_${action.toLowerCase()} AFTER ${action} ON memory_tombstones BEGIN
      UPDATE memory_quota_counters SET value=value+${sign}*8 WHERE space=${prefix}.space AND dimension='hub_snapshot_rows' AND scope_key='' AND EXISTS(SELECT 1 FROM memory_identity_ledger i WHERE i.space=${prefix}.space AND i.memory_id=${prefix}.memory_id);
    END`);
});
