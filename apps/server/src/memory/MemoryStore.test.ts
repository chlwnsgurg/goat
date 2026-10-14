import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/070_Memory.ts";
import hubMigration from "../persistence/Migrations/071_MemoryHubSync.ts";
import * as Store from "./MemoryStore.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(2));
const env = M.EnvironmentId.make("fixture");
const now = "2026-10-14T00:00:00.000Z";
const hash = "a".repeat(64);
const encodeOperationJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryOperation));
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(M.MemoryPayload));
const encodeCheckpointPage = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubCheckpointPage));
const decodeCheckpointPage = Schema.decodeEffect(Schema.fromJsonString(M.MemoryHubCheckpointPage));
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
const setup = Layer.effectDiscard(migration.pipe(Effect.andThen(hubMigration))).pipe(
  Layer.provideMerge(database),
);
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
        receipt: {
          ...base.receipt,
          hubSequence: Number.MAX_SAFE_INTEGER,
          resolutionApproval: {
            resolutionId: M.MemoryResolutionId.make(id(10)),
            appliedAtUtc: now,
            revertDeadlineUtc: M.MemoryUtcTimestamp.make("2026-11-13T00:00:00.000Z"),
          },
        },
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

it("measures the versioned compact maximum and preserves approval and correlation fields", () => {
  const record = M.MemoryCompactReceipt.make({
    memorySpaceId: space,
    originEnvironmentId: env,
    operationKind: "resolve",
    receipt: {
      operationId: M.MemoryOperationId.make(id(3)),
      memoryId: memory,
      operationDigest: hash,
      outcome: "accepted",
      hubSequence: Number.MAX_SAFE_INTEGER,
      resolutionApproval: {
        resolutionId: M.MemoryResolutionId.make(id(7)),
        appliedAtUtc: M.MemoryUtcTimestamp.make("+275760-08-13T00:00:00.000Z"),
        revertDeadlineUtc: M.MemoryUtcTimestamp.make("+275760-09-12T00:00:00.000Z"),
      },
      forgetExpansion: {
        requestDigest: hash,
        operationId: M.MemoryOperationId.make(id(8)),
        operationDigest: hash,
        status: "pending",
      },
      forgetRetryOf: { operationId: M.MemoryOperationId.make(id(9)), operationDigest: hash },
    },
    revisionId: M.MemoryRevisionId.make(id(4)),
    resolutionId: M.MemoryResolutionId.make(id(7)),
    revertsResolutionId: null,
    attemptId: M.MemoryOperationId.make(id(5)),
    fencingToken: Number.MAX_SAFE_INTEGER,
    reportGuard: {
      reportId: hash,
      resolvingEnvironmentId: env,
      resolutionId: M.MemoryResolutionId.make(id(7)),
      outcome: "resolved",
    },
  });
  const bytes = Store.encodeCompactReceipt(record, () => Number.MAX_SAFE_INTEGER);
  assert.strictEqual(bytes.length, M.MEMORY_COMPACT_RECEIPT_ENCODING_MAX_BYTES);
  assert.strictEqual(
    bytes.length + M.MEMORY_COMPACT_RECEIPT_HEADROOM_BYTES,
    M.MEMORY_COMPACT_RECEIPT_MAX_BYTES,
  );
  assert.deepStrictEqual(
    Store.decodeCompactReceipt(bytes, space, () => env),
    record,
  );
  const rejected = M.MemoryCompactReceipt.make({
    ...record,
    revisionId: null,
    reportGuard: null,
    receipt: {
      operationId: record.receipt.operationId,
      memoryId: memory,
      operationDigest: hash,
      hubSequence: Number.MAX_SAFE_INTEGER,
      outcome: "rejected",
      failureCode: "capacity_exceeded",
      capacity: {
        code: "capacity_exceeded",
        dimension: "live_payload_bytes",
        current: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
        reclaimable: Number.MAX_SAFE_INTEGER,
      },
      forgetExpansion: record.receipt.forgetExpansion!,
      forgetRetryOf: record.receipt.forgetRetryOf!,
    },
  });
  assert.isAtMost(
    Store.encodeCompactReceipt(rejected, () => Number.MAX_SAFE_INTEGER).length,
    bytes.length,
  );
  const op = operation();
  const legacyRecord = M.MemoryCompactReceipt.make({
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
    revisionId: M.MemoryRevisionId.make(id(13)),
    resolutionId: null,
    revertsResolutionId: null,
    attemptId: null,
    fencingToken: null,
    reportGuard: null,
  });
  const v2 = Store.encodeCompactReceipt(legacyRecord, () => 1);
  const v1 = v2.slice(0, -3);
  v1[0] = 1;
  assert.deepStrictEqual(
    Store.decodeCompactReceipt(v1, space, () => env),
    legacyRecord,
  );
  assert.deepStrictEqual(
    Store.decodeCompactReceipt(v2, space, () => env),
    legacyRecord,
  );
});

it.effect(
  "selects base forget and extension before LIMIT, then preserves retry ownership across restart",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const enqueue = (n: number, kind: "upsert" | "forget") =>
        Effect.gen(function* () {
          const base = operation(n);
          if (base.kind !== "upsert") throw new Error("fixture");
          const op: M.MemoryOperation =
            kind === "upsert"
              ? base
              : {
                  protocolVersion: 1,
                  kind: "forget",
                  memorySpaceId: space,
                  memoryId: memory,
                  operationId: base.operationId,
                  originEnvironmentId: env,
                  expectedHeads: [],
                  tombstone: {
                    memorySpaceId: space,
                    memoryId: memory,
                    deleteOperationId: base.operationId,
                    deletingEnvironmentId: env,
                    deletedAtUtc: M.MemoryUtcTimestamp.make(now),
                    suppressedSourceKeys: [],
                    suppressedContent: [],
                    sourceExclusions: [],
                  },
                };
          const { payload: _payload, ...metadata } =
            kind === "upsert" ? base : { ...op, payload: undefined };
          const workId = `sync:${space}:${op.operationId}`;
          yield* store.enqueueWork({
            id: workId,
            space,
            memoryId: memory,
            kind: "sync",
            status: "pending",
            metadata,
            payloadRef: null,
            attempt: 0,
            nextAttemptAt: 0,
            claimedBy: null,
            claimedUntil: null,
          });
          yield* sql`UPDATE memory_outbox SET operation_digest=${hash} WHERE id=${workId}`;
          return { op, workId };
        });
      for (let n = 100; n < 205; n++) yield* enqueue(n, "upsert");
      const base = yield* enqueue(500, "forget");
      const extension = yield* enqueue(501, "forget");
      const metadata = yield* encodeOperationJson(base.op);
      yield* sql`INSERT INTO memory_events(protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,${space},${memory},${base.op.operationId},'forget',${env},${hash},${metadata},${`{"forgetExpansion":{"operationId":"${extension.op.operationId}"}}`},0)`;
      const due = yield* store.readEligibleOutbox(space, 0, 2);
      assert.deepStrictEqual(
        due.map((c) => c.work.id),
        [base.workId, extension.workId],
      );
      // The actual immutable forget bytes must match the ownership digest.
      const original = yield* store.readWorkOperation(base.workId);
      assert.isDefined(original);
      const digest = memoryOperationDigest(original!);
      yield* sql`UPDATE memory_outbox SET operation_digest=${digest} WHERE id=${base.workId}`;
      const owner = yield* store.transact(
        store.acquireSyncWorkTx({
          workId: base.workId,
          operationId: base.op.operationId,
          operationDigest: digest,
          owner: "first",
          expectedVersion: 0,
          now: 0,
          ownedUntil: 10,
        }),
      );
      assert.isNotNull(owner);
      const retry = yield* store.transact(
        store.retrySyncWorkTx({
          ownership: owner!,
          now: 1,
          nextAttemptAt: 20,
          failureCode: "source_unavailable",
        }),
      );
      assert.isTrue(retry);
      assert.isFalse(
        yield* store.transact(
          store.retrySyncWorkTx({
            ownership: owner!,
            now: 2,
            nextAttemptAt: 30,
            failureCode: null,
          }),
        ),
      );
      assert.isFalse(
        (yield* store.readEligibleOutbox(space, 19, 2)).some((c) => c.work.id === base.workId),
      );
      const recovered = yield* Effect.gen(function* () {
        const restarted = yield* Store.MemoryStore;
        return yield* restarted.readEligibleOutbox(space, 20, 2);
      }).pipe(Effect.provide(Store.layer));
      assert.strictEqual(recovered[0]?.operationDigest, digest);
      assert.strictEqual(recovered[0]?.work.id, base.workId);
      assert.strictEqual(recovered[0]?.version, 2);
    }).pipe(Effect.provide(live)),
);

it.effect(
  "reserves combined checkpoint bytes at equality and rolls back overflow and failed transactions",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const reserved = yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - 1,
          publishedPinnedDeltaBytes: 1,
        }),
      );
      assert.strictEqual(reserved.stagingBytes, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES);
      const overflow = yield* store
        .transact(
          store.reserveHubCheckpointTx({
            memorySpaceId: space,
            checkpointDeltaBytes: 1,
            publishedPinnedDeltaBytes: 0,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(overflow._tag, "MemoryCapacityError");
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* store.reserveHubCheckpointTx({
              memorySpaceId: space,
              checkpointDeltaBytes: -10,
              publishedPinnedDeltaBytes: 0,
            });
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.exit);
      assert.strictEqual(
        (yield* store.transact(store.readHubUsageTx(space))).stagingBytes,
        M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
      );
    }).pipe(Effect.provide(live)),
);

