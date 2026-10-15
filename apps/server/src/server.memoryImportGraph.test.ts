import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as RpcTest from "effect/rpc/RpcTest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- independent synthetic source hash/mtime oracle.
import * as FS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- independent synthetic source hash oracle.
import * as Crypto from "node:crypto";
import * as Config from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as Secrets from "./auth/ServerSecretStore.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as Environment from "./environment/ServerEnvironment.ts";
import * as Repository from "./project/RepositoryIdentityResolver.ts";
import * as Store from "./memory/MemoryStore.ts";
import * as Quota from "./memory/MemoryQuotaService.ts";
import * as Service from "./memory/MemoryService.ts";
import * as Sync from "./memory/MemorySyncService.ts";
import * as Hub from "./memory/MemoryHubService.ts";
import * as Generation from "./textGeneration/TextGeneration.ts";
import * as Registry from "./provider/ProviderInstanceRegistry.ts";
import * as Authorization from "./auth/RpcAuthorization.ts";
import {
  RpcInstrumentation,
  rpcInstrumentationLayer as instrumentation,
} from "./observability/RpcInstrumentation.ts";
import { makeMemoryImportHandlers } from "./ws.ts";
import { ProviderMemoryImportRuntime } from "./memory/imports/MemoryImportTypes.ts";
import {
  buildMemoryImportFixture,
  captureMemoryImportInventory,
  type MemoryImportFixtureProfile,
} from "./memory/imports/MemoryImportFixtures.fixture.ts";
import {
  layerMemoryImport,
  layerMemoryHubServices,
  layerMemoryHubRoutes,
  layerMemorySourceReadService,
  layerMemorySourceReadBinding,
  layerMemorySyncRuntime,
  MemorySourceReadBinding,
} from "./server.ts";

const grants = ["memory:write", "filesystem:read"] as const;
const id = () => M.MemoryOperationId.make(Crypto.randomUUID());
// This constructs the application's layers, including durable SQL, settings, identity,
// real Sync/Hub and the same scoped reader/factory used by server.ts. Only unused
// provider generation/registry boundaries are doubles; import has no mocked ports.
const graph = (config: Parameters<typeof layerMemoryImport>[0]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "wp5-import-graph-" });
    const memo = yield* Layer.makeMemoMap;
    const scope = yield* Scope.Scope;
    const settings = Settings.layer.pipe(
      Layer.provide(Environment.layerIdentity),
      Layer.provideMerge(Secrets.layer),
      Layer.provideMerge(Sqlite.layerConfig),
      Layer.provideMerge(Config.layerTest(home, home)),
    );
    const core = layerMemorySourceReadService.pipe(
      Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
      Layer.provideMerge(layerMemorySourceReadBinding),
      Layer.provideMerge(Environment.layerIdentity),
      Layer.provide(Repository.layer),
    );
    const services = layerMemoryHubServices.pipe(
      Layer.provideMerge(core),
      Layer.provideMerge(settings),
    );
    const base = yield* Layer.buildWithMemoMap(
      services.pipe(Layer.provideMerge(NodeServices.layer)),
      memo,
      scope,
    );
    const sync = Sync.layer.pipe(
      Layer.provideMerge(layerMemorySyncRuntime),
      Layer.provide(Layer.mock(Generation.TextGeneration)({})),
      Layer.provide(
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(undefined),
        }),
      ),
      Layer.provideMerge(Layer.succeedContext(base)),
      Layer.provide(FetchHttpClient.layer),
    );
    const context = yield* Layer.buildWithMemoMap(
      layerMemoryImport(config).pipe(Layer.provideMerge(sync)),
      memo,
      scope,
    );
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideContext(context));
    const service = Context.get(context, Service.MemoryService);
    const memorySync = Context.get(context, Sync.MemorySyncService);
    yield* Context.get(context, MemorySourceReadBinding).bind(memorySync);
    const configured = yield* run(
      Hub.MemoryHubAdministrator.use((a) =>
        a.update(
          {
            requestId: id(),
            expectedVersion: 0,
            action: "configure",
            settings: { mode: "hub", memorySpaceId: null },
          },
          Effect.void,
        ),
      ),
    );
    assert.equal(configured.view.settings.mode, "hub");
    if (configured.view.settings.mode !== "hub") return yield* Effect.die("hub required");
    const space = configured.view.settings.memorySpaceId!;
    const routes = layerMemoryHubRoutes.pipe(
      HttpRouter.provideRequest(Layer.succeedContext(context)),
      Layer.provide(Layer.succeedContext(context)),
    );
    const descriptorContext = yield* Layer.buildWithMemoMap(
      Environment.layer.pipe(
        Layer.provideMerge(routes),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provide(HttpRouter.layer),
      ),
      memo,
      scope,
    );
    const descriptor = yield* Environment.ServerEnvironment.use((s) => s.getDescriptor).pipe(
      Effect.provideContext(descriptorContext),
    );
    const live = yield* Ref.make<readonly M.AuthEnvironmentScope[]>(grants);
    const group = M.WsMemoryImportRpcGroup.middleware(RpcInstrumentation);
    const handlers = group.toLayer(makeMemoryImportHandlers(Ref.get(live), grants));
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          handlers.pipe(Layer.provide(Layer.succeedContext(context))),
          instrumentation,
          Authorization.layer(grants),
        ),
      ),
    );
    return {
      run,
      service,
      space,
      descriptor,
      live,
      call: client[M.WS_METHODS.memoryImportProvider],
      tick: memorySync.syncOnce,
      context,
    };
  });
