import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as ProviderRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import migration from "../persistence/Migrations/070_Memory.ts";
import hubMigration from "../persistence/Migrations/071_MemoryHubSync.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Client from "./MemoryHubClient.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Worker from "./MemoryWorker.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const local = M.EnvironmentId.make("fixture-member");
const remote = M.EnvironmentId.make("fixture-hub");
const selection = { instanceId: M.ProviderInstanceId.make("P"), model: "P" };
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStatus = Schema.decodeUnknownEffect(M.MemorySyncStatus);
const pushDecode = Schema.decodeUnknownSync(Schema.fromJsonString(M.MemoryHubPushInput));
const timestamp = "1970-01-01T00:00:00.000Z";
const member = {
  mode: "member" as const,
  memorySpaceId: space,
  hubEnvironmentId: remote,
  endpoint: M.MemoryHubEndpoint.make("https://fixture.invalid"),
  secretName: "memory-hub-fixture",
};
const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(local),
});
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
const core = Service.layer.pipe(
  Layer.provideMerge(quota),
  Layer.provide(identity),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
);
const hub = Hub.layer.pipe(
  Layer.provideMerge(core),
  Layer.provide(Hub.activityLayer),
  Layer.provide(Layer.succeed(Hub.MemoryHubConfiguration, { read: Effect.succeed(null) })),
);
// Real Store ports; the fixture Settings authority below is a SQL-free Ref.
const runtime = Layer.effect(
  Sync.MemorySyncRuntime,
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const settings = yield* Settings.ServerSettingsService;
    return Sync.MemorySyncRuntime.of({
      cwd: "/tmp/memory-sync-fixture",
      readIntentBinding: settings.getSettings.pipe(
        Effect.map((s) => ({
          memorySpaceId: s.memoryHub.mode === "disabled" ? null : s.memoryHub.memorySpaceId,
          coordinatorEpoch: s.memoryHubVersion,
          enabled: s.memoryHub.mode !== "disabled",
        })),
        Effect.mapError(() => new Service.MemoryAccessError({ code: "fenced" })),
      ),
      available: () => Effect.void,
      ownerPermit: () => Effect.void,
      ownerReader: {
        readCommitted: () => Effect.succeed({ kind: "unavailable", code: "source_unavailable" }),
      },
      readBootstrap: (s, h) => store.readBootstrap({ memorySpaceId: s, hubEnvironmentId: h }),
      discardBootstrap: (s, h, token) =>
        store.transact(
          Effect.gen(function* () {
            const progress = yield* store.readBootstrap({ memorySpaceId: s, hubEnvironmentId: h });
            if (progress.snapshotToken !== token || !progress.checkpointId) return;
            yield* store.discardBootstrapTx({
              memorySpaceId: s,
              hubEnvironmentId: h,
              expectedSnapshotToken: token,
              expectedCheckpointId: progress.checkpointId,
              expectedCheckpointSequence: progress.checkpointSequence,
            });
          }),
        ),
      readUnboundStorage: Effect.fail(
        new Store.MemoryStorageError({ stage: "fixture-unbound", cause: "L5 adapter pending" }),
      ),
      readProcessing: (s, h) =>
        s && h
          ? store.readProcessing({ memorySpaceId: s, hubEnvironmentId: h })
          : Effect.fail(
              new Store.MemoryStorageError({
                stage: "fixture-unbound",
                cause: "L1 nullable status port pending",
              }),
            ),
    });
  }),
).pipe(Layer.provide(core));
const peer = (overrides: Partial<Client.MemoryHubClient["Service"]> = {}) => {
  const issued = new Map<string, M.MemoryResolutionLease>();
  const defaultClaim: Client.MemoryHubClient["Service"]["claim"] = (
    _c,
    { protocolVersion: _protocol, ...claim },
  ) =>
    Effect.succeed({
      ...claim,
      fencingToken: 1,
      claimedAtHubTime: timestamp,
      expiresAtHubTime: "1970-01-01T00:02:00.000Z",
      attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
    });
  const claim = overrides.claim ?? defaultClaim;
  return Layer.mock(Client.MemoryHubClient)({
    pull: (_c, i) =>
      Effect.succeed({
        highWatermark: i.highWatermark ?? i.afterSequence,
        throughSequence: i.afterSequence,
        hasMore: false,
        entries: [],
      }),
    collectSourceReads: () => Effect.succeed({ requests: [] }),
    push: (_c, i) =>
      Effect.succeed({
        receipts: i.operations.map((operation, index) => ({
          operationId: operation.operationId,
          memoryId: operation.memoryId,
          operationDigest: memoryOperationDigest(operation),
          hubSequence: index + 1,
          outcome: "accepted" as const,
        })),
      }),
    release: () => Effect.succeed({ released: true }),
    ...overrides,
    claim: (c, i) =>
      claim(c, i).pipe(
        Effect.tap((ticket) =>
          Effect.sync(() => {
            issued.set(ticket.attemptId, ticket);
          }),
        ),
      ),
    renew:
      overrides.renew ??
      ((_c, i) => {
        const ticket = issued.get(i.attemptId);
        return ticket
          ? Effect.succeed(ticket)
          : Effect.fail(new M.MemoryHubError({ code: "lease_expired" }));
      }),
  });
};
const realGeneration = (overrides: Partial<Generation.TextGeneration["Service"]>) => {
  const provider = Generation.TextGeneration.of({
    generateCommitMessage: () => Effect.die("unexpected fixture operation"),
    generatePrContent: () => Effect.die("unexpected fixture operation"),
    generateBranchName: () => Effect.die("unexpected fixture operation"),
    generateThreadTitle: () => Effect.die("unexpected fixture operation"),
    generateReviewGuide: () => Effect.die("unexpected fixture operation"),
    ...overrides,
  });
  return Layer.effect(Generation.TextGeneration, Generation.make).pipe(
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderInstanceRegistry)({
        getInstance: (instanceId) =>
          Effect.succeed({
            instanceId,
            driverKind: M.ProviderDriverKind.make("codex"),
            continuationIdentity: {
              driverKind: M.ProviderDriverKind.make("codex"),
              continuationKey: "synthetic-provider",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {} as ProviderInstance["snapshot"],
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: provider,
          } satisfies ProviderInstance),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControl.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("memory resolution does not read source control"),
      }),
    ),
  );
};
// Preserve real settings CAS/normalization, adding the production-style subscribed stream.
const changingSettings = (disabled: boolean) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const base = yield* Settings.ServerSettingsService;
      const transitions = Option.getOrThrow(
        yield* Effect.serviceOption(Settings.MemoryHubSettingsTransitions),
      );
      const changes =
        yield* PubSub.bounded<
          Effect.Success<Settings.ServerSettingsService["Service"]["getSettings"]>
        >(16);
      const publish = base.getSettings.pipe(Effect.flatMap((s) => PubSub.publish(changes, s)));
      return Layer.mergeAll(
        Layer.succeed(Settings.ServerSettingsService, {
          ...base,
          subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          streamChanges: Stream.fromPubSub(changes),
          updateSettings: (patch) => base.updateSettings(patch).pipe(Effect.tap(() => publish)),
        }),
        Layer.succeed(Settings.MemoryHubSettingsTransitions, {
          applyMemoryHubTransition: (input, permit) =>
            transitions.applyMemoryHubTransition(input, permit).pipe(Effect.tap(() => publish)),
        }),
      );
    }).pipe(
      Effect.provide(
        Settings.layerTest({
          memoryHub: disabled ? { mode: "disabled" } : member,
          memoryHubVersion: 1,
          defaultModelSelection: selection,
        }),
      ),
    ),
  );