it.effect(
  "recovers the full frozen claim, ignores a changed default, and retires only the matching generation",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const first = operation();
      if (first.kind !== "upsert") throw new Error("fixture");
      const commit = (op: M.MemoryOperation) =>
        Effect.gen(function* () {
          const current = yield* store.loadAggregate(space, memory);
          yield* store.apply(
            decideMemoryOperation(current, op, Store.hubAdmission, { kind: "allowed" }),
          );
        });
      yield* commit(first);
      const child = (n: number): M.MemoryOperation => {
        const op = operation(n);
        if (op.kind !== "upsert") throw new Error("fixture");
        return {
          ...op,
          expectedHeads: [first.revision.revisionId],
          revision: { ...op.revision, parents: [first.revision.revisionId] },
        };
      };
      yield* commit(child(4));
      yield* commit(child(5));
      yield* store.recoverClaimCandidates(0);
      const candidate = (yield* store.readDueClaimCandidates(1, 0))[0]!;
      if (candidate.metadata.kind !== "claim") throw new Error("fixture");
      const claim: M.MemoryHubClaimInput = {
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        holderEnvironmentId: env,
        conflictId: candidate.metadata.conflictId,
        conflictHeadSet: candidate.metadata.sortedHeads,
        attemptId: M.MemoryOperationId.make(id(60)),
        frozenDefaultModelSelection: { instanceId: M.ProviderInstanceId.make("P"), model: "P" },
      };
      yield* store.retryClaimCandidate(candidate.id, 100, "lease_required");
      assert.isNull(
        yield* store.transact(
          store.prepareClaimAttemptTx({
            memorySpaceId: space,
            candidateId: candidate.id,
            expectedGeneration: 0,
            conflictHeads: claim.conflictHeadSet,
            proposedClaim: claim,
          }),
        ),
      );
      yield* store.retryClaimCandidate(candidate.id, 0, "lease_required");
      const prepared = yield* store.transact(
        store.prepareClaimAttemptTx({
          memorySpaceId: space,
          candidateId: candidate.id,
          expectedGeneration: 0,
          conflictHeads: claim.conflictHeadSet,
          proposedClaim: claim,
        }),
      );
      assert.deepStrictEqual(prepared, { claim, generation: 0 });
      const changed = {
        ...claim,
        attemptId: M.MemoryOperationId.make(id(61)),
        frozenDefaultModelSelection: { instanceId: M.ProviderInstanceId.make("Q"), model: "Q" },
      };
      const recovered = yield* Effect.gen(function* () {
        const restarted = yield* Store.MemoryStore;
        return yield* restarted.transact(
          restarted.prepareClaimAttemptTx({
            memorySpaceId: space,
            candidateId: candidate.id,
            expectedGeneration: 0,
            conflictHeads: claim.conflictHeadSet,
            proposedClaim: changed,
          }),
        );
      }).pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(recovered, { claim, generation: 0 });
      const ticket: M.MemoryResolutionLease = {
        memorySpaceId: space,
        memoryId: memory,
        conflictId: claim.conflictId,
        conflictHeadSet: claim.conflictHeadSet,
        holderEnvironmentId: env,
        attemptId: claim.attemptId,
        frozenDefaultModelSelection: claim.frozenDefaultModelSelection,
        fencingToken: 1,
        claimedAtHubTime: M.MemoryUtcTimestamp.make("1970-01-01T00:00:00.000Z"),
        expiresAtHubTime: M.MemoryUtcTimestamp.make("1970-01-01T00:02:00.000Z"),
        attemptDeadlineHubTime: M.MemoryUtcTimestamp.make("1970-01-01T00:10:00.000Z"),
      };
      yield* store.persistResolutionTicket(ticket);
      const key = { memorySpaceId: space, attemptId: claim.attemptId };
      const owned = yield* store.transact(
        store.acquireResolutionTicketTx({
          key,
          expectedVersion: 0,
          owner: "registry",
          coordinatorEpoch: 1,
          now: 0,
          ownedUntil: 100,
        }),
      );
      assert.isNotNull(owned);
      const ownership = { ...key, owner: "registry", coordinatorEpoch: 1, version: owned!.version };
      assert.isNull(
        yield* store.transact(
          store.transitionResolutionTicketTx({
            ownership,
            nextState: "terminal",
            now: 1,
            ownedUntil: null,
            nextAttemptAt: 1,
            retireClaim: { expectedGeneration: 9, attemptId: claim.attemptId },
          }),
        ),
      );
      assert.isNotNull(
        yield* store.transact(
          store.transitionResolutionTicketTx({
            ownership,
            nextState: "terminal",
            now: 1,
            ownedUntil: null,
            nextAttemptAt: 1,
            retireClaim: { expectedGeneration: 0, attemptId: claim.attemptId },
          }),
        ),
      );
      yield* TestClock.adjust(1);
      const next = yield* store.transact(
        store.prepareClaimAttemptTx({
          memorySpaceId: space,
          candidateId: candidate.id,
          expectedGeneration: 1,
          conflictHeads: changed.conflictHeadSet,
          proposedClaim: changed,
        }),
      );
      assert.deepStrictEqual(next, { claim: changed, generation: 1 });
      assert.isNull(
        yield* store.transact(
          store.prepareClaimAttemptTx({
            memorySpaceId: space,
            candidateId: candidate.id,
            expectedGeneration: 0,
            conflictHeads: claim.conflictHeadSet,
            proposedClaim: claim,
          }),
        ),
      );
    }).pipe(Effect.provide(live)),
);

describe("MemoryStore hub administration", () => {
  const record = (
    n: number,
    action: "provisionMember" | "rotateMemberCredential" | "revokeMember",
  ): Store.AdminRecord => ({
    requestId: M.MemoryOperationId.make(id(n)),
    requestDigest: "b".repeat(64),
    expectedVersion: n,
    stage: "prepared",
    action: {
      requestId: M.MemoryOperationId.make(id(n)),
      expectedVersion: n,
      action,
      environmentId: env,
    },
    secretName: action === "revokeMember" ? null : "synthetic-member-key",
    result: null,
    memberVersion: null,
  });
  it.effect("provisions, rotates and revokes with durable replay and stale credential denial", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const first = record(200, "provisionMember");
      yield* store.transact(store.writeHubAdminTx({ record: first, expectedStage: null }));
      const activation = {
        requestId: first.requestId,
        requestDigest: first.requestDigest,
        memorySpaceId: space,
        environmentId: env,
        expectedCredentialVersion: null,
        next: { credentialDigest: "a".repeat(64), credentialVersion: 1 },
        now: 100,
      };
      const member = yield* store.transact(store.activateHubMemberTx(activation));
      assert.strictEqual(member.credentialVersion, 1);
      assert.deepStrictEqual(yield* store.transact(store.activateHubMemberTx(activation)), member);
      const rotate = record(201, "rotateMemberCredential");
      yield* store.transact(store.writeHubAdminTx({ record: rotate, expectedStage: null }));
      yield* store.transact(
        store.activateHubMemberTx({
          ...activation,
          requestId: rotate.requestId,
          expectedCredentialVersion: 1,
          next: { credentialDigest: "c".repeat(64), credentialVersion: 2 },
        }),
      );
      assert.isUndefined(yield* store.findHubMemberByCredential("a".repeat(64)));
      assert.strictEqual(
        (yield* store
          .transact(
            store.requireHubMemberTx({
              memorySpaceId: space,
              environmentId: env,
              credentialVersion: 1,
              scopes: ["memory:sync"],
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      const revoke = record(202, "revokeMember");
      yield* store.transact(store.writeHubAdminTx({ record: revoke, expectedStage: null }));
      const revoked = yield* store.transact(
        store.activateHubMemberTx({
          ...activation,
          requestId: revoke.requestId,
          expectedCredentialVersion: 2,
          next: "revoked",
        }),
      );
      assert.strictEqual(revoked.status, "revoked");
      assert.strictEqual(revoked.credentialVersion, 3);
      assert.strictEqual(
        (yield* store.transact(store.readHubAdminTx(revoke.requestId)))?.stage,
        "activated",
      );
      assert.strictEqual((yield* store.readPendingHubAdmins(100)).length, 3);
    }).pipe(Effect.provide(live)),
  );
  it.effect("rolls activation back with the admin stage and rejects changed request reuse", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const first = record(210, "provisionMember");
      yield* store.transact(store.writeHubAdminTx({ record: first, expectedStage: null }));
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* store.activateHubMemberTx({
              requestId: first.requestId,
              requestDigest: first.requestDigest,
              memorySpaceId: space,
              environmentId: env,
              expectedCredentialVersion: null,
              next: { credentialDigest: "a".repeat(64), credentialVersion: 1 },
              now: 0,
            });
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          }),
        )
        .pipe(Effect.flip);
      assert.isUndefined(yield* store.readHubMember(space, env));
      assert.strictEqual(
        (yield* store.transact(store.readHubAdminTx(first.requestId)))?.stage,
        "prepared",
      );
      assert.strictEqual(
        (yield* store
          .transact(
            store.writeHubAdminTx({
              record: { ...first, requestDigest: "d".repeat(64) },
              expectedStage: "prepared",
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "configure publishes the initial empty checkpoint and internal membership atomically",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const first: Store.AdminRecord = {
          requestId: M.MemoryOperationId.make(id(220)),
          requestDigest: hash,
          expectedVersion: 0,
          stage: "prepared",
          action: {
            action: "configure",
            requestId: M.MemoryOperationId.make(id(220)),
            expectedVersion: 0,
            settings: { mode: "hub", memorySpaceId: space },
          },
          secretName: null,
          result: null,
          memberVersion: null,
        };
        yield* store.transact(store.writeHubAdminTx({ record: first, expectedStage: null }));
        const activation = {
          requestId: first.requestId,
          requestDigest: hash,
          memorySpaceId: space,
          environmentId: env,
          expectedCredentialVersion: null,
          next: { credentialDigest: hash, credentialVersion: 1 },
          now: 0,
        };
        yield* store
          .transact(
            Effect.gen(function* () {
              yield* store.activateHubMemberTx(activation);
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            }),
          )
          .pipe(Effect.flip);
        assert.isUndefined(yield* store.readHubMember(space, env));
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_compaction_state WHERE published=1`).length,
          0,
        );
        const member = yield* store.transact(store.activateHubMemberTx(activation));
        assert.strictEqual(member.status, "active");
        const published = yield* sql<{
          published: number;
          checkpoint_id: string;
        }>`SELECT published,checkpoint_id FROM memory_compaction_state WHERE space=${space}`;
        assert.strictEqual(published[0]!.published, 1);
        const bytes = yield* store.transact(store.readHubUsageTx(space));
        assert.isAbove(bytes.checkpointBytes, 0);
        assert.strictEqual(bytes.liveHandles, 0);
        const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        assert.deepStrictEqual(
          yield* fresh.transact(fresh.activateHubMemberTx(activation)),
          member,
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE reason='hub_snapshot'`).length,
          1,
        );
      }).pipe(Effect.provide(live)),
  );
  it.effect(
    "bootstrap cannot become ready before the matching canonical checkpoint is published",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const progress = {
          memorySpaceId: space,
          hubEnvironmentId: env,
          checkpointId: "synthetic-checkpoint",
          snapshotToken: "synthetic-token",
          checkpointSequence: 5,
          nextCursor: null,
        };
        yield* store.transact(
          store.advanceBootstrapTx({ ...progress, expectedState: "unbound", nextState: "staging" }),
        );
        const error = yield* store
          .transact(
            store.advanceBootstrapTx({ ...progress, expectedState: "staging", nextState: "ready" }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "MemoryStoreConflict");
        if (error._tag === "MemoryStoreConflict")
          assert.strictEqual(error.code, "bootstrap_required");
      }).pipe(Effect.provide(live)),
  );
});

