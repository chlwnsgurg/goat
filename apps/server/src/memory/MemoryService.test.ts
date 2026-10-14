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
import lineageMigration from "../persistence/Migrations/074_MemoryImportLineage.ts";
import hubMigration from "../persistence/Migrations/071_MemoryHubSync.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import searchMigration from "../persistence/Migrations/072_MemorySearchCounters.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import { memoryAccessPermit } from "./MemoryAccess.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const environmentId = M.EnvironmentId.make("fixture");
const database = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(searchMigration),
  ),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const store = Store.layer.pipe(Layer.provideMerge(database));
const serviceLive = (serviceLayer = Service.layer) =>
  serviceLayer.pipe(
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
const decodeRpcError = Schema.decodeUnknownEffect(M.MemoryRpcError);
const encodeRpcError = Schema.encodeEffect(M.MemoryRpcError);
const encodeItemJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryItem));
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
        const coverage = yield* store.searchCoverage({
          memorySpaceId: space,
          scope: { kind: "user" },
          limit: 100,
        });
        assert.isTrue(coverage.ready);
        assert.strictEqual(coverage.eligible, 1);
        assert.strictEqual(coverage.textBytes, new TextEncoder().encode(op.payload.text).length);
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
  it.effect("consumes read-only write denial before any domain mutation", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const permit = memoryAccessPermit(
        {
          grantedScopes: ["memory:read", "memory:write"],
          reauthorize: () => Effect.void,
          readOnly: true,
        },
        "write",
      );
      assert.strictEqual(
        (yield* service.upsert(input(), permit).pipe(Effect.flip))._tag,
        "MemoryAccessError",
      );
      assert.deepStrictEqual(
        (yield* service.list(
          { memorySpaceId: space, limit: 100, includeQuarantined: true },
          Effect.void,
        )).items,
        [],
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("binds search continuation to normalized query, mode, space and scope", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      yield* service.upsert(input(), Effect.void);
      const request = {
        memorySpaceId: space,
        query: "synthetic",
        limit: 1,
        mode: "substring" as const,
      };
      const first = yield* service.search(request, Effect.void);
      assert.isTrue(first.nextCursor?.startsWith("ms1:"));
      assert.isFalse(first.nextCursor!.includes("synthetic"));
      const last = yield* service.search(
        { ...request, query: "synthetic", cursor: first.nextCursor! },
        Effect.void,
      );
      assert.deepStrictEqual(last.items, []);
      assert.isNull(last.nextCursor);
      for (const mismatch of [
        { query: "other" },
        { mode: "fts" as const },
        { memorySpaceId: M.MemorySpaceId.make(id(999)) },
        {
          scope: {
            kind: "project" as const,
            projectKey: { kind: "explicit" as const, sharedProjectId: "fixture" },
          },
        },
      ]) {
        const failure = yield* service
          .search({ ...request, ...mismatch, cursor: first.nextCursor! }, Effect.void)
          .pipe(Effect.flip);
        assert.isTrue("code" in failure && failure.code === "invalid_cursor");
      }
      const codec = Schema.fromJsonString(M.MemoryPage);
      const wire = yield* Schema.encodeEffect(codec)(first);
      assert.deepStrictEqual(yield* Schema.decodeEffect(codec)(wire), first);
      // Both MCP/RPC receive this page: transport serialization preserves the examined cursor.
      let checks = 0;
      const revoked = Effect.suspend(() => (++checks === 1 ? Effect.void : denied));
      assert.strictEqual(
        (yield* service.search(request, revoked).pipe(Effect.flip))._tag,
        "MemoryAccessError",
      );
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
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_events WHERE operation_id=${reference.operationId}`)
          .length,
        1,
      );
      assert.isTrue(
        (yield* store.loadAggregate(space, memoryId)).item?.localAvailability.reasons.includes(
          "scanner_pending",
        ),
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
      const op = yield* store.readOperation(space, operationId);
      const accepted: M.MemoryHubReceipt = {
        operationId,
        memoryId,
        operationDigest: original.operationDigest,
        outcome: "deleted",
        hubSequence: 1,
      };
      yield* service.receiveHubPage({
        memorySpaceId: space,
        hubEnvironmentId: environmentId,
        localEnvironmentId: environmentId,
        expectedSequence: 0,
        reauthorize: Effect.void,
        page: {
          entries: [{ kind: "operation", operation: op!, receipt: accepted, hubSequence: 1 }],
          throughSequence: 1,
          highWatermark: 1,
          hasMore: false,
        },
      });
      assert.deepStrictEqual(yield* store.pendingForgetIntents(10), []);
      assert.deepStrictEqual((yield* store.receipt(space, operationId))?.receipt, accepted);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_events WHERE operation_id=${operationId}`).length,
        1,
      );
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

it.effect("rejects an empty pull that skips canonical sequences and leaves the cursor intact", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const store = yield* Store.MemoryStore;
    const args = {
      memorySpaceId: space,
      hubEnvironmentId: environmentId,
      localEnvironmentId: environmentId,
      expectedSequence: 0,
      reauthorize: Effect.void,
      page: { entries: [], throughSequence: 100, highWatermark: 100, hasMore: false },
    };
    assert.strictEqual(
      (yield* service.receiveHubPage(args).pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    assert.strictEqual(yield* store.readCursor(space, environmentId), 0);
    assert.deepStrictEqual(
      yield* service.receiveHubPage({ ...args, page: { ...args.page, throughSequence: 0 } }),
      [],
    );
  }).pipe(Effect.provide(live)),
);

it.effect(
  "records semantic refusals once but rolls back unallocatable and post-append failures",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${environmentId},${"a".repeat(64)},1,'active')`;
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
      const op: M.MemoryOperation = {
        protocolVersion: 1,
        kind: "revert",
        memorySpaceId: space,
        memoryId,
        operationId: M.MemoryOperationId.make(id(900)),
        originEnvironmentId: environmentId,
        expectedHeads: [M.MemoryRevisionId.make(id(901))],
        revertsResolutionId: M.MemoryResolutionId.make(id(905)),
        restoredRevisionId: M.MemoryRevisionId.make(id(906)),
        revision: {
          memorySpaceId: space,
          memoryId,
          revisionId: M.MemoryRevisionId.make(id(902)),
          operationId: M.MemoryOperationId.make(id(900)),
          parents: [M.MemoryRevisionId.make(id(901))],
          scope: { kind: "user" },
          payloadRef: M.MemoryRevisionId.make(id(902)),
          assertionKind: "inference",
          provenance: { environmentId },
          createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
        },
        payload: { text: "synthetic refused body", evidence: [], derivedFromMemoryRevisions: [] },
      };
      const refusal = yield* service.admitHubOperation({ authority, operation: op });
      assert.strictEqual(refusal.outcome, "rejected");
      assert.isNotNull(refusal.hubSequence);
      assert.deepStrictEqual(
        yield* service.admitHubOperation({ authority, operation: op }),
        refusal,
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_operations`).length, 1);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_identity_ledger`).length, 0);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_payloads`).length, 0);
      const before = yield* sql`SELECT * FROM memory_quota_counters`;
      // Permit row allocation, then fail the actual encoded-entry byte gate after append's placeholder INSERT.
      yield* sql`UPDATE memory_hub_operations SET entry_json=CAST(zeroblob(${M.MEMORY_LOG_MAX_TAIL_BYTES - 1}) AS TEXT)`;
      const second = {
        ...op,
        operationId: M.MemoryOperationId.make(id(903)),
        revision: { ...op.revision, operationId: M.MemoryOperationId.make(id(903)) },
      };
      assert.strictEqual(
        (yield* store
          .transact(service.admitHubOperation({ authority, operation: second }))
          .pipe(Effect.flip))._tag,
        "MemoryStorageError",
      );
      const capacity = yield* service.admitHubOperation({ authority, operation: second });
      assert.strictEqual(capacity.failureCode, "capacity_exceeded");
      assert.isNull(capacity.hubSequence);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_operations`).length, 1);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_compact_receipts`).length, 1);
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_quota_counters`, before);
      yield* sql`UPDATE memory_hub_operations SET entry_json='{}'`;
      yield* sql`CREATE TRIGGER fixture_apply_failure BEFORE INSERT ON memory_events BEGIN SELECT RAISE(ABORT,'synthetic apply failure'); END`;
      const {
        revertsResolutionId: _resolution,
        restoredRevisionId: _restored,
        ...rootMetadata
      } = second;
      const root = {
        ...rootMetadata,
        kind: "upsert" as const,
        operationId: M.MemoryOperationId.make(id(904)),
        expectedHeads: [],
        revision: {
          ...second.revision,
          operationId: M.MemoryOperationId.make(id(904)),
          parents: [],
        },
      };
      assert.strictEqual(
        (yield* service.admitHubOperation({ authority, operation: root }).pipe(Effect.flip))._tag,
        "MemoryStorageError",
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_operations`).length, 1);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_compact_receipts`).length, 1);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_payloads`).length, 0);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_identity_ledger`).length, 0);
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_quota_counters`, before);
    }).pipe(Effect.provide(live)),
);

