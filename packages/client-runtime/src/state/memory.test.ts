import {
  EnvironmentId,
  MemorySpaceId,
  MemoryId,
  MemoryItem,
  MemoryChangeSignal,
  MemoryImportProviderResult,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ServerConfig,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry, EnvironmentNotRegisteredError } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createMemoryEnvironmentAtoms,
  applyMemoryChange,
  emptyMemoryExposure,
  memoryExposureMatches,
} from "./memory.ts";

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
const harness = Effect.fn(function* () {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const queue = yield* Queue.unbounded<MemoryChangeSignal>();
  const readStarted = yield* Deferred.make<void>();
  const reply = yield* Deferred.make<MemoryItem>();
  let subscriptions = 0;
  const destinations: EnvironmentId[] = [];
  let readCount = 0;
  const rpc = {
    [WS_METHODS.memoryChanges]: () => {
      subscriptions++;
      return Stream.fromQueue(queue);
    },
    [WS_METHODS.memoryRead]: () =>
      ++readCount === 1
        ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(reply)))
        : Effect.never,
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
      : Stream.empty;
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([
      [env, { enabled: true } as ConnectionCatalogEntry],
      [other, { enabled: true } as ConnectionCatalogEntry],
    ]),
  );
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run,
      followStream,
      entries,
    } as unknown as EnvironmentRegistry["Service"]),
  );
  const memory = createMemoryEnvironmentAtoms(runtime);
  registry.set(
    grants(env),
    AsyncResult.success(sessionScopes(["memory:read", "memory:write", "filesystem:read"])),
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
    memory,
    active,
    queue,
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
});