const fixture = (
  client: Layer.Layer<Client.MemoryHubClient, never, Settings.ServerSettingsService> = peer(),
  generation = realGeneration({ resolveMemoryConflict: () => Effect.never }),
  disabled = false,
  changing = false,
) => {
  const sharedSettings = changing
    ? changingSettings(disabled)
    : Settings.layerTest({
        memoryHub: disabled ? { mode: "disabled" } : member,
        memoryHubVersion: 1,
        defaultModelSelection: selection,
      });
  const shared = Layer.mergeAll(hub, runtime, identity, generation).pipe(
    Layer.provideMerge(sharedSettings),
  );
  return Sync.layer.pipe(Layer.provideMerge(client.pipe(Layer.provideMerge(shared))));
};
const ready = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},${remote},0,'ready')`;
});
const operation = (n: number, memory = M.MemoryId.make(id(2))): M.MemoryOperation => {
  const operationId = M.MemoryOperationId.make(id(n + 100));
  const revisionId = M.MemoryRevisionId.make(id(n + 200));
  return {
    protocolVersion: 1,
    operationId,
    memorySpaceId: space,
    memoryId: memory,
    originEnvironmentId: local,
    expectedHeads: [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      operationId,
      revisionId,
      payloadRef: revisionId,
      parents: [],
      scope: { kind: "user" },
      assertionKind: "inference",
      provenance: { environmentId: local },
      createdAtUtc: timestamp,
    },
    payload: { text: `synthetic fact ${n}`, evidence: [], derivedFromMemoryRevisions: [] },
  };
};
const commit = (op: M.MemoryOperation) =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    yield* store.apply(
      decideMemoryOperation(
        yield* store.loadAggregate(op.memorySpaceId, op.memoryId),
        op,
        Store.hubAdmission,
        { kind: "allowed" },
      ),
    );
  });
const conflict = (n = 1, targetSpace = space) =>
  Effect.gen(function* () {
    const original = operation(n * 3, M.MemoryId.make(id(n + 2)));
    if (original.kind !== "upsert") throw new Error("fixture");
    const first = {
      ...original,
      memorySpaceId: targetSpace,
      revision: { ...original.revision, memorySpaceId: targetSpace },
    };
    if (first.kind !== "upsert") throw new Error("fixture");
    yield* commit(first);
    for (const next of [
      operation(n * 3 + 1, first.memoryId),
      operation(n * 3 + 2, first.memoryId),
    ]) {
      if (next.kind !== "upsert") throw new Error("fixture");
      yield* commit({
        ...next,
        memorySpaceId: targetSpace,
        expectedHeads: [first.revision.revisionId],
        revision: {
          ...next.revision,
          memorySpaceId: targetSpace,
          parents: [first.revision.revisionId],
        },
      });
    }
    return first.memoryId;
  });
const tailEntries = (from: number, to: number): M.MemoryHubEntry[] =>
  Array.from({ length: to - from }, (_, index) => {
    const sequence = from + index + 1;
    const op = operation(sequence + 500, M.MemoryId.make(id(sequence + 500)));
    if (op.kind !== "upsert") throw new Error("fixture");
    const foreign = {
      ...op,
      originEnvironmentId: remote,
      revision: { ...op.revision, provenance: { environmentId: remote } },
    };
    return {
      kind: "operation",
      hubSequence: sequence,
      operation: foreign,
      receipt: {
        operationId: foreign.operationId,
        memoryId: foreign.memoryId,
        operationDigest: memoryOperationDigest(foreign),
        hubSequence: sequence,
        outcome: "accepted",
      },
    };
  });
const enqueue = (n: number) =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const op = operation(n);
    yield* commit(op);
    yield* store.enqueueWork({
      id: `sync:${n}`,
      space,
      memoryId: op.memoryId,
      kind: "sync",
      status: "pending",
      metadata: {
        protocolVersion: 1,
        kind: op.kind,
        operationId: op.operationId,
        memoryId: op.memoryId,
        memorySpaceId: op.memorySpaceId,
        originEnvironmentId: op.originEnvironmentId,
        expectedHeads: op.expectedHeads,
        ...(op.kind === "upsert" ? { revision: op.revision } : {}),
      },
      payloadRef: null,
      attempt: 0,
      nextAttemptAt: 0,
      claimedBy: null,
      claimedUntil: null,
    });
    return op;
  });

it.effect("disabled start and syncOnce perform no transport", () =>
  Effect.gen(function* () {
    const sync = yield* Sync.MemorySyncService;
    yield* sync.start;
    yield* sync.syncOnce;
    assert.deepStrictEqual(yield* sync.readLocalReadiness(), {
      memorySpaceId: null,
      bootstrap: "unbound",
    });
  }).pipe(Effect.provide(fixture(Layer.mock(Client.MemoryHubClient)({}), undefined, true))),
);

it.effect.each(["start", "syncOnce"] as const)(
  "%s automatically starts a frozen conflict without waiting for generation",
  (method) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<M.ResolveMemoryConflictInput>();
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Deferred.succeed(entered, input).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const memory = yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync[method];
          const input = yield* Deferred.await(entered);
          assert.strictEqual(input.memoryId, memory);
          assert.deepStrictEqual(input.modelSelection, selection);
          assert.strictEqual(yield* sync.activeResolutions, 1);
          yield* sync.shutdown;
          assert.strictEqual(yield* sync.activeResolutions, 0);
        }).pipe(Effect.provide(fixture(peer(), model))),
      );
    }),
);

it.effect("claim_busy persists backoff and TestClock releases a due candidate", () =>
  Effect.gen(function* () {
    let claims = 0;
    const entered = yield* Deferred.make<void>();
    const client = peer({
      claim: () =>
        Effect.sync(() => {
          claims++;
        }).pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "claim_busy" })))),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        const store = yield* Store.MemoryStore;
        yield* sync.syncOnce;
        assert.strictEqual(claims, 1);
        assert.strictEqual((yield* store.readDueClaimCandidates(100, 29999, space)).length, 0);
        yield* sync.syncOnce;
        assert.strictEqual(claims, 1);
        yield* TestClock.adjust("30 seconds");
        yield* sync.syncOnce;
        assert.strictEqual(claims, 2);
        yield* Deferred.succeed(entered, undefined);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect(
  "saved claim survives a lost response and a changed default across coordinator restart",
  () =>
    Effect.gen(function* () {
      const claims: M.MemoryHubClaimInput[] = [];
      const client = peer({
        claim: (_c, claim) =>
          Effect.sync(() => {
            claims.push(claim);
          }).pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "unavailable" })))),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* sync.shutdown;
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.updateSettings({
            defaultModelSelection: { instanceId: M.ProviderInstanceId.make("Q"), model: "Q" },
          });
          yield* TestClock.adjust("5 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          assert.strictEqual(claims.length, 2);
          assert.deepStrictEqual(claims[1], claims[0]);
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect("blocked generation leaves unrelated push and cursor movement free", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let pushes = 0;
    let phase = 0;
    const client = peer({
      push: (_c, i) =>
        Effect.sync(() => {
          pushes++;
        }).pipe(
          Effect.as({
            receipts: i.operations.map((op) => ({
              operationId: op.operationId,
              memoryId: op.memoryId,
              operationDigest: memoryOperationDigest(op),
              hubSequence: 1,
              outcome: "accepted" as const,
            })),
          }),
        ),
      pull: (_c, i) =>
        Effect.succeed({
          highWatermark: i.highWatermark ?? phase,
          throughSequence: phase,
          hasMore: false,
          entries: tailEntries(i.afterSequence, phase),
        }),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(entered);
        yield* enqueue(20);
        phase = 7;
        yield* sync.syncOnce;
        assert.strictEqual(pushes, 1);
        const store = yield* Store.MemoryStore;
        assert.strictEqual(yield* store.readCursor(space, remote), 7);
        assert.strictEqual(yield* sync.activeResolutions, 1);
        yield* sync.shutdown;
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

it.effect("four slots bound five conflicts and the fifth starts after finalization", () =>
  Effect.gen(function* () {
    const allEntered = yield* Deferred.make<void>();
    const finishFirst = yield* Deferred.make<void>();
    const fifthEntered = yield* Deferred.make<void>();
    let calls = 0;
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.gen(function* () {
          calls++;
          if (calls === 4) yield* Deferred.succeed(allEntered, undefined);
          if (calls === 5) yield* Deferred.succeed(fifthEntered, undefined);
          if (calls === 1) {
            yield* Deferred.await(finishFirst);
            return yield* new M.TextGenerationError({
              operation: "resolveMemoryConflict",
              detail: "generation_failed",
            });
          }
          return yield* Effect.never;
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        for (let n = 1; n <= 5; n++) yield* conflict(n);
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(allEntered);
        assert.strictEqual(calls, 4);
        assert.strictEqual(yield* sync.activeResolutions, 4);
        yield* sync.syncOnce;
        assert.strictEqual(calls, 4);
        yield* Deferred.succeed(finishFirst, undefined);
        yield* Deferred.await(fifthEntered);
        assert.strictEqual(calls, 5);
        assert.strictEqual(yield* sync.activeResolutions, 4);
        yield* sync.shutdown;
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(peer(), model))),
    );
  }),
);

it.effect("push failure stores retry and restart sends the identical operation", () =>
  Effect.gen(function* () {
    const sent: M.MemoryOperation[] = [];
    const client = peer({
      push: (_c, i) =>
        Effect.sync(() => {
          sent.push(i.operations[0]!);
        }).pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "unavailable" })))),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* enqueue(40);
        const sync = yield* Sync.MemorySyncService;
        const store = yield* Store.MemoryStore;
        yield* sync.syncOnce;
        assert.strictEqual(sent.length, 1);
        assert.strictEqual((yield* store.readEligibleOutbox(space, 999, 100)).length, 0);
        yield* sync.shutdown;
        yield* TestClock.adjust("1 second");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* Sync.MemorySyncService;
            yield* restarted.syncOnce;
          }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
        );
        assert.strictEqual(sent.length, 2);
        assert.deepStrictEqual(sent[1], sent[0]);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("fixed watermark and shared ten-page budget stop a perpetually growing tail", () =>
  Effect.gen(function* () {
    const requests: M.MemoryHubPullInput[] = [];
    const client = peer({
      pull: (_c, i) =>
        Effect.sync(() => {
          requests.push(i);
          return {
            highWatermark: i.highWatermark ?? 10000,
            throughSequence: i.afterSequence + 1,
            hasMore: true,
            entries: tailEntries(i.afterSequence, i.afterSequence + 1),
          };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        assert.strictEqual(requests.length, 10);
        assert.deepStrictEqual(
          requests.slice(1).map((r) => r.highWatermark),
          Array(9).fill(10000),
        );
        const store = yield* Store.MemoryStore;
        assert.strictEqual(yield* store.readCursor(space, remote), 10);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("epoch changes discard a delayed pull before cursor commit", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const client = peer({
      pull: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.as({ highWatermark: 7, throughSequence: 7, hasMore: false, entries: [] }),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const sync = yield* Sync.MemorySyncService;
        const pending = yield* Effect.result(sync.syncOnce).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const transitions = Option.getOrThrow(
          yield* Effect.serviceOption(Settings.MemoryHubSettingsTransitions),
        );
        yield* transitions.applyMemoryHubTransition(
          {
            requestId: M.MemoryOperationId.make(id(999)),
            expectedVersion: 1,
            settings: { mode: "disabled" },
          },
          Effect.void,
        );
        yield* Deferred.succeed(resume, undefined);
        assert.strictEqual((yield* Fiber.join(pending))._tag, "Failure");
        const store = yield* Store.MemoryStore;
        assert.strictEqual(yield* store.readCursor(space, remote), 0);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("real HubClient transmits bounded immutable work and settles ACK", () =>
  Effect.gen(function* () {
    const sent: M.MemoryHubPushInput[] = [];

    const fetch: typeof globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      let response: unknown;
      if (init?.method === "GET")
        response = {
          environmentId: remote,
          label: "fixture",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1",
          capabilities: { memoryHubProtocolVersion: 1 },
        };
      else if (path.endsWith("/push")) {
        const input = pushDecode(
          init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init?.body,
        );
        sent.push(input);
        response = {
          receipts: input.operations.map((o) => ({
            operationId: o.operationId,
            memoryId: o.memoryId,
            operationDigest: memoryOperationDigest(o),
            hubSequence: 1,
            outcome: "accepted",
          })),
        };
      } else if (path.endsWith("/collect")) response = { requests: [] };
      else response = { highWatermark: 0, throughSequence: 0, hasMore: false, entries: [] };
      return new Response(encode(response), { headers: { "content-type": "application/json" } });
    };
    const actualClient = Client.layer.pipe(
      Layer.provide(
        Layer.mock(Secrets.ServerSecretStore)({
          get: () => Effect.succeed(Option.some(new TextEncoder().encode("c".repeat(43)))),
        }),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const op = yield* enqueue(50);
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        assert.strictEqual(sent.length, 1);
        assert.deepStrictEqual(sent[0]?.operations, [op]);
        const store = yield* Store.MemoryStore;
        assert.strictEqual((yield* store.readWork("sync:50"))?.status, "completed");
      }).pipe(
        Effect.provide(fixture(actualClient)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );
  }),
);

it.effect(
  "uncertain resolution persists bytes and restart replays without a second generation",
  () =>
    Effect.gen(function* () {
      const submitted = yield* Deferred.make<void>();
      const replayed = yield* Deferred.make<void>();
      const submissions: M.MemoryHubApplyResolutionInput[] = [];
      let generated = 0;
      const client = peer({
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            submissions.push(input);
            yield* Deferred.succeed(submitted, undefined);
            if (submissions.length === 2) yield* Deferred.succeed(replayed, undefined);
            return yield* new M.MemoryHubError({ code: "unavailable" });
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.sync(() => {
            generated++;
            return {
              result: {
                text: "synthetic resolved fact",
                assertionKind: "inference" as const,
                evidence: [],
                judgment: "combine synthetic facts",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* Deferred.await(submitted);
          // shutdown waits for registered execution and its durable finalization.
          yield* sync.shutdown;
          const store = yield* Store.MemoryStore;
          const tickets = yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 30000,
            limit: 100,
          });
          assert.strictEqual(tickets.length, 1);
          assert.deepStrictEqual(tickets[0]?.submission, submissions[0]);
          assert.strictEqual(tickets[0]?.state, "submitting");
          yield* TestClock.adjust("30 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              // provider is never called for the durable submission on recovery.
              yield* Deferred.await(replayed);
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          assert.strictEqual(generated, 1);
          assert.strictEqual(submissions.length, 2);
          assert.deepStrictEqual(submissions[1], submissions[0]);
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect(
  "actual Worker joint start never claims resolve work while registry owns generation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let resolveClaims = 0;
      let generated = 0;
      const model = realGeneration({
        resolveMemoryConflict: () =>
          Effect.sync(() => {
            generated++;
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never),
          ),
      });
      const observedStorage = Layer.effect(
        Store.MemoryStore,
        Effect.map(Store.MemoryStore, (store) =>
          Store.MemoryStore.of({
            ...store,
            claimWork: (id, owner, now, until) => {
              if (id.startsWith("resolve:")) resolveClaims++;
              return store.claimWork(id, owner, now, until);
            },
          }),
        ),
      );
      const joint = Worker.layer.pipe(
        Layer.provideMerge(Maintenance.layer.pipe(Layer.provideMerge(core))),
        Layer.provideMerge(observedStorage.pipe(Layer.provideMerge(fixture(peer(), model)))),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.succeed(RuntimeIdentity.RuntimeIdentity, { instanceId: "synthetic-worker" }),
        ),
        Layer.provide(Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty })),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const worker = yield* Worker.MemoryWorker;
          yield* sync.start;
          yield* Deferred.await(entered);
          yield* worker.start();
          yield* worker.drain;
          const store = yield* Store.MemoryStore;
          assert.isFalse(
            (yield* store.dueWork(yield* Clock.currentTimeMillis, 100)).some(
              (work) => work.kind === "resolve",
            ),
          );
          assert.strictEqual(resolveClaims, 0);
          assert.strictEqual(generated, 1);
          yield* sync.shutdown;
        }).pipe(Effect.provide(joint)),
      );
    }),
);

it.effect("member checkpoint completes before pushing and supplies local replica identity", () =>
  Effect.gen(function* () {
    let pushed = 0;
    const client = peer({
      join: () =>
        Effect.succeed({
          protocolVersion: 1,
          memorySpaceId: space,
          hubEnvironmentId: remote,
          checkpointSequence: 0,
          retentionFloor: 0,
          snapshotToken: "fixture-token",
          causalBoundary: { checkpointSequence: 0, boundaryId: "fixture-boundary" },
        }),
      pull: (_c, input) =>
        Effect.succeed(
          input.snapshotToken
            ? {
                highWatermark: 0,
                throughSequence: 0,
                hasMore: false,
                entries: [],
                checkpoint: {
                  memorySpaceId: space,
                  checkpointSequence: 0,
                  retentionFloor: 0,
                  causalBoundary: { checkpointSequence: 0, boundaryId: "fixture-boundary" },
                  pageOrdinal: 0,
                  items: [],
                  revisions: [],
                  tombstones: [],
                  conflicts: [],
                  resolutions: [],
                  compactReceipts: [],
                  identities: [],
                  fences: [],
                  suppressions: [],
                  nextCursor: null,
                  bootstrapComplete: true,
                },
              }
            : { highWatermark: 0, throughSequence: 0, hasMore: false, entries: [] },
        ),
      push: () =>
        Effect.sync(() => {
          pushed++;
          return { receipts: [] };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sync = yield* Sync.MemorySyncService;
        assert.deepStrictEqual(yield* sync.readLocalReadiness(), {
          memorySpaceId: space,
          bootstrap: "unbound",
        });
        yield* sync.syncOnce;
        assert.deepStrictEqual(yield* sync.readLocalReadiness(), {
          memorySpaceId: space,
          bootstrap: "ready",
        });
        assert.strictEqual(pushed, 0);
        yield* sync.requireBootstrap(space);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("partial member checkpoint preserves token and keeps push blocked across restart", () =>
  Effect.gen(function* () {
    const requests: M.MemoryHubPullInput[] = [];
    let joins = 0;
    const client = peer({
      join: () =>
        Effect.sync(() => {
          joins++;
          return {
            protocolVersion: 1 as const,
            memorySpaceId: space,
            hubEnvironmentId: remote,
            checkpointSequence: 0,
            retentionFloor: 0,
            snapshotToken: "fixture-partial-token",
            causalBoundary: { checkpointSequence: 0, boundaryId: "fixture-boundary" },
          };
        }),
      pull: (_c, input) =>
        Effect.sync(() => {
          requests.push(input);
          const ordinal = input.cursor ? Number(input.cursor) : 0;
          return {
            highWatermark: 0,
            throughSequence: 0,
            hasMore: true,
            entries: [],
            checkpoint: {
              memorySpaceId: space,
              checkpointSequence: 0,
              retentionFloor: 0,
              causalBoundary: { checkpointSequence: 0, boundaryId: "fixture-boundary" },
              pageOrdinal: ordinal,
              items: [],
              revisions: [],
              tombstones: [],
              conflicts: [],
              resolutions: [],
              compactReceipts: [],
              identities: [
                {
                  memorySpaceId: space,
                  memoryId: M.MemoryId.make(id(ordinal + 800)),
                  scope: { kind: "user" as const },
                  creatingEnvironmentId: remote,
                  createOperationId: M.MemoryOperationId.make(id(ordinal + 900)),
                  createdAtUtc: timestamp,
                },
              ],
              fences: [],
              suppressions: [],
              nextCursor: String(ordinal + 1),
              bootstrapComplete: false,
            },
          };
        }),
      push: () => Effect.die("partial bootstrap must never push"),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        assert.strictEqual(requests.length, 10);
        assert.strictEqual((yield* sync.readLocalReadiness()).bootstrap, "staging");
        yield* sync.shutdown;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* Sync.MemorySyncService;
            yield* restarted.syncOnce;
          }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
        );
        assert.strictEqual(joins, 1);
        assert.strictEqual(requests.length, 20);
        assert.strictEqual(requests[10]?.cursor, "10");
        assert.isTrue(requests.every((r) => r.snapshotToken === "fixture-partial-token"));
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("one denied owner relay read leaves other responses and push moving", () =>
  Effect.gen(function* () {
    const requested = (n: number): M.MemorySourceReadRequest => ({
      requestId: M.MemorySourceReadRequestId.make(id(n)),
      memorySpaceId: space,
      memoryId: M.MemoryId.make(id(2)),
      requesterEnvironmentId: remote,
      sourceThread: { environmentId: local, threadId: M.ThreadId.make("synthetic-thread") },
      sourceWatermark: {
        fromEventId: M.EventId.make("e1"),
        toEventId: M.EventId.make("e2"),
        throughSequence: 2,
      },
      messageIds: [M.MessageId.make("synthetic-message")],
      limit: 10,
      authorizedScopes: ["memory:read", "orchestration:read"],
      expiresAtHubTime: "1970-01-01T00:01:15.000Z",
    });
    const responses: M.MemoryHubSourceReadRespondInput[] = [];
    let pushes = 0;
    const client = peer({
      collectSourceReads: () => Effect.succeed({ requests: [requested(801), requested(802)] }),
      respondSourceRead: (_c, input) =>
        Effect.sync(() => {
          responses.push(input);
          return { accepted: true };
        }),
      push: (_c, input) =>
        Effect.sync(() => {
          pushes++;
          return {
            receipts: input.operations.map((op) => ({
              operationId: op.operationId,
              memoryId: op.memoryId,
              operationDigest: memoryOperationDigest(op),
              hubSequence: 1,
              outcome: "accepted" as const,
            })),
          };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* enqueue(60);
        const base = yield* Sync.MemorySyncRuntime;
        const owner = Sync.MemorySyncRuntime.of({
          ...base,
          ownerPermit: (request) =>
            request.requestId === id(801)
              ? Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" }))
              : Effect.void,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            yield* sync.syncOnce;
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, owner)),
              ),
            ),
          ),
        );
        assert.strictEqual(pushes, 1);
        assert.deepStrictEqual(
          responses.map((r) => r.requestId),
          [id(802)],
        );
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect(
  "known approval survives a real canonical SQL failure and repairs without generation",
  () =>
    Effect.gen(function* () {
      const firstReleased = yield* Deferred.make<void>();
      const secondReleased = yield* Deferred.make<void>();
      let releases = 0;
      let generated = 0;
      let applied = 0;
      let submission: M.MemoryHubApplyResolutionInput | undefined;
      let database: SqlClient.SqlClient | undefined;
      const client = peer({
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            applied++;
            submission = input;
            if (!database) return yield* new M.MemoryHubError({ code: "storage_failed" });
            yield* database`CREATE TRIGGER fixture_canonical_failure BEFORE INSERT ON memory_revisions BEGIN SELECT RAISE(ABORT, 'fixture canonical unavailable'); END`.pipe(
              Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
            );
            if (input.operation.kind !== "resolve") throw new Error("fixture");
            return {
              operationId: input.operation.operationId,
              memoryId: input.operation.memoryId,
              operationDigest: memoryOperationDigest(input.operation),
              hubSequence: 1,
              outcome: "accepted" as const,
              resolutionApproval: {
                resolutionId: input.operation.resolution.resolutionId,
                appliedAtUtc: timestamp,
                revertDeadlineUtc: "1970-01-31T00:00:00.000Z",
              },
            };
          }),
        release: () =>
          Effect.gen(function* () {
            releases++;
            yield* Deferred.succeed(releases === 1 ? firstReleased : secondReleased, undefined);
            return { released: true };
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.sync(() => {
            generated++;
            return {
              result: {
                text: "synthetic approved fact",
                assertionKind: "inference" as const,
                evidence: [],
                judgment: "synthetic judgment",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          database = yield* SqlClient.SqlClient;
          const memory = yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* Deferred.await(firstReleased);
          yield* sync.shutdown;
          const store = yield* Store.MemoryStore;
          const saved = yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 30000,
            limit: 100,
          });
          assert.strictEqual(saved[0]?.approval?.outcome, "accepted");
          assert.strictEqual((yield* store.loadAggregate(space, memory)).heads.length, 2);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TRIGGER fixture_canonical_failure`;
          yield* TestClock.adjust("30 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              yield* Deferred.await(secondReleased);
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          assert.strictEqual(generated, 1);
          assert.strictEqual(applied, 1);
          const repaired = yield* store.loadAggregate(space, memory);
          assert.strictEqual(repaired.heads.length, 1);
          if (submission?.operation.kind !== "resolve") throw new Error("fixture");
          assert.deepStrictEqual(repaired.heads, [submission.operation.revision.revisionId]);
          assert.strictEqual((yield* store.pendingReports(10)).length, 1);
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect("disabling the epoch cancels a registered model immediately", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(entered);
        const transitions = Option.getOrThrow(
          yield* Effect.serviceOption(Settings.MemoryHubSettingsTransitions),
        );
        yield* transitions.applyMemoryHubTransition(
          {
            requestId: M.MemoryOperationId.make(id(998)),
            expectedVersion: 1,
            settings: { mode: "disabled" },
          },
          Effect.void,
        );
        yield* sync.syncOnce;
        yield* Deferred.await(cancelled);
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(peer(), model))),
    );
  }),
);

