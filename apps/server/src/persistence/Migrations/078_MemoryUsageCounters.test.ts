import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./078_MemoryUsageCounters.ts";
import * as Store from "../../memory/MemoryStore.ts";
import { assertUsageCounters } from "../../memory/MemoryUsageScan.testkit.ts";

const database = Layer.effectDiscard(runMigrations({ toMigrationInclusive: 77 })).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const live = Store.layer.pipe(Layer.provideMerge(database));
it.effect(
  "078 backfills populated spaces once, rolls DDL/accounting back, and survives restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const space of [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ]) {
        yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) VALUES (${space},'memory','{"kind":"user"}','user','["revision"]','active',0,'{}','{}')`;
        yield* sql`INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${space},'revision','memory','op','[]','{"kind":"user"}','inference','{"sourceThread":"synthetic"}','payload',0)`;
        yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},'payload','memory','{"text":"한글"}','[]'),(${space},'history','memory','{"text":"old"}','[]')`;
        yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys) VALUES (${space},'memory','{}','{}',100,2)`;
        yield* sql`INSERT INTO memory_events(protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,${space},'memory','op','upsert','synthetic','digest','{}','{}',0)`;
        yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json) VALUES (${space},'op','digest',1,'{}','{}')`;
        yield* sql`INSERT INTO memory_import_lineage(space,memory_id,kind,key,record_json) VALUES (${space},'memory','content','key','{}')`;
        yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'content','key','memory','{}')`;
      }
      const before =
        yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
      yield* sql
        .withTransaction(migration.pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.exit);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
        before,
      );
      assert.deepStrictEqual(yield* runMigrations(), [[78, "MemoryUsageCounters"]]);
      yield* assertUsageCounters;
      assert.deepStrictEqual(yield* runMigrations(), []);
      yield* assertUsageCounters;
      yield* sql`DELETE FROM memory_compact_receipts`;
      yield* assertUsageCounters;
      yield* sql`DELETE FROM memory_events`;
      yield* assertUsageCounters;
      yield* sql`DELETE FROM memory_payloads`;
      yield* assertUsageCounters;
    }).pipe(Effect.provide(live)),
);
