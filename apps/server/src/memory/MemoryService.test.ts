import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/070_Memory.ts";
import hubMigration from "../persistence/Migrations/071_MemoryHubSync.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const environmentId = M.EnvironmentId.make("fixture");
const database = Layer.effectDiscard(migration.pipe(Effect.andThen(hubMigration))).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const store = Store.layer.pipe(Layer.provideMerge(database));
const live = Service.layer.pipe(
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
const input = (n = 3): M.MemoryUpsertInput => ({
  memorySpaceId: space,
  memoryId,
  operationId: M.MemoryOperationId.make(id(n)),
  expectedHeads: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
  baseBoundary: null,
});
const encodeResolution = Schema.encodeEffect(Schema.fromJsonString(M.MemoryResolution));
const encodeSelectionJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryModelSelection));
const encodeRevisionIds = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)),
);
const denied = Effect.fail(new Service.MemoryAccessError({ code: "identity_mismatch" }));
describe("MemoryService hub admission", () => {
  const authority: Store.HubAuthority = {
    principal: {
      memorySpaceId: space,
      environmentId,
      credentialVersion: 1,
      scopes: ["memory:sync"],
    },
    now: Clock.currentTimeMillis,
    reauthorize: Effect.void,
  };
  it.effect("admits a hub-local event once and rechecks membership before replay", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${environmentId},${"a".repeat(64)},1,'active',0)`;
      yield* service.upsert(input(), Effect.void);
      const op = yield* store.readWorkOperation(`sync:${space}:${input().operationId}`);
      assert.isDefined(op);
      const first = yield* store.transact(
        service.admitHubOperationTx({ authority, operation: op! }),
      );
      assert.strictEqual(first.outcome, "accepted");
      assert.isNotNull(first.hubSequence);
      assert.deepStrictEqual(
        yield* store.transact(service.admitHubOperationTx({ authority, operation: op! })),
        first,
      );
      const aggregate = yield* store.loadAggregate(space, memoryId);
      assert.strictEqual(aggregate.item?.pendingSync, false);
      assert.strictEqual(
        (yield* store.receipt(space, op!.operationId))?.receipt.outcome,
        "accepted",
      );
      assert.strictEqual((yield* store.transact(store.readHubUsageTx(space))).tailRows, 1);
      yield* sql`UPDATE memory_hub_members SET status='revoked' WHERE space=${space}`;
      assert.strictEqual(
        (yield* store
          .transact(service.admitHubOperationTx({ authority, operation: op! }))
          .pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "a fresh remote operation reaches the canonical projection despite its compact hub receipt",
    () =>
      Effect.gen(function* () {
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${environmentId},${"a".repeat(64)},1,'active',0)`;
        const op: M.MemoryOperation = {
          protocolVersion: 1,
          kind: "upsert",
          memorySpaceId: space,
          memoryId,
          originEnvironmentId: environmentId,
          operationId: M.MemoryOperationId.make(id(90)),
          expectedHeads: [],
          revision: {
            memorySpaceId: space,
            memoryId,
            operationId: M.MemoryOperationId.make(id(90)),
            revisionId: M.MemoryRevisionId.make(id(91)),
            parents: [],
            scope: { kind: "user" },
            payloadRef: M.MemoryRevisionId.make(id(91)),
            assertionKind: "inference",
            createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
            provenance: { environmentId },
          },
          payload: {
            text: "synthetic remote memory",
            evidence: [],
            derivedFromMemoryRevisions: [],
          },
        };
        const receipt = yield* store.transact(
          service.admitHubOperationTx({ authority, operation: op }),
        );
        assert.strictEqual(receipt.operationDigest, memoryOperationDigest(op));
        const aggregate = yield* store.loadAggregate(space, memoryId);
        assert.deepStrictEqual(aggregate.heads, [M.MemoryRevisionId.make(id(91))]);
        assert.strictEqual(aggregate.revisions[0]?.payload?.text, "synthetic remote memory");
        assert.strictEqual(aggregate.item?.pendingSync, false);
        assert.strictEqual((yield* store.transact(store.readHubUsageTx(space))).tailRows, 1);
      }).pipe(Effect.provide(live)),
  );
});
describe("MemoryService", () => {
  it.effect("replays unchanged input with the original timestamp and receipt", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const first = yield* service.upsert(input(), Effect.void);
      assert.deepStrictEqual(yield* service.upsert(input(), Effect.void), first);
    }).pipe(Effect.provide(live)),
  );
  it.effect("rejects changed content under the same operation", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      yield* service.upsert(input(), Effect.void);
      const error = yield* service
        .upsert({ ...input(), payload: { ...input().payload, text: "changed" } }, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "MemoryStoreConflict");
      if (error._tag === "MemoryStoreConflict")
        assert.strictEqual(error.code, "operation_id_reused");
    }).pipe(Effect.provide(live)),
  );
  it.effect("denies writes before persisting receipt or payload", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      yield* service.upsert(input(), denied).pipe(Effect.flip);
      assert.isUndefined(yield* store.receipt(space, input().operationId));
      assert.isUndefined((yield* store.loadAggregate(space, memoryId)).item);
    }).pipe(Effect.provide(live)),
  );
  it.effect("rechecks live permission even on replay", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      yield* service.upsert(input(), Effect.void);
      assert.strictEqual(
        (yield* service.upsert(input(), denied).pipe(Effect.flip))._tag,
        "MemoryAccessError",
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("rejects secret prose without retaining it", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      yield* service
        .upsert(
          { ...input(), payload: { ...input().payload, text: "-----BEGIN PRIVATE KEY-----" } },
          Effect.void,
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual((yield* store.loadAggregate(space, memoryId)).revisions, []);
    }).pipe(Effect.provide(live)),
  );
  it.effect("rejects extra fields at the input boundary", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const value = { ...input(), authority: "model" };
      assert.strictEqual(
        (yield* service.upsert(value, Effect.void).pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("isolates thread scopes to the owning environment", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      yield* service
        .upsert(
          {
            ...input(),
            scope: {
              kind: "thread",
              thread: {
                environmentId: M.EnvironmentId.make("foreign"),
                threadId: M.ThreadId.make("thread"),
              },
            },
          },
          Effect.void,
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        (yield* service.list(
          { memorySpaceId: space, scope: { kind: "user" }, limit: 20, includeQuarantined: false },
          Effect.void,
        )).items,
        [],
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("keeps user and thread reads separate before paging", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      yield* service.upsert(input(), Effect.void);
      const page = yield* service.list(
        {
          memorySpaceId: space,
          scope: { kind: "thread", thread: { environmentId, threadId: M.ThreadId.make("thread") } },
          limit: 1,
          includeQuarantined: true,
        },
        Effect.void,
      );
      assert.deepStrictEqual(page.items, []);
    }).pipe(Effect.provide(live)),
  );
  it.effect("returns index coverage on empty search", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const page = yield* service.search(
        { memorySpaceId: space, query: "absent", limit: 20, mode: "fts" },
        Effect.void,
      );
      assert.strictEqual(page.indexCoverage?.projectionWatermark, page.projectionWatermark);
      assert.deepStrictEqual(page.items, []);
    }).pipe(Effect.provide(live)),
  );
  it.effect("forget removes bodies and blocks late local writes", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      yield* service.upsert(input(), Effect.void);
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(4)),
          expectedHeads: [],
        },
        Effect.void,
      );
      assert.strictEqual(
        (yield* service.read({ memorySpaceId: space, memoryId }, Effect.void)).status,
        "forgotten",
      );
      const page = yield* service.history(
        { memorySpaceId: space, memoryId, limit: 20 },
        Effect.void,
      );
      assert.isTrue(page.revisions.every((r) => r.payload === null));
      yield* service.upsert(input(5), Effect.void).pipe(Effect.flip);
    }).pipe(Effect.provide(live)),
  );
  it.effect("local re-forget creates no new receipt", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      yield* service.upsert(input(), Effect.void);
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(4)),
          expectedHeads: [],
        },
        Effect.void,
      );
      const result = yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(5)),
          expectedHeads: [],
        },
        Effect.void,
      );
      assert.strictEqual(result.receipt.outcome, "noop");
      assert.isUndefined(yield* store.receipt(space, M.MemoryOperationId.make(id(5))));
    }).pipe(Effect.provide(live)),
  );
  it.effect("rolls back mutation and sync intent together", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      yield* store
        .transact(
          service
            .upsert(input(), Effect.void)
            .pipe(
              Effect.andThen(
                Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" })),
              ),
            ),
        )
        .pipe(Effect.flip);
      assert.isUndefined(yield* store.receipt(space, input().operationId));
      assert.deepStrictEqual(yield* store.readEligibleOutbox(space, 0, 100), []);
    }).pipe(Effect.provide(live)),
  );
});

