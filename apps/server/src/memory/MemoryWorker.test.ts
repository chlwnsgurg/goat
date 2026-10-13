import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import migration from "../persistence/Migrations/070_Memory.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as Worker from "./MemoryWorker.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const environmentId = M.EnvironmentId.make("fixture");
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const threadId = M.ThreadId.make("thread");
const selection = { instanceId: M.ProviderInstanceId.make("fixture"), model: "fixture" };
const now = "2026-10-14T00:00:00.000Z";
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* migration;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT,occurred_at TEXT,application_event_version INTEGER,aggregate_kind TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,deleted_at TEXT)`;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const storage = Store.layer.pipe(Layer.provideMerge(setup));
const quota = Quota.layer.pipe(Layer.provideMerge(storage));
const service = Service.layer.pipe(
  Layer.provideMerge(quota),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
);
const maintenance = Maintenance.layer.pipe(Layer.provideMerge(quota));
const live = (failure = false) =>
  Worker.layer.pipe(
    Layer.provideMerge(service),
    Layer.provideMerge(maintenance),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Settings.layerTest({
        defaultModelSelection: selection,
        memoryHub: { mode: "hub", memorySpaceId: space },
      }),
    ),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(Layer.succeed(RuntimeIdentity.RuntimeIdentity, { instanceId: "worker" })),
    Layer.provide(Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty })),
    Layer.provide(
      Layer.mock(Generation.TextGeneration)({
        generateMemorySummary: (input) =>
          failure
            ? Effect.fail(
                new M.TextGenerationError({
                  operation: "generateMemorySummary",
                  detail: "synthetic failure",
                }),
              )
            : Effect.succeed({
                result: {
                  text: "synthetic summary",
                  assertionKind: "inference",
                  evidence: [
                    {
                      origin: "thread",
                      sourceThread: input.sourceThread,
                      watermark: input.sourceWatermark,
                      messageIds: input.messages.map((m) => m.messageId),
                    },
                  ],
                },
                execution: {
                  requestedModelSelection: input.modelSelection,
                  effectiveModel: "fixture",
                  effectiveProvider: M.ProviderDriverKind.make("codex"),
                  providerInstanceId: selection.instanceId,
                  environmentId,
                },
              }),
      }),
    ),
  );
const encodeMessage = Schema.encodeSync(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
const encodeRun = Schema.encodeSync(Schema.fromJsonString(M.OrchestrationV2RunJson));
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${threadId},NULL)`;
  const message = M.OrchestrationV2ConversationMessageJson.make({
    id: M.MessageId.make("message"),
    threadId,
    runId: M.RunId.make("run"),
    nodeId: null,
    createdBy: "user",
    creationSource: "web",
    role: "user",
    text: "synthetic committed statement",
    attachments: [],
    streaming: false,
    createdAt: DateTime.makeUnsafe(now),
    updatedAt: DateTime.makeUnsafe(now),
  });
  const run = M.OrchestrationV2RunJson.make({
    id: M.RunId.make("run"),
    threadId,
    ordinal: 1,
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    providerThreadId: null,
    userMessageId: message.id,
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: DateTime.makeUnsafe(now),
    startedAt: DateTime.makeUnsafe(now),
    completedAt: DateTime.makeUnsafe(now),
    checkpointId: null,
    contextHandoffId: null,
  });
  yield* sql`INSERT INTO orchestration_events VALUES (1,${id(10)},${threadId},'message.updated',${encodeMessage(message)},${now},2,'thread')`;
  yield* sql`INSERT INTO orchestration_events VALUES (2,${id(11)},${threadId},'run.updated',${encodeRun(run)},${now},2,'thread')`;
});
const work = (kind: Store.MemoryWork["kind"] = "summary"): Store.MemoryWork => ({
  id: "work",
  space,
  memoryId,
  kind,
  status: "running",
  attempt: 1,
  nextAttemptAt: 0,
  claimedBy: "worker",
  claimedUntil: Number.MAX_SAFE_INTEGER,
  payloadRef: null,
  metadata: {
    kind: "summary",
    sourceThread: { environmentId, threadId },
    sourceWatermark: {
      fromEventId: M.EventId.make(id(10)),
      toEventId: M.EventId.make(id(11)),
      throughSequence: 2,
    },
    memoryId,
    operationId: M.MemoryOperationId.make(id(4)),
    revisionId: M.MemoryRevisionId.make(id(5)),
    modelSelection: selection,
  },
});
describe("MemoryWorker", () => {
  it.effect("started idle worker drains without waking itself", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* Worker.MemoryWorker;
        const store = yield* Store.MemoryStore;
        yield* worker.start();
        yield* worker.drain;
        yield* store.loadAggregate(space, memoryId);
        yield* store.recoverDeferred(1, 0);
        yield* worker.drain;
        assert.deepStrictEqual(yield* store.dueWork(0, 100), []);
      }),
    ).pipe(Effect.provide(live())),
  );
  it("stores the bounded retry sequence without sleeping", () => {
    assert.deepStrictEqual(
      [1, 2, 3, 4, 20].map(Worker.memoryRetryDelay),
      [5000, 30000, 120000, 600000, 600000],
    );
  });
  it.effect("refuses generic claim execution", () =>
    Effect.gen(function* () {
      const worker = yield* Worker.MemoryWorker;
      assert.strictEqual(
        (yield* worker.execute(work("claim")).pipe(Effect.flip)).code,
        "unsupported_operation",
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("refuses generic resolution execution", () =>
    Effect.gen(function* () {
      const worker = yield* Worker.MemoryWorker;
      assert.strictEqual(
        (yield* worker.execute(work("resolve")).pipe(Effect.flip)).code,
        "unsupported_operation",
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("refuses generic pending revert execution", () =>
    Effect.gen(function* () {
      const worker = yield* Worker.MemoryWorker;
      assert.strictEqual(
        (yield* worker.execute(work("revert_intent")).pipe(Effect.flip)).code,
        "unsupported_operation",
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("refuses a foreign runtime owner", () =>
    Effect.gen(function* () {
      const worker = yield* Worker.MemoryWorker;
      assert.strictEqual(
        (yield* worker.execute({ ...work(), claimedBy: "foreign" }).pipe(Effect.flip)).code,
        "attempt_expired",
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("catches up committed termination and emits one stable summary", () =>
    Effect.gen(function* () {
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const store = yield* Store.MemoryStore;
      yield* worker.sweepDue();
      assert.strictEqual(yield* store.readThreadHookWatermark(), 2);
      const page = yield* store.list({
        memorySpaceId: space,
        scope: { kind: "thread", thread: { environmentId, threadId } },
        limit: 20,
      });
      assert.strictEqual(page.length, 1);
      assert.strictEqual(page[0]!.status, "active");
      yield* worker.drain;
      assert.strictEqual(
        (yield* store.list({
          memorySpaceId: space,
          scope: { kind: "thread", thread: { environmentId, threadId } },
          limit: 20,
        })).length,
        1,
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("records one safe report and durable future retry on provider failure", () =>
    Effect.gen(function* () {
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const store = yield* Store.MemoryStore;
      yield* worker.sweepDue();
      const reports = yield* store.pendingReports(100);
      assert.strictEqual(reports.length, 1);
      assert.strictEqual(reports[0]!.failureCode, "generation_failed");
      yield* worker.drain;
      assert.strictEqual((yield* store.pendingReports(100)).length, 1);
    }).pipe(Effect.provide(live(true))),
  );
  it.effect("deleted thread cancels its jobs before generation", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at=${now}`;
      const worker = yield* Worker.MemoryWorker;
      const store = yield* Store.MemoryStore;
      yield* worker.sweepDue();
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
      assert.deepStrictEqual(
        yield* store.list({
          memorySpaceId: space,
          scope: { kind: "thread", thread: { environmentId, threadId } },
          limit: 20,
        }),
        [],
      );
    }).pipe(Effect.provide(live())),
  );
});
