import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import memory from "./070_Memory.ts";
import hub from "./071_MemoryHubSync.ts";

it.effect("upgrades 070 without rewriting legacy resolution data or sync payloads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* memory;
    yield* sql`INSERT INTO memory_events (protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,'space','memory','operation','forget','env','original-digest','{}','{}',0)`;
    yield* sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at) VALUES ('sync','space','sync','retry','{"operationId":"operation"}',42)`;
    // Pre-upgrade canonical metadata is seeded into global counters once.
    yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys) VALUES ('space','memory','{}','{}',101,2)`;
    yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES ('space','fixture','key','memory','"한글"')`;
    yield* hub;
    const counter = (dimension: string) =>
      sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension=${dimension} AND scope_key=''`.pipe(
        Effect.map((rows) => rows[0]!.value),
      );
    assert.strictEqual(
      yield* counter("hub_metadata"),
      101 + 336 + 336 + new TextEncoder().encode('"한글"').length,
    );
    assert.strictEqual(yield* counter("hub_receipts"), 2);
    assert.strictEqual(yield* counter("hub_ids"), 1);
    assert.strictEqual(yield* counter("hub_keys"), 3);
    const baseline = yield* counter("hub_metadata");
    yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES ('other','환경','digest',1,'active')`;
    const privateBytes = new TextEncoder().encode("other환경digest1active").length;
    assert.strictEqual(yield* counter("hub_private_metadata"), privateBytes);
    assert.strictEqual(yield* counter("hub_metadata"), baseline + privateBytes);
    yield* sql`UPDATE memory_hub_members SET credential_digest='changed-digest' WHERE space='other'`;
    assert.strictEqual(yield* counter("hub_metadata"), baseline + privateBytes + 8);
    yield* sql`DELETE FROM memory_hub_members WHERE space='other'`;
    assert.strictEqual(yield* counter("hub_metadata"), baseline);
    // Event -> compact representation -> event retirement counts one receipt throughout.
    yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json,compact_blob) VALUES ('space','operation','original-digest',1,'{}','{}',${new Uint8Array([1, 2, 3, 4])})`;
    assert.strictEqual(yield* counter("hub_receipts"), 2);
    assert.strictEqual(yield* counter("hub_metadata"), baseline - 336 + 4);
    yield* sql`DELETE FROM memory_events WHERE operation_id='operation'`;
    assert.strictEqual(yield* counter("hub_receipts"), 2);
    assert.strictEqual(yield* counter("hub_metadata"), baseline - 336 + 4);
    yield* sql`INSERT INTO memory_events (protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,'space','memory','operation','forget','env','original-digest','{}','{}',0)`;
    const failed = yield* sql
      .withTransaction(
        sql`UPDATE memory_identity_ledger SET reserve_bytes=202 WHERE memory_id='memory'`.pipe(
          Effect.andThen(Effect.fail("rollback")),
        ),
      )
      .pipe(Effect.flip);
    assert.strictEqual(failed, "rollback");
    assert.strictEqual(yield* counter("hub_metadata"), baseline - 336 + 4);
    const rows = yield* sql<{
      operation_digest: string;
      sync_version: number;
      next_attempt_at: number;
    }>`SELECT operation_digest,sync_version,next_attempt_at FROM memory_outbox`;
    assert.deepStrictEqual(rows, [
      { operation_digest: "original-digest", sync_version: 0, next_attempt_at: 42 },
    ]);
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_hub_%'`;
    assert.strictEqual(tables.length, 5);
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(memory_outbox)`;
    assert.isTrue(columns.some((c) => c.name === "frozen_claim_json"));
    assert.isTrue(columns.some((c) => c.name === "terminal_at"));
    const triggers =
      yield* sql`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%hub_account_%'`;
    assert.strictEqual(triggers.length, 33);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