describe("MemoryStore transient source relay", () => {
  const owner = M.EnvironmentId.make("source-owner");
  const thread = { environmentId: owner, threadId: M.ThreadId.make("synthetic-thread") };
  const watermark = {
    fromEventId: M.EventId.make("synthetic-from"),
    toEventId: M.EventId.make("synthetic-to"),
    throughSequence: 8,
  };
  const messageId = M.MessageId.make("synthetic-message");
  const authority = (environmentId = env): Store.HubAuthority => ({
    principal: {
      memorySpaceId: space,
      environmentId,
      credentialVersion: 1,
      scopes: ["memory:sync"],
    },
    now: Clock.currentTimeMillis,
    reauthorize: Effect.void,
  });
  const request: M.MemoryHubSourceReadRequestInput = {
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: memory,
    requestId: M.MemorySourceReadRequestId.make(id(300)),
    sourceThread: thread,
    sourceWatermark: watermark,
    messageIds: [messageId],
    limit: 10,
    authorizedScopes: ["memory:read", "orchestration:read"],
  };
  const seed = Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${env},${"a".repeat(64)},1,'active',0),(${space},${owner},${"b".repeat(64)},1,'active',0)`;
    const base = operation(301);
    if (base.kind !== "upsert")
      return yield* new Store.MemoryStoreConflict({ code: "invalid_output" });
    const op: M.MemoryOperation = {
      ...base,
      revision: {
        ...base.revision,
        provenance: { environmentId: env, sourceThread: thread, sourceWatermark: watermark },
      },
      payload: {
        text: "synthetic linked summary",
        evidence: [{ origin: "thread", sourceThread: thread, watermark, messageIds: [messageId] }],
        derivedFromMemoryRevisions: [],
      },
    };
    const current = yield* store.loadAggregate(space, memory);
    yield* store.apply(decideMemoryOperation(current, op, Store.localIntent, scanMemoryValue(op)));
  });
  it.effect(
    "keeps the first deadline, routes only to the owner, and erases the consumed outcome",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* store.transact(store.requestHubSourceReadTx(authority(), request));
        yield* TestClock.adjust(1000);
        assert.deepStrictEqual(
          yield* store.transact(store.requestHubSourceReadTx(authority(), request)),
          first,
        );
        assert.deepStrictEqual(
          (yield* store.transact(
            store.collectHubSourceReadsTx(authority(), {
              protocolVersion: 1,
              memorySpaceId: space,
              limit: 32,
            }),
          )).requests,
          [],
        );
        assert.strictEqual(
          (yield* store.transact(
            store.collectHubSourceReadsTx(authority(owner), {
              protocolVersion: 1,
              memorySpaceId: space,
              limit: 32,
            }),
          )).requests.length,
          1,
        );
        const outcome: M.MemorySourceReadOutcome = {
          kind: "available",
          page: {
            sourceThread: thread,
            watermark,
            messages: [{ messageId, text: "synthetic original" }],
            nextCursor: null,
          },
        };
        const response = {
          protocolVersion: 1 as const,
          memorySpaceId: space,
          requestId: request.requestId,
          outcome,
        };
        assert.strictEqual(
          (yield* store
            .transact(store.respondHubSourceReadTx(authority(), response))
            .pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.strictEqual(
          (yield* store.transact(store.respondHubSourceReadTx(authority(owner), response)))
            .accepted,
          true,
        );
        assert.strictEqual(
          (yield* store.transact(store.respondHubSourceReadTx(authority(owner), response)))
            .accepted,
          true,
        );
        // Keep the real relay response unconsumed while an approved canonical change is scanned.
        const nextBase = operation(305);
        if (nextBase.kind !== "upsert") throw new Error("fixture");
        const current = yield* store.loadAggregate(space, memory);
        const next = {
          ...nextBase,
          expectedHeads: current.heads,
          revision: {
            ...nextBase.revision,
            parents: current.heads,
            provenance: { environmentId: env, sourceThread: thread, sourceWatermark: watermark },
          },
          payload: {
            ...nextBase.payload,
            evidence: [
              {
                origin: "thread" as const,
                sourceThread: thread,
                watermark,
                messageIds: [messageId],
              },
            ],
          },
        };
        const approved = decideMemoryOperation(
          current,
          next,
          Store.approvedReplica,
          scanMemoryValue(next),
          {
            operationId: next.operationId,
            memoryId: memory,
            operationDigest: memoryOperationDigest(next),
            outcome: "accepted",
            hubSequence: 2,
          },
        );
        yield* store.apply(approved);
        const scanner = (yield* store.readDeferred(yield* Clock.currentTimeMillis, 100)).find(
          (d) => d.kind === "scanner",
        )!;
        assert.isDefined(scanner);
        const chunk = yield* store.readScannerChunk(scanner);
        assert.isTrue(chunk.payloads.every((p) => "text" in p || "judgment" in p));
        assert.isFalse(JSON.stringify(chunk.payloads).includes("synthetic original"));
        assert.isTrue(
          yield* store.claimDeferred(scanner, "scanner", yield* Clock.currentTimeMillis, 2000),
        );
        assert.isTrue(
          yield* store.finishOwnedDeferred(scanner, "scanner", 2000, {
            now: yield* Clock.currentTimeMillis,
            scannerPolicyVersion: 1,
          }),
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${`relay:${request.requestId}`}`)
            .length,
          1,
        );
        assert.deepStrictEqual(
          yield* store.transact(
            store.resultHubSourceReadTx(authority(), {
              protocolVersion: 1,
              memorySpaceId: space,
              requestId: request.requestId,
            }),
          ),
          { state: "completed", outcome },
        );
        const rows = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_payloads WHERE payload_ref=${`relay:${request.requestId}`}`;
        assert.strictEqual(rows[0]!.count, 0);
        assert.strictEqual(
          (yield* store.transact(
            store.resultHubSourceReadTx(authority(), {
              protocolVersion: 1,
              memorySpaceId: space,
              requestId: request.requestId,
            }),
          )).state,
          "expired",
        );
      }).pipe(Effect.provide(live)),
  );
  it.effect("preserves post-lock 401 and 403 errors for relay and checkpoint ports", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      for (const failure of [
        new M.MemoryHubUnauthorizedError({}),
        new M.MemoryHubForbiddenError({}),
      ]) {
        const denied = { ...authority(), reauthorize: Effect.fail(failure) };
        assert.strictEqual(
          (yield* store.transact(store.requestHubSourceReadTx(denied, request)).pipe(Effect.flip))
            ._tag,
          failure._tag,
        );
        assert.strictEqual(
          (yield* store
            .transact(
              store.prepareHubCheckpointTx({
                authority: denied,
                checkpointId: "denied",
                snapshotToken: "denied",
                hubEnvironmentId: env,
              }),
            )
            .pipe(Effect.flip))._tag,
          failure._tag,
        );
        assert.strictEqual(
          (yield* store
            .transact(
              store.readHubCheckpointPageTx({
                authority: denied,
                snapshotToken: "missing",
                cursor: null,
              }),
            )
            .pipe(Effect.flip))._tag,
          failure._tag,
        );
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE memory_hub_members SET status='revoked' WHERE environment=${env}`;
      assert.strictEqual(
        (yield* store
          .transact(store.requestHubSourceReadTx(authority(), request))
          .pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_source_reads`).length, 0);
    }).pipe(Effect.provide(live)),
  );
  it.effect("expires at exactly 75 seconds and a bounded sweep removes the locator", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* store.transact(store.requestHubSourceReadTx(authority(), request));
      yield* TestClock.adjust(75000);
      assert.deepStrictEqual(
        yield* store.transact(
          store.resultHubSourceReadTx(authority(), {
            protocolVersion: 1,
            memorySpaceId: space,
            requestId: request.requestId,
          }),
        ),
        { state: "expired", code: "source_unavailable" },
      );
      const cleanup = yield* store.transact(
        store.purgeHubTransientTx({
          memorySpaceId: space,
          now: Date.parse(first.request.expiresAtHubTime),
          limit: 1,
        }),
      );
      assert.strictEqual(cleanup.removedRows, 1);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_source_reads`).length, 0);
    }).pipe(Effect.provide(live)),
  );
});

