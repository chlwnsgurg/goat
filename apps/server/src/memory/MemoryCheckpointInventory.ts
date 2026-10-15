import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";

export const checkpointKeys = [
  "items",
  "revisions",
  "tombstones",
  "conflicts",
  "resolutions",
  "compactReceipts",
  "identities",
  "fences",
  "suppressions",
  "importLineage",
] as const;
export type CheckpointInventory = {
  -readonly [K in (typeof checkpointKeys)[number]]: M.MemoryHubCheckpointPage[K][number][];
};
export const emptyCheckpointInventory = (): CheckpointInventory => ({
  items: [],
  revisions: [],
  tombstones: [],
  conflicts: [],
  resolutions: [],
  compactReceipts: [],
  identities: [],
  fences: [],
  suppressions: [],
  importLineage: [],
});
const strict = { onExcessProperty: "error" } as const;
const jsonDecoder = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return (json: string) => decode(json, strict);
};
const valueDecoder = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown) => decode(value, strict);
};
const decodeIdentity = jsonDecoder(M.MemoryIdentityRecord);
const decodeFence = jsonDecoder(M.MemoryFenceRecord);
const decodeLineage = jsonDecoder(M.MemoryImportLineageRecord);
const decodeProjection = jsonDecoder(Schema.Record(Schema.String, Schema.Unknown));
const decodePayload = jsonDecoder(M.MemoryPayload);
const decodeHeads = jsonDecoder(Schema.Array(M.MemoryRevisionId));
const decodeSuppression = jsonDecoder(M.MemorySuppressionRecord);
const decodeResolution = jsonDecoder(M.MemoryResolution);
const decodeJudgment = jsonDecoder(M.MemoryResolutionPayload);
const decodeScope = jsonDecoder(M.MemoryScope);
const decodeProvenance = jsonDecoder(M.MemoryProvenance);
const decodeCompact = jsonDecoder(M.MemoryCompactReceipt);
const decodeItem = valueDecoder(M.MemoryItem);
const decodeTombstone = valueDecoder(M.MemoryTombstone);
const decodeRevision = valueDecoder(M.MemoryRevision);
const decodeConflict = valueDecoder(M.MemoryConflict);
const validatePage = Schema.decodeUnknownEffect(M.MemoryHubCheckpointPage);
const timestamp = (n: number) => DateTime.formatIso(DateTime.makeUnsafe(n));

/** These are JSON objects in the page, never JSON strings containing encoded JSON. */
export const encodeCheckpointRecord = (
  record: CheckpointInventory[(typeof checkpointKeys)[number]][number],
) => JSON.stringify(record);
export const checkpointInventorySize = (inventory: CheckpointInventory) => {
  let bytes = 0;
  let rows = 0;
  for (const key of checkpointKeys)
    for (const record of inventory[key]) {
      bytes += new TextEncoder().encode(encodeCheckpointRecord(record)).length;
      rows++;
    }
  return { bytes, rows };
};

