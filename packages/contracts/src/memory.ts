import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { EnvironmentId, EventId, MessageId, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { ScopedThreadRef, ScopedProjectRef } from "./environment.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const utf8 = (s: string) => new TextEncoder().encode(s).length;
const jsonBytes = (value: unknown) => utf8(JSON.stringify(value));
const unique = (values: readonly unknown[]) =>
  new Set(values.map((v) => JSON.stringify(v))).size === values.length;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));
const bounded = <S extends Schema.Top>(schema: S, max: number) =>
  schema.check(
    Schema.makeFilter((value) => jsonBytes(value) <= max, {
      expected: `at most ${max} encoded UTF-8 bytes`,
    }),
  );
const array = <S extends Schema.Top>(schema: S, max = 100, min = 0) =>
  Schema.Array(schema).check(
    Schema.makeFilter((values) => values.length >= min && values.length <= max),
  );
const distinct = <S extends Schema.Top>(schema: S, max = 100, min = 0) =>
  array(schema, max, min).check(Schema.makeFilter(unique));
// Effect 4 annotations cannot set parse options. A declaration keeps strict parsing
// at the schema boundary, including flipped (encode) and type-only (.make) codecs.
const strictSchema = <S extends Schema.Constraint>(schema: S) =>
  Schema.declareConstructor<S["Type"], S["Encoded"]>()(
    [schema],
    ([codec]) => {
      const decode = SchemaParser.decodeUnknownEffect(codec);
      return (input, _ast, options) => decode(input, { ...options, onExcessProperty: "error" });
    },
    {
      toCodec: ([codec]) => new SchemaAST.Link(codec.ast, SchemaTransformation.passthrough()),
      // All memory Encoded values already use JSON. Do not insert a permissive
      // struct parser ahead of this declaration when RPC derives its JSON codec.
      toCodecJson: () => undefined,
    },
  );
const struct = <F extends Schema.Struct.Fields>(fields: F) => strictSchema(Schema.Struct(fields));
const canonical = Schema.String.check(
  Schema.makeFilter((s) => s.length > 0 && s === s.trim() && Array.from(s).length <= 1024),
);
const text = Schema.String.check(
  Schema.makeFilter((s) => s.trim().length > 0 && utf8(s) <= MEMORY_BODY_MAX_UTF8_BYTES),
);
const digest = Schema.String.check(Schema.makeFilter((s) => /^[0-9a-f]{64}$/.test(s)));
const key = canonical.check(Schema.makeFilter((s) => utf8(s) <= 512));
const uuid = Schema.String.check(
  Schema.makeFilter(
    (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s),
    { expected: "a lowercase UUID" },
  ),
);
export const MemoryUtcTimestamp = Schema.String.check(
  Schema.makeFilter(
    (s) => Number.isFinite(Date.parse(s)) && DateTime.formatIso(DateTime.makeUnsafe(s)) === s,
  ),
);
export const MEMORY_PROTOCOL_VERSION = 1;
export const MEMORY_CONTEXT_MAX_CHARS = 6000;
export const MEMORY_CONTEXT_MAX_UTF8_BYTES = 24 * 1024;
export const MEMORY_CONTEXT_OUTER_FRAME = "<external_goat_memory></external_goat_memory>";
export const MEMORY_PAGE_MAX_ITEMS = 100;
export const MEMORY_PAGE_MAX_UTF8_BYTES = 64 * 1024;
export const MEMORY_PAYLOAD_MAX_UTF8_BYTES = 64 * 1024;
export const MEMORY_LEASE_MS = 120000;
export const MEMORY_LEASE_RENEW_MS = 30000;
export const MEMORY_RESOLUTION_ATTEMPT_MAX_MS = 600000;
export const MEMORY_SOURCE_READ_TIMEOUT_MS = 75000;
export const MEMORY_SOURCE_READ_POLL_MS = 1000;
export const MEMORY_DEFERRED_SWEEP_MAX_ITEMS = 256;
export const MEMORY_DEFERRED_SWEEP_MAX_BYTES = 8 * 1024 * 1024;
export const MEMORY_BODY_MAX_UTF8_BYTES = 16384;
export const MEMORY_USER_MAX_ITEMS = 2000;
export const MEMORY_PROJECT_MAX_ITEMS = 2000;
export const MEMORY_THREAD_MAX_SUMMARIES = 1;
export const MEMORY_THREAD_MAX_EXPLICIT_ITEMS = 100;
export const MEMORY_SPACE_MAX_LIVE_ITEMS = 20000;
export const MEMORY_ENVIRONMENT_MAX_LIVE_ITEMS = 20000;
export const MEMORY_LIVE_MAX_PAYLOAD_BYTES = 134217728;
export const MEMORY_SUBSTRING_MAX_ITEMS = 2000;
export const MEMORY_SUBSTRING_MAX_UTF8_BYTES = 8388608;
export const MEMORY_TRIGRAM_EXPERIMENT_MAX_BODY_BYTES = 33554432;
export const MEMORY_TRIGRAM_EXPERIMENT_MAX_ITEMS = 5000;
export const MEMORY_TRIGRAM_EXPERIMENT_MAX_ALLOCATED_BYTES = 67108864;
export const MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES = 8388608;
export const MEMORY_IMPORT_PREVIEW_MAX_ITEMS = 128;
export const MEMORY_IMPORT_APPLY_MAX_ITEMS = 32;
export const MEMORY_IMPORT_SESSION_MAX_NEW_ITEMS = 128;
export const MEMORY_IMPORT_SESSION_MAX_BODY_BYTES = 2097152;
export const MEMORY_IMPORT_MAX_LIVE_ITEMS = 10000;
export const MEMORY_IMPORT_MAX_LIVE_BODY_BYTES = 67108864;
export const MEMORY_IMPORT_MAX_SOURCE_ITEMS = 50000;
export const MEMORY_IMPORT_MAX_ALIASES = 100000;
export const MEMORY_IMPORT_MAX_CONTENT_DIGESTS = 100000;
export const MEMORY_IMPORT_KEY_MAX_UTF8_BYTES = 512;
export const MEMORY_IMPORT_DIGEST_MAX_UTF8_BYTES = 64;
export const MEMORY_REVERT_WINDOW_MS = 2592000000;
export const MEMORY_REPLACED_PAYLOAD_RETENTION_MS = 2592000000;
export const MEMORY_RESOLUTION_PAYLOAD_RETENTION_MS = 2592000000;
export const MEMORY_HISTORY_MAX_PAYLOAD_BYTES = 134217728;
export const MEMORY_CHECKPOINT_INTERVAL_MS = 86400000;
export const MEMORY_CHECKPOINT_TRIGGER_TAIL_ROWS = 10000;
export const MEMORY_CHECKPOINT_TRIGGER_TAIL_BYTES = 33554432;
export const MEMORY_LOG_RETENTION_MS = 2592000000;
export const MEMORY_LOG_MAX_TAIL_ROWS = 50000;
export const MEMORY_LOG_MAX_TAIL_BYTES = 67108864;
export const MEMORY_CANONICAL_STAGING_MAX_BYTES = 536870912;
export const MEMORY_FTS_INDEXED_TEXT_MAX_BYTES = 134217728;
export const MEMORY_FTS_ALLOCATED_WARNING_BYTES = 100663296;
export const MEMORY_FTS_ALLOCATED_BRAKE_BYTES = 134217728;
export const MEMORY_FTS_ALLOCATED_RESUME_BYTES = 100663296;
export const MEMORY_STORAGE_SAMPLE_MAX_DAYS = 30;
export const MEMORY_STORAGE_SAMPLE_MAX_UTF8_BYTES = 16384;
export const MEMORY_STORAGE_SAMPLE_MAX_TABLES = 64;
export const MEMORY_PERMANENT_METADATA_MAX_BYTES = 134217728;
export const MEMORY_MAX_LIFETIME_IDS = 50000;
export const MEMORY_IDENTITY_CORE_MAX_BYTES = 1024;
export const MEMORY_DEDUP_MAX_RECEIPTS = 250000;
export const MEMORY_COMPACT_RECEIPT_MAX_BYTES = 256;
export const MEMORY_IMPORT_BATCH_RETENTION_MS = 2592000000;
export const MEMORY_REPORT_DETAIL_RETENTION_MS = 2592000000;
export const MEMORY_SOURCE_READ_MAX_PER_ENVIRONMENT = 32;
export const MEMORY_SOURCE_READ_MAX_PER_HUB = 128;
export const MEMORY_SOURCE_READ_OUTCOME_MAX_BYTES = 65536;
export const MEMORY_REPORT_MAX_PENDING_ITEMS = 2000;
export const MEMORY_REPORT_MAX_PENDING_BYTES = 2097152;
export const MEMORY_REPORT_MAX_AUTOMATIC_ATTEMPTS = 10;
export const MEMORY_WORK_MAX_PENDING_ITEMS = 10000;
export const MEMORY_WORK_MAX_PAYLOAD_BYTES = 33554432;
export const MEMORY_HUB_MAX_MEMBERS = 128;
export const MEMORY_CHECKPOINT_MAX_HANDLES_PER_MEMBER = 1;
export const MEMORY_CHECKPOINT_MAX_HANDLES_PER_HUB = 128;
export const MEMORY_CHECKPOINT_TOKEN_TTL_MS = 600000;
export const MEMORY_CAUSAL_BOUNDARY_ID_MAX_UTF8_BYTES = 64;
export const MEMORY_CHECKPOINT_STAGING_MAX_BYTES = 134217728;
export const MEMORY_DERIVED_CACHE_MAX_BYTES = 33554432;
export const MEMORY_DERIVED_CACHE_TTL_MS = 600000;
export const MEMORY_FTS_MERGE_TRIGGER_CHANGES = 1000;
export const MEMORY_FTS_MERGE_INTERVAL_MS = 86400000;
export const MEMORY_FTS_MERGE_MAX_PAGES = 64;
export const MEMORY_FTS_OPTIMIZE_INTERVAL_MS = 604800000;
export const MEMORY_RESOLUTION_MAX_ACTIVE = 4;
export const MEMORY_QUOTA_WARNING_RATIO = 0.8;
export const MEMORY_QUOTA_CRITICAL_RATIO = 0.9;
export const MEMORY_QUOTA_REJECT_RATIO = 1.0;
export const MEMORY_FREELIST_WARNING_RATIO = 0.2;
export const MEMORY_FREELIST_WARNING_MIN_BYTES = 67108864;

export const MemoryId = uuid.pipe(Schema.brand("MemoryId"));
export type MemoryId = typeof MemoryId.Type;

export const MemorySpaceId = uuid.pipe(Schema.brand("MemorySpaceId"));
export type MemorySpaceId = typeof MemorySpaceId.Type;

export const MemoryRevisionId = uuid.pipe(Schema.brand("MemoryRevisionId"));
export type MemoryRevisionId = typeof MemoryRevisionId.Type;

export const MemoryOperationId = uuid.pipe(Schema.brand("MemoryOperationId"));
export type MemoryOperationId = typeof MemoryOperationId.Type;

export const MemoryConflictId = uuid.pipe(Schema.brand("MemoryConflictId"));
export type MemoryConflictId = typeof MemoryConflictId.Type;

export const MemoryResolutionId = uuid.pipe(Schema.brand("MemoryResolutionId"));
export type MemoryResolutionId = typeof MemoryResolutionId.Type;

export const MemoryImportSourceId = uuid.pipe(Schema.brand("MemoryImportSourceId"));
export type MemoryImportSourceId = typeof MemoryImportSourceId.Type;

export const MemorySourceReadRequestId = uuid.pipe(Schema.brand("MemorySourceReadRequestId"));
export type MemorySourceReadRequestId = typeof MemorySourceReadRequestId.Type;

