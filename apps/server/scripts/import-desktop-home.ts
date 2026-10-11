#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Takes a consistent SQLite snapshot and publishes with a no-replace hard link.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Command, Flag } from "effect/cli";
import { CLEARED_TABLES, runMigrateDevDb } from "./migrate-dev-db.ts";

/** Reject symlink components, including dangling links, before reading or publishing data. */
function checkPath(path: string) {
  for (let current = path; ; current = NodePath.dirname(current)) {
    const stat = NodeFS.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink at '${current}'.`);
    if (NodePath.dirname(current) === current) break;
  }
}

function checkTarget(stateDir: string) {
  checkPath(stateDir);
  for (const name of [
    "statev2.sqlite",
    "statev2.sqlite-wal",
    "statev2.sqlite-shm",
    "server-runtime.json",
  ]) {
    if (NodeFS.lstatSync(NodePath.join(stateDir, name), { throwIfNoEntry: false })) {
      throw new Error(`Refusing existing desktop database or runtime file '${name}'.`);
    }
  }
}

function inspectDatabase(databasePath: string, verify = false) {
  const db = new NodeSqlite.DatabaseSync(databasePath);
  try {
    const count = (table: string) =>
      Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()!.n);
    if (verify) {
      const integrity = db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok")
        throw new Error("Imported database failed integrity_check.");
      for (const table of CLEARED_TABLES) {
        if (count(table) !== 0)
          throw new Error(`Imported database still contains runnable/auth rows in '${table}'.`);
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    // Total counts are upper bounds on eligible families, avoiding the dev sample caps.
    const projects = count("projection_projects");
    const hasV2 = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_threads'")
      .get();
    const threads = hasV2
      ? count("orchestration_v2_projection_threads")
      : count("projection_threads");
    return { projects, threads, events: count("orchestration_events") };
  } finally {
    db.close();
  }
}

/** Manual filtered import. homeDirectory is a test seam; the CLI has no destination override. */
export const runImportDesktopHome = Effect.fn("runImportDesktopHome")(function* (
  from: string,
  options: { readonly homeDirectory?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const home = NodePath.resolve(options.homeDirectory ?? NodeOS.homedir());
  const sourceHome = NodePath.resolve(from);
  const source = NodePath.join(sourceHome, "userdata", "statev2.sqlite");
  const stateDir = NodePath.join(home, ".goat", "desktop", "userdata");
  const destination = NodePath.join(stateDir, "statev2.sqlite");
  yield* Effect.try(() => {
    checkPath(source);
    checkTarget(stateDir);
    if (!NodeFS.lstatSync(source, { throwIfNoEntry: false })?.isFile())
      throw new Error(`Source V2 database does not exist at '${source}'.`);
    if (sourceHome === NodePath.dirname(stateDir) || source.startsWith(stateDir + NodePath.sep))
      throw new Error("Source aliases the desktop destination.");
  });
  return yield* Effect.gen(function* () {
    const work = yield* fs.makeTempDirectoryScoped({ prefix: "goat-desktop-import-" });
    const snapshot = NodePath.join(work, "source.sqlite");
    yield* Effect.try(() => {
      checkPath(source);
      const db = new NodeSqlite.DatabaseSync(source, { readOnly: true });
      try {
        // SQLite owns the read transaction across the main file and committed
        // WAL pages, so concurrent checkpoints cannot tear this snapshot.
        db.prepare("VACUUM main INTO ?").run(snapshot);
      } finally {
        db.close();
      }
    });
    const before = yield* Effect.try(() => inspectDatabase(snapshot));
    const migrated = yield* runMigrateDevDb(
      {
        source: snapshot,
        baseDir: NodePath.join(work, "filtered"),
        projects: Math.max(1, before.projects),
        threadsPerProject: before.threads,
      },
      { sharedHome: sourceHome },
    );
    const retained = yield* Effect.try(() => inspectDatabase(migrated.databasePath, true));
    yield* Effect.try(() => checkTarget(stateDir));
    yield* fs.makeDirectory(stateDir, { recursive: true });
    const publication = yield* fs.makeTempDirectoryScoped({
      directory: stateDir,
      prefix: ".import-",
    });
    yield* Effect.try(() => {
      const staged = NodePath.join(publication, "statev2.sqlite");
      NodeFS.copyFileSync(migrated.databasePath, staged, NodeFS.constants.COPYFILE_EXCL);
      NodeFS.chmodSync(staged, 0o600);
      checkTarget(stateDir);
      // Same-filesystem link is atomic and fails on EEXIST; never overwrite a racing DB.
      NodeFS.linkSync(staged, destination);
    });
    return {
      databasePath: destination,
      retained,
      excluded: {
        projects: before.projects - retained.projects,
        threads: before.threads - retained.threads,
        events: before.events - retained.events,
      },
    };
  }).pipe(Effect.scoped);
});

const command = Command.make("import-desktop-home", { from: Flag.String("from") }, ({ from }) =>
  Effect.gen(function* () {
    const result = yield* runImportDesktopHome(from);
    yield* Console.log(`Imported to ${result.databasePath}`);
    yield* Console.log(
      `Retained: ${result.retained.projects} projects, ${result.retained.threads} threads, ${result.retained.events} events; excluded: ${result.excluded.projects} projects, ${result.excluded.threads} threads, ${result.excluded.events} events.`,
    );
  }),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
