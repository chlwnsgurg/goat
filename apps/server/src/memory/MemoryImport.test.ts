import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Worker from "./MemoryWorker.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/070_Memory.ts";
import hubMigration from "../persistence/Migrations/071_MemoryHubSync.ts";
import searchMigration from "../persistence/Migrations/072_MemorySearchCounters.ts";
import lineageMigration from "../persistence/Migrations/074_MemoryImportLineage.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Schema from "effect/Schema";
import type {
  ImportRegistration,
  PreparedImportCommit,
  ImportItem,
} from "./imports/MemoryImportTypes.ts";
import * as Store from "./MemoryStore.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(uuid(1));
const memoryId = M.MemoryId.make(uuid(2));
const environmentId = M.EnvironmentId.make("synthetic-import");
const database = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(searchMigration),
    Effect.andThen(lineageMigration),
  ),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const live = Store.layer.pipe(Layer.provideMerge(database));
const record = (n: number): M.MemoryImportLineageRecord => ({
  memorySpaceId: space,
  memoryId,
  kind: "sourceKey",
  sourceKey: {
    environmentId,
    sourceId: M.MemoryImportSourceId.make(uuid(3)),
    sourceItemKey: `synthetic-${n}`,
  },
});
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys)
    VALUES (${space},${memoryId},'{}','{}',20000,0)`;
});
const inventory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    counters: yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
    identity: yield* sql`SELECT * FROM memory_identity_ledger`,
    lineage: yield* sql`SELECT * FROM memory_import_lineage ORDER BY space,memory_id,kind,key`,
  };
});
describe("MemoryImport lifetime lineage", () => {
  it.effect("admits equality, refuses +1 atomically and preserves duplicate noop at capacity", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      yield* store.transact(
        store.unionImportLineageTx(
          Array.from({ length: 1000 }, (_, n) => record(n)),
          Store.hubAdmission,
        ),
      );
      const before = yield* inventory;
      assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 1000);
      const failure = yield* store
        .transact(store.unionImportLineageTx([record(1000)], Store.hubAdmission))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryCapacityError");
      if (failure._tag === "MemoryCapacityError") {
        assert.strictEqual(failure.dimension, "import_lineage_records");
        assert.strictEqual(failure.current, 1001);
      }
      assert.deepStrictEqual(yield* inventory, before);
      yield* store.transact(store.unionImportLineageTx([record(999)], Store.hubAdmission));
      assert.deepStrictEqual(yield* inventory, before);
    }).pipe(Effect.provide(live)),
  );
  it.effect(
    "enforces global encoded-byte equality/+1 and rolls back reserve, generation and metadata",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        const bytes = new TextEncoder().encode(JSON.stringify(record(0))).length;
        yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_IMPORT_LINEAGE_MAX_BYTES - bytes}
        WHERE space='_hub_global' AND dimension='import_lineage_bytes'`;
        yield* store.transact(store.unionImportLineageTx([record(0)], Store.hubAdmission));
        const before = yield* inventory;
        const failure = yield* store
          .transact(store.unionImportLineageTx([record(1)], Store.hubAdmission))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryCapacityError");
        if (failure._tag === "MemoryCapacityError")
          assert.strictEqual(failure.dimension, "import_lineage_bytes");
        assert.deepStrictEqual(yield* inventory, before);
      }).pipe(Effect.provide(live)),
  );
  it.effect(
    "approved replica restores complete canonical union despite local record and byte limits",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_IMPORT_LINEAGE_MAX_BYTES}
        WHERE space='_hub_global' AND dimension='import_lineage_bytes'`;
        const store = yield* Store.MemoryStore;
        yield* store.transact(
          store.unionImportLineageTx(
            Array.from({ length: 1001 }, (_, n) => record(n)),
            Store.approvedReplica,
          ),
        );
        assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 1001);
      }).pipe(Effect.provide(live)),
  );
});

const sourceId = M.MemoryImportSourceId.make(uuid(3));
const address = { memorySpaceId: space, environmentId };
const stamp = M.MemoryUtcTimestamp.make("2026-10-15T00:00:00.000Z");
const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(environmentId),
});
const resolver = Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
  resolve: () => Effect.succeed(null),
});
const serviceLayer = Service.layer.pipe(Layer.provide(identity), Layer.provide(resolver));
const importLive = serviceLayer.pipe(
  Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(live))),
);
const registration = (): ImportRegistration => ({
  ...address,
  sourceId,
  codecVersion: 1,
  version: 0,
  slot: { format: "codex", rootSlot: "synthetic-slot", selection: null },
  source: {
    sourceId,
    format: "codex",
    parserVersion: "fixture-v1",
    profile: "fixture",
    label: "Synthetic",
  },
  sourceLocator: "memory.md",
  session: {
    sessionId: "session-1",
    parserVersion: "fixture-v1",
    profile: "fixture",
    snapshotDigest: "a".repeat(64),
    createdAtUtc: stamp,
    expiresAtUtc: M.MemoryUtcTimestamp.make("2099-01-01T00:00:00.000Z"),
    newItems: 0,
    bodyBytes: 0,
    applied: [],
  },
});
const prepared = (
  reg = registration(),
  n = 10,
  previous: ImportItem | null = null,
): PreparedImportCommit => {
  const operationId = M.MemoryOperationId.make(uuid(n));
  const revisionId = M.MemoryRevisionId.make(uuid(n + 1));
  const sourceFingerprint = (previous ? "c" : "a").repeat(64);
  const contentFingerprint = (previous ? "d" : "b").repeat(64);
  const scope: M.MemoryScope = { kind: "user" };
  const result: M.MemoryImportItemResult = {
    sourceItemKey: "synthetic-item",
    outcome: previous ? "revised" : "created",
    memoryId,
    revisionId,
  };
  const selection = {
    selector: { sourceItemKey: "synthetic-item", sourceFingerprint, scope },
    memoryId,
    operationId,
    revisionId,
    result,
  };
  const batchId = M.MemoryOperationId.make(uuid(n + 2));
  return {
    registrationVersion: reg.version,
    registration: reg,
    selection,
    batch: {
      ...address,
      kind: "detailed",
      codecVersion: 1,
      operationId: batchId,
      sourceId,
      sessionId: "session-1",
      selectionDigest: "e".repeat(64),
      selections: [selection],
      createdAtUtc: stamp,
      receipt: {
        operationId: batchId,
        sourceId,
        sessionId: "session-1",
        state: "completed",
        remaining: 0,
        sessionNewItems: 0,
        sessionBodyBytes: 0,
        items: [result],
      },
    },
    candidate: {
      sourceItemKey: "synthetic-item",
      sourceFingerprint,
      contentFingerprint,
      byteCount: 16,
      payload: {
        text: previous ? "synthetic changed" : "synthetic memory",
        evidence: [{ origin: "import", importSourceId: sourceId, messageIds: [] }],
        derivedFromMemoryRevisions: [],
      },
    },
    previous,
    next: {
      ...address,
      sourceId,
      codecVersion: 1,
      sourceItemKey: "synthetic-item",
      scope,
      memoryId,
      accepted: previous?.accepted ?? null,
      pending: { sourceFingerprint, contentFingerprint, revisionId, operationId },
      rejected: null,
      outcome: result.outcome,
    },
    expectedHeads: previous?.accepted ? [previous.accepted.revisionId] : [],
    parents: previous?.accepted ? [previous.accepted.revisionId] : [],
    projectBinding: null,
  };
};
const setupImport = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1)`;
  const service = yield* Service.MemoryService;
  yield* service.importPorts.saveRegistration(
    { ...address, next: registration(), expectedVersion: null },
    Effect.void,
  );
});
const durableInventory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    imports: yield* sql`SELECT * FROM memory_import_receipts ORDER BY receipt_id`,
    outbox: yield* sql`SELECT * FROM memory_outbox ORDER BY id`,
    events: yield* sql`SELECT * FROM memory_events ORDER BY sequence`,
    revisions: yield* sql`SELECT * FROM memory_revisions ORDER BY revision_id`,
    payloads: yield* sql`SELECT * FROM memory_payloads ORDER BY payload_ref`,
    counters: yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
  };
});
const authority = {
  principal: {
    memorySpaceId: space,
    environmentId,
    credentialVersion: 1,
    scopes: ["memory:sync"] as const,
  },
  now: Clock.currentTimeMillis,
  reauthorize: Effect.void,
};
const seedMember = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at)
    VALUES (${space},${environmentId},${"a".repeat(64)},1,'active',0)`;
});
// A fresh database models the hub; its approval cannot mutate the origin item fixture.
const remoteApproval = (
  operation: M.MemoryOperation,
  forgotten = false,
  predecessors: readonly M.MemoryOperation[] = [],
) =>
  Effect.gen(function* () {
    yield* seedMember;
    const service = yield* Service.MemoryService;
    if (forgotten) {
      const operationId = M.MemoryOperationId.make(uuid(800));
      yield* (yield* Store.MemoryStore).transact(
        service.admitHubOperationTx({
          authority,
          operation: {
            protocolVersion: 1,
            kind: "forget",
            memorySpaceId: space,
            memoryId,
            operationId,
            originEnvironmentId: environmentId,
            expectedHeads: [],
            tombstone: {
              memorySpaceId: space,
              memoryId,
              deleteOperationId: operationId,
              deletingEnvironmentId: environmentId,
              deletedAtUtc: stamp,
              suppressedSourceKeys: [],
              suppressedContent: [],
              sourceExclusions: [],
            },
          },
        }),
      );
    }
    for (const predecessor of predecessors)
      yield* (yield* Store.MemoryStore).transact(
        service.admitHubOperationTx({ authority, operation: predecessor }),
      );
    return yield* (yield* Store.MemoryStore).transact(
      service.admitHubOperationTx({ authority, operation }),
    );
  }).pipe(Effect.provide(Layer.fresh(importLive)));
const decodeReceiptEnvelope = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ receipt: M.MemoryImportReceipt })),
);
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const retired = Effect.fnUntraced(function* (p: PreparedImportCommit) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE memory_import_receipts SET completed_items_json=${encodeUnknown({ kind: "retired", codecVersion: 1, selectionDigest: p.batch.selectionDigest })}
    WHERE space=${space} AND environment_id=${environmentId} AND record_kind='batch' AND batch_operation_id=${p.batch.operationId}`;
});
describe("MemoryImport durable ports", () => {
  it.effect(
    "persists registration sessions, enforces slot/version CAS and rejects private excess fields",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const ports = service.importPorts;
        assert.deepStrictEqual(
          yield* ports.readRegistration(
            { ...address, by: "slot", slot: registration().slot },
            Effect.void,
          ),
          registration(),
        );
        const changed = {
          ...registration(),
          version: 1,
          session: { ...registration().session!, profile: "updated" },
        };
        yield* ports.saveRegistration(
          { ...address, next: changed, expectedVersion: 0 },
          Effect.void,
        );
        assert.strictEqual(
          (yield* ports
            .saveRegistration({ ...address, next: changed, expectedVersion: 0 }, Effect.void)
            .pipe(Effect.flip))._tag,
          "MemoryStoreConflict",
        );
        const conflict = yield* ports
          .saveRegistration(
            {
              ...address,
              next: {
                ...registration(),
                sourceId: M.MemoryImportSourceId.make(uuid(90)),
                source: {
                  ...registration().source,
                  sourceId: M.MemoryImportSourceId.make(uuid(90)),
                },
              },
              expectedVersion: null,
            },
            Effect.void,
          )
          .pipe(Effect.flip);
        assert.strictEqual(conflict._tag, "MemoryStoreConflict");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE memory_import_receipts SET registration_json=${encodeUnknown({ ...changed, extra: "forbidden" })} WHERE record_kind='source'`;
        assert.strictEqual(
          (yield* ports
            .readRegistration({ ...address, by: "source", sourceId }, Effect.void)
            .pipe(Effect.flip))._tag,
          "MemoryStorageError",
        );
      }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "reconstructs a fresh Service, replays committed stable IDs and keeps item/session/intent atomic",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const p = prepared();
        assert.deepStrictEqual(
          yield* service.importPorts.commit(p, Effect.void),
          p.selection.result,
        );
        const before = yield* durableInventory;
        const replay = yield* Effect.gen(function* () {
          const restarted = yield* Service.MemoryService;
          assert.deepStrictEqual(
            yield* restarted.importPorts.commit(p, Effect.void),
            p.selection.result,
          );
          return yield* restarted.importPorts.readReceipt(p.batch, Effect.void);
        }).pipe(
          Effect.provide(
            serviceLayer.pipe(
              Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
            ),
          ),
        );
        assert.strictEqual(replay.state, "completed");
        assert.strictEqual(replay.sessionNewItems, 1);
        assert.strictEqual(replay.sessionBodyBytes, 16);
        assert.deepStrictEqual(yield* durableInventory, before);
        const item = yield* service.importPorts.readItem(p.next, Effect.void);
        assert.deepStrictEqual(item, p.next);
        assert.strictEqual(
          (yield* service.importPorts.preflightBatch(
            { ...p.batch, selectionDigest: p.batch.selectionDigest },
            Effect.void,
          )).kind,
          "completed",
        );
        assert.strictEqual(
          (yield* service.importPorts
            .readReceipt({ ...p.batch, environmentId: M.EnvironmentId.make("other") }, Effect.void)
            .pipe(Effect.flip))._tag,
          "MemoryStoreConflict",
        );
        const store = yield* Store.MemoryStore;
        assert.strictEqual(
          (yield* store
            .transact(service.importPorts.readItem(p.next, Effect.void))
            .pipe(Effect.flip))._tag,
          "MemoryStorageError",
        );
      }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "rolls back every durable write on registration CAS conflict and authorization revoked after apply",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const p = prepared();
        const before = yield* durableInventory;
        const stale = yield* service.importPorts
          .commit({ ...p, registrationVersion: 99 }, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "MemoryStoreConflict");
        assert.deepStrictEqual(yield* durableInventory, before);
        const permit = Effect.gen(function* () {
          if (yield* store.receipt(space, p.selection.operationId).pipe(Effect.orDie))
            return yield* new Service.MemoryAccessError({ code: "fenced" });
        });
        assert.strictEqual(
          (yield* service.importPorts.commit(p, permit).pipe(Effect.flip))._tag,
          "MemoryAccessError",
        );
        assert.deepStrictEqual(yield* durableInventory, before);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "rechecks retired guard after preflight: same digest not_found, changed digest operation_id_reused",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const first = prepared();
        const unfinished = {
          ...first.selection,
          selector: { ...first.selection.selector, sourceItemKey: "synthetic-second" },
          memoryId: M.MemoryId.make(uuid(70)),
          operationId: M.MemoryOperationId.make(uuid(71)),
          revisionId: M.MemoryRevisionId.make(uuid(72)),
          result: null,
        };
        const batch = {
          ...first.batch,
          selections: [first.selection, unfinished],
          receipt: { ...first.batch.receipt, state: "partial" as const, remaining: 1 },
        };
        yield* service.importPorts.commit({ ...first, batch }, Effect.void);
        const preflight = yield* service.importPorts.preflightBatch(
          { ...batch, selectionDigest: batch.selectionDigest },
          Effect.void,
        );
        assert.strictEqual(preflight.kind, "partial");
        if (preflight.kind !== "partial") return assert.fail("expected durable partial batch");
        assert.strictEqual(preflight.batch.selections[1]!.operationId, unfinished.operationId);
        const reg = yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        );
        const p: PreparedImportCommit = {
          ...first,
          registration: reg!,
          registrationVersion: reg!.version,
          selection: unfinished,
          batch: preflight.batch,
          candidate: { ...first.candidate, sourceItemKey: unfinished.selector.sourceItemKey },
          next: {
            ...first.next,
            sourceItemKey: unfinished.selector.sourceItemKey,
            memoryId: unfinished.memoryId,
            pending: {
              ...first.next.pending!,
              operationId: unfinished.operationId,
              revisionId: unfinished.revisionId,
            },
          },
        };
        yield* retired(p);
        const before = yield* durableInventory;
        const same = yield* service.importPorts.commit(p, Effect.void).pipe(Effect.flip);
        assert.strictEqual(same._tag, "MemoryStoreConflict");
        if (same._tag === "MemoryStoreConflict") assert.strictEqual(same.code, "not_found");
        const changed = yield* service.importPorts
          .commit({ ...p, batch: { ...p.batch, selectionDigest: "f".repeat(64) } }, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(changed._tag, "MemoryStoreConflict");
        if (changed._tag === "MemoryStoreConflict")
          assert.strictEqual(changed.code, "operation_id_reused");
        const status = yield* service.importPorts
          .readReceipt(p.batch, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(status._tag, "MemoryRpcError");
        if (status._tag === "MemoryRpcError") assert.strictEqual(status.code, "not_found");
        assert.strictEqual(
          (yield* service.importPorts.preflightBatch(
            { ...p.batch, selectionDigest: p.batch.selectionDigest },
            Effect.void,
          )).kind,
          "retired",
        );
        assert.strictEqual(
          (yield* service.importPorts
            .preflightBatch({ ...p.batch, selectionDigest: "f".repeat(64) }, Effect.void)
            .pipe(Effect.flip))._tag,
          "MemoryImportRpcError",
        );
        assert.deepStrictEqual(yield* durableInventory, before);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("revises from accepted parent and refuses stale expected heads without writes", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const operation = (yield* store.readWorkOperation(
        `sync:${space}:${first.selection.operationId}`,
      ))!;
      const approval = yield* remoteApproval(operation);
      assert.strictEqual(
        (yield* service.importPorts.readItem(
          { ...address, sourceId, sourceItemKey: "synthetic-item" },
          Effect.void,
        ))!.accepted,
        null,
      );
      yield* store.acknowledgeOutbox(`sync:${space}:${first.selection.operationId}`, approval);
      const accepted = (yield* service.importPorts.readItem(
        { ...address, sourceId, sourceItemKey: "synthetic-item" },
        Effect.void,
      ))!;
      assert.deepStrictEqual(accepted.accepted, first.next.pending);
      assert.strictEqual(accepted.pending, null);
      const reg = yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      );
      const second = prepared(reg!, 30, accepted);
      const before = yield* durableInventory;
      assert.strictEqual(
        (yield* service.importPorts
          .commit({ ...second, expectedHeads: [] }, Effect.void)
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      assert.deepStrictEqual(yield* durableInventory, before);
      yield* service.importPorts.commit(second, Effect.void);
      const revised = yield* store.readOperation(space, second.selection.operationId);
      assert.strictEqual(revised?.kind, "upsert");
      if (revised?.kind === "upsert")
        assert.deepStrictEqual(revised.revision.parents, [first.selection.revisionId]);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "materializes unfinished selections and noop does not allocate another body, revision or intent",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const first = prepared();
        const unfinished = { ...first.selection, result: null };
        yield* service.importPorts.commit(
          {
            ...first,
            selection: unfinished,
            batch: {
              ...first.batch,
              selections: [unfinished],
              receipt: { ...first.batch.receipt, state: "partial", remaining: 1, items: [] },
            },
          },
          Effect.void,
        );
        const reg = yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        );
        const noop = prepared(reg!, 30, first.next);
        const selection = { ...noop.selection, selector: first.selection.selector, result: null };
        const p: PreparedImportCommit = {
          ...noop,
          selection,
          candidate: first.candidate,
          next: { ...first.next, outcome: "noop" },
          expectedHeads: [first.selection.revisionId],
          batch: {
            ...noop.batch,
            selections: [selection],
            receipt: { ...noop.batch.receipt, items: [], state: "partial", remaining: 1 },
          },
        };
        const target = yield* service.importPorts.prepareTarget(
          { ...address, memoryId, scope: { kind: "user" }, acceptedRevisionId: null },
          Effect.void,
        );
        assert.deepStrictEqual(target.heads, [first.selection.revisionId]);
        assert.strictEqual(target.alias, null);
        const before = yield* durableInventory;
        const scope: M.MemoryScope = {
          kind: "thread",
          thread: { environmentId, threadId: M.ThreadId.make("synthetic-thread") },
        };
        const changedSelection = { ...p.selection, selector: { ...p.selection.selector, scope } };
        const changedScope = {
          ...p,
          selection: changedSelection,
          next: { ...p.next, scope },
          batch: { ...p.batch, selections: [changedSelection] },
        };
        const denied = yield* service.importPorts
          .commit(changedScope, Effect.void)
          .pipe(Effect.flip);
        if (denied._tag === "MemoryStoreConflict")
          assert.strictEqual(denied.code, "identity_mismatch");
        else assert.fail("expected scope identity conflict");
        assert.deepStrictEqual(yield* durableInventory, before);
        const result = yield* service.importPorts.commit(p, Effect.void);
        assert.strictEqual(result.outcome, "noop");
        assert.strictEqual(result.revisionId, first.selection.revisionId);
        const after = yield* durableInventory;
        assert.deepStrictEqual(after.revisions, before.revisions);
        assert.deepStrictEqual(after.payloads, before.payloads);
        assert.deepStrictEqual(after.outbox, before.outbox);
        const receipt = yield* service.importPorts.readReceipt(p.batch, Effect.void);
        assert.strictEqual(receipt.sessionBodyBytes, 16);
        assert.strictEqual(receipt.sessionNewItems, 1);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("denies bootstrap and stale project binding without an intent or partial receipt", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const p = prepared();
      yield* sql`UPDATE memory_compaction_state SET published=0 WHERE space=${space}`;
      const before = yield* durableInventory;
      const failure = yield* service.importPorts.commit(p, Effect.void).pipe(Effect.flip);
      if (failure._tag === "MemoryStoreConflict")
        assert.strictEqual(failure.code, "bootstrap_required");
      else assert.fail("expected bootstrap conflict");
      assert.deepStrictEqual(yield* durableInventory, before);
      yield* sql`UPDATE memory_compaction_state SET published=1 WHERE space=${space}`;
      yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('synthetic-project','/synthetic',NULL)`;
      const project: M.ScopedProjectRef = {
        environmentId,
        projectId: M.ProjectId.make("synthetic-project"),
      };
      const projectKey: M.MemoryProjectKey = {
        kind: "explicit",
        sharedProjectId: uuid(80),
      };
      const binding: M.MemoryProjectBinding = {
        memorySpaceId: space,
        project,
        projectKey,
        repositoryKey: null,
        version: 1,
      };
      yield* store.putProjectBinding(binding, null, 0);
      const scope: M.MemoryScope = { kind: "project", projectKey };
      const selection = { ...p.selection, selector: { ...p.selection.selector, scope, project } };
      const mapped = {
        ...p,
        selection,
        next: { ...p.next, scope },
        batch: { ...p.batch, selections: [selection] },
        projectBinding: binding,
      };
      yield* store.putProjectBinding({ ...binding, version: 2 }, 1, 0);
      const snapshot = yield* durableInventory;
      const stale = yield* service.importPorts.commit(mapped, Effect.void).pipe(Effect.flip);
      if (stale._tag === "MemoryStoreConflict") assert.strictEqual(stale.code, "revision_changed");
      else assert.fail("expected project binding conflict");
      assert.deepStrictEqual(yield* durableInventory, snapshot);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "authorizes only after acquiring the writer lock when a queued import loses its grant",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const grant = yield* Ref.make(true);
        const before = yield* durableInventory;
        const holder = yield* Effect.forkChild(
          store.transact(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(entered);
        const permit = Ref.get(grant).pipe(
          Effect.flatMap((allowed) =>
            allowed ? Effect.void : Effect.fail(new Service.MemoryAccessError({ code: "fenced" })),
          ),
        );
        const queued = yield* Effect.forkChild(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(service.importPorts.commit(prepared(), permit)),
            Effect.exit,
          ),
        );
        yield* Deferred.await(started);
        yield* Ref.set(grant, false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const result = yield* Fiber.join(queued);
        assert.strictEqual(result._tag, "Failure");
        assert.deepStrictEqual(yield* durableInventory, before);
      }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport M3c final fences", () => {
  it.effect.each([
    ["rejected", "binding"],
    ["rejected", "deletion"],
    ["suppressed", "binding"],
    ["suppressed", "deletion"],
  ] as const)("metadata %j before durable mutation", ([outcome, race]) =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('synthetic-project','/synthetic',NULL)`;
      const project: M.ScopedProjectRef = {
        environmentId,
        projectId: M.ProjectId.make("synthetic-project"),
      };
      const projectKey: M.MemoryProjectKey = { kind: "explicit", sharedProjectId: uuid(80) };
      const binding: M.MemoryProjectBinding = {
        memorySpaceId: space,
        project,
        projectKey,
        repositoryKey: null,
        version: 1,
      };
      yield* store.putProjectBinding(binding, null, 0);
      const first = prepared();
      const scope: M.MemoryScope = { kind: "project", projectKey };
      const selection = {
        ...first.selection,
        selector: { ...first.selection.selector, scope, project },
        result: null,
      };
      const p: PreparedImportCommit = {
        ...first,
        selection,
        batch: { ...first.batch, selections: [selection] },
        projectBinding: binding,
        next: {
          ...first.next,
          scope,
          outcome,
          pending: null,
          rejected:
            outcome === "rejected"
              ? {
                  sourceFingerprint: first.candidate.sourceFingerprint,
                  issue: "source_changed",
                }
              : null,
        },
      };
      // A genuine delete fence makes suppressed a valid metadata-only outcome.
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(uuid(700)),
          expectedHeads: [],
        },
        Effect.void,
      );
      yield* store.transact(
        store.unionImportLineageTx(
          [
            {
              memorySpaceId: space,
              memoryId,
              kind: "sourceKey",
              sourceKey: {
                environmentId,
                sourceId,
                sourceItemKey: first.candidate.sourceItemKey,
              },
            },
          ],
          Store.approvedReplica,
        ),
      );
      if (race === "binding") yield* store.putProjectBinding({ ...binding, version: 2 }, 1, 0);
      else yield* sql`UPDATE projection_projects SET deleted_at='2026-10-15'`;
      const before = yield* durableInventory;
      const failure = yield* service.importPorts.commit(p, Effect.void).pipe(Effect.flip);
      if (failure._tag !== "MemoryStoreConflict")
        return assert.fail("expected final fence conflict");
      assert.strictEqual(failure.code, race === "binding" ? "revision_changed" : "not_found");
      assert.deepStrictEqual(yield* durableInventory, before);
      if (race === "binding" && outcome === "suppressed") {
        const good = { ...p, projectBinding: { ...binding, version: 2 } };
        assert.strictEqual(
          (yield* service.importPorts.commit(good, Effect.void)).outcome,
          "suppressed",
        );
      }
    }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "reject-only preserves item scope and capacity details while later selections proceed",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const first = prepared();
        yield* service.importPorts.commit(first, Effect.void);
        const reg = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        const attempt = prepared(reg, 30, first.next);
        const scope: M.MemoryScope = {
          kind: "thread",
          thread: { environmentId, threadId: M.ThreadId.make("synthetic-thread") },
        };
        const selection = {
          ...attempt.selection,
          selector: { ...attempt.selection.selector, scope },
          result: null,
        };
        const p: PreparedImportCommit = {
          ...attempt,
          selection,
          batch: { ...attempt.batch, selections: [selection] },
          next: first.next,
          rejectOnly: { issue: "mapping_changed" },
        };
        const { rejectOnly: _rejectOnly, ...normal } = p;
        const invalid = {
          ...normal,
          next: {
            ...first.next,
            scope,
            outcome: "rejected" as const,
            pending: null,
            rejected: {
              sourceFingerprint: p.candidate.sourceFingerprint,
              issue: "mapping_changed" as const,
            },
          },
        };
        const before = yield* durableInventory;
        assert.strictEqual(
          (yield* service.importPorts.commit(invalid, Effect.void).pipe(Effect.flip))._tag,
          "MemoryStoreConflict",
        );
        assert.deepStrictEqual(yield* durableInventory, before);
        const result = yield* service.importPorts.commit(p, Effect.void);
        assert.strictEqual(result.issue, "mapping_changed");
        assert.deepStrictEqual(
          yield* service.importPorts.readItem(first.next, Effect.void),
          first.next,
        );
        const updated = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        const second = prepared(updated, 50, first.next);
        const otherSelection = { ...second.selection, result: null };
        const capacity: M.MemoryCapacityExceeded = {
          code: "capacity_exceeded",
          dimension: "import_session_bytes",
          current: 2097153,
          limit: 2097152,
          reclaimable: 0,
        };
        const denied = {
          ...second,
          selection: otherSelection,
          batch: { ...second.batch, selections: [otherSelection] },
          next: first.next,
          rejectOnly: { issue: "capacity_exceeded" as const, capacity },
        };
        assert.deepStrictEqual(
          (yield* service.importPorts.commit(denied, Effect.void)).capacity,
          capacity,
        );
        assert.deepStrictEqual(
          yield* service.importPorts.readItem(first.next, Effect.void),
          first.next,
        );
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("rejected-only aliases a real approved target with previous CAS intact", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const rejected = prepared();
      const selection = { ...rejected.selection, result: null };
      const item: ImportItem = {
        ...rejected.next,
        pending: null,
        outcome: "rejected",
        rejected: {
          sourceFingerprint: rejected.candidate.sourceFingerprint,
          issue: "source_changed",
        },
      };
      yield* service.importPorts.commit(
        {
          ...rejected,
          selection,
          batch: { ...rejected.batch, selections: [selection] },
          next: item,
        },
        Effect.void,
      );
      const targetOp = M.MemoryOperationId.make(uuid(200));
      yield* service.upsert(
        {
          memorySpaceId: space,
          memoryId,
          operationId: targetOp,
          baseBoundary: null,
          expectedHeads: [],
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: rejected.candidate.payload,
        },
        Effect.void,
      );
      const operation = (yield* store.readOperation(space, targetOp))!;
      if (operation.kind !== "upsert") return assert.fail("expected target upsert");
      const targetRev = operation.revision.revisionId;
      yield* store.acknowledgeOutbox(`sync:${space}:${targetOp}`, yield* remoteApproval(operation));
      const target = yield* service.importPorts.prepareTarget(
        { ...address, memoryId, scope: { kind: "user" }, acceptedRevisionId: null },
        Effect.void,
      );
      assert.deepStrictEqual(target.heads, [targetRev]);
      assert.strictEqual(target.alias?.revision.revisionId, targetRev);
      const reg = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const alias = prepared(reg, 30, item);
      const aliasSelection = { ...alias.selection, result: null };
      const p: PreparedImportCommit = {
        ...alias,
        selection: aliasSelection,
        batch: { ...alias.batch, selections: [aliasSelection] },
        candidate: { ...alias.candidate, payload: rejected.candidate.payload },
        next: { ...alias.next, outcome: "aliased" },
        expectedHeads: target.heads,
        parents: [targetRev],
      };
      const before = yield* durableInventory;
      const stale = yield* service.importPorts
        .commit({ ...p, previous: null }, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(stale._tag, "MemoryStoreConflict");
      assert.deepStrictEqual(yield* durableInventory, before);
      const sql = yield* SqlClient.SqlClient;
      const bodies = yield* sql`SELECT * FROM memory_payloads ORDER BY space,payload_ref`;
      assert.strictEqual((yield* service.importPorts.commit(p, Effect.void)).outcome, "aliased");
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_payloads ORDER BY space,payload_ref`,
        bodies,
      );
      assert.strictEqual(
        (yield* sql<{ value: number }>`SELECT value FROM memory_quota_counters
        WHERE space='_hub_global' AND dimension='import_live_bytes'`)[0]?.value,
        new TextEncoder().encode(rejected.candidate.payload.text).length,
      );
      const op = yield* store.readOperation(space, p.selection.operationId);
      if (op?.kind !== "upsert") return assert.fail("expected alias intent");
      assert.deepStrictEqual(op.revision.parents, [targetRev]);
      assert.strictEqual(op.revision.payloadRef, operation.revision.payloadRef);
      const aliasUsage = yield* store.usage(space, { kind: "user" });
      assert.isAbove(aliasUsage.liveBytes, 0);
      assert.strictEqual(aliasUsage.historyBytes, 0);
      assert.strictEqual(
        (yield* store.loadAggregate(space, memoryId)).revisions.find(
          (r) => r.revision.revisionId === op.revision.revisionId,
        )?.revision.payloadRef,
        operation.revision.payloadRef,
      );
      assert.strictEqual(
        (yield* service.importPorts.readReceipt(p.batch, Effect.void)).sessionBodyBytes,
        0,
      );
      assert.deepStrictEqual(
        (yield* service.importPorts.readItem(item, Effect.void))?.pending,
        p.next.pending,
      );
      const aliasApproval = yield* remoteApproval(op, false, [operation]);
      assert.strictEqual(aliasApproval.outcome, "accepted");
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, aliasApproval);
      assert.deepStrictEqual(
        (yield* service.importPorts.readItem(item, Effect.void))?.accepted,
        p.next.pending,
      );
      assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 2);
      // Expired scheduling on a shared historical ref must not purge a live alias head.
      yield* sql`UPDATE memory_payloads SET purge_eligible_after=0,replaced_at=0 WHERE payload_ref=${op.revision.payloadRef}`;
      yield* store.prunePayloads(
        Date.parse(stamp) + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS + 1,
        32,
      );
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 1);
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport settlement", () => {
  it.effect("settles metadata-only pull without depending on an ACK writer", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const operation = (yield* store.readWorkOperation(
        `sync:${space}:${first.selection.operationId}`,
      ))!;
      assert.strictEqual(operation.kind, "upsert");
      if (operation.kind !== "upsert") return;
      const receipt = yield* remoteApproval(operation);
      yield* store.transact(
        store.settleMetadataEntryTx({
          memorySpaceId: space,
          entry: {
            kind: "metadata",
            operationKind: "upsert",
            hubSequence: receipt.hubSequence!,
            receipt,
            memoryId,
            revision: operation.revision,
          },
        }),
      );
      const item = (yield* service.importPorts.readItem(
        { ...address, sourceId, sourceItemKey: "synthetic-item" },
        Effect.void,
      ))!;
      assert.deepStrictEqual(item.accepted, first.next.pending);
      assert.strictEqual(item.pending, null);
      assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 2);
      const before = yield* durableInventory;
      yield* store.transact(
        store.settleMetadataEntryTx({
          memorySpaceId: space,
          entry: {
            kind: "metadata",
            operationKind: "upsert",
            hubSequence: receipt.hubSequence!,
            receipt,
            memoryId,
            revision: operation.revision,
          },
        }),
      );
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );

  it.effect("settles actual hub rejection on ACK and preserves charges across replay", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const operation = (yield* store.readWorkOperation(
        `sync:${space}:${first.selection.operationId}`,
      ))!;
      const refusal = yield* remoteApproval(operation, true);
      assert.strictEqual(refusal.outcome, "rejected");
      yield* store.acknowledgeOutbox(`sync:${space}:${first.selection.operationId}`, refusal);
      const item = (yield* service.importPorts.readItem(
        { ...address, sourceId, sourceItemKey: "synthetic-item" },
        Effect.void,
      ))!;
      assert.strictEqual(item.pending, null);
      assert.strictEqual(item.accepted, null);
      assert.strictEqual(item.outcome, "rejected");
      const receipt = yield* service.importPorts.readReceipt(first.batch, Effect.void);
      assert.strictEqual(receipt.items[0]!.outcome, "rejected");
      assert.strictEqual(receipt.sessionNewItems, 1);
      const before = yield* durableInventory;
      yield* store.acknowledgeOutbox(`sync:${space}:${first.selection.operationId}`, refusal);
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "settles a pulled canonical operation and retires only settled expired batch details",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const first = prepared();
        yield* service.importPorts.commit(first, Effect.void);
        const operation = (yield* store.readWorkOperation(
          `sync:${space}:${first.selection.operationId}`,
        ))!;
        const receipt = yield* remoteApproval(operation);
        yield* TestClock.setTime(Date.parse(stamp) + M.MEMORY_IMPORT_BATCH_RETENTION_MS + 1);
        // Still pending on the origin: expiry cannot discard the detailed receipt.
        assert.strictEqual(
          (yield* store.transact(store.readImportBatchTx(first.batch)))?.kind,
          "detailed",
        );
        yield* store.transact(
          service.settleHubEntryTx({
            memorySpaceId: space,
            localEnvironmentId: environmentId,
            hubEnvironmentId: environmentId,
            entry: {
              kind: "operation",
              hubSequence: receipt.hubSequence!,
              operation,
              receipt,
            },
          }),
        );
        assert.strictEqual(
          (yield* service.importPorts.readItem(
            { ...address, sourceId, sourceItemKey: "synthetic-item" },
            Effect.void,
          ))!.pending,
          null,
        );
        const guard = yield* store.transact(store.readImportBatchTx(first.batch));
        assert.strictEqual(guard?.kind, "retired");
        // Fixed ASCII tag/version and a 64-byte hex digest have no escaping expansion.
        assert.isAtMost(
          new TextEncoder().encode(JSON.stringify(guard)).length,
          M.MEMORY_COMPACT_RECEIPT_MAX_BYTES,
        );
        const before = yield* durableInventory;
        const failure = yield* service.importPorts.commit(first, Effect.void).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryStoreConflict");
        if (failure._tag === "MemoryStoreConflict") assert.strictEqual(failure.code, "not_found");
        assert.deepStrictEqual(yield* durableInventory, before);
        const changed = yield* service.importPorts
          .preflightBatch({ ...first.batch, selectionDigest: "f".repeat(64) }, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(changed._tag, "MemoryImportRpcError");
      }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport target frontiers", () => {
  it.effect("prepares exact multi-head conflict and identifies a compacted accepted base", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const operation = (yield* store.readOperation(space, first.selection.operationId))!;
      const approval = yield* remoteApproval(operation);
      yield* store.acknowledgeOutbox(`sync:${space}:${first.selection.operationId}`, approval);
      const previous = (yield* service.importPorts.readItem(first.next, Effect.void))!;
      yield* seedMember;
      for (const n of [210, 220]) {
        const operationId = M.MemoryOperationId.make(uuid(n));
        const revisionId = M.MemoryRevisionId.make(uuid(n + 1));
        yield* service.admitHubOperation({
          authority,
          operation: {
            protocolVersion: 1,
            kind: "upsert",
            memorySpaceId: space,
            memoryId,
            operationId,
            originEnvironmentId: environmentId,
            expectedHeads: [first.selection.revisionId],
            revision: {
              memorySpaceId: space,
              memoryId,
              operationId,
              revisionId,
              payloadRef: revisionId,
              parents: [first.selection.revisionId],
              scope: { kind: "user" },
              assertionKind: "inference",
              provenance: { environmentId },
              createdAtUtc: stamp,
            },
            payload: { ...first.candidate.payload, text: `synthetic branch ${n}` },
          },
        });
      }
      const target = yield* service.importPorts.prepareTarget(
        {
          ...address,
          memoryId,
          scope: { kind: "user" },
          acceptedRevisionId: first.selection.revisionId,
        },
        Effect.void,
      );
      assert.strictEqual(target.heads.length, 2);
      assert.strictEqual(target.acceptedParent?.status, "retained");
      assert.strictEqual(target.alias, null);
      const reg = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const attempt = prepared(reg, 30, previous);
      const selection = { ...attempt.selection, result: null };
      const conflict = {
        ...attempt,
        selection,
        batch: { ...attempt.batch, selections: [selection] },
        expectedHeads: target.heads,
        next: { ...attempt.next, outcome: "conflicted" as const },
      };
      assert.strictEqual(
        (yield* service.importPorts.commit(conflict, Effect.void)).outcome,
        "conflicted",
      );
      // Actual compact receipt membership, not a guessed timestamp/UUID, proves compaction.
      yield* store.persistCompactReceipt({
        memorySpaceId: space,
        originEnvironmentId: environmentId,
        operationKind: "upsert",
        receipt: approval,
        revisionId: first.selection.revisionId,
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      });
      const boundary = {
        checkpointSequence: approval.hubSequence!,
        boundaryId: "synthetic-boundary",
      };
      yield* sql`UPDATE memory_compaction_state SET boundary_json=${encodeUnknown(boundary)} WHERE space=${space}`;
      yield* sql`DELETE FROM memory_revisions WHERE space=${space} AND revision_id=${first.selection.revisionId}`;
      const compacted = yield* service.importPorts.prepareTarget(
        {
          ...address,
          memoryId,
          scope: { kind: "user" },
          acceptedRevisionId: first.selection.revisionId,
        },
        Effect.void,
      );
      assert.strictEqual(compacted.acceptedParent?.status, "compacted");
      assert.strictEqual(compacted.heads.length, 3);
      const updated = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const p = prepared(updated, 50, conflict.next);
      const unfinished = { ...p.selection, result: null };
      const before = yield* durableInventory;
      const failure = yield* service.importPorts
        .commit(
          {
            ...p,
            selection: unfinished,
            batch: { ...p.batch, selections: [unfinished] },
            expectedHeads: compacted.heads,
            next: { ...p.next, outcome: "conflicted" },
          },
          Effect.void,
        )
        .pipe(Effect.flip);
      if (failure._tag !== "MemoryStoreConflict")
        return assert.fail("expected compacted base conflict");
      assert.strictEqual(failure.code, "base_compacted");
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport lifetime forget fragments", () => {
  it.effect(
    "submits the full lifetime union as immutable bounded pending fragments and settles ACK links",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const first = prepared();
        yield* service.importPorts.commit(first, Effect.void);
        const operation = (yield* store.readOperation(space, first.selection.operationId))!;
        yield* store.acknowledgeOutbox(
          `sync:${space}:${first.selection.operationId}`,
          yield* remoteApproval(operation),
        );
        yield* store.transact(
          store.unionImportLineageTx(
            Array.from({ length: 203 }, (_, n) => record(n)),
            Store.hubAdmission,
          ),
        );
        const ledger = yield* store.readImportLineage(space, memoryId);
        const operationId = M.MemoryOperationId.make(uuid(600));
        const request = {
          memorySpaceId: space,
          memoryId,
          operationId,
          expectedHeads: [first.selection.revisionId],
        };
        const base = yield* service.forget(request, Effect.void);
        assert.strictEqual(base.receipt.forgetExpansion?.status, "pending");
        assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "forgotten");
        assert.strictEqual((yield* durableInventory).payloads.length, 0);
        const operations: M.MemoryOperation[] = [];
        let id = operationId;
        for (;;) {
          const op = (yield* store.readOperation(space, id))!;
          assert.strictEqual(op.kind, "forget");
          if (op.kind !== "forget") return assert.fail("expected forget fragment");
          assert.isAtMost(
            op.tombstone.suppressedSourceKeys.length +
              op.tombstone.suppressedContent.length +
              op.tombstone.sourceExclusions.length,
            100,
          );
          operations.push(op);
          const receipt = (yield* store.receipt(space, id))!;
          if (!receipt.receipt.forgetExpansion) break;
          assert.strictEqual(receipt.receipt.forgetExpansion.status, "pending");
          id = receipt.receipt.forgetExpansion.operationId;
        }
        assert.strictEqual(operations.length, 3);
        assert.strictEqual((yield* store.readSuppressions(space, memoryId)).length, ledger.length);
        const before = yield* durableInventory;
        assert.deepStrictEqual(yield* service.forget(request, Effect.void), base);
        assert.deepStrictEqual(yield* durableInventory, before);
        for (const op of operations) {
          const receipt = yield* remoteApproval(op);
          yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, receipt);
          if (op.operationId === operationId) {
            // A base can compact while its independently delivered expansion is still pending.
            yield* store.persistCompactReceipt({
              memorySpaceId: space,
              originEnvironmentId: environmentId,
              operationKind: "forget",
              receipt,
              revisionId: null,
              resolutionId: null,
              revertsResolutionId: null,
              attemptId: null,
              fencingToken: null,
              reportGuard: null,
            });
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM memory_events WHERE memory_space_id=${space} AND operation_id=${operationId}`;
          }
        }
        assert.strictEqual(
          (yield* store.receipt(space, operationId))?.receipt.forgetExpansion?.status,
          "accepted",
        );
        assert.deepStrictEqual(yield* store.readImportLineage(space, memoryId), ledger);
      }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport refused forget expansion", () => {
  it.effect("preserves reserved base deletion when expansion metadata is refused", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const op = (yield* store.readOperation(space, first.selection.operationId))!;
      yield* store.acknowledgeOutbox(
        `sync:${space}:${first.selection.operationId}`,
        yield* remoteApproval(op),
      );
      yield* store.transact(
        store.unionImportLineageTx(
          Array.from({ length: 203 }, (_, n) => record(n)),
          Store.approvedReplica,
        ),
      );
      // Canonical replica restoration may leave local metadata above its admission ceiling.
      yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys)
        VALUES (${space},${M.MemoryId.make(uuid(900))},'{}','{}',${M.MEMORY_PERMANENT_METADATA_MAX_BYTES},0)`;
      const result = yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(uuid(600)),
          expectedHeads: [first.selection.revisionId],
        },
        Effect.void,
      );
      assert.strictEqual(result.receipt.outcome, "deleted");
      assert.strictEqual(result.receipt.forgetExpansion?.status, "rejected");
      const expansion = (yield* store.receipt(space, result.receipt.forgetExpansion!.operationId))!;
      assert.strictEqual(expansion.receipt.outcome, "rejected");
      assert.strictEqual(expansion.receipt.failureCode, "capacity_exceeded");
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "forgotten");
      assert.strictEqual((yield* durableInventory).payloads.length, 0);
      assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 205);
      assert.strictEqual((yield* store.readSuppressions(space, memoryId)).length, 100);
      assert.strictEqual(
        (yield* service.importPorts.findMatch(
          {
            ...address,
            source: { environmentId, sourceId, sourceItemKey: "synthetic-202" },
            content: {
              scope: { kind: "user" },
              assertionKind: "inference",
              contentFingerprint: "b".repeat(64),
            },
          },
          Effect.void,
        )).kind,
        "source_suppressed",
      );
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport origin admission", () => {
  it.effect(
    "batch-only capacity rejection allocates no new identity and the following noop completes",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const sql = yield* SqlClient.SqlClient;
        const first = prepared();
        yield* service.importPorts.commit(first, Effect.void);
        const reg = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        const attempt = prepared(reg, 30);
        const key = "synthetic-capacity";
        const id = M.MemoryId.make(uuid(500));
        const rejectedSelection = {
          ...attempt.selection,
          memoryId: id,
          selector: { ...attempt.selection.selector, sourceItemKey: key },
          result: null,
        };
        const noop = prepared(reg, 50, first.next);
        const noopSelection = {
          ...noop.selection,
          selector: first.selection.selector,
          result: null,
        };
        const batch = {
          ...attempt.batch,
          selections: [rejectedSelection, noopSelection],
          receipt: { ...attempt.batch.receipt, items: [], remaining: 2, state: "partial" as const },
        };
        const capacity: M.MemoryCapacityExceeded = {
          code: "capacity_exceeded",
          dimension: "import_source_items",
          current: M.MEMORY_IMPORT_MAX_SOURCE_ITEMS + 1,
          limit: M.MEMORY_IMPORT_MAX_SOURCE_ITEMS,
          reclaimable: 0,
        };
        yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_IMPORT_MAX_SOURCE_ITEMS - 1} WHERE space='_hub_global' AND dimension='import_source_items'`;
        const next = {
          ...attempt.next,
          sourceItemKey: key,
          memoryId: id,
          outcome: "rejected" as const,
          pending: null,
          rejected: {
            sourceFingerprint: attempt.candidate.sourceFingerprint,
            issue: "capacity_exceeded" as const,
          },
        };
        const result = yield* service.importPorts.commit(
          {
            ...attempt,
            batch,
            selection: rejectedSelection,
            candidate: { ...attempt.candidate, sourceItemKey: key },
            next,
            rejectOnly: { issue: "capacity_exceeded", capacity },
          },
          Effect.void,
        );
        assert.deepStrictEqual(result.capacity, capacity);
        assert.strictEqual(yield* service.importPorts.readItem(next, Effect.void), undefined);
        const partial = yield* service.importPorts.preflightBatch(
          { ...batch, selectionDigest: batch.selectionDigest },
          Effect.void,
        );
        if (partial.kind !== "partial") return assert.fail("expected partial batch");
        const updated = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        assert.strictEqual(
          (yield* service.importPorts.commit(
            {
              ...noop,
              registration: updated,
              registrationVersion: updated.version,
              batch: partial.batch,
              selection: partial.batch.selections[1]!,
              candidate: first.candidate,
              next: { ...first.next, outcome: "noop" },
              expectedHeads: [first.selection.revisionId],
            },
            Effect.void,
          )).outcome,
          "noop",
        );
        const receipt = yield* service.importPorts.readReceipt(batch, Effect.void);
        assert.strictEqual(receipt.state, "completed");
        assert.strictEqual(receipt.items.length, 2);
        assert.deepStrictEqual(receipt.items[0]!.capacity, capacity);
      }).pipe(Effect.provide(importLive)),
  );

  it.effect("a rejected zero-byte observation cannot waive a later accepted session charge", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const initial = registration();
      const reg = {
        ...initial,
        version: 1,
        session: { ...initial.session!, newItems: M.MEMORY_IMPORT_SESSION_MAX_NEW_ITEMS },
      };
      yield* service.importPorts.saveRegistration(
        { ...address, next: reg, expectedVersion: 0 },
        Effect.void,
      );
      const first = prepared(reg);
      const selection = { ...first.selection, result: null };
      const rejected = {
        ...first.next,
        outcome: "rejected" as const,
        pending: null,
        rejected: {
          sourceFingerprint: first.candidate.sourceFingerprint,
          issue: "source_changed" as const,
        },
      };
      yield* service.importPorts.commit(
        { ...first, selection, batch: { ...first.batch, selections: [selection] }, next: rejected },
        Effect.void,
      );
      const updated = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      assert.strictEqual(updated.session!.applied[0]!.bodyBytes, 0);
      const attempt = prepared(updated, 30, rejected);
      const retrySelection = {
        ...attempt.selection,
        selector: first.selection.selector,
        result: null,
      };
      const retry = {
        ...attempt,
        selection: retrySelection,
        batch: { ...attempt.batch, selections: [retrySelection] },
        candidate: first.candidate,
        next: {
          ...attempt.next,
          outcome: "created" as const,
          pending: {
            ...attempt.next.pending!,
            sourceFingerprint: first.candidate.sourceFingerprint,
            contentFingerprint: first.candidate.contentFingerprint,
          },
        },
      };
      const before = yield* durableInventory;
      const failure = yield* service.importPorts.commit(retry, Effect.void).pipe(Effect.flip);
      if (failure._tag !== "MemoryCapacityError")
        return assert.fail("expected accepted charge admission");
      assert.strictEqual(failure.dimension, "import_session_items");
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );

  it.effect.each([
    ["import_source_items", M.MEMORY_IMPORT_MAX_SOURCE_ITEMS, 1],
    ["import_aliases", M.MEMORY_IMPORT_MAX_ALIASES, 1],
    ["import_digests", M.MEMORY_IMPORT_MAX_CONTENT_DIGESTS, 1],
    ["import_live_items", M.MEMORY_IMPORT_MAX_LIVE_ITEMS, 1],
    ["import_live_bytes", M.MEMORY_IMPORT_MAX_LIVE_BODY_BYTES, 16],
  ] as const)("origin %j admits equality and refuses +1 atomically", ([dimension, limit, delta]) =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const sql = yield* SqlClient.SqlClient;
      // Source registrations share the item ceiling, even before their first body.
      const initial = limit - delta - Number(dimension === "import_source_items");
      yield* sql`UPDATE memory_quota_counters SET value=${initial} WHERE space='_hub_global' AND dimension=${dimension}`;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const reg = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const attempt = prepared(reg, 30);
      const key = "synthetic-second";
      const targetId = M.MemoryId.make(uuid(500));
      const selection = {
        ...attempt.selection,
        memoryId: targetId,
        selector: { ...attempt.selection.selector, sourceItemKey: key },
        result: null,
      };
      const next = { ...attempt.next, memoryId: targetId, sourceItemKey: key };
      const second = {
        ...attempt,
        selection,
        batch: { ...attempt.batch, selections: [selection] },
        candidate: { ...attempt.candidate, sourceItemKey: key },
        next,
      };
      const before = yield* durableInventory;
      const failure = yield* service.importPorts.commit(second, Effect.void).pipe(Effect.flip);
      if (failure._tag !== "MemoryCapacityError") return assert.fail("expected origin capacity");
      assert.strictEqual(failure.dimension, dimension);
      assert.isAbove(failure.current!, limit);
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect.each(["import_session_items", "import_session_bytes"] as const)(
    "session %s is charged across chunks and rolls back an excess item",
    (dimension) =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const initial = registration();
        const reg = {
          ...initial,
          version: 1,
          session: {
            ...initial.session!,
            newItems: dimension === "import_session_items" ? 127 : 0,
            bodyBytes:
              dimension === "import_session_bytes"
                ? M.MEMORY_IMPORT_SESSION_MAX_BODY_BYTES - 16
                : 0,
          },
        };
        yield* service.importPorts.saveRegistration(
          { ...address, next: reg, expectedVersion: 0 },
          Effect.void,
        );
        const first = prepared(reg);
        yield* service.importPorts.commit(first, Effect.void);
        const updated = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        const second = prepared(updated, 30);
        const key = "synthetic-second";
        const id = M.MemoryId.make(uuid(500));
        const selection = {
          ...second.selection,
          memoryId: id,
          selector: { ...second.selection.selector, sourceItemKey: key },
          result: null,
        };
        const p = {
          ...second,
          selection,
          batch: { ...second.batch, selections: [selection] },
          candidate: { ...second.candidate, sourceItemKey: key },
          next: { ...second.next, sourceItemKey: key, memoryId: id },
        };
        const before = yield* durableInventory;
        const failure = yield* service.importPorts.commit(p, Effect.void).pipe(Effect.flip);
        if (failure._tag !== "MemoryCapacityError") return assert.fail("expected session capacity");
        assert.strictEqual(failure.dimension, dimension);
        assert.deepStrictEqual(yield* durableInventory, before);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("rejected observations allocate source/alias/digest metadata without a body", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const sql = yield* SqlClient.SqlClient;
      const first = prepared();
      const selection = { ...first.selection, result: null };
      const rejected = {
        ...first.next,
        outcome: "rejected" as const,
        pending: null,
        rejected: {
          sourceFingerprint: first.candidate.sourceFingerprint,
          issue: "source_changed" as const,
        },
      };
      yield* service.importPorts.commit(
        {
          ...first,
          selection,
          batch: { ...first.batch, selections: [selection] },
          next: rejected,
        },
        Effect.void,
      );
      const counters = yield* sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space='_hub_global' AND dimension LIKE 'import_%'`;
      const values = new Map(counters.map((r) => [r.dimension, r.value]));
      assert.strictEqual(values.get("import_source_items"), 1);
      assert.strictEqual(values.get("import_aliases"), 1);
      assert.strictEqual(values.get("import_digests"), 1);
      assert.strictEqual(values.get("import_live_items"), 0);
      assert.isAbove(values.get("import_metadata")!, 0);
      assert.isAbove(values.get("import_staging")!, 0);
      assert.strictEqual((yield* durableInventory).payloads.length, 0);
      const receipt = yield* service.importPorts.readReceipt(first.batch, Effect.void);
      assert.strictEqual(receipt.sessionBodyBytes, 0);
    }).pipe(Effect.provide(importLive)),
  );
});

