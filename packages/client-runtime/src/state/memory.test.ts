import {
  EnvironmentId,
  MemorySpaceId,
  MemoryId,
  MemoryItem,
  MemoryPage,
  MemoryHistoryPage,
  MemorySourcePage,
  MemoryRpcError,
  ThreadId,
  MessageId,
  MemoryChangeSignal,
  MemoryImportProviderResult,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ServerConfig,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HashMap from "effect/HashMap";
import type { EnvironmentCatalogState } from "./connections.ts";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry, EnvironmentNotRegisteredError } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createMemoryEnvironmentAtoms,
  createMemoryTombstoneLedger,
  applyMemoryChange,
  emptyMemoryExposure,
  memoryExposureMatches,
} from "./memory.ts";

vi.mock("./connections.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connections.ts")>();
  return {
    ...actual,
    createEnvironmentCatalogAtoms: (
      ...args: Parameters<typeof actual.createEnvironmentCatalogAtoms>
    ) => {
      const override = catalogOverrides.get(args[0]);
      return override
        ? { catalogValueAtom: override }
        : actual.createEnvironmentCatalogAtoms(...args);
    },
  };
});
const catalogOverrides = new WeakMap<object, Atom.Atom<EnvironmentCatalogState>>();

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: grants,
    initialConfigValueAtom: configs,
    preparedConnectionValueAtom: prepared,
  }),
}));
const grants = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const configs = Atom.family((_id: EnvironmentId) => Atom.make<ServerConfig | null>(null));
const prepared = Atom.family((_id: EnvironmentId) =>
  Atom.make(Option.some({} as PreparedConnection)),
);
const env = EnvironmentId.make("selected-tunnel");
const other = EnvironmentId.make("other-remote");
const space = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const id = MemoryId.make("00000000-0000-4000-8000-000000000002");
const unrelated = MemoryId.make("00000000-0000-4000-8000-000000000003");
const target = { environmentId: env, input: { memorySpaceId: space } };
const readTarget = { environmentId: env, input: { memorySpaceId: space, memoryId: id } };
const config = {
  environment: { capabilities: { memory: { protocolVersion: 1, importProvider: true } } },
} as ServerConfig;
function sessionScopes(scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState {
  return {
    authenticated: true,
    scopes,
    permissions: scopes,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "synthetic",
    },
  };
}
const decodeSignal = Schema.decodeUnknownSync(MemoryChangeSignal);
const decodeImport = Schema.decodeUnknownSync(MemoryImportProviderResult);
const signal = (kind: MemoryChangeSignal["kind"], memoryId = id) =>
  decodeSignal({
    memorySpaceId: space,
    projectionWatermark: 1,
    kind,
    ...(kind === "reset" ? {} : { memoryId }),
  });