it.effect(
  "hub claim success before ticket SQL failure recovers the same lease with a null default",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<M.ResolveMemoryConflictInput>();
      const claims: M.MemoryHubClaimInput[] = [];
      let database: SqlClient.SqlClient | undefined;
      const client = peer({
        claim: (_c, input) =>
          Effect.gen(function* () {
            claims.push(input);
            if (!database) return yield* new M.MemoryHubError({ code: "storage_failed" });
            if (claims.length === 1)
              yield* database`CREATE TRIGGER fixture_ticket_failure BEFORE INSERT ON memory_outbox WHEN NEW.kind='resolve' BEGIN SELECT RAISE(ABORT, 'fixture ticket unavailable'); END`.pipe(
                Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
              );
            const { protocolVersion: _protocolVersion, ...claim } = input;
            return {
              ...claim,
              fencingToken: 41,
              claimedAtHubTime: timestamp,
              expiresAtHubTime: "1970-01-01T00:02:00.000Z",
              attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
            };
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Deferred.succeed(entered, input).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          database = yield* SqlClient.SqlClient;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          yield* sync.syncOnce;
          assert.strictEqual(
            (yield* store.readRecoverableResolutionTickets({
              memorySpaceId: space,
              now: 0,
              limit: 100,
            })).length,
            0,
          );
          assert.strictEqual(yield* sync.activeResolutions, 0);
          yield* sync.shutdown;
          yield* database`DROP TRIGGER fixture_ticket_failure`;
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.updateSettings({ defaultModelSelection: null });
          yield* TestClock.adjust("5 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              assert.deepStrictEqual((yield* Deferred.await(entered)).modelSelection, selection);
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          assert.strictEqual(claims.length, 2);
          assert.deepStrictEqual(claims[1], claims[0]);
          const tickets = yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 35000,
            limit: 100,
          });
          assert.strictEqual(tickets[0]?.ticket.fencingToken, 41);
          assert.strictEqual(tickets[0]?.ticket.attemptId, claims[0]?.attemptId);
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect("expired recovered lease never exposes input to the provider", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    let executions = 0;
    let renews = 0;
    const client = peer({
      renew: () =>
        Effect.sync(() => {
          renews++;
        }).pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "lease_expired" })))),
      release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: false })),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.sync(() => {
          executions++;
        }).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(released);
        yield* sync.shutdown;
        assert.strictEqual(renews, 1);
        assert.strictEqual(executions, 0);
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