const allMemoryInventory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%' ORDER BY name`;
  const result: Record<string, readonly string[]> = {};
  for (const table of tables) {
    const rows = yield* sql.unsafe(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`);
    result[table.name] = rows.map((row) => encodeUnknown(row)).sort();
  }
  return result;
});
const repository = {
  canonicalKey: "github.com/synthetic/import",
  rootPath: "/synthetic",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/synthetic/import.git",
  },
};
const repositoryImportLive = Service.layer.pipe(
  Layer.provide(identity),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(repository),
    }),
  ),
  Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(live))),
);
describe("MemoryImport M3d", () => {
  it.effect(
    "preparation binding resolves without writes and materializes only inside successful commit",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const sql = yield* SqlClient.SqlClient;
        const ports = (yield* Service.MemoryService).importPorts;
        yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
        yield* sql`INSERT INTO projection_projects VALUES ('synthetic-project','/synthetic',NULL)`;
        const project = { environmentId, projectId: M.ProjectId.make("synthetic-project") };
        const before = yield* allMemoryInventory;
        const binding = yield* ports.binding({ memorySpaceId: space, project }, Effect.void);
        assert.isNotNull(binding.repositoryKey);
        assert.deepStrictEqual(yield* ports.resolveProjectKey(space, project), binding.projectKey);
        assert.deepStrictEqual(yield* allMemoryInventory, before);
        if (!binding.projectKey) return assert.fail("expected derived binding");
        const p = prepared();
        const scope: M.MemoryScope = { kind: "project", projectKey: binding.projectKey };
        const selection = { ...p.selection, selector: { ...p.selection.selector, scope, project } };
        const mapped = {
          ...p,
          selection,
          batch: { ...p.batch, selections: [selection] },
          next: { ...p.next, scope },
          projectBinding: binding,
        };
        const denied = yield* ports
          .commit({ ...mapped, expectedHeads: [M.MemoryRevisionId.make(uuid(999))] }, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(denied._tag, "MemoryStoreConflict");
        assert.deepStrictEqual(yield* allMemoryInventory, before);
        yield* ports.commit(mapped, Effect.void);
        assert.strictEqual((yield* sql`SELECT * FROM memory_project_bindings`).length, 1);
      }).pipe(Effect.provide(repositoryImportLive)),
  );
  it.effect("hubReceipt-only approval refuses incomplete lineage without backfill", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const p = prepared();
      yield* service.importPorts.commit(p, Effect.void);
      const op = (yield* store.readOperation(space, p.selection.operationId))!;
      const receipt = yield* remoteApproval(op);
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, receipt);
      yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'hubReceipt',${op.operationId},${memoryId},${encodeUnknown({ receipt, memoryId })})`;
      yield* sql`DELETE FROM memory_events WHERE memory_space_id=${space}`;
      yield* sql`DELETE FROM memory_compact_receipts WHERE space=${space}`;
      yield* sql`DELETE FROM memory_import_lineage WHERE space=${space}`;
      const before = yield* allMemoryInventory;
      const guard = yield* store
        .transact(store.requireImportLineageCompleteTx(space))
        .pipe(Effect.flip);
      assert.strictEqual(guard._tag, "MemoryStoreConflict");
      if (guard._tag === "MemoryStoreConflict")
        assert.strictEqual(guard.code, "bootstrap_required");
      const callback = yield* service.importPorts.readItem(p.next, Effect.void).pipe(Effect.flip);
      assert.strictEqual(callback._tag, "MemoryStoreConflict");
      if (callback._tag === "MemoryStoreConflict")
        assert.strictEqual(callback.code, "bootstrap_required");
      assert.deepStrictEqual(yield* allMemoryInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect("public receipt not_found commits lazy retirement", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const p = prepared();
      yield* service.importPorts.commit(p, Effect.void);
      const op = (yield* store.readOperation(space, p.selection.operationId))!;
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, yield* remoteApproval(op));
      yield* TestClock.setTime(Date.parse(stamp) + M.MEMORY_IMPORT_BATCH_RETENTION_MS + 1);
      const failure = yield* service.importPorts
        .readReceipt(p.batch, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryRpcError");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        kind: string;
      }>`SELECT json_extract(completed_items_json,'$.kind') AS kind FROM memory_import_receipts WHERE batch_operation_id=${p.batch.operationId}`;
      assert.strictEqual(rows[0]?.kind, "retired");
    }).pipe(Effect.provide(importLive)),
  );
  it.effect.each([
    "B accepted C rejected",
    "C accepted B accepted",
    "B rejected C accepted",
  ] as const)("settles delayed observations: %s", (order) =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const ports = service.importPorts;
      const a = prepared();
      yield* ports.commit(a, Effect.void);
      const aOp = (yield* store.readOperation(space, a.selection.operationId))!;
      yield* store.acknowledgeOutbox(
        `sync:${space}:${aOp.operationId}`,
        yield* remoteApproval(aOp),
      );
      const acceptedA = (yield* ports.readItem(a.next, Effect.void))!;
      const regB = (yield* ports.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const b = prepared(regB, 30, acceptedA);
      yield* ports.commit(b, Effect.void);
      const pendingB = (yield* ports.readItem(a.next, Effect.void))!;
      const regC = (yield* ports.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const cBase = prepared(regC, 50, pendingB);
      const cFingerprint = "f".repeat(64);
      const rawC = {
        ...cBase,
        candidate: { ...cBase.candidate, sourceFingerprint: cFingerprint },
        selection: {
          ...cBase.selection,
          selector: { ...cBase.selection.selector, sourceFingerprint: cFingerprint },
        },
        next: {
          ...cBase.next,
          pending: { ...cBase.next.pending!, sourceFingerprint: cFingerprint },
        },
      };
      const cSelection = {
        ...rawC.selection,
        result: { ...rawC.selection.result!, outcome: "conflicted" as const },
      };
      const c = {
        ...rawC,
        selection: cSelection,
        batch: { ...rawC.batch, selections: [cSelection] },
        next: { ...rawC.next, outcome: "conflicted" as const },
        expectedHeads: [b.selection.revisionId],
      };
      yield* ports.commit(c, Effect.void);
      const ack = (p: PreparedImportCommit, outcome: "accepted" | "rejected", sequence: number) =>
        Effect.gen(function* () {
          const saved = (yield* store.receipt(space, p.selection.operationId))!;
          const receipt: M.MemoryHubReceipt = {
            operationId: p.selection.operationId,
            memoryId,
            operationDigest: saved.operationDigest,
            outcome,
            hubSequence: outcome === "accepted" ? sequence : null,
            ...(outcome === "rejected" ? { failureCode: "forgotten" as const } : {}),
          };
          yield* store.acknowledgeOutbox(`sync:${space}:${p.selection.operationId}`, receipt);
          return receipt;
        });
      let bReceipt: M.MemoryHubReceipt;
      let cReceipt: M.MemoryHubReceipt;
      if (order === "C accepted B accepted") {
        cReceipt = yield* ack(c, "accepted", 3);
        bReceipt = yield* ack(b, "accepted", 2);
      } else {
        bReceipt = yield* ack(b, order === "B rejected C accepted" ? "rejected" : "accepted", 2);
        const intermediate = (yield* ports.readItem(a.next, Effect.void))!;
        assert.deepStrictEqual(intermediate.pending, c.next.pending);
        if (order === "B accepted C rejected")
          assert.deepStrictEqual(intermediate.accepted, b.next.pending);
        cReceipt = yield* ack(c, order === "B accepted C rejected" ? "rejected" : "accepted", 3);
      }
      const item = (yield* ports.readItem(a.next, Effect.void))!;
      assert.deepStrictEqual(
        item.accepted,
        order === "B accepted C rejected" ? b.next.pending : c.next.pending,
      );
      assert.strictEqual(item.pending, null);
      assert.strictEqual(
        (yield* ports.readReceipt(b.batch, Effect.void)).items[0]!.outcome,
        bReceipt.outcome === "rejected" ? "rejected" : "revised",
      );
      assert.strictEqual((yield* ports.readReceipt(c.batch, Effect.void)).sessionBodyBytes, 50);
      const before = yield* allMemoryInventory;
      yield* store.acknowledgeOutbox(`sync:${space}:${b.selection.operationId}`, bReceipt);
      yield* store.acknowledgeOutbox(`sync:${space}:${c.selection.operationId}`, cReceipt);
      assert.deepStrictEqual(yield* allMemoryInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect("noop follows reused pending refusal and retains details through 30-day boundary", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const ports = service.importPorts;
      const a = prepared();
      yield* ports.commit(a, Effect.void);
      const reg = (yield* ports.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const raw = prepared(reg, 30, a.next);
      const selection = { ...raw.selection, selector: a.selection.selector, result: null };
      const noop = {
        ...raw,
        selection,
        batch: { ...raw.batch, selections: [selection] },
        candidate: a.candidate,
        next: { ...a.next, outcome: "noop" as const },
        expectedHeads: [a.selection.revisionId],
      };
      yield* ports.commit(noop, Effect.void);
      // Cancellation of transport work is not a canonical settlement.
      yield* store.finishWork(`sync:${space}:${a.selection.operationId}`, "cancelled");
      yield* TestClock.setTime(Date.parse(stamp) + M.MEMORY_IMPORT_BATCH_RETENTION_MS + 1);
      assert.strictEqual(
        (yield* ports.preflightBatch(
          { ...noop.batch, selectionDigest: noop.batch.selectionDigest },
          Effect.void,
        )).kind,
        "completed",
      );
      const op = (yield* store.readOperation(space, a.selection.operationId))!;
      const saved = (yield* store.receipt(space, op.operationId))!;
      const capacity: M.MemoryCapacityExceeded = {
        code: "capacity_exceeded",
        dimension: "import_lineage_records",
        current: 1001,
        limit: 1000,
        reclaimable: 0,
      };
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, {
        operationId: op.operationId,
        memoryId,
        operationDigest: saved.operationDigest,
        outcome: "rejected",
        hubSequence: null,
        failureCode: "capacity_exceeded",
        capacity,
      });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        completed_items_json: string;
      }>`SELECT completed_items_json FROM memory_import_receipts WHERE batch_operation_id=${noop.batch.operationId}`;
      const decoded = yield* decodeReceiptEnvelope(rows[0]!.completed_items_json);
      const receipt = decoded.receipt;
      assert.strictEqual(receipt.items[0]!.issue, "capacity_exceeded");
      assert.deepStrictEqual(receipt.items[0]!.capacity, capacity);
      const failure = yield* ports.readReceipt(noop.batch, Effect.void).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryRpcError");
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport dependent purge accounting", () => {
  it.effect("returns dependent head bytes on forget, rollback, replay and quota reuse", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const a = M.MemoryId.make(uuid(970));
      yield* service.upsert(
        {
          memorySpaceId: space,
          memoryId: a,
          operationId: M.MemoryOperationId.make(uuid(971)),
          baseBoundary: null,
          expectedHeads: [],
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: { text: "synthetic dependency", evidence: [], derivedFromMemoryRevisions: [] },
        },
        Effect.void,
      );
      const source = yield* store.loadAggregate(space, a);
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      yield* service.upsert(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(uuid(972)),
          baseBoundary: null,
          expectedHeads: (yield* store.loadAggregate(space, memoryId)).heads,
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: {
            text: "dependent head bytes",
            evidence: [],
            derivedFromMemoryRevisions: source.heads,
          },
        },
        Effect.void,
      );
      const bytes = Effect.gen(function* () {
        return (yield* sql<{ value: number }>`SELECT value FROM memory_quota_counters
          WHERE space='_hub_global' AND dimension='import_live_bytes'`)[0]!.value;
      });
      assert.strictEqual(yield* bytes, 20);
      const forget = {
        memorySpaceId: space,
        memoryId: a,
        operationId: M.MemoryOperationId.make(uuid(973)),
        expectedHeads: source.heads,
      };
      const before = yield* allMemoryInventory;
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* service.forget(forget, Effect.void);
            assert.strictEqual(yield* bytes, 0);
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          }),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* allMemoryInventory, before);
      yield* service.forget(forget, Effect.void);
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "blocked");
      assert.strictEqual(
        (yield* sql`SELECT * FROM memory_payloads WHERE memory_id=${memoryId}`).length,
        0,
      );
      assert.strictEqual(yield* bytes, 0);
      yield* service.forget(forget, Effect.void);
      assert.strictEqual(yield* bytes, 0);
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(uuid(974)),
          expectedHeads: (yield* store.loadAggregate(space, memoryId)).heads,
        },
        Effect.void,
      );
      assert.strictEqual(yield* bytes, 0);
      const reg = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const next = prepared(reg, 980);
      const freshId = M.MemoryId.make(uuid(990));
      const selection = {
        ...next.selection,
        memoryId: freshId,
        result: null,
        selector: { ...next.selection.selector, sourceItemKey: "quota-reuse" },
      };
      yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_IMPORT_MAX_LIVE_BODY_BYTES - 16}
        WHERE space='_hub_global' AND dimension='import_live_bytes'`;
      yield* service.importPorts.commit(
        {
          ...next,
          selection,
          batch: { ...next.batch, selections: [selection] },
          candidate: {
            ...next.candidate,
            sourceItemKey: "quota-reuse",
            contentFingerprint: "f".repeat(64),
            payload: { ...next.candidate.payload, text: "quota reused new" },
          },
          next: {
            ...next.next,
            memoryId: freshId,
            sourceItemKey: "quota-reuse",
            pending: { ...next.next.pending!, contentFingerprint: "f".repeat(64) },
          },
        },
        Effect.void,
      );
      assert.strictEqual(yield* bytes, M.MEMORY_IMPORT_MAX_LIVE_BODY_BYTES);
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport M3d alias ownership", () => {
  it.effect("rejects forged shared payloads atomically at the canonical Store boundary", () =>
    Effect.gen(function* () {
      yield* setupImport;
      yield* seedMember;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const p = prepared();
      yield* service.importPorts.commit(p, Effect.void);
      const op = (yield* store.readOperation(space, p.selection.operationId))!;
      if (op.kind !== "upsert") return assert.fail("expected upsert");
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, yield* remoteApproval(op));
      const operationId = M.MemoryOperationId.make(uuid(930));
      const forged = {
        ...op,
        operationId,
        expectedHeads: [op.revision.revisionId],
        revision: {
          ...op.revision,
          operationId,
          revisionId: M.MemoryRevisionId.make(uuid(931)),
          parents: [op.revision.revisionId],
        },
        payload: { ...op.payload, text: "forged shared body" },
      };
      const before = yield* allMemoryInventory;
      const failure = yield* store
        .transact(service.admitHubOperationTx({ authority, operation: forged }))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryStoreConflict");
      if (failure._tag === "MemoryStoreConflict")
        assert.strictEqual(failure.code, "identity_mismatch");
      assert.deepStrictEqual(yield* allMemoryInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
});

// Service-level source workload. Factory integration remains a separate L4 gate.
const growthLayer = (filename: string) => {
  const db = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* migration;
      yield* hubMigration;
      yield* searchMigration;
      yield* lineageMigration;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA journal_mode=WAL");
      yield* sql`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_id TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT,occurred_at TEXT,application_event_version INTEGER,aggregate_kind TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,deleted_at TEXT)`;
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
  const quota = Quota.layer.pipe(Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(db))));
  const service = Service.layer.pipe(
    Layer.provideMerge(quota),
    Layer.provide(identity),
    Layer.provide(resolver),
  );
  return Layer.mergeAll(Worker.layer, Hub.layer, Compactor.layer).pipe(
    Layer.provideMerge(service),
    Layer.provideMerge(Maintenance.layer.pipe(Layer.provideMerge(quota))),
    Layer.provideMerge(Hub.activityLayer),
    Layer.provide(
      Layer.succeed(Hub.MemoryHubConfiguration, {
        read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: environmentId }),
      }),
    ),
    Layer.provide(identity),
    Layer.provide(NodeServices.layer),
    Layer.provide(Settings.layerTest({ memoryHub: { mode: "hub", memorySpaceId: space } })),
    Layer.provide(
      Layer.succeed(RuntimeIdentity.RuntimeIdentity, { instanceId: "synthetic-growth" }),
    ),
    Layer.provide(Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty })),
    Layer.provide(
      Layer.mock(Generation.TextGeneration)({
        generateMemorySummary: () => Effect.die("growth fixture must never execute a provider"),
      }),
    ),
  );
};
describe("MemoryImport physical-growth source harness", () => {
  it.effect(
    "records deterministic 64 noop / 16 change / 32 forget-rebuild workload",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          // Preserve synthetic DB and metrics until the remote evidence collector retrieves them.
          const directory = yield* fs.makeTempDirectory({
            directory: yield* Config.String("WP5_GROWTH_ROOT").pipe(
              Config.orElse(() => Config.String("TMPDIR")),
            ),
            prefix: "wp5-growth-",
          });
          yield* Effect.logInfo(`WP5_GROWTH_ARTIFACTS ${directory}`);
          const filename = `${directory}/synthetic.sqlite`;
          yield* Effect.gen(function* () {
            yield* TestClock.setTime(Date.parse(stamp));
            yield* setupImport;
            yield* seedMember;
            const service = yield* Service.MemoryService;
            const ports = service.importPorts;
            const store = yield* Store.MemoryStore;
            const worker = yield* Worker.MemoryWorker;
            const compactor = yield* Compactor.MemoryCompactor;
            const quota = yield* Quota.MemoryQuotaService;
            const hub = yield* Hub.MemoryHubService;
            const sql = yield* SqlClient.SqlClient;
            const items = Array.from({ length: 64 }, (_, i) => ({
              sourceItemKey: `growth-${i}`,
              memoryId: M.MemoryId.make(uuid(10000 + Math.floor(i / 4))),
            }));
            const text = (identity: number, round: number) => {
              const prefix = `Synthetic growth ${identity} round ${round} `;
              return (
                prefix +
                "가".repeat(1300) +
                "x".repeat(4096 - new TextEncoder().encode(prefix).length - 3900)
              );
            };
            const digest = (value: string) =>
              Service.memoryStableUuid(value).replaceAll("-", "").repeat(2);
            let allocation = 20000;
            const footprint = Effect.gen(function* () {
              return {
                counters:
                  yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
                registrations:
                  yield* sql`SELECT receipt_id,registration_json,completed_items_json FROM memory_import_receipts ORDER BY receipt_id`,
                counts:
                  yield* sql`SELECT (SELECT count(*) FROM memory_revisions) AS revisions,(SELECT count(*) FROM memory_payloads) AS bodies,
                  (SELECT count(*) FROM memory_events) AS events,(SELECT count(*) FROM memory_outbox) AS work`,
              };
            });
            const refusals: {
              phase: string;
              round: number;
              dimension: string;
              current: number | undefined;
              limit: number;
            }[] = [];
            const resolutionRefusals: {
              round: number;
              index: number;
              receipt: M.MemoryHubReceipt;
            }[] = [];
            // Replace only model output; use the same lease and canonical Service commit
            // as MemorySyncService.runResolution, without a provider or background timers.
            const resolveChanged = (round: number) =>
              Effect.gen(function* () {
                for (let index = 0; index < 16; index++) {
                  const id = M.MemoryId.make(uuid(10000 + index));
                  const aggregate = yield* store.loadAggregate(space, id);
                  if (aggregate.heads.length <= 1) continue;
                  const conflict = aggregate.conflicts.find((c) => c.status === "quarantined")!;
                  assert.isDefined(conflict);
                  allocation += 4;
                  const operationId = M.MemoryOperationId.make(uuid(allocation));
                  const revisionId = M.MemoryRevisionId.make(uuid(allocation + 1));
                  const resolutionId = M.MemoryResolutionId.make(uuid(allocation + 2));
                  const lease = yield* hub.claim(
                    {
                      protocolVersion: 1,
                      memorySpaceId: space,
                      memoryId: id,
                      holderEnvironmentId: environmentId,
                      conflictId: conflict.conflictId,
                      conflictHeadSet: aggregate.heads,
                      attemptId: M.MemoryOperationId.make(uuid(allocation + 3)),
                      frozenDefaultModelSelection: {
                        instanceId: M.ProviderInstanceId.make("synthetic-growth"),
                        model: "synthetic-model",
                      },
                    },
                    authority.principal,
                  );
                  const head = aggregate.revisions.find(
                    (r) => r.revision.revisionId === aggregate.heads[0],
                  )!;
                  const op: Extract<M.MemoryOperation, { kind: "resolve" }> = {
                    protocolVersion: 1,
                    kind: "resolve",
                    memorySpaceId: space,
                    memoryId: id,
                    originEnvironmentId: environmentId,
                    operationId,
                    expectedHeads: aggregate.heads,
                    conflictId: conflict.conflictId,
                    fencingToken: lease.fencingToken,
                    revision: {
                      ...head.revision,
                      operationId,
                      revisionId,
                      payloadRef: revisionId,
                      parents: aggregate.heads,
                      createdAtUtc: stamp,
                    },
                    payload: {
                      text: text(index, round),
                      evidence: head.payload!.evidence,
                      derivedFromMemoryRevisions: aggregate.heads,
                    },
                    resolution: {
                      resolutionId,
                      memorySpaceId: space,
                      memoryId: id,
                      inputRevisionIds: aggregate.heads,
                      inputPayloadRefs: aggregate.heads.map(
                        (h) =>
                          aggregate.revisions.find((r) => r.revision.revisionId === h)!.revision
                            .payloadRef,
                      ),
                      judgmentRef: resolutionId,
                      requestedModelSelection: lease.frozenDefaultModelSelection,
                      effectiveProvider: M.ProviderDriverKind.make("codex"),
                      effectiveModel: "synthetic-model",
                      resolvingEnvironmentId: environmentId,
                      fencingToken: lease.fencingToken,
                      resultRevisionId: revisionId,
                      appliedAtUtc: stamp,
                      revertDeadlineUtc: M.MemoryUtcTimestamp.make(
                        DateTime.formatIso(
                          DateTime.makeUnsafe(Date.parse(stamp) + M.MEMORY_REVERT_WINDOW_MS),
                        ),
                      ),
                    },
                    resolutionPayload: {
                      resolutionId,
                      judgment: "Synthetic: keep the current source round.",
                    },
                  };
                  const receipt = yield* hub.applyResolution(
                    {
                      protocolVersion: 1,
                      memorySpaceId: space,
                      holderEnvironmentId: environmentId,
                      attemptId: lease.attemptId,
                      operation: op,
                    },
                    authority.principal,
                  );
                  if (receipt.outcome === "rejected") {
                    resolutionRefusals.push({ round, index, receipt });
                    yield* fs.writeFileString(
                      `${directory}/resolution-refusals.json`,
                      encodeUnknown(resolutionRefusals),
                    );
                    continue;
                  }
                  assert.strictEqual(receipt.outcome, "accepted");
                  assert.strictEqual((yield* store.loadAggregate(space, id)).heads.length, 1);
                }
              });
            const runRound = (phase: "seed" | "noop" | "change", round: number) =>
              Effect.gen(function* () {
                if (phase === "change") {
                  const previousRegistration = (yield* ports.readRegistration(
                    { ...address, sourceId, by: "source" },
                    Effect.void,
                  ))!;
                  yield* ports.saveRegistration(
                    {
                      ...address,
                      expectedVersion: previousRegistration.version,
                      next: {
                        ...previousRegistration,
                        version: previousRegistration.version + 1,
                        session: {
                          ...previousRegistration.session!,
                          sessionId: `growth-change-${round}`,
                          newItems: 0,
                          bodyBytes: 0,
                          applied: [],
                        },
                      },
                    },
                    Effect.void,
                  );
                }
                for (let chunk = 0; chunk < 2; chunk++) {
                  const reg = (yield* ports.readRegistration(
                    { ...address, sourceId, by: "source" },
                    Effect.void,
                  ))!;
                  const frozen = items.slice(chunk * 32, (chunk + 1) * 32).map((item, offset) => {
                    allocation += 3;
                    const body = text(
                      Math.floor((chunk * 32 + offset) / 4),
                      phase === "change" ? round : 0,
                    );
                    return {
                      selector: {
                        sourceItemKey: item.sourceItemKey,
                        sourceFingerprint: digest(body),
                        scope: { kind: "user" as const },
                      },
                      memoryId: item.memoryId,
                      operationId: M.MemoryOperationId.make(uuid(allocation)),
                      revisionId: M.MemoryRevisionId.make(uuid(allocation + 1)),
                      result: null,
                    };
                  });
                  allocation += 3;
                  const batchId = M.MemoryOperationId.make(uuid(allocation));
                  let batch: PreparedImportCommit["batch"] = {
                    ...address,
                    kind: "detailed",
                    codecVersion: 1,
                    sourceId,
                    sessionId: reg.session!.sessionId,
                    operationId: batchId,
                    selectionDigest: digest(`${phase}/${round}/${chunk}`),
                    selections: frozen,
                    createdAtUtc: stamp,
                    receipt: {
                      operationId: batchId,
                      sourceId,
                      sessionId: reg.session!.sessionId,
                      state: "partial",
                      remaining: 32,
                      items: [],
                      sessionNewItems: 0,
                      sessionBodyBytes: 0,
                    },
                  };
                  for (const selection of frozen) {
                    const index = items.findIndex(
                      (i) => i.sourceItemKey === selection.selector.sourceItemKey,
                    );
                    const body = text(Math.floor(index / 4), phase === "change" ? round : 0);
                    const previous =
                      (yield* ports.readItem(
                        { ...address, sourceId, sourceItemKey: selection.selector.sourceItemKey },
                        Effect.void,
                      )) ?? null;
                    const target = yield* ports.prepareTarget(
                      {
                        ...address,
                        memoryId: selection.memoryId,
                        scope: { kind: "user" },
                        acceptedRevisionId: previous?.accepted?.revisionId ?? null,
                      },
                      Effect.void,
                    );
                    const outcome: M.MemoryImportOutcome =
                      phase === "noop"
                        ? "noop"
                        : previous
                          ? target.heads.length === 1 &&
                            target.heads[0] === previous.accepted?.revisionId
                            ? "revised"
                            : "conflicted"
                          : target.alias
                            ? "aliased"
                            : "created";
                    const candidate = {
                      sourceItemKey: selection.selector.sourceItemKey,
                      sourceFingerprint: selection.selector.sourceFingerprint,
                      contentFingerprint: digest(body),
                      byteCount: 4096,
                      payload: {
                        text: body,
                        evidence: [
                          { origin: "import" as const, importSourceId: sourceId, messageIds: [] },
                        ],
                        derivedFromMemoryRevisions: [],
                      },
                    };
                    const next: ImportItem = {
                      ...address,
                      sourceId,
                      codecVersion: 1,
                      sourceItemKey: candidate.sourceItemKey,
                      memoryId: selection.memoryId,
                      scope: { kind: "user" },
                      accepted: previous?.accepted ?? null,
                      pending:
                        outcome === "noop"
                          ? (previous?.pending ?? null)
                          : {
                              sourceFingerprint: candidate.sourceFingerprint,
                              contentFingerprint: candidate.contentFingerprint,
                              revisionId: selection.revisionId,
                              operationId: selection.operationId,
                            },
                      rejected: null,
                      outcome,
                    };
                    const currentReg = (yield* ports.readRegistration(
                      { ...address, sourceId, by: "source" },
                      Effect.void,
                    ))!;
                    const beforeCommit = phase === "change" ? yield* footprint : null;
                    const committed = yield* ports
                      .commit(
                        {
                          registration: currentReg,
                          registrationVersion: currentReg.version,
                          batch,
                          selection: batch.selections.find(
                            (s) => s.operationId === selection.operationId,
                          )!,
                          candidate,
                          previous,
                          next,
                          expectedHeads: target.heads,
                          parents: previous?.accepted
                            ? [previous.accepted.revisionId]
                            : target.alias
                              ? [target.alias.revision.revisionId]
                              : [],
                          projectBinding: null,
                        },
                        Effect.void,
                      )
                      .pipe(
                        Effect.catchTags({
                          MemoryCapacityError: (error) =>
                            Effect.gen(function* () {
                              const refusal = {
                                phase,
                                round,
                                dimension: error.dimension,
                                current: error.current,
                                limit: error.limit,
                              };
                              refusals.push(refusal);
                              yield* Console.log(`WP5_GROWTH_REFUSAL ${encodeUnknown(refusal)}`);
                              if (beforeCommit)
                                assert.deepStrictEqual(yield* footprint, beforeCommit);
                              return null;
                            }),
                        }),
                      );
                    if (committed === null) continue;
                    if (outcome !== "noop") {
                      const operation = (yield* store.readWorkOperation(
                        `sync:${space}:${selection.operationId}`,
                      ))!;
                      const receipt = yield* service.admitHubOperation({ authority, operation });
                      if (receipt.outcome === "rejected") {
                        assert.strictEqual(
                          receipt.failureCode,
                          "capacity_exceeded",
                          encodeUnknown({ phase, round, index, receipt }),
                        );
                        assert.isDefined(receipt.capacity);
                        yield* Console.log(
                          `WP5_GROWTH_HUB_REFUSAL ${encodeUnknown({ phase, round, index, capacity: receipt.capacity })}`,
                        );
                      }
                      yield* store.acknowledgeOutbox(
                        `sync:${space}:${selection.operationId}`,
                        receipt,
                      );
                    }
                    const preflight = yield* ports.preflightBatch(
                      { ...batch, selectionDigest: batch.selectionDigest },
                      Effect.void,
                    );
                    if (preflight.kind === "partial") batch = preflight.batch;
                  }
                }
                if (phase === "change") yield* resolveChanged(round);
                yield* worker.drain;
              }).pipe(
                Effect.tapError((error) =>
                  Console.log(
                    `WP5_GROWTH_REFUSAL ${encodeUnknown({
                      phase,
                      round,
                      tag: error._tag,
                      ...(error._tag === "MemoryCapacityError"
                        ? { dimension: error.dimension, current: error.current, limit: error.limit }
                        : {}),
                    })}`,
                  ),
                ),
              );
            const samples: unknown[] = [];
            const csv = [
              "phase,iteration,clock,page_size,page_count,freelist_count,used_bytes,allocated_bytes,wal_bytes,identities,bodies,body_bytes,revisions,lineage,fts_rows,active,receipts,suppression",
            ];
            const sample = (phase: string, iteration: number) =>
              Effect.gen(function* () {
                yield* worker.drain;
                const checkpoint = yield* sql.unsafe<{
                  busy: number;
                  log: number;
                  checkpointed: number;
                }>("PRAGMA wal_checkpoint(PASSIVE)");
                const pages = (yield* sql.unsafe<{ page_count: number }>("PRAGMA page_count"))[0]!
                  .page_count;
                const pageSize = (yield* sql.unsafe<{ page_size: number }>("PRAGMA page_size"))[0]!
                  .page_size;
                const free = (yield* sql.unsafe<{ freelist_count: number }>(
                  "PRAGMA freelist_count",
                ))[0]!.freelist_count;
                const walBytes = yield* fs.stat(`${filename}-wal`).pipe(
                  Effect.map((s) => Number(s.size)),
                  Effect.orElseSucceed(() => null),
                );
                const growth = yield* quota.recordStorageSample(environmentId, { walBytes });
                const counts = (yield* sql<{
                  identities: number;
                  bodies: number;
                  bodyBytes: number;
                  revisions: number;
                  lineage: number;
                  fts: number;
                  active: number;
                  receipts: number;
                  suppression: number;
                }>`SELECT
            (SELECT count(*) FROM memory_identity_ledger WHERE space=${space}) AS identities,
            (SELECT count(*) FROM memory_payloads WHERE space=${space}) AS bodies,
            (SELECT coalesce(sum(length(CAST(body_json AS BLOB))),0) FROM memory_payloads WHERE space=${space}) AS bodyBytes,
            (SELECT count(*) FROM memory_revisions WHERE space=${space}) AS revisions,
            (SELECT count(*) FROM memory_import_lineage WHERE space=${space}) AS lineage,
            (SELECT count(*) FROM memory_items_fts) AS fts,
            (SELECT count(*) FROM memory_items WHERE space=${space} AND status='active') AS active,
            (SELECT count(*) FROM memory_import_receipts WHERE space=${space}) AS receipts,
            (SELECT count(*) FROM memory_import_keys WHERE space=${space} AND key_kind IN ('sourceKey','content','sourceExclusion')) AS suppression`)[0]!;
                const metrics = {
                  phase,
                  iteration,
                  clock: yield* Clock.currentTimeMillis,
                  seed: "wp5-growth-v1",
                  allowanceBytes: 1048576,
                  drain: "MemoryWorker.drain",
                  pageSize,
                  pages,
                  free,
                  usedBytes: (pages - free) * pageSize,
                  allocatedBytes: pages * pageSize,
                  walBytes,
                  checkpoint: checkpoint[0] ?? null,
                  sample: growth.current,
                  freshAllocation: yield* store.measureAllocation(),
                  freshLogicalBytes: yield* store.logicalBytes,
                  counts,
                };
                samples.push(metrics);
                csv.push(
                  [
                    phase,
                    iteration,
                    metrics.clock,
                    pageSize,
                    pages,
                    free,
                    metrics.usedBytes,
                    metrics.allocatedBytes,
                    walBytes ?? "unavailable",
                    counts.identities,
                    counts.bodies,
                    counts.bodyBytes,
                    counts.revisions,
                    counts.lineage,
                    counts.fts,
                    counts.active,
                    counts.receipts,
                    counts.suppression,
                  ].join(","),
                );
                yield* fs.writeFileString(`${directory}/samples.json`, encodeUnknown(samples));
                yield* fs.writeFileString(`${directory}/samples.csv`, csv.join("\n") + "\n");
                yield* Console.log(`WP5_GROWTH_SAMPLE ${encodeUnknown(metrics)}`);
                return metrics;
              });
            yield* runRound("seed", 0);
            const baseline = yield* sample("seed", 0);
            assert.strictEqual(baseline.counts.identities, 16);
            assert.strictEqual(baseline.counts.bodies, 16);
            const noopSamples: (typeof baseline)[] = [];
            for (let round = 1; round <= 64; round++) {
              yield* runRound("noop", round);
              if (round % 16 === 0) {
                const measured = yield* sample("noop", round);
                assert.deepStrictEqual(
                  [
                    measured.counts.identities,
                    measured.counts.bodies,
                    measured.counts.bodyBytes,
                    measured.counts.revisions,
                    measured.counts.lineage,
                    measured.counts.fts,
                  ],
                  [
                    baseline.counts.identities,
                    baseline.counts.bodies,
                    baseline.counts.bodyBytes,
                    baseline.counts.revisions,
                    baseline.counts.lineage,
                    baseline.counts.fts,
                  ],
                );
                noopSamples.push(measured);
              }
            }
            for (let round = 1; round <= 16; round++) {
              yield* runRound("change", round);
              if (round % 4 === 0) yield* sample("change", round);
            }
            const changed = yield* sample("change", 16);
            const oldHeads = new Map<M.MemoryId, M.MemoryRevisionId>();
            for (let index = 0; index < 16; index++) {
              const id = M.MemoryId.make(uuid(10000 + index));
              const target = yield* store.loadAggregate(space, id);
              oldHeads.set(id, target.heads[0]!);
              const operationId = M.MemoryOperationId.make(uuid(90000 + index));
              yield* service.forget(
                { memorySpaceId: space, memoryId: id, operationId, expectedHeads: target.heads },
                Effect.void,
              );
              const operation = (yield* store.readWorkOperation(`sync:${space}:${operationId}`))!;
              const receipt = yield* store.transact(
                service.admitHubOperationTx({ authority, operation }),
              );
              yield* store.acknowledgeOutbox(`sync:${space}:${operationId}`, receipt);
            }
            yield* worker.drain;
            const horizon = Math.max(
              M.MEMORY_IMPORT_BATCH_RETENTION_MS,
              M.MEMORY_LOG_RETENTION_MS,
              M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS,
            );
            const rebuildSamples: (typeof baseline)[] = [];
            for (let cycle = 1; cycle <= 32; cycle++) {
              yield* TestClock.setTime(Date.parse(stamp) + cycle * (horizon - 1));
              yield* compactor.compact(authority.principal);
              yield* worker.drain;
              for (const [id, revisionId] of oldHeads) {
                const current = yield* store.loadAggregate(space, id);
                yield* store.enqueueWork({
                  id: `growth-rebuild:${cycle}:${id}`,
                  space,
                  memoryId: id,
                  kind: "rebuild",
                  status: "pending",
                  metadata: { kind: "rebuild", revisionId, generation: current.generation },
                  payloadRef: null,
                  attempt: 0,
                  nextAttemptAt: 0,
                  claimedBy: null,
                  claimedUntil: null,
                });
              }
              yield* worker.drain;
              const measured = yield* sample("rebuild", cycle);
              assert.strictEqual(measured.counts.bodies, 0);
              assert.strictEqual(measured.counts.fts, 0);
              rebuildSamples.push(measured);
            }
            // Keep unsupported metrics explicit. Source measurements do not certify packaging.
            const spread = (samples: readonly (typeof baseline)[]) =>
              Math.max(...samples.map((s) => s.usedBytes)) -
              Math.min(...samples.map((s) => s.usedBytes));
            const gates = {
              noopSpreadBytes: spread(noopSamples),
              rebuildSpreadBytes: spread(rebuildSamples.slice(8)),
              activeAfterChange: changed.counts.active,
              resolutionRefusals,
              refusals,
              allowanceBytes: 1048576,
              packaged: "NOT_RUN",
            };
            yield* fs.writeFileString(`${directory}/gates.json`, encodeUnknown(gates));
            yield* Console.log(`WP5_GROWTH_GATES ${encodeUnknown(gates)}`);
            assert.isEmpty(resolutionRefusals, "synthetic resolutions must all be admitted");
            assert.strictEqual(
              changed.counts.active,
              16,
              "all changed aliases must converge to 16 live identities",
            );
            assert.isAtMost(
              spread(noopSamples),
              1048576,
              "noop physical growth must plateau after warmup",
            );
            assert.isAtMost(
              spread(rebuildSamples.slice(8)),
              1048576,
              "forget-rebuild physical growth must plateau after warmup",
            );
          }).pipe(Effect.provide(growthLayer(filename)));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 1800000 },
  );
});