/** Shared by admission, migration and publication. Only this memory's selected pairs are loaded. */
export const selectCheckpointMemory = Effect.fnUntraced(function* (
  space: M.MemorySpaceId,
  id: M.MemoryId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const all = emptyCheckpointInventory();
  const ledgers = yield* sql<{
    identity_json: string;
    fence_json: string;
  }>`SELECT identity_json,fence_json FROM memory_identity_ledger WHERE space=${space} AND memory_id=${id}`;
  if (!ledgers[0]) return all;
  all.identities.push(yield* decodeIdentity(ledgers[0].identity_json));
  all.fences.push(yield* decodeFence(ledgers[0].fence_json));
  const lineage = yield* sql<{
    record_json: string;
  }>`SELECT record_json FROM memory_import_lineage WHERE space=${space} AND memory_id=${id} ORDER BY kind,key`;
  for (const row of lineage) all.importLineage.push(yield* decodeLineage(row.record_json));
  const items = yield* sql<{
    item_json: string;
    heads_json: string;
    body_json: string | null;
  }>`SELECT i.item_json,i.heads_json,p.body_json FROM memory_items i LEFT JOIN memory_payloads p ON p.space=i.space AND p.payload_ref=i.payload_ref WHERE i.space=${space} AND i.memory_id=${id}`;
  const row = items[0];
  let heads: readonly M.MemoryRevisionId[] = [];
  if (row) {
    const projection = yield* decodeProjection(row.item_json);
    const unsent =
      yield* sql`SELECT 1 FROM memory_outbox WHERE space=${space} AND memory_id=${id} AND kind IN ('sync','revert_intent') AND status IN ('pending','retry','running') LIMIT 1`;
    const item = yield* decodeItem(
      projection.status === "active"
        ? row.body_json
          ? {
              ...projection,
              payload: yield* decodePayload(row.body_json),
              pendingSync: unsent.length > 0,
            }
          : {
              memorySpaceId: space,
              memoryId: id,
              status: "blocked",
              scope: projection.scope,
              pendingSync: unsent.length > 0,
              failureCode: "source_invalidated",
              localAvailability: {
                exposure: "held",
                reasons: ["dependency_invalidated"],
                deferred: [],
                cleanupPending: true,
              },
            }
        : { ...projection, pendingSync: unsent.length > 0 },
    );
    all.items.push(
      item.status === "forgotten"
        ? {
            ...item,
            tombstone: {
              ...item.tombstone,
              suppressedSourceKeys: [],
              suppressedContent: [],
              sourceExclusions: [],
            },
          }
        : item,
    );
    heads = yield* decodeHeads(row.heads_json);
  }
  const tombstones = yield* sql<{
    delete_operation_id: string;
    deleting_environment_id: string;
    deleted_at: number;
  }>`SELECT * FROM memory_tombstones WHERE space=${space} AND memory_id=${id}`;
  const t = tombstones[0];
  if (t) {
    all.tombstones.push(
      yield* decodeTombstone({
        memorySpaceId: space,
        memoryId: id,
        deleteOperationId: t.delete_operation_id,
        deletingEnvironmentId: t.deleting_environment_id,
        deletedAtUtc: timestamp(t.deleted_at),
        suppressedSourceKeys: [],
        suppressedContent: [],
        sourceExclusions: [],
      }),
    );
    const suppressions = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND memory_id=${id} AND key_kind IN ('sourceKey','content','sourceExclusion') ORDER BY key_kind,key`;
    for (const r of suppressions) all.suppressions.push(yield* decodeSuppression(r.record_json));
    return all;
  }
  const resolutions = yield* sql<{
    resolution_json: string;
    body_json: string | null;
  }>`SELECT r.resolution_json,p.body_json FROM memory_resolutions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.judgment_payload_ref WHERE r.space=${space} AND r.memory_id=${id} AND r.revert_deadline>${now} ORDER BY r.resolution_id`;
  for (const r of resolutions)
    all.resolutions.push({
      resolution: yield* decodeResolution(r.resolution_json),
      payload: r.body_json ? yield* decodeJudgment(r.body_json) : null,
    });
  const needed = new Set([
    ...heads,
    ...all.resolutions.flatMap(({ resolution: r }) => [...r.inputRevisionIds, r.resultRevisionId]),
  ]);
  // A shared payload is deliberately joined once per revision, including aliases.
  const revisions = needed.size
    ? yield* sql<{
        revision_id: string;
        operation_id: string;
        parents_json: string;
        scope_json: string;
        assertion_kind: string;
        provenance_json: string;
        payload_ref: string | null;
        created_at: number;
        body_json: string | null;
      }>`SELECT r.*,p.body_json FROM memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref WHERE r.space=${space} AND r.memory_id=${id} AND r.revision_id IN ${sql.in([...needed])} ORDER BY r.revision_id`
    : [];
  for (const r of revisions)
    all.revisions.push({
      revision: yield* decodeRevision({
        memorySpaceId: space,
        memoryId: id,
        revisionId: r.revision_id,
        operationId: r.operation_id,
        parents: yield* decodeHeads(r.parents_json),
        scope: yield* decodeScope(r.scope_json),
        assertionKind: r.assertion_kind,
        provenance: yield* decodeProvenance(r.provenance_json),
        payloadRef: r.payload_ref ?? r.revision_id,
        createdAtUtc: timestamp(r.created_at),
      }),
      payload: r.body_json ? yield* decodePayload(r.body_json) : null,
    });
  const conflicts = yield* sql<{
    conflict_id: string;
    heads_json: string;
    status: string;
    failure_code: string | null;
  }>`SELECT * FROM memory_conflicts WHERE space=${space} AND memory_id=${id} AND status!='resolved' ORDER BY conflict_id`;
  for (const c of conflicts)
    all.conflicts.push(
      yield* decodeConflict({
        conflictId: c.conflict_id,
        memorySpaceId: space,
        memoryId: id,
        heads: yield* decodeHeads(c.heads_json),
        status: c.status,
        ...(c.failure_code ? { failureCode: c.failure_code } : {}),
      }),
    );
  return all;
});

export const selectCheckpointReceipt = Effect.fnUntraced(function* (
  space: M.MemorySpaceId,
  operationId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    compact_json: string;
  }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND operation_id=${operationId}`;
  const all = emptyCheckpointInventory();
  if (rows[0]) all.compactReceipts.push(yield* decodeCompact(rows[0].compact_json));
  return all;
});

/** Validation and literal object insertion keep escaping identical to record accounting. */
export const encodeCheckpointPage = (page: M.MemoryHubCheckpointPage) =>
  validatePage(page, strict).pipe(
    Effect.map(
      () =>
        `{${Object.entries(page)
          .map(
            ([key, value]) =>
              `${JSON.stringify(key)}:${checkpointKeys.includes(key as (typeof checkpointKeys)[number]) ? `[${(value as CheckpointInventory[(typeof checkpointKeys)[number]]).map(encodeCheckpointRecord).join(",")}]` : JSON.stringify(value)}`,
          )
          .join(",")}}`,
    ),
  );
