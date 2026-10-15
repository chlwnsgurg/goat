import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import reportMigration from "./077_MemoryReportLifecycle.ts";
const database = NodeSqliteClient.layer({ filename: ":memory:" });
it.effect("077 DDL and accounting rollback together then ledger restart preserves rows", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 76 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolving_environment_id,outcome,state,created_at) VALUES ('legacy','space','memory','op','owner','failed','pending',0)`;
    const before =
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
    yield* sql
      .withTransaction(reportMigration.pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.exit);
    assert.isFalse(
      (yield* sql<{ name: string }>`PRAGMA table_info(memory_report_outbox)`).some(
        (r) => r.name === "automatic_attempts",
      ),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
      before,
    );
    assert.deepStrictEqual(yield* runMigrations(), [[77, "MemoryReportLifecycle"]]);
    assert.deepStrictEqual(
      yield* sql`SELECT automatic_attempts,report_kind,report_approved FROM memory_report_outbox`,
      [{ automatic_attempts: 0, report_kind: "unknown", report_approved: 0 }],
    );
    const migrated =
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
      migrated,
    );
    assert.strictEqual(
      (yield* sql`UPDATE memory_report_outbox SET automatic_attempts=11`.pipe(Effect.exit))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(database)),
);
it.effect("077 refuses an incompatible prerelease ledger before modifying memory", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE effect_sql_migrations SET migration_id=177 WHERE name='MemoryReportLifecycle'`;
    assert.strictEqual((yield* runMigrations().pipe(Effect.exit))._tag, "Failure");
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM effect_sql_migrations WHERE name='MemoryReportLifecycle' AND migration_id=177`)
        .length,
      1,
    );
  }).pipe(Effect.provide(database)),
);