export const MemoryModelSelection = struct({
  instanceId: canonical.pipe(Schema.brand("ProviderInstanceId")),
  model: canonical,
  options: Schema.optionalKey(
    distinct(struct({ id: canonical, value: Schema.Union([canonical, Schema.Boolean]) })).check(
      Schema.makeFilter((options) => unique(options.map((o) => o.id))),
    ),
  ),
});
export type MemoryModelSelection = typeof MemoryModelSelection.Type;

export const MemoryProjectKey = Schema.Union([
  struct({ kind: Schema.Literal("repository"), groupingKey: canonical }),
  struct({ kind: Schema.Literal("explicit"), sharedProjectId: key }),
]);
export type MemoryProjectKey = typeof MemoryProjectKey.Type;

export const MemoryScope = Schema.Union([
  struct({ kind: Schema.Literal("user") }),
  struct({ kind: Schema.Literal("project"), projectKey: MemoryProjectKey }),
  struct({
    kind: Schema.Literal("thread"),
    thread: ScopedThreadRef,
    projectKey: Schema.optionalKey(MemoryProjectKey),
  }),
]);
export type MemoryScope = typeof MemoryScope.Type;

export const MemoryAssertionKind = Schema.Literals(["fact", "inference"]);
export type MemoryAssertionKind = typeof MemoryAssertionKind.Type;

export const MemoryProviderCapabilities = struct({
  snapshot: Schema.Boolean,
  mcp: Schema.Boolean,
  resolveMemoryConflict: Schema.Boolean,
  generateMemorySummary: Schema.Boolean,
});
export type MemoryProviderCapabilities = typeof MemoryProviderCapabilities.Type;

export const MemoryImportFormat = Schema.Literals(["codex", "claude", "omo"]);
export type MemoryImportFormat = typeof MemoryImportFormat.Type;

export const MemoryFailureCode = Schema.Literals([
  "unavailable",
  "source_unavailable",
  "not_found",
  "forgotten",
  "revision_changed",
  "operation_id_reused",
  "missing_parent",
  "conflict_changed",
  "lease_expired",
  "fenced",
  "claim_busy",
  "invalid_output",
  "generation_failed",
  "secret_detected",
  "bootstrap_required",
  "space_mismatch",
  "unsupported_protocol",
  "invalid_cursor",
  "cursor_expired",
  "hub_disabled",
  "identity_mismatch",
  "route_unavailable",
  "lease_required",
  "attempt_expired",
  "unsupported_operation",
  "payload_too_large",
  "generation_input_too_large",
  "storage_failed",
  "source_invalidated",
  "capacity_exceeded",
  "base_compacted",
  "revert_expired",
  "scanner_pending",
]);
export type MemoryFailureCode = typeof MemoryFailureCode.Type;

export const MemoryDeferredReason = Schema.Literals([
  "scanner_pending",
  "secret_detected",
  "missing_parent",
  "conflicted",
  "dependency_invalidated",
  "fts_braked",
  "index_budget",
  "index_unavailable",
  "cleanup_failed",
  "report_backlog",
  "report_failed",
]);
export type MemoryDeferredReason = typeof MemoryDeferredReason.Type;

export const MemoryDeferredStatus = struct({
  kind: Schema.Literals(["index", "scanner", "parent", "projection", "cleanup", "report"]),
  state: Schema.Literals(["pending", "held", "ready"]),
  reason: Schema.NullOr(MemoryDeferredReason),
  revisionId: Schema.NullOr(MemoryRevisionId),
  generation: NonNegativeInt,
  sinceAtUtc: Schema.NullOr(MemoryUtcTimestamp),
}).check(
  Schema.makeFilter((v) =>
    v.state === "ready"
      ? v.reason === null && v.sinceAtUtc === null
      : v.sinceAtUtc !== null && (v.state !== "held" || v.reason !== null),
  ),
);
export type MemoryDeferredStatus = typeof MemoryDeferredStatus.Type;

export const MemoryLocalAvailability = struct({
  exposure: Schema.Literals(["visible", "held", "forgotten"]),
  reasons: distinct(MemoryDeferredReason),
  deferred: array(MemoryDeferredStatus, 6).check(
    Schema.makeFilter((vs) => unique(vs.map((v) => v.kind))),
  ),
  cleanupPending: Schema.Boolean,
});
export type MemoryLocalAvailability = typeof MemoryLocalAvailability.Type;

export const MemorySourceWatermark = struct({
  fromEventId: EventId,
  toEventId: EventId,
  throughSequence: NonNegativeInt,
});
export type MemorySourceWatermark = typeof MemorySourceWatermark.Type;

export const MemorySourceKey = struct({
  environmentId: EnvironmentId,
  sourceId: MemoryImportSourceId,
  sourceItemKey: key,
});
export type MemorySourceKey = typeof MemorySourceKey.Type;

export const MemoryContentSuppression = struct({
  scope: MemoryScope,
  assertionKind: MemoryAssertionKind,
  contentFingerprint: digest,
});
export type MemoryContentSuppression = typeof MemoryContentSuppression.Type;

export const MemorySourceExclusion = struct({
  sourceThread: ScopedThreadRef,
  sourceWatermark: MemorySourceWatermark,
  messageIds: distinct(MessageId, 100, 1),
});
export type MemorySourceExclusion = typeof MemorySourceExclusion.Type;

export const MemoryImportSourceMetadata = struct({
  sourceId: MemoryImportSourceId,
  format: MemoryImportFormat,
  parserVersion: canonical,
  sourceLocator: canonical.check(
    Schema.makeFilter((s) => !s.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(s)),
  ),
  sourceItemKey: key,
  sourceFingerprint: digest,
  contentFingerprint: digest,
  sourceAliases: distinct(MemorySourceKey),
  acceptedContentFingerprints: distinct(digest),
  commitOid: Schema.optionalKey(canonical),
});
export type MemoryImportSourceMetadata = typeof MemoryImportSourceMetadata.Type;

export const MemoryEvidence = struct({
  origin: Schema.Literals(["user", "thread", "import", "model"]),
  sourceThread: Schema.optionalKey(ScopedThreadRef),
  watermark: Schema.optionalKey(MemorySourceWatermark),
  messageIds: distinct(MessageId),
  importSourceId: Schema.optionalKey(MemoryImportSourceId),
}).check(
  Schema.makeFilter(
    (v) =>
      (v.origin !== "thread" || (v.sourceThread !== undefined && v.watermark !== undefined)) &&
      (v.origin !== "import" || v.importSourceId !== undefined),
  ),
);
export type MemoryEvidence = typeof MemoryEvidence.Type;

export const MemoryProvenance = struct({
  environmentId: EnvironmentId,
  providerInstanceId: Schema.optionalKey(canonical.pipe(Schema.brand("ProviderInstanceId"))),
  provider: Schema.optionalKey(ProviderDriverKind),
  requestedModelSelection: Schema.optionalKey(MemoryModelSelection),
  effectiveModel: Schema.optionalKey(canonical),
  sourceThread: Schema.optionalKey(ScopedThreadRef),
  sourceWatermark: Schema.optionalKey(MemorySourceWatermark),
  importSource: Schema.optionalKey(MemoryImportSourceMetadata),
}).check(
  Schema.makeFilter(
    (v) =>
      (v.sourceThread === undefined || v.sourceWatermark !== undefined) &&
      (v.requestedModelSelection === undefined ||
        (v.effectiveModel !== undefined &&
          v.providerInstanceId === v.requestedModelSelection.instanceId &&
          v.provider !== undefined)),
  ),
);
export type MemoryProvenance = typeof MemoryProvenance.Type;

export const MemoryPayload = bounded(
  struct({
    text,
    evidence: array(MemoryEvidence),
    derivedFromMemoryRevisions: distinct(MemoryRevisionId),
  }),
  MEMORY_PAYLOAD_MAX_UTF8_BYTES,
);
export type MemoryPayload = typeof MemoryPayload.Type;

export const MemoryRevision = struct({
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  revisionId: MemoryRevisionId,
  operationId: MemoryOperationId,
  parents: distinct(MemoryRevisionId),
  scope: MemoryScope,
  payloadRef: MemoryRevisionId,
  assertionKind: MemoryAssertionKind,
  provenance: MemoryProvenance,
  createdAtUtc: MemoryUtcTimestamp,
}).check(
  Schema.makeFilter((v) => v.payloadRef === v.revisionId && !v.parents.includes(v.revisionId)),
);
export type MemoryRevision = typeof MemoryRevision.Type;

export const MemoryTombstone = struct({
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  deleteOperationId: MemoryOperationId,
  deletingEnvironmentId: EnvironmentId,
  deletedAtUtc: MemoryUtcTimestamp,
  suppressedSourceKeys: distinct(MemorySourceKey),
  suppressedContent: distinct(MemoryContentSuppression),
  sourceExclusions: distinct(MemorySourceExclusion),
}).check(
  Schema.makeFilter(
    (v) =>
      v.suppressedSourceKeys.length + v.suppressedContent.length + v.sourceExclusions.length <= 100,
  ),
);
export type MemoryTombstone = typeof MemoryTombstone.Type;
const heads = distinct(MemoryRevisionId).check(Schema.makeFilter((vs) => same(vs, [...vs].sort())));

export const MemoryConflict = struct({
  conflictId: MemoryConflictId,
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  heads: heads.check(Schema.makeFilter((vs) => vs.length >= 2)),
  status: Schema.Literals(["quarantined", "resolving", "failed", "resolved"]),
  failureCode: Schema.optionalKey(MemoryFailureCode),
}).check(Schema.makeFilter((v) => (v.status === "failed") === (v.failureCode !== undefined)));
export type MemoryConflict = typeof MemoryConflict.Type;

export const MemoryResolution = struct({
  resolutionId: MemoryResolutionId,
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  inputRevisionIds: distinct(MemoryRevisionId, 100, 2),
  inputPayloadRefs: distinct(MemoryRevisionId, 100, 2),
  judgmentRef: MemoryResolutionId,
  requestedModelSelection: MemoryModelSelection,
  effectiveProvider: ProviderDriverKind,
  effectiveModel: canonical,
  resolvingEnvironmentId: EnvironmentId,
  fencingToken: PositiveInt,
  resultRevisionId: MemoryRevisionId,
  appliedAtUtc: MemoryUtcTimestamp,
  revertDeadlineUtc: MemoryUtcTimestamp,
  revertsResolutionId: Schema.optionalKey(MemoryResolutionId),
}).check(
  Schema.makeFilter(
    (v) =>
      same(v.inputRevisionIds, v.inputPayloadRefs) &&
      v.judgmentRef === v.resolutionId &&
      Date.parse(v.revertDeadlineUtc) >= Date.parse(v.appliedAtUtc),
  ),
);
export type MemoryResolution = typeof MemoryResolution.Type;

export const MemoryResolutionPayload = bounded(
  struct({
    resolutionId: MemoryResolutionId,
    judgment: Schema.String.check(Schema.makeFilter((s) => s.trim().length > 0)),
  }),
  MEMORY_PAYLOAD_MAX_UTF8_BYTES,
);
export type MemoryResolutionPayload = typeof MemoryResolutionPayload.Type;
const assertionValid = (kind: MemoryAssertionKind, evidence: readonly MemoryEvidence[]) =>
  kind === "inference" || evidence.some((e) => e.origin !== "model");
const envelope = {
  protocolVersion: Schema.Literal(1),
  operationId: MemoryOperationId,
  memorySpaceId: MemorySpaceId,
  originEnvironmentId: EnvironmentId,
  memoryId: MemoryId,
  expectedHeads: heads,
};

