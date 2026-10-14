import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
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
      yield* sql`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<${M.MEMORY_LOG_MAX_TAIL_ROWS}) INSERT INTO memory_hub_operations(space,operation_id,memory_id,origin_environment,operation_digest,entry_json,committed_at) SELECT ${space},'tail-'||n,${memoryId},${hubEnv},${"c".repeat(64)},'{}',0 FROM rows`;
      const hub = yield* Hub.MemoryHubService;
      const result = yield* hub.push(pushInput(operation()), principal());
      assert.strictEqual(result.receipts[0]!.failureCode, "capacity_exceeded");
      assert.isNull(result.receipts[0]!.hubSequence);
      const store = yield* Store.MemoryStore;
      assert.isUndefined((yield* store.loadAggregate(space, memoryId)).item);
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
          .count,
        M.MEMORY_LOG_MAX_TAIL_ROWS,
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

const adminDependencies = Secrets.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-wp3-l2-admin-" })),
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(core),
);
const adminFixture = Effect.gen(function* () {
  yield* seed;
  const view = yield* Ref.make<M.MemoryHubSettingsView>({
    settings: { mode: "hub", memorySpaceId: space },
    version: 0,
  });
  const failApply = yield* Ref.make(false);
  const applied = yield* Ref.make(
    new Map<M.MemoryOperationId, { digest: string; result: { view: M.MemoryHubSettingsView } }>(),
  );
  const lock = yield* Semaphore.make(1);
  const backend: Hub.MemoryHubAdminSettings["Service"] = {
    withLock: (effect) => lock.withPermit(effect),
    read: Ref.get(view),
    apply: (record, permit) =>
      Effect.gen(function* () {
        yield* permit;
        if (yield* Ref.get(failApply)) return yield* new M.MemoryHubError({ code: "hub_disabled" });
        const saved = (yield* Ref.get(applied)).get(record.requestId);
        if (saved) {
          if (saved.digest !== record.requestDigest)
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          return saved.result;
        }
        const current = yield* Ref.get(view);
        // This fixture is the settings CAS owner; SQL/admin service is real.
        if (current.version === record.expectedVersion) {
          const next = { ...current, version: current.version + 1 };
          yield* Ref.set(view, next);
          const result = { view: next };
          yield* Ref.update(applied, (entries) =>
            new Map(entries).set(record.requestId, { digest: record.requestDigest, result }),
          );
          return result;
        }
        return yield* new M.MemoryHubError({ code: "identity_mismatch" });
      }),
  };
  const admin = yield* Hub.makeAdministrator.pipe(
    Effect.provideService(Hub.MemoryHubAdminSettings, backend),
  );
  return { admin, backend, failApply, view };
});
const provision: M.MemoryHubSettingsUpdateInput = {
  requestId: M.MemoryOperationId.make(id(400)),
  expectedVersion: 0,
  action: "provisionMember",
  environmentId: M.EnvironmentId.make("new-member"),
};

