import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
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
const struct = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(fields).annotate({ parseOptions: { onExcessProperty: "error" } });
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