export const MemoryOperation = bounded(
  Schema.Union([
    struct({
      ...envelope,
      kind: Schema.Literal("upsert"),
      revision: MemoryRevision,
      payload: MemoryPayload,
    }),
    struct({ ...envelope, kind: Schema.Literal("forget"), tombstone: MemoryTombstone }),
    struct({
      ...envelope,
      kind: Schema.Literal("resolve"),
      revision: MemoryRevision,
      payload: MemoryPayload,
      resolution: MemoryResolution,
      resolutionPayload: MemoryResolutionPayload,
      conflictId: MemoryConflictId,
      fencingToken: PositiveInt,
    }),
    struct({
      ...envelope,
      kind: Schema.Literal("revert"),
      revision: MemoryRevision,
      payload: MemoryPayload,
      revertsResolutionId: MemoryResolutionId,
      restoredRevisionId: MemoryRevisionId,
    }),
  ]).check(
    Schema.makeFilter((v) => {
      if (v.kind === "forget")
        return v.tombstone.memorySpaceId === v.memorySpaceId && v.tombstone.memoryId === v.memoryId;
      const r = v.revision;
      if (
        r.memorySpaceId !== v.memorySpaceId ||
        r.memoryId !== v.memoryId ||
        r.operationId !== v.operationId ||
        !sameSet(r.parents, v.expectedHeads) ||
        !assertionValid(r.assertionKind, v.payload.evidence)
      )
        return false;
      if (v.kind === "resolve")
        return (
          v.expectedHeads.length >= 2 &&
          v.resolution.memorySpaceId === v.memorySpaceId &&
          v.resolution.memoryId === v.memoryId &&
          sameSet(v.resolution.inputRevisionIds, v.expectedHeads) &&
          v.resolution.resultRevisionId === r.revisionId &&
          v.resolution.resolvingEnvironmentId === v.originEnvironmentId &&
          v.resolution.fencingToken === v.fencingToken &&
          v.resolutionPayload.resolutionId === v.resolution.resolutionId
        );
      if (v.kind === "revert")
        return (
          v.expectedHeads.length === 1 &&
          r.revisionId !== v.restoredRevisionId &&
          r.revisionId !== v.expectedHeads[0]
        );
      return true;
    }),
  ),
  256 * 1024,
);
export type MemoryOperation = typeof MemoryOperation.Type;
const itemFields = {
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  pendingSync: Schema.Boolean,
  localAvailability: MemoryLocalAvailability,
};

export const MemoryItem = bounded(
  Schema.Union([
    struct({
      ...itemFields,
      status: Schema.Literal("active"),
      scope: MemoryScope,
      revision: MemoryRevision,
      payload: MemoryPayload,
    }),
    struct({
      ...itemFields,
      status: Schema.Literal("quarantined"),
      scope: MemoryScope,
      conflict: MemoryConflict,
    }),
    struct({ ...itemFields, status: Schema.Literal("forgotten"), tombstone: MemoryTombstone }),
    struct({
      ...itemFields,
      status: Schema.Literal("blocked"),
      scope: MemoryScope,
      failureCode: Schema.Literals([
        "scanner_pending",
        "secret_detected",
        "source_invalidated",
        "missing_parent",
      ]),
    }),
  ]).check(
    Schema.makeFilter((v) => {
      const exposure =
        v.status === "active" ? "visible" : v.status === "forgotten" ? "forgotten" : "held";
      if (v.localAvailability.exposure !== exposure) return false;
      if (v.status === "blocked") return true;
      const nested =
        v.status === "active" ? v.revision : v.status === "forgotten" ? v.tombstone : v.conflict;
      return (
        nested.memoryId === v.memoryId &&
        nested.memorySpaceId === v.memorySpaceId &&
        (v.status !== "active" ||
          (same(v.scope, v.revision.scope) &&
            assertionValid(v.revision.assertionKind, v.payload.evidence)))
      );
    }),
  ),
  MEMORY_PAGE_MAX_UTF8_BYTES,
);
export type MemoryItem = typeof MemoryItem.Type;

const validateOperation = Schema.decodeUnknownSync(MemoryOperation, { onExcessProperty: "error" });
const operationJson = Schema.fromJsonString(MemoryOperation);
const encodeOperationJson = Schema.encodeSync(operationJson, { onExcessProperty: "error" });
const decodeOperationJson = Schema.decodeUnknownSync(operationJson, { onExcessProperty: "error" });
/** Refuse unknown nested fields and construct only the selected transport arm. */
export function encodeMemoryOperation(operation: MemoryOperation): string {
  const value = validateOperation(operation);
  const {
    protocolVersion,
    operationId,
    memorySpaceId,
    originEnvironmentId,
    memoryId,
    expectedHeads,
    kind,
  } = value;
  const common = {
    protocolVersion,
    operationId,
    memorySpaceId,
    originEnvironmentId,
    memoryId,
    expectedHeads,
  };
  switch (kind) {
    case "upsert":
      return encodeOperationJson({
        ...common,
        kind,
        revision: value.revision,
        payload: value.payload,
      });
    case "forget":
      return encodeOperationJson({ ...common, kind, tombstone: value.tombstone });
    case "resolve":
      return encodeOperationJson({
        ...common,
        kind,
        revision: value.revision,
        payload: value.payload,
        resolution: value.resolution,
        resolutionPayload: value.resolutionPayload,
        conflictId: value.conflictId,
        fencingToken: value.fencingToken,
      });
    case "revert":
      return encodeOperationJson({
        ...common,
        kind,
        revision: value.revision,
        payload: value.payload,
        revertsResolutionId: value.revertsResolutionId,
        restoredRevisionId: value.restoredRevisionId,
      });
  }
}
export function decodeMemoryOperation(json: string): MemoryOperation {
  return decodeOperationJson(json);
}
const eventSchema = Schema.Union([
  struct({ ...envelope, kind: Schema.Literal("upsert"), revision: MemoryRevision }),
  struct({ ...envelope, kind: Schema.Literal("forget"), tombstone: MemoryTombstone }),
  struct({
    ...envelope,
    kind: Schema.Literal("resolve"),
    revision: MemoryRevision,
    resolution: MemoryResolution,
    conflictId: MemoryConflictId,
    fencingToken: PositiveInt,
  }),
  struct({
    ...envelope,
    kind: Schema.Literal("revert"),
    revision: MemoryRevision,
    revertsResolutionId: MemoryResolutionId,
    restoredRevisionId: MemoryRevisionId,
  }),
]);
const encodeEventMetadata = Schema.encodeSync(Schema.fromJsonString(eventSchema), {
  onExcessProperty: "error",
});
const decodeEventMetadata = Schema.decodeUnknownSync(eventSchema, { onExcessProperty: "error" });
export function encodeMemoryEventMetadata(operation: MemoryOperation): string {
  validateOperation(operation);
  const {
    protocolVersion,
    operationId,
    memorySpaceId,
    originEnvironmentId,
    memoryId,
    expectedHeads,
    kind,
  } = operation;
  const common = {
    protocolVersion,
    operationId,
    memorySpaceId,
    originEnvironmentId,
    memoryId,
    expectedHeads,
    kind,
  };
  const value =
    operation.kind === "forget"
      ? { ...common, tombstone: operation.tombstone }
      : operation.kind === "resolve"
        ? {
            ...common,
            revision: operation.revision,
            resolution: operation.resolution,
            conflictId: operation.conflictId,
            fencingToken: operation.fencingToken,
          }
        : operation.kind === "revert"
          ? {
              ...common,
              revision: operation.revision,
              revertsResolutionId: operation.revertsResolutionId,
              restoredRevisionId: operation.restoredRevisionId,
            }
          : { ...common, revision: operation.revision };
  return encodeEventMetadata(decodeEventMetadata(value));
}

export const MemoryCapacityDimension = Schema.Literals([
  "body",
  "user_items",
  "project_items",
  "thread_summaries",
  "thread_items",
  "space_live_items",
  "environment_live_items",
  "live_payload_bytes",
  "history",
  "import_session_items",
  "import_session_bytes",
  "import_live_items",
  "import_live_bytes",
  "import_source_items",
  "import_aliases",
  "import_digests",
  "permanent_metadata",
  "lifetime_ids",
  "receipts",
  "log_tail_rows",
  "log_tail_bytes",
  "work_items",
  "work_bytes",
  "report_items",
  "report_bytes",
  "relay_environment",
  "relay_hub",
  "members",
  "checkpoint_handles",
  "checkpoint_staging",
  "derived_cache",
  "fts_indexed_text",
  "fts_admission_brake",
]);
export type MemoryCapacityDimension = typeof MemoryCapacityDimension.Type;

export const MemoryCapacityExceeded = struct({
  code: Schema.Literal("capacity_exceeded"),
  dimension: MemoryCapacityDimension,
  current: NonNegativeInt,
  limit: PositiveInt,
  reclaimable: NonNegativeInt,
});
export type MemoryCapacityExceeded = typeof MemoryCapacityExceeded.Type;
const safeErrorFields = {
  code: MemoryFailureCode,
  memoryId: Schema.optionalKey(MemoryId),
  operationId: Schema.optionalKey(MemoryOperationId),
  capacity: Schema.optionalKey(MemoryCapacityExceeded),
};
const safeDomainError = Schema.Struct(safeErrorFields).check(
  Schema.makeFilter((v) => (v.code === "capacity_exceeded") === (v.capacity !== undefined)),
);
export class MemoryRpcError extends Schema.TaggedError<MemoryRpcError>()(
  "MemoryRpcError",
  safeDomainError,
) {
  static override get ast(): SchemaAST.Declaration {
    return strictSchema(Schema.make(super.ast)).ast;
  }
  override get message(): string {
    return `Memory request failed (${this.code}).`;
  }
}
export class MemoryHubError extends Schema.TaggedError<MemoryHubError>()(
  "MemoryHubError",
  safeDomainError,
) {
  static override get ast(): SchemaAST.Declaration {
    return strictSchema(Schema.make(super.ast)).ast;
  }
  override get message(): string {
    return `Memory request failed (${this.code}).`;
  }
}
export class MemoryHubUnauthorizedError extends Schema.TaggedError<MemoryHubUnauthorizedError>()(
  "MemoryHubUnauthorizedError",
  {},
) {
  override get message(): string {
    return "Memory hub authentication required.";
  }
}
export class MemoryHubForbiddenError extends Schema.TaggedError<MemoryHubForbiddenError>()(
  "MemoryHubForbiddenError",
  {},
) {
  override get message(): string {
    return "Memory hub access denied.";
  }
}
export class MemoryCapabilityError extends Schema.TaggedError<MemoryCapabilityError>()(
  "MemoryCapabilityError",
  { requiredCapability: Schema.Literal("memory") },
) {
  override get message(): string {
    return "Memory capability required.";
  }
}

export const MemoryIndexCoverage = struct({
  status: Schema.Literals(["available", "partial", "unavailable"]),
  eligibleItems: NonNegativeInt,
  indexedItems: NonNegativeInt,
  unindexedItems: NonNegativeInt,
  projectionWatermark: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (v) =>
      v.eligibleItems === v.indexedItems + v.unindexedItems &&
      (v.status !== "unavailable" || v.indexedItems === 0) &&
      (v.status !== "available" || v.unindexedItems === 0) &&
      (v.status !== "partial" || v.unindexedItems > 0),
  ),
);
export type MemoryIndexCoverage = typeof MemoryIndexCoverage.Type;

export const MemoryProcessingStatus = struct({
  lastReceivedHubSequence: NonNegativeInt,
  receiveLag: Schema.NullOr(NonNegativeInt),
  deferred: NonNegativeInt,
  oldestDeferredAtUtc: Schema.NullOr(MemoryUtcTimestamp),
  unindexedItems: NonNegativeInt,
  scannerHeldItems: NonNegativeInt,
  scannerPendingItems: NonNegativeInt,
  missingParentItems: NonNegativeInt,
  pendingCleanupItems: NonNegativeInt,
  reportBacklog: NonNegativeInt,
  reportFailed: NonNegativeInt,
  hubAdmissionFailures: NonNegativeInt,
  indexCoverage: MemoryIndexCoverage,
}).check(Schema.makeFilter((v) => (v.deferred === 0) === (v.oldestDeferredAtUtc === null)));
export type MemoryProcessingStatus = typeof MemoryProcessingStatus.Type;

