import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/070_Memory.ts";
import hubMigration from "../persistence/Migrations/071_MemoryHubSync.ts";
import searchMigration from "../persistence/Migrations/072_MemorySearchCounters.ts";
import lineageMigration from "../persistence/Migrations/074_MemoryImportLineage.ts";
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
