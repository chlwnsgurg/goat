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
    compaction_json TEXT, checkpoint_bytes INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_bytes>=0),
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
});
