import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * GOAT's own migrations, which sit after upstream's in `migrationEntries`. An upstream sync that
 * adds ids GOAT already used moves these up; the names stay stable.
 */
export const GOAT_MIGRATION_NAMES: ReadonlySet<string> = new Set([
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
]);

// These ids identify the first releasable memory schema. Older sandbox schemas are not migrated.
const RELEASED_MEMORY_MIGRATION_IDS = new Map([
  ["Memory", 71],
  ["MemoryHubSync", 72],
  ["MemorySearchCounters", 73],
  ["MemoryTaskGrantCeiling", 74],
  ["MemoryImportLineage", 75],
]);

type MigrationEntry<E> = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<unknown, E, SqlClient.SqlClient>,
];

/**
 * The migrator skips every id at or below the highest one recorded, so a database that recorded a
 * GOAT migration under an id upstream later claimed would never run upstream's migration there.
 * Before the migrator runs, this moves recorded GOAT migrations to their current ids and runs the
 * upstream migrations they displaced. Upstream migrations it runs must be idempotent, as upstream
 * writes them (`CREATE ... IF NOT EXISTS`).
 */
export const reconcileGoatMigrationIds = Effect.fn("reconcileGoatMigrationIds")(function* <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND (name = 'effect_sql_migrations' OR name GLOB 'memory_*')
      `;
      const hasLedger = tables.some((table) => table.name === "effect_sql_migrations");
      const history = hasLedger
        ? yield* sql<{ readonly migration_id: number; readonly name: string }>`
            SELECT migration_id, name FROM effect_sql_migrations
          `
        : [];
      const incompatibleLedger = history.some((row) => {
        const releasedId = RELEASED_MEMORY_MIGRATION_IDS.get(row.name);
        return releasedId !== undefined && row.migration_id !== releasedId;
      });
      const unrecordedMemory =
        tables.some((table) => table.name.startsWith("memory_")) &&
        !history.some((row) => row.name === "Memory" && row.migration_id === 71);
      // Check before both the unchanged-id return and any ledger write: renumbering would hide
      // the only reliable evidence that a sandbox used an unreleased memory schema.
      if (incompatibleLedger || unrecordedMemory) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            "Unreleased memory DB is incompatible; reset this sandbox's memory development state and restart.",
        });
      }
      if (!hasLedger) return [];
      const currentIds = new Map(entries.map(([id, name]) => [name, id]));
      const goatRows = history.filter((row) => GOAT_MIGRATION_NAMES.has(row.name));
      if (goatRows.every((row) => currentIds.get(row.name) === row.migration_id)) return [];

      const upstreamRows = new Map(
        history
          .filter((row) => !GOAT_MIGRATION_NAMES.has(row.name))
          .map((row) => [row.migration_id, row.name]),
      );
      const movedIds = goatRows.map((row) => currentIds.get(row.name));
      if (movedIds.some((id) => id === undefined || upstreamRows.has(id))) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot move GOAT migrations onto ids another migration recorded.",
        });
      }
      const highestMoved = Math.max(...movedIds.map((id) => id ?? 0));
      const executed: Array<readonly [number, string]> = [];
      yield* sql`DELETE FROM effect_sql_migrations WHERE name IN ${sql.in(goatRows.map((row) => row.name))}`;
      for (const [id, name, migration] of entries) {
        if (GOAT_MIGRATION_NAMES.has(name) || id > highestMoved) continue;
        const recorded = upstreamRows.get(id);
        if (recorded === name) continue;
        if (recorded !== undefined) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Migration ${id} is recorded as ${recorded}, expected ${name}.`,
          });
        }
        yield* migration.pipe(
          Effect.mapError(
            (cause) =>
              new Migrator.MigrationError({
                kind: "Failed",
                message: `Migration ${id}_${name} failed: ${String(cause)}`,
              }),
          ),
        );
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        executed.push([id, name]);
      }
      for (const row of goatRows) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${currentIds.get(row.name)!}, ${row.name})`;
      }
      return executed;
    }),
  );
});