describe("MemoryStore durable hub checkpoints", () => {
  const authority: Store.HubAuthority = {
    principal: {
      memorySpaceId: space,
      environmentId: env,
      credentialVersion: 1,
      scopes: ["memory:sync"],
    },
    now: Clock.currentTimeMillis,
    reauthorize: Effect.void,
  };
  const seed = Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${env},${"a".repeat(64)},1,'active',0)`;
    const op = operation(401);
    yield* store.transact(
      Effect.gen(function* () {
        const current = yield* store.loadAggregate(space, memory);
        const decision = decideMemoryOperation(
          current,
          op,
          Store.hubAdmission,
          scanMemoryValue(op),
        );
        const ledger = yield* store.appendHubEntryTx({
          operation: op,
          operationDigest: memoryOperationDigest(op),
          outcome: "accepted",
          now: 0,
        });
        yield* store.apply({ ...decision, receipt: ledger.entry.receipt });
      }),
    );
  });
  it.effect(
    "producer staging preserves the hub member token, immutable pages and TTL floor pin",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const handle = yield* store.transact(
          store.prepareHubCheckpointTx({
            authority,
            checkpointId: "member-initial",
            snapshotToken: "member-token",
            hubEnvironmentId: env,
          }),
        );
        yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: handle.checkpointId,
            expectedFloor: 0,
            nextFloor: 1,
            now: 0,
          }),
        );
        const initial = yield* store.transact(
          store.readHubCheckpointPageTx({
            authority,
            snapshotToken: handle.snapshotToken,
            cursor: null,
          }),
        );
        const guardBefore =
          yield* sql`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' ORDER BY key`;
        const memberBefore = yield* sql`SELECT * FROM memory_hub_members WHERE space=${space}`;
        const base = operation(402);
        if (base.kind === "forget") throw new Error("fixture");
        const op = decodeOperation({
          ...base,
          expectedHeads: [M.MemoryRevisionId.make(id(411))],
          revision: { ...base.revision, parents: [M.MemoryRevisionId.make(id(411))] },
        });
        yield* store.transact(
          Effect.gen(function* () {
            const next = yield* store.appendHubEntryTx({
              operation: op,
              operationDigest: memoryOperationDigest(op),
              outcome: "accepted",
              now: 0,
            });
            yield* store.apply({
              ...decideMemoryOperation(
                yield* store.loadAggregate(space, memory),
                op,
                Store.hubAdmission,
                { kind: "allowed" },
              ),
              receipt: next.entry.receipt,
            });
          }),
        );
        for (const name of ["producer-next", "producer-repeat"]) {
          yield* store.transact(
            Effect.gen(function* () {
              const staged = yield* store.prepareHubProducerCheckpointTx({
                authority,
                checkpointId: name,
                hubEnvironmentId: env,
              });
              assert.strictEqual(staged.checkpointSequence, 2);
              assert.isAbove(
                (yield* store.readHubUsageTx(space)).checkpointReservationConsumedBytes,
                0,
              );
              yield* store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: staged.checkpointId,
                expectedFloor: 1,
                nextFloor: 1,
                now: 0,
              });
              assert.strictEqual(
                (yield* store.readHubUsageTx(space)).checkpointReservationConsumedBytes,
                0,
              );
            }),
          );
          assert.deepStrictEqual(
            yield* store.transact(
              store.readHubCheckpointPageTx({
                authority,
                snapshotToken: handle.snapshotToken,
                cursor: null,
              }),
            ),
            initial,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' ORDER BY key`,
            guardBefore,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM memory_hub_members WHERE space=${space}`,
            memberBefore,
          );
        }
        const guard = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token'`;
        const parsed = JSON.parse(guard[0]!.record_json);
        assert.strictEqual(parsed.retired, false);
        assert.strictEqual(parsed.handle.firstIssuedAt, 0);
        assert.strictEqual(parsed.handle.expiresAt, M.MEMORY_CHECKPOINT_TOKEN_TTL_MS);
        assert.strictEqual(parsed.handle.credentialVersion, 1);
        assert.strictEqual(
          (yield* store
            .transact(
              store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: "producer-repeat",
                expectedFloor: 1,
                nextFloor: 2,
                now: 0,
              }),
            )
            .pipe(Effect.flip))._tag,
          "MemoryStoreConflict",
        );
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_TOKEN_TTL_MS);
        const expired = yield* store
          .transact(
            store.readHubCheckpointPageTx({
              authority,
              snapshotToken: handle.snapshotToken,
              cursor: null,
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(expired._tag, "MemoryHubError");
        if (expired._tag === "MemoryHubError") assert.strictEqual(expired.code, "cursor_expired");
        const advanced = yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: "producer-repeat",
            expectedFloor: 1,
            nextFloor: 2,
            now: M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
          }),
        );
        assert.strictEqual(advanced.retentionFloor, 2);
      }).pipe(Effect.provide(live)),
  );
  it.effect(
    "producer reauthenticates the real hub and rolls back capacity and outer publication failure",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const handle = yield* store.transact(
          store.prepareHubCheckpointTx({
            authority,
            checkpointId: "producer-safe",
            snapshotToken: "producer-safe-token",
            hubEnvironmentId: env,
          }),
        );
        yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: handle.checkpointId,
            expectedFloor: 0,
            nextFloor: 1,
            now: 0,
          }),
        );
        const preparation = { authority, checkpointId: "producer-failed", hubEnvironmentId: env };
        assert.strictEqual(
          (yield* store
            .transact(
              store.prepareHubProducerCheckpointTx({
                ...preparation,
                hubEnvironmentId: M.EnvironmentId.make("foreign-hub"),
              }),
            )
            .pipe(Effect.flip))._tag,
          "MemoryHubForbiddenError",
        );
        assert.strictEqual(
          (yield* store
            .transact(
              store.prepareHubProducerCheckpointTx({
                ...preparation,
                authority: {
                  ...authority,
                  reauthorize: Effect.fail(new M.MemoryHubUnauthorizedError({})),
                },
              }),
            )
            .pipe(Effect.flip))._tag,
          "MemoryHubUnauthorizedError",
        );
        const before = yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`;
        yield* store
          .transact(
            Effect.gen(function* () {
              const staged = yield* store.prepareHubProducerCheckpointTx(preparation);
              yield* store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: staged.checkpointId,
                expectedFloor: 1,
                nextFloor: 1,
                now: 0,
              });
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            }),
          )
          .pipe(Effect.flip);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`,
          before,
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:producer-failed'`)
            .length,
          0,
        );
        const usage = yield* store.transact(store.readHubUsageTx(space));
        yield* sql`UPDATE memory_hub_retention SET published_pinned_bytes=${M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - usage.requiredCheckpointBoundBytes} WHERE space=${space}`;
        const full = yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`;
        const guards =
          yield* sql`SELECT * FROM memory_import_keys WHERE key_kind='hub_checkpoint_token'`;
        const capacity = yield* store
          .transact(
            Effect.gen(function* () {
              const staged = yield* store.prepareHubProducerCheckpointTx(preparation);
              assert.strictEqual(
                (yield* store.readHubUsageTx(space)).stagingBytes,
                M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
              );
              yield* store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: staged.checkpointId,
                expectedFloor: 1,
                nextFloor: 1,
                now: 0,
              });
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(capacity._tag, "MemoryCapacityError");
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`,
          full,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM memory_import_keys WHERE key_kind='hub_checkpoint_token'`,
          guards,
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:producer-failed'`)
            .length,
          0,
        );
        assert.strictEqual(
          (yield* store.transact(
            store.readHubCheckpointPageTx({
              authority,
              snapshotToken: handle.snapshotToken,
              cursor: null,
            }),
          )).checkpointSequence,
          1,
        );
      }).pipe(Effect.provide(live)),
  );
  it.effect(
    "pins complete pages with immutable expiry and publishes recovery independently of token lifetime",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const preparation = {
          authority,
          checkpointId: "synthetic-cp-401",
          snapshotToken: "synthetic-token-401",
          hubEnvironmentId: env,
        };
        const handle = yield* store.transact(store.prepareHubCheckpointTx(preparation));
        yield* TestClock.adjust(1000);
        assert.deepStrictEqual(
          yield* store.transact(store.prepareHubCheckpointTx(preparation)),
          handle,
        );
        const page = yield* store.transact(
          store.readHubCheckpointPageTx({
            authority,
            snapshotToken: handle.snapshotToken,
            cursor: null,
          }),
        );
        assert.strictEqual(page.bootstrapComplete, true);
        assert.strictEqual(page.revisions[0]?.payload?.text, "synthetic searchable text");
        assert.strictEqual(M.validateMemoryCheckpointRecords([page]), true);
        const retention = yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: handle.checkpointId,
            expectedFloor: 0,
            nextFloor: 1,
            now: 1000,
          }),
        );
        assert.strictEqual(retention.retentionFloor, 1);
        yield* TestClock.adjust(599000);
        assert.strictEqual(
          (yield* store
            .transact(
              store.readHubCheckpointPageTx({
                authority,
                snapshotToken: handle.snapshotToken,
                cursor: null,
              }),
            )
            .pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE reason='hub_snapshot'`).length,
          1,
        );
        yield* store.transact(
          store.purgeHubTransientTx({ memorySpaceId: space, now: 600000, limit: 100 }),
        );
        assert.strictEqual(
          (yield* store.transact(store.prepareHubCheckpointTx(preparation)).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        assert.strictEqual(
          (yield* fresh.transact(fresh.prepareHubCheckpointTx(preparation)).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_compaction_state WHERE published=1`).length,
          1,
        );
        assert.strictEqual(
          (yield* store.transact(store.readHubUsageTx(space))).publishedPinnedBytes > 0,
          true,
        );
      }).pipe(Effect.provide(live)),
  );
  it.effect("never revives a replaced token even while its published pages survive", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const first = {
        authority,
        checkpointId: "token-replacement",
        snapshotToken: "old-token",
        hubEnvironmentId: env,
      };
      yield* store.transact(store.prepareHubCheckpointTx(first));
      yield* store.transact(
        store.publishCheckpointAndFloorTx({
          memorySpaceId: space,
          checkpointId: first.checkpointId,
          expectedFloor: 0,
          nextFloor: 1,
          now: 0,
        }),
      );
      yield* TestClock.adjust(1000);
      const replacement = yield* store.transact(
        store.prepareHubCheckpointTx({ ...first, snapshotToken: "new-token" }),
      );
      assert.strictEqual(replacement.firstIssuedAt, 1000);
      assert.strictEqual(
        (yield* store.transact(store.prepareHubCheckpointTx(first)).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      assert.strictEqual(
        (yield* store
          .transact(
            store.readHubCheckpointPageTx({
              authority,
              snapshotToken: first.snapshotToken,
              cursor: null,
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      assert.strictEqual(
        (yield* store.transact(
          store.readHubCheckpointPageTx({
            authority,
            snapshotToken: replacement.snapshotToken,
            cursor: null,
          }),
        )).checkpointSequence,
        1,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("forget scrubs a pinned snapshot immediately without changing its continuation", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const preparation = {
        authority,
        checkpointId: "synthetic-cp-402",
        snapshotToken: "synthetic-token-402",
        hubEnvironmentId: env,
      };
      const handle = yield* store.transact(store.prepareHubCheckpointTx(preparation));
      const before = yield* store.transact(
        store.readHubCheckpointPageTx({
          authority,
          snapshotToken: handle.snapshotToken,
          cursor: null,
        }),
      );
      const op = decodeOperation({
        protocolVersion: 1,
        kind: "forget",
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(402),
        originEnvironmentId: env,
        expectedHeads: [id(411)],
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(402),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.transact(
        Effect.gen(function* () {
          const decision = decideMemoryOperation(
            yield* store.loadAggregate(space, memory),
            op,
            Store.hubAdmission,
            scanMemoryValue(op),
          );
          const ledger = yield* store.appendHubEntryTx({
            operation: op,
            operationDigest: memoryOperationDigest(op),
            outcome: "deleted",
            now: 1,
          });
          yield* store.apply({ ...decision, receipt: ledger.entry.receipt });
        }),
      );
      const after = yield* store.transact(
        store.readHubCheckpointPageTx({
          authority,
          snapshotToken: handle.snapshotToken,
          cursor: null,
        }),
      );
      assert.strictEqual(after.pageOrdinal, before.pageOrdinal);
      assert.strictEqual(after.nextCursor, before.nextCursor);
      assert.strictEqual(after.checkpointSequence, before.checkpointSequence);
      assert.strictEqual(after.revisions[0]?.payload, null);
      assert.strictEqual(after.items[0]?.status, "blocked");
      assert.strictEqual(M.validateMemoryCheckpointRecords([after]), true);
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "floor publication rolls back and covered tail compaction preserves replay metadata",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const handle = yield* store.transact(
          store.prepareHubCheckpointTx({
            authority,
            checkpointId: "synthetic-cp-403",
            snapshotToken: "synthetic-token-403",
            hubEnvironmentId: env,
          }),
        );
        yield* store
          .transact(
            Effect.gen(function* () {
              yield* store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: handle.checkpointId,
                expectedFloor: 0,
                nextFloor: 1,
                now: 0,
              });
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(
          (yield* store.transact(store.readHubRetentionTx(space))).retentionFloor,
          0,
        );
        yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: handle.checkpointId,
            expectedFloor: 0,
            nextFloor: 1,
            now: 0,
          }),
        );
        const status = yield* store.transact(
          store.compactEligibleHistoryTx({
            memorySpaceId: space,
            expectedFloor: 1,
            now: 2592000000,
            limit: 1,
          }),
        );
        assert.strictEqual(status.removedRows, 1);
        assert.strictEqual(
          (yield* store.transact(store.readHubReceiptTx(space, operation(401).operationId)))?.entry
            .receipt.outcome,
          "accepted",
        );
        assert.strictEqual((yield* store.transact(store.readHubUsageTx(space))).tailRows, 0);
      }).pipe(Effect.provide(live)),
  );
});

const seedResolutionConflict = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${env},${hash},1,'active')`;
  const first = operation();
  if (first.kind !== "upsert") throw new Error("fixture");
  for (const op of [
    first,
    ...[4, 5].map((n) => {
      const next = operation(n);
      if (next.kind !== "upsert") throw new Error("fixture");
      return {
        ...next,
        expectedHeads: [first.revision.revisionId],
        revision: { ...next.revision, parents: [first.revision.revisionId] },
      };
    }),
  ]) {
    yield* store.apply(
      decideMemoryOperation(yield* store.loadAggregate(space, memory), op, Store.hubAdmission, {
        kind: "allowed",
      }),
    );
  }
  const aggregate = yield* store.loadAggregate(space, memory);
  return {
    store,
    sql,
    claim: {
      protocolVersion: 1 as const,
      memorySpaceId: space,
      memoryId: memory,
      holderEnvironmentId: env,
      conflictId: aggregate.conflicts[0]!.conflictId,
      conflictHeadSet: aggregate.heads,
      attemptId: M.MemoryOperationId.make(id(70)),
      frozenDefaultModelSelection: {
        instanceId: M.ProviderInstanceId.make("fixture"),
        model: "fixture",
      },
    },
  };
});
const leaseAuthority: Store.HubAuthority = {
  principal: {
    memorySpaceId: space,
    environmentId: env,
    credentialVersion: 1,
    scopes: ["memory:sync"],
  },
  now: Clock.currentTimeMillis,
  reauthorize: Effect.void,
};
it.effect("never reissues released invalidated or replaced attempts across restart", () =>
  Effect.gen(function* () {
    const { store, sql, claim } = yield* seedResolutionConflict;
    const first = yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "claim", request: claim },
      }),
    );
    if (!first || "released" in first) throw new Error("fixture");
    const release = { ...claim, fencingToken: first.fencingToken };
    yield* TestClock.adjust(10);
    yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "release", request: release },
      }),
    );
    const retry = () =>
      store
        .transact(
          store.transitionHubLeaseTx({
            authority: leaseAuthority,
            action: { kind: "claim", request: claim },
          }),
        )
        .pipe(Effect.flip);
    assert.strictEqual((yield* retry())._tag, "MemoryHubError");
    const secondClaim = { ...claim, attemptId: M.MemoryOperationId.make(id(71)) };
    const second = yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "claim", request: secondClaim },
      }),
    );
    if (!second || "released" in second) throw new Error("fixture");
    yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: {
          kind: "invalidate",
          memoryId: memory,
          expectedToken: second.fencingToken,
          reason: "heads",
        },
      }),
    );
    assert.strictEqual(
      (yield* store
        .transact(
          store.transitionHubLeaseTx({
            authority: leaseAuthority,
            action: { kind: "claim", request: secondClaim },
          }),
        )
        .pipe(Effect.flip))._tag,
      "MemoryHubError",
    );
    const thirdClaim = { ...claim, attemptId: M.MemoryOperationId.make(id(72)) };
    yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "claim", request: thirdClaim },
      }),
    );
    assert.strictEqual(
      (yield* Effect.gen(function* () {
        const restarted = yield* Store.MemoryStore;
        return yield* restarted
          .transact(
            restarted.transitionHubLeaseTx({
              authority: leaseAuthority,
              action: { kind: "claim", request: claim },
            }),
          )
          .pipe(Effect.flip);
      }).pipe(Effect.provide(Store.layer)))._tag,
      "MemoryHubError",
    );
    yield* TestClock.adjust(M.MEMORY_RESOLUTION_ATTEMPT_MAX_MS);
    assert.strictEqual((yield* retry())._tag, "MemoryHubError");
    const guards = yield* sql<{
      key: string;
      record_json: string;
    }>`SELECT key,record_json FROM memory_import_keys WHERE key_kind='hub_attempt' ORDER BY key`;
    assert.strictEqual(guards.length, 3);
    assert.strictEqual(JSON.parse(guards[0]!.record_json).deadline, 600000);
    assert.strictEqual(JSON.parse(guards[0]!.record_json).fencingToken, first.fencingToken);
  }).pipe(Effect.provide(live)),
);
it.effect("purges submission bodies in every ticket state and fences cancelled ownership", () =>
  Effect.gen(function* () {
    const { store, sql, claim } = yield* seedResolutionConflict;
    const ticket = yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "claim", request: claim },
      }),
    );
    if (!ticket || "released" in ticket) throw new Error("fixture");
    yield* store.persistResolutionTicket(ticket);
    const key = { memorySpaceId: space, attemptId: ticket.attemptId };
    const owner = yield* store.transact(
      store.acquireResolutionTicketTx({
        key,
        expectedVersion: 0,
        owner: "fixture",
        coordinatorEpoch: 1,
        now: 0,
        ownedUntil: 100,
      }),
    );
    const base = operation(80);
    if (base.kind !== "upsert" || !owner) throw new Error("fixture");
    const op = decodeOperation({
      ...base,
      kind: "resolve",
      expectedHeads: claim.conflictHeadSet,
      revision: { ...base.revision, parents: claim.conflictHeadSet },
      conflictId: claim.conflictId,
      fencingToken: ticket.fencingToken,
      payload: { ...base.payload, text: "synthetic submission body" },
      resolution: {
        resolutionId: id(81),
        memorySpaceId: space,
        memoryId: memory,
        inputRevisionIds: claim.conflictHeadSet,
        inputPayloadRefs: claim.conflictHeadSet,
        judgmentRef: id(81),
        requestedModelSelection: claim.frozenDefaultModelSelection,
        effectiveProvider: "codex",
        effectiveModel: "fixture",
        resolvingEnvironmentId: env,
        fencingToken: ticket.fencingToken,
        resultRevisionId: base.revision.revisionId,
        appliedAtUtc: now,
        revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
      },
      resolutionPayload: { resolutionId: id(81), judgment: "synthetic submission judgment" },
    });
    const submission = {
      protocolVersion: 1 as const,
      memorySpaceId: space,
      holderEnvironmentId: env,
      attemptId: ticket.attemptId,
      operation: op,
    };
    const ownership = { ...key, owner: "fixture", coordinatorEpoch: 1, version: owner.version };
    const written = yield* store.transact(
      store.persistResolutionSubmissionTx({
        ownership,
        submission,
        digest: memoryOperationDigest(op),
      }),
    );
    const recovered = yield* store.readRecoverableResolutionTickets({ now: 101, limit: 10 });
    assert.deepStrictEqual(recovered[0]?.submission, submission);
    const workId = `resolve:${space}:${ticket.attemptId}`;
    const before = yield* sql<{
      ticket_json: string;
    }>`SELECT ticket_json FROM memory_outbox WHERE id=${workId}`;
    assert.notInclude(before[0]!.ticket_json, "synthetic submission body");
    assert.notInclude(before[0]!.ticket_json, "synthetic submission judgment");
    for (const status of ["completed", "failed"]) {
      yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,ticket_json,sync_version,next_attempt_at) SELECT ${`${workId}:${status}`},space,memory_id,kind,${status},metadata_json,ticket_json,sync_version,0 FROM memory_outbox WHERE id=${workId}`;
    }
    const forgotten: M.MemoryOperation = {
      protocolVersion: 1,
      kind: "forget",
      memorySpaceId: space,
      memoryId: memory,
      operationId: M.MemoryOperationId.make(id(82)),
      originEnvironmentId: env,
      expectedHeads: [],
      tombstone: {
        memorySpaceId: space,
        memoryId: memory,
        deleteOperationId: M.MemoryOperationId.make(id(82)),
        deletingEnvironmentId: env,
        deletedAtUtc: M.MemoryUtcTimestamp.make(now),
        suppressedSourceKeys: [],
        suppressedContent: [],
        sourceExclusions: [],
      },
    };
    yield* store.apply(
      decideMemoryOperation(
        yield* store.loadAggregate(space, memory),
        forgotten,
        Store.hubAdmission,
        { kind: "allowed" },
      ),
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${memory}`).length,
      0,
    );
    const rows = yield* sql<{
      ticket_json: string;
    }>`SELECT ticket_json FROM memory_outbox WHERE kind='resolve'`;
    assert.strictEqual(rows.length, 3);
    for (const row of rows) {
      const value = JSON.parse(row.ticket_json);
      assert.isNull(value.submission);
      assert.isNull(value.owner);
      assert.strictEqual(value.state, "terminal");
      assert.isAbove(value.version, written.version);
    }
    assert.deepStrictEqual(
      yield* store.readRecoverableResolutionTickets({ now: 101, limit: 10 }),
      [],
    );
    assert.isNull(
      yield* store.transact(
        store.acquireResolutionTicketTx({
          key,
          expectedVersion: written.version,
          owner: "retry",
          coordinatorEpoch: 2,
          now: 101,
          ownedUntil: 200,
        }),
      ),
    );
    assert.strictEqual(
      (yield* store
        .transact(
          store.persistResolutionSubmissionTx({
            ownership: { ...ownership, version: written.version },
            submission,
            digest: memoryOperationDigest(op),
          }),
        )
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${memory}`).length,
      0,
    );
  }).pipe(Effect.provide(live)),
);

