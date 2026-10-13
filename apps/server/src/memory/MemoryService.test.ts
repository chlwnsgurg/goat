import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/070_Memory.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const environmentId = M.EnvironmentId.make("fixture");
const database = Layer.effectDiscard(migration).pipe(
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
const denied = Effect.fail(new Service.MemoryAccessError({ code: "identity_mismatch" }));
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
