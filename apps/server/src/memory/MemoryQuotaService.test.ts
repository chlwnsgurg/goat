import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/070_Memory.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(2));
const env = M.EnvironmentId.make("fixture");
const now = "2026-10-14T00:00:00.000Z";
const hash = "a".repeat(64);
const encodeSuppression = Schema.encodeEffect(Schema.fromJsonString(M.MemorySuppressionRecord));
const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const operation = (n = 3) =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: memory,
    operationId: id(n),
    originEnvironmentId: env,
    expectedHeads: [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      revisionId: id(n + 10),
      operationId: id(n),
      parents: [],
      scope: { kind: "user" },
      payloadRef: id(n + 10),
      assertionKind: "inference",
      provenance: { environmentId: env },
      createdAtUtc: now,
    },
    payload: { text: "synthetic searchable text", evidence: [], derivedFromMemoryRevisions: [] },
  });
const decision = (op = operation()): Store.MemoryDecision => ({
  operation: op,
  operationDigest: hash,
  admission: Store.localIntent,
  receipt: {
    operationId: op.operationId,
    memoryId: op.memoryId,
    pendingSync: true,
    revisionId: op.kind === "forget" ? null : op.revision.revisionId,
    outcome: op.kind === "forget" ? "deleted" : "accepted",
  },
  ...(op.kind !== "forget"
    ? {
        item: {
          memorySpaceId: space,
          memoryId: memory,
          status: "active",
          scope: op.revision.scope,
          revision: op.revision,
          payload: op.payload,
          pendingSync: true,
          localAvailability: {
            exposure: "visible",
            reasons: [],
            deferred: [],
            cleanupPending: false,
          },
        } as M.MemoryItem,
      }
    : {}),
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const setup = Layer.effectDiscard(migration).pipe(Layer.provideMerge(database));
const live = Store.layer.pipe(Layer.provideMerge(setup));

const services = Quota.layer.pipe(Layer.provideMerge(live));
const forget = (n = 50) =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: memory,
    operationId: id(n),
    originEnvironmentId: env,
    expectedHeads: [],
    kind: "forget",
    tombstone: {
      memorySpaceId: space,
      memoryId: memory,
      deleteOperationId: id(n),
      deletingEnvironmentId: env,
      deletedAtUtc: now,
      suppressedSourceKeys: [],
      suppressedContent: [],
      sourceExclusions: [],
    },
  });
