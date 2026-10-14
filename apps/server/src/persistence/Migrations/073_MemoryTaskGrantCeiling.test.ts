import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationEntries, runMigrations } from "../Migrations.ts";
import { reconcileGoatMigrationIds } from "../reconcileGoatMigrationIds.ts";

const insertTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      INSERT INTO scheduled_tasks (
        task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,
        model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,
        created_at,updated_at,last_run_status,run_count
      ) VALUES (
        'synthetic-task','Synthetic task','Synthetic prompt',1,'{}','synthetic-project','{}',
        '{}','full-access','default','agent','mcp','2026-10-15','2026-10-15','never',0
      )
    `;
});

it.effect(
  "defaults existing tasks to none, constrains ceilings, and safely reruns via the ledger",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* insertTask;
      assert.deepStrictEqual(yield* runMigrations(), [[73, "MemoryTaskGrantCeiling"]]);
      assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
        { memory_grant_ceiling: "none" },
      ]);
      for (const ceiling of ["none", "read", "read_write"]) {
        yield* sql`UPDATE scheduled_tasks SET memory_grant_ceiling=${ceiling}`;
        assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
          { memory_grant_ceiling: ceiling },
        ]);
      }
      for (const ceiling of ["full-access", "", null]) {
        yield* sql`UPDATE scheduled_tasks SET memory_grant_ceiling=${ceiling}`.pipe(Effect.flip);
        assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
          { memory_grant_ceiling: "read_write" },
        ]);
      }
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
        { memory_grant_ceiling: "read_write" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "renumbers the ceiling by stable name without replaying ALTER TABLE or losing grants",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* insertTask;
      yield* sql`UPDATE scheduled_tasks SET memory_grant_ceiling='read'`;
      // An upstream migration claims 73; the existing GOAT ceiling moves to 74.
      const incoming = [
        ...migrationEntries.filter(([id]) => id < 73),
        [
          73,
          "SyntheticUpstream",
          sql`CREATE TABLE IF NOT EXISTS ceiling_renumber_fixture (id INTEGER)`,
        ] as const,
        ...migrationEntries
          .filter(([id]) => id >= 73)
          .map(([id, name, migration]) => [id + 1, name, migration] as const),
      ];
      assert.deepStrictEqual(yield* reconcileGoatMigrationIds(incoming), [
        [73, "SyntheticUpstream"],
      ]);
      const loader = Migrator.fromRecord(
        Object.fromEntries(incoming.map(([id, name, migration]) => [`${id}_${name}`, migration])),
      );
      assert.deepStrictEqual(yield* Migrator.make({})({ loader }), []);
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id>=73 ORDER BY migration_id`,
        [
          { migration_id: 73, name: "SyntheticUpstream" },
          { migration_id: 74, name: "MemoryTaskGrantCeiling" },
        ],
      );
      assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
        { memory_grant_ceiling: "read" },
      ]);
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_tasks)`;
      assert.strictEqual(columns.filter(({ name }) => name === "memory_grant_ceiling").length, 1);
      assert.deepStrictEqual(yield* reconcileGoatMigrationIds(incoming), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