it.effect.each(["accepted", "rejected"] as const)(
  "settles lost revert ACK by %s pull without resending or retaining a refused body",
  (outcome) =>
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
      const operationId = M.MemoryOperationId.make(id(6));
      const workId = `revert:${space}:${operationId}`;
      const op = yield* store.readWorkOperation(workId);
      assert.isDefined(op);
      const receipt: M.MemoryHubReceipt = {
        operationId,
        memoryId,
        operationDigest: memoryOperationDigest(op!),
        outcome,
        hubSequence: 1,
        ...(outcome === "rejected" ? { failureCode: "revert_expired" as const } : {}),
      };
      const entry: M.MemoryHubEntry =
        outcome === "rejected"
          ? { kind: "metadata", operationKind: "revert", memoryId, receipt, hubSequence: 1 }
          : { kind: "operation", operation: op!, receipt, hubSequence: 1 };
      const settled = yield* service.receiveHubPage({
        memorySpaceId: space,
        hubEnvironmentId: environmentId,
        localEnvironmentId: environmentId,
        expectedSequence: 0,
        reauthorize: Effect.void,
        page: { entries: [entry], throughSequence: 1, highWatermark: 1, hasMore: false },
      });
      assert.strictEqual(settled[0]?.intent, outcome === "rejected" ? "rejected" : "completed");
      assert.strictEqual(
        (yield* store.readWork(workId))?.status,
        outcome === "rejected" ? "failed" : "completed",
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_revert_intents`).length, 0);
      assert.strictEqual(yield* store.readCursor(space, environmentId), 1);
      if (op?.kind === "revert" && outcome === "rejected")
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${op.revision.payloadRef}`)
            .length,
          0,
        );
    }).pipe(Effect.provide(live)),
);

describe("body-free hub metadata report ownership", () => {
  it.effect.each([true, false])(
    "uses the compact guard on first receive and restart: local owner %s",
    (localOwner) =>
      Effect.gen(function* () {
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const owner = localOwner ? environmentId : M.EnvironmentId.make("foreign-owner");
        const operationId = M.MemoryOperationId.make(id(880));
        const resolutionId = M.MemoryResolutionId.make(id(881));
        const receipt: M.MemoryHubReceipt = {
          operationId,
          memoryId,
          operationDigest: "a".repeat(64),
          outcome: "accepted",
          hubSequence: 1,
          resolutionApproval: {
            resolutionId,
            appliedAtUtc: "2026-10-14T00:00:00.000Z",
            revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
          },
        };
        const reportId = Store.resolutionReportId(space, operationId, resolutionId);
        const compact: M.MemoryCompactReceipt = {
          memorySpaceId: space,
          originEnvironmentId: owner,
          operationKind: "resolve",
          receipt,
          revisionId: M.MemoryRevisionId.make(id(882)),
          resolutionId,
          revertsResolutionId: null,
          attemptId: operationId,
          fencingToken: 1,
          reportGuard: {
            reportId,
            resolvingEnvironmentId: owner,
            resolutionId,
            outcome: "resolved",
          },
        };
        const entry: M.MemoryHubEntry = {
          kind: "metadata",
          operationKind: "resolve",
          resolutionId,
          receipt,
          memoryId,
          hubSequence: 1,
          compactReceipt: compact,
        };
        const settlement = {
          memorySpaceId: space,
          hubEnvironmentId: M.EnvironmentId.make("hub"),
          localEnvironmentId: environmentId,
          entry,
        };
        yield* store.transact(service.settleHubEntryTx(settlement));
        yield* store.transact(service.settleHubEntryTx(settlement));
        const reports = yield* service.pendingReports(100);
        assert.strictEqual(reports.length, Number(localOwner));
        if (localOwner) assert.strictEqual(reports[0]!.reportId, reportId);
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_compact_receipts WHERE report_key=${reportId}`).length,
          1,
        );
        assert.strictEqual((yield* sql`SELECT 1 FROM memory_payloads`).length, 0);
        const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        const replay = yield* fresh.transact(fresh.readHubReceiptTx(space, operationId));
        assert.strictEqual(replay?.entry.kind, "metadata");
        if (replay?.entry.kind === "metadata")
          assert.deepStrictEqual(replay.entry.compactReceipt, compact);
        yield* fresh.transact(
          fresh.reconcileResolutionReportTx({ record: compact, localEnvironmentId: environmentId }),
        );
        assert.strictEqual((yield* fresh.pendingReports(100)).length, Number(localOwner));
        if (localOwner) {
          const report = (yield* fresh.pendingReports(100))[0]!;
          const delivered = {
            ...report,
            state: "delivered" as const,
            reportThread: { environmentId, threadId: M.ThreadId.make("report-fixture") },
            sequence: 1,
          };
          yield* fresh
            .transact(
              fresh
                .acknowledgeReport(delivered)
                .pipe(
                  Effect.andThen(
                    Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" })),
                  ),
                ),
            )
            .pipe(Effect.flip);
          assert.strictEqual((yield* fresh.pendingReports(100)).length, 1);
          assert.strictEqual(
            (yield* sql`SELECT 1 FROM memory_import_keys WHERE key_kind='report_delivered'`).length,
            0,
          );
          yield* fresh.acknowledgeReport(delivered);
          assert.strictEqual((yield* fresh.pendingReports(100)).length, 0);
          // Simulate expiration of the detailed delivery row; the permanent guard must stop replay.
          yield* sql`DELETE FROM memory_report_outbox WHERE report_id=${reportId}`;
          const again = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
          assert.isFalse(
            (yield* again.transact(
              again.reconcileResolutionReportTx({
                record: compact,
                localEnvironmentId: environmentId,
              }),
            )).deliverable,
          );
          assert.strictEqual((yield* again.pendingReports(100)).length, 0);
        }
      }).pipe(Effect.provide(live)),
  );
});

it.effect.each(["ack", "pull", "metadata"] as const)(
  "preserves local forget retry and expansion relations after %s promotion and replay",
  (path) =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* service.upsert(input(), Effect.void);
      const originalId = M.MemoryOperationId.make(id(961));
      yield* service.forget(
        { memorySpaceId: space, memoryId, operationId: originalId, expectedHeads: [] },
        Effect.void,
      );
      const original = yield* store.readOperation(space, originalId);
      if (original?.kind !== "forget") throw new Error("fixture");
      const rejected = {
        operationId: originalId,
        memoryId,
        outcome: "rejected" as const,
        revisionId: null,
        pendingSync: false,
        failureCode: "capacity_exceeded" as const,
      };
      yield* sql`UPDATE memory_events SET receipt_json=${JSON.stringify(rejected)} WHERE operation_id=${originalId}`;
      const retryId = M.MemoryOperationId.make(id(962));
      const op = {
        ...original,
        operationId: retryId,
        tombstone: { ...original.tombstone, deleteOperationId: retryId },
      };
      const decision = decideMemoryOperation(
        yield* store.loadAggregate(space, memoryId),
        op,
        Store.localIntent,
        { kind: "allowed" },
      );
      const links = {
        forgetRetryOf: {
          operationId: originalId,
          operationDigest: memoryOperationDigest(original),
        },
        forgetExpansion: {
          requestDigest: "b".repeat(64),
          operationId: M.MemoryOperationId.make(id(963)),
          operationDigest: "c".repeat(64),
          status: "accepted" as const,
        },
      };
      yield* store.apply({ ...decision, receipt: { ...decision.receipt, ...links } });
      assert.deepStrictEqual(yield* store.pendingForgetIntents(100), []);
      const canonical: M.MemoryHubReceipt = {
        operationId: retryId,
        memoryId,
        operationDigest: memoryOperationDigest(op),
        outcome: "deleted",
        hubSequence: 1,
      };
      const entry: M.MemoryHubEntry =
        path === "metadata"
          ? {
              kind: "metadata",
              operationKind: "forget",
              memoryId,
              receipt: canonical,
              hubSequence: 1,
              tombstone: op.tombstone,
            }
          : { kind: "operation", operation: op, receipt: canonical, hubSequence: 1 };
      const base = {
        memorySpaceId: space,
        hubEnvironmentId: environmentId,
        localEnvironmentId: environmentId,
        reauthorize: Effect.void,
      };
      if (path === "ack") {
        const args = {
          ...base,
          workId: `sync:${space}:${retryId}`,
          operation: { operationId: retryId, operationDigest: canonical.operationDigest },
          receipt: canonical,
        };
        yield* service.settleHubAcknowledgement(args);
        yield* service.settleHubAcknowledgement(args);
      } else {
        yield* service.receiveHubPage({
          ...base,
          expectedSequence: 0,
          page: { entries: [entry], throughSequence: 1, highWatermark: 1, hasMore: false },
        });
        yield* store.transact(service.settleHubEntryTx({ ...base, entry }));
      }
      const promoted = (yield* store.receipt(space, retryId))!.receipt;
      assert.deepStrictEqual(promoted.forgetRetryOf, links.forgetRetryOf);
      assert.deepStrictEqual(promoted.forgetExpansion, links.forgetExpansion);
      assert.deepStrictEqual(yield* store.pendingForgetIntents(100), []);
      assert.strictEqual((yield* store.readWork(`sync:${space}:${retryId}`))?.status, "completed");
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(yield* fresh.pendingForgetIntents(100), []);
      yield* fresh.persistCompactReceipt({
        memorySpaceId: space,
        originEnvironmentId: environmentId,
        operationKind: "forget",
        receipt: canonical,
        revisionId: null,
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      });
      yield* fresh.persistCompactReceipt({
        memorySpaceId: space,
        originEnvironmentId: environmentId,
        operationKind: "forget",
        receipt: canonical,
        revisionId: null,
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      });
      yield* sql`DELETE FROM memory_events WHERE operation_id=${retryId}`;
      assert.deepStrictEqual(
        (yield* fresh.receipt(space, retryId))?.receipt.forgetRetryOf,
        links.forgetRetryOf,
      );
      assert.deepStrictEqual(
        (yield* fresh.receipt(space, retryId))?.receipt.forgetExpansion,
        links.forgetExpansion,
      );
      assert.deepStrictEqual(yield* fresh.pendingForgetIntents(100), []);
    }).pipe(Effect.provide(live)),
);

it.effect(
  "hub upsert reserves the next checkpoint with old pins at equality and refuses plus one without a sequence",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${environmentId},${"a".repeat(64)},1,'active')`;
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
      const op: M.MemoryOperation = {
        protocolVersion: 1,
        kind: "upsert",
        memorySpaceId: space,
        memoryId,
        operationId: M.MemoryOperationId.make(id(1200)),
        originEnvironmentId: environmentId,
        expectedHeads: [],
        revision: {
          memorySpaceId: space,
          memoryId,
          revisionId: M.MemoryRevisionId.make(id(1201)),
          operationId: M.MemoryOperationId.make(id(1200)),
          parents: [],
          scope: { kind: "user" },
          payloadRef: M.MemoryRevisionId.make(id(1201)),
          assertionKind: "inference",
          provenance: { environmentId },
          createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
        },
        payload: {
          text: "synthetic reservation boundary",
          evidence: [],
          derivedFromMemoryRevisions: [],
        },
      };
      yield* store.transact(
        store.prepareHubCheckpointTx({
          authority,
          checkpointId: "old-pinned",
          snapshotToken: "old-pinned-token",
          hubEnvironmentId: environmentId,
        }),
      );
      const before = yield* store.transact(store.readHubUsageTx(space));
      const measured = yield* store
        .transact(
          Effect.gen(function* () {
            yield* service.admitHubOperationTx({ authority, operation: op });
            return yield* Effect.fail(
              (yield* store.readHubUsageTx(space)).requiredCheckpointBoundBytes,
            );
          }),
        )
        .pipe(Effect.flip);
      if (typeof measured !== "number") throw new Error("fixture admission failed");
      assert.isAbove(measured, before.requiredCheckpointBoundBytes);
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: 0,
          publishedPinnedDeltaBytes:
            M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - measured - before.publishedPinnedBytes + 1,
        }),
      );
      const denied = yield* service.admitHubOperation({ authority, operation: op });
      assert.strictEqual(denied.failureCode, "capacity_exceeded");
      assert.strictEqual(denied.capacity?.dimension, "checkpoint_staging");
      assert.isNull(denied.hubSequence);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_operations`).length, 0);
      assert.isUndefined((yield* store.loadAggregate(space, memoryId)).identity);
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: 0,
          publishedPinnedDeltaBytes: -1,
        }),
      );
      const accepted = yield* service.admitHubOperation({ authority, operation: op });
      assert.strictEqual(accepted.outcome, "accepted");
      assert.strictEqual(
        (yield* store.transact(store.readHubUsageTx(space))).stagingBytes,
        M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
      );
      yield* store.transact(
        store.prepareHubProducerCheckpointTx({
          authority,
          checkpointId: "new-required",
          hubEnvironmentId: environmentId,
        }),
      );
      const preparedUsage = yield* store.transact(store.readHubUsageTx(space));
      assert.isAbove(preparedUsage.checkpointReservationConsumedBytes, 0);
      assert.strictEqual(preparedUsage.stagingBytes, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES);
      assert.deepStrictEqual(
        yield* service.admitHubOperation({ authority, operation: op }),
        accepted,
      );
    }).pipe(Effect.provide(live)),
);

it.effect("index-only updates preserve materialized checkpoint credit and staging usage", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${environmentId},${"a".repeat(64)},1,'active')`;
    yield* service.upsert(input(1290), Effect.void);
    const operation = yield* store.readWorkOperation(`sync:${space}:${id(1290)}`);
    if (!operation) throw new Error("fixture");
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
    yield* service.admitHubOperation({ authority, operation });
    yield* store.transact(
      store.prepareHubProducerCheckpointTx({
        authority,
        checkpointId: "index-staging",
        hubEnvironmentId: environmentId,
      }),
    );
    const before = yield* store.transact(store.readHubUsageTx(space));
    assert.isAbove(before.checkpointReservationConsumedBytes, 0);
    const generation =
      yield* sql`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_generation'`;
    yield* sql`UPDATE memory_items SET index_state='ready',indexed_revision='local-index',indexed_generation=7,indexed_bytes=123 WHERE space=${space}`;
    assert.deepStrictEqual(
      yield* sql`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_generation'`,
      generation,
    );
    assert.deepStrictEqual(yield* store.transact(store.readHubUsageTx(space)), before);
    assert.isAbove(
      (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:index-staging'`)
        .length,
      0,
    );
  }).pipe(Effect.provide(live)),
);

