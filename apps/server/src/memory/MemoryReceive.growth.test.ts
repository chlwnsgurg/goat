import { assert, it, describe } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Console from "effect/Console";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Settings from "../serverSettings.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import { scanUsage } from "./MemoryUsageScan.testkit.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const environmentId = M.EnvironmentId.make("fixture");
const database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const store = Store.layer.pipe(Layer.provideMerge(database));
const serviceLive = (
  serviceLayer = Service.layer,
  readSettings: Settings.MemoryHubCommittedSettings["Service"]["read"] = Effect.succeed({
    settings: { mode: "hub" as const, memorySpaceId: space },
    version: 1,
  }),
) =>
  serviceLayer.pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: readSettings,
      }),
    ),
    Layer.provide(
      Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
    Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(store))),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
  );
const live = serviceLive();

const operation = (n: number, chain = false): M.MemoryOperation =>
  Schema.decodeUnknownSync(M.MemoryOperation)({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: id(chain ? 10 : 10000 + n),
    operationId: id(20000 + n),
    originEnvironmentId: environmentId,
    expectedHeads: chain && n > 0 ? [id(30000 + n - 1)] : [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: id(chain ? 10 : 10000 + n),
      revisionId: id(30000 + n),
      operationId: id(20000 + n),
      parents: chain && n > 0 ? [id(30000 + n - 1)] : [],
      scope: { kind: "user" },
      payloadRef: id(30000 + n),
      assertionKind: "inference",
      provenance: { environmentId },
      createdAtUtc: "2026-10-14T00:00:00.000Z",
    },
    payload: {
      text: "synthetic receive performance fixture",
      evidence: [],
      derivedFromMemoryRevisions: [],
    },
  });
const receive = (op: M.MemoryOperation, n: number) =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    return yield* service.applyReceived(op, {
      operationId: op.operationId,
      memoryId: op.memoryId,
      operationDigest: memoryOperationDigest(op),
      outcome: "accepted",
      hubSequence: n + 1,
    });
  });
const check = Effect.gen(function* () {
  const storage = yield* Store.MemoryStore;
  assert.deepStrictEqual(
    yield* storage.usage(space, { kind: "user" }),
    yield* scanUsage(space, { kind: "user" }),
  );
});

describe.runIf(process.env.GOAT_MEMORY_GROWTH === "1")("service receive scaling", () => {
  it.effect(
    "1k / 2k independent memories and separate long chains",
    () =>
      Effect.gen(function* () {
        const samples: { chain: boolean; count: number; ms: number }[] = [];
        for (const chain of [false, true]) {
          for (const count of chain ? [250, 500] : [1000, 2000]) {
            const ms = yield* Effect.gen(function* () {
              const start = performance.now();
              for (let n = 0; n < count; n++) yield* receive(operation(n, chain), n);
              const elapsed = performance.now() - start;
              yield* check;
              return elapsed;
            }).pipe(Effect.provide(live));
            samples.push({ chain, count, ms });
            yield* Console.log("RECEIVE_SAMPLE " + JSON.stringify(samples.at(-1)));
          }
        }
        const ratio = samples[1]!.ms / samples[0]!.ms;
        yield* Console.log(
          "RECEIVE_RATIO " +
            JSON.stringify({ independent: ratio, chain: samples[3]!.ms / samples[2]!.ms }),
        );
        // Large samples absorb startup/JIT noise; optional scheduled benchmark, no millisecond deadline.
        if (process.env.GOAT_RECEIVE_BASELINE !== "1") assert.isBelow(ratio, 3.25);
      }),
    { timeout: 1500000 },
  );
});