const item = Schema.decodeUnknownSync(MemoryItem)({
  memorySpaceId: space,
  memoryId: id,
  status: "active",
  pendingSync: false,
  localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
  scope: { kind: "user" },
  revision: {
    memorySpaceId: space,
    memoryId: id,
    revisionId: "00000000-0000-4000-8000-000000000004",
    operationId: "00000000-0000-4000-8000-000000000005",
    parents: [],
    scope: { kind: "user" },
    payloadRef: "00000000-0000-4000-8000-000000000004",
    assertionKind: "fact",
    provenance: { environmentId: env },
    createdAtUtc: "2026-10-14T00:00:00.000Z",
  },
  payload: {
    text: "Synthetic memory",
    evidence: [{ origin: "user", messageIds: [] }],
    derivedFromMemoryRevisions: [],
  },
});
const page = Schema.decodeUnknownSync(MemoryPage)({
  items: [item],
  projectionWatermark: 1,
  nextCursor: null,
});
const history = Schema.decodeUnknownSync(MemoryHistoryPage)({
  memoryId: id,
  revisions: item.status === "active" ? [{ revision: item.revision, payload: item.payload }] : [],
  resolutions: [],
  tombstone: null,
  reports: [],
  revertResults: [],
  localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
  nextCursor: null,
});
const sourcePage = Schema.decodeUnknownSync(MemorySourcePage)({
  sourceThread: { environmentId: env, threadId: "synthetic-thread" },
  watermark: { fromEventId: "e1", toEventId: "e2", throughSequence: 2 },
  messages: [{ messageId: "m1", text: "Synthetic source" }],
  nextCursor: null,
});
function hasBody<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<Option.Option<A>, E>>) {
  return Atom.make((get) => {
    const result = get(atom);
    return result._tag === "Success" && Option.isSome(result.value);
  });
}
function waitFor<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  predicate: (value: A) => boolean,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runHead,
  );
}
const harness = Effect.fn(function* (ledger = createMemoryTombstoneLedger()) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const queue = yield* Queue.unbounded<
    MemoryChangeSignal | MemoryRpcError | RpcClientError.RpcClientError
  >();
  const otherQueue = yield* Queue.unbounded<MemoryChangeSignal>();
  const readStarted = yield* Deferred.make<void>();
  const reply = yield* Deferred.make<MemoryItem, MemoryRpcError>();
  const readFinalized = yield* Deferred.make<void>();
  const reads = yield* Queue.unbounded<{
    reply: Deferred.Deferred<MemoryItem, MemoryRpcError>;
    finalized: Deferred.Deferred<void>;
  }>();
  let subscriptions = 0;
  const destinations: EnvironmentId[] = [];
  let readCount = 0;
  const responded = new Set<string>();
  const respondOnce = <A>(method: string, value: A) =>
    Effect.suspend(() => {
      if (responded.has(method)) return Effect.never;
      responded.add(method);
      return Deferred.await(reply).pipe(Effect.as(value));
    });
  const rpc = {
    [WS_METHODS.memoryChanges]: () => {
      subscriptions++;
      return Stream.fromQueue(queue).pipe(
        Stream.mapEffect((event) => ("kind" in event ? Effect.succeed(event) : Effect.fail(event))),
      );
    },
    [WS_METHODS.memoryRead]: () =>
      Effect.gen(function* () {
        const first = ++readCount === 1;
        const response = first ? reply : yield* Deferred.make<MemoryItem, MemoryRpcError>();
        const finalized = first ? readFinalized : yield* Deferred.make<void>();
        yield* Queue.offer(reads, { reply: response, finalized });
        if (first) yield* Deferred.succeed(readStarted, undefined);
        return yield* Deferred.await(response).pipe(
          Effect.ensuring(Deferred.succeed(finalized, undefined)),
        );
      }),
    [WS_METHODS.memoryList]: () => respondOnce("list", page),
    [WS_METHODS.memorySearch]: () => respondOnce("search", page),
    [WS_METHODS.memoryHistory]: () => respondOnce("history", history),
    [WS_METHODS.memoryReadSource]: () => respondOnce("source", sourcePage),
    [WS_METHODS.memoryImportProvider]: () =>
      Effect.succeed(decodeImport({ action: "discover", sources: [] })),
  };
  const active = yield* SubscriptionRef.make(
    Option.some({ client: rpc, initialConfig: Effect.succeed(config) } as unknown as RpcSession),
  );
  const supervisor = {
    target: { environmentId: env, label: "Selected tunnel" },
    session: active,
  } as unknown as EnvironmentSupervisor["Service"];
  const otherActive = yield* SubscriptionRef.make(
    Option.some({
      client: { [WS_METHODS.memoryChanges]: () => Stream.fromQueue(otherQueue) },
      initialConfig: Effect.succeed(config),
    } as unknown as RpcSession),
  );
  const otherSupervisor = {
    target: { environmentId: other },
    session: otherActive,
  } as unknown as EnvironmentSupervisor["Service"];
  let available = true;
  const run: EnvironmentRegistry["Service"]["run"] = (environmentId, effect) => {
    destinations.push(environmentId);
    return available && environmentId === env
      ? Effect.provideService(effect, EnvironmentSupervisor, supervisor)
      : Effect.fail(new EnvironmentNotRegisteredError({ environmentId }));
  };
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (environmentId, stream) =>
    environmentId === env
      ? Stream.provideService(stream, EnvironmentSupervisor, supervisor)
      : environmentId === other
        ? Stream.provideService(stream, EnvironmentSupervisor, otherSupervisor)
        : Stream.empty;
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([
      [env, { enabled: true } as ConnectionCatalogEntry],
      [other, { enabled: true } as ConnectionCatalogEntry],
    ]),
  );
  const clock = yield* Clock.Clock;
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, {
        run,
        followStream,
        entries,
      } as unknown as EnvironmentRegistry["Service"]),
      Layer.succeed(Clock.Clock, clock),
    ),
  );
  const memory = createMemoryEnvironmentAtoms(runtime, ledger);
  registry.mount(grants(env));
  registry.mount(grants(other));
  registry.mount(configs(env));
  registry.mount(configs(other));
  registry.mount(prepared(env));
  registry.mount(prepared(other));
  registry.set(
    grants(env),
    AsyncResult.success(
      sessionScopes(["memory:read", "memory:write", "filesystem:read", "orchestration:read"]),
    ),
  );
  registry.set(grants(other), AsyncResult.success(sessionScopes([])));
  registry.set(configs(env), config);
  registry.set(configs(other), config);
  yield* waitFor(
    registry,
    memory.importProvider.permissionAtom(env, {
      memorySpaceId: space,
      action: "discover",
      format: "claude",
    }),
    Boolean,
  );
  return {
    registry,
    entries,
    memory,
    active,
    queue,
    otherQueue,
    rpc,
    runtime,
    ledger,
    recreate: () => createMemoryEnvironmentAtoms(runtime, ledger),
    readCount: () => readCount,
    reads,
    readFinalized,
    readStarted,
    reply,
    destinations,
    subscriptions: () => subscriptions,
    remove: () => {
      available = false;
      return SubscriptionRef.set(entries, new Map());
    },
  };
});