it.effect.each(["status", "kind", "memory_id"] as const)(
  "outbox %s changes reclaim producer staging atomically",
  (changedInput) =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${environmentId},${"a".repeat(64)},1,'active')`;
      yield* service.upsert(input(1291), Effect.void);
      const workId = `sync:${space}:${id(1291)}`;
      const operation = yield* store.readWorkOperation(workId);
      if (!operation) throw new Error("fixture");
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
      yield* service.admitHubOperation({ authority, operation });
      yield* sql`UPDATE memory_outbox SET status='running' WHERE id=${workId}`;
      yield* store.transact(
        store.prepareHubProducerCheckpointTx({
          authority,
          checkpointId: "outbox-staging",
          hubEnvironmentId: environmentId,
        }),
      );
      const before = yield* store.transact(store.readHubUsageTx(space));
      assert.isAbove(before.checkpointReservationConsumedBytes, 0);
      assert.isTrue((yield* store.loadAggregate(space, operation.memoryId)).item!.pendingSync);
      const generation = () =>
        sql<{
          value: number;
        }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_generation'`.pipe(
          Effect.map((rows) => rows[0]!.value),
        );
      const pages = () =>
        sql`SELECT metadata_json FROM memory_inbox_pending WHERE space=${space} AND checkpoint_id='hub:outbox-staging'`;
      const baselineGeneration = yield* generation();
      const baselinePages = yield* pages();
      assert.isAbove(baselinePages.length, 0);
      const snapshotPending = (checkpoint: string) =>
        sql<{
          pending: number;
        }>`SELECT json_extract(i.value,'$.pendingSync') AS pending FROM memory_inbox_pending p,json_each(p.metadata_json,'$.items') i WHERE p.space=${space} AND p.checkpoint_id=${checkpoint} AND json_extract(i.value,'$.memoryId')=${operation.memoryId}`;
      assert.deepStrictEqual(yield* snapshotPending("hub:outbox-staging"), [{ pending: 1 }]);
      yield* sql`UPDATE memory_outbox SET next_attempt_at=next_attempt_at+1 WHERE id=${workId}`;
      assert.strictEqual(yield* generation(), baselineGeneration);
      assert.deepStrictEqual(yield* pages(), baselinePages);
      assert.deepStrictEqual(yield* store.transact(store.readHubUsageTx(space)), before);
      const change =
        changedInput === "status"
          ? sql`UPDATE memory_outbox SET status='completed' WHERE id=${workId}`
          : changedInput === "kind"
            ? sql`UPDATE memory_outbox SET kind='claim' WHERE id=${workId}`
            : sql`UPDATE memory_outbox SET memory_id='other-memory' WHERE id=${workId}`;
      const verify = Effect.gen(function* () {
        yield* change;
        assert.isFalse((yield* store.loadAggregate(space, operation.memoryId)).item!.pendingSync);
        assert.strictEqual(yield* generation(), baselineGeneration + 1);
        assert.deepStrictEqual(yield* pages(), []);
        assert.deepStrictEqual(
          yield* sql`SELECT reserved_snapshot_id,snapshot_generation FROM memory_hub_retention WHERE space=${space}`,
          [{ reserved_snapshot_id: null, snapshot_generation: -1 }],
        );
        const after = yield* store.readHubUsageTx(space);
        assert.strictEqual(after.checkpointReservationConsumedBytes, 0);
        assert.strictEqual(after.requiredCheckpointBoundBytes, before.requiredCheckpointBoundBytes);
        assert.isAtMost(after.stagingBytes, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES);
      });
      assert.strictEqual(
        yield* store
          .transact(verify.pipe(Effect.andThen(Effect.fail("rollback"))))
          .pipe(Effect.flip),
        "rollback",
      );
      assert.strictEqual(yield* generation(), baselineGeneration);
      assert.deepStrictEqual(yield* pages(), baselinePages);
      assert.deepStrictEqual(yield* store.transact(store.readHubUsageTx(space)), before);
      yield* store.transact(verify);
      yield* store.transact(
        store.prepareHubProducerCheckpointTx({
          authority,
          checkpointId: "outbox-restaged",
          hubEnvironmentId: environmentId,
        }),
      );
      assert.deepStrictEqual(yield* snapshotPending("hub:outbox-restaged"), [{ pending: 0 }]);
    }).pipe(Effect.provide(live)),
);

