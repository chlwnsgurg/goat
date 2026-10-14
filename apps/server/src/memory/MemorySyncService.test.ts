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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
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
// Pending L1 read/discard ports are supplied by committed SQL only in this fixture.
const runtime = Layer.effect(
  Sync.MemorySyncRuntime,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return Sync.MemorySyncRuntime.of({
      cwd: "/tmp/memory-sync-fixture",
      available: () => Effect.void,
      ownerPermit: () => Effect.void,
      ownerReader: {
        readCommitted: () => Effect.succeed({ kind: "unavailable", code: "source_unavailable" }),
      },
      readBootstrap: (s, h) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            bootstrap_state: "unbound" | "staging" | "ready";
            checkpoint_id: string | null;
            snapshot_token: string | null;
            checkpoint_sequence: number;
            checkpoint_cursor: string | null;
          }>`SELECT * FROM memory_sync_cursors WHERE space=${s} AND hub_environment_id=${h}`;
          const row = rows[0];
          const pages = row?.checkpoint_id
            ? yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM memory_inbox_pending WHERE checkpoint_id=${row.checkpoint_id}`
            : [];
          return {
            state: row?.bootstrap_state ?? "unbound",
            checkpointId: row?.checkpoint_id ?? null,
            snapshotToken: row?.snapshot_token ?? null,
            checkpointSequence: row?.checkpoint_sequence ?? 0,
            cursor: row?.checkpoint_cursor ?? null,
            pageCount: pages[0]?.count ?? 0,
          };
        }).pipe(
          Effect.mapError(
            (cause) => new Store.MemoryStorageError({ stage: "fixture-bootstrap", cause }),
          ),
        ),
      discardBootstrap: (s, h) =>
        sql`DELETE FROM memory_sync_cursors WHERE space=${s} AND hub_environment_id=${h}`.pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new Store.MemoryStorageError({ stage: "fixture-discard", cause }),
          ),
        ),
      readProcessing: () =>
        Effect.fail(
          new Store.MemoryStorageError({
            stage: "fixture-status",
            cause: "status assembler is an L1 handoff",
          }),
        ),
    });
  }),
).pipe(Layer.provide(core));
const peer = (overrides: Partial<Client.MemoryHubClient["Service"]> = {}) =>
  Layer.mock(Client.MemoryHubClient)({
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
    claim: (_c, { protocolVersion: _protocolVersion, ...claim }) =>
      Effect.succeed({
        ...claim,
        fencingToken: 1,
        claimedAtHubTime: timestamp,
        expiresAtHubTime: "1970-01-01T00:02:00.000Z",
        attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
      }),
    release: () => Effect.succeed({ released: true }),
    ...overrides,
  });
const fixture = (
  client: Layer.Layer<Client.MemoryHubClient, never, Settings.ServerSettingsService> = peer(),
  generation = Layer.mock(Generation.TextGeneration)({ resolveMemoryConflict: () => Effect.never }),
  disabled = false,
) => {
  const shared = Layer.mergeAll(
    hub,
    runtime,
    identity,
    generation,
    Settings.layerTest({
      memoryHub: disabled ? { mode: "disabled" } : member,
      memoryHubVersion: 1,
      defaultModelSelection: selection,
    }),
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
const conflict = (n = 1) =>
  Effect.gen(function* () {
    const first = operation(n * 3, M.MemoryId.make(id(n + 2)));
    if (first.kind !== "upsert") throw new Error("fixture");
    yield* commit(first);
    for (const next of [
      operation(n * 3 + 1, first.memoryId),
      operation(n * 3 + 2, first.memoryId),
    ]) {
      if (next.kind !== "upsert") throw new Error("fixture");
      yield* commit({
        ...next,
        expectedHeads: [first.revision.revisionId],
        revision: { ...next.revision, parents: [first.revision.revisionId] },
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
      const model = Layer.mock(Generation.TextGeneration)({
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
        assert.strictEqual((yield* store.readDueClaimCandidates(100, 29999)).length, 0);
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
    const model = Layer.mock(Generation.TextGeneration)({
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

it.effect("four slots bound five durable conflicts", () =>
  Effect.gen(function* () {
    const allEntered = yield* Deferred.make<void>();
    let calls = 0;
    const model = Layer.mock(Generation.TextGeneration)({
      resolveMemoryConflict: () =>
        Effect.gen(function* () {
          calls++;
          if (calls === 4) yield* Deferred.succeed(allEntered, undefined);
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
      const model = Layer.mock(Generation.TextGeneration)({
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
          const tickets = yield* store.readRecoverableResolutionTickets({ now: 30000, limit: 100 });
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
      const model = Layer.mock(Generation.TextGeneration)({
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