const seedSubmission = Effect.gen(function* () {
  const { store, sql, claim } = yield* seedResolutionConflict;
  const ticket = yield* store.transact(
    store.transitionHubLeaseTx({
      authority: leaseAuthority,
      action: { kind: "claim", request: claim },
    }),
  );
  if (!ticket || "released" in ticket) throw new Error("fixture");
  yield* store.persistResolutionTicket(ticket);
  const key = { memorySpaceId: space, attemptId: ticket.attemptId };
  const owner = yield* store.transact(
    store.acquireResolutionTicketTx({
      key,
      expectedVersion: 0,
      owner: "fixture",
      coordinatorEpoch: 1,
      now: 0,
      ownedUntil: 100,
    }),
  );
  const base = operation(80);
  if (base.kind !== "upsert" || !owner) throw new Error("fixture");
  const op = decodeOperation({
    ...base,
    kind: "resolve",
    expectedHeads: claim.conflictHeadSet,
    revision: { ...base.revision, parents: claim.conflictHeadSet },
    conflictId: claim.conflictId,
    fencingToken: ticket.fencingToken,
    payload: { ...base.payload, text: "synthetic submission body" },
    resolution: {
      resolutionId: id(81),
      memorySpaceId: space,
      memoryId: memory,
      inputRevisionIds: claim.conflictHeadSet,
      inputPayloadRefs: claim.conflictHeadSet,
      judgmentRef: id(81),
      requestedModelSelection: claim.frozenDefaultModelSelection,
      effectiveProvider: "codex",
      effectiveModel: "fixture",
      resolvingEnvironmentId: env,
      fencingToken: ticket.fencingToken,
      resultRevisionId: base.revision.revisionId,
      appliedAtUtc: now,
      revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
    },
    resolutionPayload: { resolutionId: id(81), judgment: "synthetic submission judgment" },
  });
  const submission = {
    protocolVersion: 1 as const,
    memorySpaceId: space,
    holderEnvironmentId: env,
    attemptId: ticket.attemptId,
    operation: op,
  };
  const ownership = { ...key, owner: "fixture", coordinatorEpoch: 1, version: owner.version };
  return { store, sql, ticket, key, ownership, submission };
});