const changeHub = (expectedVersion: number, settings: M.MemoryHubSettings) =>
  Effect.gen(function* () {
    const transitions = Option.getOrThrow(
      yield* Effect.serviceOption(Settings.MemoryHubSettingsTransitions),
    );
    yield* transitions.applyMemoryHubTransition(
      {
        requestId: M.MemoryOperationId.make(id(9000 + expectedVersion)),
        expectedVersion,
        settings,
      },
      Effect.void,
    );
  });

it.effect.each(["pull", "owner relay", "claim"] as const)(
  "settings listener interrupts blocked %s and the model before the next epoch cycle",
  (kind) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const modelCancelled = yield* Deferred.make<void>();
      const transportEntered = yield* Deferred.make<void>();
      const transportCancelled = yield* Deferred.make<void>();
      const oldResponse = yield* Deferred.make<void>();
      const newCycle = yield* Deferred.make<number>();
      const finishNew = yield* Deferred.make<void>();
      let phase = 0;
      let calls = 0;
      let sync: Sync.MemorySyncService["Service"] | undefined;
      const block = Deferred.succeed(transportEntered, undefined).pipe(
        Effect.andThen(Deferred.await(oldResponse)),
        Effect.ensuring(Deferred.succeed(transportCancelled, undefined)),
      );
      const empty = (i: M.MemoryHubPullInput): M.MemoryHubPullResult => ({
        highWatermark: i.highWatermark ?? i.afterSequence,
        throughSequence: i.afterSequence,
        hasMore: false,
        entries: [],
      });
      const client = peer({
        pull: (c, i) =>
          Effect.gen(function* () {
            if (c.epoch === 3) {
              yield* Deferred.succeed(newCycle, yield* sync!.activeResolutions);
              yield* Deferred.await(finishNew);
            }
            if (phase === 1 && kind === "pull") {
              yield* block;
              return {
                highWatermark: 1,
                throughSequence: 1,
                hasMore: false,
                entries: tailEntries(0, 1),
              };
            }
            return empty(i);
          }),
        collectSourceReads: () =>
          phase === 1 && kind === "owner relay"
            ? block.pipe(Effect.as({ requests: [] }))
            : Effect.succeed({ requests: [] }),
        claim: (_c, input) =>
          Effect.gen(function* () {
            if (kind === "claim" && input.memoryId === id(4)) {
              phase = 1;
              yield* block;
            }
            const { protocolVersion: _protocol, ...claim } = input;
            return {
              ...claim,
              fencingToken: 1,
              claimedAtHubTime: timestamp,
              expiresAtHubTime: "1970-01-01T00:02:00.000Z",
              attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
            };
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: () =>
          Effect.sync(() => {
            calls++;
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(modelCancelled, undefined)),
          ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          if (kind === "claim") yield* conflict(2);
          sync = yield* Sync.MemorySyncService;
          if (kind === "claim") yield* sync.start.pipe(Effect.forkScoped);
          else yield* sync.start;
          yield* Deferred.await(entered);
          phase = 1;
          const manual = yield* sync.syncOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(transportEntered);
          // Only the Settings stream triggers cancellation; no direct sync/shutdown call.
          yield* changeHub(1, { mode: "disabled" });
          yield* Deferred.await(transportCancelled);
          yield* Deferred.await(modelCancelled);
          yield* Fiber.join(manual);
          phase = 2;
          yield* changeHub(2, member);
          assert.strictEqual(yield* Deferred.await(newCycle), 0);
          yield* Deferred.succeed(oldResponse, undefined);
          const store = yield* Store.MemoryStore;
          assert.strictEqual(yield* store.readCursor(space, remote), 0);
          assert.strictEqual(calls, 1);
          assert.strictEqual(yield* sync.activeResolutions, 0);
          yield* Deferred.succeed(finishNew, undefined);
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client, model, false, true))),
      );
    }),
);