const stamp = (root: string) => {
  const result: Record<string, { hash: string; mtime: string }> = {};
  const walk = (dir: string) => {
    for (const name of FS.readdirSync(dir).sort()) {
      const path = `${dir}/${name}`;
      const stat = FS.lstatSync(path, { bigint: true });
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile())
        result[path.slice(root.length + 1)] = {
          hash: Crypto.createHash("sha256").update(FS.readFileSync(path)).digest("hex"),
          mtime: String(stat.mtimeNs),
        };
    }
  };
  walk(root);
  return result;
};

it.effect.each(["codex-handbook-v1", "claude-topic-v1", "omo-memory-core-beta63"] as const)(
  "c-6 assembled %s imports with provenance and unchanged original bytes/mtime",
  (profile: MemoryImportFixtureProfile) =>
    Effect.gen(function* () {
      const fixture = yield* buildMemoryImportFixture(profile);
      let reads = 0;
      const before = stamp(fixture.sourceRoot);
      const inventory = captureMemoryImportInventory(fixture.sourceRoot);
      const g = yield* graph({
        stateDir: fixture.stateDir,
        roots: [
          {
            format: fixture.snapshot.format,
            rootSlot: "synthetic",
            path: fixture.snapshot.format === "codex" ? fixture.sourceRoot : fixture.trustedRoot,
          },
        ],
        onSourceRead: () => {
          reads++;
        },
      });
      assert.equal(g.descriptor.capabilities.memory?.protocolVersion, 1);
      assert.equal(g.descriptor.capabilities.memory?.importProvider, true);
      assert.equal(g.descriptor.capabilities.memoryHubProtocolVersion, 1);
      const discovered = yield* g.call({
        action: "discover",
        memorySpaceId: g.space,
        format: fixture.snapshot.format,
      });
      assert.equal(discovered.action, "discover");
      if (discovered.action !== "discover") return;
      assert.lengthOf(discovered.sources, 1);
      const sourceId = discovered.sources[0]!.sourceId;
      const preview = yield* g.call({ action: "preview", memorySpaceId: g.space, sourceId });
      if (preview.action !== "preview") return assert.fail("preview");
      const apply: M.MemoryImportProviderInput = {
        action: "apply",
        memorySpaceId: g.space,
        sourceId,
        sessionId: preview.sessionId,
        operationId: id(),
        items: preview.items.map((item) => ({
          sourceItemKey: item.sourceItemKey,
          sourceFingerprint: item.sourceFingerprint!,
          scope: { kind: "user" },
        })),
      };
      const applied = yield* g.call(apply);
      if (applied.action !== "apply") return assert.fail("apply");
      assert.equal(applied.receipt.state, "completed");
      assert.lengthOf(applied.receipt.items, 1);
      assert.equal(applied.receipt.items[0]!.outcome, "imported");
      // Real hub admission and ACK settle the ordinary pending local import.
      yield* g.tick;
      const readCount = reads;
      const status = yield* g.call({
        action: "status",
        memorySpaceId: g.space,
        operationId: apply.operationId,
      });
      assert.equal(reads, readCount);
      if (status.action !== "status") return assert.fail("status");
      assert.equal(status.receipt.state, "completed");
      const memoryId = applied.receipt.items[0]!.memoryId!;
      const item = yield* g.service.read({ memorySpaceId: g.space, memoryId }, Effect.void);
      assert.equal(item.status, "active");
      if (item.status !== "active") return assert.fail("active memory");
      const sql = yield* g.run(
        Store.MemoryStore.use((s) => s.readImportLineage(g.space, memoryId)),
      );
      assert.isTrue(
        sql.some(
          (row) =>
            row.kind === "sourceKey" &&
            row.sourceKey.sourceId === sourceId &&
            row.sourceKey.sourceItemKey === preview.items[0]!.sourceItemKey,
        ),
      );
      const serialized = JSON.stringify(item);
      assert.include(serialized, sourceId);
      assert.include(serialized, preview.items[0]!.sourceItemKey);
      assert.include(serialized, fixture.snapshot.format);
      // Every action reuses the live compound permit, including source-free status.
      for (const missing of grants) {
        yield* Ref.set(
          g.live,
          grants.filter((scope) => scope !== missing),
        );
        for (const input of [
          { action: "discover", memorySpaceId: g.space, format: fixture.snapshot.format },
          { action: "preview", memorySpaceId: g.space, sourceId },
          apply,
          { action: "status", memorySpaceId: g.space, operationId: apply.operationId },
        ] as const) {
          assert.equal((yield* g.call(input).pipe(Effect.flip))._tag, "MemoryRpcError");
        }
      }
      yield* Ref.set(g.live, grants);
      if (fixture.snapshot.format === "codex") {
        const heads = [item.revision.revisionId];
        yield* g.service.forget(
          { memorySpaceId: g.space, memoryId, operationId: id(), expectedHeads: heads },
          Effect.void,
        );
        yield* g.tick;
        const retry = yield* g.call({ action: "preview", memorySpaceId: g.space, sourceId });
        if (retry.action !== "preview") return assert.fail("retry preview");
        assert.equal(retry.items[0]!.priorOutcome, "suppressed");
        const refused = yield* g.call({ ...apply, operationId: id(), sessionId: retry.sessionId });
        if (refused.action !== "apply") return assert.fail("retry apply");
        assert.equal(refused.receipt.items[0]!.outcome, "suppressed");
      }
      assert.deepEqual(stamp(fixture.sourceRoot), before);
      assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), inventory);
      const evidence = {
        provider: fixture.snapshot.format,
        sourceId,
        sourceItemKey: preview.items[0]!.sourceItemKey,
        before,
        after: stamp(fixture.sourceRoot),
        receipt: status.receipt,
      };
      // Persist synthetic evidence outside the checkout when the remote runner requests it.
      if (process.env.WP5_IMPORT_EVIDENCE_DIR)
        FS.writeFileSync(
          `${process.env.WP5_IMPORT_EVIDENCE_DIR}/${fixture.snapshot.format}.json`,
          JSON.stringify(evidence, null, 2),
        );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120000 },
);

it.effect(
  "reader acquisition failure preserves core and hub capability without advertising import",
  () =>
    Effect.gen(function* () {
      const g = yield* graph({ stateDir: "relative-invalid", roots: [] });
      assert.equal(g.descriptor.capabilities.memory?.protocolVersion, 1);
      assert.isUndefined(g.descriptor.capabilities.memory?.importProvider);
      assert.equal(g.descriptor.capabilities.memoryHubProtocolVersion, 1);
      assert.equal(
        (yield* g
          .call({ action: "discover", memorySpaceId: g.space, format: "codex" })
          .pipe(Effect.flip))._tag,
        "MemoryRpcError",
      );
      assert.equal(
        (yield* Effect.serviceOption(ProviderMemoryImportRuntime).pipe(
          Effect.provideContext(g.context),
        ))._tag,
        "None",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120000 },
);