it.effect("rejects mismatched ticket identities before saving a submission and on recovery", () =>
  Effect.gen(function* () {
    const { store, sql, key, ownership, submission } = yield* seedSubmission;
    const base = submission.operation;
    if (base.kind !== "resolve") throw new Error("fixture");
    for (const op of [
      {
        ...base,
        memoryId: M.MemoryId.make(id(950)),
        revision: { ...base.revision, memoryId: M.MemoryId.make(id(950)) },
        resolution: { ...base.resolution, memoryId: M.MemoryId.make(id(950)) },
      },
      { ...base, conflictId: M.MemoryConflictId.make(id(951)) },
      {
        ...base,
        fencingToken: base.fencingToken + 1,
        resolution: { ...base.resolution, fencingToken: base.fencingToken + 1 },
      },
    ]) {
      const failure = yield* store
        .transact(
          store.persistResolutionSubmissionTx({
            ownership,
            submission: { ...submission, operation: op },
            digest: memoryOperationDigest(op),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryStoreConflict");
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'submission:%'`).length,
        0,
      );
    }
    yield* store.transact(
      store.persistResolutionSubmissionTx({
        ownership,
        submission,
        digest: memoryOperationDigest(base),
      }),
    );
    const workId = `resolve:${space}:${key.attemptId}`;
    yield* sql`UPDATE memory_outbox SET ticket_json=json_set(ticket_json,'$.ticket.memoryId',${id(950)}) WHERE id=${workId}`;
    const failure = yield* store
      .readRecoverableResolutionTickets({ now: 101, limit: 10 })
      .pipe(Effect.flip);
    assert.strictEqual(failure.stage, "ticket-payload-identity");
  }).pipe(Effect.provide(live)),
);

it.effect.each(["completed", "failed", "cancelled", "transition"] as const)(
  "clears terminal submission atomically while protecting uncertain recovery: %s",
  (status) =>
    Effect.gen(function* () {
      const { store, sql, key, ownership, submission } = yield* seedSubmission;
      const written = yield* store.transact(
        store.persistResolutionSubmissionTx({
          ownership,
          submission,
          digest: memoryOperationDigest(submission.operation),
        }),
      );
      const deadline = Date.parse(
        submission.operation.kind === "resolve"
          ? submission.operation.resolution.revertDeadlineUtc
          : now,
      );
      yield* store.prunePayloads(deadline + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS, 100);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'submission:%'`).length,
        1,
      );
      assert.deepStrictEqual(
        (yield* store.readRecoverableResolutionTickets({ now: 101, limit: 10 }))[0]?.submission,
        submission,
      );
      const workId = `resolve:${space}:${key.attemptId}`;
      const finish = Effect.gen(function* () {
        return yield* status === "transition"
          ? store.transact(
              store.transitionResolutionTicketTx({
                ownership: { ...ownership, version: written.version },
                nextState: "terminal",
                now: 1,
                ownedUntil: null,
                nextAttemptAt: 1,
              }),
            )
          : store.finishWork(workId, status).pipe(Effect.as(null));
      });
      yield* store
        .transact(
          finish.pipe(
            Effect.andThen(
              Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" })),
            ),
          ),
        )
        .pipe(Effect.flip);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'submission:%'`).length,
        1,
      );
      yield* finish;
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'submission:%'`).length,
        0,
      );
      assert.deepStrictEqual(
        yield* store.readRecoverableResolutionTickets({ now: 101, limit: 10 }),
        [],
      );
      const rows = yield* sql<{
        ticket_json: string;
      }>`SELECT ticket_json FROM memory_outbox WHERE id=${workId}`;
      const terminal = JSON.parse(rows[0]!.ticket_json);
      assert.isNull(terminal.submission);
      assert.isNull(terminal.owner);
      assert.isAbove(terminal.version, written.version);
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(
        yield* fresh.readRecoverableResolutionTickets({ now: 101, limit: 10 }),
        [],
      );
    }).pipe(Effect.provide(live)),
);

it.effect.each([0, 1])(
  "enforces global metadata equality plus %s across spaces without leaking failed writes",
  (extra) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const record: Store.AdminRecord = {
        requestId: M.MemoryOperationId.make(id(971)),
        requestDigest: hash,
        expectedVersion: 0,
        stage: "prepared",
        action: {
          action: "configure",
          requestId: M.MemoryOperationId.make(id(971)),
          expectedVersion: 0,
          settings: { mode: "hub", memorySpaceId: space },
        },
        secretName: null,
        result: null,
        memberVersion: null,
      };
      // Measure the real write's encoded delta under rollback, then reserve the rest in another space.
      let delta = 0;
      yield* store
        .transact(
          Effect.gen(function* () {
            const before = yield* sql<{
              value: number;
            }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='hub_metadata'`;
            yield* store.writeHubAdminTx({ record, expectedStage: null });
            const after = yield* sql<{
              value: number;
            }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='hub_metadata'`;
            delta = after[0]!.value - before[0]!.value;
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          }),
        )
        .pipe(Effect.flip);
      assert.isAbove(delta, 0);
      const filler = M.MEMORY_PERMANENT_METADATA_MAX_BYTES - delta - 2 + extra;
      // Private retention detail isolates the metadata cap from required snapshot inputs.
      yield* sql`INSERT INTO memory_hub_retention(space,compaction_json) VALUES ('other',${"x".repeat(filler)})`;
      if (extra) {
        const failure = yield* store
          .transact(store.writeHubAdminTx({ record, expectedStage: null }))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryCapacityError");
        assert.isUndefined(yield* store.transact(store.readHubAdminTx(record.requestId)));
      } else {
        yield* store.transact(store.writeHubAdminTx({ record, expectedStage: null }));
        assert.isDefined(yield* store.transact(store.readHubAdminTx(record.requestId)));
      }
      const counters = yield* sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='hub_metadata'`;
      assert.strictEqual(
        counters[0]!.value,
        M.MEMORY_PERMANENT_METADATA_MAX_BYTES + extra - (extra ? delta : 0),
      );
    }).pipe(Effect.provide(live)),
);

it.effect.each(["current", "replaced-compactor", "replaced-prune"] as const)(
  "protects revert inputs and collects expired canonical judgment with %s result",
  (mode) =>
    Effect.gen(function* () {
      const { store, sql, ticket, submission } = yield* seedSubmission;
      for (const n of [3, 4, 5]) {
        const op = yield* store.readOperation(space, M.MemoryOperationId.make(id(n)));
        if (!op) throw new Error("fixture");
        const ledger = yield* store.transact(
          store.appendHubEntryTx({
            operation: op,
            operationDigest: memoryOperationDigest(op),
            outcome: n === 5 ? "conflicted" : "accepted",
            now: 0,
          }),
        );
        yield* store.apply({
          ...decideMemoryOperation(
            yield* store.loadAggregate(space, memory),
            op,
            Store.hubAdmission,
            { kind: "allowed" },
          ),
          receipt: ledger.entry.receipt,
        });
      }
      const op = submission.operation;
      if (op.kind !== "resolve") throw new Error("fixture");
      const appliedAt = Date.parse(op.resolution.appliedAtUtc);
      const expiresAt = Date.parse(op.resolution.revertDeadlineUtc);
      const ledger = yield* store.transact(
        store.appendHubEntryTx({
          operation: op,
          operationDigest: memoryOperationDigest(op),
          outcome: "accepted",
          resolutionApproval: {
            resolutionId: op.resolution.resolutionId,
            appliedAtUtc: op.resolution.appliedAtUtc,
            revertDeadlineUtc: op.resolution.revertDeadlineUtc,
          },
          now: appliedAt,
        }),
      );
      yield* store.apply({
        ...decideMemoryOperation(
          yield* store.loadAggregate(space, memory),
          op,
          Store.hubAdmission,
          { kind: "allowed" },
          undefined,
          undefined,
          0,
        ),
        receipt: ledger.entry.receipt,
        execution: {
          requestedModelSelection: op.resolution.requestedModelSelection,
          effectiveProvider: op.resolution.effectiveProvider,
          effectiveModel: op.resolution.effectiveModel,
          providerInstanceId: op.resolution.requestedModelSelection.instanceId,
          environmentId: env,
        },
      });
      const resolvedConflict = yield* sql<{
        status: string;
      }>`SELECT status FROM memory_conflicts WHERE conflict_id=${op.conflictId}`;
      assert.strictEqual(resolvedConflict[0]!.status, "resolved");
      const report = (yield* store.pendingReports(100))[0]!;
      yield* store.acknowledgeReport({
        ...report,
        state: "delivered",
        reportThread: { environmentId: env, threadId: M.ThreadId.make("history-report") },
        sequence: 1,
      });
      yield* store.finishWork(
        `resolve:${space}:${ticket.attemptId}`,
        "completed",
        ledger.entry.receipt,
      );
      for (const candidate of yield* store.readDueClaimCandidates(100, 0))
        yield* store.completeClaimCandidate(candidate.id);
      const publish = (name: string, at: number, floor: number) =>
        store.transact(
          Effect.gen(function* () {
            const handle = yield* store.prepareHubCheckpointTx({
              authority: { ...leaseAuthority, now: Effect.succeed(at) },
              checkpointId: name,
              snapshotToken: name,
              hubEnvironmentId: env,
            });
            yield* store.publishCheckpointAndFloorTx({
              memorySpaceId: space,
              checkpointId: name,
              expectedFloor: floor,
              nextFloor: handle.checkpointSequence,
              now: at,
            });
            return handle.checkpointSequence;
          }),
        );
      const floor = yield* publish("revert-protected", expiresAt - 1, 0);
      const publishedRows = yield* sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_inbox_pending WHERE space=${space} AND checkpoint_id='hub:revert-protected' ORDER BY page_ordinal`;
      const produced = yield* Effect.forEach(publishedRows, (row) =>
        decodeCheckpointPage(row.metadata_json),
      );
      assert.isTrue(M.validateMemoryCheckpointRecords(produced));
      assert.isAtMost(
        (yield* store.transact(store.readHubUsageTx(space))).lastSnapshotBytes,
        (yield* store.transact(store.readHubUsageTx(space))).requiredCheckpointBoundBytes,
      );
      const resolveGuard = produced
        .flatMap((page) => page.compactReceipts)
        .find((record) => record.receipt.operationId === op.operationId);
      assert.strictEqual(resolveGuard?.reportGuard?.resolvingEnvironmentId, env);
      assert.strictEqual(produced.flatMap((page) => page.resolutions).length, 1);
      yield* TestClock.adjust(expiresAt - 1);
      assert.strictEqual(
        (yield* store.transact(store.readHubInventoryTx(space))).reclaimable.history,
        0,
      );

      yield* store.transact(
        store.compactEligibleHistoryTx({
          memorySpaceId: space,
          expectedFloor: floor,
          now: expiresAt - 1,
          limit: 100,
        }),
      );
      for (const revisionId of op.resolution.inputRevisionIds)
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_revisions r JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref WHERE r.space=${space} AND r.revision_id=${revisionId}`)
            .length,
          1,
        );
      if (mode !== "current") {
        const base = operation(996);
        if (base.kind === "forget") throw new Error("fixture");
        const successor = decodeOperation({
          ...base,
          expectedHeads: [op.revision.revisionId],
          revision: { ...base.revision, parents: [op.revision.revisionId] },
        });
        const next = yield* store.transact(
          store.appendHubEntryTx({
            operation: successor,
            operationDigest: memoryOperationDigest(successor),
            outcome: "accepted",
            now: expiresAt,
          }),
        );
        yield* store.apply({
          ...decideMemoryOperation(
            yield* store.loadAggregate(space, memory),
            successor,
            Store.hubAdmission,
            { kind: "allowed" },
          ),
          receipt: next.entry.receipt,
        });
        // Work protects the judgment across one bounded sweep, without pinning the superseded result.
        yield* store.enqueueWork({
          ...backgroundWork("judgment:protected"),
          payloadRef: op.resolution.judgmentRef,
        });
      }
      const nextFloor = yield* publish(
        "revert-expired",
        expiresAt + M.MEMORY_LOG_RETENTION_MS + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
        floor,
      );
      yield* store.transact(
        store.purgeHubTransientTx({
          memorySpaceId: space,
          now: expiresAt + M.MEMORY_LOG_RETENTION_MS + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
          limit: 100,
        }),
      );
      yield* store.transact(
        store.compactEligibleHistoryTx({
          memorySpaceId: space,
          expectedFloor: nextFloor,
          now: expiresAt + M.MEMORY_LOG_RETENTION_MS + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
          limit: 100,
        }),
      );
      if (mode !== "current") {
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_revisions WHERE space=${space} AND revision_id=${op.revision.revisionId}`)
            .length,
          0,
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND payload_ref=${op.resolution.judgmentRef}`)
            .length,
          1,
        );
        yield* store.finishWork("judgment:protected", "completed");
        const sweepAt = expiresAt + M.MEMORY_LOG_RETENTION_MS + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS;
        if (mode === "replaced-prune") {
          yield* sql`UPDATE memory_payloads SET purge_eligible_after=${sweepAt} WHERE space=${space} AND payload_ref=${op.resolution.judgmentRef}`;
          yield* store.prunePayloads(sweepAt, 100);
        } else {
          yield* store.transact(
            store.compactEligibleHistoryTx({
              memorySpaceId: space,
              expectedFloor: nextFloor,
              now: sweepAt,
              limit: 100,
            }),
          );
        }
      }
      for (const revisionId of op.resolution.inputRevisionIds)
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_revisions WHERE space=${space} AND revision_id=${revisionId}`)
            .length,
          0,
        );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${op.resolution.judgmentRef}`)
          .length,
        0,
      );
      assert.strictEqual((yield* store.loadAggregate(space, memory)).item?.status, "active");
      assert.strictEqual(
        (yield* store.receipt(space, op.operationId))?.receipt.outcome,
        "accepted",
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_report_outbox WHERE state='delivered'`).length,
        0,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_import_keys WHERE key_kind='report_delivered'`).length,
        1,
      );
      const replay = yield* store.transact(store.readHubReceiptTx(space, op.operationId));
      if (replay?.entry.kind !== "metadata" || !replay.entry.compactReceipt)
        throw new Error("fixture");
      assert.isFalse(
        (yield* store.transact(
          store.reconcileResolutionReportTx({
            record: replay.entry.compactReceipt,
            localEnvironmentId: env,
          }),
        )).deliverable,
      );
      assert.strictEqual((yield* store.pendingReports(100)).length, 0);
      assert.strictEqual(ticket.fencingToken, 1);
    }).pipe(Effect.provide(live)),
);

it.effect(
  "shares required and pinned checkpoint reservation across spaces at equality and rejects plus one",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const other = M.MemorySpaceId.make(id(979));
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - 4097,
          publishedPinnedDeltaBytes: 0,
        }),
      );
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: other,
          checkpointDeltaBytes: 0,
          publishedPinnedDeltaBytes: 1,
        }),
      );
      const failed = yield* store
        .transact(
          store.reserveHubCheckpointTx({
            memorySpaceId: other,
            checkpointDeltaBytes: 4097,
            publishedPinnedDeltaBytes: 0,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failed._tag, "MemoryCapacityError");
      assert.strictEqual((yield* store.transact(store.readHubUsageTx(other))).checkpointBytes, 0);
      const counters = yield* sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='hub_checkpoint'`;
      assert.strictEqual(counters[0]!.value, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - 4096);
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: -1,
          publishedPinnedDeltaBytes: 0,
        }),
      );
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: other,
          checkpointDeltaBytes: 4097,
          publishedPinnedDeltaBytes: 0,
        }),
      );
    }).pipe(Effect.provide(live)),
);

