import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Renderer from "@goat/provider-core/server/memoryContext";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Snapshot from "./MemorySnapshot.ts";

const encodeSnapshotJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryContextSnapshot));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const environmentId = M.EnvironmentId.make("fixture");
const threadId = M.ThreadId.make("thread");
const runId = M.RunId.make("run");
const projectId = M.ProjectId.make("project");
const input = (n: number, scope: M.MemoryScope = { kind: "user" }): M.MemoryUpsertInput => ({
  memorySpaceId: space,
  memoryId: M.MemoryId.make(id(n)),
  operationId: M.MemoryOperationId.make(id(n + 10000)),
  expectedHeads: [],
  scope,
  assertionKind: "inference",
  payload: { text: "synthetic & <memory> " + n, evidence: [], derivedFromMemoryRevisions: [] },
  baseBoundary: null,
});
const fixture = (
  options: {
    repository?: M.RepositoryIdentity;
    foreignRevisionSpace?: M.MemorySpaceId;
  } = {},
) => {
  let pageReads = 0;
  let policy: Snapshot.MemorySnapshotPolicy = { grant: "read", policyEpoch: 1 };
  let active = true;
  let currentRunId = runId;
  let ready = true;
  // The projection boundary supplies only the shell fields read by this service.
  const shell = {
    id: threadId,
    projectId,
    activeRunId: runId,
    activityRunStatus: "running",
  } as M.OrchestrationV2ThreadShell;
  const database = Layer.effectDiscard(runMigrations()).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const store = Store.layer.pipe(Layer.provideMerge(database));
  const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });
  const serviceBase = Service.layer.pipe(
    Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(store))),
    Layer.provideMerge(identity),
    Layer.provide(
      Layer.mock(Repository.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(options.repository ?? null),
      }),
    ),
  );
  const service = Layer.effect(
    Service.MemoryService,
    Effect.gen(function* () {
      const original = yield* Service.MemoryService;
      return Service.MemoryService.of({
        ...original,
        readContextRevisions: (space, ids, permit) =>
          original
            .readContextRevisions(space, ids, permit)
            .pipe(
              Effect.map((page) =>
                options.foreignRevisionSpace
                  ? { ...page, memorySpaceId: options.foreignRevisionSpace }
                  : page,
              ),
            ),
        readContextCandidates: (input, permit) =>
          Effect.sync(() => {
            pageReads++;
          }).pipe(Effect.andThen(original.readContextCandidates(input, permit))),
      });
    }),
  ).pipe(Layer.provideMerge(serviceBase));
  const live = Snapshot.layer.pipe(
    Layer.provideMerge(service),
    Layer.provide(
      Layer.mock(Projection.ProjectionStoreV2)({
        getThreadShell: (requested) =>
          Effect.sync(() =>
            active ? { ...shell, id: requested, activeRunId: currentRunId } : null,
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(Sync.MemorySyncService)({
        readLocalReadiness: () =>
          Effect.sync(() => ({
            memorySpaceId: space,
            bootstrap: ready ? ("ready" as const) : ("staging" as const),
          })),
      }),
    ),
  );
  return {
    live,
    pageReads: () => pageReads,
    policy: () => policy,
    currentPolicy: Effect.sync(() => policy),
    setPolicy: (value: Snapshot.MemorySnapshotPolicy) => {
      policy = value;
    },
    end: () => {
      active = false;
    },
    changeRun: () => {
      currentRunId = M.RunId.make("replacement-run");
    },
    unready: () => {
      ready = false;
    },
  };
};
const project = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'synthetic','/synthetic','[]','2026-10-15','2026-10-15')`;
});
it.effect(
  "selects thread/project/user in order, restores only survivors, and fences policy/identity/TTL",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshot = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      yield* project;
      yield* store.putProjectBinding(
        {
          memorySpaceId: space,
          project: { environmentId, projectId },
          projectKey: { kind: "explicit", sharedProjectId: "shared" },
          repositoryKey: null,
          version: 1,
        },
        null,
        0,
      );
      const threadScope: M.MemoryScope = { kind: "thread", thread: { environmentId, threadId } };
      const projectScope: M.MemoryScope = {
        kind: "project",
        projectKey: { kind: "explicit", sharedProjectId: "shared" },
      };
      for (const [n, scope] of [
        [2, { kind: "user" }],
        [3, projectScope],
        [4, threadScope],
      ] as const)
        yield* service.upsert(input(n, scope), Effect.void);
      const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      assert.isDefined(selected);
      assert.deepStrictEqual(
        selected!.items.map((i) => i.scope.kind),
        ["thread", "project", "user"],
      );
      assert.isTrue(Renderer.memoryContextFits(selected!.renderedText));
      assert.include(selected!.renderedText, "&amp;");
      yield* service.upsert(input(5), Effect.void);
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId: M.MemoryId.make(id(3)),
          operationId: M.MemoryOperationId.make(id(500)),
          expectedHeads: [],
        },
        Effect.void,
      );
      const restored = yield* snapshot.revalidate(selected!, { threadId, runId }, f.currentPolicy);
      assert.deepStrictEqual(
        restored!.items.map((i) => i.memoryId),
        [id(4), id(2)],
      );
      assert.isUndefined(
        yield* snapshot.revalidate(
          selected!,
          { threadId: M.ThreadId.make("foreign"), runId },
          f.currentPolicy,
        ),
      );
      const second = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      f.setPolicy({ grant: "read_write", policyEpoch: 2 });
      assert.isUndefined(yield* snapshot.revalidate(second!, { threadId, runId }, f.currentPolicy));
      f.setPolicy({ grant: "none", policyEpoch: 2 });
      assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy));
      f.setPolicy({ grant: "read", policyEpoch: 3 });
      const third = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      yield* TestClock.adjust(M.MEMORY_DERIVED_CACHE_TTL_MS);
      assert.isUndefined(yield* snapshot.revalidate(third!, { threadId, runId }, f.currentPolicy));
      const fourth = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      yield* snapshot.invalidate(threadId);
      assert.isUndefined(yield* snapshot.revalidate(fourth!, { threadId, runId }, f.currentPolicy));
      f.end();
      assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy));
    }).pipe(Effect.provide(f.live));
  },
);
it.effect(
  "omits unready space and discards selection when a concurrent committed write changes its watermark",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshot = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      yield* project;
      yield* service.upsert(input(2), Effect.void);
      let calls = 0;
      const reached = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.await(reached);
          yield* service.upsert(input(3), Effect.void);
          yield* Deferred.succeed(committed, undefined);
        }),
      );
      const currentPolicy = Effect.gen(function* () {
        if (++calls === 3) {
          yield* Deferred.succeed(reached, undefined);
          yield* Deferred.await(committed);
        }
        return f.policy();
      });
      assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), currentPolicy));
      yield* Fiber.join(writer);
      f.unready();
      assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy));
    }).pipe(Effect.provide(f.live));
  },
);

it.effect("bounds excluded candidates to ten pages and follows the unfiltered row cursor", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshot = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    const sql = yield* SqlClient.SqlClient;
    yield* project;
    yield* sql`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<1001)
      INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json)
      SELECT ${space},printf('00000000-0000-4000-8000-%012d',n),'{"kind":"user"}','user','[]','blocked',0,
      json_object('memorySpaceId',${space},'memoryId',printf('00000000-0000-4000-8000-%012d',n),'status','blocked','scope',json('{"kind":"user"}'),'failureCode','scanner_pending','pendingSync',json('false'),'localAvailability',json('{"exposure":"held","reasons":[],"deferred":[],"cleanupPending":false}')),
      '{"exposure":"held","reasons":[],"deferred":[],"cleanupPending":false}' FROM ids`;
    yield* service.upsert(input(2000), Effect.void);
    assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy));
    assert.strictEqual(f.pageReads(), 10);
    // Remove all but a single excluded first page; the next page must reach the eligible row.
    yield* sql`DELETE FROM memory_items WHERE space=${space} AND memory_id>${id(100)} AND memory_id<${id(2000)}`;
    const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
    assert.deepStrictEqual(
      selected!.items.map((i) => i.memoryId),
      [id(2000)],
    );
  }).pipe(Effect.provide(f.live));
});
it.effect("skips whole oversized facts and packs Unicode within both native-frame limits", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshot = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    for (let n = 2; n < 10; n++) {
      const value = input(n);
      yield* service.upsert(
        { ...value, payload: { ...value.payload, text: "synthetic word ".repeat(650) } },
        Effect.void,
      );
    }
    const value = input(10);
    const text = "🙂".repeat(1000) + "synthetic word ".repeat(180);
    yield* service.upsert({ ...value, payload: { ...value.payload, text } }, Effect.void);
    yield* service.upsert(input(11), Effect.void);
    const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
    assert.isDefined(selected);
    assert.deepStrictEqual(
      selected!.items.map((i) => i.memoryId),
      [id(10), id(11)],
    );
    assert.strictEqual(selected!.items[0]!.text, text);
    const framed = Renderer.memoryContextText(selected);
    assert.isTrue(Array.from(framed).length <= M.MEMORY_CONTEXT_MAX_CHARS);
    assert.isTrue(new TextEncoder().encode(framed).length <= M.MEMORY_CONTEXT_MAX_UTF8_BYTES);
    const store = yield* Store.MemoryStore;
    const binding = yield* store.getProjectBinding(space, { environmentId, projectId });
    yield* store.putProjectBinding(
      {
        memorySpaceId: space,
        project: { environmentId, projectId },
        projectKey: { kind: "explicit", sharedProjectId: "changed" },
        repositoryKey: null,
        version: (binding?.version ?? 0) + 1,
      },
      binding?.version ?? null,
      1,
    );
    assert.isUndefined(yield* snapshot.revalidate(selected!, { threadId, runId }, f.currentPolicy));
  }).pipe(Effect.provide(f.live));
});
it.effect(
  "restores authoritative selected text and rejects replacement of the original selection",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshot = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      yield* project;
      yield* service.upsert(input(2), Effect.void);
      const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      const alteredText = selected!.items.map((item) => ({
        ...item,
        text: "synthetic altered data",
      }));
      Object.assign(selected!, {
        items: alteredText,
        renderedText: Renderer.renderMemoryContext(alteredText),
      });
      const restored = yield* snapshot.revalidate(selected!, { threadId, runId }, f.currentPolicy);
      assert.strictEqual(restored!.items[0]!.text, input(2).payload.text);
      yield* service.upsert(input(3), Effect.void);
      const replacement = (yield* service.readContextCandidates(
        { memorySpaceId: space, limit: 100, includeQuarantined: true },
        Effect.void,
      )).items.filter((i) => i.memoryId === id(3));
      Object.assign(restored!, {
        items: replacement,
        renderedText: Renderer.renderMemoryContext(replacement),
      });
      assert.isUndefined(
        yield* snapshot.revalidate(restored!, { threadId, runId }, f.currentPolicy),
      );
    }).pipe(Effect.provide(f.live));
  },
);

// The latch pauses a real read outside the SQL lane; mutations complete before it resumes.
const policyLatch = (pauseAt = 1) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let calls = 0;
    return {
      reached,
      resume,
      policy: Effect.gen(function* () {
        if (++calls === pauseAt) {
          yield* Deferred.succeed(reached, undefined);
          yield* Deferred.await(resume);
        }
        return { grant: "read" as const, policyEpoch: 1 };
      }),
    };
  });
const interruptions = ["invalidate", "replace", "expire", "run", "ended", "unready"] as const;
const lifecycleCases = (["selection", "restore"] as const).flatMap((operation) =>
  interruptions.map((interruption) => ({ operation, interruption })),
);
it.effect.each(lifecycleCases)(
  "$operation cannot survive concurrent $interruption",
  ({ operation, interruption }) => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshots = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      yield* project;
      yield* service.upsert(input(2), Effect.void);
      const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
      const latch = yield* policyLatch(operation === "selection" ? 3 : 1);
      const pending = yield* Effect.forkChild(
        operation === "selection"
          ? snapshots.forThread(threadId, f.policy(), latch.policy)
          : snapshots.revalidate(selected!, { threadId, runId }, latch.policy),
      );
      yield* Deferred.await(latch.reached);
      let replacement: M.MemoryContextSnapshot | undefined;
      if (interruption === "invalidate") yield* snapshots.invalidate(threadId);
      if (interruption === "replace")
        replacement = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
      if (interruption === "expire") yield* TestClock.adjust(M.MEMORY_DERIVED_CACHE_TTL_MS);
      if (interruption === "run") f.changeRun();
      if (interruption === "ended") f.end();
      if (interruption === "unready") f.unready();
      yield* Deferred.succeed(latch.resume, undefined);
      assert.isUndefined(yield* Fiber.join(pending));
      if (replacement)
        assert.isDefined(
          yield* snapshots.revalidate(replacement, { threadId, runId }, f.currentPolicy),
        );
    }).pipe(Effect.provide(f.live));
  },
);
it.effect("rejects a caller space swap with identical IDs, revisions, scopes and watermark", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    const sql = yield* SqlClient.SqlClient;
    const other = M.MemorySpaceId.make(id(999));
    yield* project;
    yield* service.upsert(input(2), Effect.void);
    const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    // Clone the projection and immutable payload into a distinct synthetic space.
    yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json)
      SELECT ${other},payload_ref,memory_id,json_set(body_json,'$.text','synthetic foreign body'),dependencies_json FROM memory_payloads WHERE space=${space}`;
    yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json,generation)
      SELECT ${other},memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,
      json_set(item_json,'$.memorySpaceId',${other},'$.revision.memorySpaceId',${other}),availability_json,generation FROM memory_items WHERE space=${space}`;
    yield* sql`INSERT INTO memory_compaction_state(space,projection_watermark)
      SELECT ${other},projection_watermark FROM memory_compaction_state WHERE space=${space}`;
    const foreign = yield* service.readContextRevisions(
      other,
      [M.MemoryId.make(id(2))],
      Effect.void,
    );
    assert.strictEqual(foreign.projectionWatermark, selected!.projectionWatermark);
    assert.strictEqual(foreign.items[0]!.revisionId, selected!.items[0]!.revisionId);
    assert.strictEqual(foreign.items[0]!.text, "synthetic foreign body");
    Object.assign(selected!, { memorySpaceId: other });
    assert.isUndefined(
      yield* snapshots.revalidate(selected!, { threadId, runId }, f.currentPolicy),
    );
  }).pipe(Effect.provide(f.live));
});
it.effect("rejects an exact-read page from a foreign space", () => {
  const f = fixture({ foreignRevisionSpace: M.MemorySpaceId.make(id(999)) });
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    yield* service.upsert(input(2), Effect.void);
    const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    assert.isUndefined(
      yield* snapshots.revalidate(selected!, { threadId, runId }, f.currentPolicy),
    );
  }).pipe(Effect.provide(f.live));
});
it.effect("restoration retains the original expiry", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    yield* service.upsert(input(2), Effect.void);
    const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    yield* TestClock.adjust(M.MEMORY_DERIVED_CACHE_TTL_MS - 1);
    const restored = yield* snapshots.revalidate(selected!, { threadId, runId }, f.currentPolicy);
    assert.isDefined(restored);
    yield* TestClock.adjust(1);
    assert.isUndefined(
      yield* snapshots.revalidate(restored!, { threadId, runId }, f.currentPolicy),
    );
  }).pipe(Effect.provide(f.live));
});
it.effect("evicts oldest associations at the aggregate 32 MiB charge ceiling", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    const value = input(2);
    yield* service.upsert(
      { ...value, payload: { ...value.payload, text: "🙂".repeat(1500) + "a".repeat(3600) } },
      Effect.void,
    );
    const oldest = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    assert.isDefined(oldest);
    const charge = 2 * new TextEncoder().encode(yield* encodeSnapshotJson(oldest!)).length;
    let current = oldest!;
    for (let n = 0; n <= Math.ceil(M.MEMORY_DERIVED_CACHE_MAX_BYTES / charge); n++) {
      const next = yield* snapshots.revalidate(current, { threadId, runId }, f.currentPolicy);
      assert.isDefined(next);
      current = next!;
    }
    assert.isUndefined(yield* snapshots.revalidate(oldest!, { threadId, runId }, f.currentPolicy));
    assert.isDefined(yield* snapshots.revalidate(current, { threadId, runId }, f.currentPolicy));
  }).pipe(Effect.provide(f.live));
});

it.effect("selects the project discovered through repository identity", () => {
  const repository: M.RepositoryIdentity = {
    canonicalKey: "example.invalid/synthetic/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://example.invalid/synthetic/repo.git",
    },
  };
  const f = fixture({ repository });
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    const scope: M.MemoryScope = {
      kind: "project",
      projectKey: { kind: "repository", groupingKey: M.repositoryGroupingKeyOf(repository) },
    };
    yield* service.upsert(input(2, scope), Effect.void);
    // Initial discovery commits a new binding/watermark: discard that mixed view once.
    assert.isUndefined(yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy));
    const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    assert.deepStrictEqual(
      selected!.items.map((i) => i.scope),
      [scope],
    );
  }).pipe(Effect.provide(f.live));
});
const survivorCases = [
  { status: "quarantined", failureCode: "scanner_pending" },
  { status: "blocked", failureCode: "forget_pending" },
  { status: "blocked", failureCode: "scanner_pending" },
] as const;
it.effect.each(survivorCases)(
  "restoration removes $status/$failureCode while retaining a visible survivor",
  ({ status, failureCode }) => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshots = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      const sql = yield* SqlClient.SqlClient;
      yield* project;
      yield* service.upsert(input(2), Effect.void);
      yield* service.upsert(input(3), Effect.void);
      const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
      const held = {
        memorySpaceId: space,
        memoryId: M.MemoryId.make(id(2)),
        status,
        scope: { kind: "user" as const },
        pendingSync: false,
        localAvailability: {
          exposure: "held" as const,
          reasons: [],
          deferred: [],
          cleanupPending: false,
        },
        ...(status === "blocked"
          ? { failureCode }
          : {
              conflict: {
                memorySpaceId: space,
                memoryId: M.MemoryId.make(id(2)),
                conflictId: M.MemoryConflictId.make(id(700)),
                heads: [M.MemoryRevisionId.make(id(701)), M.MemoryRevisionId.make(id(702))],
                status: "quarantined" as const,
              },
            }),
      };
      yield* sql`UPDATE memory_items SET status=${status},payload_ref=NULL,item_json=${JSON.stringify(held)} WHERE memory_id=${id(2)}`;
      const restored = yield* snapshots.revalidate(selected!, { threadId, runId }, f.currentPolicy);
      assert.deepStrictEqual(
        restored!.items.map((i) => i.memoryId),
        [id(3)],
      );
    }).pipe(Effect.provide(f.live));
  },
);