it.effect("periodic renewal failure preserves the renewed expiry retry floor", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    let renews = 0;
    let issued: M.MemoryResolutionLease | undefined;
    const client = peer({
      claim: (_c, { protocolVersion: _p, ...claim }) =>
        Effect.sync(() => {
          issued = {
            ...claim,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          };
          return issued;
        }),
      renew: () =>
        Effect.gen(function* () {
          renews++;
          if (renews === 1) return { ...issued!, expiresAtHubTime: "1970-01-01T00:03:00.000Z" };
          return yield* new M.MemoryHubError({ code: "unavailable" });
        }),
      release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: false })),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(entered);
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(cancelled);
        yield* Deferred.await(released);
        yield* sync.shutdown;
        const tickets = yield* (yield* Store.MemoryStore).readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 180000,
          limit: 100,
        });
        assert.strictEqual(renews, 2);
        assert.strictEqual(tickets[0]?.nextAttemptAt, 180000);
        assert.strictEqual(tickets[0]?.ticket.expiresAtHubTime, "1970-01-01T00:03:00.000Z");
        const reopened = yield* Effect.service(Store.MemoryStore).pipe(Effect.provide(Store.layer));
        const recovered = yield* reopened.readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 180000,
          limit: 100,
        });
        assert.strictEqual(recovered[0]?.ticket.expiresAtHubTime, "1970-01-01T00:03:00.000Z");
        assert.strictEqual(
          (yield* reopened.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 179999,
            limit: 100,
          })).length,
          0,
        );
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