it.effect("reserves snapshot growth atomically at pinned equality and rejects one extra byte", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const op = operation(981);
    const append = store.appendHubEntryTx({
      operation: op,
      operationDigest: memoryOperationDigest(op),
      outcome: "rejected",
      failureCode: "identity_mismatch",
      now: 0,
    });
    const base = yield* store.transact(store.readHubUsageTx(space));
    const growth = yield* store
      .transact(
        Effect.gen(function* () {
          yield* append;
          const after = yield* store.readHubUsageTx(space);
          return yield* Effect.fail(
            after.requiredCheckpointBoundBytes - base.requiredCheckpointBoundBytes,
          );
        }),
      )
      .pipe(Effect.flip);
    if (typeof growth !== "number") throw new Error("fixture growth failed");
    assert.isAbove(growth, 0);
    const pins = M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - base.requiredCheckpointBoundBytes - growth;
    yield* store.transact(
      store.reserveHubCheckpointTx({
        memorySpaceId: space,
        checkpointDeltaBytes: 0,
        publishedPinnedDeltaBytes: pins + 1,
      }),
    );
    const failed = yield* store.transact(append).pipe(Effect.flip);
    assert.strictEqual(failed._tag, "MemoryCapacityError");
    assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_operations`).length, 0);
    assert.strictEqual(
      (yield* store.transact(store.readHubUsageTx(space))).requiredCheckpointBoundBytes,
      base.requiredCheckpointBoundBytes,
    );
    yield* store.transact(
      store.reserveHubCheckpointTx({
        memorySpaceId: space,
        checkpointDeltaBytes: 0,
        publishedPinnedDeltaBytes: -1,
      }),
    );
    yield* store.transact(append);
    assert.strictEqual(
      (yield* store.transact(store.readHubUsageTx(space))).stagingBytes,
      M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
    );
    const replay = yield* store.transact(append);
    assert.strictEqual(replay.entry.kind, "metadata");
  }).pipe(Effect.provide(live)),
);

it.effect.each(["refusal", "forget", "escaped", "pages"] as const)(
  "producer round-trips %s checkpoint and its encoded pages fit the counter bound",
  (shape) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${env},${hash},1,'active')`;
      const first = operation(990);
      const op: M.MemoryOperation =
        shape === "forget"
          ? {
              protocolVersion: 1,
              memorySpaceId: space,
              memoryId: memory,
              operationId: first.operationId,
              originEnvironmentId: env,
              expectedHeads: [],
              kind: "forget",
              tombstone: {
                memorySpaceId: space,
                memoryId: memory,
                deleteOperationId: first.operationId,
                deletingEnvironmentId: env,
                deletedAtUtc: M.MemoryUtcTimestamp.make(now),
                suppressedSourceKeys: Array.from({ length: 20 }, (_, n) => ({
                  environmentId: env,
                  sourceId: M.MemoryImportSourceId.make(id(1700)),
                  sourceItemKey: `${"k".repeat(480)}${n}`,
                })),
                suppressedContent: [],
                sourceExclusions: [],
              },
            }
          : shape === "escaped" && first.kind === "upsert"
            ? {
                ...first,
                payload: { ...first.payload, text: "\u0000".repeat(10000) },
              }
            : first;
      yield* store.transact(
        Effect.gen(function* () {
          const ledger = yield* store.appendHubEntryTx({
            operation: op,
            operationDigest: memoryOperationDigest(op),
            outcome:
              shape === "refusal" || shape === "pages"
                ? "rejected"
                : shape === "forget"
                  ? "deleted"
                  : "accepted",
            ...(shape === "refusal" || shape === "pages"
              ? { failureCode: "identity_mismatch" as const }
              : {}),
            now: 0,
          });
          if (shape !== "refusal" && shape !== "pages") {
            const decided = decideMemoryOperation(
              yield* store.loadAggregate(space, memory),
              op,
              Store.hubAdmission,
              scanMemoryValue(op),
            );
            yield* store.apply({ ...decided, receipt: ledger.entry.receipt });
          } else {
            assert.strictEqual(ledger.entry.kind, "metadata");
            if (ledger.entry.kind === "metadata") assert.isDefined(ledger.entry.compactReceipt);
          }
        }),
      );
      if (shape === "pages") {
        for (let n = 0; n < 105; n++) {
          const rejected = operation(1100 + n);
          yield* store.transact(
            store.appendHubEntryTx({
              operation: rejected,
              operationDigest: memoryOperationDigest(rejected),
              outcome: "rejected",
              failureCode: "identity_mismatch",
              now: 0,
            }),
          );
        }
      }
      const authority: Store.HubAuthority = {
        principal: {
          memorySpaceId: space,
          environmentId: env,
          credentialVersion: 1,
          scopes: ["memory:sync"],
        },
        now: Clock.currentTimeMillis,
        reauthorize: Effect.void,
      };
      const handle = yield* store.transact(
        store.prepareHubCheckpointTx({
          authority,
          checkpointId: `shape-${shape}`,
          snapshotToken: `token-${shape}`,
          hubEnvironmentId: env,
        }),
      );
      const pages: M.MemoryHubCheckpointPage[] = [];
      let cursor: M.MemoryHubCheckpointPage["nextCursor"] = null;
      for (let i = 0; i < handle.pageCount; i++) {
        const page: M.MemoryHubCheckpointPage = yield* store.transact(
          store.readHubCheckpointPageTx({
            authority,
            snapshotToken: handle.snapshotToken,
            cursor,
          }),
        );
        const json = yield* encodeCheckpointPage(page);
        pages.push(yield* decodeCheckpointPage(json));
        cursor = page.nextCursor;
      }
      assert.isTrue(M.validateMemoryCheckpointRecords(pages));
      const usage = yield* store.transact(store.readHubUsageTx(space));
      assert.isAtMost(usage.lastSnapshotBytes, usage.requiredCheckpointBoundBytes);
      assert.strictEqual(
        pages.flatMap((p) => p.compactReceipts).length,
        shape === "pages" ? 106 : 1,
      );
      if (shape === "pages") assert.isAbove(handle.pageCount, 1);
      if (shape === "escaped") assert.isAbove(usage.lastSnapshotBytes, 100000);
      assert.strictEqual(
        pages.flatMap((p) => p.identities).length,
        shape === "refusal" || shape === "pages" ? 0 : 1,
      );
      if (shape === "forget") {
        assert.strictEqual(pages.flatMap((p) => p.tombstones).length, 1);
        assert.strictEqual(pages.flatMap((p) => p.suppressions).length, 20);
      }
      const replay = yield* store.transact(store.readHubReceiptTx(space, op.operationId));
      assert.strictEqual(
        replay?.entry.receipt.outcome,
        shape === "refusal" || shape === "pages"
          ? "rejected"
          : shape === "forget"
            ? "deleted"
            : "accepted",
      );
    }).pipe(Effect.provide(live)),
);