it.effect(
  "first forget reclaims large current staging at equality while retaining an older pin",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${environmentId},${"a".repeat(64)},1,'active')`;
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
      for (let n = 0; n < 48; n++) {
        const upsert = {
          ...input(1500 + n),
          memoryId: n === 0 ? memoryId : M.MemoryId.make(id(1600 + n)),
          payload: {
            text: n === 0 ? "small" : "synthetic bulk ".repeat(500),
            evidence: [],
            derivedFromMemoryRevisions: [],
          },
        };
        yield* service.upsert(upsert, Effect.void);
        const operation = yield* store.readWorkOperation(`sync:${space}:${id(1500 + n)}`);
        if (!operation) throw new Error("fixture");
        assert.strictEqual(
          (yield* service.admitHubOperation({ authority, operation })).outcome,
          "accepted",
        );
      }
      const pin = yield* store.transact(
        store.prepareHubCheckpointTx({
          authority,
          checkpointId: "retained-large",
          snapshotToken: "retained-large-token",
          hubEnvironmentId: environmentId,
        }),
      );
      assert.strictEqual(
        (yield* store.transact(store.readHubUsageTx(space))).checkpointReservationConsumedBytes,
        0,
      );
      yield* store.transact(
        store.prepareHubProducerCheckpointTx({
          authority,
          checkpointId: "current-large",
          hubEnvironmentId: environmentId,
        }),
      );
      const current = yield* store.transact(store.readHubUsageTx(space));
      assert.isAbove(current.checkpointReservationConsumedBytes, 100000);
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: 0,
          publishedPinnedDeltaBytes: M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - current.stagingBytes,
        }),
      );
      const equality = yield* store.transact(store.readHubUsageTx(space));
      assert.strictEqual(equality.stagingBytes, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES);
      const plusOne = yield* store
        .transact(
          store.reserveHubCheckpointTx({
            memorySpaceId: space,
            checkpointDeltaBytes: 0,
            publishedPinnedDeltaBytes: 1,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(plusOne._tag, "MemoryCapacityError");
      const pinDenied = yield* store
        .transact(
          store.prepareHubCheckpointTx({
            authority,
            checkpointId: "current-large",
            snapshotToken: "new-pin-token",
            hubEnvironmentId: environmentId,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(pinDenied._tag, "MemoryCapacityError");
      const publishDenied = yield* store
        .transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: "current-large",
            expectedFloor: 0,
            nextFloor: 0,
            now: 0,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(publishDenied._tag, "MemoryCapacityError");
      assert.deepStrictEqual(yield* store.transact(store.readHubUsageTx(space)), equality);
      assert.isNull((yield* store.transact(store.readHubRetentionTx(space))).checkpointId);
      const forget: M.MemoryOperation = {
        protocolVersion: 1,
        kind: "forget",
        memorySpaceId: space,
        memoryId,
        operationId: M.MemoryOperationId.make(id(1599)),
        originEnvironmentId: environmentId,
        expectedHeads: [],
        tombstone: {
          memorySpaceId: space,
          memoryId,
          deleteOperationId: M.MemoryOperationId.make(id(1599)),
          deletingEnvironmentId: environmentId,
          deletedAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      };
      const rolledBack = yield* store
        .transact(
          Effect.gen(function* () {
            assert.strictEqual(
              (yield* service.admitHubOperationTx({ authority, operation: forget })).outcome,
              "deleted",
            );
            assert.isAtMost(
              (yield* store.readHubUsageTx(space)).stagingBytes,
              M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
            );
            assert.strictEqual(
              (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:current-large'`)
                .length,
              0,
            );
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(rolledBack, "rollback");
      assert.deepStrictEqual(yield* store.transact(store.readHubUsageTx(space)), equality);
      assert.isAbove(
        (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:current-large'`)
          .length,
        0,
      );
      assert.strictEqual(
        (yield* service.admitHubOperation({ authority, operation: forget })).outcome,
        "deleted",
      );
      const after = yield* store.transact(store.readHubUsageTx(space));
      assert.strictEqual(after.checkpointReservationConsumedBytes, 0);
      assert.isAtMost(after.stagingBytes, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES);
      assert.isBelow(
        equality.requiredCheckpointBoundBytes - after.requiredCheckpointBoundBytes,
        current.checkpointReservationConsumedBytes,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:current-large'`)
          .length,
        0,
      );
      const page = yield* store.transact(
        store.readHubCheckpointPageTx({
          authority,
          snapshotToken: pin.snapshotToken,
          cursor: null,
        }),
      );
      assert.isTrue(
        page.items.some((item) => item.memoryId === memoryId && item.status === "blocked"),
      );
      assert.isTrue(
        page.items.some((item) => item.memoryId !== memoryId && item.status === "active"),
      );
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "forgotten");
    }).pipe(Effect.provide(live)),
);

