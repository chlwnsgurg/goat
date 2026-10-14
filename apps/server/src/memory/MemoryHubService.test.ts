import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
const otherEnv = M.EnvironmentId.make("member");
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
const configuration = Layer.succeed(Hub.MemoryHubConfiguration, {
  read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
});
const live = Layer.merge(Hub.layer, Compactor.layer).pipe(
  Layer.provideMerge(core),
  Layer.provide(configuration),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubEnv},${"a".repeat(64)},1,'active',0),(${space},${otherEnv},${"b".repeat(64)},1,'active',0)`;
});
const operation = (n = 10, env = hubEnv): Extract<M.MemoryOperation, { kind: "upsert" }> => ({
  protocolVersion: 1,
  kind: "upsert",
  memorySpaceId: space,
  memoryId,
  operationId: M.MemoryOperationId.make(id(n)),
  originEnvironmentId: env,
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
    provenance: { environmentId: env },
  },
  payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
});
const pushInput = (...operations: M.MemoryOperation[]): M.MemoryHubPushInput => ({
  protocolVersion: 1,
  memorySpaceId: space,
  environmentId: hubEnv,
  operations,
});
const pullInput: M.MemoryHubPullInput = {
  protocolVersion: 1,
  memorySpaceId: space,
  environmentId: hubEnv,
  afterSequence: 0,
  limit: 100,
};
const conflict = Effect.gen(function* () {
  const hub = yield* Hub.MemoryHubService;
  const first = operation();
  yield* hub.push(pushInput(first), principal());
  const sibling = (n: number) => {
    const op = operation(n);
    return {
      ...op,
      expectedHeads: [first.revision.revisionId],
      revision: { ...op.revision, parents: [first.revision.revisionId] },
    };
  };
  yield* hub.push(pushInput(sibling(11), sibling(12)), principal());
  const store = yield* Store.MemoryStore;
  const current = yield* store.loadAggregate(space, memoryId);
  const claim: M.MemoryHubClaimInput = {
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId,
    holderEnvironmentId: hubEnv,
    conflictId: current.conflicts[0]!.conflictId,
    conflictHeadSet: current.heads,
    attemptId: M.MemoryOperationId.make(id(50)),
    frozenDefaultModelSelection: {
      instanceId: M.ProviderInstanceId.make("synthetic-provider"),
      model: "synthetic-model",
    },
  };
  return { hub, store, claim };
});

describe("MemoryHubService", () => {
  it.effect("replays one sequence, rejects changed digest and refuses revoked replay", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const first = yield* hub.push(pushInput(operation()), principal());
      assert.strictEqual(first.receipts[0]!.hubSequence, 1);
      assert.deepStrictEqual(yield* hub.push(pushInput(operation()), principal()), first);
      const changed = { ...operation(), payload: { ...operation().payload, text: "changed" } };
      const error = yield* hub.push(pushInput(changed), principal()).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MemoryStoreConflict");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE memory_hub_members SET status='revoked' WHERE environment=${hubEnv}`;
      assert.strictEqual(
        (yield* hub.push(pushInput(operation()), principal()).pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
          .count,
        1,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("checks member origin, space and excess fields before any sequence", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      assert.strictEqual(
        (yield* hub
          .push({ ...pushInput(operation(10, otherEnv)), environmentId: otherEnv }, principal())
          .pipe(Effect.flip))._tag,
        "MemoryHubForbiddenError",
      );
      assert.strictEqual(
        (yield* hub
          .pull({ ...pullInput, memorySpaceId: M.MemorySpaceId.make(id(999)) }, principal())
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      assert.strictEqual(
        (yield* hub
          .push(Object.assign(pushInput(operation()), { extra: true }), principal())
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
          .count,
        0,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("semantic refusal is sequenced metadata and a later sibling commits", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const bad = {
        ...operation(),
        payload: { ...operation().payload, text: "-----BEGIN PRIVATE KEY-----" },
      };
      const good = {
        ...operation(11),
        memoryId: M.MemoryId.make(id(3)),
        revision: { ...operation(11).revision, memoryId: M.MemoryId.make(id(3)) },
      };
      const result = yield* hub.push(pushInput(bad, good), principal());
      assert.deepStrictEqual(
        result.receipts.map((r) => r.outcome),
        ["rejected", "accepted"],
      );
      const page = yield* hub.pull(pullInput, principal());
      assert.deepStrictEqual(
        page.entries.map((e) => e.kind),
        ["metadata", "operation"],
      );
      assert.strictEqual(page.throughSequence, 2);
      assert.isFalse(JSON.stringify(page.entries[0]).includes("PRIVATE KEY"));
    }).pipe(Effect.provide(live)),
  );
  it.effect("capacity failure returns null sequence and rolls back all canonical writes", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_retention(space,checkpoint_bytes,published_pinned_bytes) VALUES (${space},${M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES},0)`;
      const hub = yield* Hub.MemoryHubService;
      const result = yield* hub.push(pushInput(operation()), principal());
      assert.strictEqual(result.receipts[0]!.failureCode, "capacity_exceeded");
      assert.isNull(result.receipts[0]!.hubSequence);
      const store = yield* Store.MemoryStore;
      assert.isUndefined((yield* store.loadAggregate(space, memoryId)).item);
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
          .count,
        0,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("post-lock membership sees a revoke committed while push waited", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocker = yield* store
        .transact(
          Effect.gen(function* () {
            yield* sql`UPDATE memory_hub_members SET status='revoked' WHERE environment=${hubEnv}`;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const hub = yield* Hub.MemoryHubService;
      const waiting = yield* hub
        .push(pushInput(operation()), principal())
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(blocker);
      assert.strictEqual((yield* Fiber.join(waiting))._tag, "MemoryHubUnauthorizedError");
    }).pipe(Effect.provide(live)),
  );
  it.effect("fixed watermark excludes later writes until the next pull", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      yield* hub.push(pushInput(operation()), principal());
      const page = yield* hub.pull({ ...pullInput, limit: 1 }, principal());
      const next = operation(11);
      yield* hub.push(
        pushInput({
          ...next,
          expectedHeads: [operation().revision.revisionId],
          revision: { ...next.revision, parents: [operation().revision.revisionId] },
        }),
        principal(),
      );
      const pinned = yield* hub.pull(
        { ...pullInput, afterSequence: page.throughSequence, highWatermark: page.highWatermark },
        principal(),
      );
      assert.strictEqual(pinned.entries.length, 0);
      assert.strictEqual(
        (yield* hub.pull({ ...pullInput, afterSequence: page.throughSequence }, principal()))
          .entries.length,
        1,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("only one claimant holds the fence; expiry takeover rejects stale release", () =>
    Effect.gen(function* () {
      yield* seed;
      const { hub, store, claim } = yield* conflict;
      const first = yield* hub.claim(claim, principal());
      assert.deepStrictEqual(yield* hub.claim(claim, principal()), first);
      const other = {
        ...claim,
        holderEnvironmentId: otherEnv,
        attemptId: M.MemoryOperationId.make(id(51)),
      };
      assert.strictEqual(
        (yield* hub.claim(other, principal(otherEnv)).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      yield* TestClock.adjust(M.MEMORY_LEASE_MS);
      const takeover = yield* hub.claim(other, principal(otherEnv));
      assert.isAbove(takeover.fencingToken, first.fencingToken);
      assert.strictEqual(
        (yield* hub
          .release(
            {
              protocolVersion: 1,
              memorySpaceId: space,
              memoryId,
              holderEnvironmentId: hubEnv,
              conflictId: claim.conflictId,
              attemptId: claim.attemptId,
              fencingToken: first.fencingToken,
            },
            principal(),
          )
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      assert.strictEqual(
        (yield* store.loadAggregate(space, memoryId)).fence!.activeLease!.holderEnvironmentId,
        otherEnv,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("renewal never extends the ten-minute attempt deadline", () =>
    Effect.gen(function* () {
      yield* seed;
      const { hub, claim } = yield* conflict;
      const first = yield* hub.claim(claim, principal());
      const request: M.MemoryHubRenewInput = {
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId,
        holderEnvironmentId: hubEnv,
        conflictId: claim.conflictId,
        attemptId: claim.attemptId,
        fencingToken: first.fencingToken,
      };
      for (let n = 0; n < 9; n++) {
        yield* TestClock.adjust(60000);
        const next = yield* hub.renew(request, principal());
        assert.strictEqual(next.attemptDeadlineHubTime, first.attemptDeadlineHubTime);
      }
      yield* TestClock.adjust(60000);
      assert.strictEqual(
        (yield* hub.renew(request, principal()).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("join requires publication and checkpoint token expires without sliding", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const request: M.MemoryHubJoinInput = {
        protocolVersion: 1,
        memorySpaceId: null,
        environmentId: otherEnv,
      };
      assert.strictEqual(
        (yield* hub.join(request, principal(otherEnv)).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      yield* (yield* Compactor.MemoryCompactor).compact(principal());
      const joined = yield* hub.join(request, principal(otherEnv));
      const pull = { ...pullInput, environmentId: otherEnv, snapshotToken: joined.snapshotToken };
      const first = yield* hub.pull(pull, principal(otherEnv));
      yield* TestClock.adjust(M.MEMORY_CHECKPOINT_TOKEN_TTL_MS - 1);
      assert.deepStrictEqual(yield* hub.pull(pull, principal(otherEnv)), first);
      yield* TestClock.adjust(1);
      assert.strictEqual(
        (yield* hub.pull(pull, principal(otherEnv)).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
    }).pipe(Effect.provide(live)),
  );
});

const thread: M.ScopedThreadRef = {
  environmentId: otherEnv,
  threadId: M.ThreadId.make("synthetic-thread"),
};
const watermark: M.MemorySourceWatermark = {
  fromEventId: M.EventId.make("synthetic-from"),
  toEventId: M.EventId.make("synthetic-to"),
  throughSequence: 8,
};
const messageId = M.MessageId.make("synthetic-message");
const sourceRequest: M.MemoryHubSourceReadRequestInput = {
  protocolVersion: 1,
  memorySpaceId: space,
  memoryId,
  requestId: M.MemorySourceReadRequestId.make(id(300)),
  sourceThread: thread,
  sourceWatermark: watermark,
  messageIds: [messageId],
  limit: 10,
  authorizedScopes: ["memory:read", "orchestration:read"],
};
const sourceSeed = Effect.gen(function* () {
  yield* seed;
  const base = operation();
  yield* (yield* Hub.MemoryHubService).push(
    pushInput({
      ...base,
      revision: {
        ...base.revision,
        provenance: { environmentId: hubEnv, sourceThread: thread, sourceWatermark: watermark },
      },
      payload: {
        text: "synthetic linked summary",
        evidence: [{ origin: "thread", sourceThread: thread, watermark, messageIds: [messageId] }],
        derivedFromMemoryRevisions: [],
      },
    }),
    principal(),
  );
});
const outcome: M.MemorySourceReadOutcome = {
  kind: "available",
  page: {
    sourceThread: thread,
    watermark,
    messages: [{ messageId, text: "synthetic original" }],
    nextCursor: null,
  },
};

describe("MemoryHubService source relay", () => {
  it.effect(
    "routes to the owner only and consumes the purgeable result without tail accumulation",
    () =>
      Effect.gen(function* () {
        yield* sourceSeed;
        const hub = yield* Hub.MemoryHubService;
        const first = yield* hub.requestSourceRead(sourceRequest, principal());
        yield* TestClock.adjust(1000);
        assert.deepStrictEqual(yield* hub.requestSourceRead(sourceRequest, principal()), first);
        const collect = { protocolVersion: 1 as const, memorySpaceId: space, limit: 32 };
        assert.strictEqual(
          (yield* hub.collectSourceReads(collect, principal())).requests.length,
          0,
        );
        assert.strictEqual(
          (yield* hub.collectSourceReads(collect, principal(otherEnv))).requests.length,
          1,
        );
        const response = {
          protocolVersion: 1 as const,
          memorySpaceId: space,
          requestId: sourceRequest.requestId,
          outcome,
        };
        assert.strictEqual(
          (yield* hub.respondSourceRead(response, principal()).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        yield* hub.respondSourceRead(response, principal(otherEnv));
        const resultInput = {
          protocolVersion: 1 as const,
          memorySpaceId: space,
          requestId: sourceRequest.requestId,
        };
        assert.strictEqual(
          (yield* hub.resultSourceRead(resultInput, principal(otherEnv)).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.deepStrictEqual(yield* hub.resultSourceRead(resultInput, principal()), {
          state: "completed",
          outcome,
        });
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM memory_payloads WHERE body_json LIKE '%synthetic original%'`)[0]!
            .count,
          0,
        );
        assert.strictEqual((yield* hub.pull(pullInput, principal())).entries.length, 1);
      }).pipe(Effect.provide(live)),
  );
  it.effect("expires at the original 75-second deadline and rejects a late owner response", () =>
    Effect.gen(function* () {
      yield* sourceSeed;
      const hub = yield* Hub.MemoryHubService;
      yield* hub.requestSourceRead(sourceRequest, principal());
      yield* TestClock.adjust(74000);
      yield* hub.requestSourceRead(sourceRequest, principal());
      yield* TestClock.adjust(1000);
      assert.deepStrictEqual(
        yield* hub.resultSourceRead(
          { protocolVersion: 1, memorySpaceId: space, requestId: sourceRequest.requestId },
          principal(),
        ),
        { state: "expired", code: "source_unavailable" },
      );
      assert.strictEqual(
        (yield* hub.respondSourceRead(
          { protocolVersion: 1, memorySpaceId: space, requestId: sourceRequest.requestId, outcome },
          principal(otherEnv),
        )).accepted,
        false,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_hub_source_reads WHERE locator_json!='{}'`)[0]!
          .count,
        0,
      );
    }).pipe(Effect.provide(live)),
  );
});