export const MemoryStorageBlockedReason = Schema.Literals([
  "retained_revert_input",
  "active_lease",
  "pending_work",
  "checkpoint_pinned",
  "storage_unavailable",
  "index_unavailable",
  "fts_braked",
  "cleanup_failed",
  "report_backlog",
  "capacity_exceeded",
]);
export type MemoryStorageBlockedReason = typeof MemoryStorageBlockedReason.Type;

export const MemoryStorageQuota = struct({
  dimension: MemoryCapacityDimension,
  current: NonNegativeInt,
  limit: PositiveInt,
  reclaimable: NonNegativeInt,
  reserved: NonNegativeInt,
  warning: Schema.Literals(["normal", "warning", "critical", "full"]),
  blockedReasons: distinct(MemoryStorageBlockedReason),
});
export type MemoryStorageQuota = typeof MemoryStorageQuota.Type;

export const MemoryStorageTable = Schema.Literals([
  "memory_events",
  "memory_revisions",
  "memory_payloads",
  "memory_items",
  "memory_tombstones",
  "memory_conflicts",
  "memory_resolutions",
  "memory_outbox",
  "memory_inbox_pending",
  "memory_sync_cursors",
  "memory_import_receipts",
  "memory_report_outbox",
  "memory_items_fts",
  "memory_project_bindings",
  "memory_quota_counters",
  "memory_identity_ledger",
  "memory_compact_receipts",
  "memory_import_keys",
  "memory_compaction_state",
  "memory_fts_maintenance_state",
  "memory_storage_samples",
  "memory_hub_operations",
  "memory_hub_members",
  "memory_hub_leases",
  "memory_hub_source_reads",
  "memory_hub_retention",
]);
export type MemoryStorageTable = typeof MemoryStorageTable.Type;

export const MemoryStorageTableUsage = struct({
  table: MemoryStorageTable,
  rowCount: NonNegativeInt,
  logicalBytes: NonNegativeInt,
  allocatedBytes: Schema.NullOr(NonNegativeInt),
  allocationStatus: Schema.Literals(["available", "unavailable"]),
}).check(
  Schema.makeFilter((v) => (v.allocationStatus === "available") === (v.allocatedBytes !== null)),
);
export type MemoryStorageTableUsage = typeof MemoryStorageTableUsage.Type;

export const MemoryCompactionStatus = struct({
  lastRunAtUtc: Schema.NullOr(MemoryUtcTimestamp),
  removedRows: NonNegativeInt,
  reclaimedLogicalBytes: NonNegativeInt,
  reclaimableLogicalBytes: NonNegativeInt,
  blockedReasons: distinct(MemoryStorageBlockedReason),
});
export type MemoryCompactionStatus = typeof MemoryCompactionStatus.Type;

export const MemoryFtsAdmissionStatus = struct({
  state: Schema.Literals(["open", "braked"]),
  changedAtUtc: Schema.NullOr(MemoryUtcTimestamp),
  lastMeasuredAtUtc: Schema.NullOr(MemoryUtcTimestamp),
  allocatedBytes: Schema.NullOr(NonNegativeInt),
  measurementStatus: Schema.Literals(["available", "unavailable"]),
}).check(
  Schema.makeFilter((v) => (v.measurementStatus === "available") === (v.allocatedBytes !== null)),
);
export type MemoryFtsAdmissionStatus = typeof MemoryFtsAdmissionStatus.Type;

export const MemoryStorageMetric = Schema.Literals([
  "memoryLogicalBytes",
  "memoryAllocatedBytes",
  "ftsAllocatedBytes",
  "dbFileBytes",
  "walBytes",
  "freelistBytes",
]);
export type MemoryStorageMetric = typeof MemoryStorageMetric.Type;

export const MemoryStorageSample = struct({
  measuredAtUtc: MemoryUtcTimestamp,
  utcDay: Schema.String.check(
    Schema.makeFilter(
      (s) =>
        /^\d{4}-\d{2}-\d{2}$/.test(s) &&
        Number.isFinite(Date.parse(s)) &&
        DateTime.formatIsoDateUtc(DateTime.makeUnsafe(s)) === s,
    ),
  ),
  status: Schema.Literals(["available", "partial", "unavailable"]),
  memoryLogicalBytes: Schema.NullOr(NonNegativeInt),
  memoryAllocatedBytes: Schema.NullOr(NonNegativeInt),
  ftsAllocatedBytes: Schema.NullOr(NonNegativeInt),
  dbFileBytes: Schema.NullOr(NonNegativeInt),
  walBytes: Schema.NullOr(NonNegativeInt),
  freelistBytes: Schema.NullOr(NonNegativeInt),
  tables: array(MemoryStorageTableUsage, 64).check(
    Schema.makeFilter((vs) => unique(vs.map((v) => v.table))),
  ),
}).check(
  Schema.makeFilter(
    (v) =>
      v.measuredAtUtc.startsWith(v.utcDay) && jsonBytes(v) <= MEMORY_STORAGE_SAMPLE_MAX_UTF8_BYTES,
  ),
);
export type MemoryStorageSample = typeof MemoryStorageSample.Type;

export const MemoryStorageDelta = struct({
  days: Schema.Literals([1, 7, 30]),
  metric: MemoryStorageMetric,
  status: Schema.Literals(["available", "unavailable"]),
  baselineAtUtc: Schema.NullOr(MemoryUtcTimestamp),
  currentAtUtc: Schema.NullOr(MemoryUtcTimestamp),
  elapsedMs: Schema.NullOr(NonNegativeInt),
  deltaBytes: Schema.NullOr(Schema.Int),
  reason: Schema.NullOr(
    Schema.Literals(["missing_baseline", "metric_unavailable", "clock_discontinuity"]),
  ),
}).check(
  Schema.makeFilter((v) =>
    v.status === "available"
      ? v.baselineAtUtc !== null &&
        v.currentAtUtc !== null &&
        v.elapsedMs !== null &&
        v.deltaBytes !== null &&
        v.reason === null &&
        Date.parse(v.currentAtUtc) - Date.parse(v.baselineAtUtc) === v.elapsedMs
      : v.deltaBytes === null && v.reason !== null,
  ),
);
export type MemoryStorageDelta = typeof MemoryStorageDelta.Type;

export const MemoryStorageGrowth = struct({
  current: Schema.NullOr(MemoryStorageSample),
  deltas: array(MemoryStorageDelta, 18, 18),
}).check(Schema.makeFilter((v) => unique(v.deltas.map((d) => [d.days, d.metric]))));
export type MemoryStorageGrowth = typeof MemoryStorageGrowth.Type;

export const MemoryStorageStatus = struct({
  quotas: array(MemoryStorageQuota).check(
    Schema.makeFilter((vs) => unique(vs.map((v) => v.dimension))),
  ),
  tables: array(MemoryStorageTableUsage, 64).check(
    Schema.makeFilter((vs) => unique(vs.map((v) => v.table))),
  ),
  measuredAtUtc: Schema.NullOr(MemoryUtcTimestamp),
  dbFileBytes: Schema.NullOr(NonNegativeInt),
  walBytes: Schema.NullOr(NonNegativeInt),
  freelistBytes: Schema.NullOr(NonNegativeInt),
  freelistRatio: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  retentionFloor: NonNegativeInt,
  checkpointSequence: NonNegativeInt,
  compaction: MemoryCompactionStatus,
  ftsAdmission: MemoryFtsAdmissionStatus,
  growth: MemoryStorageGrowth,
  warnings: distinct(MemoryStorageBlockedReason),
}).check(Schema.makeFilter((v) => v.retentionFloor <= v.checkpointSequence));
export type MemoryStorageStatus = typeof MemoryStorageStatus.Type;

export const MemorySyncStatus = struct({
  memorySpaceId: Schema.NullOr(MemorySpaceId),
  state: Schema.Literals(["disabled", "bootstrapping", "online", "offline", "error"]),
  pendingSync: NonNegativeInt,
  quarantined: NonNegativeInt,
  parked: NonNegativeInt,
  lastSuccessfulSyncAtUtc: Schema.NullOr(MemoryUtcTimestamp),
  lastHubSequence: NonNegativeInt,
  failureCode: Schema.optionalKey(MemoryFailureCode),
  storage: MemoryStorageStatus,
  processing: MemoryProcessingStatus,
}).check(Schema.makeFilter((v) => v.lastHubSequence === v.processing.lastReceivedHubSequence));
export type MemorySyncStatus = typeof MemorySyncStatus.Type;

export const MemoryHubEndpoint = canonical.check(
  Schema.makeFilter((s) => {
    try {
      const u = new URL(s);
      return (
        (u.protocol === "https:" ||
          (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) &&
        !u.username &&
        !u.password &&
        u.pathname === "/" &&
        !u.search &&
        !u.hash
      );
    } catch {
      return false;
    }
  }),
);
export type MemoryHubEndpoint = typeof MemoryHubEndpoint.Type;

export const MemoryHubSettings = Schema.Union([
  struct({ mode: Schema.Literal("disabled") }),
  struct({ mode: Schema.Literal("hub"), memorySpaceId: Schema.NullOr(MemorySpaceId) }),
  struct({
    mode: Schema.Literal("member"),
    hubEnvironmentId: EnvironmentId,
    endpoint: MemoryHubEndpoint,
    secretName: canonical.check(Schema.makeFilter((s) => /^[a-z0-9-]+$/.test(s))),
    memorySpaceId: Schema.NullOr(MemorySpaceId),
  }),
]);
export type MemoryHubSettings = typeof MemoryHubSettings.Type;

export const MemorySpaceBinding = struct({
  memorySpaceId: Schema.NullOr(MemorySpaceId),
  hubEnvironmentId: Schema.NullOr(EnvironmentId),
  bootstrapReady: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (v) => !v.bootstrapReady || (v.memorySpaceId !== null && v.hubEnvironmentId !== null),
  ),
);
export type MemorySpaceBinding = typeof MemorySpaceBinding.Type;

export const MemoryCausalBoundary = struct({
  checkpointSequence: NonNegativeInt,
  boundaryId: canonical.check(Schema.makeFilter((s) => utf8(s) <= 64)),
});
export type MemoryCausalBoundary = typeof MemoryCausalBoundary.Type;

export const MemoryContextSnapshot = struct({
  protocolVersion: Schema.Literal(1),
  memorySpaceId: MemorySpaceId,
  projectionWatermark: NonNegativeInt,
  items: array(
    struct({
      memoryId: MemoryId,
      revisionId: MemoryRevisionId,
      scope: MemoryScope,
      provenance: MemoryProvenance,
      assertionKind: MemoryAssertionKind,
      text,
    }),
  ),
  renderedText: Schema.String,
}).check(
  Schema.makeFilter(
    (v) =>
      unique(v.items.map((i) => i.memoryId)) &&
      v.items.every((i) => v.renderedText.includes(i.text)) &&
      Array.from(v.renderedText + MEMORY_CONTEXT_OUTER_FRAME).length <= MEMORY_CONTEXT_MAX_CHARS &&
      utf8(v.renderedText + MEMORY_CONTEXT_OUTER_FRAME) <= MEMORY_CONTEXT_MAX_UTF8_BYTES,
  ),
);
export type MemoryContextSnapshot = typeof MemoryContextSnapshot.Type;
export type MemoryContextCandidate = MemoryContextSnapshot["items"][number];
export type MemoryContextCandidates = Pick<
  MemoryContextSnapshot,
  "memorySpaceId" | "projectionWatermark" | "items"
>;

export const MemoryMutationReceipt = struct({
  operationId: MemoryOperationId,
  memoryId: MemoryId,
  outcome: Schema.Literals(["accepted", "noop", "conflicted", "deleted"]),
  revisionId: Schema.NullOr(MemoryRevisionId),
  pendingSync: Schema.Boolean,
});
export type MemoryMutationReceipt = typeof MemoryMutationReceipt.Type;

export const MemoryRevertStatus = Schema.Literals([
  "pending",
  "accepted",
  "revision_changed",
  "forgotten",
  "revert_expired",
]);
export type MemoryRevertStatus = typeof MemoryRevertStatus.Type;

const revertArms = Schema.Union([
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("pending"),
  }),
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("accepted"),
    receipt: MemoryMutationReceipt,
    localAvailability: MemoryLocalAvailability,
  }),
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("revision_changed"),
  }),
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("forgotten"),
  }),
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("revert_expired"),
  }),
]);
export type MemoryRevertResult = typeof MemoryRevertResult.Type;
export const MemoryRevertResult = revertArms.check(
  Schema.makeFilter(
    (v) =>
      v.status !== "accepted" ||
      (v.receipt.operationId === v.operationId &&
        v.receipt.memoryId === v.memoryId &&
        v.receipt.revisionId !== null &&
        !v.receipt.pendingSync &&
        v.receipt.outcome === "accepted"),
  ),
);

