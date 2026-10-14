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
    yield* hub;
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
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
