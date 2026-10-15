import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Worker from "./MemoryWorker.ts";

const environmentId = M.EnvironmentId.make("fresh-database");
const database = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "memory-sweep-fresh-" });
    return Sqlite.layerFromPath(`${home}/statev2.sqlite`);
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
const storage = Store.layer.pipe(Layer.provideMerge(database));
const quota = Quota.layer.pipe(Layer.provideMerge(storage));
const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(environmentId),
});
const service = Service.layer.pipe(
  Layer.provideMerge(quota),
  Layer.provide(identity),
  Layer.provide(
    Layer.mock(Repository.RepositoryIdentityResolver)({ resolve: () => Effect.succeed(null) }),
  ),
);
const live = (hub = false, configured = false) =>
  Worker.layer.pipe(
    Layer.provideMerge(service),
    Layer.provideMerge(Maintenance.layer.pipe(Layer.provideMerge(quota))),
    Layer.provide(identity),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Settings.layerTest({
        ...(hub
          ? {
              memoryHub: {
                mode: "hub",
                memorySpaceId: M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001"),
              },
            }
          : {}),
        ...(configured
          ? {
              defaultModelSelection: {
                instanceId: M.ProviderInstanceId.make("fixture"),
                model: "fixture",
              },
            }
          : {}),
      }),
    ),
    Layer.provide(Layer.succeed(RuntimeIdentity.RuntimeIdentity, { instanceId: "fresh-worker" })),
    Layer.provide(Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty })),
    Layer.provide(
      Layer.mock(Generation.TextGeneration)({
        generateMemorySummary: () => Effect.die("empty database must not invoke a provider"),
      }),
    ),
  );

it.effect("sweeps an empty database migrated through 073 with the default disabled hub", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-15T00:00:00.000Z"));
    const worker = yield* Worker.MemoryWorker;
    const store = yield* Store.MemoryStore;
    yield* worker.sweepDue();
    assert.strictEqual(yield* store.readThreadHookWatermark(), 0);
    yield* worker.start();
    yield* worker.drain;
    assert.strictEqual((yield* store.ftsState(environmentId)).state, "open");
  }).pipe(Effect.scoped, Effect.provide(live())),
);

for (const hub of [false, true]) {
  for (const configured of [false, true]) {
    it.effect(`advances past a non-summary thread event (hub=${hub}, model=${configured})`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES ('fresh-event','thread','fresh-thread',0,'thread.created','2026-10-15T00:00:00.000Z','server','{}','{}',2)`;
        const worker = yield* Worker.MemoryWorker;
        yield* worker.sweepDue();
        const store = yield* Store.MemoryStore;
        assert.strictEqual(yield* store.readThreadHookWatermark(), 1);
      }).pipe(Effect.provide(live(hub, configured))),
    );
  }
}