describe("memory project bindings", () => {
  const project = { environmentId, projectId: M.ProjectId.make("project") };
  const seedProject = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
    yield* sql`INSERT INTO projection_projects VALUES ('project','/synthetic',NULL)`;
  });
  it.effect("persists explicit binding and replays without version inflation", () =>
    Effect.gen(function* () {
      yield* seedProject;
      const service = yield* Service.MemoryService;
      const request = {
        memorySpaceId: space,
        project,
        requestId: M.MemoryOperationId.make(id(70)),
        expectedVersion: 0,
        action: "setExplicit" as const,
        sharedProjectId: "shared",
      };
      const result = yield* service.updateProjectBinding(request, Effect.void);
      assert.strictEqual(result.binding.version, 1);
      assert.deepStrictEqual(yield* service.updateProjectBinding(request, Effect.void), result);
      assert.deepStrictEqual(yield* service.resolveProjectKey(space, project), {
        kind: "explicit",
        sharedProjectId: "shared",
      });
    }).pipe(Effect.provide(live)),
  );
  it.effect("unbound projects resolve to no project key", () =>
    Effect.gen(function* () {
      yield* seedProject;
      const service = yield* Service.MemoryService;
      assert.isNull(yield* service.resolveProjectKey(space, project));
    }).pipe(Effect.provide(live)),
  );
  it.effect("stale version and revoked permit commit no binding", () =>
    Effect.gen(function* () {
      yield* seedProject;
      const service = yield* Service.MemoryService;
      const request = {
        memorySpaceId: space,
        project,
        requestId: M.MemoryOperationId.make(id(71)),
        expectedVersion: 1,
        action: "setExplicit" as const,
        sharedProjectId: "shared",
      };
      yield* service.updateProjectBinding(request, Effect.void).pipe(Effect.flip);
      yield* service
        .updateProjectBinding({ ...request, expectedVersion: 0 }, denied)
        .pipe(Effect.flip);
      assert.isNull(yield* service.resolveProjectKey(space, project));
    }).pipe(Effect.provide(live)),
  );
});