it.effect(
  "the reserved first forget keeps checkpoint representability at a fully pinned budget",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${environmentId},${"a".repeat(64)},1,'active')`;
      yield* service.upsert(input(1300), Effect.void);
      const upsert = yield* store.readWorkOperation(`sync:${space}:${id(1300)}`);
      if (!upsert) throw new Error("fixture");
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
      yield* service.admitHubOperation({ authority, operation: upsert });
      const initial = yield* store.transact(store.readHubUsageTx(space));
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: 0,
          publishedPinnedDeltaBytes:
            M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - initial.requiredCheckpointBoundBytes,
        }),
      );
      const forget: M.MemoryOperation = {
        protocolVersion: 1,
        kind: "forget",
        memorySpaceId: space,
        memoryId,
        operationId: M.MemoryOperationId.make(id(1301)),
        originEnvironmentId: environmentId,
        expectedHeads: [],
        tombstone: {
          memorySpaceId: space,
          memoryId,
          deleteOperationId: M.MemoryOperationId.make(id(1301)),
          deletingEnvironmentId: environmentId,
          deletedAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      };
      const receipt = yield* service.admitHubOperation({ authority, operation: forget });
      assert.strictEqual(receipt.outcome, "deleted");
      assert.isAtMost(
        (yield* store.transact(store.readHubUsageTx(space))).stagingBytes,
        M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
      );
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "forgotten");
    }).pipe(Effect.provide(live)),
);

it.effect(
  "a fully reserved explicit checkpoint cannot mask a fresh upsert's incremental growth",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${environmentId},${"a".repeat(64)},1,'active')`;
      yield* service.upsert(input(1400), Effect.void);
      const operation = yield* store.readWorkOperation(`sync:${space}:${id(1400)}`);
      if (!operation) throw new Error("fixture");
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
          publishedPinnedDeltaBytes: 0,
        }),
      );
      const receipt = yield* service.admitHubOperation({
        authority: {
          principal: {
            memorySpaceId: space,
            environmentId,
            credentialVersion: 1,
            scopes: ["memory:sync"],
          },
          now: Clock.currentTimeMillis,
          reauthorize: Effect.void,
        },
        operation,
      });
      assert.strictEqual(receipt.failureCode, "capacity_exceeded");
      assert.strictEqual(receipt.capacity?.dimension, "checkpoint_staging");
      assert.isNull(receipt.hubSequence);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_operations`).length, 0);
      assert.isTrue((yield* store.loadAggregate(space, memoryId)).item?.pendingSync);
    }).pipe(Effect.provide(live)),
);

it.effect("commits 100 frozen local intents atomically and advances the next intent", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1)`;
    const createdAtUtc = "2026-10-13T01:02:03.000Z";
    const assignments = [];
    for (let n = 0; n < 101; n++) {
      const intentId = `frozen:${String(n).padStart(3, "0")}`;
      yield* store.putLocalIntent({
        intentId,
        environmentId,
        memoryId: M.MemoryId.make(id(10000 + n)),
        scope: { kind: "user" },
        assertionKind: "inference",
        provenance: { environmentId, effectiveModel: "original-model" },
        createdAtUtc,
        payload: { text: `synthetic intent ${n}`, evidence: [], derivedFromMemoryRevisions: [] },
      });
      assignments.push({
        intentId,
        memorySpaceId: space,
        operationId: M.MemoryOperationId.make(id(11000 + n)),
        revisionId: M.MemoryRevisionId.make(id(12000 + n)),
      });
    }
    const readBinding = Effect.succeed({
      memorySpaceId: space,
      coordinatorEpoch: 7,
      enabled: true,
    });
    const first = yield* service.commitLocalIntent({
      assignment: assignments[0]!,
      expectedEpoch: 7,
      readBinding,
    });
    if (first.operation.kind !== "upsert") throw new Error("fixture");
    assert.strictEqual(first.operation.revision.createdAtUtc, createdAtUtc);
    assert.strictEqual(first.operation.revision.provenance.effectiveModel, "original-model");
    assert.strictEqual(first.operation.revision.revisionId, assignments[0]!.revisionId);
    const replay = yield* service.commitLocalIntent({
      assignment: {
        ...assignments[0]!,
        operationId: M.MemoryOperationId.make(id(13000)),
        revisionId: M.MemoryRevisionId.make(id(13001)),
      },
      expectedEpoch: 7,
      readBinding,
    });
    assert.deepStrictEqual(replay, first);
    for (const assignment of assignments.slice(1, 100))
      yield* service.commitLocalIntent({ assignment, expectedEpoch: 7, readBinding });
    assert.deepStrictEqual(
      (yield* store.listMaterializableIntents(environmentId, 100)).map((i) => i.intentId),
      [assignments[100]!.intentId],
    );
    const target = assignments[100]!;
    // Failure after canonical/outbox writes must roll mapping, receipt and completion back.
    yield* sql.unsafe(
      "CREATE TRIGGER fail_intent_complete BEFORE UPDATE OF status ON memory_outbox WHEN OLD.id='local:fixture:frozen:100' AND NEW.status='completed' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    assert.strictEqual(
      (yield* service
        .commitLocalIntent({ assignment: target, expectedEpoch: 7, readBinding })
        .pipe(Effect.exit))._tag,
      "Failure",
    );
    assert.isUndefined(yield* store.receipt(space, target.operationId));
    assert.isUndefined(yield* store.readWork(`sync:${space}:${target.operationId}`));
    const row = yield* sql<{
      metadata_json: string;
    }>`SELECT metadata_json FROM memory_outbox WHERE id=${`local:${environmentId}:${target.intentId}`}`;
    assert.isNull(JSON.parse(row[0]!.metadata_json).mapping);
    yield* sql`DROP TRIGGER fail_intent_complete`;
    const changed = Effect.succeed({
      memorySpaceId: M.MemorySpaceId.make(id(14000)),
      coordinatorEpoch: 8,
      enabled: true,
    });
    assert.strictEqual(
      (yield* service
        .commitLocalIntent({ assignment: target, expectedEpoch: 7, readBinding: changed })
        .pipe(Effect.flip))._tag,
      "MemoryAccessError",
    );
    assert.isUndefined(yield* store.receipt(space, target.operationId));
    let reads = 0;
    const changedDuringCommit = Effect.sync(() =>
      ++reads === 1
        ? { memorySpaceId: space, coordinatorEpoch: 7, enabled: true }
        : { memorySpaceId: space, coordinatorEpoch: 8, enabled: true },
    );
    assert.strictEqual(
      (yield* service
        .commitLocalIntent({
          assignment: target,
          expectedEpoch: 7,
          readBinding: changedDuringCommit,
        })
        .pipe(Effect.flip))._tag,
      "MemoryAccessError",
    );
    assert.isUndefined(yield* store.receipt(space, target.operationId));
    yield* service.commitLocalIntent({ assignment: target, expectedEpoch: 7, readBinding });
    assert.deepStrictEqual(yield* store.listMaterializableIntents(environmentId, 100), []);
  }).pipe(Effect.provide(live)),
);

it.effect.each(["lost-response", "known-approval"] as const)(
  "r14 reconciles %s after changed heads without another generation",
  (mode) =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const at = M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z");
      const makeOp = (n: number, parents: readonly M.MemoryRevisionId[]): M.MemoryOperation => ({
        protocolVersion: 1,
        kind: "upsert",
        memorySpaceId: space,
        memoryId,
        operationId: M.MemoryOperationId.make(id(n)),
        originEnvironmentId: environmentId,
        expectedHeads: parents,
        revision: {
          memorySpaceId: space,
          memoryId,
          revisionId: M.MemoryRevisionId.make(id(n + 10)),
          operationId: M.MemoryOperationId.make(id(n)),
          parents,
          scope: { kind: "user" },
          payloadRef: M.MemoryRevisionId.make(id(n + 10)),
          assertionKind: "inference",
          provenance: { environmentId },
          createdAtUtc: at,
        },
        payload: {
          text: "synthetic reconcile input",
          evidence: [],
          derivedFromMemoryRevisions: [],
        },
      });
      const first = makeOp(3, []);
      if (first.kind !== "upsert") throw new Error("fixture");
      for (const op of [
        first,
        makeOp(4, [first.revision.revisionId]),
        makeOp(5, [first.revision.revisionId]),
      ])
        yield* store.apply(
          decideMemoryOperation(
            yield* store.loadAggregate(space, memoryId),
            op,
            Store.hubAdmission,
            { kind: "allowed" },
          ),
        );
      const current = yield* store.loadAggregate(space, memoryId);
      const heads = current.heads;
      const selection = { instanceId: M.ProviderInstanceId.make("fixture"), model: "fixture" };
      const ticket: M.MemoryResolutionLease = {
        memorySpaceId: space,
        memoryId,
        conflictId: current.conflicts[0]!.conflictId,
        conflictHeadSet: heads,
        attemptId: M.MemoryOperationId.make(id(70)),
        holderEnvironmentId: environmentId,
        fencingToken: 1,
        claimedAtHubTime: M.MemoryUtcTimestamp.make("1970-01-01T00:00:00.000Z"),
        expiresAtHubTime: M.MemoryUtcTimestamp.make("1970-01-01T00:02:00.000Z"),
        attemptDeadlineHubTime: M.MemoryUtcTimestamp.make("1970-01-01T00:10:00.000Z"),
        frozenDefaultModelSelection: selection,
      };
      yield* store.persistResolutionTicket(ticket);
      yield* store.recoverClaimCandidates(0);
      const claimCount = (yield* sql`SELECT 1 FROM memory_outbox WHERE kind='claim'`).length;
      const base = makeOp(80, heads);
      if (base.kind !== "upsert") throw new Error("fixture");
      const op: M.MemoryOperation = {
        ...base,
        kind: "resolve",
        conflictId: ticket.conflictId,
        fencingToken: 1,
        resolution: {
          resolutionId: M.MemoryResolutionId.make(id(81)),
          memorySpaceId: space,
          memoryId,
          inputRevisionIds: heads,
          inputPayloadRefs: heads,
          judgmentRef: M.MemoryResolutionId.make(id(81)),
          requestedModelSelection: selection,
          effectiveProvider: M.ProviderDriverKind.make("codex"),
          effectiveModel: "fixture",
          resolvingEnvironmentId: environmentId,
          fencingToken: 1,
          resultRevisionId: base.revision.revisionId,
          appliedAtUtc: at,
          revertDeadlineUtc: M.MemoryUtcTimestamp.make("2026-11-13T00:00:00.000Z"),
        },
        resolutionPayload: {
          resolutionId: M.MemoryResolutionId.make(id(81)),
          judgment: "synthetic reconcile judgment",
        },
      };
      const key = { memorySpaceId: space, attemptId: ticket.attemptId };
      const acquired = (yield* store.transact(
        store.acquireResolutionTicketTx({
          key,
          expectedVersion: 0,
          owner: "first",
          coordinatorEpoch: 1,
          now: 0,
          ownedUntil: 100,
        }),
      ))!;
      const ownership = { ...key, owner: "first", coordinatorEpoch: 1, version: acquired.version };
      let saved = yield* store.transact(
        store.persistResolutionSubmissionTx({
          ownership,
          submission: {
            protocolVersion: 1,
            memorySpaceId: space,
            holderEnvironmentId: environmentId,
            attemptId: ticket.attemptId,
            operation: op,
          },
          digest: memoryOperationDigest(op),
        }),
      );
      if (op.kind !== "resolve") throw new Error("fixture");
      const receipt: M.MemoryHubReceipt = {
        operationId: op.operationId,
        memoryId,
        operationDigest: memoryOperationDigest(op),
        outcome: "accepted",
        hubSequence: 7,
        resolutionApproval: {
          resolutionId: op.resolution.resolutionId,
          appliedAtUtc: at,
          revertDeadlineUtc: op.resolution.revertDeadlineUtc,
        },
      };
      if (mode === "lost-response") {
        // The response was lost; the next pull delivers our own admitted resolve.
        yield* service.receiveHubPage({
          memorySpaceId: space,
          hubEnvironmentId: environmentId,
          localEnvironmentId: environmentId,
          expectedSequence: 0,
          reauthorize: Effect.void,
          page: {
            highWatermark: 7,
            throughSequence: 7,
            hasMore: false,
            entries: [{ kind: "operation", operation: op, receipt, hubSequence: 7 }],
          },
        });
      } else {
        saved = (yield* store.transact(
          store.transitionResolutionTicketTx({
            ownership: { ...ownership, version: saved.version },
            now: 1,
            nextState: "approved",
            ownedUntil: 100,
            nextAttemptAt: 0,
            approval: receipt,
          }),
        ))!;
        const other = makeOp(6, [first.revision.revisionId]);
        yield* store.apply(
          decideMemoryOperation(
            yield* store.loadAggregate(space, memoryId),
            other,
            Store.hubAdmission,
            { kind: "allowed" },
          ),
        );
      }
      yield* store.recoverClaimCandidates(101);
      const recovered = (yield* store.readRecoverableResolutionTickets({
        memorySpaceId: space,
        now: 101,
        limit: 10,
      }))[0]!;
      assert.deepStrictEqual(recovered.submission, saved.submission);
      assert.isTrue(recovered.reconcileRequired);
      const next = (yield* store.transact(
        store.acquireResolutionTicketTx({
          key,
          expectedVersion: recovered.version,
          owner: "reconcile",
          coordinatorEpoch: 2,
          now: 101,
          ownedUntil: 200,
        }),
      ))!;
      const args = {
        ownership: { ...key, owner: "reconcile", coordinatorEpoch: 2, version: next.version },
        now: 101,
        hubEnvironmentId: environmentId,
        localEnvironmentId: environmentId,
        reauthorize: Effect.void,
      };
      // Canonical SQL failure or authority loss rolls approval and cleanup back together.
      yield* sql`CREATE TRIGGER r14_terminal_failure BEFORE UPDATE ON memory_outbox WHEN NEW.kind='resolve' AND json_extract(NEW.ticket_json,'$.state')='terminal' BEGIN SELECT RAISE(ABORT,'synthetic settlement failure'); END`;
      assert.strictEqual(
        (yield* service.reconcileResolutionSubmission(args).pipe(Effect.flip))._tag,
        "MemoryStorageError",
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${`submission:${ticket.attemptId}`}`)
          .length,
        1,
      );
      yield* sql`DROP TRIGGER r14_terminal_failure`;
      const result = yield* service.reconcileResolutionSubmission(args);
      assert.strictEqual(result?.outcome, "admitted");
      assert.strictEqual(result?.row.state, "terminal");
      assert.deepStrictEqual((yield* store.receipt(space, op.operationId))?.receipt, receipt);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_events WHERE operation_id=${op.operationId}`).length,
        1,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_outbox WHERE kind='claim'`).length,
        claimCount,
        "new generation/attempt count is zero",
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${`submission:${ticket.attemptId}`}`)
          .length,
        0,
      );
      assert.isNull(yield* service.reconcileResolutionSubmission(args));
    }).pipe(Effect.provide(live)),
);

