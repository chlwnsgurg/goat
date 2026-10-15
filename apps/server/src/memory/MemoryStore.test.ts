import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/071_Memory.ts";
import * as Store from "./MemoryStore.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(2));
const env = M.EnvironmentId.make("fixture");
const now = "2026-10-14T00:00:00.000Z";
const hash = "a".repeat(64);
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(M.MemoryPayload));
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
const backgroundWork = (id = "fixture:background"): Store.MemoryWork => ({
  id,
  space,
  memoryId: memory,
  kind: "rebuild",
  status: "pending",
  metadata: { kind: "rebuild", revisionId: null, generation: 0 },
  payloadRef: null,
  attempt: 0,
  nextAttemptAt: 0,
  claimedBy: null,
  claimedUntil: null,
});
const summaryWork = (n: number, environmentId = env): Store.MemoryWork => ({
  ...backgroundWork(`summary:${n}`),
  kind: "summary",
  metadata: {
    kind: "summary",
    sourceThread: { environmentId, threadId: M.ThreadId.make(id(70)) },
    sourceWatermark: {
      fromEventId: M.EventId.make(id(71)),
      toEventId: M.EventId.make(id(72)),
      throughSequence: n,
    },
    memoryId: memory,
    operationId: M.MemoryOperationId.make(id(n + 100)),
    revisionId: M.MemoryRevisionId.make(id(n + 200)),
    modelSelection: { instanceId: M.ProviderInstanceId.make("fixture"), model: "fixture" },
  },
});
const deferredWork = (
  kind: Store.MemoryDeferredWork["kind"],
  overrides: Partial<Store.MemoryDeferredWork> = {},
) => ({
  kind,
  state: "pending" as const,
  reason: null,
  revisionId: null,
  generation: 1,
  sinceAtUtc: now,
  attempt: 0,
  dueAt: 0,
  lastAttemptAt: null,
  claimedBy: null,
  claimedUntil: null,
  ...overrides,
});
const seedDeferred = (
  n: number,
  entries: ReadonlyArray<ReturnType<typeof deferredWork>>,
  payloadBytes = 0,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const memoryId = M.MemoryId.make(id(n));
    yield* sql`INSERT INTO memory_items (space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json,generation,deferred_json) VALUES (${space},${memoryId},'{}','user','[]','blocked',0,'{}','{}',1,${JSON.stringify(entries)})`;
    if (payloadBytes)
      yield* sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${id(n)},${memoryId},${"x".repeat(payloadBytes)},'[]')`;
  });
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
  it.effect(
    "reserves source exclusions when an identity arrives through checkpoint bootstrap",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const original = checkpoint();
        const pair = original.revisions[0]!;
        const item = original.items[0]!;
        if (item.status !== "active" || !pair.payload) throw new Error("Fixture kind");
        const sourceThread = { environmentId: env, threadId: M.ThreadId.make("thread") };
        const sourceWatermark = {
          fromEventId: M.EventId.make(id(900)),
          toEventId: M.EventId.make(id(901)),
          throughSequence: 1,
        };
        const revision = {
          ...pair.revision,
          provenance: { environmentId: env, sourceThread, sourceWatermark },
        };
        const payload = {
          ...pair.payload,
          evidence: [
            {
              origin: "thread" as const,
              sourceThread,
              watermark: sourceWatermark,
              messageIds: [M.MessageId.make("a"), M.MessageId.make("b")],
            },
          ],
        };
        const page = {
          ...original,
          revisions: [{ revision, payload }],
          items: [{ ...item, revision, payload }],
        };
        yield* store.installCheckpointPage({ checkpointId: "fixture", page });
        yield* store.completeCheckpoint({
          memorySpaceId: space,
          hubEnvironmentId: env,
          checkpointId: "fixture",
          pageCount: 1,
        });
        assert.strictEqual((yield* store.readForgetReservation(space, memory)).keys, 2);
        assert.strictEqual((yield* store.usage(space, { kind: "user" })).keys, 3);
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
        const bodies =
          yield* sql`SELECT payload_ref,body_json FROM memory_payloads ORDER BY payload_ref`;
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
          yield* sql`SELECT payload_ref,body_json FROM memory_payloads ORDER BY payload_ref`,
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
  it.effect("reads work and persists a claimed retry across restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      assert.isUndefined(yield* store.readWork("absent"));
      const work = backgroundWork();
      yield* store.enqueueWork(work);
      assert.isTrue(yield* store.claimWork(work.id, "runtime-a", 0, 100));
      const claimed = (yield* store.readWork(work.id))!;
      assert.isTrue(yield* store.retryWork(claimed, 5000));
      assert.isFalse(yield* store.retryWork(claimed, 1));
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(yield* fresh.dueWork(4999, 100), []);
      const due = yield* fresh.dueWork(5000, 100);
      assert.strictEqual(due[0]?.status, "retry");
      assert.strictEqual(due[0]?.attempt, 1);
      assert.isNull(due[0]?.claimedBy);
    }).pipe(Effect.provide(live)),
  );
  it.effect("stale worker cannot postpone a reclaimed or terminal row", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = backgroundWork();
      yield* store.enqueueWork(work);
      yield* store.claimWork(work.id, "runtime-a", 0, 100);
      const stale = (yield* store.readWork(work.id))!;
      yield* store.claimWork(work.id, "runtime-b", 100, 200);
      assert.isFalse(yield* store.retryWork(stale, 5000));
      const current = (yield* store.readWork(work.id))!;
      yield* store.finishWork(work.id, "completed");
      assert.isFalse(yield* store.retryWork(current, 5000));
      assert.strictEqual((yield* store.readWork(work.id))?.status, "completed");
    }).pipe(Effect.provide(live)),
  );
  it.effect("commits thread hook watermark and work atomically and recovers after restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = backgroundWork();
      assert.strictEqual(yield* store.readThreadHookWatermark(), 0);
      yield* store.commitThreadHook({ expectedWatermark: 0, throughWatermark: 7, work: [work] });
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.strictEqual(yield* fresh.readThreadHookWatermark(), 7);
      assert.deepStrictEqual(yield* fresh.readWork(work.id), work);
      assert.deepStrictEqual(
        (yield* fresh.dueWork(0, 100)).map((row) => row.id),
        [work.id],
      );
      assert.strictEqual(
        (yield* Effect.exit(
          fresh.commitThreadHook({
            expectedWatermark: 0,
            throughWatermark: 8,
            work: [backgroundWork("stale")],
          }),
        ))._tag,
        "Failure",
      );
      assert.isUndefined(yield* fresh.readWork("stale"));
    }).pipe(Effect.provide(live)),
  );
  it.effect("rolls back enqueued hook work if watermark storage fails", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fail_hook BEFORE INSERT ON memory_outbox WHEN NEW.id='memory:thread-hook:v1' BEGIN SELECT RAISE(ABORT,'fixture'); END`;
      assert.strictEqual(
        (yield* Effect.exit(
          store.commitThreadHook({
            expectedWatermark: 0,
            throughWatermark: 7,
            work: [backgroundWork()],
          }),
        ))._tag,
        "Failure",
      );
      assert.isUndefined(yield* store.readWork(backgroundWork().id));
      assert.strictEqual(yield* store.readThreadHookWatermark(), 0);
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "fences concurrent hook sweeps and rejects watermark rollback or marker overwrite",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const results = yield* Effect.all(
          [
            Effect.exit(
              store.commitThreadHook({
                expectedWatermark: 0,
                throughWatermark: 1,
                work: [backgroundWork("one")],
              }),
            ),
            Effect.exit(
              store.commitThreadHook({
                expectedWatermark: 0,
                throughWatermark: 2,
                work: [backgroundWork("two")],
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1);
        const current = yield* store.readThreadHookWatermark();
        assert.strictEqual(
          (yield* Effect.exit(
            store.commitThreadHook({ expectedWatermark: current, throughWatermark: 0, work: [] }),
          ))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* Effect.exit(
            store.commitThreadHook({
              expectedWatermark: current,
              throughWatermark: current + 1,
              work: [backgroundWork("memory:thread-hook:v1")],
            }),
          ))._tag,
          "Failure",
        );
      }).pipe(Effect.provide(live)),
  );
  it.effect("caps generic worker sweeps at 100 rows", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      for (let n = 0; n < 101; n++) yield* store.enqueueWork(backgroundWork(`fixture:${n}`));
      assert.strictEqual((yield* store.dueWork(0, 256)).length, 100);
      assert.strictEqual((yield* store.dueWork(0, -1)).length, 0);
    }).pipe(Effect.provide(live)),
  );
  it.effect("limits runnable deferred rows after excluding held, future and claimed work", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* seedDeferred(80, [
        deferredWork("parent", { state: "held" }),
        deferredWork("scanner", { claimedBy: "other", claimedUntil: 100 }),
        deferredWork("index", { dueAt: 100 }),
      ]);
      yield* seedDeferred(81, [deferredWork("index")]);
      assert.deepStrictEqual(
        (yield* store.readDeferred(0, 1)).map((row) => row.memoryId),
        [M.MemoryId.make(id(81))],
      );
      assert.strictEqual((yield* store.readDeferred(0, -1)).length, 0);
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "orders deferred rows by due, null-first last attempt, memory and kind across restart",
    () =>
      Effect.gen(function* () {
        yield* seedDeferred(80, [deferredWork("index", { lastAttemptAt: 10 })]);
        yield* seedDeferred(81, [deferredWork("scanner"), deferredWork("index")]);
        yield* seedDeferred(82, [deferredWork("parent", { dueAt: 1 })]);
        const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        assert.deepStrictEqual(
          (yield* fresh.readDeferred(1, 3)).map((row) => [row.memoryId, row.kind]),
          [
            [M.MemoryId.make(id(81)), "index"],
            [M.MemoryId.make(id(81)), "scanner"],
            [M.MemoryId.make(id(80)), "index"],
          ],
        );
      }).pipe(Effect.provide(live)),
  );
  it.effect("charges index payloads independently of unrelated history", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* seedDeferred(
        80,
        [deferredWork("index"), deferredWork("scanner")],
        M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
      );
      const rows = yield* store.readDeferred(0, 10);
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows.find((row) => row.kind === "index")!.payloadBytes, 0);
      assert.strictEqual(
        rows.find((row) => row.kind === "scanner")!.payloadBytes,
        Math.min(
          M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS * M.MEMORY_PAYLOAD_MAX_UTF8_BYTES,
        ),
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("advances an approved scanner with over 8 MiB history across restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(approved());
      const payload = yield* encodePayload({
        text: "x".repeat(16000),
        evidence: [],
        derivedFromMemoryRevisions: [],
      });
      for (let index = 0; index < 600; index++) {
        yield* sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${id(1000 + index)},${memory},${payload},'[]')`;
      }
      assert.isAbove(
        (yield* store.usage(space, { kind: "user" })).historyBytes,
        M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
      );
      const first = (yield* store.readDeferred(0, 100)).find((row) => row.kind === "scanner")!;
      assert.isDefined(first);
      assert.isTrue(yield* store.claimDeferred(first, "owner", 0, 1000));
      const chunk = yield* store.readScannerChunk(first);
      assert.strictEqual(chunk.payloads.length, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
      assert.isNotNull(chunk.nextCursor);
      assert.strictEqual(scanMemoryValue({ payloads: chunk.payloads }).kind, "allowed");
      assert.isTrue(
        yield* store.finishOwnedDeferred(first, "owner", 1000, {
          now: 0,
          scannerCursor: chunk.nextCursor!,
        }),
      );
      assert.include(
        (yield* store.loadAggregate(space, memory)).item!.localAvailability.reasons,
        "scanner_pending",
      );
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      const second = (yield* fresh.readDeferred(0, 100)).find((row) => row.kind === "scanner")!;
      assert.strictEqual(second.scannerCursor, chunk.nextCursor);
      assert.isFalse(yield* fresh.claimDeferred(first, "stale", 0, 1000));
      assert.isTrue(yield* fresh.claimDeferred(second, "owner", 0, 1000));
      const rest = yield* fresh.readScannerChunk(second);
      assert.strictEqual(rest.payloads.length, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
      assert.isNotNull(rest.nextCursor);
      assert.isTrue(
        yield* fresh.finishOwnedDeferred(second, "owner", 1000, {
          now: 0,
          scannerCursor: rest.nextCursor!,
        }),
      );
      const third = (yield* fresh.readDeferred(0, 100)).find((row) => row.kind === "scanner")!;
      assert.strictEqual(third.scannerCursor, rest.nextCursor);
      assert.isTrue(yield* fresh.claimDeferred(third, "owner", 0, 1000));
      const tail = yield* fresh.readScannerChunk(third);
      assert.strictEqual(tail.payloads.length, 601 - 2 * M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
      assert.isNull(tail.nextCursor);
      assert.isTrue(
        yield* fresh.finishOwnedDeferred(third, "owner", 1000, {
          now: 0,
          scannerPolicyVersion: 1,
        }),
      );
      assert.notInclude(
        (yield* fresh.loadAggregate(space, memory)).item!.localAvailability.reasons,
        "scanner_pending",
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "recovers only eligible held rows in bounded batches and leaves idle items untouched",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* seedDeferred(1000, [deferredWork("scanner")]);
        yield* seedDeferred(2000, [deferredWork("index", { state: "held", reason: "fts_braked" })]);
        yield* store.putFtsState({ ...(yield* store.ftsState(env)), state: "braked" });
        for (let index = 1; index <= M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS + 1; index++) {
          yield* seedDeferred(1000 + index, [
            deferredWork("scanner", {
              state: "held",
              reason: "secret_detected",
              scannerCursor: "old-policy-cursor",
            }),
          ]);
        }
        yield* sql`CREATE TABLE recovery_updates (memory_id TEXT)`;
        yield* sql`CREATE TRIGGER count_recovery AFTER UPDATE ON memory_items BEGIN INSERT INTO recovery_updates VALUES (NEW.memory_id); END`;
        yield* store.recoverDeferred(1, 0);
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates`).length,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
        );
        yield* store.recoverDeferred(1, 0);
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates`).length,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS + 1,
        );
        yield* store.recoverDeferred(1, 0);
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates`).length,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS + 1,
        );
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates WHERE memory_id IN (${id(1000)},${id(2000)})`)
            .length,
          0,
        );
        const resumed = (yield* store.readDeferred(0, 100)).find(
          (row) => row.memoryId === id(1001),
        )!;
        assert.isUndefined(resumed.scannerCursor);
        yield* store.putFtsState({ ...(yield* store.ftsState(env)), state: "open" });
        yield* store.recoverDeferred(1, 0);
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates`).length,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS + 2,
        );
      }).pipe(Effect.provide(live)),
  );
  it.effect("recovers global parked work with bounded pages after event compaction", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(parked());
      yield* sql`DELETE FROM memory_events`;
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(yield* fresh.readParked(1), [childOperation()]);
      assert.deepStrictEqual(yield* fresh.readParked(0), []);
      assert.deepStrictEqual(yield* fresh.readParked(-1), []);
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "cancels future and running thread jobs without crossing environment or terminal boundaries",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        yield* store.enqueueWork(summaryWork(1));
        yield* store.enqueueWork({ ...summaryWork(2), kind: "consolidate", nextAttemptAt: 10000 });
        yield* store.enqueueWork(summaryWork(3));
        yield* store.claimWork(summaryWork(3).id, "runtime", 0, 100);
        yield* store.enqueueWork({ ...summaryWork(4), status: "completed" });
        yield* store.enqueueWork(summaryWork(5, M.EnvironmentId.make("other")));
        const thread = { environmentId: env, threadId: M.ThreadId.make(id(70)) };
        assert.strictEqual(yield* store.cancelThreadWork(thread), 3);
        assert.strictEqual(yield* store.cancelThreadWork(thread), 0);
        assert.strictEqual((yield* store.readWork(summaryWork(3).id))?.status, "cancelled");
        assert.isNull((yield* store.readWork(summaryWork(3).id))?.claimedBy);
        assert.strictEqual((yield* store.readWork(summaryWork(4).id))?.status, "completed");
        assert.strictEqual((yield* store.readWork(summaryWork(5).id))?.status, "pending");
      }).pipe(Effect.provide(live)),
  );
  it.effect(
    "commits a hook summary intent and watermark with rollback on summary insertion failure",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_summary BEFORE INSERT ON memory_outbox WHEN NEW.kind='summary' BEGIN SELECT RAISE(ABORT,'fixture'); END`;
        const input = { expectedWatermark: 0, throughWatermark: 7, work: [summaryWork(7)] };
        assert.strictEqual((yield* Effect.exit(store.commitThreadHook(input)))._tag, "Failure");
        assert.strictEqual(yield* store.readThreadHookWatermark(), 0);
        yield* sql`DROP TRIGGER fail_summary`;
        yield* store.commitThreadHook(input);
        assert.deepStrictEqual(yield* store.readWork(summaryWork(7).id), summaryWork(7));
        assert.strictEqual(yield* store.readThreadHookWatermark(), 7);
      }).pipe(Effect.provide(live)),
  );
});

describe("generation failure ownership", () => {
  const failure = (work: Store.MemoryWork, retryAt: number | null = null) => ({
    work,
    environmentId: env,
    failureCode: "generation_failed" as const,
    now: 1,
    retryAt,
  });
  const claimed = Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    yield* store.enqueueWork({ ...summaryWork(9), space, memoryId: memory });
    yield* store.claimWork("summary:9", "worker", 0, 100);
    return (yield* store.readWork("summary:9"))!;
  });
  it.effect("records one report and terminates atomically", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      assert.isTrue(yield* store.failGenerationAttempt(failure(work)));
      assert.isFalse(yield* store.failGenerationAttempt(failure(work)));
      const reports = yield* store.pendingReports(100);
      assert.strictEqual(reports.length, 1);
      assert.strictEqual(reports[0]!.outcome, "failed");
      assert.strictEqual(reports[0]!.failureCode, "generation_failed");
      assert.strictEqual((yield* store.readWork(work.id))!.status, "failed");
    }).pipe(Effect.provide(live)),
  );
  it.effect("persists retry due time with the safe report", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      assert.isTrue(yield* store.failGenerationAttempt(failure(work, 5001)));
      assert.strictEqual((yield* store.readWork(work.id))!.nextAttemptAt, 5001);
      assert.strictEqual((yield* store.pendingReports(100)).length, 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("rejects stale owners and expired claims without reports", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      assert.isFalse(yield* store.failGenerationAttempt(failure({ ...work, claimedBy: "other" })));
      assert.isFalse(yield* store.failGenerationAttempt({ ...failure(work), now: 100 }));
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
    }).pipe(Effect.provide(live)),
  );
  it.effect("rejects foreign environment authority", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      const result = yield* store
        .failGenerationAttempt({ ...failure(work), environmentId: M.EnvironmentId.make("foreign") })
        .pipe(Effect.flip);
      assert.strictEqual(result._tag, "MemoryStoreConflict");
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
    }).pipe(Effect.provide(live)),
  );
  it.effect("rolls back report and retry together", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* store.failGenerationAttempt(failure(work, 5001));
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          }),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
      assert.strictEqual((yield* store.readWork(work.id))!.status, "running");
    }).pipe(Effect.provide(live)),
  );
});

describe("unbound summary replacement", () => {
  const draft = (watermark: number): Store.LocalMemoryIntent => ({
    intentId: "summary-draft",
    environmentId: env,
    memoryId: memory,
    scope: { kind: "thread", thread: { environmentId: env, threadId: M.ThreadId.make("thread") } },
    assertionKind: "inference",
    createdAtUtc: now,
    provenance: {
      environmentId: env,
      sourceThread: { environmentId: env, threadId: M.ThreadId.make("thread") },
      sourceWatermark: {
        fromEventId: M.EventId.make("first"),
        toEventId: M.EventId.make("last"),
        throughSequence: watermark,
      },
    },
    payload: {
      text: `synthetic summary ${watermark}`,
      evidence: [],
      derivedFromMemoryRevisions: [],
    },
  });
  it.effect("replaces only with a newer committed watermark", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.refreshLocalSummaryIntent(draft(1));
      yield* store.refreshLocalSummaryIntent(draft(2));
      yield* store.refreshLocalSummaryIntent(draft(1));
      const work = yield* store.readWork("local:fixture:summary-draft");
      assert.strictEqual(work?.metadata.kind, "localIntent");
      if (work?.metadata.kind === "localIntent")
        assert.strictEqual(work.metadata.provenance.sourceWatermark?.throughSequence, 2);
    }).pipe(Effect.provide(live)),
  );
  it.effect("cannot resurrect a forgotten local draft", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.refreshLocalSummaryIntent(draft(1));
      yield* store.forgetLocalIntent(env, "summary-draft");
      const result = yield* store.refreshLocalSummaryIntent(draft(2)).pipe(Effect.flip);
      assert.strictEqual(result._tag, "MemoryStoreConflict");
      if (result._tag === "MemoryStoreConflict") assert.strictEqual(result.code, "forgotten");
    }).pipe(Effect.provide(live)),
  );
});

describe("derived work integration", () => {
  it.effect("active writes durably schedule a generation-fenced index repair", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(decision());
      const rows = yield* store.readDeferred(0, 100);
      assert.isTrue(
        rows.some((r) => r.kind === "index" && r.memoryId === memory && r.generation === 1),
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("local draft admin rows cannot starve generic work", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.enqueueWork({ ...backgroundWork("a-admin"), kind: "admin" });
      yield* store.enqueueWork(backgroundWork("z-index"));
      assert.deepStrictEqual(
        (yield* store.dueWork(0, 1)).map((w) => w.id),
        ["z-index"],
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("pending sync clears after durable acknowledgement", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const op = operation();
      yield* store.apply(decision(op));
      assert.isTrue((yield* store.loadAggregate(space, memory)).item!.pendingSync);
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, {
        operationId: op.operationId,
        memoryId: memory,
        operationDigest: hash,
        hubSequence: 1,
        outcome: "accepted",
      });
      assert.isFalse((yield* store.loadAggregate(space, memory)).item!.pendingSync);
    }).pipe(Effect.provide(live)),
  );
});

describe("worker completion fencing", () => {
  it.effect("rejects a deferred completion from an old owner", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(decision());
      const target = (yield* store.readDeferred(0, 100))[0]!;
      yield* store.claimDeferred(target, "new-owner", 0, Number.MAX_SAFE_INTEGER);
      assert.isFalse(
        yield* store.finishOwnedDeferred(target, "old-owner", Number.MAX_SAFE_INTEGER, { now: 1 }),
      );
      assert.strictEqual((yield* store.readDeferred(0, 100)).length, 0);
    }).pipe(Effect.provide(live)),
  );
  it.effect("compacts older completed summary rows without dropping the latest receipt", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.enqueueWork({ ...summaryWork(9), status: "completed" });
      yield* store.enqueueWork(summaryWork(10));
      yield* store.claimWork("summary:10", "worker", 0, Number.MAX_SAFE_INTEGER);
      const work = (yield* store.readWork("summary:10"))!;
      assert.isTrue(yield* store.completeSummaryWork(work));
      assert.isUndefined(yield* store.readWork("summary:9"));
      assert.strictEqual((yield* store.readWork("summary:10"))!.status, "completed");
      assert.isFalse(yield* store.completeSummaryWork(work));
    }).pipe(Effect.provide(live)),
  );
  it.effect("rolls back summary completion and receipt compaction together", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.enqueueWork({ ...summaryWork(9), status: "completed" });
      yield* store.enqueueWork(summaryWork(10));
      yield* store.claimWork("summary:10", "worker", 0, Number.MAX_SAFE_INTEGER);
      const work = (yield* store.readWork("summary:10"))!;
      yield* store
        .transact(
          store
            .completeSummaryWork(work)
            .pipe(
              Effect.andThen(
                Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" })),
              ),
            ),
        )
        .pipe(Effect.flip);
      assert.isDefined(yield* store.readWork("summary:9"));
      assert.strictEqual((yield* store.readWork("summary:10"))!.status, "running");
    }).pipe(Effect.provide(live)),
  );
});