const sourceFixture = Effect.gen(function* () {
  const sourceThread = { environmentId: local, threadId: M.ThreadId.make("deadline-thread") };
  const watermark = {
    fromEventId: M.EventId.make("from"),
    toEventId: M.EventId.make("to"),
    throughSequence: 2,
  };
  const messageIds = [M.MessageId.make("completed-message")];
  const base = operation(8000);
  if (base.kind !== "upsert") throw new Error("fixture");
  const op = {
    ...base,
    revision: {
      ...base.revision,
      provenance: { environmentId: local, sourceThread, sourceWatermark: watermark },
    },
    payload: {
      text: "synthetic linked summary",
      evidence: [{ origin: "thread" as const, sourceThread, watermark, messageIds }],
      derivedFromMemoryRevisions: [],
    },
  };
  const store = yield* Store.MemoryStore;
  yield* store.apply(
    decideMemoryOperation(yield* store.loadAggregate(space, op.memoryId), op, Store.localIntent, {
      kind: "allowed",
    }),
  );
  return yield* (yield* Service.MemoryService).prepareSourceRead(
    { memorySpaceId: space, memoryId: op.memoryId, sourceThread, messageIds, limit: 10 },
    Effect.void,
  );
});

it.effect.each(["owner permit", "owner read"] as const)(
  "requester absolute deadline interrupts %s crossing the persisted 75s expiry",
  (boundary) =>
    Effect.gen(function* () {
      const firstResult = yield* Deferred.make<void>();
      const resumeResult = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      let requested: M.MemorySourceReadRequest | undefined;
      let collects = 0;
      let responses = 0;
      const client = peer({
        requestSourceRead: (_c, { protocolVersion: _p, ...input }) =>
          Effect.sync(() => {
            requested = {
              ...input,
              requesterEnvironmentId: local,
              expiresAtHubTime: "1970-01-01T00:01:15.000Z",
            };
            return { request: requested };
          }),
        collectSourceReads: () =>
          Effect.sync(() => ({ requests: ++collects === 1 ? [] : [requested!] })),
        resultSourceRead: () =>
          Deferred.succeed(firstResult, undefined).pipe(
            Effect.andThen(Deferred.await(resumeResult)),
            Effect.as({ state: "pending", expiresAtHubTime: "1970-01-01T00:01:15.000Z" } as const),
          ),
        respondSourceRead: () =>
          Effect.sync(() => {
            responses++;
            return { accepted: true };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const validated = yield* sourceFixture;
          const base = yield* Sync.MemorySyncRuntime;
          const blocked = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cancelled, undefined)),
          );
          const owner = Sync.MemorySyncRuntime.of({
            ...base,
            ownerPermit: () => (boundary === "owner permit" ? blocked : Effect.void),
            ownerReader: { readCommitted: () => blocked },
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              const read = yield* sync.readSource(validated, Effect.void).pipe(Effect.forkScoped);
              yield* Deferred.await(firstResult);
              yield* TestClock.adjust("70 seconds");
              yield* Deferred.succeed(resumeResult, undefined);
              yield* TestClock.adjust("1 second");
              yield* Deferred.await(entered);
              yield* TestClock.adjust("4 seconds");
              assert.deepStrictEqual(yield* Fiber.join(read), {
                kind: "unavailable",
                code: "source_unavailable",
              });
              yield* Deferred.await(cancelled);
              assert.strictEqual(yield* Clock.currentTimeMillis, 75000);
              assert.strictEqual(responses, 0);
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, owner)),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect("requester deadline includes the initial requester permit", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    let requests = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const validated = yield* sourceFixture;
        const sync = yield* Sync.MemorySyncService;
        const permit = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        );
        const read = yield* sync.readSource(validated, permit).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("75 seconds");
        assert.deepStrictEqual(yield* Fiber.join(read), {
          kind: "unavailable",
          code: "source_unavailable",
        });
        yield* Deferred.await(cancelled);
        assert.strictEqual(requests, 0);
      }).pipe(
        Effect.provide(
          fixture(
            peer({
              requestSourceRead: () =>
                Effect.sync(() => {
                  requests++;
                }).pipe(Effect.andThen(Effect.never)),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("a fenced relay cannot assign an old-space local intent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      const store = yield* Store.MemoryStore;
      yield* store.putLocalIntent({
        intentId: "epoch-intent",
        memoryId: M.MemoryId.make(id(8800)),
        environmentId: local,
        scope: { kind: "user" },
        provenance: { environmentId: local },
        assertionKind: "inference",
        createdAtUtc: timestamp,
        payload: { text: "synthetic unsent fact", evidence: [], derivedFromMemoryRevisions: [] },
      });
      const sync = yield* Sync.MemorySyncService;
      const result = yield* Effect.result(sync.syncOnce);
      assert.strictEqual(result._tag, "Failure");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        mapping: string | null;
      }>`SELECT json_extract(metadata_json,'$.mapping') AS mapping FROM memory_outbox WHERE id=${`local:${local}:epoch-intent`}`;
      assert.strictEqual(rows[0]?.mapping, null);
      assert.strictEqual(yield* store.readCursor(space, remote), 0);
    }).pipe(
      Effect.provide(
        fixture(
          peer({
            collectSourceReads: () =>
              changeHub(1, { mode: "disabled" }).pipe(
                Effect.mapError(() => new M.MemoryHubError({ code: "fenced" })),
                Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "fenced" }))),
              ),
          }),
        ),
      ),
    ),
  ),
);

it.effect("recovered attempt uses only the remaining fixed 600s cap", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    let ticket: M.MemoryResolutionLease | undefined;
    const client = peer({
      claim: (_c, { protocolVersion: _p, ...claim }) =>
        Effect.sync(() => {
          ticket = {
            ...claim,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:10:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          };
          return ticket;
        }),
      renew: () => Effect.succeed(ticket!),
      release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: true })),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        yield* TestClock.adjust("550 seconds");
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(entered);
        yield* TestClock.adjust("49 seconds");
        assert.isTrue(Option.isNone(yield* Deferred.poll(cancelled)));
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(cancelled);
        yield* Deferred.await(released);
        assert.strictEqual(yield* Clock.currentTimeMillis, 600000);
        yield* sync.shutdown;
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

// Empty fixture snapshot is explicit. Production counter-backed reads belong to L1/L5.
const emptyProcessing: M.MemoryProcessingStatus = {
  lastReceivedHubSequence: 0,
  receiveLag: null,
  deferred: 0,
  oldestDeferredAtUtc: null,
  unindexedItems: 0,
  scannerHeldItems: 0,
  scannerPendingItems: 0,
  missingParentItems: 0,
  pendingCleanupItems: 0,
  reportBacklog: 0,
  reportFailed: 0,
  hubAdmissionFailures: 0,
  indexCoverage: {
    status: "available",
    eligibleItems: 0,
    indexedItems: 0,
    unindexedItems: 0,
    projectionWatermark: 0,
  },
};
const statusRuntime = Effect.gen(function* () {
  const base = yield* Sync.MemorySyncRuntime;
  const quota = yield* Quota.MemoryQuotaService;
  return Sync.MemorySyncRuntime.of({
    ...base,
    readProcessing: () =>
      Effect.succeed({ processing: emptyProcessing, pendingSync: 0, quarantined: 0, parked: 0 }),
    readUnboundStorage: quota.readStorageStatus({ memorySpaceId: space, environmentId: local }),
  });
});

it.effect("status selects disabled and bootstrapping without requiring a bound route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* statusRuntime;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          const status = () =>
            sync.syncStatus({}, Effect.void).pipe(Effect.tap((s) => decodeStatus(s)));
          assert.strictEqual((yield* status()).state, "disabled");
          yield* changeHub(1, { ...member, memorySpaceId: null });
          const unbound = yield* status();
          assert.strictEqual(unbound.state, "bootstrapping");
          assert.strictEqual(unbound.memorySpaceId, null);
          yield* changeHub(2, member);
          assert.strictEqual((yield* status()).state, "bootstrapping");
          yield* ready;
          yield* sync.syncOnce;
          assert.strictEqual((yield* status()).state, "online");
          assert.strictEqual((yield* status()).lastSuccessfulSyncAtUtc, timestamp);
          yield* changeHub(3, { mode: "disabled" });
          const disabled = yield* status();
          assert.strictEqual(disabled.state, "disabled");
          assert.strictEqual(disabled.lastSuccessfulSyncAtUtc, null);
          assert.strictEqual(disabled.failureCode, undefined);
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(fixture(peer(), undefined, true))),
  ),
);