const resolutionOperation = () => {
  const base = operation(5);
  if (base.kind === "forget") throw new Error("Fixture kind");
  const parents = [M.MemoryRevisionId.make(id(13)), M.MemoryRevisionId.make(id(14))];
  return decodeOperation({
    ...base,
    kind: "resolve",
    expectedHeads: parents,
    revision: { ...base.revision, parents },
    conflictId: id(600),
    fencingToken: 7,
    resolution: {
      resolutionId: id(500),
      memorySpaceId: space,
      memoryId: memory,
      inputRevisionIds: parents,
      inputPayloadRefs: parents,
      judgmentRef: id(500),
      requestedModelSelection: { instanceId: "fixture", model: "fixture" },
      effectiveProvider: "codex",
      effectiveModel: "fixture",
      resolvingEnvironmentId: env,
      fencingToken: 7,
      resultRevisionId: base.revision.revisionId,
      appliedAtUtc: now,
      revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
    },
    resolutionPayload: { resolutionId: id(500), judgment: "한글 judgment" },
  });
};
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(M.MemoryPayload));
const encodeJudgment = Schema.encodeEffect(Schema.fromJsonString(M.MemoryResolutionPayload));
const encodeHeads = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)));
const sample = (day: number, value = day): M.MemoryStorageSample => {
  const instant = DateTime.add(DateTime.makeUnsafe(now), { days: day });
  return {
    measuredAtUtc: DateTime.formatIso(instant),
    utcDay: DateTime.formatIsoDateUtc(instant),
    status: "partial",
    memoryLogicalBytes: value,
    memoryAllocatedBytes: null,
    ftsAllocatedBytes: null,
    dbFileBytes: value + 100,
    walBytes: null,
    freelistBytes: 0,
    tables: [],
  };
};
describe("MemoryQuotaService", () => {
  it.effect("admits quota equality and refuses plus one atomically", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      for (const [dimension, limit] of [
        ["lifetime_ids", M.MEMORY_MAX_LIFETIME_IDS],
        ["receipts", M.MEMORY_DEDUP_MAX_RECEIPTS],
        ["import_source_items", M.MEMORY_IMPORT_MAX_SOURCE_ITEMS],
        ["live_payload_bytes", M.MEMORY_LIVE_MAX_PAYLOAD_BYTES],
        ["work_items", M.MEMORY_WORK_MAX_PENDING_ITEMS],
      ] as const) {
        yield* store.reserve(Store.localIntent, [
          { space, dimension, scopeKey: "fixture", delta: limit, limit },
        ]);
        assert.isTrue(
          (yield* Effect.exit(
            store.reserve(Store.localIntent, [
              { space, dimension, scopeKey: "fixture", delta: 1, limit },
            ]),
          ))._tag === "Failure",
        );
        assert.strictEqual(
          (yield* store.counters(space)).find((row) => row.dimension === dimension)?.value,
          limit,
        );
        yield* store.reserve(Store.approvedReplica, [
          { space, dimension, scopeKey: "fixture", delta: 1, limit },
        ]);
        assert.strictEqual(
          (yield* store.counters(space)).find((row) => row.dimension === dimension)?.value,
          limit + 1,
        );
      }
    }).pipe(Effect.provide(services)),
  );
  it.effect("rolls back quota reservations with failed canonical commit", () =>
    Effect.gen(function* () {
      const quota = yield* Quota.MemoryQuotaService;
      const store = yield* Store.MemoryStore;
      yield* quota
        .withAdmission(
          { operation: operation(), admission: Store.localIntent, environmentId: env },
          Effect.fail("fixture"),
        )
        .pipe(Effect.exit);
      assert.deepStrictEqual(yield* store.counters(space), []);
      assert.isUndefined((yield* store.loadAggregate(space, memory)).identity);
    }).pipe(Effect.provide(services)),
  );
  it.effect("existing-identity first forget uses its reserve at full budgets and FTS brake", () =>
    Effect.gen(function* () {
      const quota = yield* Quota.MemoryQuotaService;
      const store = yield* Store.MemoryStore;
      yield* quota.commit(decision(), env, Effect.void);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE memory_identity_ledger SET reserve_bytes=${M.MEMORY_PERMANENT_METADATA_MAX_BYTES - 2 * M.MEMORY_COMPACT_RECEIPT_MAX_BYTES}`;
      yield* store.reserve(Store.approvedReplica, [
        {
          space,
          dimension: "receipts",
          scopeKey: "space",
          delta: M.MEMORY_DEDUP_MAX_RECEIPTS,
          limit: M.MEMORY_DEDUP_MAX_RECEIPTS,
        },
      ]);
      yield* store.putFtsState({ ...(yield* store.ftsState(env)), state: "braked" });
      const outcome = yield* quota.commit(decision(forget()), env, Effect.void);
      assert.strictEqual(outcome.receipt.outcome, "deleted");
      assert.strictEqual((yield* store.loadAggregate(space, memory)).item?.status, "forgotten");
    }).pipe(Effect.provide(services)),
  );
  it.effect(
    "reserves actual first-delete source keys before ordinary writers fill the budget",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const quota = yield* Quota.MemoryQuotaService;
        const sql = yield* SqlClient.SqlClient;
        const sourceThread = { environmentId: env, threadId: M.ThreadId.make("thread") };
        const sourceWatermark = {
          fromEventId: M.EventId.make(id(100)),
          toEventId: M.EventId.make(id(101)),
          throughSequence: 1,
        };
        const messageIds = Array.from({ length: 100 }, (_, n) => M.MessageId.make(`message-${n}`));
        const base = operation();
        if (base.kind === "forget") throw new Error("Fixture kind");
        const upsert = decodeOperation({
          ...base,
          revision: {
            ...base.revision,
            provenance: { environmentId: env, sourceThread, sourceWatermark },
          },
          payload: {
            ...base.payload,
            evidence: [{ origin: "thread", sourceThread, watermark: sourceWatermark, messageIds }],
          },
        });
        yield* quota.commit(decision(upsert), env, Effect.void);
        assert.strictEqual((yield* store.readForgetReservation(space, memory)).keys, 100);
        const count = M.MEMORY_IMPORT_MAX_SOURCE_ITEMS - 100;
        yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<${count}) INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) SELECT ${space},'fixture',CAST(v AS TEXT),${id(900)},'{}' FROM n`;
        const removal = forget();
        if (removal.kind !== "forget") throw new Error("Fixture kind");
        const op = decodeOperation({
          ...removal,
          tombstone: {
            ...removal.tombstone,
            sourceExclusions: [{ sourceThread, sourceWatermark, messageIds }],
          },
        });
        yield* quota.commit(decision(op), env, Effect.void);
        assert.strictEqual(
          (yield* store.usage(space, { kind: "user" })).keys,
          M.MEMORY_IMPORT_MAX_SOURCE_ITEMS,
        );
        assert.strictEqual((yield* store.readSuppressions(space, memory)).length, 100);
      }).pipe(Effect.provide(services)),
  );
  it.effect("reserves first-delete slots in a fresh memory ledger", () =>
    Effect.gen(function* () {
      const quota = yield* Quota.MemoryQuotaService;
      const store = yield* Store.MemoryStore;
      const base = operation();
      if (base.kind === "forget") throw new Error("Fixture kind");
      const sourceThread = { environmentId: env, threadId: "thread" };
      const sourceWatermark = { fromEventId: id(100), toEventId: id(101), throughSequence: 1 };
      const op = decodeOperation({
        ...base,
        revision: {
          ...base.revision,
          provenance: { environmentId: env, sourceThread, sourceWatermark },
        },
        payload: {
          ...base.payload,
          evidence: [
            { origin: "thread", sourceThread, watermark: sourceWatermark, messageIds: ["a", "b"] },
          ],
        },
      });
      yield* quota.commit(decision(op), env, Effect.void);
      assert.strictEqual((yield* store.readForgetReservation(space, memory)).keys, 2);
      assert.strictEqual((yield* store.readForgetReservation(space, memory)).keys, 2);
    }).pipe(Effect.provide(services)),
  );
  it.effect.each([
    { dimension: "keys", extra: 0 },
    { dimension: "keys", extra: 1 },
    { dimension: "bytes", extra: 0 },
    { dimension: "bytes", extra: 1 },
  ] as const)("expanded first-forget boundary %s", ({ dimension, extra }) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      const sql = yield* SqlClient.SqlClient;
      yield* quota.commit(decision(), env, Effect.void);
      const base = forget();
      if (base.kind !== "forget") throw new Error("Fixture kind");
      const op = decodeOperation({
        ...base,
        tombstone: {
          ...base.tombstone,
          sourceExclusions: Array.from({ length: 3 }, (_, index) => ({
            sourceThread: { environmentId: env, threadId: `thread-${index}` },
            sourceWatermark: { fromEventId: id(100), toEventId: id(101), throughSequence: 1 },
            messageIds: Array.from({ length: 100 }, (_, message) => `message-${index}-${message}`),
          })),
        },
      });
      if (op.kind !== "forget") throw new Error("Fixture kind");
      const records = op.tombstone.sourceExclusions.flatMap((exclusion) =>
        exclusion.messageIds.map((messageId) => ({
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: op.operationId,
          kind: "sourceExclusion" as const,
          exclusion: { ...exclusion, messageIds: [messageId] },
        })),
      );
      const encoded = yield* Effect.forEach(records, (record) => encodeSuppression(record));
      const bytes = encoded.reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0);
      assert.isAbove(bytes, M.MEMORY_PAYLOAD_MAX_UTF8_BYTES);
      if (dimension === "keys") {
        const count = M.MEMORY_IMPORT_MAX_SOURCE_ITEMS - records.length + extra;
        yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<${count}) INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) SELECT ${space},'fixture',CAST(v AS TEXT),${id(900)},'{}' FROM n`;
      } else {
        yield* sql`INSERT INTO memory_identity_ledger (space,memory_id,identity_json,fence_json,reserve_bytes) VALUES (${space},${id(900)},'{}','{}',0)`;
        const used = yield* store.usage(space, { kind: "user" });
        const held = yield* store.readForgetReservation(space, memory);
        const filler =
          M.MEMORY_PERMANENT_METADATA_MAX_BYTES -
          used.permanentBytes -
          (bytes - held.bytes) +
          extra;
        yield* sql`UPDATE memory_identity_ledger SET reserve_bytes=${filler} WHERE memory_id=${id(900)}`;
      }
      const result = yield* Effect.exit(quota.commit(decision(op), env, Effect.void));
      assert.strictEqual(result._tag, extra ? "Failure" : "Success");
      assert.strictEqual((yield* store.readSuppressions(space, memory)).length, extra ? 0 : 300);
      assert.strictEqual(
        (yield* store.loadAggregate(space, memory)).item?.status,
        extra ? "active" : "forgotten",
      );
    }).pipe(Effect.provide(services)),
  );
  it.effect.each([0, 1])(
    "includes encoded judgment at the actual resolve history boundary (+%s)",
    (extra) =>
      Effect.gen(function* () {
        const quota = yield* Quota.MemoryQuotaService;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* quota.commit(decision(operation(3)), env, Effect.void);
        yield* quota.commit(decision(operation(4)), env, Effect.void);
        const op = resolutionOperation();
        if (op.kind !== "resolve") throw new Error("Fixture kind");
        yield* sql`UPDATE memory_items SET heads_json=${yield* encodeHeads(op.revision.parents)} WHERE space=${space} AND memory_id=${memory}`;
        const usage = yield* store.usage(space, { kind: "user" });
        const original = operation();
        if (original.kind === "forget") throw new Error("Fixture kind");
        const oldBytes =
          2 * new TextEncoder().encode(yield* encodePayload(original.payload)).length;
        const judgmentBytes = new TextEncoder().encode(
          yield* encodeJudgment(op.resolutionPayload),
        ).length;
        const filler =
          M.MEMORY_HISTORY_MAX_PAYLOAD_BYTES -
          usage.historyBytes -
          oldBytes -
          judgmentBytes +
          extra;
        yield* sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},'history-budget',${id(900)},CAST(zeroblob(${filler}) AS TEXT),'[]')`;
        const result = yield* Effect.exit(
          quota.commit(
            {
              ...decision(op),
              execution: {
                requestedModelSelection: op.resolution.requestedModelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: "fixture",
                providerInstanceId: op.resolution.requestedModelSelection.instanceId,
                environmentId: env,
              },
            },
            env,
            Effect.void,
          ),
        );
        assert.strictEqual(result._tag, extra ? "Failure" : "Success");
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${op.resolution.judgmentRef}`)
            .length,
          extra ? 0 : 1,
        );
        assert.strictEqual(
          (yield* store.usage(space, { kind: "user" })).historyBytes,
          extra
            ? M.MEMORY_HISTORY_MAX_PAYLOAD_BYTES - oldBytes - judgmentBytes + 1
            : M.MEMORY_HISTORY_MAX_PAYLOAD_BYTES,
        );
      }).pipe(Effect.provide(services)),
  );
  it.effect("prunes an expired judgment only after approval and a covering checkpoint", () =>
    Effect.gen(function* () {
      const quota = yield* Quota.MemoryQuotaService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* quota.commit(decision(operation(3)), env, Effect.void);
      yield* quota.commit(decision(operation(4)), env, Effect.void);
      const op = resolutionOperation();
      if (op.kind !== "resolve") throw new Error("Fixture kind");
      yield* quota.commit(
        {
          ...decision(op),
          admission: Store.approvedReplica,
          receipt: {
            operationId: op.operationId,
            memoryId: memory,
            outcome: "accepted",
            operationDigest: hash,
            hubSequence: 3,
          },
        },
        env,
        Effect.void,
      );
      const expires = Date.parse(now) + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS;
      assert.strictEqual(
        (yield* sql<{
          expiry: number;
        }>`SELECT purge_eligible_after AS expiry FROM memory_payloads WHERE payload_ref=${op.resolution.judgmentRef}`)[0]!
          .expiry,
        expires,
      );
      assert.strictEqual(yield* store.prunePayloads(expires, 100), 0);
      yield* sql`UPDATE memory_compaction_state SET published=1,boundary_json='{"checkpointSequence":2,"boundaryId":"fixture"}' WHERE space=${space}`;
      assert.strictEqual(yield* store.prunePayloads(expires, 100), 0);
      yield* sql`UPDATE memory_compaction_state SET boundary_json='{"checkpointSequence":3,"boundaryId":"fixture"}' WHERE space=${space}`;
      assert.strictEqual(yield* store.prunePayloads(expires - 1, 100), 0);
      yield* store.enqueueWork({
        id: "judgment-guard",
        space,
        memoryId: memory,
        kind: "rebuild",
        status: "pending",
        payloadRef: op.revision.payloadRef,
        attempt: 0,
        nextAttemptAt: 0,
        claimedBy: null,
        claimedUntil: null,
        metadata: { kind: "rebuild", revisionId: op.revision.revisionId, generation: 1 },
      });
      assert.strictEqual(yield* store.prunePayloads(expires, 100), 0);
      yield* store.finishWork("judgment-guard", "completed");
      yield* store.persistCompactReceipt({
        memorySpaceId: space,
        originEnvironmentId: env,
        operationKind: "resolve",
        receipt: {
          operationId: op.operationId,
          memoryId: memory,
          operationDigest: hash,
          outcome: "accepted",
          hubSequence: 3,
        },
        revisionId: op.revision.revisionId,
        resolutionId: op.resolution.resolutionId,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: op.fencingToken,
        reportGuard: null,
      });
      yield* sql`DELETE FROM memory_events WHERE operation_id=${op.operationId}`;
      assert.strictEqual(yield* store.prunePayloads(expires, 100), 1);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${op.resolution.judgmentRef}`)
          .length,
        0,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${op.revision.payloadRef}`)
          .length,
        1,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_resolutions WHERE resolution_id=${op.resolution.resolutionId}`)
          .length,
        1,
      );
    }).pipe(Effect.provide(services)),
  );
  it.effect("unknown-ID forget reserves at lifetime equality but refuses plus one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const quota = yield* Quota.MemoryQuotaService;
      const store = yield* Store.MemoryStore;
      yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<${M.MEMORY_MAX_LIFETIME_IDS - 1}) INSERT INTO memory_identity_ledger (space,memory_id,identity_json,fence_json,reserve_bytes) SELECT ${space},'00000000-0000-4000-8001-'||printf('%012d',v),'{}','{}',0 FROM n`;
      const accepted = yield* quota.commit(decision(forget()), env, Effect.void);
      assert.strictEqual(accepted.receipt.outcome, "deleted");
      const other = decodeOperation({
        ...forget(51),
        memoryId: id(60000),
        tombstone: {
          ...(forget(51) as Extract<M.MemoryOperation, { kind: "forget" }>).tombstone,
          memoryId: id(60000),
        },
      });
      assert.isTrue(
        (yield* Effect.exit(quota.commit(decision(other), env, Effect.void)))._tag === "Failure",
      );
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_identity_ledger`)[0]
          ?.count,
        M.MEMORY_MAX_LIFETIME_IDS,
      );
      assert.isUndefined(yield* store.receipt(space, other.operationId));
    }).pipe(Effect.provide(services)),
  );
  it.effect("approved forget bypasses local identity key and receipt limits", () =>
    Effect.gen(function* () {
      const quota = yield* Quota.MemoryQuotaService;
      const store = yield* Store.MemoryStore;
      const op = forget();
      const approved: Store.MemoryDecision = {
        ...decision(op),
        admission: Store.approvedReplica,
        receipt: {
          operationId: op.operationId,
          memoryId: memory,
          operationDigest: hash,
          outcome: "deleted",
          hubSequence: 1,
        },
      };
      const receipt = yield* store.withReceivedCursor(
        { memorySpaceId: space, hubEnvironmentId: env, expectedSequence: 0, afterSequence: 1 },
        quota.commit(approved, env, Effect.void),
      );
      assert.deepStrictEqual(receipt.receipt, approved.receipt);
      assert.strictEqual(yield* store.readCursor(space, env), 1);
    }).pipe(Effect.provide(services)),
  );
  it.effect("pending forget preservation equality and plus one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<${M.MEMORY_PENDING_FORGET_INTENTS_MAX - 1}) INSERT INTO memory_pending_forget_intents (space,memory_id,operation_id,requested_at_utc,attempts,submission_state) SELECT ${space},'00000000-0000-4000-8001-'||printf('%012d',v),'00000000-0000-4000-8002-'||printf('%012d',v),${now},0,'unsubmitted' FROM n`;
      const intent = {
        memorySpaceId: space,
        memoryId: memory,
        operationId: M.MemoryOperationId.make(id(90)),
        requestedAtUtc: now,
        attempts: 0,
        lastFailureCode: null,
        operationDigest: null,
        submissionState: "unsubmitted" as const,
      };
      yield* store.preserveForgetIntent(intent);
      assert.isTrue(
        (yield* Effect.exit(
          store.preserveForgetIntent({ ...intent, memoryId: M.MemoryId.make(id(91)) }),
        ))._tag === "Failure",
      );
      assert.strictEqual((yield* store.pendingForgetIntents(2001)).length, 2000);
      const restored = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.strictEqual((yield* restored.pendingForgetIntents(2001)).length, 2000);
    }).pipe(Effect.provide(services)),
  );
  it.effect("31 UTC days retain 30 completed rows plus current and exact signed deltas", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      const sql = yield* SqlClient.SqlClient;
      for (let day = 0; day <= 31; day++) yield* store.recordSample(env, sample(day, 100 - day));
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_storage_samples`)[0]
          ?.count,
        30,
      );
      const growth = yield* quota.readStorageGrowth(env);
      for (const days of [1, 7, 30])
        assert.strictEqual(
          growth.deltas.find(
            (delta) => delta.days === days && delta.metric === "memoryLogicalBytes",
          )?.deltaBytes,
          -days,
        );
      assert.isTrue(
        growth.deltas
          .filter((delta) => delta.metric === "memoryAllocatedBytes")
          .every((delta) => delta.reason === "metric_unavailable"),
      );
      const restored = yield* Quota.MemoryQuotaService.pipe(Effect.provide(Quota.layer));
      assert.deepStrictEqual(yield* restored.readStorageGrowth(env), growth);
    }).pipe(Effect.provide(services)),
  );
  it.effect("same-day replacement missed days and clock rollback preserve actual endpoints", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      yield* store.recordSample(env, sample(0));
      const later = {
        ...sample(0, 10),
        measuredAtUtc: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { hours: 1 })),
      };
      yield* store.recordSample(env, later);
      assert.isFalse(yield* store.recordSample(env, sample(0)));
      assert.deepStrictEqual(yield* store.samples(env), [later]);
      yield* store.recordSample(env, sample(7));
      const growth = yield* quota.readStorageGrowth(env);
      assert.strictEqual(
        growth.deltas.find((delta) => delta.days === 1)?.reason,
        "missing_baseline",
      );
      assert.strictEqual(
        growth.deltas.find((delta) => delta.days === 7 && delta.metric === "memoryLogicalBytes")
          ?.deltaBytes,
        -3,
      );
    }).pipe(Effect.provide(services)),
  );
  it.effect("non-memory DB growth changes shared metrics without memory allocation growth", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const before = yield* store.measureAllocation();
      yield* sql`CREATE TABLE unrelated_fixture (body TEXT)`;
      yield* sql`INSERT INTO unrelated_fixture VALUES (${"x".repeat(1024 * 1024)})`;
      const after = yield* store.measureAllocation();
      assert.strictEqual(after.memoryBytes, before.memoryBytes);
      assert.isAbove(after.dbFileBytes, before.dbFileBytes);
    }).pipe(Effect.provide(services)),
  );
  it.effect("startup sampling records unavailable allocation as null and clock discontinuity", () =>
    Effect.gen(function* () {
      const quota = yield* Quota.MemoryQuotaService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE dbstat (unavailable INTEGER)`;
      yield* TestClock.setTime(Date.parse(now));
      const first = yield* quota.recordStorageSample(env);
      assert.isNull(first.current?.memoryAllocatedBytes);
      assert.strictEqual(first.current?.status, "partial");
      yield* TestClock.setTime(Date.parse(now) - 1);
      assert.isTrue(
        (yield* quota.recordStorageSample(env)).deltas.every(
          (delta) => delta.reason === "clock_discontinuity",
        ),
      );
    }).pipe(Effect.provide(services)),
  );
});
