import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const decodeOperationEffect = Schema.decodeUnknownEffect(M.MemoryOperation);
const operation = (n: number, chain = false): M.MemoryOperation =>
  decodeOperation({
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

it.effect(
  "received create/update, replay, forget, outbox, receipt replacement and rollback match scan",
  () =>
    Effect.gen(function* () {
      const storage = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* check;
      for (let n = 0; n < 5; n++) {
        yield* receive(operation(n, true), n);
        yield* check;
      }
      yield* receive(operation(4, true), 4);
      yield* check;
      const before = yield* storage.usage(space, { kind: "user" });
      yield* storage
        .transact(receive(operation(5, true), 5).pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.exit);
      assert.deepStrictEqual(yield* storage.usage(space, { kind: "user" }), before);
      yield* check;
      yield* sql`UPDATE memory_revisions SET provenance_json=json_set(provenance_json,'$.sourceThread','synthetic') WHERE revision_id=${id(30004)}`;
      yield* check;
      yield* sql`UPDATE memory_payloads SET body_json=json_set(body_json,'$.text','한글 synthetic replacement') WHERE payload_ref=${id(30004)}`;
      yield* check;
      yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,attempt,next_attempt_at) VALUES ('test',${space},${id(10)},'admin','pending','{}',0,0)`;
      yield* check;
      yield* sql`UPDATE memory_outbox SET status='completed' WHERE id='test'`;
      yield* check;
      yield* sql`DELETE FROM memory_outbox WHERE id='test'`;
      yield* check;
      const service = yield* Service.MemoryService;
      const op = yield* decodeOperationEffect({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: id(10),
        operationId: id(90000),
        originEnvironmentId: environmentId,
        expectedHeads: [id(30004)],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: id(10),
          deleteOperationId: id(90000),
          deletingEnvironmentId: environmentId,
          deletedAtUtc: "2026-10-14T00:00:00.000Z",
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* service.applyReceived(op, {
        operationId: op.operationId,
        memoryId: op.memoryId,
        operationDigest: memoryOperationDigest(op),
        outcome: "deleted",
        hubSequence: 10,
      });
      yield* check;
      yield* sql`DELETE FROM memory_revisions WHERE space=${space}`;
      yield* check;
      yield* sql`DELETE FROM memory_events WHERE memory_space_id=${space}`;
      yield* check;
      yield* sql`DELETE FROM memory_compact_receipts WHERE space=${space}`;
      yield* check;
    }).pipe(Effect.provide(live)),
);
