import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as TestClock from "effect/testing/TestClock";
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
import migration from "../persistence/Migrations/071_Memory.ts";
import hubMigration from "../persistence/Migrations/071_MemoryHubSync.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import { decideMemoryOperation } from "./MemoryDecider.ts";
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
    yield* hubMigration;
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
const live = (
  failure = false,
  onInput?: (input: M.GenerateMemorySummaryInput) => void,
  local = false,
  elapsedPerCallMs = 0,
) =>
  Worker.layer.pipe(
    Layer.provideMerge(service),
    Layer.provideMerge(maintenance),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Settings.layerTest({
        defaultModelSelection: selection,
        memoryHub: local ? { mode: "disabled" } : { mode: "hub", memorySpaceId: space },
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
        generateMemorySummary: (input) => {
          onInput?.(input);
          const result = failure
            ? Effect.fail(
                new M.TextGenerationError({
                  operation: "generateMemorySummary",
                  detail: "synthetic failure",
                }),
              )
            : Effect.succeed({
                result: {
                  text: [
                    input.previousSummary?.text,
                    ...input.messages.map((message) => message.messageId),
                  ]
                    .filter(Boolean)
                    .join(" "),
                  assertionKind: "inference" as const,
                  evidence: [
                    ...(input.previousSummary?.evidence ?? []),
                    {
                      origin: "thread" as const,
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
              });
          return elapsedPerCallMs
            ? TestClock.adjust(elapsedPerCallMs).pipe(Effect.andThen(result))
            : result;
        },
      }),
    ),
  );
const encodeMessage = Schema.encodeSync(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperation);
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(M.OrchestrationV2RunJson));
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
// Summary A covers a run that is then rolled back, and run B adds 101 messages. The next
// summary must drop A and regenerate from the start: two bounded chunks in one work item.
const seedRolledBackRegeneration = Effect.gen(function* () {
  yield* seed;
  const sql = yield* SqlClient.SqlClient;
  const worker = yield* Worker.MemoryWorker;
  const earlyMessageRow = (yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
  const earlyMessage = yield* decodeMessage(earlyMessageRow.payload_json);
  yield* sql`UPDATE orchestration_events SET sequence=3 WHERE sequence=2`;
  yield* sql`INSERT INTO orchestration_events VALUES (2,${id(1299)},${threadId},'message.updated',${encodeMessage({ ...earlyMessage, id: M.MessageId.make("survivor"), runId: null })},${now},2,'thread')`;
  yield* worker.sweepDue();
  const runRow = (yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events WHERE sequence=3`)[0]!;
  const run = yield* decodeRun(runRow.payload_json);
  yield* sql`INSERT INTO orchestration_events VALUES (4,${id(1300)},${threadId},'run.updated',${encodeRun({ ...run, status: "rolled_back" })},${now},2,'thread')`;
  const nextRunId = M.RunId.make("run-b");
  for (let index = 0; index < 101; index++) {
    yield* sql`INSERT INTO orchestration_events VALUES (${index + 5},${id(1400 + index)},${threadId},'message.updated',${encodeMessage({ ...earlyMessage, id: M.MessageId.make(`run-b-${index}`), runId: nextRunId })},${now},2,'thread')`;
  }
  yield* sql`INSERT INTO orchestration_events VALUES (106,${id(1600)},${threadId},'run.updated',${encodeRun({ ...run, id: nextRunId, userMessageId: M.MessageId.make("run-b-0"), status: "completed" })},${now},2,'thread')`;
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
  it.effect(
    "isolates a secret source while normal work, deferred repair and maintenance continue",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        const worker = yield* Worker.MemoryWorker;
        const source = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
        const message = yield* decodeMessage(source.payload_json);
        const secret = encodeMessage({ ...message, text: "sk-" + "A".repeat(32) });
        yield* sql`UPDATE orchestration_events SET payload_json=${secret} WHERE sequence=1`;
        const normalThread = M.ThreadId.make("normal-thread");
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${normalThread},NULL)`;
        yield* sql`INSERT INTO orchestration_events VALUES (3,${id(20)},${normalThread},'message.updated',${encodeMessage({ ...message, threadId: normalThread })},${now},2,'thread')`;
        yield* sql`INSERT INTO orchestration_events SELECT 4,${id(21)},${normalThread},event_type,payload_json,occurred_at,application_event_version,aggregate_kind FROM orchestration_events WHERE sequence=2`;
        yield* worker.sweepDue();
        assert.strictEqual(yield* store.readThreadHookWatermark(), 4);
        const reports = yield* store.pendingReports(100);
        assert.strictEqual(reports.length, 1);
        assert.strictEqual(reports[0]!.failureCode, "secret_detected");
        const normalId = M.MemoryId.make(
          Service.memoryStableUuid(`${environmentId}:${normalThread}:summary`),
        );
        assert.strictEqual((yield* store.loadAggregate(space, normalId)).item?.status, "active");
        yield* worker.sweepDue();
        assert.strictEqual((yield* store.pendingReports(100)).length, 1);
        const normal = yield* store.loadAggregate(space, normalId);
        assert.strictEqual(
          normal.item?.localAvailability.reasons.includes("scanner_pending"),
          false,
        );
        assert.strictEqual(
          normal.item?.localAvailability.reasons.includes("index_unavailable"),
          false,
        );
        const quota = yield* Quota.MemoryQuotaService;
        assert.isNotNull((yield* quota.readStorageGrowth(environmentId)).current);
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_outbox WHERE kind='summary' AND status='failed'`).length,
          1,
        );
      }).pipe(Effect.provide(live())),
  );
  it.effect("filters streaming and system messages before applying the chunk limit", () => {
    const batches: string[][] = [];
    return Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const original = (yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
      const message = yield* decodeMessage(original.payload_json);
      yield* sql`UPDATE orchestration_events SET sequence=112 WHERE sequence=2`;
      for (let index = 2; index <= 111; index++) {
        yield* sql`INSERT INTO orchestration_events VALUES (${index},${id(2000 + index)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make(`skipped-${index}`), streaming: index % 2 === 0, role: index % 2 === 0 ? "user" : "system" })},${now},2,'thread')`;
      }
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      yield* worker.sweepDue();
      yield* worker.sweepDue();
      assert.deepStrictEqual(batches, [["message"]]);
    }).pipe(
      Effect.provide(
        live(false, (input) => batches.push(input.messages.map((message) => message.messageId))),
      ),
    );
  });
  it.effect("retries rejected forget excess without replaying the basic deletion", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      const sql = yield* SqlClient.SqlClient;
      yield* service.upsert(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(1700)),
          expectedHeads: [],
          baseBoundary: null,
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
        },
        Effect.void,
      );
      const aggregate = yield* store.loadAggregate(space, memoryId);
      const operation = yield* decodeOperation({
        protocolVersion: 1,
        kind: "forget",
        memorySpaceId: space,
        memoryId,
        operationId: id(1701),
        originEnvironmentId: environmentId,
        expectedHeads: aggregate.heads,
        tombstone: {
          memorySpaceId: space,
          memoryId,
          deleteOperationId: id(1701),
          deletingEnvironmentId: environmentId,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [
            {
              sourceThread: { environmentId, threadId },
              sourceWatermark: { fromEventId: id(1702), toEventId: id(1703), throughSequence: 1 },
              messageIds: ["excess-message"],
            },
          ],
        },
      });
      const used = yield* store.usage(space, { kind: "user" });
      const filler = M.MEMORY_IMPORT_MAX_SOURCE_ITEMS - used.keys;
      yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<${filler}) INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) SELECT ${space},'fixture',CAST(v AS TEXT),${id(1799)},'{}' FROM n`;
      // Exhaust intent slots as well; the basic deletion still commits and its rejected excess is recoverable.
      const intentLimit = M.MEMORY_PENDING_FORGET_INTENTS_MAX;
      yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<${intentLimit}) INSERT INTO memory_pending_forget_intents (space,memory_id,operation_id,requested_at_utc,attempts,last_failure_code,operation_digest,submission_state) SELECT ${space},printf('00000000-0000-4000-8000-%012d',10000+v),printf('00000000-0000-4000-8000-%012d',20000+v),${now},0,'capacity_exceeded',NULL,'unsubmitted' FROM n`;
      const decision = decideMemoryOperation(aggregate, operation, Store.localIntent, {
        kind: "allowed",
      });
      const result = yield* quota.commit(decision, environmentId, Effect.void);
      assert.strictEqual(result.receipt.outcome, "deleted");
      assert.strictEqual(result.receipt.forgetExpansion?.status, "rejected");
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_pending_forget_intents WHERE memory_id=${memoryId}`)
          .length,
        0,
      );
      yield* sql`DELETE FROM memory_pending_forget_intents WHERE memory_id!=${memoryId}`;
      const intent = (yield* store.pendingForgetIntents(10))[0]!;
      yield* (yield* Worker.MemoryWorker).sweepDue();
      const failedRetryId = M.MemoryOperationId.make(
        Service.memoryStableUuid(`${intent.operationId}:0:retry`),
      );
      assert.strictEqual(yield* store.receipt(space, failedRetryId), undefined);
      assert.strictEqual((yield* store.pendingForgetIntents(10))[0]?.attempts, 1);
      yield* sql`DELETE FROM memory_import_keys WHERE key_kind='fixture'`;
      yield* (yield* Worker.MemoryWorker).sweepDue();
      const retryId = M.MemoryOperationId.make(
        Service.memoryStableUuid(`${intent.operationId}:1:retry`),
      );
      const retry = (yield* store.receipt(space, retryId))!;
      assert.strictEqual(retry.receipt.outcome, "deleted");
      assert.deepStrictEqual(retry.receipt.forgetRetryOf, {
        operationId: intent.operationId,
        operationDigest: intent.operationDigest,
      });
      assert.deepStrictEqual(yield* store.pendingForgetIntents(10), []);
      assert.strictEqual((yield* store.readSuppressions(space, memoryId)).length, 1);
      assert.deepStrictEqual(yield* quota.commit(decision, environmentId, Effect.void), result);
    }).pipe(Effect.provide(live())),
  );
  it.effect.each([false, true])(
    "preserves earlier chunks and later updates (local=%s)",
    (local) => {
      const batches: string[][] = [];
      const previous: Array<M.MemoryPayload | undefined> = [];
      return Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const original = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
        const message = yield* decodeMessage(original.payload_json);
        yield* sql`UPDATE orchestration_events SET sequence=102 WHERE sequence=2`;
        for (let index = 2; index <= 101; index++) {
          yield* sql`INSERT INTO orchestration_events VALUES (${index},${id(1000 + index)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make(`message-${index}`) })},${now},2,'thread')`;
        }
        const worker = yield* Worker.MemoryWorker;
        const store = yield* Store.MemoryStore;
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        assert.deepStrictEqual(
          batches.map((batch) => batch.length),
          [100, 1],
        );
        assert.strictEqual(new Set(batches.flat()).size, 101);
        assert.deepStrictEqual(yield* store.pendingReports(100), []);
        const run = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=102`)[0]!;
        yield* sql`INSERT INTO orchestration_events VALUES (103,${id(1200)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make("later") })},${now},2,'thread')`;
        yield* sql`INSERT INTO orchestration_events VALUES (104,${id(1201)},${threadId},'run.updated',${run.payload_json},${now},2,'thread')`;
        yield* worker.sweepDue();
        assert.deepStrictEqual(batches.at(-1), ["later"]);
        assert.strictEqual(previous[0], undefined);
        assert.include(previous[1]!.text, "message-100");
        assert.strictEqual(previous[1]!.evidence[0]!.messageIds.length, 100);
        assert.include(previous[2]!.text, "message-101");
        const summaryId = M.MemoryId.make(
          Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
        );
        const aggregate = local ? undefined : yield* store.loadAggregate(space, summaryId);
        const final = local
          ? yield* store.readLocalSummaryPayload(
              environmentId,
              `${environmentId}:${threadId}:summary`,
            )
          : aggregate?.revisions.find((pair) => pair.revision.revisionId === aggregate.heads[0])
              ?.payload;
        if (!final) throw new Error("Missing summary");
        assert.include(final.text, "message-100");
        assert.include(final.text, "message-101");
        assert.include(final.text, "later");
        assert.strictEqual(new Set(final.evidence.flatMap((entry) => entry.messageIds)).size, 102);
      }).pipe(
        Effect.provide(
          live(
            false,
            (input) => {
              batches.push(input.messages.map((message) => message.messageId));
              previous.push(input.previousSummary);
            },
            local,
          ),
        ),
      );
    },
  );
  it.effect.each([false, true])(
    "rebuilds cumulative summaries after a prior run is rolled back (local=%s)",
    (local) => {
      const inputs: M.GenerateMemorySummaryInput[] = [];
      return Effect.gen(function* () {
        yield* seedRolledBackRegeneration;
        const worker = yield* Worker.MemoryWorker;
        const store = yield* Store.MemoryStore;
        assert.include(
          inputs[0]!.messages.map((m) => m.messageId),
          M.MessageId.make("message"),
        );
        // The hook itself is bounded to 100 events per sweep.
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        assert.strictEqual(inputs[1]!.previousSummary, undefined);
        assert.isTrue(inputs.slice(1).every((input) => input.messages.length <= 100));
        assert.isFalse(
          inputs
            .slice(1)
            .some(
              (input) =>
                input.messages.some((m) => m.messageId === "message") ||
                input.previousSummary?.text.includes("message"),
            ),
        );
        const summaryId = M.MemoryId.make(
          Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
        );
        const aggregate = local ? undefined : yield* store.loadAggregate(space, summaryId);
        const final = local
          ? yield* store.readLocalSummaryPayload(
              environmentId,
              `${environmentId}:${threadId}:summary`,
            )
          : aggregate?.revisions.find((pair) => pair.revision.revisionId === aggregate.heads[0])
              ?.payload;
        if (!final) throw new Error("Missing rebuilt summary");
        assert.notInclude(final.text, "message");
        assert.include(final.text, "run-b-100");
        const evidenceIds = new Set(final.evidence.flatMap((e) => e.messageIds));
        assert.isFalse(evidenceIds.has(M.MessageId.make("message")));
        assert.isTrue(evidenceIds.has(M.MessageId.make("survivor")));
        assert.strictEqual(evidenceIds.size, 102);
      }).pipe(Effect.provide(live(false, (input) => inputs.push(input), local)));
    },
  );
  it.effect.each([false, true])(
    "keeps one claim while a regeneration outlasts the claim deadline (local=%s)",
    (local) => {
      const inputs: M.GenerateMemorySummaryInput[] = [];
      return Effect.gen(function* () {
        yield* seedRolledBackRegeneration;
        const sql = yield* SqlClient.SqlClient;
        const worker = yield* Worker.MemoryWorker;
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        // Summary A, the two-call regeneration in one work item, then the continuation chunk.
        // Two 400s calls outlast the 600s claim, so without renewal the regeneration repeats.
        assert.strictEqual(inputs.length, 4);
        assert.isUndefined(inputs[1]!.previousSummary);
        assert.isDefined(inputs[2]!.previousSummary);
        const rows = yield* sql<{
          attempt: number;
          status: string;
        }>`SELECT attempt,status FROM memory_outbox WHERE kind='summary'`;
        assert.isAbove(rows.length, 0);
        assert.deepStrictEqual(
          [...new Set(rows.map((row) => `${row.status}:${row.attempt}`))],
          ["completed:1"],
        );
      }).pipe(Effect.provide(live(false, (input) => inputs.push(input), local, 400000)));
    },
  );
  it.effect("revisits consolidation at exactly 24 hours after extracting turns", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const sql = yield* SqlClient.SqlClient;
      yield* worker.sweepDue();
      yield* TestClock.setTime(Date.parse(now) + 86400000 - 1);
      yield* worker.sweepDue();
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_outbox WHERE kind='consolidate' AND status='completed'`)[0]!
          .count,
        0,
      );
      yield* TestClock.adjust(1);
      yield* worker.sweepDue();
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_outbox WHERE kind='consolidate' AND status='completed'`)[0]!
          .count,
        1,
      );
      yield* worker.sweepDue();
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_outbox WHERE kind='consolidate'`)[0]!.count,
        1,
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("consolidates delayed terminal events using the processing clock", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const terminalAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { hours: 1 }));
      yield* sql`UPDATE orchestration_events SET occurred_at=${terminalAt} WHERE sequence=2`;
      yield* TestClock.setTime(Date.parse(now) + 25 * 3600000);
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      const rows = yield* sql<{
        kind: string;
        status: string;
      }>`SELECT kind,status FROM memory_outbox WHERE kind='consolidate'`;
      assert.deepStrictEqual(rows, [{ kind: "consolidate", status: "completed" }]);
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
