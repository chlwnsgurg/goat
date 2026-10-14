import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as Settings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";
import { layerMemoryHubServices, layerMemoryHubRoutes, layerMemoryHubStarted } from "../server.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const memberEnv = M.EnvironmentId.make("synthetic-source-owner");
const hubCredential = "d".repeat(43);
const operation = (
  n: number,
  environmentId: M.EnvironmentId,
): Extract<M.MemoryOperation, { kind: "upsert" }> => ({
  protocolVersion: 1,
  kind: "upsert",
  memorySpaceId: space,
  memoryId,
  operationId: M.MemoryOperationId.make(id(n)),
  originEnvironmentId: environmentId,
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
    provenance: { environmentId },
  },
  payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
});

// r2 can reuse the actual HTTP/core fixture when L4's H/A/B drivers are integrated.
// No SyncService double, transcript reader or alternate admission path is installed.
const scenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-memory-hub-scenario-" });
  const settings = Settings.layer.pipe(
    Layer.provideMerge(Secrets.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const core = Service.layer.pipe(
    Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
    Layer.provideMerge(Environment.layerIdentity),
    Layer.provide(
      Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
  );
  const services = layerMemoryHubServices.pipe(
    Layer.provideMerge(core),
    Layer.provideMerge(settings),
  );
  const routes = layerMemoryHubRoutes.pipe(
    HttpRouter.provideRequest(services),
    Layer.provideMerge(services),
  );
  const app = Environment.layer.pipe(
    Layer.provideMerge(routes),
    Layer.provideMerge(NodeServices.layer),
  );
  const memoMap = yield* Layer.makeMemoMap;
  const scope = yield* Scope.Scope;
  const context = yield* Layer.buildWithMemoMap(
    app.pipe(Layer.provideMerge(HttpRouter.layer)),
    memoMap,
    scope,
  );
  const http = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(app, { memoMap, disableLogger: true })),
    (http) => Effect.promise(() => http.dispose()),
  );
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context);
  const hubEnv = yield* run(
    Environment.ServerEnvironmentIdentity.use((identity) => identity.getEnvironmentId),
  );
  const post = (path: string, body: unknown, credential: string | null = hubCredential) =>
    Effect.promise(() =>
      http.handler(
        new Request(`https://hub.invalid${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
          },
          body: JSON.stringify(body),
        }),
        Context.empty(),
      ),
    );
  const call = <A, I>(
    path: string,
    body: unknown,
    schema: Schema.Codec<A, I>,
    credential = hubCredential,
  ) =>
    Effect.gen(function* () {
      const response = yield* post(path, body, credential);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
      return yield* Schema.decodeUnknownEffect(schema)(
        yield* Effect.promise(() => response.json()),
      );
    });
  const configure = (mode: "hub" | "disabled") =>
    run(
      Effect.gen(function* () {
        const service = yield* Settings.ServerSettingsService;
        const transitions = yield* Settings.MemoryHubSettingsTransitions;
        const current = yield* service.getSettings;
        return yield* transitions.applyMemoryHubTransition(
          {
            requestId: M.MemoryOperationId.make(id(900 + current.memoryHubVersion)),
            expectedVersion: current.memoryHubVersion,
            settings: mode === "hub" ? { mode, memorySpaceId: space } : { mode },
          },
          Effect.void,
        );
      }),
    );
  const initialize = Effect.gen(function* () {
    yield* configure("hub");
    yield* run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const crypto = yield* Crypto.Crypto;
        const digest = Hex.encode(
          yield* crypto.digest("SHA-256", new TextEncoder().encode(hubCredential)),
        );
        yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubEnv},${digest},1,'active',0)`;
        const compactor = yield* Compactor.MemoryCompactor;
        yield* compactor.compact({
          memorySpaceId: space,
          environmentId: hubEnv,
          credentialVersion: 1,
          scopes: ["memory:sync"],
        });
      }),
    );
  });
  const push = (operations: readonly M.MemoryOperation[]) =>
    call(
      M.MEMORY_HUB_PATHS.push,
      {
        protocolVersion: 1,
        memorySpaceId: space,
        environmentId: hubEnv,
        operations,
      },
      M.MemoryHubPushResult,
    );
  return { run, post, call, configure, initialize, push, hubEnv, context, memoMap };
});

