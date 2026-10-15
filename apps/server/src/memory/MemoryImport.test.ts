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
const remoteApproval = (operation: M.MemoryOperation, forgotten = false) =>
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
    return yield* (yield* Store.MemoryStore).transact(
      service.admitHubOperationTx({ authority, operation }),
    );
  }).pipe(Effect.provide(Layer.fresh(importLive)));
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
  for (const outcome of ["rejected", "suppressed"] as const) {
    for (const race of ["binding", "deletion"] as const) {
      it.effect(`metadata ${outcome} refuses ${race} before durable mutation`, () =>
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
    }
  }
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
      const targetReceipt = yield* service.upsert(
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
      const targetRev = targetReceipt.receipt.revisionId!;
      const operation = (yield* store.readOperation(space, targetOp))!;
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
      assert.strictEqual((yield* service.importPorts.commit(p, Effect.void)).outcome, "aliased");
      const op = yield* store.readOperation(space, p.selection.operationId);
      if (op?.kind !== "upsert") return assert.fail("expected alias intent");
      assert.deepStrictEqual(op.revision.parents, [targetRev]);
      assert.deepStrictEqual(
        (yield* service.importPorts.readItem(item, Effect.void))?.pending,
        p.next.pending,
      );
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