describe("shared memory client", () => {
  it("fences reset/hold/dependency/forget and never resurrects an observed tombstone", () => {
    const initial = applyMemoryChange(emptyMemoryExposure(), signal("reset"));
    for (const kind of ["reset", "invalidate", "forget"] as const) {
      const changed = applyMemoryChange(initial, signal(kind));
      expect(memoryExposureMatches(initial, changed, [id])).toBe(false);
      if (kind !== "reset") expect(memoryExposureMatches(initial, changed, [unrelated])).toBe(true);
    }
    const forgotten = applyMemoryChange(initial, signal("forget"));
    const reset = applyMemoryChange(forgotten, signal("reset"));
    const newer = applyMemoryChange(reset, signal("upsert"));
    expect(memoryExposureMatches(newer, newer, [id])).toBe(false);
  });

  it.effect(
    "uses the selected destination and compound import grants, and rejects a removed environment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const request = {
            environmentId: env,
            input: { memorySpaceId: space, action: "discover" as const, format: "claude" as const },
          };
          expect(h.registry.get(h.memory.importProvider.permissionAtom(env, request.input))).toBe(
            true,
          );
          expect(
            (yield* Effect.promise(() => h.memory.importProvider.run(h.registry, request)))._tag,
          ).toBe("Success");
          expect(h.destinations).toEqual([env]);
          for (const scopes of [["memory:write"], ["filesystem:read"], []] as const) {
            h.registry.set(grants(env), AsyncResult.success(sessionScopes(scopes)));
            expect(h.registry.get(h.memory.importProvider.permissionAtom(env, request.input))).toBe(
              false,
            );
            expect(
              (yield* Effect.promise(() => h.memory.importProvider.run(h.registry, request)))._tag,
            ).toBe("Failure");
          }
          h.registry.set(
            grants(env),
            AsyncResult.success(sessionScopes(["memory:write", "filesystem:read"])),
          );
          h.registry.set(configs(env), {
            environment: { capabilities: { memory: { protocolVersion: 1 } } },
          } as ServerConfig);
          expect(h.registry.get(h.memory.importProvider.permissionAtom(env, request.input))).toBe(
            false,
          );
          yield* h.remove();
          expect(
            (yield* Effect.promise(() => h.memory.importProvider.run(h.registry, request)))._tag,
          ).toBe("Failure");
          expect(h.destinations.every((destination) => destination === env)).toBe(true);
          expect(h.registry.get(h.memory.importProvider.permissionAtom(other, request.input))).toBe(
            false,
          );
        }),
      ),
  );

  it.effect.each(["reset", "forget", "invalidate"] as const)(
    "discards a delayed read after %s and clears derived edits only",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const edit = h.memory.draftAtom({ ...target, draftId: "edit" });
          const fresh = h.memory.draftAtom({ ...target, draftId: "new" });
          const otherEdit = h.memory.draftAtom({ ...target, draftId: "other-edit" });
          h.registry.mount(edit);
          h.registry.mount(fresh);
          h.registry.mount(otherEdit);
          h.registry.set(edit, { text: "Derived body", memoryIds: [id] });
          h.registry.set(fresh, { text: "New draft", memoryIds: [] });
          h.registry.set(otherEdit, { text: "Unrelated edit", memoryIds: [unrelated] });
          const source = h.memory.read(readTarget);
          const read = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
          h.registry.mount(read);
          yield* Deferred.await(h.readStarted);
          const before = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal(kind));
          yield* waitFor(h.registry, exposure, (state) => state !== before);
          expect(h.registry.get(edit)).toBeNull();
          expect(h.registry.get(fresh)).toBe("New draft");
          expect(h.registry.get(otherEdit)).toBe(kind === "reset" ? null : "Unrelated edit");
          yield* Deferred.succeed(h.reply, item);
          yield* TestClock.adjust(0);
          expect(Option.isNone(h.registry.get(read))).toBe(true);
        }),
      ),
  );
  it.effect(
    "subscribes once, evicts visible bodies on disconnect, and waits for a fresh reset",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const source = h.memory.read(readTarget);
          const body = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
          h.registry.mount(body);
          yield* Deferred.await(h.readStarted);
          yield* Deferred.succeed(h.reply, item);
          yield* waitFor(h.registry, body, Option.isSome);
          expect(h.subscriptions()).toBe(1);
          yield* SubscriptionRef.set(h.active, Option.none());
          yield* waitFor(h.registry, exposure, (state) => !state.ready);
          expect(Option.isNone(h.registry.get(body))).toBe(true);
        }),
      ),
  );
  it.effect.each(["reset", "forget", "invalidate"] as const)(
    "evicts list/search/history/source and visible reads on %s",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const bodies = [
            hasBody(h.memory.read(readTarget)),
            hasBody(
              h.memory.list({
                ...target,
                input: { ...target.input, includeQuarantined: false, limit: 10 },
              }),
            ),
            hasBody(
              h.memory.search({
                ...target,
                input: { ...target.input, query: "Synthetic", mode: "fts", limit: 10 },
              }),
            ),
            hasBody(h.memory.history({ ...readTarget, input: { ...readTarget.input, limit: 10 } })),
            hasBody(
              h.memory.readSource({
                ...readTarget,
                input: {
                  ...readTarget.input,
                  limit: 10,
                  sourceThread: { environmentId: env, threadId: ThreadId.make("synthetic-thread") },
                  messageIds: [MessageId.make("m1")],
                },
              }),
            ),
          ];
          for (const body of bodies) h.registry.mount(body);
          yield* Deferred.succeed(h.reply, item);
          for (const body of bodies) yield* waitFor(h.registry, body, Boolean);
          const before = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal(kind));
          yield* waitFor(h.registry, exposure, (state) => state !== before);
          expect(bodies.map((body) => h.registry.get(body))).toEqual([
            false,
            false,
            false,
            false,
            false,
          ]);
        }),
      ),
  );
  it.effect.each(["downgrade", "remove", "prepared", "prepared-replaced", "failure"] as const)(
    "clears exposure and edits on %s",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const edit = h.memory.draftAtom({ ...target, draftId: "edit" });
          h.registry.mount(edit);
          h.registry.set(edit, { text: "Derived", memoryIds: [id] });
          if (reason === "downgrade")
            h.registry.set(grants(env), AsyncResult.success(sessionScopes([])));
          if (reason === "remove") yield* h.remove();
          if (reason === "prepared") h.registry.set(prepared(env), Option.none());
          if (reason === "prepared-replaced")
            h.registry.set(prepared(env), Option.some({} as PreparedConnection));
          if (reason === "failure")
            yield* Queue.offer(h.queue, new MemoryRpcError({ code: "bootstrap_required" }));
          yield* waitFor(h.registry, exposure, (state) => !state.ready);
          expect(h.registry.get(edit)).toBeNull();
        }),
      ),
  );
  it.effect("expires a mounted body and forwards public refresh to a second RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const source = h.memory.read(readTarget);
        const body = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
        h.registry.mount(body);
        yield* Deferred.await(h.readStarted);
        yield* Deferred.succeed(h.reply, item);
        yield* waitFor(h.registry, body, Option.isSome);
        yield* TestClock.adjust("1 minute");
        yield* waitFor(h.registry, body, Option.isNone);
        expect(Option.isNone(h.registry.get(body))).toBe(true);
        expect(h.readCount()).toBe(1);
        yield* Queue.take(h.reads);
        h.registry.refresh(source);
        expect(Option.isNone(h.registry.get(body))).toBe(true);
        const second = yield* Queue.take(h.reads);
        expect(h.readCount()).toBe(2);
        yield* Deferred.succeed(second.reply, item);
        yield* waitFor(h.registry, body, Option.isSome);
      }),
    ),
  );
  it.effect("does not open a read stream for a write-only grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.registry.set(grants(env), AsyncResult.success(sessionScopes(["memory:write"])));
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* TestClock.adjust(0);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.subscriptions()).toBe(0);
      }),
    ),
  );
  it.effect.each(["pending", "visible"] as const)(
    "closes %s body/draft immediately on transport failure with session/prepared retained",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const source = h.memory.read(readTarget);
          const body = hasBody(source);
          h.registry.mount(body);
          yield* Deferred.await(h.readStarted);
          const edit = h.memory.draftAtom({ ...target, draftId: "transport-edit" });
          h.registry.mount(edit);
          h.registry.set(edit, { text: "Derived", memoryIds: [id] });
          if (phase === "visible") {
            yield* Deferred.succeed(h.reply, item);
            yield* waitFor(h.registry, body, Boolean);
          }
          const session = yield* SubscriptionRef.get(h.active);
          const connection = h.registry.get(prepared(env));
          yield* Queue.offer(
            h.queue,
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "synthetic transport closed",
                cause: new Error("synthetic"),
              }),
            }),
          );
          yield* waitFor(h.registry, exposure, (state) => !state.ready);
          expect(h.registry.get(body)).toBe(false);
          expect(h.registry.get(edit)).toBeNull();
          expect(yield* SubscriptionRef.get(h.active)).toBe(session);
          expect(h.registry.get(prepared(env))).toBe(connection);
          yield* Deferred.await(h.readFinalized);
          yield* Deferred.succeed(h.reply, item);
          yield* TestClock.adjust(0);
          expect(h.registry.get(body)).toBe(false);
          // Recovery belongs to session lifecycle, and an upsert cannot replace reset.
          yield* SubscriptionRef.set(
            h.active,
            Option.some({
              client: h.rpc,
              initialConfig: Effect.succeed(config),
            } as unknown as RpcSession),
          );
          const before = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal("upsert", unrelated));
          yield* waitFor(h.registry, exposure, (state) => state !== before);
          expect(h.registry.get(exposure).ready).toBe(false);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          expect(h.registry.get(body)).toBe(false);
        }),
      ),
  );

  it.effect("retries a failed mounted public query and keeps the old body absent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const source = h.memory.read(readTarget);
        h.registry.mount(source);
        const first = yield* Queue.take(h.reads);
        yield* Deferred.fail(first.reply, new MemoryRpcError({ code: "bootstrap_required" }));
        yield* waitFor(h.registry, source, (value) => value._tag === "Failure");
        h.registry.refresh(source);
        const second = yield* Queue.take(h.reads);
        expect(Option.isNone(Option.flatten(AsyncResult.value(h.registry.get(source))))).toBe(true);
        yield* Deferred.succeed(second.reply, item);
        yield* waitFor(h.registry, hasBody(source), Boolean);
        expect(h.readCount()).toBe(2);
      }),
    ),
  );

  it.effect("retains tombstones when weak-family closures are deterministically recreated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        const release = h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        yield* Queue.offer(h.queue, signal("forget"));
        yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
        release();
        yield* TestClock.adjust(0);
        // A fresh family guarantees fresh closures without relying on nondeterministic GC.
        const recreated = h.recreate();
        const next = recreated.exposureAtom(target);
        h.registry.mount(next);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, next, (state) => state.ready);
        const before = h.registry.get(next);
        yield* Queue.offer(h.queue, signal("upsert"));
        yield* waitFor(h.registry, next, (state) => state !== before);
        expect(memoryExposureMatches(h.registry.get(next), h.registry.get(next), [id])).toBe(false);
        const body = hasBody(recreated.read(readTarget));
        h.registry.mount(body);
        yield* TestClock.adjust(0);
        expect(h.readCount()).toBe(0);
        expect(h.registry.get(body)).toBe(false);
      }),
    ),
  );

  it("bounds ledger metadata without evicting tombstones and removes only absent environments", () => {
    const ledger = createMemoryTombstoneLedger(2, 1);
    const selected = ledger.space(env, space);
    ledger.forget(selected, id);
    expect(ledger.space(env, space)).toBe(selected);
    ledger.forget(selected, unrelated);
    expect(selected.blocked).toBe(true);
    expect(selected.forgotten.has(id)).toBe(true);
    expect(selected.forgotten.size).toBe(1);
    const foreign = ledger.space(other, space);
    expect(
      ledger.space(env, MemorySpaceId.make("00000000-0000-4000-8000-000000000010")).blocked,
    ).toBe(true);
    ledger.retainEnvironments(new Map([[env, {}]]));
    expect(ledger.space(env, space)).toBe(selected);
    expect(ledger.space(other, space)).not.toBe(foreign);
    ledger.dispose();
    expect(ledger.space(env, space).blocked).toBe(true);
  });

  it.effect("factory disposal closes mounted exposure, body and derived draft", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* Deferred.succeed(h.reply, item);
        yield* waitFor(h.registry, body, Boolean);
        const edit = h.memory.draftAtom({ ...target, draftId: "dispose" });
        h.registry.mount(edit);
        h.registry.set(edit, { text: "Derived", memoryIds: [id] });
        h.memory.dispose(h.registry);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.registry.get(body)).toBe(false);
        expect(h.registry.get(edit)).toBeNull();
      }),
    ),
  );

  it.effect("other ID changes preserve direct read/history/source while invalidating pages", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const bodies = [
          hasBody(h.memory.read(readTarget)),
          hasBody(h.memory.history({ ...readTarget, input: { ...readTarget.input, limit: 10 } })),
          hasBody(
            h.memory.readSource({
              ...readTarget,
              input: {
                ...readTarget.input,
                limit: 10,
                sourceThread: { environmentId: env, threadId: ThreadId.make("synthetic-thread") },
                messageIds: [MessageId.make("m1")],
              },
            }),
          ),
          hasBody(
            h.memory.list({
              ...target,
              input: { ...target.input, includeQuarantined: false, limit: 10 },
            }),
          ),
          hasBody(
            h.memory.search({
              ...target,
              input: { ...target.input, query: "Synthetic", mode: "fts", limit: 10 },
            }),
          ),
        ];
        for (const body of bodies) h.registry.mount(body);
        yield* Deferred.succeed(h.reply, item);
        for (const body of bodies) yield* waitFor(h.registry, body, Boolean);
        const before = h.registry.get(exposure);
        yield* Queue.offer(h.queue, signal("upsert", unrelated));
        yield* waitFor(h.registry, exposure, (state) => state !== before);
        expect(bodies.map((body) => h.registry.get(body))).toEqual([
          true,
          true,
          true,
          false,
          false,
        ]);
        expect(h.readCount()).toBe(1);
      }),
    ),
  );

  it.effect("signals from another environment preserve selected bodies and derived drafts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.registry.set(grants(other), AsyncResult.success(sessionScopes(["memory:read"])));
        const selected = h.memory.exposureAtom(target);
        const foreign = h.memory.exposureAtom({ ...target, environmentId: other });
        h.registry.mount(selected);
        h.registry.mount(foreign);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* Queue.offer(h.otherQueue, signal("reset"));
        yield* waitFor(h.registry, selected, (state) => state.ready);
        yield* waitFor(h.registry, foreign, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* Deferred.succeed(h.reply, item);
        yield* waitFor(h.registry, body, Boolean);
        const edit = h.memory.draftAtom({ ...target, draftId: "selected" });
        h.registry.mount(edit);
        h.registry.set(edit, { text: "Selected derived", memoryIds: [id] });
        const before = h.registry.get(foreign);
        yield* Queue.offer(h.otherQueue, signal("forget"));
        yield* waitFor(h.registry, foreign, (state) => state !== before);
        expect(h.registry.get(body)).toBe(true);
        expect(h.registry.get(edit)).toBe("Selected derived");
        expect(h.readCount()).toBe(1);
      }),
    ),
  );

  it.effect("replacing Some(prepared) requires reset and cancels the old pending body", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* Deferred.await(h.readStarted);
        h.registry.set(prepared(env), Option.some({} as PreparedConnection));
        yield* waitFor(h.registry, exposure, (state) => !state.ready);
        yield* Deferred.await(h.readFinalized);
        yield* Deferred.succeed(h.reply, item);
        const before = h.registry.get(exposure);
        yield* Queue.offer(h.queue, signal("upsert"));
        yield* waitFor(h.registry, exposure, (state) => state !== before);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.registry.get(body)).toBe(false);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        expect(h.registry.get(body)).toBe(false);
      }),
    ),
  );

  it.effect("session replacement fences old signals and late body until a new reset", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* Deferred.await(h.readStarted);
        const nextQueue = yield* Queue.unbounded<MemoryChangeSignal>();
        yield* SubscriptionRef.set(
          h.active,
          Option.some({
            client: { ...h.rpc, [WS_METHODS.memoryChanges]: () => Stream.fromQueue(nextQueue) },
            initialConfig: Effect.succeed(config),
          } as unknown as RpcSession),
        );
        yield* waitFor(h.registry, exposure, (state) => !state.ready);
        yield* Deferred.await(h.readFinalized);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* Queue.offer(h.queue, signal("forget"));
        yield* Deferred.succeed(h.reply, item);
        const before = h.registry.get(exposure);
        yield* Queue.offer(nextQueue, signal("upsert", unrelated));
        yield* waitFor(h.registry, exposure, (state) => state !== before);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.registry.get(exposure).forgotten.has(id)).toBe(false);
        expect(h.registry.get(body)).toBe(false);
        yield* Queue.offer(nextQueue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        expect(h.registry.get(body)).toBe(false);
      }),
    ),
  );

  it.effect("losing only orchestration:read clears source but preserves memory read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        const source = hasBody(
          h.memory.readSource({
            ...readTarget,
            input: {
              ...readTarget.input,
              limit: 10,
              sourceThread: { environmentId: env, threadId: ThreadId.make("synthetic-thread") },
              messageIds: [MessageId.make("m1")],
            },
          }),
        );
        h.registry.mount(body);
        h.registry.mount(source);
        yield* Deferred.succeed(h.reply, item);
        yield* waitFor(h.registry, body, Boolean);
        yield* waitFor(h.registry, source, Boolean);
        h.registry.set(
          grants(env),
          AsyncResult.success(sessionScopes(["memory:read", "memory:write", "filesystem:read"])),
        );
        expect(h.registry.get(source)).toBe(false);
        expect(h.registry.get(body)).toBe(true);
        expect(h.registry.get(exposure).ready).toBe(true);
      }),
    ),
  );

  it.effect("missing memory capability starts neither a body request nor a changes stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.registry.set(configs(env), { environment: { capabilities: {} } } as ServerConfig);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* TestClock.adjust(0);
        expect(h.registry.get(body)).toBe(false);
        expect(h.subscriptions()).toBe(0);
        expect(h.readCount()).toBe(0);
      }),
    ),
  );

  it.effect.each(["timeout", "unmount"] as const)(
    "interrupts the actual pending RPC finalizer on %s",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const source = h.memory.read(readTarget);
          const release = h.registry.mount(source);
          yield* Deferred.await(h.readStarted);
          if (reason === "timeout") yield* TestClock.adjust("1 minute");
          else {
            release();
            yield* TestClock.adjust(0);
          }
          yield* Deferred.await(h.readFinalized);
          yield* Deferred.succeed(h.reply, item);
          if (reason === "timeout")
            expect(Option.isNone(Option.flatten(AsyncResult.value(h.registry.get(source))))).toBe(
              true,
            );
        }),
      ),
  );
  it.effect("ledger overflow stays closed across reset without forgetting earlier tombstones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(createMemoryTombstoneLedger(2, 1));
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        yield* Queue.offer(h.queue, signal("forget"));
        yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
        yield* Queue.offer(h.queue, signal("forget", unrelated));
        yield* waitFor(h.registry, exposure, (state) => !state.ready);
        const before = h.registry.get(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state !== before);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.registry.get(exposure).forgotten.has(id)).toBe(true);
      }),
    ),
  );
  it.effect("unready empty catalog preserves an existing ledger until registration is known", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const retained = h.ledger.space(env, space);
        h.ledger.forget(retained, id);
        const catalog = Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() });
        catalogOverrides.set(h.runtime, catalog);
        const recreated = h.recreate();
        const exposure = recreated.exposureAtom(target);
        h.registry.mount(exposure);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.ledger.space(env, space)).toBe(retained);
        expect(retained.forgotten.has(id)).toBe(true);
        h.registry.set(catalog, { isReady: true, entries: yield* SubscriptionRef.get(h.entries) });
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        expect(h.registry.get(exposure).forgotten.has(id)).toBe(true);
        const body = hasBody(recreated.read(readTarget));
        h.registry.mount(body);
        expect(h.registry.get(body)).toBe(false);
        h.registry.set(catalog, { isReady: true, entries: new Map() });
        yield* waitFor(h.registry, exposure, (state) => !state.ready);
        expect(h.ledger.space(env, space)).not.toBe(retained);
      }),
    ),
  );

  it.effect.each(["pending", "visible"] as const)(
    "version 10000/10001 boundary fences %s body/draft and resumes only after reset",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const source = h.memory.read(readTarget);
          const body = hasBody(source);
          h.registry.mount(body);
          const first = yield* Queue.take(h.reads);
          const edit = h.memory.draftAtom({ ...target, draftId: "version-limit" });
          h.registry.mount(edit);
          h.registry.set(edit, { text: "Derived before overflow", memoryIds: [id] });
          if (phase === "visible") {
            yield* Deferred.succeed(first.reply, item);
            yield* waitFor(h.registry, body, Boolean);
          }
          const changes = Array.from({ length: 10_000 }, (_, index) =>
            signal(
              "upsert",
              MemoryId.make(`10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`),
            ),
          );
          yield* Queue.offerAll(h.queue, changes);
          yield* waitFor(h.registry, exposure, (state) => HashMap.size(state.versions) === 10_000);
          expect(h.registry.get(exposure).ready).toBe(true);
          expect(h.registry.get(edit)).toBe("Derived before overflow");
          expect(h.readCount()).toBe(1);
          expect(h.registry.get(body)).toBe(phase === "visible");
          const before = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal("upsert", unrelated));
          yield* waitFor(h.registry, exposure, (state) => !state.ready);
          expect(HashMap.size(h.registry.get(exposure).versions)).toBe(0);
          expect(h.registry.get(exposure).epoch).not.toBe(before.epoch);
          expect(h.registry.get(body)).toBe(false);
          expect(h.registry.get(edit)).toBeNull();
          yield* Deferred.await(first.finalized);
          yield* Deferred.succeed(first.reply, item);
          const closed = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal("upsert", unrelated));
          yield* waitFor(h.registry, exposure, (state) => state !== closed);
          expect(h.registry.get(exposure).ready).toBe(false);
          expect(h.registry.get(body)).toBe(false);
          expect(h.readCount()).toBe(1);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const second = yield* Queue.take(h.reads);
          expect(h.registry.get(body)).toBe(false);
          expect(h.registry.get(edit)).toBeNull();
          expect(HashMap.size(h.registry.get(exposure).versions)).toBe(0);
          yield* Deferred.succeed(second.reply, item);
          yield* waitFor(h.registry, body, Boolean);
          expect(h.readCount()).toBe(2);
          expect(h.registry.get(edit)).toBeNull();
        }),
      ),
  );
});