describe("Memory hub assembled HTTP scenarios", () => {
  it.effect(
    "joins a real checkpoint, pushes a fork, claims and applies one canonical resolution",
    () =>
      Effect.gen(function* () {
        const s = yield* scenario;
        yield* s.initialize;
        const join = yield* s.call(
          M.MEMORY_HUB_PATHS.join,
          { protocolVersion: 1, memorySpaceId: space, environmentId: s.hubEnv },
          M.MemoryHubJoinResult,
        );
        const initial = yield* s.call(
          M.MEMORY_HUB_PATHS.pull,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            environmentId: s.hubEnv,
            afterSequence: 0,
            limit: 100,
            snapshotToken: join.snapshotToken,
          },
          M.MemoryHubPullResult,
        );
        assert.strictEqual(initial.checkpoint?.bootstrapComplete, true);
        const first = operation(10, s.hubEnv);
        assert.strictEqual((yield* s.push([first])).receipts[0]!.hubSequence, 1);
        const sibling = (n: number) => {
          const op = operation(n, s.hubEnv);
          return {
            ...op,
            expectedHeads: [first.revision.revisionId],
            revision: { ...op.revision, parents: [first.revision.revisionId] },
          };
        };
        yield* s.push([sibling(11), sibling(12)]);
        const aggregate = yield* s.run(
          Store.MemoryStore.use((store) => store.loadAggregate(space, memoryId)),
        );
        assert.deepStrictEqual([...aggregate.heads].sort(), [id(111), id(112)]);
        const claim: M.MemoryHubClaimInput = {
          protocolVersion: 1,
          memorySpaceId: space,
          memoryId,
          holderEnvironmentId: s.hubEnv,
          conflictId: aggregate.conflicts[0]!.conflictId,
          conflictHeadSet: aggregate.heads,
          attemptId: M.MemoryOperationId.make(id(50)),
          frozenDefaultModelSelection: {
            instanceId: M.ProviderInstanceId.make("synthetic-provider"),
            model: "synthetic-model",
          },
        };
        const lease = yield* s.call(M.MEMORY_HUB_PATHS.claim, claim, M.MemoryResolutionLease);
        const renewed = yield* s.call(
          M.MEMORY_HUB_PATHS.renew,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            memoryId,
            holderEnvironmentId: s.hubEnv,
            conflictId: claim.conflictId,
            attemptId: claim.attemptId,
            fencingToken: lease.fencingToken,
          },
          M.MemoryResolutionLease,
        );
        assert.strictEqual(renewed.fencingToken, lease.fencingToken);
        const base = operation(80, s.hubEnv);
        const resolutionId = M.MemoryResolutionId.make(id(81));
        const op: Extract<M.MemoryOperation, { kind: "resolve" }> = {
          ...base,
          kind: "resolve",
          expectedHeads: aggregate.heads,
          revision: { ...base.revision, parents: aggregate.heads },
          conflictId: claim.conflictId,
          fencingToken: lease.fencingToken,
          resolution: {
            resolutionId,
            memorySpaceId: space,
            memoryId,
            inputRevisionIds: aggregate.heads,
            inputPayloadRefs: aggregate.heads,
            judgmentRef: resolutionId,
            requestedModelSelection: claim.frozenDefaultModelSelection,
            effectiveProvider: M.ProviderDriverKind.make("codex"),
            effectiveModel: "synthetic-model",
            resolvingEnvironmentId: s.hubEnv,
            fencingToken: lease.fencingToken,
            resultRevisionId: base.revision.revisionId,
            appliedAtUtc: M.MemoryUtcTimestamp.make("2000-01-01T00:00:00.000Z"),
            revertDeadlineUtc: M.MemoryUtcTimestamp.make("2000-01-02T00:00:00.000Z"),
          },
          resolutionPayload: { resolutionId, judgment: "synthetic judgment" },
        };
        const apply = {
          protocolVersion: 1,
          memorySpaceId: space,
          holderEnvironmentId: s.hubEnv,
          attemptId: claim.attemptId,
          operation: op,
        };
        const receipt = yield* s.call(
          M.MEMORY_HUB_PATHS.applyResolution,
          apply,
          M.MemoryHubReceipt,
        );
        assert.strictEqual(receipt.outcome, "accepted");
        assert.strictEqual(receipt.hubSequence, 4);
        assert.deepStrictEqual(
          yield* s.call(M.MEMORY_HUB_PATHS.applyResolution, apply, M.MemoryHubReceipt),
          receipt,
        );
        const pull = yield* s.call(
          M.MEMORY_HUB_PATHS.pull,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            environmentId: s.hubEnv,
            afterSequence: 0,
            limit: 100,
          },
          M.MemoryHubPullResult,
        );
        assert.strictEqual(pull.entries.length, 4);
        assert.strictEqual(pull.throughSequence, 4);
        assert.deepStrictEqual(
          (yield* s.run(Store.MemoryStore.use((store) => store.loadAggregate(space, memoryId))))
            .heads,
          [base.revision.revisionId],
        );
        yield* s.run(
          Compactor.MemoryCompactor.use((compactor) =>
            compactor.compact({
              memorySpaceId: space,
              environmentId: s.hubEnv,
              credentialVersion: 1,
              scopes: ["memory:sync"],
            }),
          ),
        );
        // Production producer must retain the old member's immutable checkpoint token.
        const pinned = yield* s.call(
          M.MEMORY_HUB_PATHS.pull,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            environmentId: s.hubEnv,
            afterSequence: 0,
            limit: 100,
            snapshotToken: join.snapshotToken,
          },
          M.MemoryHubPullResult,
        );
        assert.deepStrictEqual(pinned.checkpoint, initial.checkpoint);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "relays only the owner's synthetic source through four actual routes and purges it",
    () =>
      Effect.gen(function* () {
        const s = yield* scenario;
        yield* s.initialize;
        const provisioned = yield* s.run(
          Effect.gen(function* () {
            const settings = yield* Settings.ServerSettingsService;
            const admin = yield* Hub.MemoryHubAdministrator;
            return yield* admin.update(
              {
                requestId: M.MemoryOperationId.make(id(600)),
                expectedVersion: (yield* settings.getSettings).memoryHubVersion,
                action: "provisionMember",
                environmentId: memberEnv,
              },
              Effect.void,
            );
          }),
        );
        assert.ok(provisioned.credential);
        const sourceThread: M.ScopedThreadRef = {
          environmentId: memberEnv,
          threadId: M.ThreadId.make("synthetic-thread"),
        };
        const watermark: M.MemorySourceWatermark = {
          fromEventId: M.EventId.make("synthetic-from"),
          toEventId: M.EventId.make("synthetic-to"),
          throughSequence: 8,
        };
        const messageId = M.MessageId.make("synthetic-message");
        const base = operation(10, s.hubEnv);
        yield* s.push([
          {
            ...base,
            revision: {
              ...base.revision,
              provenance: { environmentId: s.hubEnv, sourceThread, sourceWatermark: watermark },
            },
            payload: {
              text: "synthetic linked summary",
              evidence: [{ origin: "thread", sourceThread, watermark, messageIds: [messageId] }],
              derivedFromMemoryRevisions: [],
            },
          },
        ]);
        const requestId = M.MemorySourceReadRequestId.make(id(300));
        yield* s.call(
          M.MEMORY_HUB_PATHS.sourceReadRequest,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            memoryId,
            requestId,
            sourceThread,
            sourceWatermark: watermark,
            messageIds: [messageId],
            limit: 10,
            authorizedScopes: ["memory:read", "orchestration:read"],
          },
          M.MemoryHubSourceReadRequestResult,
        );
        const collect = { protocolVersion: 1, memorySpaceId: space, limit: 32 };
        assert.strictEqual(
          (yield* s.call(
            M.MEMORY_HUB_PATHS.sourceReadCollect,
            collect,
            M.MemoryHubSourceReadCollectResult,
          )).requests.length,
          0,
        );
        assert.strictEqual(
          (yield* s.call(
            M.MEMORY_HUB_PATHS.sourceReadCollect,
            collect,
            M.MemoryHubSourceReadCollectResult,
            provisioned.credential.credential,
          )).requests.length,
          1,
        );
        const outcome: M.MemorySourceReadOutcome = {
          kind: "available",
          page: {
            sourceThread,
            watermark,
            messages: [{ messageId, text: "synthetic original" }],
            nextCursor: null,
          },
        };
        yield* s.call(
          M.MEMORY_HUB_PATHS.sourceReadRespond,
          { protocolVersion: 1, memorySpaceId: space, requestId, outcome },
          M.MemoryHubSourceReadRespondResult,
          provisioned.credential.credential,
        );
        assert.deepStrictEqual(
          yield* s.call(
            M.MEMORY_HUB_PATHS.sourceReadResult,
            { protocolVersion: 1, memorySpaceId: space, requestId },
            M.MemoryHubSourceReadResultResult,
          ),
          { state: "completed", outcome },
        );
        yield* s.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.strictEqual(
              (yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM memory_payloads WHERE body_json LIKE '%synthetic original%'`)[0]!
                .count,
              0,
            );
            assert.strictEqual(
              (yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!.count,
              1,
            );
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses bearer identity for 401/403 and withdraws live advertisement when disabled", () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      const descriptor = s.run(
        Environment.ServerEnvironment.use((environment) => environment.getDescriptor),
      );
      assert.strictEqual((yield* descriptor).capabilities.memoryHubProtocolVersion, undefined);
      assert.strictEqual((yield* s.post(M.MEMORY_HUB_PATHS.push, {})).status, 503);
      yield* s.initialize;
      assert.strictEqual((yield* descriptor).capabilities.memoryHubProtocolVersion, 1);
      const push = {
        protocolVersion: 1,
        memorySpaceId: space,
        environmentId: s.hubEnv,
        operations: [],
      };
      assert.strictEqual((yield* s.post(M.MEMORY_HUB_PATHS.push, push, null)).status, 401);
      assert.strictEqual(
        (yield* s.post(M.MEMORY_HUB_PATHS.push, push, "x".repeat(43))).status,
        401,
      );
      assert.strictEqual(
        (yield* s.post(M.MEMORY_HUB_PATHS.push, { ...push, environmentId: memberEnv })).status,
        403,
      );
      yield* s.configure("disabled");
      assert.strictEqual((yield* descriptor).capabilities.memoryHubProtocolVersion, undefined);
      assert.strictEqual((yield* s.post(M.MEMORY_HUB_PATHS.push, push)).status, 503);
      assert.strictEqual(
        yield* s.run(Hub.MemoryHubConfiguration.use((configuration) => configuration.read)),
        null,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("serves externally registered hub routes across the server MemoMap boundary", () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      yield* s.initialize;
      // As in server.ts: route/descriptor acquisition happens in the parent map,
      // and serve forks that map while reusing the already acquired router/core.
      const served = yield* Layer.buildWithMemoMap(
        HttpRouter.serve(Layer.empty, {
          disableLogger: true,
          disableListenLog: true,
        }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(Layer.succeedContext(s.context)),
        ),
        s.memoMap,
        yield* Scope.Scope,
      );
      const client = Context.get(served, HttpClient.HttpClient);
      const request = () =>
        client.post(M.MEMORY_HUB_PATHS.push, {
          headers: { "content-type": "application/json", authorization: `Bearer ${hubCredential}` },
          body: HttpBody.jsonUnsafe({
            protocolVersion: 1,
            memorySpaceId: space,
            environmentId: s.hubEnv,
            operations: [],
          }),
        });
      const response = yield* request();
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* response.json, { receipts: [] });
      const descriptor = s.run(
        Environment.ServerEnvironment.use((environment) => environment.getDescriptor),
      );
      const enabled = yield* descriptor;
      assert.strictEqual(enabled.capabilities.memoryHubProtocolVersion, 1);
      assert.strictEqual(enabled.capabilities.memory, undefined);
      yield* s.configure("disabled");
      const disabled = yield* descriptor;
      assert.strictEqual(disabled.environmentId, enabled.environmentId);
      assert.strictEqual(disabled.instanceId, enabled.instanceId);
      const { memoryHubProtocolVersion: _hubVersion, ...enabledCapabilities } =
        enabled.capabilities;
      assert.deepStrictEqual(disabled.capabilities, enabledCapabilities);
      assert.strictEqual((yield* request()).status, 503);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "parks for settings readiness, starts once after enable and keeps timers in application Scope",
    () =>
      Effect.gen(function* () {
        const s = yield* scenario;
        yield* s.initialize;
        yield* s.configure("disabled");
        const started = yield* Deferred.make<void>();
        const prepared = yield* Deferred.make<void>();
        let starts = 0;
        const producer = Context.get(s.context, Compactor.MemoryHubCheckpointProducer);
        const compactor = yield* s.run(
          Compactor.make.pipe(
            Effect.provideService(Compactor.MemoryHubCheckpointProducer, {
              prepareTx: (input) =>
                producer
                  .prepareTx(input)
                  .pipe(Effect.tap(() => Deferred.succeed(prepared, undefined))),
            }),
          ),
        );
        const observed = Compactor.MemoryCompactor.of({
          ...compactor,
          start: (principal) =>
            compactor.start(principal).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  starts++;
                }),
              ),
              Effect.tap(() => Deferred.succeed(started, undefined)),
            ),
        });
        const applicationScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(applicationScope, Exit.void));
        // Real file settings are not started yet. Layer acquisition must return;
        // waiting for readiness here would deadlock ServerRuntimeStartup.start.
        yield* Layer.buildWithScope(
          layerMemoryHubStarted.pipe(
            Layer.provide(Layer.succeed(Compactor.MemoryCompactor, observed)),
            Layer.provide(Layer.succeedContext(s.context)),
          ),
          applicationScope,
        );
        assert.strictEqual(starts, 0);
        yield* s.run(Settings.ServerSettingsService.use((settings) => settings.start));
        yield* s.configure("hub");
        yield* Deferred.await(started);
        assert.strictEqual(starts, 1);
        const retention = s.run(
          Store.MemoryStore.use((store) => store.transact(store.readHubRetentionTx(space))),
        );
        const before = yield* retention;
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS);
        yield* Deferred.await(prepared);
        // Read through the writer lock after prepare, so the observation follows commit.
        const after = yield* retention;
        assert.notStrictEqual(after.checkpointId, before.checkpointId);
        yield* s.configure("disabled");
        yield* s.configure("hub");
        assert.strictEqual(starts, 1);
        yield* Scope.close(applicationScope, Exit.void);
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS);
        yield* s.run(Hub.MemoryHubActivity.use((activity) => activity.notify));
        assert.deepStrictEqual(yield* retention, after);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
