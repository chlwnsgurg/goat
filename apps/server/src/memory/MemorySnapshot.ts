import * as M from "@goat/contracts";
import * as Renderer from "@goat/provider-core/server/memoryContext";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Sync from "./MemorySyncService.ts";

/** L5/L2 supply already-intersected committed authority, never caller wire data. */
export type MemorySnapshotPolicy = {
  readonly grant: M.MemoryTaskGrantCeiling;
  readonly policyEpoch: number;
};
type CurrentPolicy = Effect.Effect<MemorySnapshotPolicy>;
export class MemorySnapshotError extends Schema.TaggedError<MemorySnapshotError>()(
  "MemorySnapshotError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Memory snapshot unavailable.";
  }
}
export class MemorySnapshot extends Context.Service<
  MemorySnapshot,
  {
    readonly forThread: (
      threadId: M.ThreadId,
      policy: MemorySnapshotPolicy,
      currentPolicy: CurrentPolicy,
    ) => Effect.Effect<M.MemoryContextSnapshot | undefined, MemorySnapshotError>;
    readonly revalidate: (
      snapshot: M.MemoryContextSnapshot,
      execution: { threadId: M.ThreadId; runId: M.RunId },
      currentPolicy: CurrentPolicy,
    ) => Effect.Effect<M.MemoryContextSnapshot | undefined, MemorySnapshotError>;
    readonly invalidate: (threadId: M.ThreadId) => Effect.Effect<void>;
  }
>()("goat/memory/MemorySnapshot") {}

const encodeBinding = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(M.MemoryProjectBinding)),
);
const encodeScope = Schema.encodeSync(Schema.fromJsonString(M.MemoryScope));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(M.MemoryContextSnapshot));

