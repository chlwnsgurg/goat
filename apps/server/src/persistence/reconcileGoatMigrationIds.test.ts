import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { reconcileGoatMigrationIds } from "./reconcileGoatMigrationIds.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

// GOAT builds before the upstream sync that added PullRequestReviewGuides at 61 recorded
// GOAT's own migrations at 61 and up.
const seedGoatLedger = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 60 });
    const byName = new Map<string, (typeof migrationEntries)[number][2]>(
      migrationEntries.map(([, name, migration]) => [name, migration]),
    );
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          names.map((name, index) => [`${61 + index}_${name}`, byName.get(name)!]),
        ),
      ),
    });
  });

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const hasReviewGuides = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_review_guides'
  `;
  return tables.length === 1;
});

describe("GOAT migration ids", () => {
  it.effect("runs the upstream migration a GOAT ledger skipped and moves GOAT's ids up", () =>
    Effect.gen(function* () {
      yield* seedGoatLedger([
        "ServerActivityIndexes",
        "RemoteReports",
        "RemoteDispatches",
        "ChannelLedger",
        "RemoteDispatchQuestions",
        "ThreadRunResults",
        "RemoteReportRelay",
        "ProjectionTurnItemRequestIndex",
        "Memory",
        "MemoryHubSync",
        "MemorySearchCounters",
        "MemoryTaskGrantCeiling",
      ]);
      assert.isFalse(yield* hasReviewGuides);
      assert.deepStrictEqual(yield* runMigrations(), [[61, "PullRequestReviewGuides"]]);
      assert.isTrue(yield* hasReviewGuides);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("finishes the GOAT migrations a partial ledger had not reached yet", () =>
    Effect.gen(function* () {
      yield* seedGoatLedger(["ServerActivityIndexes", "RemoteReports", "RemoteDispatches"]);
      assert.deepStrictEqual(yield* runMigrations(), [
        [61, "PullRequestReviewGuides"],
        [65, "ChannelLedger"],
        [66, "RemoteDispatchQuestions"],
        [67, "ThreadRunResults"],
        [68, "RemoteReportRelay"],
        [69, "ProjectionTurnItemRequestIndex"],
        [70, "Memory"],
        [71, "MemoryHubSync"],
        [72, "MemorySearchCounters"],
        [73, "MemoryTaskGrantCeiling"],
      ]);
      assert.isTrue(yield* hasReviewGuides);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("reconciles Memory by stable name after upstream claims its old ID", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(migrationManifest.at(-1), [73, "MemoryTaskGrantCeiling"]);
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_quota_counters VALUES ('fixture','live','user',7)`;
      const future = migrationEntries.map(
        ([n, name, migration]) => [n >= 70 ? n + 1 : n, name, migration] as const,
      );
      const displaced = Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS future_fixture (id INTEGER)`;
      });
      const incoming = [
        ...future.filter(([n]) => n < 70),
        [70, "FutureUpstream", displaced] as const,
        ...future.filter(([n]) => n >= 70),
      ];
      yield* reconcileGoatMigrationIds(incoming);
      const ledger = yield* history;
      assert.isTrue(ledger.some(([n, name]) => n === 71 && name === "Memory"));
      assert.strictEqual(
        (yield* sql<{
          value: number;
        }>`SELECT value FROM memory_quota_counters WHERE space='fixture' AND dimension='live' AND scope_key='user'`)[0]
          ?.value,
        7,
      );
      assert.strictEqual(
        (yield* sql`SELECT name FROM sqlite_master WHERE name='future_fixture'`).length,
        1,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
