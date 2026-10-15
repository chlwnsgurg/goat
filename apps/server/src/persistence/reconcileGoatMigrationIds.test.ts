import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { reconcileGoatMigrationIds } from "./reconcileGoatMigrationIds.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

// GOAT builds record GOAT's own migrations right after the last upstream one they knew:
// at 61 before the sync that added PullRequestReviewGuides, at 62 before the one that
// added ThreadFailureLookupIndex.
const seedGoatLedger = (names: ReadonlyArray<string>, firstGoatId = 61) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: firstGoatId - 1 });
    const byName = new Map<string, (typeof migrationEntries)[number][2]>(
      migrationEntries.map(([, name, migration]) => [name, migration]),
    );
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          names.map((name, index) => [`${firstGoatId + index}_${name}`, byName.get(name)!]),
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
      ]);
      assert.isFalse(yield* hasReviewGuides);
      assert.deepStrictEqual(yield* runMigrations(), [
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
      ]);
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
        [62, "ThreadFailureLookupIndex"],
        [66, "ChannelLedger"],
        [67, "RemoteDispatchQuestions"],
        [68, "ThreadRunResults"],
        [69, "RemoteReportRelay"],
        [70, "ProjectionTurnItemRequestIndex"],
        [70, "Memory"],
      ]);
      assert.isTrue(yield* hasReviewGuides);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "moves a ledger that already ran PullRequestReviewGuides past ThreadFailureLookupIndex",
    () =>
      Effect.gen(function* () {
        yield* seedGoatLedger(
          [
            "ServerActivityIndexes",
            "RemoteReports",
            "RemoteDispatches",
            "ChannelLedger",
            "RemoteDispatchQuestions",
            "ThreadRunResults",
            "RemoteReportRelay",
            "ProjectionTurnItemRequestIndex",
          ],
          62,
        );
        assert.deepStrictEqual(yield* runMigrations(), [[62, "ThreadFailureLookupIndex"]]);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