const make = Effect.gen(function* () {
  const service = yield* Service.MemoryService;
  const store = yield* Store.MemoryStore;
  const sync = yield* Sync.MemorySyncService;
  const projection = yield* Projection.ProjectionStoreV2;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const capture = Effect.fnUntraced(function* (threadId: M.ThreadId) {
    // Readiness may acquire the settings lane; never hold the SQL lane while reading it.
    const readiness = yield* sync.readLocalReadiness();
    if (readiness.bootstrap !== "ready" || !readiness.memorySpaceId) return undefined;
    const space = readiness.memorySpaceId;
    return yield* store.transact(
      Effect.gen(function* () {
        const thread = yield* projection.getThreadShell(threadId);
        if (!thread?.activeRunId) return undefined;
        if (
          !thread.activityRunStatus ||
          !["preparing", "starting", "running", "waiting"].includes(thread.activityRunStatus)
        )
          return undefined;
        const project = { environmentId, projectId: thread.projectId };
        // resolveProjectKey may discover repository identity. Resolve outside these short reads;
        // here the committed binding is compared verbatim, including its version.
        const binding = yield* store.getProjectBinding(space, project);
        const rows = yield* sql<{
          watermark: number;
        }>`SELECT coalesce((SELECT projection_watermark FROM memory_compaction_state WHERE space=${space}),0) AS watermark`;
        return {
          space,
          threadId,
          runId: thread.activeRunId,
          project,
          binding,
          watermark: rows[0]!.watermark,
        };
      }),
    );
  });
  type View = NonNullable<Effect.Success<ReturnType<typeof capture>>>;
  const sameView = (a: View, b: View | undefined) =>
    !!b &&
    a.space === b.space &&
    a.threadId === b.threadId &&
    a.runId === b.runId &&
    a.project.projectId === b.project.projectId &&
    encodeBinding(a.binding ?? null) === encodeBinding(b.binding ?? null) &&
    a.watermark === b.watermark;
  const entries = new Map<
    M.MemoryContextSnapshot,
    { view: View; epoch: number; expires: number; bytes: number }
  >();
  let cacheBytes = 0;
  const remove = (snapshot: M.MemoryContextSnapshot) => {
    const entry = entries.get(snapshot);
    if (entry) cacheBytes -= entry.bytes;
    entries.delete(snapshot);
  };
  const sweep = (now: number) => {
    for (const [snapshot, entry] of entries) if (entry.expires <= now) remove(snapshot);
  };
  const invalidate = (threadId: M.ThreadId) =>
    Effect.sync(() => {
      for (const [snapshot, entry] of entries)
        if (entry.view.threadId === threadId) remove(snapshot);
    });
  const permits = (policy: MemorySnapshotPolicy, expected: MemorySnapshotPolicy) =>
    policy.grant !== "none" && policy.policyEpoch === expected.policyEpoch;
  const forThread = Effect.fn("MemorySnapshot.forThread")(
    function* (threadId: M.ThreadId, policy: MemorySnapshotPolicy, currentPolicy: CurrentPolicy) {
      yield* invalidate(threadId);
      sweep(yield* Clock.currentTimeMillis);
      if (!permits(yield* currentPolicy, policy) || policy.grant === "none") return undefined;
      const initial = yield* capture(threadId);
      if (!initial) return undefined;
      // Preserve existing explicit/repository mapping semantics, including discovery outside SQL.
      const projectKey = yield* service.resolveProjectKey(initial.space, initial.project);
      const view = yield* capture(threadId);
      if (
        !view ||
        view.space !== initial.space ||
        view.runId !== initial.runId ||
        view.project.projectId !== initial.project.projectId ||
        view.watermark !== initial.watermark
      )
        return undefined;
      const scopes: M.MemoryScope[] = [
        { kind: "thread", thread: { environmentId, threadId } },
        ...(projectKey ? [{ kind: "project" as const, projectKey }] : []),
        { kind: "user" },
      ];
      let pages = 0;
      const candidates: M.MemoryContextCandidate[] = [];
      for (const scope of scopes) {
        let cursor: string | undefined;
        do {
          if (pages === 10) break;
          if (!permits(yield* currentPolicy, policy) || !sameView(view, yield* capture(threadId)))
            return undefined;
          // Each page reserves 100 slots and 64 KiB, regardless of filtering/oversize output.
          pages++;
          const page = yield* service.readContextCandidates(
            {
              memorySpaceId: view.space,
              scope,
              limit: 100,
              includeQuarantined: true,
              ...(cursor ? { cursor } : {}),
            },
            Effect.void,
          );
          if (page.projectionWatermark !== view.watermark) return undefined;
          candidates.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (pages === 10) break;
      }
      if (!permits(yield* currentPolicy, policy) || !sameView(view, yield* capture(threadId)))
        return undefined;
      const snapshot = Renderer.packMemoryContext({
        memorySpaceId: view.space,
        projectionWatermark: view.watermark,
        items: candidates,
      });
      if (!snapshot) return undefined;
      const bytes = yield* Effect.try({
        try: () => new TextEncoder().encode(encodeSnapshot(snapshot)).length,
        catch: (cause) => new MemorySnapshotError({ cause }),
      });
      const now = yield* Clock.currentTimeMillis;
      sweep(now);
      while (cacheBytes + bytes > M.MEMORY_DERIVED_CACHE_MAX_BYTES && entries.size)
        remove(entries.keys().next().value!);
      entries.set(snapshot, {
        view,
        epoch: policy.policyEpoch,
        expires: now + M.MEMORY_DERIVED_CACHE_TTL_MS,
        bytes,
      });
      cacheBytes += bytes;
      return snapshot;
    },
    Effect.mapError((cause) => new MemorySnapshotError({ cause })),
  );
  const revalidate = Effect.fn("MemorySnapshot.revalidate")(
    function* (
      snapshot: M.MemoryContextSnapshot,
      execution: { threadId: M.ThreadId; runId: M.RunId },
      currentPolicy: CurrentPolicy,
    ) {
      sweep(yield* Clock.currentTimeMillis);
      yield* Effect.try({
        try: () => Renderer.validateMemoryContext(snapshot),
        catch: (cause) => new MemorySnapshotError({ cause }),
      });
      const entry = entries.get(snapshot);
      const clear = () => {
        remove(snapshot);
        return undefined;
      };
      if (
        !entry ||
        entry.view.threadId !== execution.threadId ||
        entry.view.runId !== execution.runId
      )
        return clear();
      const policy = yield* currentPolicy;
      if (!permits(policy, { grant: "read", policyEpoch: entry.epoch })) return clear();
      const view = yield* capture(execution.threadId);
      // Restore allows a newer watermark, but never a different execution or binding.
      if (!view || !sameView({ ...entry.view, watermark: view.watermark }, view)) return clear();
      const current = yield* service.readContextRevisions(
        snapshot.memorySpaceId,
        snapshot.items.map((i) => i.memoryId),
        Effect.void,
      );
      if (current.projectionWatermark !== view.watermark) return clear();
      const survivors = snapshot.items.filter((original) =>
        current.items.some(
          (item) =>
            item.memoryId === original.memoryId &&
            item.revisionId === original.revisionId &&
            encodeScope(item.scope) === encodeScope(original.scope),
        ),
      );
      if (
        !permits(yield* currentPolicy, policy) ||
        !sameView(view, yield* capture(execution.threadId))
      )
        return clear();
      const restored = Renderer.packMemoryContext({
        memorySpaceId: view.space,
        projectionWatermark: view.watermark,
        items: survivors,
      });
      if (!restored) return clear();
      const bytes = yield* Effect.try({
        try: () => new TextEncoder().encode(encodeSnapshot(restored)).length,
        catch: (cause) => new MemorySnapshotError({ cause }),
      });
      while (cacheBytes + bytes > M.MEMORY_DERIVED_CACHE_MAX_BYTES && entries.size)
        remove(entries.keys().next().value!);
      entries.set(restored, { ...entry, view, bytes });
      cacheBytes += bytes;
      return restored;
    },
    Effect.mapError((cause) => new MemorySnapshotError({ cause })),
  );
  return MemorySnapshot.of({
    forThread,
    revalidate: (snapshot, execution, currentPolicy) =>
      revalidate(snapshot, execution, currentPolicy).pipe(
        Effect.tapError(() => Effect.sync(() => remove(snapshot))),
      ),
    invalidate,
  });
});
export const layer = Layer.effect(MemorySnapshot, make);