it.effect(
  "promotes a local root on ACK without advancing the cursor, then settles pull atomically once",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const initial = yield* service.upsert(input(), Effect.void);
      const workId = `sync:${space}:${input().operationId}`;
      const reference = {
        operationId: input().operationId,
        operationDigest: initial.operationDigest,
      };
      const receipt: M.MemoryHubReceipt = {
        operationId: reference.operationId,
        memoryId,
        operationDigest: reference.operationDigest,
        outcome: "accepted",
        hubSequence: 7,
      };
      const args = {
        memorySpaceId: space,
        hubEnvironmentId: environmentId,
        localEnvironmentId: environmentId,
        workId,
        operation: reference,
        receipt,
        reauthorize: Effect.void,
      };
      const ack = yield* service.settleHubAcknowledgement(args);
      assert.isTrue(ack.incorporated);
      assert.strictEqual(yield* store.readCursor(space, environmentId), 0);
      assert.deepStrictEqual(
        (yield* store.receipt(space, reference.operationId))?.receipt,
        receipt,
      );
      assert.isFalse((yield* service.settleHubAcknowledgement(args)).incorporated);
      const operation = yield* store.readOperation(space, reference.operationId);
      assert.isDefined(operation);
      const page: M.MemoryHubPullResult = {
        highWatermark: 7,
        throughSequence: 7,
        hasMore: false,
        entries: [{ kind: "operation", operation: operation!, receipt, hubSequence: 7 }],
      };
      const pullArgs = {
        memorySpaceId: space,
        hubEnvironmentId: environmentId,
        localEnvironmentId: environmentId,
        expectedSequence: 0,
        page,
        reauthorize: Effect.void,
      };
      assert.strictEqual((yield* service.receiveHubPage(pullArgs)).length, 1);
      assert.strictEqual(yield* store.readCursor(space, environmentId), 7);
      assert.deepStrictEqual(yield* service.receiveHubPage(pullArgs), []);
    }).pipe(Effect.provide(live)),
);