export const MemoryReportReference = struct({
  memorySpaceId: MemorySpaceId,
  environmentId: EnvironmentId,
  memoryId: MemoryId,
  resolutionId: Schema.optionalKey(MemoryResolutionId),
});
export type MemoryReportReference = typeof MemoryReportReference.Type;

export const MemoryReportDelivery = struct({
  reportId: digest,
  operationId: MemoryOperationId,
  outcome: Schema.Literals(["resolved", "failed", "reverted"]),
  resolvingEnvironmentId: EnvironmentId,
  resolutionId: Schema.NullOr(MemoryResolutionId),
  state: Schema.Literals(["pending", "delivered", "failed"]),
  failureCode: Schema.optionalKey(MemoryFailureCode),
  reportThread: Schema.NullOr(ScopedThreadRef),
  sequence: Schema.NullOr(NonNegativeInt),
}).check(
  Schema.makeFilter(
    (v) =>
      (v.state === "delivered"
        ? v.reportThread !== null && v.sequence !== null
        : v.reportThread === null && v.sequence === null) &&
      (v.state !== "failed" || v.failureCode !== undefined),
  ),
);
export type MemoryReportDelivery = typeof MemoryReportDelivery.Type;

export const MemoryPage = bounded(
  struct({
    items: array(MemoryItem),
    projectionWatermark: NonNegativeInt,
    nextCursor: Schema.NullOr(canonical),
    indexCoverage: Schema.optionalKey(MemoryIndexCoverage),
  }).check(
    Schema.makeFilter(
      (v) =>
        v.indexCoverage === undefined ||
        (v.indexCoverage.projectionWatermark === v.projectionWatermark &&
          (v.indexCoverage.status !== "unavailable" || v.items.length === 0)),
    ),
  ),
  MEMORY_PAGE_MAX_UTF8_BYTES,
);
export type MemoryPage = typeof MemoryPage.Type;
const revisionPair = struct({ revision: MemoryRevision, payload: Schema.NullOr(MemoryPayload) });
const resolutionPair = struct({
  resolution: MemoryResolution,
  payload: Schema.NullOr(MemoryResolutionPayload),
});

export const MemoryHistoryPage = bounded(
  struct({
    memoryId: MemoryId,
    revisions: array(revisionPair),
    resolutions: array(resolutionPair),
    tombstone: Schema.NullOr(MemoryTombstone),
    reports: array(MemoryReportDelivery),
    revertResults: array(MemoryRevertResult),
    localAvailability: MemoryLocalAvailability,
    nextCursor: Schema.NullOr(canonical),
  }).check(
    Schema.makeFilter(
      (v) =>
        v.revisions.length +
          v.resolutions.length +
          v.reports.length +
          v.revertResults.length +
          (v.tombstone === null ? 0 : 1) <=
          100 &&
        v.revisions.every((r) => r.revision.memoryId === v.memoryId) &&
        v.resolutions.every((r) => r.resolution.memoryId === v.memoryId) &&
        (v.localAvailability.exposure === "visible" ||
          (v.revisions.every((r) => r.payload === null) &&
            v.resolutions.every((r) => r.payload === null))),
    ),
  ),
  MEMORY_PAGE_MAX_UTF8_BYTES,
);
export type MemoryHistoryPage = typeof MemoryHistoryPage.Type;

export const MemorySourcePage = bounded(
  struct({
    sourceThread: ScopedThreadRef,
    watermark: MemorySourceWatermark,
    messages: array(struct({ messageId: MessageId, text: Schema.String })).check(
      Schema.makeFilter((vs) => unique(vs.map((v) => v.messageId))),
    ),
    nextCursor: Schema.NullOr(canonical),
  }),
  MEMORY_PAGE_MAX_UTF8_BYTES,
);
export type MemorySourcePage = typeof MemorySourcePage.Type;
const space = { memorySpaceId: MemorySpaceId };
const limit = PositiveInt.check(Schema.isLessThanOrEqualTo(100)).pipe(
  Schema.withDecodingDefault(Effect.succeed(20)),
);
const paging = { limit, cursor: Schema.optionalKey(canonical) };

export const MemorySearchInput = struct({
  ...space,
  ...paging,
  query: canonical,
  scope: Schema.optionalKey(MemoryScope),
  mode: Schema.Literals(["fts", "substring"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("fts")),
  ),
});
export type MemorySearchInput = typeof MemorySearchInput.Type;

export const MemoryListInput = struct({
  ...space,
  ...paging,
  scope: Schema.optionalKey(MemoryScope),
  includeQuarantined: Schema.Boolean,
});
export type MemoryListInput = typeof MemoryListInput.Type;

export const MemoryReadInput = struct({ ...space, memoryId: MemoryId });
export type MemoryReadInput = typeof MemoryReadInput.Type;

export const MemoryHistoryInput = struct({ ...space, ...paging, memoryId: MemoryId });
export type MemoryHistoryInput = typeof MemoryHistoryInput.Type;

export const MemorySyncStatusInput = struct({});
export type MemorySyncStatusInput = typeof MemorySyncStatusInput.Type;

export const MemoryUpsertInput = struct({
  ...space,
  operationId: MemoryOperationId,
  memoryId: MemoryId,
  expectedHeads: heads,
  scope: MemoryScope,
  assertionKind: MemoryAssertionKind,
  payload: MemoryPayload,
  baseBoundary: Schema.NullOr(MemoryCausalBoundary),
}).check(Schema.makeFilter((v) => assertionValid(v.assertionKind, v.payload.evidence)));
export type MemoryUpsertInput = typeof MemoryUpsertInput.Type;

export const MemoryForgetInput = struct({
  ...space,
  operationId: MemoryOperationId,
  memoryId: MemoryId,
  expectedHeads: heads,
});
export type MemoryForgetInput = typeof MemoryForgetInput.Type;

export const MemoryRevertResolutionInput = struct({
  ...space,
  operationId: MemoryOperationId,
  memoryId: MemoryId,
  resolutionId: MemoryResolutionId,
  restoredRevisionId: MemoryRevisionId,
  expectedHeads: heads.check(Schema.makeFilter((vs) => vs.length === 1)),
});
export type MemoryRevertResolutionInput = typeof MemoryRevertResolutionInput.Type;

export const MemoryReadSourceInput = struct({
  ...space,
  ...paging,
  memoryId: MemoryId,
  sourceThread: ScopedThreadRef,
  messageIds: distinct(MessageId, 100, 1),
});
export type MemoryReadSourceInput = typeof MemoryReadSourceInput.Type;

export const MemoryHubSettingsGetInput = struct({});
export type MemoryHubSettingsGetInput = typeof MemoryHubSettingsGetInput.Type;

export const MemoryHubSettingsView = struct({
  settings: MemoryHubSettings,
  version: NonNegativeInt,
});
export type MemoryHubSettingsView = typeof MemoryHubSettingsView.Type;

export const MemoryHubSettingsUpdateInput = bounded(
  Schema.Union([
    struct({
      requestId: MemoryOperationId,
      expectedVersion: NonNegativeInt,
      action: Schema.Literal("configure"),
      settings: MemoryHubSettings,
    }),
    struct({
      requestId: MemoryOperationId,
      expectedVersion: NonNegativeInt,
      action: Schema.Literal("provisionMember"),
      environmentId: EnvironmentId,
    }),
    struct({
      requestId: MemoryOperationId,
      expectedVersion: NonNegativeInt,
      action: Schema.Literal("rotateMemberCredential"),
      environmentId: EnvironmentId,
    }),
    struct({
      requestId: MemoryOperationId,
      expectedVersion: NonNegativeInt,
      action: Schema.Literal("revokeMember"),
      environmentId: EnvironmentId,
    }),
    struct({
      requestId: MemoryOperationId,
      expectedVersion: NonNegativeInt,
      action: Schema.Literal("installCredential"),
      hubEnvironmentId: EnvironmentId,
      endpoint: MemoryHubEndpoint,
      memorySpaceId: MemorySpaceId,
      credential: canonical,
    }),
    struct({
      requestId: MemoryOperationId,
      expectedVersion: NonNegativeInt,
      action: Schema.Literal("acknowledgeCredential"),
      credentialRequestId: MemoryOperationId,
    }),
  ]),
  MEMORY_PAGE_MAX_UTF8_BYTES,
);
export type MemoryHubSettingsUpdateInput = typeof MemoryHubSettingsUpdateInput.Type;

export const MemoryHubCredentialResult = struct({
  requestId: MemoryOperationId,
  environmentId: EnvironmentId,
  memorySpaceId: MemorySpaceId,
  credentialVersion: PositiveInt,
  credential: canonical.check(Schema.makeFilter((s) => /^[A-Za-z0-9_-]{43}$/.test(s))),
});
export type MemoryHubCredentialResult = typeof MemoryHubCredentialResult.Type;

export const MemoryHubSettingsUpdateResult = bounded(
  struct({ view: MemoryHubSettingsView, credential: Schema.NullOr(MemoryHubCredentialResult) }),
  65536,
);
export type MemoryHubSettingsUpdateResult = typeof MemoryHubSettingsUpdateResult.Type;

export const MemoryProjectBinding = struct({
  ...space,
  project: ScopedProjectRef,
  projectKey: Schema.NullOr(MemoryProjectKey),
  repositoryKey: Schema.NullOr(
    struct({ kind: Schema.Literal("repository"), groupingKey: canonical }),
  ),
  version: NonNegativeInt,
});
export type MemoryProjectBinding = typeof MemoryProjectBinding.Type;

export const MemoryProjectBindingGetInput = struct({ ...space, project: ScopedProjectRef });
export type MemoryProjectBindingGetInput = typeof MemoryProjectBindingGetInput.Type;

export const MemoryProjectBindingUpdateInput = Schema.Union([
  struct({
    ...space,
    project: ScopedProjectRef,
    requestId: MemoryOperationId,
    expectedVersion: NonNegativeInt,
    action: Schema.Literal("setExplicit"),
    sharedProjectId: key,
  }),
  struct({
    ...space,
    project: ScopedProjectRef,
    requestId: MemoryOperationId,
    expectedVersion: NonNegativeInt,
    action: Schema.Literal("useRepository"),
  }),
]);
export type MemoryProjectBindingUpdateInput = typeof MemoryProjectBindingUpdateInput.Type;

export const MemoryProjectBindingUpdateResult = struct({
  binding: MemoryProjectBinding,
  requestId: MemoryOperationId,
});
export type MemoryProjectBindingUpdateResult = typeof MemoryProjectBindingUpdateResult.Type;

export const MemoryChangesInput = struct({ ...space });
export type MemoryChangesInput = typeof MemoryChangesInput.Type;

