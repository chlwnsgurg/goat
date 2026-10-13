import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/070_Memory.ts";
import * as Store from "./MemoryStore.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(2));
const env = M.EnvironmentId.make("fixture");
const now = "2026-10-14T00:00:00.000Z";
const hash = "a".repeat(64);
const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const operation = (n = 3) =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: memory,
    operationId: id(n),
    originEnvironmentId: env,
    expectedHeads: [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      revisionId: id(n + 10),
      operationId: id(n),
      parents: [],
      scope: { kind: "user" },
      payloadRef: id(n + 10),
      assertionKind: "inference",
      provenance: { environmentId: env },
      createdAtUtc: now,
    },
    payload: { text: "synthetic searchable text", evidence: [], derivedFromMemoryRevisions: [] },
  });
const decision = (op = operation()): Store.MemoryDecision => ({
  operation: op,
  operationDigest: hash,
  admission: Store.localIntent,
  receipt: {
    operationId: op.operationId,
    memoryId: op.memoryId,
    pendingSync: true,
    revisionId: op.kind === "forget" ? null : op.revision.revisionId,
    outcome: op.kind === "forget" ? "deleted" : "accepted",
  },
  ...(op.kind !== "forget"
    ? {
        item: {
          memorySpaceId: space,
          memoryId: memory,
          status: "active",
          scope: op.revision.scope,
          revision: op.revision,
          payload: op.payload,
          pendingSync: true,
          localAvailability: {
            exposure: "visible",
            reasons: [],
            deferred: [],
            cleanupPending: false,
          },
        } as M.MemoryItem,
      }
    : {}),
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const setup = Layer.effectDiscard(migration).pipe(Layer.provideMerge(database));
const live = Store.layer.pipe(Layer.provideMerge(setup));

const checkpoint = () => {
  const op = operation();
  if (op.kind === "forget") throw new Error("Fixture kind");
  const item = decision(op).item!;
  return M.MemoryHubCheckpointPage.make({
    memorySpaceId: space,
    checkpointSequence: 1,
    retentionFloor: 0,
    causalBoundary: { checkpointSequence: 1, boundaryId: "fixture" },
    pageOrdinal: 0,
    items: [{ ...item, pendingSync: false }],
    revisions: [{ revision: op.revision, payload: op.payload }],
    tombstones: [],
    conflicts: [],
    resolutions: [],
    compactReceipts: [
      {
        memorySpaceId: space,
        originEnvironmentId: env,
        operationKind: "upsert",
        receipt: {
          operationId: op.operationId,
          memoryId: memory,
          operationDigest: hash,
          outcome: "accepted",
          hubSequence: 1,
        },
        revisionId: op.revision.revisionId,
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      },
    ],
    identities: [
      {
        memorySpaceId: space,
        memoryId: memory,
        scope: op.revision.scope,
        creatingEnvironmentId: env,
        createOperationId: op.operationId,
        createdAtUtc: now,
      },
    ],
    fences: [{ memorySpaceId: space, memoryId: memory, highestFencingToken: 0, activeLease: null }],
    suppressions: [],
    nextCursor: null,
    bootstrapComplete: true,
  });
};
const approved = (op = operation()): Store.MemoryDecision => ({
  ...decision(op),
  admission: Store.approvedReplica,
  receipt: {
    operationId: op.operationId,
    memoryId: op.memoryId,
    operationDigest: hash,
    outcome: "accepted",
    hubSequence: 2,
  },
});
const childOperation = () => {
  const op = operation(4);
  if (op.kind === "forget") throw new Error("Fixture kind");
  const parent = M.MemoryRevisionId.make(id(13));
  return decodeOperation({
    ...op,
    expectedHeads: [parent],
    revision: { ...op.revision, parents: [parent] },
  });
};
const parked = (): Store.MemoryDecision => {
  const op = childOperation();
  if (op.kind === "forget") throw new Error("Fixture kind");
  return {
    ...approved(op),
    heads: [],
    pending: { missingParents: op.revision.parents, reason: "missing_parent" },
    item: {
      memorySpaceId: space,
      memoryId: memory,
      scope: op.revision.scope,
      status: "blocked",
      failureCode: "missing_parent",
      pendingSync: false,
      localAvailability: {
        exposure: "held",
        reasons: ["missing_parent"],
        cleanupPending: false,
        deferred: [
          {
            kind: "parent",
            state: "held",
            reason: "missing_parent",
            revisionId: op.revision.revisionId,
            generation: 0,
            sinceAtUtc: now,
          },
        ],
      },
    },
  };
};
const reconnected = () => approved(childOperation());
describe("MemoryStore", () => {
  it.effect("rolls back each pre-commit failure boundary", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      for (const table of ["memory_payloads", "memory_events", "memory_items", "memory_outbox"]) {
        yield* sql.unsafe(
          `CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END`,
        );
        assert.isTrue((yield* Effect.exit(store.apply(decision())))._tag === "Failure");
        for (const name of [
          "memory_payloads",
          "memory_revisions",
          "memory_events",
          "memory_items",
          "memory_outbox",
        ])
          assert.strictEqual((yield* sql.unsafe(`SELECT * FROM ${name}`)).length, 0);
        yield* sql`DROP TRIGGER fail_write`;
      }
    }).pipe(Effect.provide(live)),
  );
  it.effect("preserves committed intent after a lost wakeup", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(decision());
      const second = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.isDefined(yield* second.receipt(space, operation().operationId));
      assert.strictEqual((yield* second.readEligibleOutbox(space, 0, 100)).length, 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("serializes concurrent identical operation reservations", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const results = yield* Effect.all([store.apply(decision()), store.apply(decision())], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(results[0], results[1]);
      assert.strictEqual((yield* store.loadAggregate(space, memory)).revisions.length, 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("rejects changed payload under an operation ID", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const original = yield* store.apply(decision());
      const result = yield* Effect.exit(
        store.apply({
          ...decision(),
          operationDigest: "b".repeat(64),
          receipt: decision().receipt,
        }),
      );
      assert.isTrue(result._tag === "Failure");
      assert.deepStrictEqual(yield* store.receipt(space, operation().operationId), original);
    }).pipe(Effect.provide(live)),
  );
  it.effect("received cursor commits with parked receipt or not at all", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const input = {
        memorySpaceId: space,
        hubEnvironmentId: env,
        expectedSequence: 0,
        afterSequence: 1,
      };
      yield* store
        .withReceivedCursor(input, Effect.andThen(store.apply(decision()), Effect.fail("barrier")))
        .pipe(Effect.exit);
      assert.strictEqual(yield* store.readCursor(space, env), 0);
      assert.isUndefined(yield* store.receipt(space, operation().operationId));
      yield* store.withReceivedCursor(input, store.apply(decision()));
      assert.strictEqual(yield* store.readCursor(space, env), 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("removes forgotten text from FTS and payload tables", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const op = operation();
      yield* store.apply(decision(op));
      const aggregate = yield* store.loadAggregate(space, memory);
      if (op.kind !== "forget")
        yield* store.index({
          memorySpaceId: space,
          memoryId: memory,
          revisionId: op.revision.revisionId,
          generation: aggregate.generation,
        });
      const forget = decodeOperation({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(50),
        originEnvironmentId: env,
        expectedHeads: [],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(50),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.apply(decision(forget));
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
      assert.strictEqual((yield* sql`SELECT * FROM memory_items_fts`).length, 0);
      assert.isFalse(
        op.kind !== "forget" &&
          (yield* store.index({
            memorySpaceId: space,
            memoryId: memory,
            revisionId: op.revision.revisionId,
            generation: aggregate.generation,
          })),
      );
      assert.isNull((yield* store.loadAggregate(space, memory)).revisions[0]?.payload);
    }).pipe(Effect.provide(live)),
  );
  it.effect("scope filter precedes paging", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(decision());
      assert.strictEqual(
        (yield* store.list({
          memorySpaceId: space,
          scope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "foreign" } },
          limit: 1,
        })).length,
        0,
      );
      assert.strictEqual(
        (yield* store.list({ memorySpaceId: space, scope: { kind: "user" }, limit: 1 })).length,
        1,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("escapes FTS input and caps pages", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      for (const limit of [0, 101])
        assert.isTrue(
          (yield* Effect.exit(
            store.search({ memorySpaceId: space, scope: { kind: "user" }, limit }, '" OR *', "fts"),
          ))._tag === "Failure",
        );
      assert.strictEqual(
        (yield* store.search(
          { memorySpaceId: space, scope: { kind: "user" }, limit: 100 },
          '" OR *',
          "fts",
        )).length,
        0,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("rejected unknown forget survives restart and late upsert", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.preserveForgetIntent({
        memorySpaceId: space,
        memoryId: memory,
        operationId: M.MemoryOperationId.make(id(99)),
        requestedAtUtc: now,
        attempts: 0,
        lastFailureCode: "capacity_exceeded",
        operationDigest: null,
        submissionState: "rejected",
      });
      yield* store.apply({
        ...decision(),
        admission: Store.approvedReplica,
        receipt: {
          operationId: operation().operationId,
          memoryId: memory,
          operationDigest: hash,
          outcome: "accepted",
          hubSequence: 1,
        },
      });
      const second = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      const item = (yield* second.loadAggregate(space, memory)).item;
      assert.strictEqual(item?.status, "blocked");
      assert.isTrue(item?.status === "blocked" && item.failureCode === "forget_pending");
      assert.isDefined((yield* second.loadAggregate(space, memory)).revisions[0]?.payload);
      assert.isFalse(item !== undefined && "payload" in item);
      assert.strictEqual((yield* second.pendingForgetIntents(10)).length, 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("materializes an unbound intent once after checkpoint install", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const op = operation();
      if (op.kind === "forget") return;
      const draft = {
        intentId: "fixture-local",
        environmentId: env,
        memoryId: M.MemoryId.make(id(70)),
        scope: op.revision.scope,
        provenance: op.revision.provenance,
        assertionKind: op.revision.assertionKind,
        createdAtUtc: now,
        payload: op.payload,
      };
      yield* store.putLocalIntent(draft);
      const input = {
        environmentId: env,
        intentId: draft.intentId,
        memorySpaceId: space,
        operationId: M.MemoryOperationId.make(id(71)),
        revisionId: M.MemoryRevisionId.make(id(72)),
      };
      assert.isTrue((yield* Effect.exit(store.materializeLocalIntent(input)))._tag === "Failure");
      yield* store.installCheckpointPage({ checkpointId: "fixture", page: checkpoint() });
      yield* store.completeCheckpoint({
        memorySpaceId: space,
        hubEnvironmentId: env,
        checkpointId: "fixture",
        pageCount: 1,
      });
      const first = yield* store.materializeLocalIntent(input);
      const second = yield* store.materializeLocalIntent({
        ...input,
        operationId: M.MemoryOperationId.make(id(73)),
        revisionId: M.MemoryRevisionId.make(id(74)),
      });
      assert.deepStrictEqual(first, second);
      assert.strictEqual((yield* store.loadAggregate(space, draft.memoryId)).revisions.length, 0);
    }).pipe(Effect.provide(live)),
  );
  it.effect("partial checkpoint stays invisible and forget purges staged bodies", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.installCheckpointPage({ checkpointId: "fixture", page: checkpoint() });
      assert.isUndefined((yield* store.loadAggregate(space, memory)).item);
      const forget = decodeOperation({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(50),
        originEnvironmentId: env,
        expectedHeads: [],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(50),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.apply(decision(forget));
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
      yield* store.completeCheckpoint({
        memorySpaceId: space,
        hubEnvironmentId: env,
        checkpointId: "fixture",
        pageCount: 1,
      });
      assert.strictEqual((yield* store.loadAggregate(space, memory)).item?.status, "forgotten");
    }).pipe(Effect.provide(live)),
  );
  it.effect("unions 101 suppressed source keys across bounded forget fragments", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      for (const [ordinal, count] of [
        [0, 100],
        [1, 1],
      ] as const) {
        const operationId = M.MemoryOperationId.make(id(100 + ordinal));
        const op = decodeOperation({
          protocolVersion: 1,
          memorySpaceId: space,
          memoryId: memory,
          operationId,
          originEnvironmentId: env,
          expectedHeads: [],
          kind: "forget",
          tombstone: {
            memorySpaceId: space,
            memoryId: memory,
            deleteOperationId: operationId,
            deletingEnvironmentId: env,
            deletedAtUtc: now,
            suppressedSourceKeys: Array.from({ length: count }, (_, n) => ({
              environmentId: env,
              sourceId: id(200),
              sourceItemKey: `key:${ordinal}:${n}`,
            })),
            suppressedContent: [],
            sourceExclusions: [],
          },
        });
        yield* store.apply(decision(op));
        yield* store.apply(decision(op));
      }
      assert.strictEqual((yield* store.readSuppressions(space, memory)).length, 101);
    }).pipe(Effect.provide(live)),
  );
  it.effect("search excludes only quarantined memory", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const op = operation();
      if (op.kind === "forget") return;
      yield* store.apply(decision(op));
      const current = yield* store.loadAggregate(space, memory);
      yield* store.index({
        memorySpaceId: space,
        memoryId: memory,
        revisionId: op.revision.revisionId,
        generation: current.generation,
      });
      const other = M.MemoryId.make(id(90));
      yield* sql`INSERT INTO memory_items (space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) VALUES (${space},${other},'{}','user','[]','quarantined',0,'{}','{}')`;
      const results = yield* store.search(
        { memorySpaceId: space, scope: { kind: "user" }, limit: 100 },
        "synthetic",
        "fts",
      );
      assert.deepStrictEqual(
        results.map((item) => item.memoryId),
        [memory],
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("encodes worst-case compact receipts and guards within the binary budget", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const base = checkpoint().compactReceipts[0]!;
      const record = M.MemoryCompactReceipt.make({
        ...base,
        operationKind: "resolve",
        resolutionId: M.MemoryResolutionId.make(id(10)),
        attemptId: M.MemoryOperationId.make(id(11)),
        fencingToken: Number.MAX_SAFE_INTEGER,
        receipt: { ...base.receipt, hubSequence: Number.MAX_SAFE_INTEGER },
        reportGuard: {
          reportId: "b".repeat(64),
          resolvingEnvironmentId: env,
          resolutionId: M.MemoryResolutionId.make(id(10)),
          outcome: "resolved",
        },
      });
      const encoded = Store.encodeCompactReceipt(record, () => Number.MAX_SAFE_INTEGER);
      assert.isAtMost(encoded.length, M.MEMORY_COMPACT_RECEIPT_MAX_BYTES);
      yield* store.persistCompactReceipt(record);
      const restored = yield* store.receipt(space, record.receipt.operationId);
      assert.deepStrictEqual(restored?.receipt, record.receipt);
    }).pipe(Effect.provide(live)),
  );
  it.effect("pending forget holds scanner and conflicting claim candidates after restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.preserveForgetIntent({
        memorySpaceId: space,
        memoryId: memory,
        operationId: M.MemoryOperationId.make(id(91)),
        requestedAtUtc: now,
        attempts: 0,
        lastFailureCode: "capacity_exceeded",
        operationDigest: null,
        submissionState: "rejected",
      });
      const op = operation();
      if (op.kind === "forget") return;
      yield* store.apply({
        ...decision(op),
        admission: Store.approvedReplica,
        receipt: {
          operationId: op.operationId,
          memoryId: memory,
          operationDigest: hash,
          outcome: "accepted",
          hubSequence: 1,
        },
      });
      const pending = yield* store.readDeferred(0, 256);
      const scanner = pending.find((d) => d.kind === "scanner")!;
      yield* store.finishDeferred(scanner, { now: 0, scannerPolicyVersion: 1 });
      assert.strictEqual((yield* store.loadAggregate(space, memory)).item?.status, "blocked");
      yield* store.recoverClaimCandidates(0);
      assert.deepStrictEqual(yield* store.readDueClaimCandidates(256, 0), []);
    }).pipe(Effect.provide(live)),
  );
  it.effect("derived purge failure remains fenced and recovers after restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const op = operation();
      if (op.kind === "forget") return;
      yield* store.apply(decision(op));
      const before = yield* store.loadAggregate(space, memory);
      yield* store.index({
        memorySpaceId: space,
        memoryId: memory,
        revisionId: op.revision.revisionId,
        generation: before.generation,
      });
      yield* sql`ALTER TABLE memory_items_fts RENAME TO unavailable_fts_fixture`;
      const forget = decodeOperation({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(50),
        originEnvironmentId: env,
        expectedHeads: [],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(50),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.apply(decision(forget));
      const restored = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.strictEqual(
        (yield* restored.loadAggregate(space, memory)).item?.localAvailability.cleanupPending,
        true,
      );
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
      yield* sql`ALTER TABLE unavailable_fts_fixture RENAME TO memory_items_fts`;
      assert.strictEqual(yield* restored.cleanupDerived(256), 1);
      assert.strictEqual((yield* sql`SELECT * FROM memory_items_fts`).length, 0);
      assert.strictEqual(
        (yield* restored.loadAggregate(space, memory)).item?.localAvailability.cleanupPending,
        false,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "reconnects after restart without changing receipt, event, cursor or canonical payload",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const original = yield* store.withReceivedCursor(
          { memorySpaceId: space, hubEnvironmentId: env, expectedSequence: 0, afterSequence: 2 },
          store.apply(parked()),
        );
        const replay = yield* store.apply(reconnected());
        assert.deepStrictEqual(replay, original);
        assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
        yield* store.apply(approved());
        const before = yield* sql`SELECT * FROM memory_events ORDER BY sequence`;
        const bodies = yield* sql`SELECT * FROM memory_payloads ORDER BY payload_ref`;
        const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        const generation = (yield* fresh.loadAggregate(space, memory)).generation;
        assert.deepStrictEqual(yield* fresh.reconnectParked(reconnected(), generation), original);
        const after = yield* fresh.loadAggregate(space, memory);
        assert.deepStrictEqual(after.heads, [M.MemoryRevisionId.make(id(14))]);
        assert.strictEqual(after.generation, generation + 1);
        assert.isFalse(after.item?.localAvailability.reasons.includes("missing_parent"));
        assert.isTrue(after.item?.localAvailability.reasons.includes("scanner_pending"));
        assert.strictEqual((yield* fresh.pendingReceived(space, 10)).length, 0);
        assert.deepStrictEqual(yield* sql`SELECT * FROM memory_events ORDER BY sequence`, before);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM memory_payloads ORDER BY payload_ref`,
          bodies,
        );
        assert.strictEqual(yield* fresh.readCursor(space, env), 2);
        assert.deepStrictEqual(yield* fresh.reconnectParked(reconnected(), generation), original);
        assert.strictEqual((yield* fresh.loadAggregate(space, memory)).generation, generation + 1);
      }).pipe(Effect.provide(live)),
  );
  it.effect("rolls back reconnect projection and marker at each SQL failure", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(parked());
      yield* store.apply(approved());
      const before = yield* store.loadAggregate(space, memory);
      for (const [table, action] of [
        ["memory_items", "UPDATE"],
        ["memory_inbox_pending", "DELETE"],
      ]) {
        yield* sql.unsafe(
          `CREATE TRIGGER fail_reconnect BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END`,
        );
        assert.strictEqual(
          (yield* Effect.exit(store.reconnectParked(reconnected(), before.generation)))._tag,
          "Failure",
        );
        assert.deepStrictEqual(yield* store.loadAggregate(space, memory), before);
        assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
        yield* sql`DROP TRIGGER fail_reconnect`;
      }
      yield* store.reconnectParked(reconnected(), before.generation);
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 0);
    }).pipe(Effect.provide(live)),
  );
  it.effect("fences stale reconnect decisions and missing parents", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      assert.strictEqual(
        (yield* Effect.exit(store.reconnectParked(reconnected(), generation)))._tag,
        "Failure",
      );
      yield* store.apply(approved());
      assert.strictEqual(
        (yield* Effect.exit(store.reconnectParked(reconnected(), generation)))._tag,
        "Failure",
      );
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("rejects reconnect with changed operation, digest, receipt or admission", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      yield* store.apply(approved());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      const base = reconnected();
      const op = base.operation;
      if (op.kind === "forget") throw new Error("Fixture kind");
      for (const changed of [
        { ...base, operationDigest: "b".repeat(64) },
        { ...base, operation: { ...op, payload: { ...op.payload, text: "changed" } } },
        { ...base, receipt: { ...base.receipt, hubSequence: 99 } },
        { ...base, admission: Store.localIntent },
      ])
        assert.strictEqual(
          (yield* Effect.exit(store.reconnectParked(changed, generation)))._tag,
          "Failure",
        );
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("updates remaining missing parents atomically without rewriting receipt", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const original = yield* store.apply(parked());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      assert.deepStrictEqual(yield* store.reconnectParked(parked(), generation), original);
      assert.strictEqual((yield* store.loadAggregate(space, memory)).generation, generation + 1);
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("reconstructs parked operations from pending metadata after event compaction", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(parked());
      yield* sql`DELETE FROM memory_events`;
      assert.deepStrictEqual(yield* store.pendingReceived(space, 10), [childOperation()]);
    }).pipe(Effect.provide(live)),
  );
  it.effect("returns retained ancestry and real missing parents without a boundary", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(approved());
      const parent = M.MemoryRevisionId.make(id(13));
      const absent = M.MemoryRevisionId.make(id(99));
      assert.deepStrictEqual(yield* store.readAncestry(space, memory, [parent, absent]), {
        causalBoundary: undefined,
        retentionFloor: 0,
        parents: [
          { revisionId: parent, status: "retained", parents: [] },
          { revisionId: absent, status: "missing" },
        ],
      });
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "distinguishes checkpoint-covered compacted ancestry from arbitrary unknown UUIDs",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const page = checkpoint();
        yield* store.installCheckpointPage({ checkpointId: "fixture", page });
        yield* store.completeCheckpoint({
          memorySpaceId: space,
          hubEnvironmentId: env,
          checkpointId: "fixture",
          pageCount: 1,
        });
        yield* sql`DELETE FROM memory_revisions`;
        const parent = page.revisions[0]!.revision.revisionId;
        const absent = M.MemoryRevisionId.make(id(99));
        const result = yield* store.readAncestry(space, memory, [parent, absent]);
        assert.deepStrictEqual(result.causalBoundary, page.causalBoundary);
        assert.deepStrictEqual(result.parents, [
          { revisionId: parent, status: "compacted", boundary: page.causalBoundary },
          { revisionId: absent, status: "missing" },
        ]);
        const other = yield* store.readAncestry(space, M.MemoryId.make(id(88)), [parent]);
        assert.deepStrictEqual(other.parents, [
          { revisionId: parent, status: "crossMemory", memoryId: memory },
        ]);
      }).pipe(Effect.provide(live)),
  );
  it.effect("never treats a staged boundary or a newer compact receipt as covered ancestry", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const page = checkpoint();
      yield* store.installCheckpointPage({ checkpointId: "fixture", page });
      assert.isUndefined((yield* store.readAncestry(space, memory, [])).causalBoundary);
      yield* store.persistCompactReceipt({
        ...page.compactReceipts[0]!,
        receipt: { ...page.compactReceipts[0]!.receipt, hubSequence: 2 },
      });
      yield* sql`INSERT INTO memory_compaction_state (space,boundary_json,published) VALUES (${space},${JSON.stringify(page.causalBoundary)},1)`;
      assert.strictEqual(
        (yield* store.readAncestry(space, memory, [page.revisions[0]!.revision.revisionId]))
          .parents[0]?.status,
        "missing",
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("rejects a retained cross-memory parent before reconnect", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(parked());
      yield* store.apply(approved());
      const other = M.MemoryId.make(id(88));
      yield* sql`UPDATE memory_revisions SET memory_id=${other} WHERE revision_id=${M.MemoryRevisionId.make(id(13))}`;
      assert.strictEqual(
        (yield* store.readAncestry(space, memory, [M.MemoryRevisionId.make(id(13))])).parents[0]
          ?.status,
        "crossMemory",
      );
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      assert.strictEqual(
        (yield* Effect.exit(store.reconnectParked(reconnected(), generation)))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("serializes concurrent reconnects into one projection update", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      yield* store.apply(approved());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      const results = yield* Effect.all(
        [
          store.reconnectParked(reconnected(), generation),
          store.reconnectParked(reconnected(), generation),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(results[0], results[1]);
      assert.strictEqual((yield* store.loadAggregate(space, memory)).generation, generation + 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("reconnect preserves a pending forget exposure fence", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      yield* store.apply(approved());
      yield* store.preserveForgetIntent({
        memorySpaceId: space,
        memoryId: memory,
        operationId: M.MemoryOperationId.make(id(90)),
        requestedAtUtc: now,
        attempts: 0,
        lastFailureCode: "capacity_exceeded",
        operationDigest: null,
        submissionState: "rejected",
      });
      yield* store.reconnectParked(
        reconnected(),
        (yield* store.loadAggregate(space, memory)).generation,
      );
      const item = (yield* store.loadAggregate(space, memory)).item;
      assert.strictEqual(item?.status, "blocked");
      assert.isTrue(item?.status === "blocked" && item.failureCode === "forget_pending");
      assert.isFalse(item !== undefined && "payload" in item);
    }).pipe(Effect.provide(live)),
  );
  it.effect("forget wins over late reconnect without restoring a body", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const original = yield* store.apply(parked());
      yield* store.apply(approved());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      const forget = decodeOperation({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(50),
        originEnvironmentId: env,
        expectedHeads: [],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(50),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.apply(decision(forget));
      assert.deepStrictEqual(yield* store.reconnectParked(reconnected(), generation), original);
      assert.strictEqual((yield* store.loadAggregate(space, memory)).item?.status, "forgotten");
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 0);
    }).pipe(Effect.provide(live)),
  );
  it.effect("reports an unlinked parked parent separately from a retained DAG ancestor", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      const revisionId = M.MemoryRevisionId.make(id(14));
      assert.deepStrictEqual((yield* store.readAncestry(space, memory, [revisionId])).parents, [
        { revisionId, status: "parked", missingParents: [M.MemoryRevisionId.make(id(13))] },
      ]);
    }).pipe(Effect.provide(live)),
  );
});
