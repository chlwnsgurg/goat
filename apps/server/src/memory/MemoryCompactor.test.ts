import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/070_Memory.ts";
import hubMigration from "../persistence/Migrations/071_MemoryHubSync.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const hubEnv = M.EnvironmentId.make("hub");
const memberEnv = M.EnvironmentId.make("member");
const principal = (environmentId = hubEnv): M.MemoryHubPrincipal => ({
  memorySpaceId: space,
  environmentId,
  credentialVersion: 1,
  scopes: ["memory:sync"],
});
const database = Layer.effectDiscard(migration.pipe(Effect.andThen(hubMigration))).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const storeLayer = Store.layer.pipe(Layer.provideMerge(database));
const core = Service.layer.pipe(
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(storeLayer))),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(hubEnv),
    }),
  ),
);
// Legacy Store adapter exercises unrelated L2 behavior until L1 provides producer staging.
// It does not prove same-principal bootstrap token preservation.
const legacyProducerLayer = Layer.effect(
  Compactor.MemoryHubCheckpointProducer,
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    return Compactor.MemoryHubCheckpointProducer.of({
      prepareTx: (input) =>
        store.prepareHubCheckpointTx({
          ...input,
          snapshotToken: `producer-${input.checkpointId}`,
        }),
    });
  }),
).pipe(Layer.provide(storeLayer));
const live = Layer.merge(Hub.layer, Compactor.layer).pipe(
  Layer.provideMerge(core),
  Layer.provideMerge(legacyProducerLayer),
  Layer.provideMerge(Hub.activityLayer),
  Layer.provide(
    Layer.succeed(Hub.MemoryHubConfiguration, {
      read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
    }),
  ),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubEnv},${"a".repeat(64)},1,'active',0),(${space},${memberEnv},${"b".repeat(64)},1,'active',0)`;
});
const operation = (n = 10): M.MemoryOperation => ({
  protocolVersion: 1,
  kind: "upsert",
  memorySpaceId: space,
  memoryId,
  originEnvironmentId: hubEnv,
  operationId: M.MemoryOperationId.make(id(n)),
  expectedHeads: [],
  revision: {
    memorySpaceId: space,
    memoryId,
    operationId: M.MemoryOperationId.make(id(n)),
    revisionId: M.MemoryRevisionId.make(id(n + 100)),
    parents: [],
    scope: { kind: "user" },
    payloadRef: M.MemoryRevisionId.make(id(n + 100)),
    assertionKind: "inference",
    createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
    provenance: { environmentId: hubEnv },
  },
  payload: { text: "synthetic durable memory", evidence: [], derivedFromMemoryRevisions: [] },
});
const push = (op = operation()) =>
  Effect.gen(function* () {
    return yield* (yield* Hub.MemoryHubService).push(
      { protocolVersion: 1, memorySpaceId: space, environmentId: hubEnv, operations: [op] },
      principal(),
    );
  });
const pull = (afterSequence: number, environmentId = hubEnv): M.MemoryHubPullInput => ({
  protocolVersion: 1,
  memorySpaceId: space,
  environmentId,
  afterSequence,
  limit: 100,
});

describe("MemoryCompactor", () => {
  it.effect(
    "publishes a recoverable snapshot and real floor, compacts old tail and retains replay",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const first = yield* push();
        yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS);
        const compactor = yield* Compactor.MemoryCompactor;
        const retention = yield* compactor.compact(principal());
        assert.strictEqual(retention.checkpointSequence, 1);
        assert.strictEqual(retention.retentionFloor, 1);
        assert.strictEqual(retention.compaction.removedRows, 1);
        const hub = yield* Hub.MemoryHubService;
        assert.strictEqual(
          (yield* hub.pull(pull(0), principal()).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.strictEqual((yield* hub.pull(pull(1), principal())).entries.length, 0);
        assert.deepStrictEqual(yield* push(), first);
        const joined = yield* hub.join(
          { protocolVersion: 1, memorySpaceId: null, environmentId: memberEnv },
          principal(memberEnv),
        );
        const recovered = yield* hub.pull(
          { ...pull(0, memberEnv), snapshotToken: joined.snapshotToken },
          principal(memberEnv),
        );
        assert.strictEqual(recovered.checkpoint!.items[0]!.memoryId, memoryId);
        assert.strictEqual(recovered.checkpoint!.compactReceipts.length, 1);
      }).pipe(Effect.provide(live)),
  );
  it.effect("live member pin keeps the prior floor until immutable expiry", () =>
    Effect.gen(function* () {
      yield* seed;
      const compactor = yield* Compactor.MemoryCompactor;
      const hub = yield* Hub.MemoryHubService;
      yield* compactor.compact(principal());
      const joined = yield* hub.join(
        { protocolVersion: 1, memorySpaceId: space, environmentId: memberEnv },
        principal(memberEnv),
      );
      yield* push();
      const pinned = yield* compactor.compact(principal());
      assert.strictEqual(pinned.checkpointSequence, 1);
      assert.strictEqual(pinned.retentionFloor, 0);
      const old = yield* hub.pull(
        { ...pull(0, memberEnv), snapshotToken: joined.snapshotToken },
        principal(memberEnv),
      );
      assert.strictEqual(old.checkpoint!.checkpointSequence, 0);
      yield* TestClock.adjust(M.MEMORY_CHECKPOINT_TOKEN_TTL_MS);
      assert.strictEqual((yield* compactor.compact(principal())).retentionFloor, 1);
    }).pipe(Effect.provide(live)),
  );
  it.effect("a failed staging reservation keeps the old publication and floor intact", () =>
    Effect.gen(function* () {
      yield* seed;
      const compactor = yield* Compactor.MemoryCompactor;
      const initial = yield* compactor.compact(principal());
      yield* push();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE memory_hub_retention SET published_pinned_bytes=${M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES} WHERE space=${space}`;
      assert.strictEqual(
        (yield* compactor.compact(principal()).pipe(Effect.flip))._tag,
        "MemoryCapacityError",
      );
      const store = yield* Store.MemoryStore;
      const retained = yield* store.transact(store.readHubRetentionTx(space));
      assert.strictEqual(retained.checkpointId, initial.checkpointId);
      assert.strictEqual(retained.retentionFloor, initial.retentionFloor);
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(DISTINCT checkpoint_id) AS count FROM memory_inbox_pending WHERE reason='hub_snapshot'`)[0]!
          .count,
        1,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "daily scheduling survives service reconstruction and preserves nonexpired history",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* push();
        const compactor = yield* Compactor.MemoryCompactor;
        const first = yield* compactor.compactIfNeeded(principal());
        assert.strictEqual(first.compaction.removedRows, 0);
        const restarted = yield* Compactor.make.pipe(
          Effect.provideService(Hub.MemoryHubConfiguration, {
            read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
          }),
        );
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS - 1);
        assert.strictEqual(
          (yield* restarted.compactIfNeeded(principal())).checkpointId,
          first.checkpointId,
        );
        yield* TestClock.adjust(1);
        assert.notStrictEqual(
          (yield* restarted.compactIfNeeded(principal())).checkpointId,
          first.checkpointId,
        );
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
            .count,
          1,
        );
      }).pipe(Effect.provide(live)),
  );
  it.effect("row and byte triggers publish before the daily deadline", () =>
    Effect.gen(function* () {
      yield* seed;
      const compactor = yield* Compactor.MemoryCompactor;
      let first = yield* compactor.compact(principal());
      const sql = yield* SqlClient.SqlClient;
      // Denormalized tail bytes are a measurement fixture, not fabricated floor/publication.
      const padded = " ".repeat(M.MEMORY_CHECKPOINT_TRIGGER_TAIL_BYTES);
      const receipt = yield* push();
      yield* sql`UPDATE memory_hub_operations SET entry_json=entry_json || ${padded} WHERE operation_id=${receipt.receipts[0]!.operationId}`;
      const byBytes = yield* compactor.compactIfNeeded(principal());
      assert.notStrictEqual(byBytes.checkpointId, first.checkpointId);
      first = byBytes;
      // Every synthetic row is a body-free tail fixture; checkpoint state is built from real canonical writes.
      yield* sql`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<${M.MEMORY_CHECKPOINT_TRIGGER_TAIL_ROWS}) INSERT INTO memory_hub_operations(space,operation_id,memory_id,origin_environment,operation_digest,entry_json,committed_at) SELECT ${space},'tail-'||n,${memoryId},${hubEnv},${"c".repeat(64)},'{}',0 FROM rows`;
      assert.notStrictEqual(
        (yield* compactor.compactIfNeeded(principal())).checkpointId,
        first.checkpointId,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "start follows the durable daily deadline after a signal and interrupts its scoped workers",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* push();
        const store = yield* Store.MemoryStore;
        const activity = yield* Hub.MemoryHubActivity;
        const scope = yield* Scope.make();
        const mainId = yield* Effect.withFiberSucceed((fiber) => fiber.id);
        const workers = yield* Ref.make(new Map<number, Fiber.Fiber<unknown, unknown>>());
        const completed = yield* Ref.make(0);
        const signaled = yield* Deferred.make<void>();
        const daily = yield* Deferred.make<void>();
        const observed = Store.MemoryStore.of({
          ...store,
          readHubRetentionTx: (spaceId) =>
            Effect.withFiber((fiber) =>
              Ref.update(workers, (all) =>
                fiber.id === mainId ? all : new Map(all).set(fiber.id, fiber),
              ).pipe(Effect.andThen(store.readHubRetentionTx(spaceId))),
            ),
          compactEligibleHistoryTx: (input) =>
            store.compactEligibleHistoryTx(input).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  const count = yield* Ref.updateAndGet(completed, (n) => n + 1);
                  if (count === 2) yield* Deferred.succeed(signaled, undefined);
                  if (count === 3) yield* Deferred.succeed(daily, undefined);
                }),
              ),
            ),
        });
        const compactor = yield* Compactor.make.pipe(
          Effect.provideService(Store.MemoryStore, observed),
          Effect.provideService(Hub.MemoryHubConfiguration, {
            read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
          }),
        );
        yield* compactor.start(principal()).pipe(Effect.provideService(Scope.Scope, scope));
        const startedAt = yield* Clock.currentTimeMillis;
        yield* TestClock.adjust(3600000);
        const sql = yield* SqlClient.SqlClient;
        const padded = " ".repeat(M.MEMORY_CHECKPOINT_TRIGGER_TAIL_BYTES);
        yield* sql`UPDATE memory_hub_operations SET entry_json=entry_json || ${padded} WHERE space=${space}`;
        yield* activity.notify;
        yield* Deferred.await(signaled);
        const signaledRun = yield* store.transact(store.readHubRetentionTx(space));
        assert.strictEqual(Date.parse(signaledRun.compaction.lastRunAtUtc!), startedAt + 3600000);
        yield* sql`UPDATE memory_hub_operations SET entry_json=rtrim(entry_json) WHERE space=${space}`;
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS - 1);
        assert.strictEqual(
          (yield* store.transact(store.readHubRetentionTx(space))).checkpointId,
          signaledRun.checkpointId,
        );
        yield* TestClock.adjust(1);
        yield* Deferred.await(daily);
        const dailyRun = yield* store.transact(store.readHubRetentionTx(space));
        assert.strictEqual(
          Date.parse(dailyRun.compaction.lastRunAtUtc!),
          startedAt + 3600000 + M.MEMORY_CHECKPOINT_INTERVAL_MS,
        );
        assert.notStrictEqual(dailyRun.checkpointId, signaledRun.checkpointId);
        yield* Scope.close(scope, Exit.void);
        const captured = yield* Ref.get(workers);
        // Timer plus admission worker have both crossed a real Store boundary.
        assert.isAtLeast(captured.size, 2);
        for (const fiber of captured.values()) {
          const exit = yield* Fiber.await(fiber);
          assert.isTrue(Exit.isFailure(exit));
        }
        yield* activity.notify;
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS);
        assert.strictEqual(
          (yield* store.transact(store.readHubRetentionTx(space))).checkpointId,
          dailyRun.checkpointId,
        );
        assert.strictEqual(yield* Ref.get(completed), 3);
      }).pipe(Effect.provide(live)),
  );
  it.effect("members cannot run hub compaction or floor publication", () =>
    Effect.gen(function* () {
      yield* seed;
      const compactor = yield* Compactor.MemoryCompactor;
      assert.strictEqual(
        (yield* compactor.compact(principal(memberEnv)).pipe(Effect.flip))._tag,
        "MemoryHubForbiddenError",
      );
      const store = yield* Store.MemoryStore;
      assert.isNull((yield* store.transact(store.readHubRetentionTx(space))).checkpointId);
    }).pipe(Effect.provide(live)),
  );
});