export const MemoryChangeSignal = Schema.Union([
  struct({ ...space, projectionWatermark: NonNegativeInt, kind: Schema.Literal("reset") }),
  struct({
    ...space,
    projectionWatermark: NonNegativeInt,
    kind: Schema.Literals(["upsert", "forget", "invalidate"]),
    memoryId: MemoryId,
  }),
]);
export type MemoryChangeSignal = typeof MemoryChangeSignal.Type;

export const MemoryImportOutcome = Schema.Literals([
  "created",
  "revised",
  "noop",
  "aliased",
  "suppressed",
  "rejected",
  "conflicted",
]);
export type MemoryImportOutcome = typeof MemoryImportOutcome.Type;

export const MemoryImportIssue = Schema.Literals([
  "unsupported_format",
  "source_missing",
  "source_unreadable",
  "invalid_utf8",
  "path_rejected",
  "limit_exceeded",
  "source_changed",
  "scope_unmapped",
  "mapping_changed",
  "bootstrap_required",
  "secret_detected",
  "storage_failed",
  "operation_id_reused",
  "capacity_exceeded",
]);
export type MemoryImportIssue = typeof MemoryImportIssue.Type;
export class MemoryImportRpcError extends Schema.TaggedError<MemoryImportRpcError>()(
  "MemoryImportRpcError",
  Schema.Struct({
    issue: MemoryImportIssue,
    operationId: Schema.optionalKey(MemoryOperationId),
    capacity: Schema.optionalKey(MemoryCapacityExceeded),
  }).check(
    Schema.makeFilter((v) => (v.issue === "capacity_exceeded") === (v.capacity !== undefined)),
  ),
) {
  static override get ast(): SchemaAST.Declaration {
    return strictSchema(Schema.make(super.ast)).ast;
  }
  override get message(): string {
    return `Memory import failed (${this.issue}).`;
  }
}

export const MemoryImportSource = struct({
  sourceId: MemoryImportSourceId,
  format: MemoryImportFormat,
  parserVersion: canonical,
  profile: canonical,
  label: canonical,
});
export type MemoryImportSource = typeof MemoryImportSource.Type;

export const MemoryImportPreviewItem = struct({
  sourceItemKey: key,
  sourceFingerprint: Schema.optionalKey(digest),
  byteCount: NonNegativeInt,
  mappingRequired: Schema.Boolean,
  title: Schema.optionalKey(canonical.check(Schema.makeFilter((s) => Array.from(s).length <= 256))),
  priorOutcome: Schema.optionalKey(MemoryImportOutcome),
  issue: Schema.optionalKey(MemoryImportIssue),
  memoryId: Schema.optionalKey(MemoryId),
  revisionId: Schema.optionalKey(MemoryRevisionId),
}).check(
  Schema.makeFilter(
    (v) =>
      (v.priorOutcome !== "suppressed" && v.issue !== "secret_detected") || v.title === undefined,
  ),
);
export type MemoryImportPreviewItem = typeof MemoryImportPreviewItem.Type;

export const MemoryImportItemResult = struct({
  sourceItemKey: key,
  outcome: MemoryImportOutcome,
  issue: Schema.optionalKey(MemoryImportIssue),
  capacity: Schema.optionalKey(MemoryCapacityExceeded),
  memoryId: Schema.NullOr(MemoryId),
  revisionId: Schema.NullOr(MemoryRevisionId),
}).check(
  Schema.makeFilter(
    (v) =>
      (v.outcome !== "rejected" || v.issue !== undefined) &&
      (v.issue === "capacity_exceeded") === (v.capacity !== undefined),
  ),
);
export type MemoryImportItemResult = typeof MemoryImportItemResult.Type;

export const MemoryImportReceipt = struct({
  operationId: MemoryOperationId,
  sourceId: MemoryImportSourceId,
  sessionId: canonical.check(Schema.makeFilter((s) => utf8(s) <= 64)),
  sessionNewItems: NonNegativeInt,
  sessionBodyBytes: NonNegativeInt,
  state: Schema.Literals(["partial", "completed"]),
  items: array(MemoryImportItemResult, 32),
  remaining: NonNegativeInt,
}).check(Schema.makeFilter((v) => (v.state === "completed") === (v.remaining === 0)));
export type MemoryImportReceipt = typeof MemoryImportReceipt.Type;
const importSelector = struct({
  sourceItemKey: key,
  sourceFingerprint: digest,
  scope: MemoryScope,
  project: Schema.optionalKey(ScopedProjectRef),
}).check(
  Schema.makeFilter((v) =>
    v.scope.kind === "project"
      ? v.project !== undefined
      : v.scope.kind !== "user" || v.project === undefined,
  ),
);

export const MemoryImportProviderInput = bounded(
  Schema.Union([
    struct({ ...space, action: Schema.Literal("discover"), format: MemoryImportFormat }),
    struct({ ...space, action: Schema.Literal("preview"), sourceId: MemoryImportSourceId }),
    struct({
      ...space,
      action: Schema.Literal("apply"),
      sourceId: MemoryImportSourceId,
      sessionId: canonical.check(Schema.makeFilter((s) => utf8(s) <= 64)),
      operationId: MemoryOperationId,
      items: array(importSelector, 32, 1),
    }),
    struct({ ...space, action: Schema.Literal("status"), operationId: MemoryOperationId }),
  ]),
  MEMORY_PAGE_MAX_UTF8_BYTES,
);
export type MemoryImportProviderInput = typeof MemoryImportProviderInput.Type;

export const MemoryImportProviderResult = bounded(
  Schema.Union([
    struct({ action: Schema.Literal("discover"), sources: array(MemoryImportSource, 128) }),
    struct({
      action: Schema.Literal("preview"),
      sourceId: MemoryImportSourceId,
      sessionId: canonical,
      items: array(MemoryImportPreviewItem, 128),
    }),
    struct({
      action: Schema.Literals(["apply", "status"]),
      receipt: MemoryImportReceipt,
      syncStatus: MemorySyncStatus,
    }),
  ]),
  65536,
);
export type MemoryImportProviderResult = typeof MemoryImportProviderResult.Type;

export const ResolveMemoryConflictInput = struct({
  cwd: canonical,
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  conflictId: MemoryConflictId,
  heads: array(struct({ revision: MemoryRevision, payload: MemoryPayload }), 100, 2),
  modelSelection: MemoryModelSelection,
}).check(
  Schema.makeFilter(
    (v) =>
      jsonBytes(v) <= 262144 &&
      unique(v.heads.map((h) => h.revision.revisionId)) &&
      v.heads.every(
        (h) =>
          h.revision.memorySpaceId === v.memorySpaceId &&
          h.revision.memoryId === v.memoryId &&
          same(h.revision.scope, v.heads[0]?.revision.scope),
      ),
  ),
);
export type ResolveMemoryConflictInput = typeof ResolveMemoryConflictInput.Type;

export const GenerateMemorySummaryInput = struct({
  cwd: canonical,
  sourceThread: ScopedThreadRef,
  sourceWatermark: MemorySourceWatermark,
  messages: array(struct({ messageId: MessageId, text: Schema.String, completed: Schema.Boolean })),
  modelSelection: MemoryModelSelection,
}).check(
  Schema.makeFilter((v) => jsonBytes(v) <= 262144 && unique(v.messages.map((m) => m.messageId))),
);
export type GenerateMemorySummaryInput = typeof GenerateMemorySummaryInput.Type;

export const ResolveMemoryConflictResult = bounded(
  struct({
    text,
    assertionKind: MemoryAssertionKind,
    evidence: array(MemoryEvidence),
    judgment: Schema.String.check(Schema.makeFilter((s) => s.trim().length > 0)),
  }).check(Schema.makeFilter((v) => assertionValid(v.assertionKind, v.evidence))),
  65536,
);
export type ResolveMemoryConflictResult = typeof ResolveMemoryConflictResult.Type;

export const GenerateMemorySummaryResult = bounded(
  struct({ text, assertionKind: MemoryAssertionKind, evidence: array(MemoryEvidence) }).check(
    Schema.makeFilter((v) => assertionValid(v.assertionKind, v.evidence)),
  ),
  65536,
);
export type GenerateMemorySummaryResult = typeof GenerateMemorySummaryResult.Type;

export const MemoryGenerationExecution = struct({
  requestedModelSelection: MemoryModelSelection,
  effectiveProvider: ProviderDriverKind,
  effectiveModel: canonical,
  providerInstanceId: canonical.pipe(Schema.brand("ProviderInstanceId")),
  environmentId: EnvironmentId,
}).check(Schema.makeFilter((v) => v.providerInstanceId === v.requestedModelSelection.instanceId));
export type MemoryGenerationExecution = typeof MemoryGenerationExecution.Type;

export const ResolveMemoryConflictExecutionResult = struct({
  result: ResolveMemoryConflictResult,
  execution: MemoryGenerationExecution,
});
export type ResolveMemoryConflictExecutionResult = typeof ResolveMemoryConflictExecutionResult.Type;

export const GenerateMemorySummaryExecutionResult = struct({
  result: GenerateMemorySummaryResult,
  execution: MemoryGenerationExecution,
});
export type GenerateMemorySummaryExecutionResult = typeof GenerateMemorySummaryExecutionResult.Type;
export function validateMemoryGenerationResult(
  input: ResolveMemoryConflictInput | GenerateMemorySummaryInput,
  result: ResolveMemoryConflictResult | GenerateMemorySummaryResult,
): boolean {
  if (!assertionValid(result.assertionKind, result.evidence)) return false;
  return result.evidence.every((e) => {
    if (e.origin === "model")
      return (
        e.messageIds.length === 0 &&
        e.sourceThread === undefined &&
        e.watermark === undefined &&
        e.importSourceId === undefined
      );
    if ("heads" in input)
      return input.heads
        .flatMap((h) => h.payload.evidence)
        .some(
          (source) =>
            e.origin === source.origin &&
            same(e.sourceThread, source.sourceThread) &&
            same(e.watermark, source.watermark) &&
            e.importSourceId === source.importSourceId &&
            e.messageIds.every((id) => source.messageIds.includes(id)),
        );
    return (
      e.origin === "thread" &&
      e.messageIds.length > 0 &&
      same(e.sourceThread, input.sourceThread) &&
      same(e.watermark, input.sourceWatermark) &&
      e.importSourceId === undefined &&
      e.messageIds.every((id) => input.messages.some((m) => m.messageId === id && m.completed))
    );
  });
}

export const MemoryResolutionLease = struct({
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  conflictId: MemoryConflictId,
  conflictHeadSet: heads.check(Schema.makeFilter((vs) => vs.length >= 2)),
  holderEnvironmentId: EnvironmentId,
  attemptId: MemoryOperationId,
  frozenDefaultModelSelection: MemoryModelSelection,
  fencingToken: PositiveInt,
  claimedAtHubTime: MemoryUtcTimestamp,
  expiresAtHubTime: MemoryUtcTimestamp,
  attemptDeadlineHubTime: MemoryUtcTimestamp,
}).check(
  Schema.makeFilter(
    (v) =>
      Date.parse(v.claimedAtHubTime) <= Date.parse(v.expiresAtHubTime) &&
      Date.parse(v.expiresAtHubTime) <= Date.parse(v.attemptDeadlineHubTime) &&
      Date.parse(v.expiresAtHubTime) - Date.parse(v.claimedAtHubTime) <=
        MEMORY_RESOLUTION_ATTEMPT_MAX_MS &&
      Date.parse(v.attemptDeadlineHubTime) - Date.parse(v.claimedAtHubTime) <=
        MEMORY_RESOLUTION_ATTEMPT_MAX_MS,
  ),
);
export type MemoryResolutionLease = typeof MemoryResolutionLease.Type;
export interface MemoryHubPrincipal {
  readonly environmentId: EnvironmentId;
  readonly memorySpaceId: MemorySpaceId;
  readonly credentialVersion: number;
  readonly scopes: readonly ["memory:sync"];
}

