import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
// When on, workers run a script that never announces, like a worker stuck opening the file.
const silentWorkers = vi.hoisted(() => ({ on: false, readyOnTerminate: false }));
// When set, workers throw this at startup, like a checkpoint worker on SQLite before 3.51.
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(
        ...((silentWorkers.on
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : failingWorkers.message !== undefined
            ? [`throw new Error(${JSON.stringify(failingWorkers.message)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      startedWorkers.push(this);
    }
    override terminate() {
      // A "ready" already queued when termination starts reaches the parent before "exit".
      if (silentWorkers.readyOnTerminate) this.emit("message", { type: "ready" });
      return super.terminate();
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-reader-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );
});

// Recovery can fail before SQLite calls its busy handler. Inject only that
// native boundary error; successful attempts still execute against a real DB.
const recoveryBusy = () => Object.assign(new Error("database is locked"), { errcode: 261 });

it.effect("waits for WAL recovery when executing writer statements", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE recovery_entries(value INTEGER)`;
    const operations = [
      () => sql`INSERT INTO recovery_entries VALUES (1) RETURNING value`,
      () => sql`SELECT value FROM recovery_entries`.values,
      () => sql`SELECT value FROM recovery_entries`.valuesUnprepared,
      () => sql`SELECT value FROM recovery_entries`.unprepared,
    ];
    for (const operation of operations) {
      const attempted = yield* Deferred.make<void>();
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementationOnce(() => {
            Deferred.doneUnsafe(attempted, Effect.void);
            throw recoveryBusy();
          }),
        ),
        () =>
          Effect.gen(function* () {
            const fiber = yield* operation().pipe(Effect.forkChild);
            yield* Deferred.await(attempted);
            yield* TestClock.adjust("10 millis");
            yield* Fiber.join(fiber);
          }),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
    }
    const writes = [
      () => sql`INSERT INTO recovery_entries VALUES (2)`,
      () => sql`INSERT INTO recovery_entries VALUES (2)`.raw,
      () => sql`INSERT INTO recovery_entries VALUES (2)`.values,
      () => sql`INSERT INTO recovery_entries VALUES (2)`.valuesUnprepared,
    ];
    for (const write of writes) {
      const attempted = yield* Deferred.make<void>();
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "run").mockImplementationOnce(() => {
            Deferred.doneUnsafe(attempted, Effect.void);
            throw recoveryBusy();
          }),
        ),
        () =>
          Effect.gen(function* () {
            const fiber = yield* write().pipe(Effect.forkChild);
            yield* Deferred.await(attempted);
            yield* TestClock.adjust("10 millis");
            yield* Fiber.join(fiber);
          }),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
    }
    assert.deepEqual(yield* sql`SELECT value FROM recovery_entries`.values, [
      [1],
      [2],
      [2],
      [2],
      [2],
    ]);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("isolates a writer waiting for WAL recovery from another transaction's rollback", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE isolated_recovery(value TEXT)`;
    const insert = sql`INSERT INTO isolated_recovery VALUES ('survives')`;
    // Exercise a cached statement, rather than serializing on a pending prepare.
    yield* insert;
    yield* sql`DELETE FROM isolated_recovery`;
    const attempted = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const rollback = yield* Deferred.make<void>();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "run").mockImplementationOnce(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          throw recoveryBusy();
        }),
      ),
      () =>
        Effect.gen(function* () {
          const writer = yield* insert.pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          // Run B until it blocks on the permit (or, on the broken client,
          // enters its transaction and blocks on the rollback barrier).
          const transaction = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(rollback);
                return yield* Effect.fail("rollback B");
              }),
            )
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          const enteredDuringRecovery = yield* Deferred.isDone(entered);
          yield* TestClock.adjust("10 millis");
          yield* Fiber.join(writer);
          yield* Deferred.await(entered);
          yield* Deferred.succeed(rollback, undefined);
          assert.equal(yield* Fiber.join(transaction), "rollback B");
          // A must survive B's rollback even though A resumed on the same DB.
          assert.deepEqual(yield* sql`SELECT value FROM isolated_recovery`, [
            { value: "survives" },
          ]);
          assert.equal(enteredDuringRecovery, false);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("isolates values waiting for WAL recovery from the same cached object query", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const select = sql<{ value: number }>`SELECT 42 AS value`;
    yield* select;
    const attempted = yield* Deferred.make<void>();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementationOnce(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          throw recoveryBusy();
        }),
      ),
      () =>
        Effect.gen(function* () {
          const values = yield* select.values.pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          const objects = yield* select.pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust("10 millis");
          assert.deepEqual(yield* Fiber.join(values), [[42]]);
          assert.deepEqual(yield* Fiber.join(objects), [{ value: 42 }]);
          assert.deepEqual(yield* select, [{ value: 42 }]);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("releases statement permits and result mode after interrupted WAL recovery", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const select = sql<{ value: number }>`SELECT 42 AS value`;
    yield* select;
    const attempted = yield* Deferred.make<void>();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementationOnce(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          throw recoveryBusy();
        }),
      ),
      () =>
        Effect.gen(function* () {
          const values = yield* select.values.pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          const waiter = yield* select.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.interrupt(waiter);
          yield* Fiber.interrupt(values);
          assert.deepEqual(yield* select, [{ value: 42 }]);
          assert.deepEqual(yield* sql.withTransaction(select), [{ value: 42 }]);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("releases connections across statement scope consumers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const select = sql<{ value: number }>`SELECT 42 AS value`;
    // reserve owns its caller's scope; execute through the returned connection.
    const reserved = yield* Effect.scoped(
      Effect.flatMap(sql.reserve, (connection) =>
        connection.execute("SELECT 42 AS value", [], undefined),
      ),
    );
    assert.deepEqual(reserved, [{ value: 42 }]);
    assert.deepEqual(yield* select, reserved);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const results = yield* sql.reactiveMailbox(["statement-scope"], select);
        assert.deepEqual(yield* Queue.take(results), [{ value: 42 }]);
        // A reactive query must release before its subscription scope closes.
        assert.deepEqual(yield* select, [{ value: 42 }]);
        yield* Reactivity.invalidate(["statement-scope"]);
        assert.deepEqual(yield* Queue.take(results), [{ value: 42 }]);
      }),
    );

    const streamed = yield* select.stream.pipe(Stream.runCollect, Effect.exit);
    assert(Exit.isFailure(streamed));
    // Unsupported streams still close their acquisition scope on failure.
    assert.deepEqual(yield* select, [{ value: 42 }]);
    assert.deepEqual(yield* sql.withTransaction(sql.withTransaction(select)), [{ value: 42 }]);
  }).pipe(
    Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), Reactivity.layer)),
  ),
);

it.effect("waits for WAL recovery when preparing a writer statement", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attempted = yield* Deferred.make<void>();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare").mockImplementationOnce(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          throw recoveryBusy();
        }),
      ),
      () =>
        Effect.gen(function* () {
          const fiber = yield* sql`SELECT 42 AS value`.pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          yield* TestClock.adjust("10 millis");
          assert.deepEqual(yield* Fiber.join(fiber), [{ value: 42 }]);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("bounds WAL recovery retries and preserves the lock failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attempted = yield* Deferred.make<void>();
    let lastFailure = recoveryBusy();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          lastFailure = recoveryBusy();
          throw lastFailure;
        }),
      ),
      (spy) =>
        Effect.gen(function* () {
          const fiber = yield* sql`SELECT 1`.pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(attempted);
          yield* TestClock.adjust("5 seconds");
          const error = yield* Fiber.join(fiber);
          assert.equal(error.reason._tag, "LockTimeoutError");
          assert.equal(spy.mock.calls.length, 501);
          assert.strictEqual(error.reason.cause, lastFailure);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("stops WAL recovery retries when the SQLite error changes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attempted = yield* Deferred.make<void>();
    const snapshotFailure = Object.assign(new Error("stale snapshot"), { errcode: 517 });
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi
          .spyOn(NodeSqlite.StatementSync.prototype, "all")
          .mockImplementationOnce(() => {
            Deferred.doneUnsafe(attempted, Effect.void);
            throw recoveryBusy();
          })
          .mockImplementation(() => {
            throw snapshotFailure;
          }),
      ),
      (spy) =>
        Effect.gen(function* () {
          const fiber = yield* sql`SELECT 1`.pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(attempted);
          yield* TestClock.adjust("10 millis");
          const error = yield* Fiber.join(fiber);
          assert.equal(spy.mock.calls.length, 2);
          assert.strictEqual(error.reason.cause, snapshotFailure);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("does not retry a stale WAL snapshot or unrelated SQLite errors", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const errcode of [5, 517, 6, 19]) {
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(() => {
            throw Object.assign(new Error("sqlite failure"), { errcode });
          }),
        ),
        (spy) =>
          Effect.gen(function* () {
            yield* sql`SELECT 1`.pipe(Effect.flip);
            assert.equal(spy.mock.calls.length, 1);
          }),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const largeText = "x".repeat(64 * 1024 + 1);

it.effect("keeps large text and blob parameters off cached statements", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements: Array<NodeSqlite.StatementSync> = [];
    const all = NodeSqlite.StatementSync.prototype.all;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
          this: NodeSqlite.StatementSync,
          ...params
        ) {
          statements.push(this);
          return all.apply(this, params);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );

    const small = "small";
    const queries = [
      (value: string | Uint8Array | ArrayBuffer) => sql`SELECT length(${value}) AS size`,
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS size", [{ $value: value }]),
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS callable", [
          Object.assign(() => {}, { $value: value }),
        ]),
    ];
    const cached = new Set<NodeSqlite.StatementSync>();
    const large = new Set<NodeSqlite.StatementSync>();
    const largeBlobs = [new Uint8Array(64 * 1024 + 1), new ArrayBuffer(64 * 1024 + 1)];
    for (const value of [small, largeText, ...largeBlobs, small]) {
      const expected = typeof value === "string" ? value.length : value.byteLength;
      for (const query of queries) {
        assert.deepEqual((yield* query(value)).map(Object.values), [[expected]]);
        assert.deepEqual(yield* query(value).values, [[expected]]);
        for (const statement of statements.splice(0)) {
          (value === small ? cached : large).add(statement);
        }
      }
    }

    // Small parameters keep reusing the one cached statement for each query.
    assert.equal(cached.size, queries.length);
    // Each large execution gets a statement that nothing holds on to afterwards.
    assert.equal(large.size, queries.length * 6);
    assert.isTrue(cached.isDisjointFrom(large));
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("reads integers on the values path as the caller asked, cached or not", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const value of ["small", largeText]) {
      const values = sql`SELECT 1 AS id, length(${value}) AS size`.values;
      assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
        [1n, BigInt(value.length)],
      ]);
      assert.deepEqual(yield* values, [[1, value.length]]);
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("leaves a parameter it cannot measure for the statement to handle", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const detached = new DataView(new ArrayBuffer(8));
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    // What a detached view binds as varies by Node version; match the statement itself.
    const native = new NodeSqlite.DatabaseSync(":memory:");
    const expected = native.prepare("SELECT length(?) AS size").all(detached);
    native.close();
    assert.deepEqual(yield* sql`SELECT length(${detached}) AS size`, expected);

    const throwing = {
      get $value(): string {
        throw new Error("unreadable");
      },
    };
    const error = yield* sql.unsafe("SELECT length($value) AS size", [throwing]).pipe(Effect.flip);
    assert.equal(error.reason.operation, "execute");

    // Only the statement reads a getter, so it runs once as it would natively.
    let reads = 0;
    const counting = {
      get $value(): number {
        return ++reads;
      },
    };
    assert.deepEqual(yield* sql.unsafe("SELECT $value AS value", [counting]), [{ value: 1 }]);
    assert.equal(reads, 1);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  // node:sqlite connections fail a busy statement at once unless given a timeout.
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("pipelines reader requests before replies without leaking values mode", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      // Finish startup before holding requests at the worker transport boundary.
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers[startedWorkers.length - 1]!;
      const send = worker.postMessage.bind(worker);
      const requests: Array<() => void> = [];
      const postMessage = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
        requests.push(() => send(...args));
      });
      yield* Effect.gen(function* () {
        const select = sql`SELECT name FROM entries`;
        const values = yield* Effect.forkChild(select.values.pipe(SqliteClient.readOnly), {
          startImmediately: true,
        });
        const objects = yield* Effect.forkChild(select.pipe(SqliteClient.readOnly), {
          startImmediately: true,
        });
        // Routing awaits the already-resolved startup Promise even for a warm
        // reader. Let its microtasks run before checking outstanding requests.
        yield* Effect.yieldNow;
        // Neither request has reached the real worker, so no reply can release
        // a statement lease. Both must already have crossed the permit boundary.
        assert.lengthOf(requests, 2);
        postMessage.mockRestore();
        for (const request of requests) request();
        assert.deepEqual(yield* Fiber.join(values), [["first"]]);
        assert.deepEqual(yield* Fiber.join(objects), [{ name: "first" }]);
        assert.deepEqual(yield* select.pipe(SqliteClient.readOnly), [{ name: "first" }]);
      }).pipe(Effect.ensuring(Effect.sync(() => postMessage.mockRestore())));
    }),
  ),
);

it.effect("lets the writer commit while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            // Holding the writer lock here would deadlock this join.
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);

      // The reader keeps the snapshot it began with, and later reads see the commit.
      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

it.effect("rejects a write in a read-only transaction", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('blocked')`)
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps the reader read-only even if a statement turns query_only off", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`PRAGMA query_only = OFF`;
            yield* sql`INSERT INTO entries VALUES ('blocked')`;
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps read-only work inside a write transaction on the writer", () =>
  withReaderClient((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES ('uncommitted')`;
        // Only the writer can see its own uncommitted row.
        const count = yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        assert.equal(count, 2);
      }),
    ),
  ),
);

it.effect("labels SQL spans with their connection and how long they waited for its lock", () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return withReaderClient((sql) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      yield* Deferred.await(held);
      // Each waiter runs until it blocks on the writer lock, before the clock moves.
      const statement = yield* Effect.forkChild(sql`SELECT 1`, { startImmediately: true });
      const transaction = yield* Effect.forkChild(sql.withTransaction(countEntries(sql)), {
        startImmediately: true,
      });
      yield* TestClock.adjust("25 millis");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(statement);
      yield* Fiber.join(transaction);
      yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
    }),
  ).pipe(
    // The server turns this on, so a statement's span is current while it waits.
    Effect.provideService(Statement.SpanPropagationEnabled, true),
    Effect.withTracer(tracer),
    Effect.map(() => {
      // Statements inside a transaction reuse its connection, so only the
      // statements and transactions that took a lock are labeled.
      const labeled = spans
        .filter((span) => span.attributes.has("db.connection"))
        .map((span) => [
          span.name,
          span.attributes.get("db.connection"),
          span.attributes.get("db.lock_wait_ms"),
        ]);
      assert.deepStrictEqual(labeled.slice(3), [
        ["sql.transaction", "writer", 0],
        ["sqlite", "writer", 25],
        ["sql.transaction", "writer", 25],
        ["sql.transaction", "reader", 0],
      ]);
    }),
  );
});

it.effect("labels only the span of the statement or transaction that took the lock", () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = sql.withTransaction(sql`SELECT 1`);
    yield* transaction;
    // Run again nested, the same Effect reuses the outer connection and takes no lock.
    yield* sql.withTransaction(transaction);
    // With tracing off, Statement does not make its span current.
    yield* sql`SELECT 2`.pipe(Effect.withTracerEnabled(false));
  }).pipe(
    Effect.withSpan("caller"),
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.provideService(Statement.SpanPropagationEnabled, true),
    Effect.withTracer(tracer),
    Effect.map(() => {
      assert.deepStrictEqual(
        spans
          .filter((span) => span.name === "caller" || span.name === "sql.transaction")
          .map((span) => [span.name, span.attributes.get("db.connection")]),
        [
          ["caller", undefined],
          ["sql.transaction", "writer"],
          ["sql.transaction", "writer"],
          ["sql.transaction", undefined],
        ],
      );
    }),
  );
});

it.effect("keeps large parameters off the reader worker's cached statements", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const read = (value: string) =>
        sql<{ size: number }>`SELECT length(${value}) AS size`.pipe(
          Effect.map((rows) => rows[0]?.size),
        );
      // Start the worker so its requests can be recorded.
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers.at(-1)!;
      const cached: Array<boolean> = [];
      const postMessage = worker.postMessage;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(worker, "postMessage").mockImplementation(function (
            this: NodeWorkerThreads.Worker,
            message: { readonly cached: boolean },
          ) {
            cached.push(message.cached);
            return postMessage.call(this, message);
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );

      assert.equal(yield* read("small").pipe(SqliteClient.readOnly), 5);
      assert.equal(yield* read(largeText).pipe(SqliteClient.readOnly), largeText.length);
      assert.deepEqual(cached, [true, false]);
    }).pipe(Effect.scoped),
  ),
);

it.effect("fails a read-only transaction whose reader stops, then starts a new reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
            return yield* countEntries(sql);
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "Database reader exited");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 2);
    }),
  ),
);

it.effect("uses the writer for read-only work on an in-memory database", () =>
  Effect.gen(function* () {
    const startedBefore = startedWorkers.length;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE memory_entries(name TEXT NOT NULL)`;
    yield* sql`INSERT INTO memory_entries VALUES ('kept')`;

    const rows = yield* sql
      .withTransaction(sql<{ name: string }>`SELECT name FROM memory_entries`)
      .pipe(SqliteClient.readOnly);

    assert.deepEqual(rows, [{ name: "kept" }]);
    assert.equal(startedWorkers.length, startedBefore);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", readerWorker: true }))),
);

it.effect("keeps a nested transaction inside a read-only transaction on the reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      // Callers wrap a store read that opens its own transaction, as the
      // shell snapshot routes do around getShellSnapshot.
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const outer = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            yield* Fiber.join(writer);
            const nested = yield* sql.withTransaction(countEntries(sql));
            return { outer, nested };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { outer: 1, nested: 1 });
    }),
  ),
);

