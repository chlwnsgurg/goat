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
import { layerMemoryHubServices, layerMemoryHubRoutes } from "../server.ts";

const id = (n: number) =>
  M.MemoryOperationId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

// This fixture proves the production Hub/Client prerequisites. It deliberately
// does not stand in for the missing application-owned Sync authorization/reader.
const environment = (label: "H" | "A" | "B") =>
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
      Layer.provideMerge(HttpRouter.layer),
    );
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Scope.Scope;
    const context = yield* Layer.buildWithMemoMap(application, memoMap, scope);
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
        descriptor.pipe(Effect.map(HttpServerResponse.jsonUnsafe)),
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
      return M.MemoryHubEndpoint.make(HttpServer.formatAddress(server.address));
    });
    const connection = run(
      Effect.gen(function* () {
        const snapshot = yield* (yield* Settings.MemoryHubCommittedSettings).read;
        if (snapshot.settings.mode !== "member")
          return yield* Effect.die("member configuration required");
        return { ...snapshot.settings, epoch: snapshot.version };
      }),
    );
    return { home, run, identity, update, descriptor, serve, connection };
  });

it.effect(
  "H/A/B use isolated file stores and the same administrator/descriptor identity through real HTTP join",
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
        const fs = yield* FileSystem.FileSystem;
        const dbPath = yield* member.run(
          Config.ServerConfig.use((config) => Effect.succeed(config.dbPath)),
        );
        assert.isTrue(yield* fs.exists(dbPath));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