export const MemoryHubReceipt = struct({
  operationId: MemoryOperationId,
  memoryId: MemoryId,
  operationDigest: digest,
  outcome: Schema.Literals(["accepted", "conflicted", "deleted", "rejected"]),
  hubSequence: Schema.NullOr(PositiveInt),
  failureCode: Schema.optionalKey(MemoryFailureCode),
  capacity: Schema.optionalKey(MemoryCapacityExceeded),
}).check(
  Schema.makeFilter(
    (v) =>
      (v.outcome === "rejected") === (v.failureCode !== undefined) &&
      (v.failureCode === "capacity_exceeded") === (v.capacity !== undefined) &&
      (v.outcome === "rejected" || v.hubSequence !== null),
  ),
);
export type MemoryHubReceipt = typeof MemoryHubReceipt.Type;

export const MemoryHubEntry = Schema.Union([
  struct({
    kind: Schema.Literal("operation"),
    hubSequence: PositiveInt,
    receipt: MemoryHubReceipt,
    operation: MemoryOperation,
  }),
  struct({
    kind: Schema.Literal("metadata"),
    hubSequence: PositiveInt,
    receipt: MemoryHubReceipt,
    memoryId: MemoryId,
    revision: Schema.optionalKey(MemoryRevision),
    tombstone: Schema.optionalKey(MemoryTombstone),
  }),
]).check(
  Schema.makeFilter(
    (v) =>
      v.hubSequence === v.receipt.hubSequence &&
      (v.kind === "operation"
        ? v.operation.operationId === v.receipt.operationId &&
          v.operation.memoryId === v.receipt.memoryId
        : v.memoryId === v.receipt.memoryId),
  ),
);
export type MemoryHubEntry = typeof MemoryHubEntry.Type;

export const MemoryCheckpointReportGuard = struct({
  reportId: digest,
  resolvingEnvironmentId: EnvironmentId,
  resolutionId: MemoryResolutionId,
  outcome: Schema.Literals(["resolved", "reverted"]),
});
export type MemoryCheckpointReportGuard = typeof MemoryCheckpointReportGuard.Type;

export const MemoryCompactReceipt = struct({
  memorySpaceId: MemorySpaceId,
  originEnvironmentId: EnvironmentId,
  operationKind: Schema.Literals(["upsert", "forget", "resolve", "revert"]),
  receipt: MemoryHubReceipt,
  revisionId: Schema.NullOr(MemoryRevisionId),
  resolutionId: Schema.NullOr(MemoryResolutionId),
  revertsResolutionId: Schema.NullOr(MemoryResolutionId),
  attemptId: Schema.NullOr(MemoryOperationId),
  fencingToken: Schema.NullOr(PositiveInt),
  reportGuard: Schema.NullOr(MemoryCheckpointReportGuard),
}).check(
  Schema.makeFilter((v) => {
    if (v.receipt.hubSequence === null) return false;
    if (v.operationKind === "forget" || v.receipt.outcome === "rejected") {
      if (v.revisionId !== null) return false;
    } else if (v.revisionId === null) return false;
    if (v.operationKind === "resolve") {
      if (
        v.resolutionId === null ||
        v.attemptId === null ||
        v.fencingToken === null ||
        v.revertsResolutionId !== null
      )
        return false;
    } else {
      if (v.attemptId !== null || v.fencingToken !== null) return false;
      if (
        v.operationKind === "revert"
          ? v.resolutionId === null || v.revertsResolutionId !== v.resolutionId
          : v.resolutionId !== null || v.revertsResolutionId !== null
      )
        return false;
    }
    const needsGuard =
      (v.operationKind === "resolve" || v.operationKind === "revert") &&
      (v.receipt.outcome === "accepted" || v.receipt.outcome === "conflicted");
    return needsGuard
      ? v.reportGuard !== null &&
          v.reportGuard.resolutionId === v.resolutionId &&
          v.reportGuard.outcome === (v.operationKind === "resolve" ? "resolved" : "reverted") &&
          (v.operationKind !== "resolve" ||
            v.reportGuard.resolvingEnvironmentId === v.originEnvironmentId)
      : v.reportGuard === null;
  }),
);
export type MemoryCompactReceipt = typeof MemoryCompactReceipt.Type;

export const MemoryIdentityRecord = struct({
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  scope: MemoryScope,
  creatingEnvironmentId: EnvironmentId,
  createOperationId: MemoryOperationId,
  createdAtUtc: MemoryUtcTimestamp,
});
export type MemoryIdentityRecord = typeof MemoryIdentityRecord.Type;

export const MemoryFenceRecord = struct({
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  highestFencingToken: NonNegativeInt,
  activeLease: Schema.NullOr(MemoryResolutionLease),
}).check(
  Schema.makeFilter(
    (v) =>
      v.activeLease === null ||
      (v.activeLease.memorySpaceId === v.memorySpaceId &&
        v.activeLease.memoryId === v.memoryId &&
        v.activeLease.fencingToken === v.highestFencingToken),
  ),
);
export type MemoryFenceRecord = typeof MemoryFenceRecord.Type;

export const MemorySuppressionRecord = Schema.Union([
  struct({
    memorySpaceId: MemorySpaceId,
    memoryId: MemoryId,
    deleteOperationId: MemoryOperationId,
    kind: Schema.Literal("sourceKey"),
    sourceKey: MemorySourceKey,
  }),
  struct({
    memorySpaceId: MemorySpaceId,
    memoryId: MemoryId,
    deleteOperationId: MemoryOperationId,
    kind: Schema.Literal("content"),
    content: MemoryContentSuppression,
  }),
  struct({
    memorySpaceId: MemorySpaceId,
    memoryId: MemoryId,
    deleteOperationId: MemoryOperationId,
    kind: Schema.Literal("sourceExclusion"),
    exclusion: MemorySourceExclusion.check(Schema.makeFilter((v) => v.messageIds.length === 1)),
  }),
]);
export type MemorySuppressionRecord = typeof MemorySuppressionRecord.Type;

export const MemoryHubCheckpointPage = bounded(
  struct({
    memorySpaceId: MemorySpaceId,
    checkpointSequence: NonNegativeInt,
    retentionFloor: NonNegativeInt,
    causalBoundary: MemoryCausalBoundary,
    pageOrdinal: NonNegativeInt,
    items: array(MemoryItem),
    revisions: array(revisionPair),
    tombstones: array(MemoryTombstone),
    conflicts: array(MemoryConflict),
    resolutions: array(resolutionPair),
    compactReceipts: array(MemoryCompactReceipt),
    identities: array(MemoryIdentityRecord),
    fences: array(MemoryFenceRecord),
    suppressions: array(MemorySuppressionRecord),
    nextCursor: Schema.NullOr(canonical),
    bootstrapComplete: Schema.Boolean,
  }).check(
    Schema.makeFilter((v) => {
      const count =
        v.items.length +
        v.revisions.length +
        v.tombstones.length +
        v.conflicts.length +
        v.resolutions.length +
        v.compactReceipts.length +
        v.identities.length +
        v.fences.length +
        v.suppressions.length;
      return (
        count <= 100 &&
        (count > 0 || v.bootstrapComplete) &&
        v.retentionFloor <= v.checkpointSequence &&
        v.causalBoundary.checkpointSequence === v.checkpointSequence &&
        v.bootstrapComplete === (v.nextCursor === null) &&
        v.tombstones.every(
          (t) =>
            t.suppressedSourceKeys.length +
              t.suppressedContent.length +
              t.sourceExclusions.length ===
            0,
        )
      );
    }),
  ),
  262144,
);
export type MemoryHubCheckpointPage = typeof MemoryHubCheckpointPage.Type;
const hub = { protocolVersion: Schema.Literal(1), memorySpaceId: MemorySpaceId };

export const MemoryHubJoinInput = struct({
  protocolVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  memorySpaceId: Schema.NullOr(MemorySpaceId),
});
export type MemoryHubJoinInput = typeof MemoryHubJoinInput.Type;

export const MemoryHubJoinResult = struct({
  ...hub,
  hubEnvironmentId: EnvironmentId,
  checkpointSequence: NonNegativeInt,
  snapshotToken: canonical,
  causalBoundary: MemoryCausalBoundary,
  retentionFloor: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (v) =>
      v.checkpointSequence === v.causalBoundary.checkpointSequence &&
      v.retentionFloor <= v.checkpointSequence,
  ),
);
export type MemoryHubJoinResult = typeof MemoryHubJoinResult.Type;

export const MemoryHubPushInput = bounded(
  struct({ ...hub, environmentId: EnvironmentId, operations: array(MemoryOperation) }).check(
    Schema.makeFilter((v) =>
      v.operations.every(
        (o) => o.memorySpaceId === v.memorySpaceId && o.originEnvironmentId === v.environmentId,
      ),
    ),
  ),
  1048576,
);
export type MemoryHubPushInput = typeof MemoryHubPushInput.Type;

export const MemoryHubPushResult = struct({ receipts: array(MemoryHubReceipt) });
export type MemoryHubPushResult = typeof MemoryHubPushResult.Type;

export const MemoryHubPullInput = struct({
  ...hub,
  environmentId: EnvironmentId,
  afterSequence: NonNegativeInt,
  limit,
  highWatermark: Schema.optionalKey(NonNegativeInt),
  snapshotToken: Schema.optionalKey(canonical),
  cursor: Schema.optionalKey(canonical),
}).check(
  Schema.makeFilter((v) =>
    v.snapshotToken !== undefined ? v.highWatermark === undefined : v.cursor === undefined,
  ),
);
export type MemoryHubPullInput = typeof MemoryHubPullInput.Type;

export const MemoryHubPullResult = bounded(
  struct({
    highWatermark: NonNegativeInt,
    throughSequence: NonNegativeInt,
    hasMore: Schema.Boolean,
    entries: array(MemoryHubEntry),
    checkpoint: Schema.optionalKey(MemoryHubCheckpointPage),
  }).check(
    Schema.makeFilter(
      (v) =>
        v.throughSequence <= v.highWatermark &&
        (v.checkpoint === undefined ||
          (v.entries.length === 0 &&
            v.throughSequence === v.checkpoint.checkpointSequence &&
            v.hasMore === !v.checkpoint.bootstrapComplete)),
    ),
  ),
  262144,
);
export type MemoryHubPullResult = typeof MemoryHubPullResult.Type;
const leaseKey = {
  ...hub,
  memoryId: MemoryId,
  conflictId: MemoryConflictId,
  holderEnvironmentId: EnvironmentId,
  attemptId: MemoryOperationId,
};

export const MemoryHubClaimInput = struct({
  ...leaseKey,
  conflictHeadSet: heads.check(Schema.makeFilter((vs) => vs.length >= 2)),
  frozenDefaultModelSelection: MemoryModelSelection,
});
export type MemoryHubClaimInput = typeof MemoryHubClaimInput.Type;

export const MemoryHubRenewInput = struct({ ...leaseKey, fencingToken: PositiveInt });
export type MemoryHubRenewInput = typeof MemoryHubRenewInput.Type;

export const MemoryHubReleaseInput = struct({ ...leaseKey, fencingToken: PositiveInt });
export type MemoryHubReleaseInput = typeof MemoryHubReleaseInput.Type;

export const MemoryHubReleaseResult = struct({ released: Schema.Boolean });
export type MemoryHubReleaseResult = typeof MemoryHubReleaseResult.Type;

export const MemoryHubApplyResolutionInput = struct({
  ...hub,
  holderEnvironmentId: EnvironmentId,
  attemptId: MemoryOperationId,
  operation: MemoryOperation.check(Schema.makeFilter((v) => v.kind === "resolve")),
}).check(
  Schema.makeFilter(
    (v) =>
      v.operation.memorySpaceId === v.memorySpaceId &&
      v.operation.originEnvironmentId === v.holderEnvironmentId,
  ),
);
export type MemoryHubApplyResolutionInput = typeof MemoryHubApplyResolutionInput.Type;
const sourceRequestFields = {
  requestId: MemorySourceReadRequestId,
  memoryId: MemoryId,
  sourceThread: ScopedThreadRef,
  sourceWatermark: MemorySourceWatermark,
  messageIds: distinct(MessageId, 100, 1),
  ...paging,
  authorizedScopes: Schema.Tuple([
    Schema.Literal("memory:read"),
    Schema.Literal("orchestration:read"),
  ]),
};

