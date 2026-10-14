import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ProviderDriver, ProviderInstance } from "@goat/provider-core/server/driver";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlDrivers from "../sourceControl/builtInDrivers.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Vcs from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Worker from "./MemoryWorker.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as OrchestrationRuntime from "../orchestration-v2/runtimeLayer.ts";
import * as Runtime from "./MemorySyncRuntimeLive.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Client from "./MemoryHubClient.ts";
import { layerMemoryHubServices, layerMemoryHubRoutes, layerMemorySyncStarted } from "../server.ts";

const id = (n: number) =>
  M.MemoryOperationId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

type Resolve = NonNullable<Generation.TextGeneration["Service"]["resolveMemoryConflict"]>;
// The only double is the provider instance returned by this driver. Registry,
// TextGeneration routing, storage, HTTP and Sync all run their production code.
const environment = (label: "H" | "A" | "B", resolve?: Resolve) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: `goat-wp3-l5-${label}-` });
    const settings = Settings.layer.pipe(
      Layer.provideMerge(Secrets.layer),
      Layer.provideMerge(Sqlite.layerConfig),
      Layer.provideMerge(Config.layerTest(home, home)),
    );
    const core = Service.layer.pipe(
      Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
      Layer.provideMerge(Environment.layerIdentity),
      Layer.provide(Repository.layer),
    );
    const services = layerMemoryHubServices.pipe(
      Layer.provideMerge(core),
      Layer.provideMerge(settings),
    );
    const routes = layerMemoryHubRoutes.pipe(
      HttpRouter.provideRequest(services),
      Layer.provideMerge(services),
    );
    const application = Layer.mergeAll(Environment.layer, Client.layer).pipe(
      Layer.provideMerge(routes),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(HttpRouter.layer),
    );
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Scope.Scope;
    const baseContext = yield* Layer.buildWithMemoMap(application, memoMap, scope);
    const instanceId = M.ProviderInstanceId.make(`fixture-${label}`);
    const selection = { instanceId, model: `model-${label}` };
    const entered = yield* Deferred.make<M.ResolveMemoryConflictInput>();
    const released = yield* Deferred.make<M.MemoryId>();
    let generated = 0;
    let descriptorHealthy = true;
    let probes = 0;
    let rearmObservations = 0;
    const probed = yield* Deferred.make<void>();
    const pulled = yield* Deferred.make<void>();
    let observePull = false;
    const sourceRequested = yield* Deferred.make<M.MemorySourceReadRequest>();
    let sourceResultGate: Deferred.Deferred<void> | null = null;
    const driver: ProviderDriver<{}> = {
      driverKind: M.ProviderDriverKind.make("codex"),
      metadata: { displayName: "Synthetic memory provider", hasDefaultInstance: false },
      configSchema: Schema.Struct({}),
      defaultConfig: () => ({}),
      create: (input) =>
        Effect.gen(function* () {
          const identity = Context.get(baseContext, Environment.ServerEnvironmentIdentity);
          const environmentId = yield* identity.getEnvironmentId;
          const textGeneration = Generation.TextGeneration.of({
            generateCommitMessage: () => Effect.die("unexpected provider operation"),
            generatePrContent: () => Effect.die("unexpected provider operation"),
            generateBranchName: () => Effect.die("unexpected provider operation"),
            generateThreadTitle: () => Effect.die("unexpected provider operation"),
            generateReviewGuide: () => Effect.die("unexpected provider operation"),
            resolveMemoryConflict: (request) =>
              Effect.gen(function* () {
                generated++;
                yield* Deferred.succeed(entered, request);
                if (resolve) return yield* resolve(request);
                return {
                  result: {
                    text: "resolved synthetic fact",
                    assertionKind: "inference" as const,
                    evidence: [],
                    judgment: "combine both synthetic versions",
                  },
                  execution: {
                    requestedModelSelection: request.modelSelection,
                    effectiveProvider: M.ProviderDriverKind.make("codex"),
                    effectiveModel: request.modelSelection.model,
                    providerInstanceId: input.instanceId,
                    environmentId,
                  },
                };
              }),
          });
          return {
            instanceId: input.instanceId,
            driverKind: M.ProviderDriverKind.make("codex"),
            continuationIdentity: {
              driverKind: M.ProviderDriverKind.make("codex"),
              continuationKey: `synthetic-${label}`,
            },
            displayName: input.displayName,
            enabled: true,
            snapshot: {} as ProviderInstance["snapshot"],
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration,
          };
        }),
    };
    const providers = Registry.layer({
      drivers: [driver],
      configMap: { [instanceId]: { driver: driver.driverKind, config: {}, enabled: true } },
    });
    const vcs = Layer.mergeAll(Git.layer, Vcs.layer).pipe(Layer.provideMerge(VcsProcess.layer));
    const sourceControl = SourceControl.layer.pipe(
      Layer.provide(SourceControlDrivers.layer),
      Layer.provide(vcs),
    );
    // Observe the real HTTP release after the coordinator's persisted finalize.
    // Even an erroneous release wakes the test, which asserts the actual state;
    // it cannot turn a failed resolution into a timeout-only oracle.
    const observedClient = Layer.effect(
      Client.MemoryHubClient,
      Effect.gen(function* () {
        const client = yield* Client.MemoryHubClient;
        return Client.MemoryHubClient.of({
          ...client,
          preflight: (connection) =>
            client.preflight(connection).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  probes++;
                }),
              ),
              Effect.tap(() => Deferred.succeed(probed, undefined)),
            ),
          pull: (connection, input) =>
            client
              .pull(connection, input)
              .pipe(
                Effect.tap(() => (observePull ? Deferred.succeed(pulled, undefined) : Effect.void)),
              ),
          requestSourceRead: (connection, input) =>
            client
              .requestSourceRead(connection, input)
              .pipe(Effect.tap((result) => Deferred.succeed(sourceRequested, result.request))),
          resultSourceRead: (connection, input) =>
            Effect.suspend(() =>
              (sourceResultGate ? Deferred.await(sourceResultGate) : Effect.void).pipe(
                Effect.andThen(client.resultSourceRead(connection, input)),
              ),
            ),
          release: (connection, input) =>
            client
              .release(connection, input)
              .pipe(
                Effect.onExit(() => Deferred.succeed(released, input.memoryId).pipe(Effect.asVoid)),
              ),
        });
      }),
    ).pipe(Layer.provideMerge(Runtime.layer));
    const observedRuntime = Layer.effect(
      Sync.MemorySyncRuntime,
      Effect.gen(function* () {
        const runtime = yield* Sync.MemorySyncRuntime;
        return Sync.MemorySyncRuntime.of({
          ...runtime,
          rearmEvents: runtime.rearmEvents!.pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                rearmObservations++;
              }),
            ),
          ),
        });
      }),
    ).pipe(Layer.provideMerge(observedClient));
    const syncLayer = Layer.mergeAll(Sync.layer, Worker.layer).pipe(
      Layer.provide(Maintenance.layer),
      Layer.provide(OrchestrationRuntime.layerEventSink),
      Layer.provide(RuntimeIdentity.layer),
      Layer.provideMerge(observedRuntime),
      Layer.provideMerge(Generation.layer.pipe(Layer.provide(sourceControl))),
      Layer.provideMerge(providers),
      Layer.provideMerge(Layer.succeedContext(baseContext)),
    );
    const context = yield* Layer.buildWithMemoMap(syncLayer, memoMap, scope);
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context);
    const identity = yield* run(
      Environment.ServerEnvironmentIdentity.use((s) => s.getEnvironmentId),
    );
    const admin = Context.get(context, Hub.MemoryHubAdministrator);
    const update: typeof admin.update = (input, permit) => run(admin.update(input, permit));
    const descriptor = run(Environment.ServerEnvironment.use((s) => s.getDescriptor));
    const serve = Effect.gen(function* () {
      const descriptorRoute = HttpRouter.add(
        "GET",
        GOAT_ENVIRONMENT_PATH,
        descriptor.pipe(
          Effect.map((view) =>
            HttpServerResponse.jsonUnsafe(
              descriptorHealthy
                ? view
                : { ...view, capabilities: { ...view.capabilities, memoryHubProtocolVersion: 99 } },
            ),
          ),
        ),
      );
      const served = yield* Layer.buildWithMemoMap(
        HttpRouter.serve(descriptorRoute, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(Layer.succeedContext(context)),
        ),
        memoMap,
        scope,
      );
      const server = Context.get(served, HttpServer.HttpServer);
      // layerTest listens on a wildcard address; clients must use loopback.
      const endpoint = new URL(HttpServer.formatAddress(server.address));
      endpoint.hostname = "127.0.0.1";
      return M.MemoryHubEndpoint.make(endpoint.origin);
    });
    const connection = run(
      Effect.gen(function* () {
        const snapshot = yield* (yield* Settings.MemoryHubCommittedSettings).read;
        if (snapshot.settings.mode !== "member")
          return yield* Effect.die("member configuration required");
        return { ...snapshot.settings, epoch: snapshot.version };
      }),
    );
    const sync = Context.get(context, Sync.MemorySyncService);
    const worker = Context.get(context, Worker.MemoryWorker);
    // Two explicit phases: receive/push, finish persisted scanner work, then
    // discover the newly eligible frontier. No polling or elapsed-time oracle.
    const tick = Effect.gen(function* () {
      yield* sync.syncOnce;
      yield* worker.drain;
      yield* sync.syncOnce;
      yield* worker.drain;
    });
    const startProduction = Layer.buildWithMemoMap(
      layerMemorySyncStarted.pipe(Layer.provide(Layer.succeedContext(context))),
      memoMap,
      scope,
    ).pipe(Effect.map((started) => Context.get(started, Sync.MemorySyncService)));
    const aggregate = (space: M.MemorySpaceId, memory: M.MemoryId) =>
      run(Store.MemoryStore.use((s) => s.loadAggregate(space, memory)));
    return {
      home,
      run,
      identity,
      update,
      descriptor,
      serve,
      connection,
      sync,
      worker,
      tick,
      selection,
      entered,
      aggregate,
      released,
      generated: () => generated,
      startProduction,
      setDescriptorHealthy: (healthy: boolean) => {
        descriptorHealthy = healthy;
      },
      probes: () => probes,
      rearmObservations: () => rearmObservations,
      probed,
      pulled,
      observeNextPull: () => {
        observePull = true;
      },
      sourceRequested,
      blockSourceResult: (gate: Deferred.Deferred<void>) => {
        sourceResultGate = gate;
      },
    };
  });