describe("MemoryHubAdministrator", () => {
  it.effect(
    "resumes after activation/settings failure using the same private secret and member version",
    () =>
      Effect.gen(function* () {
        const { admin, backend, failApply } = yield* adminFixture;
        yield* Ref.set(failApply, true);
        assert.strictEqual(
          (yield* admin.update(provision, Effect.void).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        const pending = yield* admin.pending(Effect.void);
        assert.strictEqual(pending[0]!.stage, "activated");
        assert.strictEqual(pending[0]!.memberVersion, 1);
        const secrets = yield* Secrets.ServerSecretStore;
        const staged = yield* secrets.get(pending[0]!.secretName!);
        assert.isTrue(Option.isSome(staged));
        yield* Ref.set(failApply, false);
        const restarted = yield* Hub.makeAdministrator.pipe(
          Effect.provideService(Hub.MemoryHubAdminSettings, backend),
        );
        const result = yield* restarted.update(provision, Effect.void);
        assert.strictEqual(result.credential!.credentialVersion, 1);
        assert.strictEqual(
          result.credential!.credential,
          Buffer.from(Option.getOrThrow(staged)).toString("base64url"),
        );
        assert.deepStrictEqual(yield* restarted.update(provision, Effect.void), result);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          admin_json: string;
        }>`SELECT admin_json FROM memory_outbox WHERE kind='admin'`;
        assert.isFalse(rows[0]!.admin_json.includes(result.credential!.credential));
        assert.isFalse(rows[0]!.admin_json.includes('"credential":'));
      }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("a prepared rotation cannot supersede a completed competing rotation", () =>
    Effect.gen(function* () {
      const { admin, backend } = yield* adminFixture;
      const first = yield* admin.update(provision, Effect.void);
      const rotation: M.MemoryHubSettingsUpdateInput = {
        requestId: M.MemoryOperationId.make(id(410)),
        expectedVersion: 1,
        action: "rotateMemberCredential",
        environmentId: first.credential!.environmentId,
      };
      const secrets = yield* Secrets.ServerSecretStore;
      const failed = yield* Hub.makeAdministrator.pipe(
        Effect.provideService(Hub.MemoryHubAdminSettings, backend),
        Effect.provideService(Secrets.ServerSecretStore, {
          ...secrets,
          getOrCreateRandom: () =>
            Effect.fail(
              new Secrets.SecretStorePersistError({ resource: "synthetic", cause: undefined }),
            ),
        }),
      );
      assert.strictEqual(
        (yield* failed.update(rotation, Effect.void).pipe(Effect.flip))._tag,
        "SecretStorePersistError",
      );
      assert.strictEqual(
        (yield* admin.pending(Effect.void)).find(
          (record) => record.requestId === rotation.requestId,
        )!.stage,
        "prepared",
      );
      const winner = yield* admin.update(
        { ...rotation, requestId: M.MemoryOperationId.make(id(411)) },
        Effect.void,
      );
      const store = yield* Store.MemoryStore;
      const member = yield* store.readHubMember(space, rotation.environmentId);
      const error = yield* admin.update(rotation, Effect.void).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MemoryStoreConflict");
      if (error._tag === "MemoryStoreConflict") assert.strictEqual(error.code, "revision_changed");
      assert.deepStrictEqual(yield* store.readHubMember(space, rotation.environmentId), member);
      assert.strictEqual(member!.credentialVersion, winner.credential!.credentialVersion);
      yield* store.transact(
        store.requireHubMemberTx({
          ...principal(rotation.environmentId),
          credentialVersion: winner.credential!.credentialVersion,
        }),
      );
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("an activated recovery blocks later transitions until its settings CAS finishes", () =>
    Effect.gen(function* () {
      const { admin, backend, failApply, view } = yield* adminFixture;
      yield* Ref.set(failApply, true);
      yield* admin.update(provision, Effect.void).pipe(Effect.flip);
      yield* Ref.set(failApply, false);
      const blocked = {
        ...provision,
        requestId: M.MemoryOperationId.make(id(412)),
        environmentId: M.EnvironmentId.make("other-new-member"),
      };
      assert.strictEqual(
        (yield* admin.update(blocked, Effect.void).pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      const store = yield* Store.MemoryStore;
      assert.isUndefined(yield* store.transact(store.readHubAdminTx(blocked.requestId)));
      assert.isUndefined(yield* store.readHubMember(space, blocked.environmentId));
      const restarted = yield* Hub.makeAdministrator.pipe(
        Effect.provideService(Hub.MemoryHubAdminSettings, backend),
      );
      yield* restarted.update(provision, Effect.void);
      assert.strictEqual((yield* Ref.get(view)).version, 1);
      // A distinct request cannot replay another request's expectedVersion + 1.
      const original = (yield* store.transact(store.readHubAdminTx(provision.requestId)))!;
      assert.strictEqual(
        (yield* backend
          .apply({ ...original, requestId: blocked.requestId }, Effect.void)
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      yield* restarted.update({ ...blocked, expectedVersion: 1 }, Effect.void);
      assert.strictEqual((yield* Ref.get(view)).version, 2);
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("acknowledgement erases outgoing bytes and replay cannot disclose them", () =>
    Effect.gen(function* () {
      const { admin } = yield* adminFixture;
      const issued = yield* admin.update(provision, Effect.void);
      const record = (yield* admin.pending(Effect.void))[0]!;
      yield* admin.update(
        {
          requestId: M.MemoryOperationId.make(id(401)),
          expectedVersion: 1,
          action: "acknowledgeCredential",
          credentialRequestId: provision.requestId,
        },
        Effect.void,
      );
      const secrets = yield* Secrets.ServerSecretStore;
      assert.isTrue(Option.isNone(yield* secrets.get(record.secretName!)));
      assert.isNull((yield* admin.update(provision, Effect.void)).credential);
      const store = yield* Store.MemoryStore;
      assert.strictEqual(
        (yield* store.readHubMember(space, issued.credential!.environmentId))!.credentialVersion,
        1,
      );
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("denied owner permission creates neither secret nor member/admin record", () =>
    Effect.gen(function* () {
      const { admin } = yield* adminFixture;
      assert.strictEqual(
        (yield* admin
          .update(provision, Effect.fail(new M.MemoryHubForbiddenError({})))
          .pipe(Effect.flip))._tag,
        "MemoryHubForbiddenError",
      );
      assert.deepStrictEqual(yield* admin.pending(Effect.void), []);
      const store = yield* Store.MemoryStore;
      assert.isUndefined(yield* store.readHubMember(space, M.EnvironmentId.make("new-member")));
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("rotate/revoke invalidate old principals and changed request bytes cannot replay", () =>
    Effect.gen(function* () {
      const { admin } = yield* adminFixture;
      const first = yield* admin.update(provision, Effect.void);
      assert.strictEqual(
        (yield* admin
          .update({ ...provision, environmentId: M.EnvironmentId.make("changed") }, Effect.void)
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      const env = first.credential!.environmentId;
      const rotated = yield* admin.update(
        {
          requestId: M.MemoryOperationId.make(id(402)),
          expectedVersion: 1,
          action: "rotateMemberCredential",
          environmentId: env,
        },
        Effect.void,
      );
      assert.strictEqual(rotated.credential!.credentialVersion, 2);
      assert.notStrictEqual(rotated.credential!.credential, first.credential!.credential);
      const store = yield* Store.MemoryStore;
      assert.strictEqual(
        (yield* store.transact(store.requireHubMemberTx(principal(env))).pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      yield* admin.update(
        {
          requestId: M.MemoryOperationId.make(id(403)),
          expectedVersion: 2,
          action: "revokeMember",
          environmentId: env,
        },
        Effect.void,
      );
      assert.strictEqual((yield* store.readHubMember(space, env))!.status, "revoked");
      assert.strictEqual(
        (yield* admin.update(provision, Effect.void).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
    }).pipe(Effect.provide(adminDependencies)),
  );
});

const resolutionSubmission = Effect.gen(function* () {
  const { hub, store, claim } = yield* conflict;
  const lease = yield* hub.claim(claim, principal());
  const base = operation(80);
  const resolutionId = M.MemoryResolutionId.make(id(81));
  const op: Extract<M.MemoryOperation, { kind: "resolve" }> = {
    ...base,
    kind: "resolve",
    expectedHeads: claim.conflictHeadSet,
    revision: { ...base.revision, parents: claim.conflictHeadSet },
    conflictId: claim.conflictId,
    fencingToken: lease.fencingToken,
    resolution: {
      resolutionId,
      memorySpaceId: space,
      memoryId,
      inputRevisionIds: claim.conflictHeadSet,
      inputPayloadRefs: claim.conflictHeadSet,
      judgmentRef: resolutionId,
      requestedModelSelection: claim.frozenDefaultModelSelection,
      effectiveProvider: M.ProviderDriverKind.make("codex"),
      effectiveModel: "synthetic-model",
      resolvingEnvironmentId: hubEnv,
      fencingToken: lease.fencingToken,
      resultRevisionId: base.revision.revisionId,
      appliedAtUtc: M.MemoryUtcTimestamp.make("2000-01-01T00:00:00.000Z"),
      revertDeadlineUtc: M.MemoryUtcTimestamp.make("2000-01-02T00:00:00.000Z"),
    },
    resolutionPayload: { resolutionId, judgment: "synthetic judgment" },
  };
  const request: M.MemoryHubApplyResolutionInput = {
    protocolVersion: 1,
    memorySpaceId: space,
    holderEnvironmentId: hubEnv,
    attemptId: claim.attemptId,
    operation: op,
  };
  return { hub, store, claim, lease, op, request };
});

describe("MemoryHubService resolution approval", () => {
  it.effect(
    "uses post-lock hub time rather than operation timestamps and preserves approval on replay",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const { hub, store, request, op } = yield* resolutionSubmission;
        const now = yield* Clock.currentTimeMillis;
        const approved = yield* hub.applyResolution(request, principal());
        assert.strictEqual(approved.outcome, "accepted");
        assert.strictEqual(
          approved.resolutionApproval!.appliedAtUtc,
          DateTime.formatIso(DateTime.makeUnsafe(now)),
        );
        assert.strictEqual(
          Date.parse(approved.resolutionApproval!.revertDeadlineUtc),
          now + 2592000000,
        );
        const aggregate = yield* store.loadAggregate(space, memoryId);
        assert.deepStrictEqual(aggregate.heads, [op.revision.revisionId]);
        assert.strictEqual(
          aggregate.resolutions[0]!.appliedAtUtc,
          DateTime.formatIso(DateTime.makeUnsafe(now)),
        );
        yield* TestClock.adjust(M.MEMORY_RESOLUTION_ATTEMPT_MAX_MS);
        assert.deepStrictEqual(yield* hub.applyResolution(request, principal()), approved);
        assert.deepStrictEqual((yield* hub.push(pushInput(op), principal())).receipts, [approved]);
      }).pipe(Effect.provide(live)),
  );
  it.effect("ordinary push cannot admit a new resolution", () =>
    Effect.gen(function* () {
      yield* seed;
      const { hub, store, op } = yield* resolutionSubmission;
      const refusal = (yield* hub.push(pushInput(op), principal())).receipts[0]!;
      assert.strictEqual(refusal.outcome, "rejected");
      assert.strictEqual(refusal.failureCode, "lease_required");
      assert.isNotNull(refusal.hubSequence);
      assert.isFalse(
        (yield* store.loadAggregate(space, memoryId)).heads.includes(op.revision.revisionId),
      );
      const page = yield* hub.pull(pullInput, principal());
      assert.strictEqual(page.entries.at(-1)!.kind, "metadata");
    }).pipe(Effect.provide(live)),
  );
  it.effect("SQL lock wait crossing expiry cannot approve a stale resolution", () =>
    Effect.gen(function* () {
      yield* seed;
      const { hub, store, request } = yield* resolutionSubmission;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocker = yield* store
        .transact(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const waiting = yield* hub.applyResolution(request, principal()).pipe(Effect.forkChild);
      yield* TestClock.adjust(M.MEMORY_LEASE_MS);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(blocker);
      const refusal = yield* Fiber.join(waiting);
      assert.strictEqual(refusal.failureCode, "lease_expired");
      assert.isUndefined(refusal.resolutionApproval);
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).resolutions.length, 0);
    }).pipe(Effect.provide(live)),
  );
  it.effect("forget immediately invalidates pending source relay", () =>
    Effect.gen(function* () {
      yield* sourceSeed;
      const hub = yield* Hub.MemoryHubService;
      yield* hub.requestSourceRead(sourceRequest, principal());
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const operationId = M.MemoryOperationId.make(id(600));
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId,
          expectedHeads: (yield* store.loadAggregate(space, memoryId)).heads,
        },
        Effect.void,
      );
      const op = (yield* store.readWorkOperation(`sync:${space}:${operationId}`))!;
      yield* hub.push(pushInput(op), principal());
      const response = yield* hub
        .respondSourceRead(
          { protocolVersion: 1, memorySpaceId: space, requestId: sourceRequest.requestId, outcome },
          principal(otherEnv),
        )
        .pipe(Effect.flip);
      assert.strictEqual(response._tag, "MemoryHubError");
      if (response._tag === "MemoryHubError")
        assert.strictEqual(response.code, "identity_mismatch");
      assert.deepStrictEqual(
        yield* hub.resultSourceRead(
          { protocolVersion: 1, memorySpaceId: space, requestId: sourceRequest.requestId },
          principal(),
        ),
        { state: "expired", code: "source_unavailable" },
      );
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_payloads WHERE body_json LIKE '%synthetic original%'`)[0]!
          .count,
        0,
      );
    }).pipe(Effect.provide(live)),
  );
});
