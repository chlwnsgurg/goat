import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/070_Memory.ts";
import { runMigrations } from "../persistence/Migrations.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
describe("Memory migration", () => {
  it.effect("upgrades through incoming 069 and creates memory tables idempotently", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* migration;
      yield* migration;
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%'`;
      for (const name of [
        "memory_items",
        "memory_events",
        "memory_payloads",
        "memory_project_bindings",
        "memory_pending_forget_intents",
        "memory_identity_ledger",
        "memory_storage_samples",
      ])
        assert.isTrue(rows.some((row) => row.name === name));
    }).pipe(Effect.provide(database)),
  );
  it.effect("binding table constraints survive restart without copied provider data", () =>
    Effect.gen(function* () {
      yield* migration;
      const sql = yield* SqlClient.SqlClient;
      const bad = yield* Effect.exit(
        sql`INSERT INTO memory_project_bindings VALUES ('space','env','project',NULL,NULL,-1,0)`,
      );
      assert.isTrue(bad._tag === "Failure");
      yield* sql`INSERT INTO memory_project_bindings VALUES ('space','env','project',NULL,NULL,0,0)`;
      yield* migration;
      assert.strictEqual((yield* sql`SELECT * FROM memory_project_bindings`).length, 1);
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
    }).pipe(Effect.provide(database)),
  );
  it.effect("rolls back migration DDL with its transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql
        .withTransaction(Effect.andThen(migration, Effect.fail("barrier")))
        .pipe(Effect.exit);
      assert.strictEqual(
        (yield* sql`SELECT name FROM sqlite_master WHERE name='memory_events'`).length,
        0,
      );
    }).pipe(Effect.provide(database)),
  );
});