it.effect(
  "installCredential automatically bootstraps fresh production Sync for isolated H/A/B over real HTTP",
  () =>
    Effect.gen(function* () {
      const h = yield* environment("H");
      const a = yield* environment("A");
      const b = yield* environment("B");
      assert.strictEqual(new Set([h.home, a.home, b.home]).size, 3);
      assert.strictEqual(new Set([h.identity, a.identity, b.identity]).size, 3);
      assert.strictEqual((yield* h.descriptor).capabilities.memoryHubProtocolVersion, undefined);
      const configured = yield* h.update(
        {
          requestId: id(1),
          expectedVersion: 0,
          action: "configure",
          settings: { mode: "hub", memorySpaceId: null },
        },
        Effect.void,
      );
      if (
        configured.view.settings.mode !== "hub" ||
        configured.view.settings.memorySpaceId === null
      )
        return yield* Effect.die("hub configure did not publish a space");
      const space = configured.view.settings.memorySpaceId;
      const descriptor = yield* h.descriptor;
      assert.strictEqual(descriptor.environmentId, h.identity);
      assert.strictEqual(descriptor.capabilities.memoryHubProtocolVersion, 1);
      yield* h.run(
        Effect.gen(function* () {
          const store = yield* Store.MemoryStore;
          const self = yield* store.readHubMember(space, h.identity);
          assert.strictEqual(self?.status, "active");
          const retention = yield* store.transact(store.readHubRetentionTx(space));
          assert.strictEqual(retention.checkpointId, `initial-${id(1)}`);
        }),
      );
      const endpoint = yield* h.serve;
      for (const [index, member] of [a, b].entries()) {
        const current = yield* h.run(Settings.MemoryHubCommittedSettings.use((s) => s.read));
        const provisioned = yield* h.update(
          {
            requestId: id(10 + index),
            expectedVersion: current.version,
            action: "provisionMember",
            environmentId: member.identity,
          },
          Effect.void,
        );
        if (provisioned.credential === null)
          return yield* Effect.die("missing issued member credential");
        yield* member.update(
          {
            requestId: id(20 + index),
            expectedVersion: 0,
            action: "installCredential",
            hubEnvironmentId: h.identity,
            endpoint,
            memorySpaceId: space,
            credential: provisioned.credential.credential,
          },
          Effect.void,
        );
        const connection = yield* member.connection;
        const joined = yield* member.run(
          Client.MemoryHubClient.use((client) =>
            client.join(connection, {
              protocolVersion: 1,
              memorySpaceId: space,
              environmentId: member.identity,
            }),
          ),
        );
        assert.strictEqual(joined.hubEnvironmentId, h.identity);
        assert.strictEqual(joined.memorySpaceId, space);
        assert.strictEqual(joined.checkpointSequence, 0);
        assert.strictEqual(
          (yield* member.descriptor).capabilities.memoryHubProtocolVersion,
          undefined,
        );
        // A real join issues a token but cannot mark the replica bootstrap ready.
        const progress = yield* member.run(
          Store.MemoryStore.use((store) =>
            store.readBootstrap({
              memorySpaceId: space,
              hubEnvironmentId: h.identity,
            }),
          ),
        );
        assert.strictEqual(progress.state, "unbound");
        assert.strictEqual(yield* member.startProduction, member.sync);
        assert.deepStrictEqual(yield* member.sync.readLocalReadiness(), {
          memorySpaceId: space,
          bootstrap: "ready",
        });
        assert.strictEqual(
          (yield* member.run(
            Store.MemoryStore.use((store) =>
              store.readBootstrap({ memorySpaceId: space, hubEnvironmentId: h.identity }),
            ),
          )).state,
          "ready",
        );

        const fs = yield* FileSystem.FileSystem;
        const dbPath = yield* member.run(
          Config.ServerConfig.use((config) => Effect.succeed(config.dbPath)),
        );
        assert.isTrue(yield* fs.exists(dbPath));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

type Replica = Effect.Success<ReturnType<typeof environment>>;
const cluster = (resolveB?: Resolve) =>
  Effect.gen(function* () {
    const h = yield* environment("H");
    const a = yield* environment("A");
    const b = yield* environment("B", resolveB);
    const configured = yield* h.update(
      {
        requestId: id(1000),
        expectedVersion: 0,
        action: "configure",
        settings: { mode: "hub", memorySpaceId: null },
      },
      Effect.void,
    );
    if (configured.view.settings.mode !== "hub" || configured.view.settings.memorySpaceId === null)
      return yield* Effect.die("missing configured space");
    const space = configured.view.settings.memorySpaceId;
    const endpoint = yield* h.serve;
    for (const [index, member] of [a, b].entries()) {
      const view = yield* h.run(Settings.MemoryHubCommittedSettings.use((s) => s.read));
      const provisioned = yield* h.update(
        {
          requestId: id(1010 + index),
          expectedVersion: view.version,
          action: "provisionMember",
          environmentId: member.identity,
        },
        Effect.void,
      );
      if (provisioned.credential === null) return yield* Effect.die("missing issued credential");
      yield* member.update(
        {
          requestId: id(1020 + index),
          expectedVersion: 0,
          action: "installCredential",
          hubEnvironmentId: h.identity,
          endpoint,
          memorySpaceId: space,
          credential: provisioned.credential.credential,
        },
        Effect.void,
      );
      yield* member.run(
        Settings.ServerSettingsService.use((s) =>
          s.updateSettings({ defaultModelSelection: member.selection }),
        ),
      );
      yield* member.tick;
      assert.deepStrictEqual(yield* member.sync.readLocalReadiness(), {
        memorySpaceId: space,
        bootstrap: "ready",
      });
    }
    yield* h.tick;
    assert.deepStrictEqual(yield* h.sync.readLocalReadiness(), {
      memorySpaceId: space,
      bootstrap: "ready",
    });
    return { h, a, b, space };
  });
const memory = (n: number) =>
  M.MemoryId.make(`00000000-0000-4000-9000-${String(n).padStart(12, "0")}`);
const write = (
  replica: Replica,
  space: M.MemorySpaceId,
  target: M.MemoryId,
  n: number,
  text: string,
  expectedHeads: readonly M.MemoryRevisionId[] = [],
) =>
  replica.run(
    Service.MemoryService.use((s) =>
      s.upsert(
        {
          memorySpaceId: space,
          memoryId: target,
          operationId: id(n),
          expectedHeads,
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: { text, evidence: [], derivedFromMemoryRevisions: [] },
          baseBoundary: null,
        },
        Effect.void,
      ),
    ),
  );
const activeText = (aggregate: Store.MemoryAggregate) => {
  assert.strictEqual(aggregate.item?.status, "active");
  return aggregate.item?.status === "active" ? aggregate.item.payload.text : undefined;
};
const common = (c: Effect.Success<ReturnType<typeof cluster>>, target: M.MemoryId) =>
  Effect.gen(function* () {
    yield* write(c.a, c.space, target, 1100, "common parent");
    yield* c.a.tick;
    yield* c.b.tick;
    return (yield* c.a.aggregate(c.space, target)).heads;
  });

it.effect("a: A write propagates through real H HTTP to B", () =>
  Effect.gen(function* () {
    const c = yield* cluster();
    const target = memory(1);
    yield* write(c.a, c.space, target, 1101, "A shared fact");
    yield* c.a.tick;
    yield* c.b.tick;
    for (const replica of [c.a, c.h, c.b]) {
      assert.strictEqual(activeText(yield* replica.aggregate(c.space, target)), "A shared fact");
      assert.strictEqual(replica.generated(), 0);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("b: A forget dominates B concurrent edit and purges every replica", () =>
  Effect.gen(function* () {
    const c = yield* cluster();
    const target = memory(2);
    const heads = yield* common(c, target);
    yield* write(c.b, c.space, target, 1102, "B offline concurrent edit", heads);
    yield* c.a.run(
      Service.MemoryService.use((s) =>
        s.forget(
          { memorySpaceId: c.space, memoryId: target, operationId: id(1103), expectedHeads: heads },
          Effect.void,
        ),
      ),
    );
    yield* c.a.tick;
    yield* c.b.tick;
    yield* c.a.tick;
    for (const replica of [c.a, c.h, c.b]) {
      const aggregate = yield* replica.aggregate(c.space, target);
      assert.strictEqual(aggregate.item?.status, "forgotten");
      assert.isDefined(aggregate.tombstone);
      assert.isTrue(aggregate.revisions.every((r) => r.payload === null));
      assert.strictEqual(replica.generated(), 0);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "c: one conflicted memory is quarantined while unrelated memory continues during a blocked provider",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster(() => Effect.never);
      const target = memory(3);
      const heads = yield* common(c, target);
      yield* write(c.a, c.space, target, 1110, "A version", heads);
      yield* write(c.b, c.space, target, 1111, "B version", heads);
      yield* c.a.tick;
      yield* c.b.tick;
      const input = yield* Deferred.await(c.b.entered);
      assert.strictEqual(input.memoryId, target);
      assert.strictEqual((yield* c.h.aggregate(c.space, target)).item?.status, "quarantined");
      assert.strictEqual((yield* c.b.aggregate(c.space, target)).item?.status, "quarantined");
      const other = memory(30);
      yield* write(c.a, c.space, other, 1112, "unrelated healthy fact");
      yield* c.a.tick;
      yield* c.b.tick;
      assert.strictEqual(
        activeText(yield* c.b.aggregate(c.space, other)),
        "unrelated healthy fact",
      );
      assert.strictEqual((yield* c.b.aggregate(c.space, target)).item?.status, "quarantined");
      assert.strictEqual(c.b.generated(), 1);
      assert.strictEqual(c.a.generated(), 0);
      yield* c.b.sync.shutdown;
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "d/f: first observer B automatically resolves with its default provider and one revert reaches all replicas",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster();
      const target = memory(4);
      const heads = yield* common(c, target);
      yield* write(c.a, c.space, target, 1120, "A original", heads);
      yield* write(c.b, c.space, target, 1121, "B original", heads);
      const aHead = (yield* c.a.aggregate(c.space, target)).heads[0]!;
      const bHead = (yield* c.b.aggregate(c.space, target)).heads[0]!;
      yield* c.a.tick;
      yield* c.b.tick;
      assert.strictEqual(yield* Deferred.await(c.b.released), target);
      yield* c.b.worker.drain;
      const input = yield* Deferred.await(c.b.entered);
      assert.deepStrictEqual(input.modelSelection, c.b.selection);
      assert.strictEqual(c.b.generated(), 1);
      assert.strictEqual(c.a.generated(), 0);
      yield* c.a.tick;
      const resolved = yield* c.b.aggregate(c.space, target);
      const resolution = resolved.resolutions[0]!;
      assert.deepStrictEqual([...resolution.inputRevisionIds].sort(), [aHead, bHead].sort());
      assert.strictEqual(resolution.resolvingEnvironmentId, c.b.identity);
      assert.deepStrictEqual(resolution.requestedModelSelection, c.b.selection);
      assert.strictEqual(resolution.effectiveProvider, "codex");
      assert.strictEqual(resolution.effectiveModel, "model-B");
      const history = yield* c.b.run(
        Service.MemoryService.use((s) =>
          s.history({ memorySpaceId: c.space, memoryId: target, limit: 100 }, Effect.void),
        ),
      );
      assert.deepStrictEqual(
        history.revisions
          .filter((r) => [aHead, bHead].includes(r.revision.revisionId))
          .map((r) => r.payload?.text)
          .sort(),
        ["A original", "B original"],
      );
      assert.strictEqual(
        history.resolutions[0]?.payload?.judgment,
        "combine both synthetic versions",
      );
      for (const replica of [c.a, c.h, c.b])
        assert.strictEqual(
          activeText(yield* replica.aggregate(c.space, target)),
          "resolved synthetic fact",
        );
      yield* c.b.run(
        Service.MemoryService.use((s) =>
          s.revertResolution(
            {
              memorySpaceId: c.space,
              memoryId: target,
              operationId: id(1122),
              resolutionId: resolution.resolutionId,
              restoredRevisionId: aHead,
              expectedHeads: resolved.heads,
            },
            Effect.void,
          ),
        ),
      );
      yield* c.b.tick;
      yield* c.a.tick;
      for (const replica of [c.a, c.h, c.b])
        assert.strictEqual(activeText(yield* replica.aggregate(c.space, target)), "A original");
      assert.strictEqual(c.b.generated(), 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "e: departed holder cannot release and A takes over only after the hub lease expires",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster(() => Effect.never);
      const target = memory(5);
      const heads = yield* common(c, target);
      yield* write(c.a, c.space, target, 1130, "A takeover original", heads);
      yield* write(c.b, c.space, target, 1131, "B takeover original", heads);
      yield* c.a.tick;
      yield* c.b.tick;
      yield* Deferred.await(c.b.entered);
      // Revocation models loss of the departed device's authenticated transport.
      // Its real HTTP release is denied, leaving the hub lease to expire naturally.
      const view = yield* c.h.run(Settings.MemoryHubCommittedSettings.use((s) => s.read));
      yield* c.h.update(
        {
          requestId: id(1132),
          expectedVersion: view.version,
          action: "revokeMember",
          environmentId: c.b.identity,
        },
        Effect.void,
      );
      yield* c.b.sync.shutdown;
      yield* c.a.tick;
      assert.strictEqual(c.a.generated(), 0);
      assert.strictEqual((yield* c.h.aggregate(c.space, target)).item?.status, "quarantined");
      yield* TestClock.adjust("120 seconds");
      yield* c.a.tick;
      assert.strictEqual(yield* Deferred.await(c.a.released), target);
      yield* c.a.worker.drain;
      if (c.a.generated() !== 1) {
        const status = yield* c.a.sync.syncStatus({}, Effect.void);
        const snapshot = yield* c.a.run(
          Store.MemoryStore.use((store) => store.readResolutionSnapshot(c.space, target)),
        );
        const tickets = yield* c.a.run(
          Store.MemoryStore.use((store) =>
            store.readRecoverableResolutionTickets({
              memorySpaceId: c.space,
              now: Number.MAX_SAFE_INTEGER,
              limit: 100,
            }),
          ),
        );
        assert.fail(
          JSON.stringify({
            generated: c.a.generated(),
            now: yield* Clock.currentTimeMillis,
            failureCode: status.failureCode,
            status: snapshot.status,
            reasons: snapshot.reasons,
            lease: snapshot.fence?.activeLease,
            tickets: tickets.map((row) => ({
              state: row.state,
              nextAttemptAt: row.nextAttemptAt,
              ownedUntil: row.ownedUntil,
              leaseExpires: row.ticket.expiresAtHubTime,
            })),
          }),
        );
      }
      assert.strictEqual(c.a.generated(), 1);
      assert.strictEqual(
        (yield* c.h.aggregate(c.space, target)).resolutions[0]?.resolvingEnvironmentId,
        c.a.identity,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "requester receives terminal denied from fail-closed owner while unrelated HTTP sync continues",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster();
      const target = memory(6);
      const sourceThread = {
        environmentId: c.b.identity,
        threadId: M.ThreadId.make("synthetic-owner-thread"),
      };
      const watermark = {
        fromEventId: M.EventId.make("synthetic-from"),
        toEventId: M.EventId.make("synthetic-to"),
        throughSequence: 8,
      };
      const messageId = M.MessageId.make("synthetic-owner-message");
      const operation: Extract<M.MemoryOperation, { kind: "upsert" }> = {
        protocolVersion: 1,
        kind: "upsert",
        memorySpaceId: c.space,
        memoryId: target,
        operationId: id(1140),
        originEnvironmentId: c.a.identity,
        expectedHeads: [],
        revision: {
          memorySpaceId: c.space,
          memoryId: target,
          operationId: id(1140),
          revisionId: M.MemoryRevisionId.make(id(1141)),
          payloadRef: M.MemoryRevisionId.make(id(1141)),
          parents: [],
          scope: { kind: "user" },
          assertionKind: "inference",
          createdAtUtc: M.MemoryUtcTimestamp.make("1970-01-01T00:00:00.000Z"),
          provenance: { environmentId: c.a.identity, sourceThread, sourceWatermark: watermark },
        },
        payload: {
          text: "synthetic linked summary",
          evidence: [{ origin: "thread", sourceThread, watermark, messageIds: [messageId] }],
          derivedFromMemoryRevisions: [],
        },
      };
      const connection = yield* c.a.connection;
      yield* c.a.run(
        Client.MemoryHubClient.use((client) =>
          client.push(connection, {
            protocolVersion: 1,
            memorySpaceId: c.space,
            environmentId: c.a.identity,
            operations: [operation],
          }),
        ),
      );
      yield* c.a.tick;
      const validated = yield* c.a.run(
        Service.MemoryService.use((service) =>
          service.prepareSourceRead(
            {
              memorySpaceId: c.space,
              memoryId: target,
              sourceThread,
              messageIds: [messageId],
              limit: 10,
            },
            Effect.void,
          ),
        ),
      );
      const resultGate = yield* Deferred.make<void>();
      c.a.blockSourceResult(resultGate);
      const requester = yield* c.a.sync.readSource(validated, Effect.void).pipe(Effect.forkScoped);
      const request = yield* Deferred.await(c.a.sourceRequested);
      const denied = yield* c.b.run(
        Sync.MemorySyncRuntime.use((runtime) => Effect.result(runtime.ownerPermit(request))),
      );
      assert.strictEqual(denied._tag, "Failure");
      if (denied._tag === "Failure") {
        assert.strictEqual(denied.failure._tag, "MemoryAccessError");
        assert.strictEqual(denied.failure.code, "route_unavailable");
      }
      const other = memory(60);
      yield* write(c.b, c.space, other, 1143, "ordinary sync survives source denial");
      yield* c.b.tick;
      assert.strictEqual(
        activeText(yield* c.h.aggregate(c.space, other)),
        "ordinary sync survives source denial",
      );
      const status = yield* c.b.sync.syncStatus({}, Effect.void);
      assert.strictEqual(status.failureCode, "route_unavailable");
      yield* Deferred.succeed(resultGate, undefined);
      assert.deepStrictEqual(yield* Fiber.join(requester), {
        kind: "denied",
        requiredPermission: "orchestration:read",
      });
      const outcome = yield* c.a.run(
        Client.MemoryHubClient.use((client) =>
          client.resultSourceRead(connection, {
            protocolVersion: 1,
            memorySpaceId: c.space,
            requestId: request.requestId,
          }),
        ),
      );
      assert.strictEqual(outcome.state, "completed");
      if (outcome.state !== "completed") return yield* Effect.die("source request stayed pending");
      assert.deepStrictEqual(outcome.outcome, {
        kind: "denied",
        requiredPermission: "orchestration:read",
      });
      yield* c.a.tick;
      assert.strictEqual(
        activeText(yield* c.a.aggregate(c.space, other)),
        "ordinary sync survives source denial",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "production scoped startup reuses Sync and exposes real unbound processing and storage",
  () =>
    Effect.gen(function* () {
      const replica = yield* environment("A");
      assert.strictEqual(yield* replica.startProduction, replica.sync);
      assert.strictEqual(yield* replica.startProduction, replica.sync);
      yield* replica.run(
        Sync.MemorySyncRuntime.use((runtime) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* runtime.readIntentBinding!, {
              memorySpaceId: null,
              coordinatorEpoch: 0,
              enabled: false,
            });
            const processing = yield* runtime.readProcessing(null, null);
            assert.strictEqual(processing.pendingSync, 0);
            assert.strictEqual(processing.quarantined, 0);
            const storage = yield* runtime.readUnboundStorage;
            assert.strictEqual(storage.checkpointSequence, 0);
            assert.strictEqual(storage.retentionFloor, 0);
            const status = yield* replica.sync.syncStatus({}, Effect.void);
            assert.strictEqual(status.state, "disabled");
            assert.strictEqual(status.memorySpaceId, null);
            assert.deepStrictEqual(status.processing, processing.processing);
          }),
        ),
      );
      yield* replica.worker.start();
      yield* replica.worker.drain;
      assert.strictEqual(replica.generated(), 0);
      yield* replica.sync.shutdown;
      assert.strictEqual(yield* replica.sync.activeResolutions, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "hub device writes propagate H to A/B and A writes reach H local replica over real HTTP",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster();
      const fromHub = memory(70);
      yield* write(c.h, c.space, fromHub, 1170, "H device memory");
      yield* c.h.tick;
      yield* c.a.tick;
      yield* c.b.tick;
      for (const replica of [c.h, c.a, c.b])
        assert.strictEqual(
          activeText(yield* replica.aggregate(c.space, fromHub)),
          "H device memory",
        );
      const fromA = memory(71);
      yield* write(c.a, c.space, fromA, 1171, "A device memory");
      yield* c.a.tick;
      yield* c.h.tick;
      yield* c.b.tick;
      for (const replica of [c.h, c.a, c.b]) {
        assert.strictEqual(activeText(yield* replica.aggregate(c.space, fromA)), "A device memory");
        assert.strictEqual(replica.generated(), 0);
      }
      assert.strictEqual((yield* c.h.sync.readLocalReadiness()).bootstrap, "ready");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "production adapter and recovery probe recover one protocol hold without duplicate rearm observations",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster();
      c.h.setDescriptorHealthy(false);
      yield* c.a.sync.syncOnce;
      const retry = () =>
        c.a.run(
          Store.MemoryStore.use((store) =>
            store.readPullRetry({
              memorySpaceId: c.space,
              hubEnvironmentId: c.h.identity,
            }),
          ),
        );
      assert.strictEqual((yield* retry()).holdClass, "protocol");
      assert.strictEqual((yield* retry()).nextAttemptAt, Number.MAX_SAFE_INTEGER);
      c.h.setDescriptorHealthy(true);
      c.a.observeNextPull();
      yield* c.a.startProduction;
      assert.strictEqual(c.a.probes(), 0);
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(c.a.probed);
      yield* Deferred.await(c.a.pulled);
      yield* c.a.tick;
      assert.strictEqual((yield* retry()).holdClass, null);
      assert.strictEqual(c.a.probes(), 1);
      assert.strictEqual(c.a.rearmObservations(), 0);
      yield* c.a.tick;
      assert.strictEqual(c.a.probes(), 1);
      assert.strictEqual(c.a.rearmObservations(), 0);
      yield* c.a.sync.shutdown;
    }).pipe(Effect.provide(NodeServices.layer)),
);