it.effect(
  "compacts acknowledged admin after thirty days into an immutable replay and secret-name guard",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const first: Store.AdminRecord = {
        requestId: M.MemoryOperationId.make(id(995)),
        requestDigest: hash,
        expectedVersion: 0,
        stage: "prepared",
        action: {
          action: "configure",
          requestId: M.MemoryOperationId.make(id(995)),
          expectedVersion: 0,
          settings: { mode: "disabled" },
        },
        secretName: "synthetic-secret-name",
        result: null,
        memberVersion: null,
      };
      yield* store.transact(store.writeHubAdminTx({ record: first, expectedStage: null }));
      yield* store.transact(
        store.writeHubAdminTx({
          record: { ...first, stage: "activated" },
          expectedStage: "prepared",
        }),
      );
      const ready: Store.AdminRecord = {
        ...first,
        stage: "ready",
        result: { view: { settings: { mode: "disabled" }, version: 1 } },
      };
      yield* store.transact(store.writeHubAdminTx({ record: ready, expectedStage: "activated" }));
      const terminal = yield* store.transact(
        store.writeHubAdminTx({
          record: { ...ready, stage: "acknowledged" },
          expectedStage: "ready",
        }),
      );
      const reservedCounters = yield* sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space='_hub_global' AND dimension IN ('hub_receipts','hub_keys') ORDER BY dimension`;
      assert.deepStrictEqual(reservedCounters, [
        { dimension: "hub_keys", value: 1 },
        { dimension: "hub_receipts", value: 1 },
      ]);
      yield* store.transact(
        store.purgeHubTransientTx({
          memorySpaceId: space,
          now: M.MEMORY_LOG_RETENTION_MS - 1,
          limit: 100,
        }),
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin'`).length, 1);
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* store.purgeHubTransientTx({
              memorySpaceId: space,
              now: M.MEMORY_LOG_RETENTION_MS,
              limit: 100,
            });
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin'`).length, 1);
      yield* store.transact(
        store.purgeHubTransientTx({
          memorySpaceId: space,
          now: M.MEMORY_LOG_RETENTION_MS,
          limit: 100,
        }),
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin'`).length, 0);
      assert.deepStrictEqual(
        yield* sql`SELECT dimension,value FROM memory_quota_counters WHERE space='_hub_global' AND dimension IN ('hub_receipts','hub_keys') ORDER BY dimension`,
        reservedCounters,
      );
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      const guard = yield* fresh.transact(fresh.readHubAdminTx(first.requestId));
      assert.isDefined(guard);
      assert.isFalse(guard !== undefined && "action" in guard);
      assert.strictEqual(guard?.secretName, first.secretName);
      assert.deepStrictEqual(guard?.result, terminal.result);
      assert.deepStrictEqual(
        yield* fresh.transact(fresh.writeHubAdminTx({ record: first, expectedStage: null })),
        terminal,
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin'`).length, 0);
      const mismatch = yield* fresh
        .transact(
          fresh.writeHubAdminTx({
            record: { ...first, secretName: "different-secret" },
            expectedStage: null,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(mismatch._tag, "MemoryStoreConflict");
    }).pipe(Effect.provide(live)),
);

it.effect("keeps the successor frontier and exposure on body-free canonical metadata replay", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const first = operation();
    const second = childOperation();
    if (first.kind === "forget" || second.kind === "forget") throw new Error("fixture");
    for (const [index, op] of [first, second].entries()) {
      const approval: M.MemoryHubReceipt = {
        operationId: op.operationId,
        memoryId: memory,
        operationDigest: memoryOperationDigest(op),
        outcome: "accepted",
        hubSequence: index + 1,
      };
      yield* store.apply(
        decideMemoryOperation(
          yield* store.loadAggregate(space, memory),
          op,
          Store.approvedReplica,
          { kind: "allowed" },
          approval,
        ),
      );
    }
    const scanner = (yield* store.readDeferred(0, 100)).find((row) => row.kind === "scanner")!;
    assert.isDefined(scanner);
    const scanned = yield* store.readScannerChunk(scanner);
    assert.isNull(scanned.nextCursor);
    assert.strictEqual(scanMemoryValue({ payloads: scanned.payloads }).kind, "allowed");
    assert.isTrue(yield* store.claimDeferred(scanner, "replay-scanner", 0, 1000));
    assert.isTrue(
      yield* store.finishOwnedDeferred(scanner, "replay-scanner", 1000, {
        now: 0,
        scannerPolicyVersion: 1,
      }),
    );
    const before = yield* store.loadAggregate(space, memory);
    assert.deepStrictEqual(before.heads, [second.revision.revisionId]);
    assert.strictEqual(before.item?.localAvailability.exposure, "visible");
    yield* sql`DELETE FROM memory_payloads WHERE space=${space} AND payload_ref=${first.revision.payloadRef}`;
    const receipt = (yield* store.receipt(space, first.operationId))!.receipt;
    if (!("hubSequence" in receipt) || receipt.hubSequence === null) throw new Error("fixture");
    yield* store.transact(
      store.settleMetadataEntryTx({
        memorySpaceId: space,
        entry: {
          kind: "metadata",
          operationKind: "upsert",
          memoryId: memory,
          hubSequence: 1,
          receipt,
          revision: first.revision,
        },
      }),
    );
    const after = yield* store.loadAggregate(space, memory);
    assert.deepStrictEqual(after.heads, [second.revision.revisionId]);
    assert.deepStrictEqual(after.item, before.item);
  }).pipe(Effect.provide(live)),
);

it.effect(
  "finds activated admin beyond a saturated ready list and excludes acknowledged records",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const make = (n: number): Store.AdminRecord => ({
        requestId: M.MemoryOperationId.make(id(n)),
        requestDigest: hash,
        expectedVersion: 0,
        stage: "prepared",
        action: {
          action: "configure",
          requestId: M.MemoryOperationId.make(id(n)),
          expectedVersion: 0,
          settings: { mode: "disabled" },
        },
        secretName: null,
        memberVersion: null,
        result: null,
      });
      assert.isUndefined(yield* store.transact(store.readActivatedHubAdminTx()));
      for (let n = 0; n <= M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS; n++) {
        const record = make(2000 + n);
        yield* store.transact(store.writeHubAdminTx({ record, expectedStage: null }));
        yield* store.transact(
          store.writeHubAdminTx({
            record: { ...record, stage: "activated" },
            expectedStage: "prepared",
          }),
        );
        const ready: Store.AdminRecord = {
          ...record,
          stage: "ready",
          result: { view: { settings: { mode: "disabled" }, version: 1 } },
        };
        yield* store.transact(store.writeHubAdminTx({ record: ready, expectedStage: "activated" }));
        if (n === 0)
          yield* store.transact(
            store.writeHubAdminTx({
              record: { ...ready, stage: "acknowledged" },
              expectedStage: "ready",
            }),
          );
      }
      assert.isUndefined(yield* store.transact(store.readActivatedHubAdminTx()));
      const prepared = make(3000);
      yield* store.transact(store.writeHubAdminTx({ record: prepared, expectedStage: null }));
      const target = make(4000);
      yield* store.transact(store.writeHubAdminTx({ record: target, expectedStage: null }));
      const activated: Store.AdminRecord = { ...target, stage: "activated" };
      yield* store.transact(
        store.writeHubAdminTx({ record: activated, expectedStage: "prepared" }),
      );
      assert.isFalse(
        (yield* store.readPendingHubAdmins(M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)).some(
          (r) => r.requestId === activated.requestId,
        ),
      );
      assert.deepStrictEqual(yield* store.transact(store.readActivatedHubAdminTx()), activated);
      const fresh = yield* Effect.service(Store.MemoryStore).pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(yield* fresh.transact(fresh.readActivatedHubAdminTx()), activated);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin' AND json_extract(admin_json,'$.stage')='acknowledged'`)
          .length,
        1,
      );
    }).pipe(Effect.provide(live)),
);

it.effect(
  "recovery preserves current frontier tickets while cancelling stale tickets and discovering unrelated claims",
  () =>
    Effect.gen(function* () {
      const { store, sql, ticket, key, ownership, submission } = yield* seedSubmission;
      yield* store.transact(
        store.persistResolutionSubmissionTx({
          ownership,
          submission,
          digest: memoryOperationDigest(submission.operation),
        }),
      );
      // A second memory becomes quarantined while the first submission is in flight.
      const other = M.MemoryId.make(id(980));
      const aggregate = yield* store.loadAggregate(space, memory);
      if (aggregate.item?.status !== "quarantined") throw new Error("fixture");
      const item = {
        ...aggregate.item,
        memoryId: other,
        conflict: { ...aggregate.item.conflict, memoryId: other },
      };
      yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) SELECT space,${other},scope_json,scope_key,heads_json,status,projection_watermark,${JSON.stringify(item)},availability_json FROM memory_items WHERE space=${space} AND memory_id=${memory}`;
      yield* store.recoverClaimCandidates(0);
      const rows = yield* sql<{
        status: string;
        ticket_json: string;
      }>`SELECT status,ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      assert.strictEqual(rows[0]!.status, "pending");
      assert.strictEqual(JSON.parse(rows[0]!.ticket_json).state, "submitting");
      assert.isNotNull(JSON.parse(rows[0]!.ticket_json).submission);
      assert.isTrue(
        (yield* store.readDueClaimCandidates(100, 0)).some((c) => c.memoryId === other),
      );
      const changed = {
        ...aggregate.item,
        conflict: {
          ...aggregate.item.conflict,
          heads: [M.MemoryRevisionId.make(id(981)), M.MemoryRevisionId.make(id(982))],
        },
      };
      yield* sql`UPDATE memory_items SET item_json=${JSON.stringify(changed)},heads_json=${JSON.stringify(changed.conflict.heads)} WHERE space=${space} AND memory_id=${memory}`;
      yield* store.recoverClaimCandidates(1);
      const stale = yield* sql<{
        status: string;
        ticket_json: string;
      }>`SELECT status,ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      assert.strictEqual(stale[0]!.status, "cancelled");
      const terminal = JSON.parse(stale[0]!.ticket_json);
      assert.strictEqual(terminal.state, "terminal");
      assert.isNull(terminal.owner);
      assert.isNull(terminal.submission);
      assert.isNull(
        yield* store.transact(
          store.acquireResolutionTicketTx({
            key,
            expectedVersion: terminal.version,
            owner: "late",
            coordinatorEpoch: 2,
            now: 101,
            ownedUntil: 200,
          }),
        ),
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND payload_ref=${`submission:${ticket.attemptId}`}`)
          .length,
        0,
      );
    }).pipe(Effect.provide(live)),
);
