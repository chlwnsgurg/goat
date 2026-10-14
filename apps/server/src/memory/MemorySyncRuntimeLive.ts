import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Client from "./MemoryHubClient.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Sync from "./MemorySyncService.ts";

const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const settings = yield* Settings.MemoryHubCommittedSettings;
  const store = yield* Store.MemoryStore;
  const registry = yield* Registry.ProviderInstanceRegistry;
  const client = yield* Client.MemoryHubClient;
  type Observation = {
    epoch: number;
    memorySpaceId: M.MemorySpaceId;
    holdClass: Store.MemoryHoldClass;
  };
  const events = yield* PubSub.dropping<Observation>(16);
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  // One transport binding, four failure classes, and one safe descriptor tuple.
  // Never retain credential bytes, response bodies or a per-request history.
  let epoch: number | null = null;
  let binding: Client.HubConnection | null = null;
  let descriptor: { identity: M.EnvironmentId; protocol: number | undefined } | null = null;
  const failures = new Set<Store.MemoryHoldClass>();
  const publish = (connection: Client.HubConnection, holdClass: Store.MemoryHoldClass) =>
    connection.memorySpaceId === null
      ? Effect.void
      : PubSub.publish(events, {
          epoch: connection.epoch,
          memorySpaceId: connection.memorySpaceId,
          holdClass,
        });
  const observe = <A>(
    connection: Client.HubConnection,
    effect: Effect.Effect<A, Client.HubClientFailure>,
    authenticated = true,
  ) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(effect);
      const current = yield* settings.read;
      if (
        current.version === connection.epoch &&
        current.settings.mode === "member" &&
        current.settings.memorySpaceId === connection.memorySpaceId
      ) {
        if (epoch !== connection.epoch) {
          const previous = binding;
          failures.clear();
          descriptor = null;
          epoch = connection.epoch;
          binding = connection;
          if (previous !== null) {
            yield* publish(connection, "authorization");
            if (
              previous.memorySpaceId !== connection.memorySpaceId ||
              previous.hubEnvironmentId !== connection.hubEnvironmentId
            )
              yield* publish(connection, "identity");
            if (previous.endpoint !== connection.endpoint) yield* publish(connection, "protocol");
          }
        }
        if (result._tag === "Failure") {
          const error = result.failure;
          failures.add(
            error._tag !== "MemoryHubError" || error.code === "route_unavailable"
              ? "authorization"
              : error.code === "identity_mismatch" || error.code === "space_mismatch"
                ? "identity"
                : error.code === "unsupported_protocol" ||
                    error.code === "invalid_output" ||
                    error.code === "unsupported_operation"
                  ? "protocol"
                  : "availability",
          );
        } else {
          for (const holdClass of failures) {
            if (holdClass === "authorization" && !authenticated) continue;
            yield* publish(connection, holdClass);
            failures.delete(holdClass);
          }
        }
      }
      return result._tag === "Success" ? result.success : yield* result.failure;
    });
  const observed = Client.MemoryHubClient.of({
    ...client,
    preflight: (connection) =>
      observe(connection, client.preflight(connection), false).pipe(
        Effect.tap((next) =>
          Effect.gen(function* () {
            const current = yield* settings.read;
            if (current.version !== connection.epoch || epoch !== connection.epoch) return;
            if (descriptor !== null && descriptor.identity !== next.environmentId)
              yield* publish(connection, "identity");
            if (
              descriptor !== null &&
              descriptor.protocol !== next.capabilities.memoryHubProtocolVersion
            )
              yield* publish(connection, "protocol");
            descriptor = {
              identity: next.environmentId,
              protocol: next.capabilities.memoryHubProtocolVersion,
            };
          }),
        ),
      ),
    join: (c, i) => observe(c, client.join(c, i)),
    push: (c, i) => observe(c, client.push(c, i)),
    pull: (c, i) => observe(c, client.pull(c, i)),
    claim: (c, i) => observe(c, client.claim(c, i)),
    renew: (c, i) => observe(c, client.renew(c, i)),
    applyResolution: (c, i) => observe(c, client.applyResolution(c, i)),
    release: (c, i) => observe(c, client.release(c, i)),
    requestSourceRead: (c, i) => observe(c, client.requestSourceRead(c, i)),
    collectSourceReads: (c, i) => observe(c, client.collectSourceReads(c, i)),
    respondSourceRead: (c, i) => observe(c, client.respondSourceRead(c, i)),
    resultSourceRead: (c, i) => observe(c, client.resultSourceRead(c, i)),
  });
  const denied = Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" }));
  const unbound = Effect.fail(
    new Store.MemoryStorageError({
      stage: "bootstrap_required",
      cause: new M.MemoryHubError({ code: "bootstrap_required" }),
    }),
  );
  const runtime = Sync.MemorySyncRuntime.of({
    cwd: config.cwd,
    readIntentBinding: settings.read.pipe(
      Effect.map((view) => ({
        memorySpaceId: view.settings.mode === "disabled" ? null : view.settings.memorySpaceId,
        coordinatorEpoch: view.version,
        enabled: view.settings.mode !== "disabled",
      })),
    ),
    rearmEvents: Stream.fromPubSub(events).pipe(
      Stream.filterEffect((event) =>
        settings.read.pipe(
          Effect.map(
            (view) =>
              view.version === event.epoch &&
              view.settings.mode !== "disabled" &&
              view.settings.memorySpaceId === event.memorySpaceId,
          ),
        ),
      ),
      Stream.map(({ memorySpaceId, holdClass }) => ({ memorySpaceId, holdClass })),
    ),
    readBootstrap: (memorySpaceId, hubEnvironmentId) =>
      store.readBootstrap({ memorySpaceId, hubEnvironmentId }),
    discardBootstrap: (memorySpaceId, hubEnvironmentId, token) =>
      store.transact(
        Effect.gen(function* () {
          const progress = yield* store.readBootstrap({ memorySpaceId, hubEnvironmentId });
          if (
            progress.state !== "staging" ||
            progress.snapshotToken !== token ||
            progress.checkpointId === null
          )
            return;
          yield* store.discardBootstrapTx({
            memorySpaceId,
            hubEnvironmentId,
            expectedSnapshotToken: token,
            expectedCheckpointId: progress.checkpointId,
            expectedCheckpointSequence: progress.checkpointSequence,
          });
        }),
      ),
    readProcessing: (memorySpaceId, hubEnvironmentId) =>
      memorySpaceId === null || hubEnvironmentId === null
        ? unbound
        : store.readProcessing({ memorySpaceId, hubEnvironmentId }),
    readUnboundStorage: unbound,
    available: (selection) =>
      registry
        .getInstance(selection.instanceId)
        .pipe(
          Effect.flatMap((instance) =>
            instance === undefined || !instance.enabled
              ? Effect.fail(new M.MemoryHubError({ code: "route_unavailable" }))
              : instance.textGeneration.resolveMemoryConflict === undefined
                ? Effect.fail(new M.MemoryHubError({ code: "unsupported_operation" }))
                : Effect.void,
          ),
        ),
    // WP4 owns live same-owner delegated orchestration:read authority. A sync
    // credential cannot open transcripts. No reader is activated before that gate.
    ownerPermit: () => denied,
    ownerReader: { readCommitted: () => denied },
  });
  return Layer.mergeAll(
    Layer.succeed(Sync.MemorySyncRuntime, runtime),
    Layer.succeed(Client.MemoryHubClient, observed),
  );
});

/** The raw Client is constructed once; consumers receive only its observed boundary. */
export const layer = Layer.unwrap(make).pipe(Layer.provide(Client.layer));