const withFileClient = <A, E>(
  setup: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-reader-off-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      return yield* setup(yield* SqlClient.SqlClient, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("uses the writer when the reader cannot open the database", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      // The writer keeps its open file; a read-only open of the path now fails.
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

it.effect("uses the writer for a database that is not in WAL mode", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      const startedBefore = startedWorkers.length;

      // A write inside readOnly only succeeds on the writer: the reader is read-only.
      yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('on the writer')`)
        .pipe(SqliteClient.readOnly);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const silently = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      silentWorkers.on = true;
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        silentWorkers.on = false;
        silentWorkers.readyOnTerminate = false;
      }),
  );

it.effect("turns the reader off when its worker never opens the database", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      const read = yield* silently(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("10 seconds");
          return yield* Fiber.join(fiber);
        }),
      );

      assert.equal(read, 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.lengthOf(warnings, 1);
    }),
  ).pipe(Effect.provide(logs));
});

it.effect("lets a read be cancelled while its worker is still starting", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* silently(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          );
          yield* Effect.yieldNow;
          // Never returns if the wait for the worker were uninterruptible: the
          // test clock has not moved, so the startup deadline cannot fire.
          yield* Fiber.interrupt(fiber);
        }),
      );

      // The client stays usable: the next read waits out the deadline, then uses the writer.
      const next = yield* Effect.forkChild(
        sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* Fiber.join(next), 0);
    }),
  ),
);

it.effect("logs one warning when concurrent first reads find the reader unavailable", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      const counts = yield* Effect.all(
        [
          sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(counts, [0, 0]);
      assert.equal(startedWorkers.length, startedBefore + 1);
      assert.lengthOf(warnings, 1);
    }),
  ).pipe(Effect.provide(logs));
});

it.effect("does not hand out a worker that reports ready after another read timed it out", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      const read = () => sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
      const counts = yield* silently(
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(read());
          yield* Effect.yieldNow;
          yield* TestClock.adjust("5 seconds");
          const second = yield* Effect.forkChild(read());
          yield* Effect.yieldNow;
          // The first read reaches its deadline and retires the worker; the second
          // is still waiting when the worker's "ready" arrives, before it exits.
          silentWorkers.readyOnTerminate = true;
          yield* TestClock.adjust("5 seconds");
          return [yield* Fiber.join(first), yield* Fiber.join(second)];
        }),
      );

      assert.deepEqual(counts, [1, 1]);
    }),
  ),
);

const withCheckpointClient = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-checkpoint-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// Resolves once the worker has handled a request sent now, after every
// statement so far. Earlier requests from the writer reply with null. A worker
// that dies first fails the wait with its reason instead of leaving it hanging.
const checkpointWorkerReply = (worker: NodeWorkerThreads.Worker) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const stop = () => {
          worker.off("message", onReply);
          worker.off("error", onError);
          worker.off("exit", onExit);
        };
        const onReply = (reply: unknown) => {
          if (reply !== "barrier") return;
          stop();
          resolve();
        };
        const onError = (cause: Error) => {
          stop();
          reject(new Error(`checkpoint worker failed: ${cause.stack ?? cause.message}`));
        };
        const onExit = (code: number) => {
          stop();
          reject(new Error(`checkpoint worker exited with code ${code}`));
        };
        if (worker.threadId === -1) {
          reject(new Error("checkpoint worker had already exited"));
          return;
        }
        worker.on("message", onReply);
        worker.on("error", onError);
        worker.on("exit", onExit);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage("barrier");
      }),
  );

// The real worker can race the writer with WAL recovery. Let the writer's
// recovery retry advance on the live clock rather than an unadvanced TestClock.
it.live("checkpoints the WAL on the worker instead of the writer", () =>
  withCheckpointClient((sql, filename) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const walSize = Effect.map(fs.stat(`${filename}-wal`), (info) => Number(info.size));
      const worker = startedWorkers.at(-1)!;
      const limit = 1024 * 1024;
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${limit}`);
      const autocheckpoint = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;
      // The writer leaves a WAL of this size to the worker.
      assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 10_000);

      // About 1200 frames, past the 1000 that start a checkpoint.
      yield* sql`CREATE TABLE pages(payload BLOB)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
        INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
      `;
      yield* checkpointWorkerReply(worker);
      const wal = yield* sql<{
        readonly log: number;
        readonly checkpointed: number;
      }>`PRAGMA wal_checkpoint(NOOP)`;
      assert.isAbove(wal[0]!.log, 1000);
      assert.equal(wal[0]!.checkpointed, wal[0]!.log);

      // Every frame is in the database, so the next commit restarts the WAL and
      // cuts the file back to the size limit.
      assert.isAbove(yield* walSize, limit);
      yield* sql`INSERT INTO pages(payload) VALUES (x'00')`;
      assert.isAtMost(yield* walSize, limit);
    }),
  ),
);

