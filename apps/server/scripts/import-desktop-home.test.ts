// @effect-diagnostics nodeBuiltinImport:off - Verifies source bytes and runs the manual CLI in a scratch HOME.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import { vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { CLEARED_TABLES } from "./migrate-dev-db.ts";
import { runImportDesktopHome } from "./import-desktop-home.ts";

vi.mock("node:fs", { spy: true });

const withDatabase = <A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

/** A migrated source db with one V2 thread per lifecycle state. Only
 * `stopped-thread` and its fork qualify for the clone. */
const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      // Excluded threads are newer than the kept family, so only the filters
      // can keep them out of a one-family-per-project clone.
      const threads = [
        ["stopped-thread", "project-kept", "completed", "{}", "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        // Its result never reached the parent, so startup would deliver it.
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
      ] as const;
      for (const [threadId, projectId, runStatus, payload, updatedAt] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${updatedAt}, ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}')`;
      }
      // A provider session shared by two threads names its latest writer.
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'settled-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
        VALUES ('pending-command', 'thread', 'stopped-thread', '2026-08-01', 0, 'accepted')`;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
        VALUES ('pending-effect', 'pending-command', 'stopped-thread', 'provider.start', '{}', 'pending', '2026-08-01', '2026-08-01', '2026-08-01')`;
      yield* sql`INSERT INTO orchestration_v2_thread_launch_workflows (command_id, thread_id, project_id, status, title, created_at, updated_at)
        VALUES ('launch-command', 'stopped-thread', 'project-kept', 'pending', 'pending launch', '2026-08-01', '2026-08-01')`;
      yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at)
        VALUES ('stopped-thread', 'codex', 'codex', 'running', '2026-08-01')`;
      yield* sql`INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at, expires_at)
        VALUES ('pairing-link', 'fixture', 'pairing', '[]', 'user', '2026-08-01', '2027-08-01')`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

it.layer(NodeServices.layer)("import-desktop-home", (it) => {
  it.effect(
    "retains a committed row checkpointed between opening the source and taking its snapshot",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "goat-import-checkpoint-" }),
        );
        const from = path.join(root, "source");
        const source = yield* createFixtureSource(from);
        const writer = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(source)),
          (db) => Effect.sync(() => db.close()),
        );
        writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
        let checkpointed = false;
        const originalPrepare = NodeSqlite.DatabaseSync.prototype.prepare;
        const prepare = vi
          .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
          .mockImplementation(function (this: NodeSqlite.DatabaseSync, statement) {
            if (statement === "VACUUM main INTO ?") {
              writer.exec(`BEGIN;
            INSERT INTO orchestration_v2_projection_threads
              (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
              VALUES ('checkpoint-thread', 'project-kept', 'Checkpoint', 'codex', 'full-access', 'default', '2026-08-01', '2026-08-01', '{}');
            INSERT INTO orchestration_v2_projection_runs
              (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
              VALUES ('checkpoint-run', 'checkpoint-thread', 1, 'codex', 'completed', '2026-08-01', '{}');
            INSERT INTO orchestration_events
              (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
              VALUES ('checkpoint-event', 'thread', 'checkpoint-thread', 0, 'thread.created', '2026-08-01', 'user', '{}', '{}');
            COMMIT;`);
              assert.isAbove(NodeFS.statSync(source + "-wal").size, 0);
              writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
              assert.strictEqual(NodeFS.statSync(source + "-wal").size, 0);
              checkpointed = true;
            }
            return originalPrepare.call(this, statement);
          });
        const result = yield* runImportDesktopHome(from, {
          homeDirectory: path.join(root, "account"),
        }).pipe(Effect.ensuring(Effect.sync(() => prepare.mockRestore())));
        assert.isTrue(checkpointed);
        assert.strictEqual(result.retained.events, 3);
        yield* withDatabase(
          result.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows =
              yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = 'checkpoint-thread'`;
            assert.deepStrictEqual(rows, [{ thread_id: "checkpoint-thread" }]);
          }),
        );
        assert.isFalse(
          vi
            .mocked(NodeFS.copyFileSync)
            .mock.calls.some(([input]) =>
              [source, source + "-wal", source + "-shm"].includes(String(input)),
            ),
        );
      }).pipe(Effect.scoped),
  );
  it.effect(
    "imports all eligible projects and stopped families, clears runnable rows, and preserves source bytes including WAL",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "goat-import-test-" }),
        );
        const sourceHome = path.join(root, "source");
        const home = path.join(root, "account");
        const source = yield* createFixtureSource(sourceHome);
        for (const name of ["secrets", "settings.json", "server-runtime.json"]) {
          yield* fs.writeFileString(path.join(sourceHome, "userdata", name), "do not import");
        }
        yield* fs.makeDirectory(path.join(home, ".goat", "desktop", "userdata"), {
          recursive: true,
        });
        const sentinel = path.join(home, ".goat", "desktop", "userdata", "existing.txt");
        yield* fs.writeFileString(sentinel, "preserve");
        // Keep committed WAL content live while SQLite takes its read-only source snapshot.
        yield* withDatabase(
          source,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
            yield* sql.unsafe("PRAGMA wal_autocheckpoint = 0").unprepared;
            for (let project = 0; project < 6; project++) {
              const id = `extra-project-${project}`;
              yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
            VALUES (${id}, ${id}, '/tmp/project', '[]', '2026-08-01', '2026-08-01')`;
              for (let thread = 0; thread < 11; thread++) {
                const tid = `${id}-thread-${thread}`;
                yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
              VALUES (${tid}, ${id}, ${tid}, 'codex', 'full-access', 'default', '2026-08-01', '2026-08-01', '{}')`;
                yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
              VALUES (${`run-${tid}`}, ${tid}, 1, 'codex', 'completed', '2026-08-01', '{}')`;
              }
            }
            const bytes = ["", "-wal"].map((suffix) => NodeFS.readFileSync(source + suffix));
            const result = yield* runImportDesktopHome(sourceHome, { homeDirectory: home });
            assert.equal(result.retained.projects, 7);
            assert.equal(result.retained.threads, 68);
            assert.equal(result.retained.events, 2);
            for (const [i, suffix] of ["", "-wal"].entries())
              assert.deepStrictEqual(NodeFS.readFileSync(source + suffix), bytes[i]);
            // Read-only SQLite connections may update SHM reader marks, not database content.
            assert.isTrue(NodeFS.existsSync(source + "-shm"));
            const threads = yield* withDatabase(
              result.databasePath,
              Effect.gen(function* () {
                const imported = yield* SqlClient.SqlClient;
                for (const table of CLEARED_TABLES) {
                  const [row] = yield* imported.unsafe<{ n: number }>(
                    `SELECT COUNT(*) AS n FROM "${table}"`,
                  );
                  assert.equal(row?.n, 0, table);
                }
                return yield* imported<{
                  thread_id: string;
                }>`SELECT thread_id FROM orchestration_v2_projection_threads`;
              }),
            );
            assert.include(
              threads.map((r) => r.thread_id),
              "stopped-thread",
            );
            assert.include(
              threads.map((r) => r.thread_id),
              "fork-thread",
            );
            assert.notInclude(
              threads.map((r) => r.thread_id),
              "running-thread",
            );
            const destinationBytes = NodeFS.readFileSync(result.databasePath);
            assert.isTrue(
              yield* runImportDesktopHome(sourceHome, { homeDirectory: home }).pipe(
                Effect.isFailure,
              ),
            );
            assert.deepStrictEqual(NodeFS.readFileSync(result.databasePath), destinationBytes);
            assert.equal(NodeFS.statSync(result.databasePath).mode & 0o777, 0o600);
            assert.equal(yield* fs.readFileString(sentinel), "preserve");
            for (const name of ["secrets", "settings.json", "server-runtime.json"])
              assert.isFalse(yield* fs.exists(path.join(path.dirname(result.databasePath), name)));
            assert.isFalse(yield* fs.exists(path.join(home, ".goat", "userdata")));
          }),
        );
      }),
  );
  it.effect(
    "refuses missing/V1 sources, symlinks, target database and sidecars without modifying them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "goat-import-refuse-" }),
        );
        const from = path.join(root, "source");
        const home = path.join(root, "account");
        yield* fs.makeDirectory(path.join(from, "userdata"), { recursive: true });
        yield* fs.writeFileString(path.join(from, "userdata", "state.sqlite"), "legacy");
        assert.isTrue(
          yield* runImportDesktopHome(from, { homeDirectory: home }).pipe(Effect.isFailure),
        );
        yield* createFixtureSource(from);
        const alias = path.join(root, "alias");
        NodeFS.symlinkSync(from, alias, "dir");
        assert.isTrue(
          yield* runImportDesktopHome(alias, { homeDirectory: home }).pipe(Effect.isFailure),
        );
        const state = path.join(home, ".goat", "desktop", "userdata");
        yield* fs.makeDirectory(state, { recursive: true });
        for (const name of [
          "statev2.sqlite",
          "statev2.sqlite-wal",
          "statev2.sqlite-shm",
          "server-runtime.json",
        ]) {
          const target = path.join(state, name);
          yield* fs.writeFileString(target, "existing");
          assert.isTrue(
            yield* runImportDesktopHome(from, { homeDirectory: home }).pipe(Effect.isFailure),
          );
          assert.equal(yield* fs.readFileString(target), "existing");
          yield* fs.remove(target);
        }
        NodeFS.symlinkSync(path.join(root, "missing"), path.join(state, "statev2.sqlite"));
        assert.isTrue(
          yield* runImportDesktopHome(from, { homeDirectory: home }).pipe(Effect.isFailure),
        );
        assert.isTrue(NodeFS.lstatSync(path.join(state, "statev2.sqlite")).isSymbolicLink());
      }),
  );
  it.effect(
    "leaves source bytes and racing destinations intact on migration or publication failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "goat-import-failure-" }),
        );
        const from = path.join(root, "source");
        const home = path.join(root, "account");
        const source = yield* createFixtureSource(from);
        yield* withDatabase(
          source,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE effect_sql_migrations SET name = 'SomebodyElsesMigration' WHERE migration_id = 1`;
          }),
        );
        const before = NodeFS.readFileSync(source);
        const error = yield* runImportDesktopHome(from, { homeDirectory: home }).pipe(Effect.flip);
        assert.equal(error._tag, "MigrateDevDbSlotCollisionError");
        assert.deepStrictEqual(NodeFS.readFileSync(source), before);
        const dest = path.join(home, ".goat", "desktop", "userdata", "statev2.sqlite");
        assert.isFalse(NodeFS.existsSync(dest));
        const clean = path.join(root, "clean");
        yield* createFixtureSource(clean);
        const originalLink = NodeFS.linkSync;
        const spy = vi.spyOn(NodeFS, "linkSync").mockImplementation((staged, target) => {
          NodeFS.writeFileSync(target, "racing desktop DB");
          originalLink(staged, target);
        });
        yield* Effect.gen(function* () {
          assert.isTrue(
            yield* runImportDesktopHome(clean, { homeDirectory: home }).pipe(Effect.isFailure),
          );
          assert.equal(NodeFS.readFileSync(dest, "utf8"), "racing desktop DB");
          assert.deepStrictEqual(NodeFS.readdirSync(path.dirname(dest)), ["statev2.sqlite"]);
        }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
      }),
  );
  it.effect("runs the real manual command under a scratch HOME and refuses a second import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "goat-import-cli-" }),
      );
      const source = path.join(root, "source");
      yield* createFixtureSource(source);
      const args = ["apps/server/scripts/import-desktop-home.ts", "--from", source];
      const options = {
        cwd: path.resolve(import.meta.dirname, "../../.."),
        encoding: "utf8" as const,
        env: { ...process.env, HOME: root, T3CODE_HOME: path.join(root, "ignored") },
      };
      const first = NodeChildProcess.spawnSync(process.execPath, args, options);
      assert.equal(first.status, 0, first.stderr);
      assert.include(first.stdout, "2 threads");
      const db = path.join(root, ".goat", "desktop", "userdata", "statev2.sqlite");
      const bytes = NodeFS.readFileSync(db);
      assert.notEqual(NodeChildProcess.spawnSync(process.execPath, args, options).status, 0);
      assert.deepStrictEqual(NodeFS.readFileSync(db), bytes);
      assert.notEqual(
        NodeChildProcess.spawnSync(process.execPath, [...args, "--to", root], options).status,
        0,
      );
      assert.notEqual(NodeChildProcess.spawnSync(process.execPath, [args[0]!], options).status, 0);
      assert.isFalse(NodeFS.existsSync(path.join(root, "ignored")));
    }),
  );
});
