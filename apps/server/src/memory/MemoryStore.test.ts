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
    operationDigest: hash,
    outcome: op.kind === "forget" ? "deleted" : "accepted",
    hubSequence: 1,
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
          receipt: { ...decision().receipt, operationDigest: "b".repeat(64) },
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
      yield* store.apply({ ...decision(), admission: Store.approvedReplica });
      const second = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      const item = (yield* second.loadAggregate(space, memory)).item;
      assert.strictEqual(item?.status, "blocked");
      assert.isTrue(item?.status === "blocked" && item.failureCode === "forget_pending");
      assert.isDefined((yield* second.loadAggregate(space, memory)).revisions[0]?.payload);
      assert.isFalse(item !== undefined && "payload" in item);
      assert.strictEqual((yield* second.pendingForgetIntents(10)).length, 1);
    }).pipe(Effect.provide(live)),
  );
});