it.effect("hands checkpoints back to the writer when the worker stops", () =>
  withCheckpointClient((sql) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
      const autocheckpoint = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;
      assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
    }),
  ),
);

it.effect("warns once and hands checkpoints back when the worker fails at startup", () => {
  const { warnings, layer: logs } = captureWarnings();
  const reason = "SQLite 3.50.4 has no NOOP checkpoint";
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      failingWorkers.message = reason;
    }),
    () =>
      withCheckpointClient((sql) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          // threadId is -1 once the worker has exited and the client has seen "error" and "exit".
          if (worker.threadId !== -1) {
            yield* Effect.promise(() => new Promise((resolve) => worker.once("exit", resolve)));
          }
          const autocheckpoint = yield* sql<{
            readonly wal_autocheckpoint: number;
          }>`PRAGMA wal_autocheckpoint`;
          assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
          assert.deepEqual(warnings, [
            [
              "SQLite checkpoint worker unavailable; checkpoints run on the main connection",
              { reason },
            ],
          ]);
        }),
      ),
    () =>
      Effect.sync(() => {
        failingWorkers.message = undefined;
      }),
  ).pipe(Effect.provide(logs));
});

it.effect("does not warn when the client stops its checkpoint worker", () => {
  const { warnings, layer: logs } = captureWarnings();
  return Effect.gen(function* () {
    yield* withCheckpointClient(() => Effect.void);
    assert.lengthOf(warnings, 0);
  }).pipe(Effect.provide(logs));
});