it.effect(
  "late old-epoch failure cannot contaminate new status and a status read is epoch fenced",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const statusEntered = yield* Deferred.make<void>();
      const statusResume = yield* Deferred.make<void>();
      let blockStatus = false;
      let failPull = false;
      const client = peer({
        pull: (_c, i) =>
          failPull
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "unavailable" }))),
              )
            : Effect.succeed({
                highWatermark: i.afterSequence,
                throughSequence: i.afterSequence,
                hasMore: false,
                entries: [],
              }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const base = yield* statusRuntime;
          const adapter = Sync.MemorySyncRuntime.of({
            ...base,
            readProcessing: (s, h) =>
              blockStatus
                ? Deferred.succeed(statusEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(statusResume)),
                    Effect.andThen(base.readProcessing(s, h)),
                  )
                : base.readProcessing(s, h),
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              yield* sync.syncOnce;
              failPull = true;
              const old = yield* Effect.result(sync.syncOnce).pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* changeHub(1, { mode: "disabled" });
              yield* Deferred.succeed(resume, undefined);
              assert.strictEqual((yield* Fiber.join(old))._tag, "Failure");
              const fresh = yield* sync.syncStatus({}, Effect.void);
              assert.strictEqual(fresh.state, "disabled");
              assert.strictEqual(fresh.failureCode, undefined);
              assert.strictEqual(fresh.lastSuccessfulSyncAtUtc, null);
              blockStatus = true;
              const stale = yield* Effect.result(sync.syncStatus({}, Effect.void)).pipe(
                Effect.forkScoped,
              );
              yield* Deferred.await(statusEntered);
              yield* changeHub(2, member);
              yield* Deferred.succeed(statusResume, undefined);
              const result = yield* Fiber.join(stale);
              assert.strictEqual(result._tag, "Failure");
              if (result._tag === "Failure")
                assert.deepStrictEqual(result.failure, new M.MemoryHubError({ code: "fenced" }));
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect("settings cancels local-hub pull without an HTTP timeout", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const next = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${local},${"a".repeat(64)},1,'active')`;
        yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},${local},0,'ready')`;
        yield* changeHub(1, { mode: "hub", memorySpaceId: space });
        const actual = yield* Hub.MemoryHubService;
        const localHub = Hub.MemoryHubService.of({
          ...actual,
          pull: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(interrupted, undefined)),
            ),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            const start = yield* sync.start.pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            yield* changeHub(2, { mode: "disabled" });
            yield* Deferred.await(interrupted);
            yield* Fiber.join(start);
            assert.strictEqual(yield* sync.activeResolutions, 0);
            assert.strictEqual(yield* (yield* Store.MemoryStore).readCursor(space, local), 0);
            yield* ready;
            yield* changeHub(3, member);
            yield* Deferred.await(next);
            yield* sync.shutdown;
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Hub.MemoryHubService, localHub)),
              ),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          fixture(
            peer({
              pull: (_c, i) =>
                Deferred.succeed(next, undefined).pipe(
                  Effect.as({
                    highWatermark: i.afterSequence,
                    throughSequence: i.afterSequence,
                    hasMore: false,
                    entries: [],
                  }),
                ),
            }),
            undefined,
            false,
            true,
          ),
        ),
      ),
    );
  }),
);

it.effect("settings finalization bounds a blocked matching release before freeing the slot", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const releaseEntered = yield* Deferred.make<void>();
    const releaseInterrupted = yield* Deferred.make<void>();
    const next = yield* Deferred.make<number>();
    let sync: Sync.MemorySyncService["Service"] | undefined;
    const client = peer({
      release: () =>
        Deferred.succeed(releaseEntered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(releaseInterrupted, undefined)),
        ),
      pull: (c, i) =>
        Effect.gen(function* () {
          if (c.epoch === 3) yield* Deferred.succeed(next, yield* sync!.activeResolutions);
          return {
            highWatermark: i.afterSequence,
            throughSequence: i.afterSequence,
            hasMore: false,
            entries: [],
          };
        }),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        sync = yield* Sync.MemorySyncService;
        yield* sync.start;
        yield* Deferred.await(entered);
        yield* changeHub(1, { mode: "disabled" });
        yield* Deferred.await(releaseEntered);
        assert.strictEqual(yield* sync.activeResolutions, 1);
        yield* TestClock.adjust("15 seconds");
        yield* Deferred.await(releaseInterrupted);
        yield* changeHub(2, member);
        assert.strictEqual(yield* Deferred.await(next), 0);
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(client, model, false, true))),
    );
  }),
);

it.effect("current space enters generation behind 100 old-space candidates and tickets", () =>
  Effect.gen(function* () {
    const oldSpace = M.MemorySpaceId.make(id(9900));
    const entered = yield* Deferred.make<M.ResolveMemoryConflictInput>();
    const model = realGeneration({
      resolveMemoryConflict: (i) => Deferred.succeed(entered, i).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const store = yield* Store.MemoryStore;
        for (let n = 1; n <= 100; n++) {
          const memoryId = yield* conflict(n, oldSpace);
          const snapshot = yield* store.readResolutionSnapshot(oldSpace, memoryId);
          yield* store.persistResolutionTicket({
            memorySpaceId: oldSpace,
            memoryId,
            conflictId: M.MemoryConflictId.make(id(10000 + n)),
            holderEnvironmentId: local,
            attemptId: M.MemoryOperationId.make(id(11000 + n)),
            conflictHeadSet: snapshot.heads,
            frozenDefaultModelSelection: selection,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          });
        }
        yield* store.recoverClaimCandidates(0);
        const memory = yield* conflict(101);
        yield* store.recoverClaimCandidates(0);
        assert.strictEqual((yield* store.readDueClaimCandidates(100, 0, oldSpace)).length, 100);
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        assert.strictEqual((yield* Deferred.await(entered)).memoryId, memory);
        assert.strictEqual(
          (yield* store.readRecoverableResolutionTickets({
            memorySpaceId: oldSpace,
            now: 0,
            limit: 100,
          })).length,
          100,
        );
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(peer(), model))),
    );
  }),
);

it.effect("recovery discovers a new conflict while an unrelated ticket is running", () =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    let executions = 0;
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.gen(function* () {
          executions++;
          yield* Deferred.succeed(executions === 1 ? first : second, undefined);
          return yield* Effect.never;
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(first);
        yield* conflict(2);
        yield* sync.syncOnce;
        yield* Deferred.await(second);
        assert.strictEqual(yield* sync.activeResolutions, 2);
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(peer(), model))),
    );
  }),
);

