import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "installs one body-free table, one lookup index and three delta triggers without changing search counters",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      yield* sql`INSERT INTO memory_search_counters VALUES ('synthetic','user',7,5,123)`;
      assert.deepStrictEqual(yield* runMigrations(), [[74, "MemoryImportLineage"]]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_search_counters`, [
        { space: "synthetic", scope_key: "user", eligible: 7, indexed: 5, text_bytes: 123 },
      ]);
      const triggers =
        yield* sql`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_import_lineage'`;
      assert.strictEqual(triggers.length, 3);
      const indexes =
        yield* sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_import_lineage' AND sql IS NOT NULL`;
      assert.strictEqual(indexes.length, 1);
      yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys)
      VALUES ('synthetic','memory','{}','{}',20000,0)`;
      const counters = () =>
        sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
      const before = yield* counters();
      yield* sql`INSERT INTO memory_import_lineage VALUES ('synthetic','memory','sourceKey','key','{}')`;
      assert.deepStrictEqual(
        yield* sql`SELECT value FROM memory_quota_counters WHERE dimension='import_lineage_bytes'`,
        [{ value: 2 }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT reserve_bytes,reserve_keys FROM memory_identity_ledger`,
        [{ reserve_bytes: 20066, reserve_keys: 1 }],
      );
      const inserted = yield* counters();
      yield* sql`INSERT INTO memory_import_lineage VALUES ('synthetic','memory','sourceKey','key','{}') ON CONFLICT DO NOTHING`;
      assert.deepStrictEqual(yield* counters(), inserted);
      yield* sql`UPDATE memory_import_lineage SET record_json='{"x":1}'`;
      assert.deepStrictEqual(
        yield* sql`SELECT value FROM memory_quota_counters WHERE dimension='import_lineage_bytes'`,
        [{ value: 7 }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT reserve_bytes,reserve_keys FROM memory_identity_ledger`,
        [{ reserve_bytes: 20071, reserve_keys: 1 }],
      );
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM memory_import_lineage`;
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        yield* sql`SELECT value FROM memory_quota_counters WHERE dimension='import_lineage_bytes'`,
        [{ value: 7 }],
      );
      yield* sql`DELETE FROM memory_import_lineage`;
      assert.deepStrictEqual(
        yield* sql`SELECT reserve_bytes,reserve_keys FROM memory_identity_ledger`,
        [{ reserve_bytes: 20000, reserve_keys: 0 }],
      );
      // Generation is monotonic; all byte/row counters return to the original allocation.
      const withoutGeneration = (rows: readonly { readonly [key: string]: unknown }[]) =>
        rows.filter((r) => r.dimension !== "hub_snapshot_generation" && r.value !== 0);
      assert.deepStrictEqual(withoutGeneration(yield* counters()), withoutGeneration(before));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