it.effect(
  "r16 reads disabled local counters then atomically hands processing to the bound space",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      const sql = yield* SqlClient.SqlClient;
      const local = { environmentId, memorySpaceId: null, hubEnvironmentId: null };
      const intent = {
        intentId: "r16-draft",
        environmentId,
        memoryId,
        scope: { kind: "user" as const },
        assertionKind: "inference" as const,
        provenance: { environmentId },
        createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
        payload: { text: "한글 local draft", evidence: [], derivedFromMemoryRevisions: [] },
      };
      assert.strictEqual((yield* store.readLocalProcessingStatus(local)).pendingSync, 0);
      yield* store.putLocalIntent(intent);
      yield* store.putLocalIntent({ ...intent, environmentId: M.EnvironmentId.make("other") });
      const processing = yield* store.readLocalProcessingStatus(local);
      const storage = yield* quota.readUnboundStorageStatus({ environmentId });
      assert.strictEqual(processing.pendingSync, 1);
      assert.strictEqual(processing.processing.lastReceivedHubSequence, 0);
      assert.strictEqual(storage.quotas.find((q) => q.dimension === "work_items")?.current, 1);
      const bodies = yield* sql<{
        body_json: string;
        metadata_json: string;
      }>`SELECT p.body_json,o.metadata_json FROM memory_payloads p JOIN memory_outbox o ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.id='local:fixture:r16-draft'`;
      const bytes = new TextEncoder().encode(
        bodies[0]!.body_json + bodies[0]!.metadata_json,
      ).length;
      assert.strictEqual(storage.quotas.find((q) => q.dimension === "work_bytes")?.current, bytes);
      assert.isNull(storage.measuredAtUtc);
      assert.isNull(storage.dbFileBytes);
      const assignment = {
        intentId: intent.intentId,
        memorySpaceId: space,
        operationId: M.MemoryOperationId.make(id(16001)),
        revisionId: M.MemoryRevisionId.make(id(16002)),
      };
      const disabled = yield* service
        .commitLocalIntent({
          assignment,
          expectedEpoch: 1,
          readBinding: Effect.succeed({ memorySpaceId: null, coordinatorEpoch: 1, enabled: false }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(disabled._tag, "MemoryAccessError");
      assert.deepStrictEqual(yield* store.readLocalProcessingStatus(local), processing);
      assert.deepStrictEqual(yield* quota.readUnboundStorageStatus({ environmentId }), storage);
      yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1)`;
      const commit = service.commitLocalIntent({
        assignment,
        expectedEpoch: 2,
        readBinding: Effect.succeed({ memorySpaceId: space, coordinatorEpoch: 2, enabled: true }),
      });
      yield* store.transact(commit.pipe(Effect.andThen(Effect.fail("rollback")))).pipe(Effect.flip);
      assert.deepStrictEqual(yield* store.readLocalProcessingStatus(local), processing);
      assert.deepStrictEqual(yield* quota.readUnboundStorageStatus({ environmentId }), storage);
      assert.strictEqual(
        (yield* store.readProcessing({ memorySpaceId: space, hubEnvironmentId: environmentId }))
          .pendingSync,
        0,
      );
      yield* commit;
      const boundInput = { environmentId, memorySpaceId: space, hubEnvironmentId: environmentId };
      const bound = yield* store.readLocalProcessingStatus(boundInput);
      assert.deepStrictEqual(bound, yield* store.readProcessing(boundInput));
      assert.strictEqual(bound.pendingSync, 1);
      assert.strictEqual((yield* store.readLocalProcessingStatus(local)).pendingSync, 0);
      assert.strictEqual(
        (yield* quota.readUnboundStorageStatus({ environmentId })).quotas.find(
          (q) => q.dimension === "work_items",
        )?.current,
        0,
      );
      const boundStorage = yield* quota.readStorageStatus(boundInput);
      assert.strictEqual(
        boundStorage.quotas.find((q) => q.dimension === "space_live_items")?.current,
        1,
      );
      const noHub = yield* store.readLocalProcessingStatus({
        ...boundInput,
        hubEnvironmentId: null,
      });
      assert.deepStrictEqual(noHub, bound);
      // Enabling does not delete the retained local payload. Its actual bytes remain counted.
      assert.isAbove(
        (yield* quota.readUnboundStorageStatus({ environmentId })).quotas.find(
          (q) => q.dimension === "work_bytes",
        )!.current,
        bytes,
      );
    }).pipe(Effect.provide(live)),
);

it.effect(
  "classifies only cursor schema errors as invalid_cursor and binds NFC-equivalent queries",
  () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const value = input();
      yield* service.upsert(
        { ...value, payload: { ...value.payload, text: "synthetic café" } },
        Effect.void,
      );
      const request = { memorySpaceId: space, query: "café", limit: 1, mode: "substring" as const };
      const first = yield* service.search(request, Effect.void);
      assert.strictEqual(first.items.length, 1);
      assert.isNotNull(first.nextCursor);
      const next = yield* service.search(
        { ...request, query: "cafe\u0301", cursor: first.nextCursor! },
        Effect.void,
      );
      assert.deepStrictEqual(next.items, []);
      for (const cursor of [
        id(2),
        "ms1:%",
        "ms1:" + encodeURIComponent("{}"),
        "ms1:" + "x".repeat(20000),
        "",
      ]) {
        const failure = yield* service
          .search({ ...request, cursor }, Effect.void)
          .pipe(Effect.flip);
        assert.isTrue("code" in failure && failure.code === "invalid_cursor");
      }
      for (const invalid of [
        { limit: 0 },
        { query: "" },
        { query: " cafe " },
        { unexpected: true },
      ]) {
        const failure = yield* service
          .search({ ...request, ...invalid, cursor: "ms1:%" }, Effect.void)
          .pipe(Effect.flip);
        assert.isTrue("code" in failure && failure.code === "invalid_output");
      }
    }).pipe(Effect.provide(live)),
);
it.effect("reauthorizes immediately before returning unready FTS coverage", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<1001)
      INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json)
      SELECT ${space},printf('00000000-0000-4000-8000-%012d',n),'{}','user','[]','quarantined',0,'{}','{}' FROM ids`;
    let checks = 0;
    const permit = Effect.suspend(() => (++checks < 3 ? Effect.void : denied));
    const failure = yield* service
      .search({ memorySpaceId: space, query: "synthetic", limit: 10, mode: "fts" }, permit)
      .pipe(Effect.flip);
    assert.strictEqual(failure._tag, "MemoryAccessError");
    assert.strictEqual(checks, 3);
    assert.deepStrictEqual(yield* sql`SELECT after_rowid,ready FROM memory_search_backfill`, [
      { after_rowid: 1000, ready: 0 },
    ]);
  }).pipe(Effect.provide(live)),
);
it.effect("list byte cap retains the quarantined row cursor before a visible short tail", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const sql = yield* SqlClient.SqlClient;
    const value = input();
    yield* service.upsert(
      { ...value, payload: { ...value.payload, text: "synthetic " + "x".repeat(14500) } },
      Effect.void,
    );
    for (const n of [10, 11, 12, 13, 14])
      yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json)
        SELECT space,${id(n)},scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,json_set(item_json,'$.memoryId',${id(n)},'$.revision.memoryId',${id(n)}),availability_json FROM memory_items WHERE memory_id=${memoryId}`;
    const quarantined: M.MemoryItem = {
      memorySpaceId: space,
      memoryId: M.MemoryId.make(id(13)),
      status: "quarantined",
      scope: { kind: "user" },
      pendingSync: false,
      localAvailability: { exposure: "held", reasons: [], deferred: [], cleanupPending: false },
      conflict: {
        memorySpaceId: space,
        memoryId: M.MemoryId.make(id(13)),
        conflictId: M.MemoryConflictId.make(id(500)),
        heads: [M.MemoryRevisionId.make(id(501)), M.MemoryRevisionId.make(id(502))],
        status: "quarantined",
      },
    };
    const json = yield* encodeItemJson(quarantined);
    yield* sql`UPDATE memory_items SET status='quarantined',payload_ref=NULL,item_json=${json} WHERE memory_id=${id(13)}`;
    const request = { memorySpaceId: space, limit: 100, includeQuarantined: false };
    const first = yield* service.list(request, Effect.void);
    assert.deepStrictEqual(
      first.items.map((i) => i.memoryId),
      [memoryId, id(10), id(11), id(12)],
    );
    assert.strictEqual(first.nextCursor, id(13));
    const tail = yield* service.list({ ...request, cursor: first.nextCursor! }, Effect.void);
    assert.deepStrictEqual(
      tail.items.map((i) => i.memoryId),
      [id(14)],
    );
    assert.isNull(tail.nextCursor);
  }).pipe(Effect.provide(live)),
);
it.effect("list refuses a valid first item exceeding the reserved page envelope", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.upsert(input(), Effect.void);
    const current = yield* service.read({ memorySpaceId: space, memoryId }, Effect.void);
    if (current.status !== "active") throw new Error("Fixture kind");
    const base = new TextEncoder().encode(yield* encodeItemJson(current)).length;
    const large = {
      ...current,
      revision: {
        ...current.revision,
        provenance: {
          ...current.revision.provenance,
          environmentId: M.EnvironmentId.make(
            "m".repeat(M.MEMORY_PAGE_MAX_UTF8_BYTES - 1000 - base),
          ),
        },
      },
    };
    const encoded = yield* encodeItemJson(large);
    assert.isTrue(new TextEncoder().encode(encoded).length + 2048 > M.MEMORY_PAGE_MAX_UTF8_BYTES);
    // Store projection does not duplicate the immutable payload.
    const { payload: _payload, ...projection } = large;
    yield* sql`UPDATE memory_items SET item_json=${JSON.stringify(projection)} WHERE memory_id=${memoryId}`;
    const failure = yield* service
      .list({ memorySpaceId: space, limit: 100, includeQuarantined: true }, Effect.void)
      .pipe(Effect.flip);
    assert.isTrue("code" in failure && failure.code === "payload_too_large");
  }).pipe(Effect.provide(live)),
);

const sourceFixture = Effect.gen(function* () {
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
  const operationId = M.MemoryOperationId.make(id(9000));
  const revisionId = M.MemoryRevisionId.make(id(9001));
  const op: M.MemoryOperation = {
    protocolVersion: 1,
    kind: "upsert",
    memorySpaceId: space,
    memoryId,
    operationId,
    originEnvironmentId: environmentId,
    expectedHeads: [],
    revision: {
      memorySpaceId: space,
      memoryId,
      operationId,
      revisionId,
      payloadRef: revisionId,
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
  yield* store.apply(decideMemoryOperation(aggregate, op, Store.localIntent, scanMemoryValue(op)));
  const input: M.MemoryReadSourceInput = {
    memorySpaceId: space,
    memoryId,
    sourceThread,
    messageIds: [messageId],
    limit: 10,
  };
  const page: M.MemorySourcePage = {
    sourceThread,
    watermark,
    messages: [{ messageId, text: "synthetic original" }],
    nextCursor: null,
  };
  return { input, page };
});
it.effect("public readSource returns the validated page through the injected authority", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const fixture = yield* sourceFixture;
    const actual = yield* service.readSource(fixture.input, Effect.void);
    assert.deepStrictEqual(actual, fixture.page);
  }).pipe(
    Effect.provide(
      serviceLive(
        Service.layerWithSourceReadAuthority((validated, permit) =>
          permit.pipe(
            Effect.as({
              kind: "available",
              page: {
                sourceThread: validated.request.sourceThread,
                watermark: validated.request.sourceWatermark,
                messages: validated.request.messageIds.map((messageId) => ({
                  messageId,
                  text: "synthetic original",
                })),
                nextCursor: null,
              },
            }),
          ),
        ),
      ),
    ),
  ),
);
it.effect.each([
  "source_unavailable",
  "forgotten",
  "source_invalidated",
  "secret_detected",
] as const)("public readSource preserves unavailable %s", (code) =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const fixture = yield* sourceFixture;
    const failure = yield* service.readSource(fixture.input, Effect.void).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "MemoryStoreConflict");
    assert.isTrue("code" in failure && failure.code === code);
  }).pipe(
    Effect.provide(
      serviceLive(
        Service.layerWithSourceReadAuthority(() => Effect.succeed({ kind: "unavailable", code })),
      ),
    ),
  ),
);
it.effect.each(["outcome", "error", "missing"] as const)(
  "public readSource retains auth denial from %s",
  (kind) => {
    const authority: Service.MemorySourceReadAuthority["readSource"] = () =>
      kind === "error"
        ? denied
        : Effect.succeed({ kind: "denied", requiredPermission: "orchestration:read" });
    return Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const fixture = yield* sourceFixture;
      const failure = yield* service.readSource(fixture.input, Effect.void).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryAccessError");
      assert.isTrue(
        "code" in failure &&
          failure.code === (kind === "error" ? "identity_mismatch" : "unavailable"),
      );
    }).pipe(
      Effect.provide(
        kind === "missing" ? live : serviceLive(Service.layerWithSourceReadAuthority(authority)),
      ),
    );
  },
);
it.effect("public readSource fences post-await revocation", () => {
  let revoke = false;
  return Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const fixture = yield* sourceFixture;
    const permit = Effect.suspend(() => (revoke ? denied : Effect.void));
    const failure = yield* service.readSource(fixture.input, permit).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "MemoryAccessError");
  }).pipe(
    Effect.provide(
      serviceLive(
        Service.layerWithSourceReadAuthority((validated, permit) =>
          Effect.gen(function* () {
            yield* permit;
            revoke = true;
            return {
              kind: "available" as const,
              page: {
                sourceThread: validated.request.sourceThread,
                watermark: validated.request.sourceWatermark,
                messages: [],
                nextCursor: null,
              },
            };
          }),
        ),
      ),
    ),
  );
});
it.effect.each(["before-authority", "before-return"] as const)(
  "public readSource repeats permit %s",
  (boundary) => {
    let calls = 0;
    let authorityCalls = 0;
    const at = boundary === "before-authority" ? 3 : 6;
    const authority: Service.MemorySourceReadAuthority["readSource"] = (validated) => {
      authorityCalls++;
      return Effect.succeed({
        kind: "available",
        page: {
          sourceThread: validated.request.sourceThread,
          watermark: validated.request.sourceWatermark,
          messages: [],
          nextCursor: null,
        },
      });
    };
    return Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const fixture = yield* sourceFixture;
      const permit = Effect.suspend(() => (++calls === at ? denied : Effect.void));
      const failure = yield* service.readSource(fixture.input, permit).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryAccessError");
      assert.strictEqual(calls, at);
      assert.strictEqual(authorityCalls, boundary === "before-authority" ? 0 : 1);
    }).pipe(Effect.provide(serviceLive(Service.layerWithSourceReadAuthority(authority))));
  },
);
it.effect("public readSource discards an available body whose locator changed during await", () => {
  let invalidate: Effect.Effect<void, Service.MemoryServiceError> = Effect.void;
  const authority: Service.MemorySourceReadAuthority["readSource"] = (validated) =>
    Effect.gen(function* () {
      yield* invalidate;
      return {
        kind: "available" as const,
        page: {
          sourceThread: validated.request.sourceThread,
          watermark: validated.request.sourceWatermark,
          messages: [
            { messageId: validated.request.messageIds[0]!, text: "synthetic stale original" },
          ],
          nextCursor: null,
        },
      };
    });
  return Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const fixture = yield* sourceFixture;
    invalidate = service
      .forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(9002)),
          expectedHeads: [],
        },
        Effect.void,
      )
      .pipe(Effect.asVoid);
    const failure = yield* service.readSource(fixture.input, Effect.void).pipe(Effect.flip);
    assert.isTrue("code" in failure && failure.code === "forgotten");
  }).pipe(Effect.provide(serviceLive(Service.layerWithSourceReadAuthority(authority))));
});

it.effect.each([0, 7])(
  "public readSource preserves Hub capacity with reclaimable %s",
  (reclaimable) => {
    const capacity: M.MemoryCapacityExceeded = {
      code: "capacity_exceeded",
      dimension: "relay_environment",
      current: 32,
      limit: 32,
      reclaimable,
    };
    return Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const fixture = yield* sourceFixture;
      const failure = yield* service.readSource(fixture.input, Effect.void).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryCapacityError");
      if (failure._tag !== "MemoryCapacityError") return;
      assert.deepStrictEqual(
        {
          dimension: failure.dimension,
          current: failure.current,
          limit: failure.limit,
          reclaimable: failure.reclaimable,
        },
        { dimension: "relay_environment", current: 32, limit: 32, reclaimable },
      );
      // Planned transport projection: the service fields alone must satisfy the safe wire codec.
      const safe = yield* decodeRpcError({
        _tag: "MemoryRpcError",
        code: "capacity_exceeded",
        capacity: {
          code: "capacity_exceeded",
          dimension: failure.dimension,
          current: failure.current,
          limit: failure.limit,
          reclaimable: failure.reclaimable,
        },
      });
      const encoded = yield* encodeRpcError(safe);
      assert.deepStrictEqual(encoded, {
        _tag: "MemoryRpcError",
        code: "capacity_exceeded",
        capacity,
      });
      assert.isFalse("cause" in failure);
    }).pipe(
      Effect.provide(
        serviceLive(
          Service.layerWithSourceReadAuthority(() =>
            Effect.fail(new M.MemoryHubError({ code: "capacity_exceeded", capacity })),
          ),
        ),
      ),
    );
  },
);
it.effect.each([
  "source_unavailable",
  "forgotten",
  "source_invalidated",
  "secret_detected",
  "hub_disabled",
  "identity_mismatch",
  "invalid_output",
] as const)("public readSource preserves Hub error code %s without capacity or cause", (code) =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const fixture = yield* sourceFixture;
    const failure = yield* service.readSource(fixture.input, Effect.void).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "MemoryStoreConflict");
    assert.isTrue("code" in failure && failure.code === code);
    assert.isFalse("capacity" in failure);
    assert.isFalse("cause" in failure);
    const safe = yield* decodeRpcError({
      _tag: "MemoryRpcError",
      code,
    });
    assert.deepStrictEqual(yield* encodeRpcError(safe), {
      _tag: "MemoryRpcError",
      code,
    });
  }).pipe(
    Effect.provide(
      serviceLive(
        Service.layerWithSourceReadAuthority(() => Effect.fail(new M.MemoryHubError({ code }))),
      ),
    ),
  ),
);
it.effect("public readSource does not invent capacity for a code-only service conflict", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const fixture = yield* sourceFixture;
    const failure = yield* service.readSource(fixture.input, Effect.void).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "MemoryStoreConflict");
    assert.isTrue("code" in failure && failure.code === "capacity_exceeded");
    assert.isFalse("current" in failure);
    assert.isFalse("capacity" in failure);
  }).pipe(
    Effect.provide(
      serviceLive(
        Service.layerWithSourceReadAuthority(() =>
          Effect.fail(new Store.MemoryStoreConflict({ code: "capacity_exceeded" })),
        ),
      ),
    ),
  ),
);

for (const mutation of ["forget", "hold", "replace"] as const) {
  it.effect.each(["denied", "malformed", "available"] as const)(
    `public readSource validates %s after authority await with ${mutation}`,
    (kind) => {
      let invalidate: Effect.Effect<void, Service.MemoryServiceError> = Effect.void;
      const authority: Service.MemorySourceReadAuthority["readSource"] = (validated) =>
        Effect.gen(function* () {
          yield* invalidate;
          if (kind === "malformed") {
            // Simulate a faulty authority crossing the runtime boundary with excess properties.
            const malformed = {
              kind: "denied" as const,
              requiredPermission: "orchestration:read" as const,
              unexpected: true,
            };
            return malformed;
          }
          if (kind === "denied")
            return { kind: "denied" as const, requiredPermission: "orchestration:read" as const };
          return {
            kind: "available" as const,
            page: {
              sourceThread: validated.request.sourceThread,
              watermark: validated.request.sourceWatermark,
              messages: [],
              nextCursor: null,
            },
          };
        });
      return Effect.gen(function* () {
        const service = yield* Service.MemoryService;
        const fixture = yield* sourceFixture;
        const sql = yield* SqlClient.SqlClient;
        if (mutation === "forget") {
          invalidate = service
            .forget(
              {
                memorySpaceId: space,
                memoryId,
                operationId: M.MemoryOperationId.make(id(9002)),
                expectedHeads: [],
              },
              Effect.void,
            )
            .pipe(Effect.asVoid);
        } else if (mutation === "replace") {
          // Replace the linked head with an actual local revision without a source locator.
          invalidate = service
            .upsert(
              { ...input(9003), expectedHeads: [M.MemoryRevisionId.make(id(9001))] },
              Effect.void,
            )
            .pipe(Effect.asVoid);
        } else {
          const held: M.MemoryItem = {
            memorySpaceId: space,
            memoryId,
            status: "blocked",
            scope: { kind: "user" },
            pendingSync: false,
            failureCode: "scanner_pending",
            localAvailability: {
              exposure: "held",
              reasons: ["scanner_pending"],
              deferred: [],
              cleanupPending: false,
            },
          };
          const json = yield* encodeItemJson(held);
          invalidate =
            sql`UPDATE memory_items SET status='blocked',item_json=${json} WHERE space=${space} AND memory_id=${memoryId}`.pipe(
              Effect.asVoid,
              Effect.mapError((cause) => new Store.MemoryStorageError({ stage: "fixture", cause })),
            );
        }
        const failure = yield* service.readSource(fixture.input, Effect.void).pipe(Effect.flip);
        assert.strictEqual(
          failure._tag,
          kind === "denied" ? "MemoryAccessError" : "MemoryStoreConflict",
        );
        assert.isTrue(
          "code" in failure &&
            failure.code ===
              (kind === "denied"
                ? "unavailable"
                : kind === "malformed"
                  ? "invalid_output"
                  : mutation === "forget"
                    ? "forgotten"
                    : "source_invalidated"),
        );
      }).pipe(Effect.provide(serviceLive(Service.layerWithSourceReadAuthority(authority))));
    },
  );
}