it.effect(
  "settles a null-sequence forget refusal without canonical promotion, reports or cursor movement",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* service.upsert(input(), Effect.void);
      const operationId = M.MemoryOperationId.make(id(4));
      const original = yield* service.forget(
        { memorySpaceId: space, memoryId, operationId, expectedHeads: [] },
        Effect.void,
      );
      const receipt: M.MemoryHubReceipt = {
        operationId,
        memoryId,
        operationDigest: original.operationDigest,
        outcome: "rejected",
        hubSequence: null,
        failureCode: "capacity_exceeded",
        capacity: {
          code: "capacity_exceeded",
          dimension: "permanent_metadata",
          current: M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
          limit: M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
          reclaimable: 0,
        },
      };
      const args = {
        memorySpaceId: space,
        hubEnvironmentId: environmentId,
        localEnvironmentId: environmentId,
        workId: `sync:${space}:${operationId}`,
        operation: { operationId, operationDigest: original.operationDigest },
        receipt,
        reauthorize: Effect.void,
      };
      assert.isFalse((yield* service.settleHubAcknowledgement(args)).incorporated);
      assert.deepStrictEqual(yield* store.receipt(space, operationId), original);
      assert.strictEqual(yield* store.readCursor(space, environmentId), 0);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_report_outbox`).length, 0);
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "forgotten");
      assert.strictEqual((yield* store.pendingForgetIntents(10))[0]?.submissionState, "rejected");
      yield* service.settleHubAcknowledgement(args);
      assert.deepStrictEqual(yield* store.receipt(space, operationId), original);
    }).pipe(Effect.provide(live)),
);

it.effect(
  "reads legacy non-thirty-day resolutions and stages offline revert despite a fast device clock",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* service.upsert(input(), Effect.void);
      const original = (yield* store.loadAggregate(space, memoryId)).revisions[0]!;
      const second = { ...input(4), expectedHeads: [original.revision.revisionId] };
      yield* service.upsert(second, Effect.void);
      const current = yield* store.loadAggregate(space, memoryId);
      const result = current.revisions.find((r) => r.revision.operationId === second.operationId)!;
      const resolutionId = M.MemoryResolutionId.make(id(90));
      const selection: M.MemoryModelSelection = {
        instanceId: M.ProviderInstanceId.make("fixture"),
        model: "fixture",
      };
      const inputIds = [original.revision.revisionId, M.MemoryRevisionId.make(id(91))].sort();
      const resolution: M.MemoryResolution = {
        resolutionId,
        memorySpaceId: space,
        memoryId,
        inputRevisionIds: inputIds,
        inputPayloadRefs: inputIds,
        judgmentRef: resolutionId,
        requestedModelSelection: selection,
        effectiveProvider: M.ProviderDriverKind.make("codex"),
        effectiveModel: "fixture",
        resolvingEnvironmentId: environmentId,
        fencingToken: 1,
        resultRevisionId: result.revision.revisionId,
        appliedAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
        revertDeadlineUtc: M.MemoryUtcTimestamp.make("2026-10-15T00:00:00.000Z"),
      };
      yield* sql`INSERT INTO memory_resolutions(space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json) VALUES (${space},${resolutionId},${memoryId},${yield* encodeRevisionIds(inputIds)},${yield* encodeRevisionIds(inputIds)},${resolutionId},${yield* encodeSelectionJson(selection)},'{}',${environmentId},1,${result.revision.revisionId},${Date.parse(resolution.appliedAtUtc)},${Date.parse(resolution.revertDeadlineUtc)},${yield* encodeResolution(resolution)})`;
      assert.deepStrictEqual((yield* store.loadAggregate(space, memoryId)).resolutions, [
        resolution,
      ]);
      yield* TestClock.setTime(Date.parse("2030-01-01T00:00:00.000Z"));
      const staged = yield* service.revertResolution(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(6)),
          resolutionId,
          restoredRevisionId: original.revision.revisionId,
          expectedHeads: [result.revision.revisionId],
        },
        Effect.void,
      );
      assert.strictEqual(staged.status, "pending");
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_revert_intents`).length, 1);
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(7)),
          expectedHeads: [],
        },
        Effect.void,
      );
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "forgotten");
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND memory_id=${memoryId}`)
          .length,
        0,
      );
    }).pipe(Effect.provide(live)),
);

describe("MemoryService source outcome fencing", () => {
  it.effect("rechecks evidence, permission and generation after source output arrives", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sourceThread = {
        environmentId: M.EnvironmentId.make("synthetic-owner"),
        threadId: M.ThreadId.make("synthetic-thread"),
      };
      const watermark = {
        fromEventId: M.EventId.make("synthetic-from"),
        toEventId: M.EventId.make("synthetic-to"),
        throughSequence: 8,
      };
      const messageId = M.MessageId.make("synthetic-message");
      const op: M.MemoryOperation = {
        protocolVersion: 1,
        kind: "upsert",
        memorySpaceId: space,
        memoryId,
        operationId: M.MemoryOperationId.make(id(500)),
        originEnvironmentId: environmentId,
        expectedHeads: [],
        revision: {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(500)),
          revisionId: M.MemoryRevisionId.make(id(501)),
          payloadRef: M.MemoryRevisionId.make(id(501)),
          parents: [],
          scope: { kind: "user" },
          assertionKind: "inference",
          createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
          provenance: { environmentId, sourceThread, sourceWatermark: watermark },
        },
        payload: {
          text: "synthetic linked summary",
          evidence: [{ origin: "thread", sourceThread, watermark, messageIds: [messageId] }],
          derivedFromMemoryRevisions: [],
        },
      };
      const aggregate = yield* store.loadAggregate(space, memoryId);
      yield* store.apply(
        decideMemoryOperation(aggregate, op, Store.localIntent, scanMemoryValue(op)),
      );
      const read = {
        memorySpaceId: space,
        memoryId,
        sourceThread,
        messageIds: [messageId],
        limit: 10,
      };
      const request = yield* service.prepareSourceRead(read, Effect.void);
      const outcome: M.MemorySourceReadOutcome = {
        kind: "available",
        page: {
          sourceThread,
          watermark,
          messages: [{ messageId, text: "synthetic original" }],
          nextCursor: null,
        },
      };
      assert.deepStrictEqual(
        yield* service.validateSourceOutcome({ request, outcome }, Effect.void),
        outcome,
      );
      assert.strictEqual(
        (yield* service.validateSourceOutcome({ request, outcome }, denied).pipe(Effect.flip))._tag,
        "MemoryAccessError",
      );
      const wrong = {
        ...outcome,
        page: { ...outcome.page, sourceThread: { ...sourceThread, environmentId } },
      };
      const mismatch = yield* service
        .validateSourceOutcome({ request, outcome: wrong }, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(mismatch._tag, "MemoryStoreConflict");
      if (mismatch._tag === "MemoryStoreConflict")
        assert.strictEqual(mismatch.code, "source_invalidated");
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(502)),
          expectedHeads: [M.MemoryRevisionId.make(id(501))],
        },
        Effect.void,
      );
      const forgotten = yield* service
        .validateSourceOutcome({ request, outcome }, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(forgotten._tag, "MemoryStoreConflict");
      if (forgotten._tag === "MemoryStoreConflict") assert.strictEqual(forgotten.code, "forgotten");
    }).pipe(Effect.provide(live)),
  );
});