export const MemorySourceReadRequest = struct({
  ...sourceRequestFields,
  memorySpaceId: MemorySpaceId,
  requesterEnvironmentId: EnvironmentId,
  expiresAtHubTime: MemoryUtcTimestamp,
});
export type MemorySourceReadRequest = typeof MemorySourceReadRequest.Type;

export const MemoryHubSourceReadRequestInput = struct({ ...hub, ...sourceRequestFields });
export type MemoryHubSourceReadRequestInput = typeof MemoryHubSourceReadRequestInput.Type;

export const MemoryHubSourceReadRequestResult = struct({ request: MemorySourceReadRequest });
export type MemoryHubSourceReadRequestResult = typeof MemoryHubSourceReadRequestResult.Type;

export const MemoryHubSourceReadCollectInput = struct({
  ...hub,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(32)),
});
export type MemoryHubSourceReadCollectInput = typeof MemoryHubSourceReadCollectInput.Type;

export const MemoryHubSourceReadCollectResult = bounded(
  struct({ requests: array(MemorySourceReadRequest, 32) }),
  65536,
);
export type MemoryHubSourceReadCollectResult = typeof MemoryHubSourceReadCollectResult.Type;

export const MemorySourceReadOutcome = bounded(
  Schema.Union([
    struct({ kind: Schema.Literal("available"), page: MemorySourcePage }),
    struct({
      kind: Schema.Literal("unavailable"),
      code: Schema.Literals([
        "source_unavailable",
        "forgotten",
        "source_invalidated",
        "secret_detected",
      ]),
    }),
    struct({
      kind: Schema.Literal("denied"),
      requiredPermission: Schema.Literal("orchestration:read"),
    }),
  ]),
  65536,
);
export type MemorySourceReadOutcome = typeof MemorySourceReadOutcome.Type;

export const MemoryHubSourceReadRespondInput = struct({
  ...hub,
  requestId: MemorySourceReadRequestId,
  outcome: MemorySourceReadOutcome,
});
export type MemoryHubSourceReadRespondInput = typeof MemoryHubSourceReadRespondInput.Type;

export const MemoryHubSourceReadRespondResult = struct({ accepted: Schema.Boolean });
export type MemoryHubSourceReadRespondResult = typeof MemoryHubSourceReadRespondResult.Type;

export const MemoryHubSourceReadResultInput = struct({
  ...hub,
  requestId: MemorySourceReadRequestId,
});
export type MemoryHubSourceReadResultInput = typeof MemoryHubSourceReadResultInput.Type;

export const MemoryHubSourceReadResultResult = bounded(
  Schema.Union([
    struct({ state: Schema.Literal("pending"), expiresAtHubTime: MemoryUtcTimestamp }),
    struct({ state: Schema.Literal("completed"), outcome: MemorySourceReadOutcome }),
    struct({ state: Schema.Literal("expired"), code: Schema.Literal("source_unavailable") }),
  ]),
  MEMORY_PAGE_MAX_UTF8_BYTES,
);
export type MemoryHubSourceReadResultResult = typeof MemoryHubSourceReadResultResult.Type;
export const MEMORY_MCP_TOOLS = [
  "memory_search",
  "memory_list",
  "memory_read",
  "memory_history",
  "memory_sync_status",
  "memory_upsert",
  "memory_forget",
  "memory_revert_resolution",
  "memory_read_source",
] as const;
export const MEMORY_HUB_PATHS = {
  join: "/api/memory-hub/v1/join",
  push: "/api/memory-hub/v1/push",
  pull: "/api/memory-hub/v1/pull",
  claim: "/api/memory-hub/v1/claim",
  renew: "/api/memory-hub/v1/renew",
  applyResolution: "/api/memory-hub/v1/apply-resolution",
  release: "/api/memory-hub/v1/release",
  sourceReadRequest: "/api/memory-hub/v1/source-read/request",
  sourceReadCollect: "/api/memory-hub/v1/source-read/collect",
  sourceReadRespond: "/api/memory-hub/v1/source-read/respond",
  sourceReadResult: "/api/memory-hub/v1/source-read/result",
} as const;
const checkpointDecode = Schema.decodeUnknownSync(MemoryHubCheckpointPage, {
  onExcessProperty: "error",
});
/** Validate the complete staged snapshot without applying stateful admission or quotas. */
export function validateMemoryCheckpointRecords(
  pages: readonly MemoryHubCheckpointPage[],
): boolean {
  if (pages.length === 0) return false;
  const first = pages[0]!;
  try {
    pages.forEach((p) => checkpointDecode(p));
  } catch {
    return false;
  }
  if (
    !pages.every(
      (p, i) =>
        p.pageOrdinal === i &&
        p.memorySpaceId === first.memorySpaceId &&
        p.checkpointSequence === first.checkpointSequence &&
        p.retentionFloor === first.retentionFloor &&
        same(p.causalBoundary, first.causalBoundary) &&
        p.bootstrapComplete === (i === pages.length - 1),
    )
  )
    return false;
  const identities = pages.flatMap((p) => p.identities),
    fences = pages.flatMap((p) => p.fences),
    receipts = pages.flatMap((p) => p.compactReceipts),
    revisions = pages.flatMap((p) => p.revisions),
    resolutions = pages.flatMap((p) => p.resolutions),
    tombstones = pages.flatMap((p) => p.tombstones),
    suppressions = pages.flatMap((p) => p.suppressions),
    conflicts = pages.flatMap((p) => p.conflicts),
    items = pages.flatMap((p) => p.items);
  if (
    ![
      identities.map((v) => v.memoryId),
      fences.map((v) => v.memoryId),
      receipts.map((v) => v.receipt.operationId),
      revisions.map((v) => v.revision.revisionId),
      resolutions.map((v) => v.resolution.resolutionId),
      tombstones.map((v) => v.memoryId),
      conflicts.map((v) => v.conflictId),
      items.map((v) => v.memoryId),
      suppressions.map((v) => JSON.stringify(v)),
    ].every(unique)
  )
    return false;
  const identity = (id: MemoryId) => identities.find((v) => v.memoryId === id);
  const fence = (id: MemoryId) => fences.find((v) => v.memoryId === id);
  const receipt = (id: MemoryOperationId) => receipts.find((v) => v.receipt.operationId === id);
  const metadata = [
    ...identities,
    ...fences,
    ...receipts.map((r) => ({ ...r, memoryId: r.receipt.memoryId })),
    ...revisions.map((r) => r.revision),
    ...resolutions.map((r) => r.resolution),
    ...tombstones,
    ...suppressions,
    ...conflicts,
    ...items,
  ];
  if (
    !metadata.every(
      (v) =>
        v.memorySpaceId === first.memorySpaceId &&
        identity(v.memoryId) !== undefined &&
        fence(v.memoryId) !== undefined,
    )
  )
    return false;
  if (
    !receipts.every(
      (r) =>
        r.reportGuard === null ||
        r.reportGuard.reportId ===
          reportKeyDigest(
            JSON.stringify([
              r.memorySpaceId,
              r.reportGuard.resolvingEnvironmentId,
              r.reportGuard.resolutionId,
              r.receipt.operationId,
              r.reportGuard.outcome,
            ]),
          ),
    )
  )
    return false;
  if (
    !receipts.every(
      (r) =>
        r.operationKind !== "resolve" ||
        (fence(r.receipt.memoryId)?.highestFencingToken ?? -1) >= (r.fencingToken ?? 0),
    )
  )
    return false;
  if (
    !receipts.every(
      (r) => r.receipt.hubSequence !== null && r.receipt.hubSequence <= first.checkpointSequence,
    )
  )
    return false;
  if (
    !identities.every((i) => {
      const r = receipt(i.createOperationId);
      return (
        r !== undefined &&
        r.receipt.memoryId === i.memoryId &&
        r.originEnvironmentId === i.creatingEnvironmentId &&
        (r.receipt.outcome === "accepted" || r.receipt.outcome === "conflicted") &&
        r.operationKind === "upsert"
      );
    })
  )
    return false;
  if (
    !revisions.every(({ revision: r }) => {
      const rec = receipt(r.operationId);
      return (
        same(r.scope, identity(r.memoryId)?.scope) &&
        rec !== undefined &&
        rec.receipt.memoryId === r.memoryId &&
        rec.revisionId === r.revisionId
      );
    })
  )
    return false;
  if (
    !items.every((i) =>
      i.status === "forgotten"
        ? tombstones.some((t) => same(t, i.tombstone))
        : same(i.scope, identity(i.memoryId)?.scope),
    )
  )
    return false;
  if (
    !tombstones.every((t) => {
      const r = receipt(t.deleteOperationId);
      return (
        r?.receipt.outcome === "deleted" &&
        r.receipt.memoryId === t.memoryId &&
        r.originEnvironmentId === t.deletingEnvironmentId &&
        fence(t.memoryId)?.activeLease === null
      );
    })
  )
    return false;
  if (
    !suppressions.every((s) =>
      tombstones.some(
        (t) => t.memoryId === s.memoryId && t.deleteOperationId === s.deleteOperationId,
      ),
    )
  )
    return false;
  if (
    !resolutions.every(({ resolution: r }) => {
      const rec = receipts.find(
        (c) => c.resolutionId === r.resolutionId && c.operationKind === "resolve",
      );
      return (
        rec !== undefined &&
        rec.revisionId === r.resultRevisionId &&
        rec.fencingToken === r.fencingToken &&
        (fence(r.memoryId)?.highestFencingToken ?? -1) >= r.fencingToken
      );
    })
  )
    return false;
  return fences.every(
    (f) =>
      f.activeLease === null ||
      conflicts.some(
        (c) =>
          c.memoryId === f.memoryId &&
          c.conflictId === f.activeLease?.conflictId &&
          c.status !== "resolved" &&
          same(c.heads, f.activeLease.conflictHeadSet),
      ),
  );
}

// A synchronous SHA256 over bounded canonical report keys keeps this validator usable by every client.
function reportKeyDigest(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(length);
  buffer.set(bytes);
  buffer[bytes.length] = 128;
  const view = new DataView(buffer.buffer);
  view.setUint32(length - 4, bytes.length * 8);
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++) if (!primes.some((p) => n % p === 0)) primes.push(n);
  const k = primes.map((p) => Math.floor((Math.cbrt(p) % 1) * 2 ** 32));
  const h = primes.slice(0, 8).map((p) => Math.floor((Math.sqrt(p) % 1) * 2 ** 32));
  const rotr = (v: number, n: number) => (v >>> n) | (v << (32 - n));
  const w = new Uint32Array(64);
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      w[i] =
        w[i - 16]! +
        (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
        w[i - 7]! +
        (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, j] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const t1 =
        (j + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      j = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, j].forEach((v, i) => {
      h[i] = (h[i]! + v) >>> 0;
    });
  }
  return h.map((v) => v.toString(16).padStart(8, "0")).join("");
}

/** Source admission still belongs to the owner; this only checks returned locators. */
export function validateMemorySourceReadOutcome(
  request: MemorySourceReadRequest,
  outcome: MemorySourceReadOutcome,
): boolean {
  return (
    outcome.kind !== "available" ||
    (same(request.sourceThread, outcome.page.sourceThread) &&
      same(request.sourceWatermark, outcome.page.watermark) &&
      outcome.page.messages.length <= request.limit &&
      outcome.page.messages.every((m) => request.messageIds.includes(m.messageId)))
  );
}