it.effect.each([0, 80])("eligibility uses bounded ports with %s historical revisions", (history) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const renewed = yield* Deferred.make<void>();
    let renews = 0;
    let issued: M.MemoryResolutionLease | undefined;
    const client = peer({
      claim: (_c, { protocolVersion: _p, ...claim }) =>
        Effect.sync(() => {
          issued = {
            ...claim,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          };
          return issued;
        }),
      renew: () =>
        Effect.gen(function* () {
          renews++;
          const ticket = issued!;
          if (renews === 2) yield* Deferred.succeed(renewed, undefined);
          return ticket;
        }),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const store = yield* Store.MemoryStore;
        const memory = M.MemoryId.make(id(28000));
        let parent: M.MemoryRevisionId | undefined;
        for (let n = 0; n <= history; n++) {
          const op = operation(29000 + n, memory);
          if (op.kind !== "upsert") throw new Error("fixture");
          yield* commit({
            ...op,
            expectedHeads: parent ? [parent] : [],
            revision: { ...op.revision, parents: parent ? [parent] : [] },
          });
          parent = op.revision.revisionId;
        }
        for (let n = 0; n < 2; n++) {
          const op = operation(30000 + n, memory);
          if (op.kind !== "upsert") throw new Error("fixture");
          yield* commit({
            ...op,
            expectedHeads: [parent!],
            revision: { ...op.revision, parents: [parent!] },
          });
        }
        let aggregates = 0;
        let snapshots = 0;
        let heads = 0;
        const observed = Store.MemoryStore.of({
          ...store,
          loadAggregate: (...args) => {
            aggregates++;
            return store.loadAggregate(...args);
          },
          readResolutionSnapshot: (...args) => {
            snapshots++;
            return store.readResolutionSnapshot(...args);
          },
          readResolutionHeads: (input) => {
            heads++;
            return store.readResolutionHeads(input);
          },
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            yield* sync.syncOnce;
            yield* Deferred.await(entered);
            assert.strictEqual(heads, 1);
            const before = snapshots;
            yield* TestClock.adjust("30 seconds");
            yield* Deferred.await(renewed);
            yield* sync.syncOnce;
            assert.strictEqual(aggregates, 0);
            assert.strictEqual(heads, 1);
            assert.strictEqual(snapshots - before, 2);
            yield* sync.shutdown;
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Store.MemoryStore, observed)),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

it.effect(
  "published bootstrap commits 100 exact intents then advances and replays identical retry",
  () =>
    Effect.gen(function* () {
      let observedStore: Store.MemoryStore["Service"] | undefined;
      const sent: M.MemoryOperation[] = [];
      let failed = false;
      let nextSequence = 2;
      const client = peer({
        join: () =>
          Effect.succeed({
            protocolVersion: 1,
            memorySpaceId: space,
            hubEnvironmentId: remote,
            checkpointSequence: 0,
            retentionFloor: 0,
            snapshotToken: "intent-snapshot",
            causalBoundary: { checkpointSequence: 0, boundaryId: "intent-boundary" },
          }),
        pull: (_c, input) =>
          Effect.succeed(
            input.snapshotToken
              ? {
                  highWatermark: 0,
                  throughSequence: 0,
                  hasMore: false,
                  entries: [],
                  checkpoint: {
                    memorySpaceId: space,
                    checkpointSequence: 0,
                    retentionFloor: 0,
                    causalBoundary: { checkpointSequence: 0, boundaryId: "intent-boundary" },
                    pageOrdinal: 0,
                    items: [],
                    revisions: [],
                    tombstones: [],
                    conflicts: [],
                    resolutions: [],
                    compactReceipts: [],
                    identities: [],
                    fences: [],
                    suppressions: [],
                    nextCursor: null,
                    bootstrapComplete: true,
                  },
                }
              : {
                  highWatermark: Math.max(1, input.afterSequence),
                  throughSequence: Math.max(1, input.afterSequence),
                  hasMore: false,
                  entries: input.afterSequence === 0 ? tailEntries(0, 1) : [],
                },
          ),
        push: (_c, input) =>
          Effect.gen(function* () {
            assert.isAtLeast(yield* observedStore!.readCursor(space, remote).pipe(Effect.orDie), 1);
            sent.push(...input.operations);
            if (!failed) {
              failed = true;
              return yield* new M.MemoryHubError({ code: "unavailable" });
            }
            return {
              receipts: input.operations.map((op) => ({
                operationId: op.operationId,
                memoryId: op.memoryId,
                operationDigest: memoryOperationDigest(op),
                hubSequence: nextSequence++,
                outcome: "accepted" as const,
              })),
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store.MemoryStore;
          observedStore = store;
          for (let n = 0; n < 101; n++)
            yield* store.putLocalIntent({
              intentId: `exact-${String(n).padStart(3, "0")}`,
              memoryId: M.MemoryId.make(id(31000 + n)),
              environmentId: local,
              scope: { kind: "user" },
              provenance: { environmentId: local },
              assertionKind: "inference",
              createdAtUtc: timestamp,
              payload: {
                text: `synthetic local ${n}`,
                evidence: [],
                derivedFromMemoryRevisions: [],
              },
            });
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          assert.strictEqual((yield* store.listMaterializableIntents(local, 100)).length, 1);
          assert.strictEqual(sent.length, 100);
          yield* sync.syncOnce;
          assert.strictEqual((yield* store.listMaterializableIntents(local, 100)).length, 0);
          assert.strictEqual(sent.length, 101);
          yield* TestClock.adjust("1 second");
          yield* sync.syncOnce;
          assert.strictEqual(sent.length, 102);
          assert.deepStrictEqual(sent[101], sent[0]);
          assert.strictEqual(memoryOperationDigest(sent[101]!), memoryOperationDigest(sent[0]!));
          assert.strictEqual(
            (yield* store.readOperation(space, sent[0]!.operationId))?.operationId,
            sent[0]!.operationId,
          );
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect("intent binding is rechecked inside commit and rejects a changed space", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      const store = yield* Store.MemoryStore;
      yield* store.putLocalIntent({
        intentId: "space-fence",
        memoryId: M.MemoryId.make(id(32000)),
        environmentId: local,
        scope: { kind: "user" },
        provenance: { environmentId: local },
        assertionKind: "inference",
        createdAtUtc: timestamp,
        payload: { text: "synthetic fenced", evidence: [], derivedFromMemoryRevisions: [] },
      });
      const base = yield* Sync.MemorySyncRuntime;
      const adapter = Sync.MemorySyncRuntime.of({
        ...base,
        readIntentBinding: Effect.succeed({
          memorySpaceId: M.MemorySpaceId.make(id(32001)),
          coordinatorEpoch: 1,
          enabled: true,
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          const result = yield* Effect.result(sync.syncOnce);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure" && "code" in result.failure)
            assert.strictEqual(result.failure.code, "fenced");
          assert.strictEqual((yield* store.listMaterializableIntents(local, 100)).length, 1);
          assert.strictEqual((yield* store.readEligibleOutbox(space, 0, 100)).length, 0);
          yield* sync.shutdown;
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(fixture())),
  ),
);

it.effect("ticketless definitive refusal rotates the frozen attempt but uncertainty does not", () =>
  Effect.gen(function* () {
    const claims: M.MemoryHubClaimInput[] = [];
    let code: M.MemoryFailureCode = "conflict_changed";
    const client = peer({
      claim: (_c, input) =>
        Effect.sync(() => {
          claims.push(input);
        }).pipe(Effect.andThen(Effect.suspend(() => Effect.fail(new M.MemoryHubError({ code }))))),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        code = "unavailable";
        yield* TestClock.adjust("30 seconds");
        yield* sync.syncOnce;
        assert.strictEqual(claims.length, 2);
        assert.notStrictEqual(claims[1]!.attemptId, claims[0]!.attemptId);
        yield* TestClock.adjust("30 seconds");
        yield* sync.syncOnce;
        assert.strictEqual(claims.length, 3);
        assert.deepStrictEqual(claims[2], claims[1]);
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect.each(["rejected", "uncertain"] as const)(
  "%s apply preserves its retirement contract and new-conflict discovery",
  (outcome) =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      let generations = 0;
      let submitted: M.MemoryHubApplyResolutionInput | undefined;
      const client = peer({
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            submitted = input;
            if (outcome === "uncertain")
              return yield* new M.MemoryHubError({ code: "unavailable" });
            return {
              operationId: input.operation.operationId,
              memoryId: input.operation.memoryId,
              operationDigest: memoryOperationDigest(input.operation),
              hubSequence: null,
              outcome: "rejected" as const,
              failureCode: "conflict_changed" as const,
            };
          }),
        release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: true })),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.gen(function* () {
            generations++;
            if (generations === 2) {
              yield* Deferred.succeed(second, undefined);
              return yield* Effect.never;
            }
            return {
              result: {
                text: "synthetic resolution",
                evidence: [],
                assertionKind: "inference" as const,
                judgment: "synthetic judgment",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          yield* sync.syncOnce;
          yield* Deferred.await(released);
          yield* sync.shutdown;
          const saved = yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 0,
            limit: 100,
          });
          if (outcome === "rejected") {
            assert.strictEqual(saved.length, 0);
            assert.isNull(
              yield* store.findClaimCandidate({
                memorySpaceId: space,
                attemptId: submitted!.attemptId,
              }),
            );
          } else {
            assert.deepStrictEqual(saved[0]?.submission, submitted);
            assert.isNotNull(
              yield* store.findClaimCandidate({
                memorySpaceId: space,
                attemptId: submitted!.attemptId,
              }),
            );
          }
          const other = yield* conflict(2);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              yield* Deferred.await(second);
              assert.strictEqual(generations, 2);
              assert.strictEqual(
                (yield* store.readResolutionSnapshot(space, other)).status,
                "quarantined",
              );
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);
