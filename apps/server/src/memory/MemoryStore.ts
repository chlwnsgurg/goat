// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hashes do not depend on runtime identity.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { SqlError } from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";

export class MemoryStorageError extends Schema.TaggedError<MemoryStorageError>()(
  "MemoryStorageError",
  {
    stage: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Memory storage failed.";
  }
}
export class MemoryStoreConflict extends Schema.TaggedError<MemoryStoreConflict>()(
  "MemoryStoreConflict",
  {
    code: M.MemoryFailureCode,
  },
) {
  override get message() {
    return "Memory storage state changed.";
  }
}
export class MemoryCapacityError extends Schema.TaggedError<MemoryCapacityError>()(
  "MemoryCapacityError",
  {
    dimension: Schema.String,
    limit: Schema.Int,
  },
) {
  override get message() {
    return "Memory capacity exceeded.";
  }
}

// These contexts are constructed inside the server, never decoded from a transport.
const admissionBrand: unique symbol = Symbol("memory-admission");
export type MemoryAdmissionContext = {
  readonly [admissionBrand]: true;
  readonly kind: "localIntent" | "hubAdmission" | "approvedReplica";
};
export const localIntent: MemoryAdmissionContext = { [admissionBrand]: true, kind: "localIntent" };
export const hubAdmission: MemoryAdmissionContext = {
  [admissionBrand]: true,
  kind: "hubAdmission",
};
export const approvedReplica: MemoryAdmissionContext = {
  [admissionBrand]: true,
  kind: "approvedReplica",
};

const hashText = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const strict = { onExcessProperty: "error" } as const;
const digest = Schema.String.check(Schema.makeFilter((s) => /^[a-f0-9]{64}$/.test(s)));
const Metadata = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  operationId: M.MemoryOperationId,
  memorySpaceId: M.MemorySpaceId,
  memoryId: M.MemoryId,
  originEnvironmentId: M.EnvironmentId,
  kind: Schema.Literals(["upsert", "forget", "resolve", "revert"]),
  expectedHeads: Schema.Array(M.MemoryRevisionId),
  revision: Schema.optionalKey(M.MemoryRevision),
  tombstone: Schema.optionalKey(M.MemoryTombstone),
  resolution: Schema.optionalKey(M.MemoryResolution),
  conflictId: Schema.optionalKey(M.MemoryConflictId),
  fencingToken: Schema.optionalKey(Schema.Int),
  revertsResolutionId: Schema.optionalKey(M.MemoryResolutionId),
  restoredRevisionId: Schema.optionalKey(M.MemoryRevisionId),
});
const Receipt = Schema.Union([M.MemoryHubReceipt, M.MemoryMutationReceipt]);
export const StoredReceipt = Schema.Struct({
  operationDigest: digest,
  receipt: Receipt,
});
export type StoredReceipt = typeof StoredReceipt.Type;
export const LocalMemoryIntent = Schema.Struct({
  intentId: Schema.String,
  memoryId: M.MemoryId,
  environmentId: M.EnvironmentId,
  scope: M.MemoryScope,
  provenance: M.MemoryProvenance,
  assertionKind: M.MemoryAssertionKind,
  createdAtUtc: M.MemoryUtcTimestamp,
  payload: M.MemoryPayload,
});
export type LocalMemoryIntent = typeof LocalMemoryIntent.Type;
const LocalIntentMetadata = Schema.Struct({
  kind: Schema.Literal("localIntent"),
  intentId: Schema.String,
  memoryId: M.MemoryId,
  environmentId: M.EnvironmentId,
  scope: M.MemoryScope,
  provenance: M.MemoryProvenance,
  assertionKind: M.MemoryAssertionKind,
  createdAtUtc: M.MemoryUtcTimestamp,
  mapping: Schema.NullOr(
    Schema.Struct({
      memorySpaceId: M.MemorySpaceId,
      operationId: M.MemoryOperationId,
      revisionId: M.MemoryRevisionId,
    }),
  ),
});
const WorkMetadata = Schema.Union([
  Metadata,
  LocalIntentMetadata,
  Schema.Struct({
    kind: Schema.Literal("summary"),
    sourceThread: M.ScopedThreadRef,
    sourceWatermark: M.MemorySourceWatermark,
    memoryId: M.MemoryId,
    operationId: M.MemoryOperationId,
    revisionId: M.MemoryRevisionId,
    modelSelection: M.MemoryModelSelection,
  }),
  Schema.Struct({
    kind: Schema.Literal("claim"),
    conflictId: M.MemoryConflictId,
    sortedHeads: Schema.Array(M.MemoryRevisionId),
    headSetDigest: digest,
    attemptId: Schema.optionalKey(M.MemoryOperationId),
    leaseExpiresAt: Schema.optionalKey(Schema.Int),
    coordinatorEpoch: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({ kind: Schema.Literal("resolve"), ticket: M.MemoryResolutionLease }),
  Schema.Struct({
    kind: Schema.Literal("binding"),
    requestDigest: digest,
    result: M.MemoryProjectBindingUpdateResult,
  }),
  Schema.Struct({
    kind: Schema.Literal("rebuild"),
    revisionId: Schema.NullOr(M.MemoryRevisionId),
    generation: Schema.Int,
  }),
]);
export const MemoryWork = Schema.Struct({
  id: Schema.String,
  space: Schema.String,
  memoryId: Schema.NullOr(M.MemoryId),
  kind: Schema.Literals([
    "sync",
    "revert_intent",
    "summary",
    "consolidate",
    "claim",
    "resolve",
    "rebuild",
    "admin",
  ]),
  status: Schema.Literals(["pending", "running", "retry", "completed", "cancelled", "failed"]),
  metadata: WorkMetadata,
  payloadRef: Schema.NullOr(Schema.String),
  attempt: Schema.Int,
  nextAttemptAt: Schema.Int,
  claimedBy: Schema.NullOr(Schema.String),
  claimedUntil: Schema.NullOr(Schema.Int),
});
export type MemoryWork = typeof MemoryWork.Type;
const DeferredRow = Schema.Struct({
  kind: Schema.Literals(["index", "scanner", "parent", "projection", "cleanup", "report"]),
  state: Schema.Literals(["pending", "held", "ready"]),
  reason: Schema.NullOr(M.MemoryDeferredReason),
  revisionId: Schema.NullOr(M.MemoryRevisionId),
  generation: Schema.Int,
  sinceAtUtc: Schema.NullOr(M.MemoryUtcTimestamp),
  attempt: Schema.Int,
  dueAt: Schema.Int,
  lastAttemptAt: Schema.NullOr(Schema.Int),
  claimedBy: Schema.NullOr(Schema.String),
  claimedUntil: Schema.NullOr(Schema.Int),
});
export type MemoryDeferredWork = typeof DeferredRow.Type & {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly memoryId: M.MemoryId;
  readonly payloadBytes: number;
};
export const PendingForgetIntent = Schema.Struct({
  memorySpaceId: M.MemorySpaceId,
  memoryId: M.MemoryId,
  operationId: M.MemoryOperationId,
  requestedAtUtc: M.MemoryUtcTimestamp,
  attempts: Schema.Int,
  lastFailureCode: Schema.NullOr(M.MemoryFailureCode),
  operationDigest: Schema.NullOr(digest),
  submissionState: Schema.Literals(["unsubmitted", "uncertain", "rejected"]),
});
export type PendingForgetIntent = typeof PendingForgetIntent.Type;
export type MemoryAggregate = {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly memoryId: M.MemoryId;
  readonly item: M.MemoryItem | undefined;
  readonly heads: ReadonlyArray<M.MemoryRevisionId>;
  readonly revisions: ReadonlyArray<{
    readonly revision: M.MemoryRevision;
    readonly payload: M.MemoryPayload | null;
  }>;
  readonly tombstone: M.MemoryTombstone | undefined;
  readonly conflicts: ReadonlyArray<M.MemoryConflict>;
  readonly resolutions: ReadonlyArray<M.MemoryResolution>;
  readonly identity: M.MemoryIdentityRecord | undefined;
  readonly fence: M.MemoryFenceRecord | undefined;
  readonly pendingForget: PendingForgetIntent | undefined;
  readonly generation: number;
};
/** A published boundary is not proof that an arbitrary unknown UUID was compacted. */
export type MemoryParentState =
  | {
      readonly revisionId: M.MemoryRevisionId;
      readonly status: "retained";
      readonly parents: ReadonlyArray<M.MemoryRevisionId>;
    }
  | {
      readonly revisionId: M.MemoryRevisionId;
      readonly status: "crossMemory";
      readonly memoryId: M.MemoryId;
    }
  | {
      readonly revisionId: M.MemoryRevisionId;
      readonly status: "compacted";
      readonly boundary: M.MemoryCausalBoundary;
    }
  | {
      readonly revisionId: M.MemoryRevisionId;
      readonly status: "parked";
      readonly missingParents: ReadonlyArray<M.MemoryRevisionId>;
    }
  | { readonly revisionId: M.MemoryRevisionId; readonly status: "missing" };
export type MemoryAncestry = {
  readonly causalBoundary: M.MemoryCausalBoundary | undefined;
  readonly retentionFloor: number;
  readonly parents: ReadonlyArray<MemoryParentState>;
};
export type MemoryDecision = {
  readonly operation: M.MemoryOperation;
  readonly operationDigest: string;
  readonly admission: MemoryAdmissionContext;
  readonly receipt: M.MemoryHubReceipt | M.MemoryMutationReceipt;
  readonly item?: M.MemoryItem;
  readonly heads?: ReadonlyArray<M.MemoryRevisionId>;
  readonly conflict?: M.MemoryConflict;
  readonly identity?: M.MemoryIdentityRecord;
  readonly fence?: M.MemoryFenceRecord;
  readonly execution?: M.MemoryGenerationExecution;
  readonly work?: ReadonlyArray<MemoryWork>;
  readonly pending?: {
    readonly missingParents: ReadonlyArray<M.MemoryRevisionId>;
    readonly reason: M.MemoryDeferredReason;
  };
  readonly signals?: ReadonlyArray<M.MemoryChangeSignal>;
};
/** Fixed-width UUID/digest fields; environment strings are admitted once in the SQL dictionary. */
export function encodeCompactReceipt(
  record: M.MemoryCompactReceipt,
  environmentOrdinal: (id: M.EnvironmentId) => number,
): Uint8Array {
  const bytes: number[] = [1];
  const byte = (value: number) => bytes.push(value);
  const number = (value: number) => {
    let remaining = BigInt(value);
    do {
      const part = Number(remaining & 127n);
      remaining >>= 7n;
      byte(part | (remaining ? 128 : 0));
    } while (remaining);
  };
  const uuid = (value: string | null) => {
    byte(value === null ? 0 : 1);
    if (value !== null)
      for (const pair of value.replaceAll("-", "").match(/../g) ?? []) byte(parseInt(pair, 16));
  };
  const hash = (value: string) => {
    for (const pair of value.match(/../g) ?? []) byte(parseInt(pair, 16));
  };
  byte(["upsert", "forget", "resolve", "revert"].indexOf(record.operationKind));
  byte(["accepted", "conflicted", "deleted", "rejected"].indexOf(record.receipt.outcome));
  uuid(record.receipt.operationId);
  uuid(record.receipt.memoryId);
  hash(record.receipt.operationDigest);
  number(record.receipt.hubSequence!);
  number(environmentOrdinal(record.originEnvironmentId));
  uuid(record.revisionId);
  uuid(record.resolutionId);
  uuid(record.attemptId);
  number(record.fencingToken ?? 0);
  byte(record.revertsResolutionId === null ? 0 : 1);
  byte(record.reportGuard === null ? 0 : 1);
  if (record.reportGuard) {
    hash(record.reportGuard.reportId);
    number(environmentOrdinal(record.reportGuard.resolvingEnvironmentId));
    byte(record.reportGuard.outcome === "resolved" ? 0 : 1);
  }
  byte(
    record.receipt.failureCode === undefined
      ? 0
      : M.MemoryFailureCode.literals.indexOf(record.receipt.failureCode) + 1,
  );
  byte(record.receipt.capacity === undefined ? 0 : 1);
  if (record.receipt.capacity) {
    byte(M.MemoryCapacityDimension.literals.indexOf(record.receipt.capacity.dimension));
    number(record.receipt.capacity.current);
    number(record.receipt.capacity.limit);
    number(record.receipt.capacity.reclaimable);
  }
  return Uint8Array.from(bytes);
}

export type MemoryUsage = {
  readonly scopeItems: number;
  readonly scopeSummaries: number;
  readonly scopeExplicit: number;
  readonly environmentItems: number;
  readonly environmentLiveBytes: number;
  readonly environmentHistoryBytes: number;
  readonly environmentPermanentBytes: number;
  readonly environmentReceipts: number;
  readonly environmentLifetimeIds: number;
  readonly spaceItems: number;
  readonly lifetimeIds: number;
  readonly permanentBytes: number;
  readonly receipts: number;
  readonly liveBytes: number;
  readonly historyBytes: number;
  readonly logicalBytes: number;
  readonly keys: number;
  readonly workItems: number;
  readonly workBytes: number;
  readonly reportItems: number;
  readonly logRows: number;
  readonly logBytes: number;
};
export type MemoryQuotaCharge = {
  readonly space: string;
  readonly dimension: string;
  readonly scopeKey: string;
  readonly delta: number;
  readonly current?: number;
  readonly limit: number;
};
export type MemoryReadFilter = {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly scope: M.MemoryScope;
  readonly afterMemoryId?: M.MemoryId;
  readonly limit: number;
};
const FtsState = Schema.Struct({
  environment: M.EnvironmentId,
  state: Schema.Literals(["open", "braked"]),
  changedAt: Schema.NullOr(Schema.Int),
  allocatedBytes: Schema.NullOr(Schema.Int),
  measuredAt: Schema.NullOr(Schema.Int),
  measurementStatus: Schema.Literals(["available", "unavailable"]),
  mergePending: Schema.Boolean,
  changedRows: Schema.Int,
  lastMergeAt: Schema.NullOr(Schema.Int),
});
export type MemoryFtsState = typeof FtsState.Type;
export type MemoryIndexTarget = {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly memoryId: M.MemoryId;
  readonly revisionId: M.MemoryRevisionId;
  readonly generation: number;
};

class Transaction extends Context.Service<
  Transaction,
  { readonly signals: M.MemoryChangeSignal[] }
>()("goat/memory/MemoryStore/Transaction") {}

export class MemoryStore extends Context.Service<
  MemoryStore,
  {
    readonly transact: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | MemoryStorageError, R>;
    readonly receipt: (
      space: M.MemorySpaceId,
      id: M.MemoryOperationId,
    ) => Effect.Effect<StoredReceipt | undefined, MemoryStorageError>;
    readonly loadAggregate: (
      space: M.MemorySpaceId,
      id: M.MemoryId,
    ) => Effect.Effect<MemoryAggregate, MemoryStorageError>;
    readonly apply: (
      decision: MemoryDecision,
    ) => Effect.Effect<StoredReceipt, MemoryStorageError | MemoryStoreConflict>;
    readonly readAncestry: (
      space: M.MemorySpaceId,
      memoryId: M.MemoryId,
      parents: ReadonlyArray<M.MemoryRevisionId>,
    ) => Effect.Effect<MemoryAncestry, MemoryStorageError>;
    /** Recompute under transact; expectedGeneration fences the projection used by the decider. */
    readonly reconnectParked: (
      decision: MemoryDecision,
      expectedGeneration: number,
    ) => Effect.Effect<StoredReceipt, MemoryStorageError | MemoryStoreConflict>;
    readonly withReceivedCursor: <A, E, R>(
      input: {
        readonly memorySpaceId: M.MemorySpaceId;
        readonly hubEnvironmentId: M.EnvironmentId;
        readonly afterSequence: number;
        readonly expectedSequence: number;
      },
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | MemoryStorageError | MemoryStoreConflict, R>;
    readonly readOperation: (
      space: M.MemorySpaceId,
      id: M.MemoryOperationId,
    ) => Effect.Effect<M.MemoryOperation | undefined, MemoryStorageError>;
    readonly readWorkOperation: (
      id: string,
    ) => Effect.Effect<M.MemoryOperation | undefined, MemoryStorageError>;
    readonly pendingReceived: (
      space: M.MemorySpaceId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<M.MemoryOperation | undefined>, MemoryStorageError>;
    readonly stageRevertIntent: (input: {
      readonly operation: Extract<M.MemoryOperation, { kind: "revert" }>;
      readonly requestDigest: string;
    }) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
    readonly readCursor: (
      space: M.MemorySpaceId,
      hub: M.EnvironmentId,
    ) => Effect.Effect<number, MemoryStorageError>;
    readonly list: (
      filter: MemoryReadFilter,
    ) => Effect.Effect<ReadonlyArray<M.MemoryItem>, MemoryStorageError | MemoryStoreConflict>;
    readonly search: (
      filter: MemoryReadFilter,
      text: string,
      mode: "fts" | "substring",
    ) => Effect.Effect<
      ReadonlyArray<M.MemoryItem>,
      MemoryStorageError | MemoryStoreConflict | MemoryCapacityError
    >;
    readonly dueWork: (
      now: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<MemoryWork>, MemoryStorageError>;
    readonly enqueueWork: (work: MemoryWork) => Effect.Effect<void, MemoryStorageError>;
    readonly claimWork: (
      id: string,
      owner: string,
      now: number,
      until: number,
    ) => Effect.Effect<boolean, MemoryStorageError>;
    readonly finishWork: (
      id: string,
      status: "completed" | "cancelled" | "failed",
      receipt?: M.MemoryHubReceipt,
    ) => Effect.Effect<void, MemoryStorageError>;
    readonly readEligibleOutbox: (
      space: M.MemorySpaceId,
      now: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<MemoryWork>, MemoryStorageError>;
    readonly acknowledgeOutbox: (
      id: string,
      receipt: M.MemoryHubReceipt,
    ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly enqueuePendingForget: (input: {
      readonly operation: Extract<M.MemoryOperation, { kind: "forget" }>;
      readonly operationDigest: string;
    }) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly forgetLocalIntent: (
      environmentId: M.EnvironmentId,
      intentId: string,
    ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly preserveForgetIntent: (
      intent: PendingForgetIntent,
    ) => Effect.Effect<void, MemoryStorageError | MemoryCapacityError>;
    readonly pendingForgetIntents: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<PendingForgetIntent>, MemoryStorageError>;
    readonly settleForgetIntent: (
      space: M.MemorySpaceId,
      id: M.MemoryId,
    ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly readDeferred: (
      now: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<MemoryDeferredWork>, MemoryStorageError>;
    readonly claimDeferred: (
      target: MemoryDeferredWork,
      owner: string,
      now: number,
      until: number,
    ) => Effect.Effect<boolean, MemoryStorageError>;
    readonly recoverDeferred: (
      scannerPolicyVersion: number,
      now: number,
    ) => Effect.Effect<void, MemoryStorageError>;
    readonly finishDeferred: (
      target: MemoryDeferredWork,
      outcome: {
        readonly now: number;
        readonly failure?: M.MemoryDeferredReason;
        readonly scannerPolicyVersion?: number;
        readonly ruleIds?: ReadonlyArray<string>;
      },
    ) => Effect.Effect<boolean, MemoryStorageError>;
    readonly getProjectBinding: (
      space: M.MemorySpaceId,
      project: M.ScopedProjectRef,
    ) => Effect.Effect<M.MemoryProjectBinding | undefined, MemoryStorageError>;
    readonly putProjectBinding: (
      binding: M.MemoryProjectBinding,
      expectedVersion: number | null,
      now: number,
    ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly changes: (
      space: M.MemorySpaceId,
    ) => Effect.Effect<
      Stream.Stream<M.MemoryChangeSignal, MemoryStorageError>,
      MemoryStorageError,
      Scope.Scope
    >;
    readonly persistCompactReceipt: (
      record: M.MemoryCompactReceipt,
    ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly prunePayloads: (
      now: number,
      limit: number,
    ) => Effect.Effect<number, MemoryStorageError>;
    readonly operationMetadataBytes: (
      operation: M.MemoryOperation,
    ) => Effect.Effect<number, MemoryStorageError>;
    readonly usage: (
      space: M.MemorySpaceId,
      scope: M.MemoryScope,
    ) => Effect.Effect<MemoryUsage, MemoryStorageError>;
    readonly readSuppressions: (
      space: M.MemorySpaceId,
      id: M.MemoryId,
    ) => Effect.Effect<ReadonlyArray<M.MemorySuppressionRecord>, MemoryStorageError>;
    readonly logicalBytes: Effect.Effect<number, MemoryStorageError>;
    readonly reserve: (
      context: MemoryAdmissionContext,
      charges: ReadonlyArray<MemoryQuotaCharge>,
    ) => Effect.Effect<void, MemoryStorageError | MemoryCapacityError>;
    readonly counters: (space: string) => Effect.Effect<
      ReadonlyArray<{
        readonly dimension: string;
        readonly scope_key: string;
        readonly value: number;
      }>,
      MemoryStorageError
    >;
    readonly ftsState: (
      environment: M.EnvironmentId,
    ) => Effect.Effect<MemoryFtsState, MemoryStorageError>;
    readonly putFtsState: (state: MemoryFtsState) => Effect.Effect<void, MemoryStorageError>;
    readonly index: (
      target: MemoryIndexTarget,
    ) => Effect.Effect<boolean, MemoryStorageError | MemoryCapacityError>;
    readonly measureAllocation: () => Effect.Effect<
      {
        readonly memoryBytes: number | null;
        readonly ftsBytes: number | null;
        readonly dbFileBytes: number;
        readonly freelistBytes: number;
        readonly tables: ReadonlyArray<M.MemoryStorageTableUsage>;
      },
      MemoryStorageError
    >;
    readonly cleanupDerived: (limit: number) => Effect.Effect<number, MemoryStorageError>;
    readonly mergeFts: () => Effect.Effect<boolean, MemoryStorageError>;
    readonly recordSample: (
      environment: M.EnvironmentId,
      sample: M.MemoryStorageSample,
    ) => Effect.Effect<boolean, MemoryStorageError>;
    readonly samples: (
      environment: M.EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<M.MemoryStorageSample>, MemoryStorageError>;
    readonly putLocalIntent: (
      input: LocalMemoryIntent,
    ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly materializeLocalIntent: (input: {
      readonly environmentId: M.EnvironmentId;
      readonly intentId: string;
      readonly memorySpaceId: M.MemorySpaceId;
      readonly operationId: M.MemoryOperationId;
      readonly revisionId: M.MemoryRevisionId;
    }) => Effect.Effect<
      { readonly operation: M.MemoryOperation; readonly operationDigest: string },
      MemoryStorageError | MemoryStoreConflict
    >;
    readonly installCheckpointPage: (input: {
      readonly checkpointId: string;
      readonly page: M.MemoryHubCheckpointPage;
    }) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly completeCheckpoint: (input: {
      readonly memorySpaceId: M.MemorySpaceId;
      readonly hubEnvironmentId: M.EnvironmentId;
      readonly checkpointId: string;
      readonly pageCount: number;
    }) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly readDueClaimCandidates: (
      limit: number,
      now: number,
    ) => Effect.Effect<ReadonlyArray<MemoryWork>, MemoryStorageError>;
    readonly recoverClaimCandidates: (now: number) => Effect.Effect<void, MemoryStorageError>;
    readonly claimCandidate: (
      id: string,
      epoch: number,
      now: number,
    ) => Effect.Effect<boolean, MemoryStorageError>;
    readonly retryClaimCandidate: (
      id: string,
      nextAttemptAt: number,
      failureCode: M.MemoryFailureCode,
      leaseExpiresAt?: number,
    ) => Effect.Effect<void, MemoryStorageError>;
    readonly completeClaimCandidate: (id: string) => Effect.Effect<void, MemoryStorageError>;
    readonly persistResolutionTicket: (
      ticket: M.MemoryResolutionLease,
    ) => Effect.Effect<void, MemoryStorageError>;
    readonly pendingReports: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<M.MemoryReportDelivery>, MemoryStorageError>;
    readonly claimReport: (
      id: string,
      owner: string,
      now: number,
      until: number,
    ) => Effect.Effect<boolean, MemoryStorageError>;
    readonly acknowledgeReport: (
      input: M.MemoryReportDelivery,
    ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
    readonly failReport: (
      id: string,
      failure: M.MemoryFailureCode,
    ) => Effect.Effect<void, MemoryStorageError>;
    readonly wake: Effect.Effect<void>;
    readonly subscribeWake: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("goat/memory/MemoryStore") {}

// All JSON goes through Effect codecs, including values reconstructed from SQL rows.
const codec = <S extends Schema.Constraint>(schema: S) => {
  const json = Schema.fromJsonString(schema);
  const encode = Schema.encodeEffect(json);
  const decode = Schema.decodeUnknownEffect(json);
  return {
    encode: (value: S["Type"]) => stored("encode", encode(value)),
    decode: (value: unknown, options?: typeof strict) => stored("decode", decode(value, options)),
  };
};
const decodeLocalIntent = Schema.decodeUnknownEffect(LocalMemoryIntent);
const localMetadataCodec = codec(LocalIntentMetadata);
const decodeTicket = Schema.decodeUnknownEffect(M.MemoryResolutionLease);
const decodeReport = Schema.decodeUnknownEffect(M.MemoryReportDelivery);
const threadCodec = codec(M.ScopedThreadRef);
const decodeCheckpoint = Schema.decodeUnknownEffect(M.MemoryHubCheckpointPage);
const checkpointCodec = codec(M.MemoryHubCheckpointPage);
const stagedCheckpointCodec = codec(
  Schema.Struct({
    page: M.MemoryHubCheckpointPage,
    heads: Schema.Array(
      Schema.Struct({ memoryId: M.MemoryId, heads: Schema.Array(M.MemoryRevisionId) }),
    ),
  }),
);
const environmentOrdinalCodec = codec(Schema.Int.check(Schema.makeFilter((n) => n > 0)));
const compactCodec = codec(M.MemoryCompactReceipt);
const boundaryCodec = codec(M.MemoryCausalBoundary);
const suppressionKeyCodec = codec(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("sourceKey"), value: M.MemorySourceKey }),
    Schema.Struct({ kind: Schema.Literal("content"), value: M.MemoryContentSuppression }),
    Schema.Struct({ kind: Schema.Literal("sourceExclusion"), value: M.MemorySourceExclusion }),
  ]),
);
const metadataCodec = codec(Metadata);
const workMetadataCodec = codec(WorkMetadata);
const receiptCodec = codec(Receipt);
const Projection = Schema.Union([
  Schema.Struct({
    memorySpaceId: M.MemorySpaceId,
    memoryId: M.MemoryId,
    pendingSync: Schema.Boolean,
    localAvailability: M.MemoryLocalAvailability,
    status: Schema.Literal("active"),
    scope: M.MemoryScope,
    revision: M.MemoryRevision,
  }),
  M.MemoryItem.check(Schema.makeFilter((item) => item.status !== "active")),
]);
const projectionCodec = codec(Projection);
const decodeItem = Schema.decodeUnknownEffect(M.MemoryItem);
const payloadCodec = codec(M.MemoryPayload);
const resolutionPayloadCodec = codec(M.MemoryResolutionPayload);
const scopeCodec = codec(M.MemoryScope);
const headsCodec = codec(Schema.Array(M.MemoryRevisionId));
const provenanceCodec = codec(M.MemoryProvenance);
const availabilityCodec = codec(M.MemoryLocalAvailability);
const deferredCodec = codec(Schema.Array(DeferredRow));
const identityCodec = codec(M.MemoryIdentityRecord);
const fenceCodec = codec(M.MemoryFenceRecord);
const rulesCodec = codec(
  Schema.Array(Schema.String).check(
    Schema.makeFilter(
      (values) => values.length <= 64 && values.every((value) => value.length <= 128),
    ),
  ),
);
const sourceKeysCodec = codec(Schema.Array(M.MemorySourceKey));
const contentCodec = codec(Schema.Array(M.MemoryContentSuppression));
const exclusionsCodec = codec(Schema.Array(M.MemorySourceExclusion));
const selectionCodec = codec(M.MemoryModelSelection);
const executionCodec = codec(M.MemoryGenerationExecution);
const resolutionCodec = codec(M.MemoryResolution);
const sampleCodec = codec(M.MemoryStorageSample);
const keyCodec = codec(M.MemoryProjectKey);
const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperation);
const decodeWork = Schema.decodeUnknownEffect(MemoryWork);
const decodePendingForget = Schema.decodeUnknownEffect(PendingForgetIntent);
const decodeBinding = Schema.decodeUnknownEffect(M.MemoryProjectBinding);
const decodeTombstone = Schema.decodeUnknownEffect(M.MemoryTombstone);
const decodeConflict = Schema.decodeUnknownEffect(M.MemoryConflict);
const decodeRevision = Schema.decodeUnknownEffect(M.MemoryRevision);
const isSqlError = Schema.is(SqlError);
const isStorageError = Schema.is(MemoryStorageError);
const decodeMemoryId = Schema.decodeUnknownEffect(M.MemoryId);
const decodeMemorySpaceId = Schema.decodeUnknownEffect(M.MemorySpaceId);
const decodeReceipt = Schema.decodeUnknownEffect(Receipt);
const decodeFtsState = Schema.decodeUnknownEffect(FtsState);
const suppressionCodec = codec(M.MemorySuppressionRecord);
const decodeScope = Schema.decodeUnknownEffect(M.MemoryScope);
const stored = <A, E, R>(stage: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new MemoryStorageError({ stage, cause })));
const scopeKey = (scope: M.MemoryScope) => {
  if (scope.kind === "user") return "user";
  if (scope.kind === "thread")
    return `thread:${scope.thread.environmentId.length}:${scope.thread.environmentId}:${scope.thread.threadId}`;
  return scope.projectKey.kind === "repository"
    ? `repository:${scope.projectKey.groupingKey}`
    : `explicit:${scope.projectKey.sharedProjectId}`;
};
const metadataOf = (operation: M.MemoryOperation): typeof Metadata.Type => {
  if (operation.kind === "forget") return operation;
  const { payload: _payload, ...metadata } = operation;
  if (metadata.kind === "resolve") {
    const { resolutionPayload: _judgment, ...safe } = metadata;
    return safe;
  }
  return metadata;
};

const importTime = (ms: number) => Effect.succeed(DateTime.formatIso(DateTime.makeUnsafe(ms)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lane = yield* Semaphore.make(1);
  let signals = yield* PubSub.dropping<M.MemoryChangeSignal>(256);
  const wakes = yield* PubSub.sliding<void>(1);
  const wake = PubSub.publish(wakes, undefined).pipe(Effect.asVoid);
  const transact = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | MemoryStorageError, R> =>
    Effect.gen(function* () {
      const existing = yield* Effect.serviceOption(Transaction);
      if (Option.isSome(existing)) return yield* effect;
      return yield* lane.withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const journal = { signals: [] as M.MemoryChangeSignal[] };
            const result = yield* sql
              .withTransaction(restore(effect).pipe(Effect.provideService(Transaction, journal)))
              .pipe(
                Effect.mapError((cause) =>
                  isSqlError(cause)
                    ? new MemoryStorageError({ stage: "transaction", cause })
                    : (cause as E),
                ),
              );
            if (!(yield* PubSub.publishAll(signals, journal.signals))) {
              yield* PubSub.shutdown(signals);
              signals = yield* PubSub.dropping<M.MemoryChangeSignal>(256);
            }
            yield* wake;
            return result;
          }),
        ),
      );
    });
  const receipt = Effect.fn("MemoryStore.receipt")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryOperationId,
  ) {
    const rows = yield* stored(
      "receipt",
      sql<{ operation_digest: string; receipt_json: string }>`
      SELECT operation_digest,receipt_json FROM memory_events WHERE memory_space_id=${space} AND operation_id=${id}
      UNION ALL SELECT operation_digest,receipt_json FROM memory_compact_receipts WHERE space=${space} AND operation_id=${id} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      operationDigest: row.operation_digest,
      receipt: yield* stored("receipt-codec", receiptCodec.decode(row.receipt_json, strict)),
    };
  });
  const readAncestry = Effect.fn("MemoryStore.readAncestry")(function* (
    space: M.MemorySpaceId,
    memoryId: M.MemoryId,
    parents: ReadonlyArray<M.MemoryRevisionId>,
  ) {
    const states = yield* stored(
      "ancestry-boundary",
      sql<{
        boundary_json: string | null;
        retained_revision_boundary: number;
      }>`SELECT boundary_json,retained_revision_boundary FROM memory_compaction_state WHERE space=${space} AND published=1`,
    );
    const state = states[0];
    const causalBoundary = state?.boundary_json
      ? yield* boundaryCodec.decode(state.boundary_json, strict)
      : undefined;
    const result = yield* Effect.forEach(parents, (revisionId) =>
      Effect.gen(function* () {
        const rows = yield* stored(
          "ancestry-revision",
          sql<{
            memory_id: string;
            parents_json: string;
            missing_parents_json: string | null;
          }>`SELECT r.memory_id,r.parents_json,p.missing_parents_json FROM memory_revisions r LEFT JOIN memory_inbox_pending p ON p.space=r.space AND p.operation_id=r.operation_id AND p.record_kind='operation' WHERE r.space=${space} AND r.revision_id=${revisionId}`,
        );
        const row = rows[0];
        if (row) {
          const owner = yield* stored("ancestry-owner", decodeMemoryId(row.memory_id));
          if (owner === memoryId && row.missing_parents_json !== null)
            return {
              revisionId,
              status: "parked" as const,
              missingParents: yield* headsCodec.decode(row.missing_parents_json, strict),
            };
          return owner !== memoryId
            ? { revisionId, status: "crossMemory" as const, memoryId: owner }
            : {
                revisionId,
                status: "retained" as const,
                parents: yield* headsCodec.decode(row.parents_json, strict),
              };
        }
        // Exact durable revision membership, rather than timestamps or the existence of a checkpoint.
        const receipts = yield* stored(
          "ancestry-compact",
          sql<{
            compact_json: string;
          }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND json_extract(compact_json,'$.revisionId')=${revisionId}`,
        );
        for (const receipt of receipts) {
          const record = yield* compactCodec.decode(receipt.compact_json, strict);
          if (record.receipt.outcome === "rejected") continue;
          if (record.receipt.memoryId !== memoryId)
            return {
              revisionId,
              status: "crossMemory" as const,
              memoryId: record.receipt.memoryId,
            };
          if (
            causalBoundary &&
            record.receipt.hubSequence !== null &&
            record.receipt.hubSequence <= causalBoundary.checkpointSequence
          )
            return { revisionId, status: "compacted" as const, boundary: causalBoundary };
        }
        return { revisionId, status: "missing" as const };
      }),
    );
    return {
      causalBoundary,
      retentionFloor: state?.retained_revision_boundary ?? 0,
      parents: result,
    };
  });
  const readPending = Effect.fnUntraced(function* (space: M.MemorySpaceId, id: M.MemoryId) {
    const rows = yield* stored(
      "pending-forget",
      sql`SELECT space AS memorySpaceId,memory_id AS memoryId,operation_id AS operationId,requested_at_utc AS requestedAtUtc,attempts,last_failure_code AS lastFailureCode,operation_digest AS operationDigest,submission_state AS submissionState FROM memory_pending_forget_intents WHERE space=${space} AND memory_id=${id}`,
    );
    return rows[0]
      ? yield* stored("pending-forget-codec", decodePendingForget(rows[0], strict))
      : undefined;
  });
  const readItem = Effect.fnUntraced(function* (space: M.MemorySpaceId, id: M.MemoryId) {
    const rows = yield* stored(
      "item",
      sql<{
        item_json: string;
        heads_json: string;
        generation: number;
        body_json: string | null;
      }>`SELECT i.item_json,i.heads_json,i.generation,p.body_json FROM memory_items i LEFT JOIN memory_payloads p ON p.space=i.space AND p.payload_ref=i.payload_ref WHERE i.space=${space} AND i.memory_id=${id}`,
    );
    const row = rows[0];
    if (!row) return undefined;
    const projection = yield* projectionCodec.decode(row.item_json, strict);
    const item =
      projection.status === "active"
        ? row.body_json
          ? yield* stored(
              "item-codec",
              decodeItem(
                { ...projection, payload: yield* payloadCodec.decode(row.body_json, strict) },
                strict,
              ),
            )
          : yield* stored(
              "item-codec",
              decodeItem(
                {
                  memorySpaceId: space,
                  memoryId: id,
                  status: "blocked",
                  scope: projection.scope,
                  pendingSync: projection.pendingSync,
                  failureCode: "source_invalidated",
                  localAvailability: {
                    exposure: "held",
                    reasons: ["dependency_invalidated"],
                    deferred: [],
                    cleanupPending: true,
                  },
                },
                strict,
              ),
            )
        : yield* stored("item-codec", decodeItem(projection, strict));
    return { item, heads: yield* headsCodec.decode(row.heads_json), generation: row.generation };
  });
  const loadAggregate = Effect.fn("MemoryStore.loadAggregate")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) {
    const item = yield* readItem(space, id);
    const revisionRows = yield* stored(
      "revisions",
      sql<{
        revision_id: string;
        operation_id: string;
        parents_json: string;
        scope_json: string;
        assertion_kind: string;
        provenance_json: string;
        payload_ref: string | null;
        created_at: number;
        body_json: string | null;
      }>`
      SELECT r.*,p.body_json FROM memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref WHERE r.space=${space} AND r.memory_id=${id}`,
    );
    const revisions = yield* Effect.forEach(revisionRows, (row) =>
      Effect.gen(function* () {
        const revision = yield* stored(
          "revision-codec",
          decodeRevision(
            {
              memorySpaceId: space,
              memoryId: id,
              revisionId: row.revision_id,
              operationId: row.operation_id,
              parents: yield* headsCodec.decode(row.parents_json),
              scope: yield* scopeCodec.decode(row.scope_json),
              assertionKind: row.assertion_kind,
              provenance: yield* provenanceCodec.decode(row.provenance_json),
              payloadRef: row.revision_id,
              createdAtUtc: yield* importTime(row.created_at),
            },
            strict,
          ),
        );
        return {
          revision,
          payload:
            row.body_json && item?.item.status !== "forgotten"
              ? yield* stored("payload-codec", payloadCodec.decode(row.body_json, strict))
              : null,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isStorageError(cause)
            ? cause
            : new MemoryStorageError({ stage: "revision-codec", cause }),
        ),
      ),
    );
    const tombstones = yield* stored(
      "tombstone",
      sql<{
        delete_operation_id: string;
        deleting_environment_id: string;
        deleted_at: number;
        suppressed_source_keys_json: string;
        suppressed_content_json: string;
        source_exclusions_json: string;
      }>`SELECT * FROM memory_tombstones WHERE space=${space} AND memory_id=${id}`,
    );
    const t = tombstones[0];
    const tombstone = t
      ? yield* stored(
          "tombstone-codec",
          Effect.gen(function* () {
            return yield* decodeTombstone(
              {
                memorySpaceId: space,
                memoryId: id,
                deleteOperationId: t.delete_operation_id,
                deletingEnvironmentId: t.deleting_environment_id,
                deletedAtUtc: yield* importTime(t.deleted_at),
                suppressedSourceKeys: yield* sourceKeysCodec.decode(t.suppressed_source_keys_json),
                suppressedContent: yield* contentCodec.decode(t.suppressed_content_json),
                sourceExclusions: yield* exclusionsCodec.decode(t.source_exclusions_json),
              },
              strict,
            );
          }),
        )
      : undefined;
    const conflictRows = yield* stored(
      "conflicts",
      sql<{
        conflict_id: string;
        heads_json: string;
        status: string;
        failure_code: string | null;
      }>`SELECT * FROM memory_conflicts WHERE space=${space} AND memory_id=${id}`,
    );
    const conflicts = yield* stored(
      "conflict-codec",
      Effect.forEach(conflictRows, (row) =>
        Effect.gen(function* () {
          return yield* decodeConflict(
            {
              conflictId: row.conflict_id,
              memorySpaceId: space,
              memoryId: id,
              heads: yield* headsCodec.decode(row.heads_json),
              status: row.status,
              ...(row.failure_code ? { failureCode: row.failure_code } : {}),
            },
            strict,
          );
        }),
      ),
    );
    const resolutionRows = yield* stored(
      "resolutions",
      sql<{
        resolution_json: string;
      }>`SELECT resolution_json FROM memory_resolutions WHERE space=${space} AND memory_id=${id}`,
    );
    const resolutions = yield* stored(
      "resolution-codec",
      Effect.forEach(resolutionRows, (row) => resolutionCodec.decode(row.resolution_json, strict)),
    );
    const identities = yield* stored(
      "identity",
      sql<{
        identity_json: string;
        fence_json: string;
      }>`SELECT identity_json,fence_json FROM memory_identity_ledger WHERE space=${space} AND memory_id=${id}`,
    );
    const identity = identities[0];
    return {
      memorySpaceId: space,
      memoryId: id,
      item: item?.item,
      heads: item?.heads ?? [],
      generation: item?.generation ?? 0,
      revisions,
      tombstone,
      conflicts,
      resolutions,
      identity: identity
        ? yield* stored("identity-codec", identityCodec.decode(identity.identity_json, strict))
        : undefined,
      fence: identity
        ? yield* stored("fence-codec", fenceCodec.decode(identity.fence_json, strict))
        : undefined,
      pendingForget: yield* readPending(space, id),
    };
  });
  const nextWatermark = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const rows = yield* stored(
      "projection-watermark",
      sql<{
        projection_watermark: number;
      }>`INSERT INTO memory_compaction_state (space,projection_watermark) VALUES (${space},1) ON CONFLICT(space) DO UPDATE SET projection_watermark=projection_watermark+1 RETURNING projection_watermark`,
    );
    return rows[0]!.projection_watermark;
  });
  const emit = Effect.fnUntraced(function* (signal: M.MemoryChangeSignal) {
    const tx = yield* Effect.serviceOption(Transaction);
    if (Option.isNone(tx)) return yield* Effect.die("Memory write requires transaction ownership");
    tx.value.signals.push(signal);
  });
  const putItem = Effect.fnUntraced(function* (
    item: M.MemoryItem,
    heads: ReadonlyArray<M.MemoryRevisionId>,
    watermark: number,
  ) {
    const previous = yield* readItem(item.memorySpaceId, item.memoryId);
    const pending = yield* readPending(item.memorySpaceId, item.memoryId);
    const held =
      pending && item.status !== "forgotten"
        ? {
            memorySpaceId: item.memorySpaceId,
            memoryId: item.memoryId,
            status: "blocked" as const,
            scope: item.scope,
            failureCode: "forget_pending" as const,
            pendingSync: item.pendingSync,
            localAvailability: {
              ...item.localAvailability,
              exposure: "held" as const,
              reasons: [...new Set([...item.localAvailability.reasons, "forget_pending" as const])],
            },
          }
        : item;
    const scope =
      held.status === "forgotten"
        ? ((previous?.item.status !== "forgotten" ? previous?.item.scope : undefined) ?? {
            kind: "user" as const,
          })
        : held.scope;
    const generation = (previous?.generation ?? 0) + 1;
    const safeProjection =
      held.status === "active" ? (({ payload: _payload, ...rest }) => rest)(held) : held;
    const scannerDeferred =
      held.localAvailability.reasons.includes("scanner_pending") &&
      !held.localAvailability.deferred.some((d) => d.kind === "scanner")
        ? [
            ...held.localAvailability.deferred,
            {
              kind: "scanner" as const,
              state: "pending" as const,
              reason: "scanner_pending" as const,
              revisionId: heads.length === 1 ? heads[0]! : null,
              generation,
              sinceAtUtc: DateTime.formatIso(DateTime.makeUnsafe(0)),
            },
          ]
        : held.localAvailability.deferred;
    const deferred = scannerDeferred.map((d) => ({
      ...d,
      generation,
      attempt: 0,
      dueAt: 0,
      lastAttemptAt: null,
      claimedBy: null,
      claimedUntil: null,
    }));
    yield* stored(
      "projection",
      sql`INSERT INTO memory_items (space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json,generation,deferred_json,cleanup_pending)
      VALUES (${held.memorySpaceId},${held.memoryId},${yield* scopeCodec.encode(scope)},${scopeKey(scope)},${yield* headsCodec.encode(heads)},${held.status},${held.status === "active" ? held.revision.payloadRef : null},${watermark},${yield* projectionCodec.encode(safeProjection)},${yield* availabilityCodec.encode(held.localAvailability)},${generation},${yield* deferredCodec.encode(deferred)},${held.localAvailability.cleanupPending ? 1 : 0})
      ON CONFLICT(space,memory_id) DO UPDATE SET scope_json=excluded.scope_json,scope_key=excluded.scope_key,heads_json=excluded.heads_json,status=excluded.status,payload_ref=excluded.payload_ref,projection_watermark=excluded.projection_watermark,item_json=excluded.item_json,availability_json=excluded.availability_json,generation=excluded.generation,deferred_json=excluded.deferred_json,cleanup_pending=excluded.cleanup_pending,index_state='pending'`,
    );
  });
  const enqueueWork = Effect.fn("MemoryStore.enqueueWork")(function* (input: MemoryWork) {
    const work = yield* stored("work-codec", decodeWork(input, strict));
    yield* stored(
      "outbox",
      sql`INSERT INTO memory_outbox (id,space,memory_id,kind,status,metadata_json,payload_ref,attempt,next_attempt_at,claimed_by,claimed_until) VALUES (${work.id},${work.space},${work.memoryId},${work.kind},${work.status},${yield* workMetadataCodec.encode(work.metadata)},${work.payloadRef},${work.attempt},${work.nextAttemptAt},${work.claimedBy},${work.claimedUntil}) ON CONFLICT(id) DO NOTHING`,
    );
  });
  const purge = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
    watermark: number,
  ) {
    const ids = [id];
    const seen = new Set<string>();
    while (ids.length) {
      const current = ids.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const dependents = yield* stored(
        "dependencies",
        sql<{
          memory_id: string;
        }>`SELECT DISTINCT p.memory_id FROM memory_payloads p JOIN json_each(p.dependencies_json) d JOIN memory_revisions r ON r.space=p.space AND r.revision_id=d.value WHERE p.space=${space} AND r.memory_id=${current}`,
      );
      for (const row of dependents)
        ids.push(yield* stored("dependency-id", decodeMemoryId(row.memory_id)));
      yield* stored(
        "purge",
        sql`DELETE FROM memory_payloads WHERE space=${space} AND memory_id=${current}`,
      );
      yield* stored(
        "purge-revert",
        sql`DELETE FROM memory_revert_intents WHERE space=${space} AND memory_id=${current}`,
      );
      yield* stored(
        "purge-inbox",
        sql`DELETE FROM memory_inbox_pending WHERE space=${space} AND memory_id=${current}`,
      );
      yield* stored(
        "cancel-work",
        sql`UPDATE memory_outbox SET status='cancelled',payload_ref=NULL WHERE space=${space} AND memory_id=${current} AND status NOT IN ('completed','failed')`,
      );
      yield* stored(
        "cancel-claims",
        sql`UPDATE memory_conflicts SET attempt_id=NULL WHERE space=${space} AND memory_id=${current}`,
      );
      const old = yield* readItem(space, current);
      if (current !== id && old && old.item.status !== "forgotten") {
        const blocked: M.MemoryItem = {
          memorySpaceId: space,
          memoryId: current,
          status: "blocked",
          scope: old.item.scope,
          failureCode: "source_invalidated",
          pendingSync: old.item.pendingSync,
          localAvailability: {
            exposure: "held",
            reasons: ["dependency_invalidated"],
            deferred: [],
            cleanupPending: true,
          },
        };
        yield* putItem(blocked, old.heads, watermark);
        yield* emit({
          memorySpaceId: space,
          memoryId: current,
          projectionWatermark: watermark,
          kind: "invalidate",
        });
      }
      const deleted =
        yield* sql`DELETE FROM memory_items_fts WHERE rowid IN (SELECT rowid FROM memory_items WHERE space=${space} AND memory_id=${current})`.pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      const fenced = yield* readItem(space, current);
      if (fenced && !deleted) {
        const projection =
          fenced.item.status === "active"
            ? (({ payload: _payload, ...rest }) => rest)(fenced.item)
            : fenced.item;
        const availability = { ...projection.localAvailability, cleanupPending: true };
        yield* stored(
          "purge-observation",
          sql`UPDATE memory_items SET item_json=${yield* projectionCodec.encode({ ...projection, localAvailability: availability })},availability_json=${yield* availabilityCodec.encode(availability)} WHERE space=${space} AND memory_id=${current}`,
        );
      }
      yield* stored(
        "purge-fence",
        sql`UPDATE memory_items SET indexed_bytes=0,index_state=${deleted ? "pending" : "held"},indexed_revision=NULL,indexed_generation=NULL,cleanup_pending=${deleted ? 0 : 1} WHERE space=${space} AND memory_id=${current}`,
      );
    }
  });
  const applyDecision = Effect.fn("MemoryStore.applyDecision")(function* (
    decision: MemoryDecision,
    expectedGeneration?: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const op = yield* stored("operation-codec", decodeOperation(decision.operation, strict));
        const old = yield* receipt(op.memorySpaceId, op.operationId);
        if (old) {
          if (old.operationDigest !== decision.operationDigest)
            return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
          if (expectedGeneration === undefined) return old;
        } else if (expectedGeneration !== undefined) {
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        }
        const reconnect = expectedGeneration !== undefined;
        if (reconnect) {
          if (
            decision.admission.kind !== "approvedReplica" ||
            op.kind === "forget" ||
            !old ||
            !("hubSequence" in old.receipt) ||
            old.receipt.hubSequence === null ||
            old.receipt.outcome === "rejected"
          )
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          const pending = yield* stored(
            "reconnect-pending",
            sql<{
              operation_digest: string;
              metadata_json: string;
            }>`SELECT operation_digest,metadata_json FROM memory_inbox_pending WHERE space=${op.memorySpaceId} AND operation_id=${op.operationId} AND record_kind='operation'`,
          );
          // Completion and tombstone purge both remove the durable marker. Replay must not resurrect it.
          if (!pending[0]) return old;
          const canonical = yield* operationFromMetadata(
            yield* metadataCodec.decode(pending[0].metadata_json, strict),
          );
          if (
            pending[0].operation_digest !== decision.operationDigest ||
            !canonical ||
            M.encodeMemoryOperation(canonical) !== M.encodeMemoryOperation(op) ||
            (yield* receiptCodec.encode(old.receipt)) !==
              (yield* receiptCodec.encode(decision.receipt))
          )
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          const current = yield* readItem(op.memorySpaceId, op.memoryId);
          if ((current?.generation ?? 0) !== expectedGeneration)
            return yield* new MemoryStoreConflict({ code: "revision_changed" });
          if (!decision.pending) {
            const ancestry = yield* readAncestry(
              op.memorySpaceId,
              op.memoryId,
              op.revision.parents,
            );
            if (ancestry.parents.some((parent) => parent.status === "crossMemory"))
              return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
            if (
              ancestry.parents.some(
                (parent) => parent.status === "missing" || parent.status === "parked",
              )
            )
              return yield* new MemoryStoreConflict({ code: "missing_parent" });
          }
          if (!decision.item) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        }
        const outcome = yield* stored("receipt-codec", decodeReceipt(decision.receipt, strict));
        if (
          outcome.operationId !== op.operationId ||
          outcome.memoryId !== op.memoryId ||
          ("operationDigest" in outcome && outcome.operationDigest !== decision.operationDigest)
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        if (decision.admission.kind === "approvedReplica" && !("hubSequence" in outcome))
          return yield* new MemoryStoreConflict({ code: "unsupported_protocol" });
        const state = yield* readItem(op.memorySpaceId, op.memoryId);
        const tombstones = yield* stored(
          "tombstone-fence",
          sql`SELECT 1 FROM memory_tombstones WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
        );
        const accepted = outcome.outcome !== "rejected";
        if (!reconnect && accepted && !tombstones.length && op.kind !== "forget") {
          const r = op.revision;
          yield* stored(
            "replaced-payload",
            sql`UPDATE memory_payloads SET replaced_at=${Date.parse(r.createdAtUtc)},purge_eligible_after=${Date.parse(r.createdAtUtc) + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS} WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId} AND payload_ref IN (SELECT value FROM json_each(${yield* headsCodec.encode(r.parents)}))`,
          );
          const existing = yield* stored(
            "revision-identity",
            sql<{
              operation_id: string;
            }>`SELECT operation_id FROM memory_revisions WHERE space=${op.memorySpaceId} AND revision_id=${r.revisionId}`,
          );
          if (existing.length && existing[0]?.operation_id !== r.operationId)
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          yield* stored(
            "payload",
            sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${op.memorySpaceId},${r.payloadRef},${op.memoryId},${yield* payloadCodec.encode(op.payload)},${yield* headsCodec.encode(op.payload.derivedFromMemoryRevisions)}) ON CONFLICT(space,payload_ref) DO NOTHING`,
          );
          yield* stored(
            "revision",
            sql`INSERT INTO memory_revisions (space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${op.memorySpaceId},${r.revisionId},${op.memoryId},${r.operationId},${yield* headsCodec.encode(r.parents)},${yield* scopeCodec.encode(r.scope)},${r.assertionKind},${yield* provenanceCodec.encode(r.provenance)},${r.payloadRef},${Date.parse(r.createdAtUtc)}) ON CONFLICT(space,revision_id) DO NOTHING`,
          );
          if (op.kind === "resolve") {
            const resolution = op.resolution;
            const execution =
              decision.execution ??
              (decision.admission.kind === "approvedReplica"
                ? {
                    requestedModelSelection: resolution.requestedModelSelection,
                    effectiveProvider: resolution.effectiveProvider,
                    effectiveModel: resolution.effectiveModel,
                    providerInstanceId: resolution.requestedModelSelection.instanceId,
                    environmentId: resolution.resolvingEnvironmentId,
                  }
                : undefined);
            if (!execution) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
            yield* stored(
              "judgment",
              sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json,resolved_at,revert_deadline) VALUES (${op.memorySpaceId},${resolution.judgmentRef},${op.memoryId},${yield* resolutionPayloadCodec.encode(op.resolutionPayload)},${yield* headsCodec.encode(resolution.inputRevisionIds)},${Date.parse(resolution.appliedAtUtc)},${Date.parse(resolution.revertDeadlineUtc)}) ON CONFLICT(space,payload_ref) DO NOTHING`,
            );
            yield* stored(
              "resolution",
              sql`INSERT INTO memory_resolutions (space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json) VALUES (${op.memorySpaceId},${resolution.resolutionId},${op.memoryId},${yield* headsCodec.encode(resolution.inputRevisionIds)},${yield* headsCodec.encode(resolution.inputPayloadRefs)},${resolution.judgmentRef},${yield* selectionCodec.encode(resolution.requestedModelSelection)},${yield* executionCodec.encode(execution)},${resolution.resolvingEnvironmentId},${resolution.fencingToken},${resolution.resultRevisionId},${Date.parse(resolution.appliedAtUtc)},${Date.parse(resolution.revertDeadlineUtc)},${yield* resolutionCodec.encode(resolution)}) ON CONFLICT(space,resolution_id) DO NOTHING`,
            );
          }
        }
        const eventMetadata = yield* stored("metadata-codec", metadataCodec.encode(metadataOf(op)));
        const eventReceipt = yield* stored("receipt-codec", receiptCodec.encode(outcome));
        if (!reconnect)
          yield* stored(
            "event",
            sql<{
              sequence: number;
            }>`INSERT INTO memory_events (protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,${op.memorySpaceId},${op.memoryId},${op.operationId},${op.kind},${op.originEnvironmentId},${decision.operationDigest},${eventMetadata},${eventReceipt},${op.kind === "forget" ? Date.parse(op.tombstone.deletedAtUtc) : Date.parse(op.revision.createdAtUtc)}) RETURNING sequence`,
          );
        const watermark = yield* nextWatermark(op.memorySpaceId);
        if (!reconnect && decision.identity)
          yield* stored(
            "identity",
            sql`INSERT INTO memory_identity_ledger (space,memory_id,identity_json,fence_json,reserve_bytes) VALUES (${op.memorySpaceId},${op.memoryId},${yield* identityCodec.encode(decision.identity)},${yield* fenceCodec.encode(decision.fence ?? { memorySpaceId: op.memorySpaceId, memoryId: op.memoryId, highestFencingToken: 0, activeLease: null })},${M.MEMORY_IDENTITY_CORE_MAX_BYTES + M.MEMORY_PAYLOAD_MAX_UTF8_BYTES}) ON CONFLICT(space,memory_id) DO NOTHING`,
          );
        if (accepted && op.kind === "forget") {
          const t = op.tombstone;
          yield* stored(
            "tombstone",
            sql`INSERT INTO memory_tombstones (space,memory_id,delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json) VALUES (${op.memorySpaceId},${op.memoryId},${t.deleteOperationId},${t.deletingEnvironmentId},${Date.parse(t.deletedAtUtc)},${yield* sourceKeysCodec.encode(t.suppressedSourceKeys)},${yield* contentCodec.encode(t.suppressedContent)},${yield* exclusionsCodec.encode(t.sourceExclusions)}) ON CONFLICT(space,memory_id) DO NOTHING`,
          );
          const records: M.MemorySuppressionRecord[] = [
            ...t.suppressedSourceKeys.map((sourceKey) => ({
              memorySpaceId: t.memorySpaceId,
              memoryId: t.memoryId,
              deleteOperationId: t.deleteOperationId,
              kind: "sourceKey" as const,
              sourceKey,
            })),
            ...t.suppressedContent.map((content) => ({
              memorySpaceId: t.memorySpaceId,
              memoryId: t.memoryId,
              deleteOperationId: t.deleteOperationId,
              kind: "content" as const,
              content,
            })),
            ...t.sourceExclusions.flatMap((exclusion) =>
              exclusion.messageIds.map((messageId) => ({
                memorySpaceId: t.memorySpaceId,
                memoryId: t.memoryId,
                deleteOperationId: t.deleteOperationId,
                kind: "sourceExclusion" as const,
                exclusion: { ...exclusion, messageIds: [messageId] },
              })),
            ),
          ];
          for (const record of records) {
            const json = yield* stored("suppression-codec", suppressionCodec.encode(record));
            // Unique canonical encoded keys keep the permanent union outside bounded wire fragments.
            yield* stored(
              "suppression",
              sql`INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) VALUES (${op.memorySpaceId},${record.kind},${hashText(yield* suppressionKeyCodec.encode(record.kind === "sourceKey" ? { kind: record.kind, value: record.sourceKey } : record.kind === "content" ? { kind: record.kind, value: record.content } : { kind: record.kind, value: record.exclusion }))},${op.memoryId},${json}) ON CONFLICT(space,key_kind,key) DO NOTHING`,
            );
          }
          const item: M.MemoryItem = {
            memorySpaceId: op.memorySpaceId,
            memoryId: op.memoryId,
            status: "forgotten",
            tombstone: t,
            pendingSync: decision.admission.kind === "localIntent",
            localAvailability: {
              exposure: "forgotten",
              reasons: [],
              deferred: [],
              cleanupPending: false,
            },
          };
          yield* putItem(item, [], watermark);
          yield* purge(op.memorySpaceId, op.memoryId, watermark);
          yield* stored(
            "forget-reserve-consumed",
            sql`UPDATE memory_identity_ledger SET reserve_bytes=${M.MEMORY_IDENTITY_CORE_MAX_BYTES} WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
          );
          yield* stored(
            "settle-forget",
            sql`DELETE FROM memory_pending_forget_intents WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
          );
        } else if (accepted && !tombstones.length && decision.item) {
          const projected =
            decision.admission.kind === "approvedReplica" && decision.item.status !== "forgotten"
              ? {
                  ...decision.item,
                  localAvailability: {
                    ...decision.item.localAvailability,
                    exposure: "held" as const,
                    reasons: [
                      ...new Set([
                        ...decision.item.localAvailability.reasons,
                        "scanner_pending" as const,
                      ]),
                    ],
                    deferred: [
                      ...decision.item.localAvailability.deferred.filter(
                        (d) => d.kind !== "scanner",
                      ),
                      {
                        kind: "scanner" as const,
                        state: "pending" as const,
                        reason: "scanner_pending" as const,
                        revisionId: op.kind !== "forget" ? op.revision.revisionId : null,
                        generation: 0,
                        sinceAtUtc:
                          op.kind !== "forget"
                            ? op.revision.createdAtUtc
                            : op.tombstone.deletedAtUtc,
                      },
                    ],
                  },
                }
              : decision.item;
          const held: M.MemoryItem =
            projected.status === "active" && projected.localAvailability.exposure === "held"
              ? {
                  memorySpaceId: op.memorySpaceId,
                  memoryId: op.memoryId,
                  status: "blocked",
                  scope: projected.scope,
                  pendingSync: projected.pendingSync,
                  failureCode: "scanner_pending",
                  localAvailability: projected.localAvailability,
                }
              : projected;
          yield* putItem(
            held,
            decision.heads ??
              (op.kind !== "forget" ? [op.revision.revisionId] : (state?.heads ?? [])),
            watermark,
          );
        }
        if (accepted && decision.conflict && !tombstones.length) {
          const c = decision.conflict;
          yield* stored(
            "conflict",
            sql`INSERT INTO memory_conflicts (space,conflict_id,memory_id,heads_json,status,failure_code) VALUES (${op.memorySpaceId},${c.conflictId},${op.memoryId},${yield* headsCodec.encode(c.heads)},${c.status},${c.failureCode ?? null}) ON CONFLICT(space,conflict_id) DO UPDATE SET heads_json=excluded.heads_json,status=excluded.status,failure_code=excluded.failure_code`,
          );
        }
        if (accepted && decision.admission.kind === "localIntent")
          yield* enqueueWork({
            id: `sync:${op.memorySpaceId}:${op.operationId}`,
            space: op.memorySpaceId,
            memoryId: op.memoryId,
            kind: "sync",
            status: "pending",
            metadata: metadataOf(op),
            payloadRef: op.kind === "forget" ? null : op.revision.payloadRef,
            attempt: 0,
            nextAttemptAt: 0,
            claimedBy: null,
            claimedUntil: null,
          });
        if (!reconnect && accepted && (op.kind === "resolve" || op.kind === "revert")) {
          const resolutionId =
            op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId;
          const reportId = hashText(`${op.memorySpaceId}:${op.operationId}:${resolutionId}`);
          yield* stored(
            "report-intent",
            sql`INSERT INTO memory_report_outbox (report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,created_at) VALUES (${reportId},${op.memorySpaceId},${op.memoryId},${op.operationId},${resolutionId},${op.kind === "resolve" ? op.operationId : null},${op.originEnvironmentId},${op.kind === "resolve" ? "resolved" : "reverted"},'pending',${Date.parse(op.revision.createdAtUtc)}) ON CONFLICT(report_id) DO NOTHING`,
          );
        }
        if (decision.pending && accepted && op.kind !== "forget" && !tombstones.length)
          yield* stored(
            "park-approved",
            sql`INSERT INTO memory_inbox_pending (space,pending_key,record_kind,operation_id,memory_id,operation_digest,missing_parents_json,reason,hub_sequence,metadata_json,payload_ref) VALUES (${op.memorySpaceId},${`operation:${op.operationId}`},'operation',${op.operationId},${op.memoryId},${decision.operationDigest},${yield* headsCodec.encode(decision.pending.missingParents)},${decision.pending.reason},${"hubSequence" in outcome ? outcome.hubSequence : null},${eventMetadata},${op.revision.payloadRef}) ON CONFLICT(space,pending_key) DO UPDATE SET missing_parents_json=excluded.missing_parents_json,reason=excluded.reason`,
          );
        if (accepted && op.kind === "revert")
          yield* stored(
            "accepted-revert-intent",
            sql`DELETE FROM memory_revert_intents WHERE space=${op.memorySpaceId} AND operation_id=${op.operationId}`,
          );
        if (reconnect && !decision.pending)
          yield* stored(
            "reconnect-complete",
            sql`DELETE FROM memory_inbox_pending WHERE space=${op.memorySpaceId} AND operation_id=${op.operationId} AND record_kind='operation'`,
          );
        for (const work of decision.work ?? []) yield* enqueueWork(work);
        if (accepted && (!tombstones.length || op.kind === "forget"))
          yield* emit({
            memorySpaceId: op.memorySpaceId,
            memoryId: op.memoryId,
            projectionWatermark: watermark,
            kind: op.kind === "forget" ? "forget" : "upsert",
          });
        for (const signal of decision.signals ?? [])
          yield* emit({ ...signal, projectionWatermark: watermark });
        return old ?? { operationDigest: decision.operationDigest, receipt: outcome };
      }),
    );
  });
  const readCursor = Effect.fnUntraced(function* (space: M.MemorySpaceId, hub: M.EnvironmentId) {
    const rows = yield* stored(
      "cursor",
      sql<{
        after_sequence: number;
      }>`SELECT after_sequence FROM memory_sync_cursors WHERE space=${space} AND hub_environment_id=${hub}`,
    );
    return rows[0]?.after_sequence ?? 0;
  });
  const withReceivedCursor: MemoryStore["Service"]["withReceivedCursor"] = (input, effect) =>
    transact(
      Effect.gen(function* () {
        const current = yield* readCursor(input.memorySpaceId, input.hubEnvironmentId);
        if (current !== input.expectedSequence || input.afterSequence < current)
          return yield* new MemoryStoreConflict({ code: "invalid_cursor" });
        const result = yield* effect;
        yield* stored(
          "cursor-write",
          sql`INSERT INTO memory_sync_cursors (space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${input.memorySpaceId},${input.hubEnvironmentId},${input.afterSequence},'ready') ON CONFLICT(space,hub_environment_id) DO UPDATE SET after_sequence=excluded.after_sequence`,
        );
        return result;
      }),
    );
  const list = Effect.fn("MemoryStore.list")(function* (filter: MemoryReadFilter) {
    if (
      !Number.isInteger(filter.limit) ||
      filter.limit < 1 ||
      filter.limit > M.MEMORY_PAGE_MAX_ITEMS
    )
      return yield* new MemoryStoreConflict({ code: "payload_too_large" });
    const scope = yield* stored("scope-codec", decodeScope(filter.scope, strict));
    const rows = yield* stored(
      "list",
      sql<{
        memory_id: string;
      }>`SELECT memory_id FROM memory_items WHERE space=${filter.memorySpaceId} AND scope_key=${scopeKey(scope)} AND memory_id>${filter.afterMemoryId ?? ""} ORDER BY memory_id LIMIT ${filter.limit}`,
    );
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const id = yield* stored("item-id", decodeMemoryId(row.memory_id));
        return (yield* readItem(filter.memorySpaceId, id))!.item;
      }),
    );
  });
  const search = Effect.fn("MemoryStore.search")(function* (
    filter: MemoryReadFilter,
    text: string,
    mode: "fts" | "substring",
  ) {
    if (
      !Number.isInteger(filter.limit) ||
      filter.limit < 1 ||
      filter.limit > M.MEMORY_PAGE_MAX_ITEMS
    )
      return yield* new MemoryStoreConflict({ code: "payload_too_large" });
    const key = scopeKey(yield* stored("scope-codec", decodeScope(filter.scope, strict)));
    if (mode === "substring") {
      const counts = yield* stored(
        "substring-count",
        sql<{
          items: number;
          bytes: number;
        }>`SELECT count(*) AS items,coalesce(sum(length(CAST(json_extract(p.body_json,'$.text') AS BLOB))),0) AS bytes FROM memory_items i JOIN memory_payloads p ON p.space=i.space AND p.payload_ref=i.payload_ref WHERE i.space=${filter.memorySpaceId} AND i.scope_key=${key} AND i.status='active'`,
      );
      if (
        (counts[0]?.items ?? 0) > M.MEMORY_SUBSTRING_MAX_ITEMS ||
        (counts[0]?.bytes ?? 0) > M.MEMORY_SUBSTRING_MAX_UTF8_BYTES
      )
        return yield* new MemoryCapacityError({
          dimension: "substring",
          limit: M.MEMORY_SUBSTRING_MAX_ITEMS,
        });
    }
    const rows =
      mode === "fts"
        ? yield* stored(
            "fts-search",
            sql<{
              memory_id: string;
            }>`SELECT i.memory_id FROM memory_items i JOIN memory_items_fts f ON f.rowid=i.rowid WHERE memory_items_fts MATCH ${'"' + text.replaceAll('"', '""') + '"'} AND i.space=${filter.memorySpaceId} AND i.scope_key=${key} AND i.status='active' AND i.index_state='ready' AND i.indexed_generation=i.generation AND i.memory_id>${filter.afterMemoryId ?? ""} ORDER BY i.memory_id LIMIT ${filter.limit}`,
          )
        : yield* stored(
            "substring-search",
            sql<{
              memory_id: string;
            }>`SELECT i.memory_id FROM memory_items i JOIN memory_payloads p ON p.space=i.space AND p.payload_ref=i.payload_ref WHERE i.space=${filter.memorySpaceId} AND i.scope_key=${key} AND i.status='active' AND instr(json_extract(p.body_json,'$.text'),${text})>0 AND i.memory_id>${filter.afterMemoryId ?? ""} ORDER BY i.memory_id LIMIT ${filter.limit}`,
          );
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const id = yield* stored("item-id", decodeMemoryId(row.memory_id));
        return (yield* readItem(filter.memorySpaceId, id))!.item;
      }),
    );
  });
  const workRows = Effect.fnUntraced(function* (
    rows: ReadonlyArray<{
      id: string;
      space: string;
      memory_id: string | null;
      kind: string;
      status: string;
      metadata_json: string;
      payload_ref: string | null;
      attempt: number;
      next_attempt_at: number;
      claimed_by: string | null;
      claimed_until: number | null;
    }>,
  ) {
    return yield* stored(
      "work-codec",
      Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          return yield* decodeWork(
            {
              id: row.id,
              space: row.space,
              memoryId: row.memory_id,
              kind: row.kind,
              status: row.status,
              metadata: yield* workMetadataCodec.decode(row.metadata_json, strict),
              payloadRef: row.payload_ref,
              attempt: row.attempt,
              nextAttemptAt: row.next_attempt_at,
              claimedBy: row.claimed_by,
              claimedUntil: row.claimed_until,
            },
            strict,
          );
        }),
      ),
    );
  });
  type WorkRow = Parameters<typeof workRows>[0][number];
  const dueWork = Effect.fn("MemoryStore.dueWork")(function* (now: number, limit: number) {
    const rows = yield* stored(
      "due-work",
      sql<WorkRow>`SELECT * FROM memory_outbox WHERE kind NOT IN ('sync','claim','resolve','revert_intent') AND (status IN ('pending','retry') OR (status='running' AND claimed_until<=${now})) AND next_attempt_at<=${now} ORDER BY next_attempt_at,attempt,id LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
    );
    return yield* workRows(rows);
  });
  const claimWork = Effect.fn("MemoryStore.claimWork")(function* (
    id: string,
    owner: string,
    now: number,
    until: number,
  ) {
    const rows = yield* stored(
      "claim-work",
      sql`UPDATE memory_outbox SET status='running',claimed_by=${owner},claimed_until=${until},attempt=min(attempt+1,2147483647) WHERE id=${id} AND kind NOT IN ('claim','resolve','revert_intent') AND next_attempt_at<=${now} AND (status IN ('pending','retry') OR (status='running' AND claimed_until<=${now})) RETURNING id`,
    );
    return rows.length === 1;
  });
  const finishWork = Effect.fn("MemoryStore.finishWork")(function* (
    id: string,
    status: "completed" | "cancelled" | "failed",
    result?: M.MemoryHubReceipt,
  ) {
    yield* stored(
      "finish-work",
      sql`UPDATE memory_outbox SET status=${status},claimed_by=NULL,claimed_until=NULL,completed_receipt_json=${result ? yield* receiptCodec.encode(result) : null},payload_ref=NULL WHERE id=${id}`,
    );
  });
  const readEligibleOutbox = Effect.fn("MemoryStore.readEligibleOutbox")(function* (
    space: M.MemorySpaceId,
    now: number,
    limit: number,
  ) {
    return yield* workRows(
      yield* stored(
        "sync-outbox",
        sql<WorkRow>`SELECT * FROM memory_outbox WHERE space=${space} AND kind IN ('sync','revert_intent') AND status IN ('pending','retry') AND next_attempt_at<=${now} ORDER BY next_attempt_at,id LIMIT ${Math.min(limit, M.MEMORY_PAGE_MAX_ITEMS)}`,
      ),
    );
  });
  const acknowledgeOutbox = Effect.fn("MemoryStore.acknowledgeOutbox")(function* (
    id: string,
    result: M.MemoryHubReceipt,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "ack-work",
          sql<WorkRow>`SELECT * FROM memory_outbox WHERE id=${id}`,
        );
        const work = (yield* workRows(rows))[0];
        if (
          !work ||
          !("operationId" in work.metadata) ||
          !("memoryId" in work.metadata) ||
          work.metadata.operationId !== result.operationId ||
          work.metadata.memoryId !== result.memoryId
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const original = yield* stored(
          "ack-original",
          sql<{
            operation_digest: string;
            receipt_json: string;
          }>`SELECT operation_digest,receipt_json FROM memory_events WHERE memory_space_id=${work.space} AND operation_id=${result.operationId}`,
        );
        if (original[0] && original[0].operation_digest !== result.operationDigest)
          return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
        const previous = original[0]
          ? yield* receiptCodec.decode(original[0].receipt_json, strict)
          : undefined;
        if (
          previous &&
          "hubSequence" in previous &&
          previous.hubSequence !== null &&
          (yield* receiptCodec.encode(previous)) !== (yield* receiptCodec.encode(result))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        if (previous && !("hubSequence" in previous))
          yield* stored(
            "ack-settle",
            sql`UPDATE memory_events SET receipt_json=${yield* receiptCodec.encode(result)} WHERE memory_space_id=${work.space} AND operation_id=${result.operationId}`,
          );
        yield* finishWork(id, result.outcome === "rejected" ? "failed" : "completed", result);
        if (result.outcome === "rejected")
          yield* stored(
            "forget-rejected",
            sql`UPDATE memory_pending_forget_intents SET submission_state='rejected',last_failure_code=${result.failureCode ?? null} WHERE space=${work.space} AND operation_id=${result.operationId}`,
          );
      }),
    );
  });
  const preserveForgetIntent = Effect.fn("MemoryStore.preserveForgetIntent")(function* (
    input: PendingForgetIntent,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const intent = yield* stored("pending-forget-codec", decodePendingForget(input, strict));
        const existing = yield* readPending(intent.memorySpaceId, intent.memoryId);
        if (existing) return;
        const counts = yield* stored(
          "pending-forget-count",
          sql<{ count: number }>`SELECT count(*) AS count FROM memory_pending_forget_intents`,
        );
        if ((counts[0]?.count ?? 0) >= M.MEMORY_PENDING_FORGET_INTENTS_MAX)
          return yield* new MemoryCapacityError({
            dimension: "pendingForgetIntents",
            limit: M.MEMORY_PENDING_FORGET_INTENTS_MAX,
          });
        yield* stored(
          "pending-forget-insert",
          sql`INSERT INTO memory_pending_forget_intents (space,memory_id,operation_id,requested_at_utc,attempts,last_failure_code,operation_digest,submission_state) VALUES (${intent.memorySpaceId},${intent.memoryId},${intent.operationId},${intent.requestedAtUtc},${intent.attempts},${intent.lastFailureCode},${intent.operationDigest},${intent.submissionState})`,
        );
        const old = yield* readItem(intent.memorySpaceId, intent.memoryId);
        if (old && old.item.status !== "forgotten") {
          const watermark = yield* nextWatermark(intent.memorySpaceId);
          yield* putItem(old.item, old.heads, watermark);
          yield* emit({
            memorySpaceId: intent.memorySpaceId,
            memoryId: intent.memoryId,
            projectionWatermark: watermark,
            kind: "invalidate",
          });
        }
      }),
    );
  });
  const enqueuePendingForget = Effect.fn("MemoryStore.enqueuePendingForget")(function* (input: {
    operation: Extract<M.MemoryOperation, { kind: "forget" }>;
    operationDigest: string;
  }) {
    yield* transact(
      Effect.gen(function* () {
        const op = input.operation;
        const intent = yield* readPending(op.memorySpaceId, op.memoryId);
        if (!intent) return yield* new MemoryStoreConflict({ code: "not_found" });
        if (
          intent.submissionState === "uncertain" &&
          (intent.operationId !== op.operationId ||
            intent.operationDigest !== input.operationDigest)
        )
          return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
        if (
          intent.submissionState === "rejected" &&
          intent.operationDigest !== null &&
          intent.operationId === op.operationId
        )
          return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
        yield* enqueueWork({
          id: `sync:${op.memorySpaceId}:${op.operationId}`,
          space: op.memorySpaceId,
          memoryId: op.memoryId,
          kind: "sync",
          status: "pending",
          metadata: metadataOf(op),
          payloadRef: null,
          attempt: 0,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
        });
        yield* stored(
          "pending-forget-map",
          sql`UPDATE memory_pending_forget_intents SET operation_id=${op.operationId},operation_digest=${input.operationDigest},submission_state='uncertain',attempts=min(attempts+1,2147483647) WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
        );
      }),
    );
  });
  const pendingForgetIntents = Effect.fn("MemoryStore.pendingForgetIntents")(function* (
    limit: number,
  ) {
    const rows = yield* stored(
      "pending-forget-list",
      sql`SELECT space AS memorySpaceId,memory_id AS memoryId,operation_id AS operationId,requested_at_utc AS requestedAtUtc,attempts,last_failure_code AS lastFailureCode,operation_digest AS operationDigest,submission_state AS submissionState FROM memory_pending_forget_intents ORDER BY requested_at_utc,space,memory_id LIMIT ${Math.min(limit, M.MEMORY_PENDING_FORGET_INTENTS_MAX)}`,
    );
    return yield* stored(
      "pending-forget-codec",
      Effect.forEach(rows, (row) => decodePendingForget(row, strict)),
    );
  });
  const settleForgetIntent = Effect.fn("MemoryStore.settleForgetIntent")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const tombstones = yield* stored(
          "settle-forget-check",
          sql`SELECT 1 FROM memory_tombstones WHERE space=${space} AND memory_id=${id}`,
        );
        if (!tombstones.length) return yield* new MemoryStoreConflict({ code: "forgotten" });
        yield* stored(
          "settle-forget",
          sql`DELETE FROM memory_pending_forget_intents WHERE space=${space} AND memory_id=${id}`,
        );
      }),
    );
  });
  const readDeferred = Effect.fn("MemoryStore.readDeferred")(function* (
    now: number,
    limit: number,
  ) {
    const rows = yield* stored(
      "deferred",
      sql<{
        space: string;
        memory_id: string;
        deferred_json: string;
        payload_bytes: number;
      }>`SELECT i.space,i.memory_id,i.deferred_json,coalesce((SELECT sum(length(CAST(body_json AS BLOB))) FROM memory_payloads p WHERE p.space=i.space AND p.memory_id=i.memory_id),0) AS payload_bytes FROM memory_items i WHERE i.status!='forgotten' AND EXISTS (SELECT 1 FROM json_each(i.deferred_json) d WHERE json_extract(d.value,'$.state')='pending' AND json_extract(d.value,'$.dueAt')<=${now}) ORDER BY (SELECT min(json_extract(d.value,'$.dueAt')) FROM json_each(i.deferred_json) d),i.memory_id LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
    );
    const all = yield* stored(
      "deferred-codec",
      Effect.flatMap(
        Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const memorySpaceId = yield* decodeMemorySpaceId(row.space);
            const memoryId = yield* decodeMemoryId(row.memory_id);
            return (yield* deferredCodec.decode(row.deferred_json, strict))
              .filter(
                (d) =>
                  d.state === "pending" &&
                  d.dueAt <= now &&
                  (!d.claimedUntil || d.claimedUntil <= now),
              )
              .map((d) => ({ ...d, memorySpaceId, memoryId, payloadBytes: row.payload_bytes }));
          }),
        ),
        (groups) => Effect.succeed(groups.flat()),
      ),
    );
    all.sort(
      (a, b) =>
        a.dueAt - b.dueAt ||
        (a.lastAttemptAt ?? -1) - (b.lastAttemptAt ?? -1) ||
        a.memoryId.localeCompare(b.memoryId) ||
        a.kind.localeCompare(b.kind),
    );
    let bytes = 0;
    return all.filter((d, index) => {
      bytes += d.payloadBytes;
      return (
        index < Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS) &&
        bytes <= M.MEMORY_DEFERRED_SWEEP_MAX_BYTES
      );
    });
  });
  const claimDeferred = Effect.fn("MemoryStore.claimDeferred")(function* (
    target: MemoryDeferredWork,
    owner: string,
    now: number,
    until: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "deferred-claim",
          sql<{
            generation: number;
            deferred_json: string;
            status: string;
          }>`SELECT generation,deferred_json,status FROM memory_items WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId}`,
        );
        const row = rows[0];
        if (!row || row.generation !== target.generation || row.status === "forgotten")
          return false;
        const deferred = yield* stored(
          "deferred-codec",
          deferredCodec.decode(row.deferred_json, strict),
        );
        const current = deferred.find((d) => d.kind === target.kind);
        if (
          !current ||
          current.state !== "pending" ||
          current.dueAt > now ||
          (current.claimedUntil !== null && current.claimedUntil > now)
        )
          return false;
        const updated = deferred.map((d) =>
          d.kind === target.kind
            ? { ...d, claimedBy: owner, claimedUntil: until, lastAttemptAt: now }
            : d,
        );
        yield* stored(
          "deferred-claim-write",
          sql`UPDATE memory_items SET deferred_json=${yield* deferredCodec.encode(updated)} WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
        );
        return true;
      }),
    );
  });
  const finishDeferred = Effect.fn("MemoryStore.finishDeferred")(function* (
    target: MemoryDeferredWork,
    outcome: {
      now: number;
      failure?: M.MemoryDeferredReason;
      scannerPolicyVersion?: number;
      ruleIds?: ReadonlyArray<string>;
    },
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "deferred-finish",
          sql<{
            generation: number;
            deferred_json: string;
            status: string;
          }>`SELECT generation,deferred_json,status FROM memory_items WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId}`,
        );
        const row = rows[0];
        if (!row || row.generation !== target.generation || row.status === "forgotten")
          return false;
        const deferred = yield* stored(
          "deferred-codec",
          deferredCodec.decode(row.deferred_json, strict),
        );
        const updated = deferred.map((d) =>
          d.kind === target.kind
            ? {
                ...d,
                state:
                  outcome.failure === "secret_detected"
                    ? ("held" as const)
                    : outcome.failure
                      ? ("pending" as const)
                      : ("ready" as const),
                reason: outcome.failure ?? null,
                sinceAtUtc: outcome.failure ? d.sinceAtUtc : null,
                attempt: outcome.failure ? Math.min(d.attempt + 1, 2147483647) : d.attempt,
                dueAt: outcome.failure
                  ? outcome.now + Math.min(2 ** Math.min(d.attempt + 1, 10) * 5000, 3600000)
                  : d.dueAt,
                claimedBy: null,
                claimedUntil: null,
              }
            : d,
        );
        yield* stored(
          "deferred-finish-write",
          sql`UPDATE memory_items SET deferred_json=${yield* deferredCodec.encode(updated)},scanner_policy_version=coalesce(${outcome.scannerPolicyVersion ?? null},scanner_policy_version),scanned_at=CASE WHEN ${target.kind}='scanner' THEN ${outcome.now} ELSE scanned_at END WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
        );
        const old = yield* readItem(target.memorySpaceId, target.memoryId);
        if (old && old.item.status !== "forgotten" && target.kind === "scanner") {
          const aggregate = yield* loadAggregate(target.memorySpaceId, target.memoryId);
          const pending = yield* readPending(target.memorySpaceId, target.memoryId);
          const reasons = old.item.localAvailability.reasons.filter(
            (reason) => !["scanner_pending", "secret_detected"].includes(reason),
          );
          if (outcome.failure) reasons.push(outcome.failure);
          if (pending && !reasons.includes("forget_pending")) reasons.push("forget_pending");
          const localAvailability: M.MemoryLocalAvailability = {
            ...old.item.localAvailability,
            reasons,
            deferred: updated.map((d) => ({
              kind: d.kind,
              state: d.state,
              reason: d.reason,
              revisionId: d.revisionId,
              generation: d.generation,
              sinceAtUtc: d.sinceAtUtc,
            })),
            exposure: reasons.some((r) =>
              [
                "scanner_pending",
                "secret_detected",
                "missing_parent",
                "dependency_invalidated",
                "forget_pending",
              ].includes(r),
            )
              ? "held"
              : old.item.status === "quarantined"
                ? "held"
                : "visible",
          };
          const single = aggregate.revisions.find(
            (pair) => pair.revision.revisionId === aggregate.heads[0],
          );
          const projected =
            localAvailability.exposure === "visible" &&
            aggregate.heads.length === 1 &&
            single?.payload
              ? {
                  memorySpaceId: target.memorySpaceId,
                  memoryId: target.memoryId,
                  pendingSync: old.item.pendingSync,
                  status: "active" as const,
                  scope: single.revision.scope,
                  revision: single.revision,
                  localAvailability,
                }
              : { ...old.item, localAvailability };
          yield* stored(
            "scanner-projection",
            sql`UPDATE memory_items SET item_json=${yield* projectionCodec.encode(projected)},availability_json=${yield* availabilityCodec.encode(localAvailability)},status=${projected.status},payload_ref=${projected.status === "active" ? projected.revision.payloadRef : null},scanner_rules_json=${yield* rulesCodec.encode(outcome.ruleIds ?? [])} WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
          );
        }
        if (target.kind === "scanner") {
          const watermark = yield* nextWatermark(target.memorySpaceId);
          yield* stored(
            "scanner-watermark",
            sql`UPDATE memory_items SET projection_watermark=${watermark} WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId}`,
          );
          yield* emit({
            memorySpaceId: target.memorySpaceId,
            memoryId: target.memoryId,
            projectionWatermark: watermark,
            kind: "invalidate",
          });
        }
        return true;
      }),
    );
  });
  const recoverDeferred = Effect.fn("MemoryStore.recoverDeferred")(function* (
    scannerPolicyVersion: number,
    now: number,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "deferred-recovery",
          sql<{
            space: string;
            memory_id: string;
            generation: number;
            scanner_policy_version: number;
            deferred_json: string;
          }>`SELECT space,memory_id,generation,scanner_policy_version,deferred_json FROM memory_items WHERE status!='forgotten'`,
        );
        const brake = yield* stored(
          "deferred-brake",
          sql`SELECT 1 FROM memory_fts_maintenance_state WHERE state='braked'`,
        );
        for (const row of rows) {
          const deferred = yield* deferredCodec.decode(row.deferred_json, strict);
          const updated = deferred.map((d) =>
            d.state === "held" &&
            ((d.kind === "scanner" &&
              d.reason === "secret_detected" &&
              row.scanner_policy_version < scannerPolicyVersion) ||
              (d.kind === "index" && d.reason === "fts_braked" && !brake.length))
              ? { ...d, state: "pending" as const, dueAt: now, claimedBy: null, claimedUntil: null }
              : d,
          );
          yield* stored(
            "deferred-release",
            sql`UPDATE memory_items SET deferred_json=${yield* deferredCodec.encode(updated)} WHERE space=${row.space} AND memory_id=${row.memory_id} AND generation=${row.generation}`,
          );
        }
      }),
    );
  });
  const getProjectBinding = Effect.fn("MemoryStore.getProjectBinding")(function* (
    space: M.MemorySpaceId,
    project: M.ScopedProjectRef,
  ) {
    const rows = yield* stored(
      "binding",
      sql<{
        project_key_json: string | null;
        repository_key_json: string | null;
        version: number;
      }>`SELECT * FROM memory_project_bindings WHERE memory_space_id=${space} AND environment_id=${project.environmentId} AND project_id=${project.projectId}`,
    );
    const row = rows[0];
    return row
      ? yield* stored(
          "binding-codec",
          Effect.gen(function* () {
            return yield* decodeBinding(
              {
                memorySpaceId: space,
                project,
                projectKey: row.project_key_json
                  ? yield* keyCodec.decode(row.project_key_json, strict)
                  : null,
                repositoryKey: row.repository_key_json
                  ? yield* keyCodec.decode(row.repository_key_json, strict)
                  : null,
                version: row.version,
              },
              strict,
            );
          }),
        )
      : undefined;
  });
  const putProjectBinding = Effect.fn("MemoryStore.putProjectBinding")(function* (
    input: M.MemoryProjectBinding,
    expected: number | null,
    now: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const binding = yield* stored("binding-codec", decodeBinding(input, strict));
        const old = yield* getProjectBinding(binding.memorySpaceId, binding.project);
        if ((old?.version ?? null) !== expected)
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        yield* stored(
          "binding-write",
          sql`INSERT INTO memory_project_bindings (memory_space_id,environment_id,project_id,project_key_json,repository_key_json,version,updated_at) VALUES (${binding.memorySpaceId},${binding.project.environmentId},${binding.project.projectId},${binding.projectKey ? yield* keyCodec.encode(binding.projectKey) : null},${binding.repositoryKey ? yield* keyCodec.encode(binding.repositoryKey) : null},${binding.version},${now}) ON CONFLICT(memory_space_id,environment_id,project_id) DO UPDATE SET project_key_json=excluded.project_key_json,repository_key_json=coalesce(memory_project_bindings.repository_key_json,excluded.repository_key_json),version=excluded.version,updated_at=excluded.updated_at`,
        );

        yield* emit({
          memorySpaceId: binding.memorySpaceId,
          projectionWatermark: yield* nextWatermark(binding.memorySpaceId),
          kind: "reset",
        });
      }),
    );
  });
  const changes = Effect.fn("MemoryStore.changes")(function* (space: M.MemorySpaceId) {
    const subscription = yield* PubSub.subscribe(signals);
    const rows = yield* stored(
      "watermark",
      sql<{
        watermark: number;
      }>`SELECT coalesce(max(projection_watermark),0) AS watermark FROM memory_compaction_state WHERE space=${space}`,
    );
    const watermark = rows[0]!.watermark;
    return Stream.concat(
      Stream.succeed<M.MemoryChangeSignal>({
        memorySpaceId: space,
        projectionWatermark: watermark,
        kind: "reset",
      }),
      Stream.fromSubscription(subscription).pipe(
        Stream.filter(
          (signal) =>
            signal.memorySpaceId === space &&
            (signal.kind === "reset" || signal.projectionWatermark > watermark),
        ),
      ),
    );
  });
  const reserve = Effect.fn("MemoryStore.reserve")(function* (
    context: MemoryAdmissionContext,
    charges: ReadonlyArray<MemoryQuotaCharge>,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        for (const charge of charges) {
          const rows = yield* stored(
            "quota",
            sql<{
              value: number;
            }>`SELECT value FROM memory_quota_counters WHERE space=${charge.space} AND dimension=${charge.dimension} AND scope_key=${charge.scopeKey}`,
          );
          const value = (charge.current ?? rows[0]?.value ?? 0) + charge.delta;
          if (
            value < 0 ||
            (context.kind !== "approvedReplica" && charge.delta > 0 && value > charge.limit)
          )
            return yield* new MemoryCapacityError({
              dimension: charge.dimension,
              limit: charge.limit,
            });
          yield* stored(
            "quota-write",
            sql`INSERT INTO memory_quota_counters (space,dimension,scope_key,value) VALUES (${charge.space},${charge.dimension},${charge.scopeKey},${value}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`,
          );
        }
      }),
    );
  });
  const counters = Effect.fn("MemoryStore.counters")(function* (space: string) {
    return yield* stored(
      "counters",
      sql<{
        dimension: string;
        scope_key: string;
        value: number;
      }>`SELECT dimension,scope_key,value FROM memory_quota_counters WHERE space=${space}`,
    );
  });
  const ftsState = Effect.fn("MemoryStore.ftsState")(function* (environment: M.EnvironmentId) {
    const rows = yield* stored(
      "fts-state",
      sql<{
        state: "open" | "braked";
        changed_at: number | null;
        allocated_bytes: number | null;
        measured_at: number | null;
        measurement_status: "available" | "unavailable";
        merge_pending: number;
        changed_rows: number;
        last_merge_at: number | null;
      }>`SELECT * FROM memory_fts_maintenance_state WHERE environment=${environment}`,
    );
    const row = rows[0];
    return row
      ? {
          environment,
          state: row.state,
          changedAt: row.changed_at,
          allocatedBytes: row.allocated_bytes,
          measuredAt: row.measured_at,
          measurementStatus: row.measurement_status,
          mergePending: row.merge_pending === 1,
          changedRows: row.changed_rows,
          lastMergeAt: row.last_merge_at,
        }
      : {
          environment,
          state: "open" as const,
          changedAt: null,
          allocatedBytes: null,
          measuredAt: null,
          measurementStatus: "unavailable" as const,
          mergePending: false,
          changedRows: 0,
          lastMergeAt: null,
        };
  });
  const putFtsState = Effect.fn("MemoryStore.putFtsState")(function* (input: MemoryFtsState) {
    const state = yield* stored("fts-state-codec", decodeFtsState(input, strict));
    yield* stored(
      "fts-state-write",
      sql`INSERT INTO memory_fts_maintenance_state (environment,state,changed_at,allocated_bytes,measured_at,measurement_status,merge_pending,changed_rows,last_merge_at) VALUES (${state.environment},${state.state},${state.changedAt},${state.allocatedBytes},${state.measuredAt},${state.measurementStatus},${state.mergePending ? 1 : 0},${state.changedRows},${state.lastMergeAt}) ON CONFLICT(environment) DO UPDATE SET state=excluded.state,changed_at=excluded.changed_at,allocated_bytes=excluded.allocated_bytes,measured_at=excluded.measured_at,measurement_status=excluded.measurement_status,merge_pending=excluded.merge_pending,changed_rows=excluded.changed_rows,last_merge_at=excluded.last_merge_at`,
    );
  });
  const index = Effect.fn("MemoryStore.index")(function* (target: MemoryIndexTarget) {
    return yield* transact(
      Effect.gen(function* () {
        const row = yield* readItem(target.memorySpaceId, target.memoryId);
        if (
          !row ||
          row.generation !== target.generation ||
          row.item.status !== "active" ||
          row.item.revision.revisionId !== target.revisionId ||
          row.heads.length !== 1 ||
          (yield* readPending(target.memorySpaceId, target.memoryId))
        )
          return false;
        const brake = yield* stored(
          "fts-brake",
          sql`SELECT 1 FROM memory_fts_maintenance_state WHERE state='braked' LIMIT 1`,
        );
        if (brake.length) return false;
        const bytes = new TextEncoder().encode(row.item.payload.text).length;
        const totals = yield* stored(
          "index-budget",
          sql<{
            bytes: number;
          }>`SELECT coalesce(sum(indexed_bytes),0) AS bytes FROM memory_items WHERE NOT(space=${target.memorySpaceId} AND memory_id=${target.memoryId})`,
        );
        if ((totals[0]?.bytes ?? 0) + bytes > M.MEMORY_FTS_INDEXED_TEXT_MAX_BYTES)
          return yield* new MemoryCapacityError({
            dimension: "ftsIndexedTextBytes",
            limit: M.MEMORY_FTS_INDEXED_TEXT_MAX_BYTES,
          });
        yield* stored(
          "fts-delete",
          sql`DELETE FROM memory_items_fts WHERE rowid IN (SELECT rowid FROM memory_items WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId})`,
        );
        yield* stored(
          "fts-insert",
          sql`INSERT INTO memory_items_fts (rowid,body) SELECT rowid,${row.item.payload.text} FROM memory_items WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
        );
        yield* stored(
          "fts-fence",
          sql`UPDATE memory_items SET index_state='ready',indexed_revision=${target.revisionId},indexed_generation=${target.generation},indexed_bytes=${bytes} WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
        );
        yield* stored(
          "fts-count",
          sql`UPDATE memory_fts_maintenance_state SET changed_rows=changed_rows+1`,
        );
        return true;
      }),
    );
  });
  const measureAllocation = Effect.fn("MemoryStore.measureAllocation")(function* () {
    const pages = yield* stored("page-count", sql<{ page_count: number }>`PRAGMA page_count`);
    const size = yield* stored("page-size", sql<{ page_size: number }>`PRAGMA page_size`);
    const free = yield* stored("freelist", sql<{ freelist_count: number }>`PRAGMA freelist_count`);
    const allocation = yield* sql<{
      memory_bytes: number;
      fts_bytes: number;
    }>`SELECT coalesce(sum(pgsize),0) AS memory_bytes,coalesce(sum(CASE WHEN name LIKE 'memory_items_fts%' THEN pgsize ELSE 0 END),0) AS fts_bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE (type='table' AND name LIKE 'memory_%') OR (type='index' AND tbl_name LIKE 'memory_%'))`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const tableAllocations = yield* sql<{
      name: string;
      bytes: number;
    }>`SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name`.pipe(Effect.option);
    const tables: M.MemoryStorageTableUsage[] = [];
    for (const table of M.MemoryStorageTable.literals) {
      const exists = yield* stored(
        "table-inventory",
        sql`SELECT 1 FROM sqlite_master WHERE name=${table} AND type='table'`,
      );
      if (!exists.length) continue;
      const rows = yield* stored(
        "table-count",
        sql.unsafe<{ count: number }>(`SELECT count(*) AS count FROM ${table}`),
      );
      const indexedNames = yield* stored(
        "table-indexes",
        sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE tbl_name=${table} AND type='index'`,
      );
      const names = new Set([
        table,
        ...indexedNames.map((row) => row.name),
        ...(table === "memory_items_fts"
          ? [
              "memory_items_fts_data",
              "memory_items_fts_idx",
              "memory_items_fts_content",
              "memory_items_fts_docsize",
              "memory_items_fts_config",
            ]
          : []),
      ]);
      const allocated = Option.isSome(tableAllocations)
        ? tableAllocations.value
            .filter((row) => names.has(row.name))
            .reduce((sum, row) => sum + row.bytes, 0)
        : null;
      const columns = yield* stored(
        "table-columns",
        sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`),
      );
      const charged = columns.filter(
        (column) =>
          column.name.endsWith("_json") ||
          column.name === "reserve_bytes" ||
          (table === "memory_items_fts" && column.name === "body"),
      );
      const expression =
        charged
          .map((column) =>
            column.name === "reserve_bytes"
              ? "coalesce(reserve_bytes,0)"
              : `coalesce(length(CAST("${column.name.replaceAll('"', '""')}" AS BLOB)),0)`,
          )
          .join("+") || "0";
      const logical = yield* stored(
        "table-logical",
        sql.unsafe<{ bytes: number }>(
          `SELECT coalesce(sum(${expression}),0) AS bytes FROM ${table}`,
        ),
      );
      tables.push({
        table,
        rowCount: rows[0]!.count,
        logicalBytes: logical[0]!.bytes,
        allocatedBytes: allocated,
        allocationStatus: allocated === null ? "unavailable" : "available",
      });
    }
    return {
      tables,
      memoryBytes: allocation?.memory_bytes ?? null,
      ftsBytes: allocation?.fts_bytes ?? null,
      dbFileBytes: (pages[0]?.page_count ?? 0) * (size[0]?.page_size ?? 0),
      freelistBytes: (free[0]?.freelist_count ?? 0) * (size[0]?.page_size ?? 0),
    };
  });
  const mergeFts = Effect.fn("MemoryStore.mergeFts")(function* () {
    return yield* sql`INSERT INTO memory_items_fts(memory_items_fts,rank) VALUES ('merge',${M.MEMORY_FTS_MERGE_MAX_PAGES})`.pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  });
  const recordSample = Effect.fn("MemoryStore.recordSample")(function* (
    environment: M.EnvironmentId,
    input: M.MemoryStorageSample,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const json = yield* sampleCodec.encode(input);
        const systemSpace = `_environment:${environment}`;
        const rows = yield* stored(
          "sample-current",
          sql<{
            current_sample_json: string | null;
          }>`SELECT current_sample_json FROM memory_compaction_state WHERE space=${systemSpace}`,
        );
        const previous = rows[0]?.current_sample_json
          ? yield* sampleCodec.decode(rows[0].current_sample_json, strict)
          : undefined;
        if (previous && Date.parse(previous.measuredAtUtc) >= Date.parse(input.measuredAtUtc))
          return false;
        if (previous && previous.utcDay !== input.utcDay)
          yield* stored(
            "sample-archive",
            sql`INSERT INTO memory_storage_samples (environment,utc_day,measured_at,sample_json,is_current) VALUES (${environment},${previous.utcDay},${Date.parse(previous.measuredAtUtc)},${yield* sampleCodec.encode(previous)},0) ON CONFLICT(environment,utc_day) DO UPDATE SET measured_at=excluded.measured_at,sample_json=excluded.sample_json`,
          );
        yield* stored(
          "sample-current-write",
          sql`INSERT INTO memory_compaction_state (space,current_sample_json) VALUES (${systemSpace},${json}) ON CONFLICT(space) DO UPDATE SET current_sample_json=excluded.current_sample_json`,
        );
        yield* stored(
          "sample-evict",
          sql`DELETE FROM memory_storage_samples WHERE environment=${environment} AND utc_day NOT IN (SELECT utc_day FROM memory_storage_samples WHERE environment=${environment} ORDER BY utc_day DESC LIMIT ${M.MEMORY_STORAGE_SAMPLE_MAX_DAYS})`,
        );
        return true;
      }),
    );
  });
  const samples = Effect.fn("MemoryStore.samples")(function* (environment: M.EnvironmentId) {
    const rows = yield* stored(
      "samples",
      sql<{
        sample_json: string;
      }>`SELECT sample_json FROM memory_storage_samples WHERE environment=${environment} UNION ALL SELECT current_sample_json AS sample_json FROM memory_compaction_state WHERE space=${`_environment:${environment}`} AND current_sample_json IS NOT NULL`,
    );
    const result = yield* Effect.forEach(rows, (row) =>
      sampleCodec.decode(row.sample_json, strict),
    );
    return result.toSorted((a, b) => a.utcDay.localeCompare(b.utcDay));
  });
  const readDueClaimCandidates = Effect.fn("MemoryStore.readDueClaimCandidates")(function* (
    limit: number,
    now: number,
  ) {
    return yield* workRows(
      yield* stored(
        "claim-candidates",
        sql<WorkRow>`SELECT o.* FROM memory_outbox o JOIN memory_items i ON i.space=o.space AND i.memory_id=o.memory_id WHERE o.kind='claim' AND o.status IN ('pending','retry') AND o.next_attempt_at<=${now} AND i.status='quarantined' AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=i.space AND f.memory_id=i.memory_id) AND NOT EXISTS (SELECT 1 FROM json_each(i.availability_json,'$.reasons') r WHERE r.value IN ('scanner_pending','secret_detected','missing_parent','dependency_invalidated','forget_pending')) ORDER BY o.next_attempt_at,o.id LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
      ),
    );
  });
  const recoverClaimCandidates = Effect.fn("MemoryStore.recoverClaimCandidates")(function* (
    now: number,
  ) {
    yield* transact(
      Effect.gen(function* () {
        yield* stored(
          "claim-recovery",
          sql`UPDATE memory_outbox SET status='retry',claimed_by=NULL,claimed_until=NULL WHERE kind='claim' AND status='running' AND claimed_until<=${now}`,
        );
        const rows = yield* stored(
          "claim-frontiers",
          sql<{
            space: string;
            memory_id: string;
            heads_json: string;
            item_json: string;
          }>`SELECT space,memory_id,heads_json,item_json FROM memory_items WHERE status='quarantined'`,
        );
        for (const row of rows) {
          const item = yield* projectionCodec.decode(row.item_json, strict);
          if (item.status !== "quarantined") continue;
          const unusable = item.localAvailability.reasons.some((r) =>
            [
              "scanner_pending",
              "secret_detected",
              "missing_parent",
              "dependency_invalidated",
              "forget_pending",
            ].includes(r),
          );
          if (unusable || (yield* readPending(item.memorySpaceId, item.memoryId))) {
            yield* stored(
              "claim-cancel",
              sql`UPDATE memory_outbox SET status='cancelled' WHERE kind IN ('claim','resolve') AND space=${row.space} AND memory_id=${row.memory_id} AND status NOT IN ('completed','cancelled')`,
            );
            continue;
          }
          const headSetDigest = hashText(yield* headsCodec.encode(item.conflict.heads));
          const id = `claim:${row.space}:${row.memory_id}:${headSetDigest}`;
          yield* stored(
            "claim-stale",
            sql`UPDATE memory_outbox SET status='cancelled' WHERE kind IN ('claim','resolve') AND space=${row.space} AND memory_id=${row.memory_id} AND id<>${id} AND status NOT IN ('completed','cancelled')`,
          );
          yield* enqueueWork({
            id,
            space: row.space,
            memoryId: item.memoryId,
            kind: "claim",
            status: "pending",
            metadata: {
              kind: "claim",
              conflictId: item.conflict.conflictId,
              sortedHeads: item.conflict.heads,
              headSetDigest,
            },
            payloadRef: null,
            attempt: 0,
            nextAttemptAt: now,
            claimedBy: null,
            claimedUntil: null,
          });
        }
        yield* stored(
          "claim-gone",
          sql`UPDATE memory_outbox SET status='cancelled' WHERE kind IN ('claim','resolve') AND status NOT IN ('completed','cancelled') AND NOT EXISTS (SELECT 1 FROM memory_items i WHERE i.space=memory_outbox.space AND i.memory_id=memory_outbox.memory_id AND i.status='quarantined')`,
        );
      }),
    );
  });
  const claimCandidate = Effect.fn("MemoryStore.claimCandidate")(function* (
    id: string,
    epoch: number,
    now: number,
  ) {
    const rows = yield* stored(
      "claim-cas",
      sql`UPDATE memory_outbox SET status='running',claimed_by=${String(epoch)},claimed_until=${now + M.MEMORY_LEASE_MS},attempt=min(attempt+1,2147483647) WHERE id=${id} AND kind='claim' AND status IN ('pending','retry') AND next_attempt_at<=${now} AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=memory_outbox.space AND f.memory_id=memory_outbox.memory_id) RETURNING id`,
    );
    return rows.length === 1;
  });
  const retryClaimCandidate = Effect.fn("MemoryStore.retryClaimCandidate")(function* (
    id: string,
    nextAttemptAt: number,
    _failure: M.MemoryFailureCode,
    leaseExpiresAt?: number,
  ) {
    yield* stored(
      "claim-retry",
      sql`UPDATE memory_outbox SET status='retry',next_attempt_at=${Math.max(nextAttemptAt, leaseExpiresAt ?? 0)},claimed_by=NULL,claimed_until=NULL WHERE id=${id} AND kind='claim'`,
    );
  });
  const completeClaimCandidate = (id: string) => finishWork(id, "completed");
  const persistResolutionTicket = Effect.fn("MemoryStore.persistResolutionTicket")(function* (
    input: M.MemoryResolutionLease,
  ) {
    const ticket = yield* stored("ticket-codec", decodeTicket(input, strict));
    yield* enqueueWork({
      id: `resolve:${ticket.memorySpaceId}:${ticket.attemptId}`,
      space: ticket.memorySpaceId,
      memoryId: ticket.memoryId,
      kind: "resolve",
      status: "pending",
      metadata: { kind: "resolve", ticket },
      payloadRef: null,
      attempt: 0,
      nextAttemptAt: 0,
      claimedBy: null,
      claimedUntil: null,
    });
  });
  const pendingReports = Effect.fn("MemoryStore.pendingReports")(function* (limit: number) {
    const rows = yield* stored(
      "reports",
      sql<{
        report_id: string;
        operation_id: string;
        outcome: string;
        resolving_environment_id: string;
        resolution_id: string | null;
        state: string;
        failure_code: string | null;
        report_thread_json: string | null;
        delivered_sequence: number | null;
      }>`SELECT * FROM memory_report_outbox WHERE state IN ('pending','failed') ORDER BY created_at,report_id LIMIT ${Math.min(limit, M.MEMORY_REPORT_MAX_PENDING_ITEMS)}`,
    );
    return yield* stored(
      "report-codec",
      Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          return yield* decodeReport(
            {
              reportId: row.report_id,
              operationId: row.operation_id,
              outcome: row.outcome,
              resolvingEnvironmentId: row.resolving_environment_id,
              resolutionId: row.resolution_id,
              state: row.state,
              ...(row.failure_code ? { failureCode: row.failure_code } : {}),
              reportThread: row.report_thread_json
                ? yield* threadCodec.decode(row.report_thread_json, strict)
                : null,
              sequence: row.delivered_sequence,
            },
            strict,
          );
        }),
      ),
    );
  });
  const claimReport = Effect.fn("MemoryStore.claimReport")(function* (
    id: string,
    owner: string,
    now: number,
    until: number,
  ) {
    const rows = yield* stored(
      "report-claim",
      sql`UPDATE memory_report_outbox SET claimed_by=${owner},claimed_until=${until} WHERE report_id=${id} AND state='pending' AND (claimed_until IS NULL OR claimed_until<=${now}) RETURNING report_id`,
    );
    return rows.length === 1;
  });
  const acknowledgeReport = Effect.fn("MemoryStore.acknowledgeReport")(function* (
    input: M.MemoryReportDelivery,
  ) {
    const report = yield* stored("report-codec", decodeReport(input, strict));
    if (report.state !== "delivered" || !report.reportThread || report.sequence === null)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const rows = yield* stored(
      "report-ack",
      sql`UPDATE memory_report_outbox SET state='delivered',report_thread_json=${yield* threadCodec.encode(report.reportThread)},delivered_sequence=${report.sequence},delivered_at=${yield* Clock.currentTimeMillis},claimed_by=NULL,claimed_until=NULL WHERE report_id=${report.reportId} AND operation_id=${report.operationId} AND resolving_environment_id=${report.resolvingEnvironmentId} AND outcome=${report.outcome} RETURNING report_id`,
    );
    if (!rows.length) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
  });
  const failReport = Effect.fn("MemoryStore.failReport")(function* (
    id: string,
    failure: M.MemoryFailureCode,
  ) {
    yield* stored(
      "report-fail",
      sql`UPDATE memory_report_outbox SET state='failed',failure_code=${failure},claimed_by=NULL,claimed_until=NULL WHERE report_id=${id} AND state!='delivered'`,
    );
  });
  const installCheckpointPage = Effect.fn("MemoryStore.installCheckpointPage")(function* (input: {
    checkpointId: string;
    page: M.MemoryHubCheckpointPage;
  }) {
    yield* transact(
      Effect.gen(function* () {
        const page = yield* stored("checkpoint-codec", decodeCheckpoint(input.page, strict));
        const pageDigest = hashText(yield* checkpointCodec.encode(page));
        const existing = yield* stored(
          "checkpoint-page",
          sql<{
            metadata_json: string;
            operation_digest: string;
          }>`SELECT metadata_json,operation_digest FROM memory_inbox_pending WHERE space=${page.memorySpaceId} AND checkpoint_id=${input.checkpointId} AND page_ordinal=${page.pageOrdinal}`,
        );
        const safePage = {
          ...page,
          items: page.items.map((item) =>
            item.status === "active"
              ? {
                  memorySpaceId: item.memorySpaceId,
                  memoryId: item.memoryId,
                  pendingSync: item.pendingSync,
                  status: "blocked" as const,
                  scope: item.scope,
                  failureCode: "scanner_pending" as const,
                  localAvailability: {
                    exposure: "held" as const,
                    reasons: ["scanner_pending" as const],
                    deferred: [],
                    cleanupPending: false,
                  },
                }
              : item,
          ),
          revisions: page.revisions.map((pair) => ({ ...pair, payload: null })),
          resolutions: page.resolutions.map((pair) => ({ ...pair, payload: null })),
        };
        const json = yield* stagedCheckpointCodec.encode({
          page: safePage,
          heads: page.items.map((item) => ({
            memoryId: item.memoryId,
            heads:
              item.status === "active"
                ? [item.revision.revisionId]
                : item.status === "quarantined"
                  ? item.conflict.heads
                  : [],
          })),
        });
        if (existing[0]) {
          if (existing[0].metadata_json !== json || existing[0].operation_digest !== pageDigest)
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          return;
        }
        for (const pair of page.revisions) {
          if (!pair.payload) continue;
          const forgotten = yield* stored(
            "checkpoint-forget",
            sql`SELECT 1 FROM memory_tombstones WHERE space=${page.memorySpaceId} AND memory_id=${pair.revision.memoryId}`,
          );
          if (forgotten.length) continue;
          yield* stored(
            "checkpoint-payload",
            sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${page.memorySpaceId},${pair.revision.payloadRef},${pair.revision.memoryId},${yield* payloadCodec.encode(pair.payload)},${yield* headsCodec.encode(pair.payload.derivedFromMemoryRevisions)}) ON CONFLICT(space,payload_ref) DO NOTHING`,
          );
        }
        for (const pair of page.resolutions)
          if (pair.payload) {
            const forgotten = yield* stored(
              "checkpoint-forget",
              sql`SELECT 1 FROM memory_tombstones WHERE space=${page.memorySpaceId} AND memory_id=${pair.resolution.memoryId}`,
            );
            if (forgotten.length) continue;
            yield* stored(
              "checkpoint-judgment",
              sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${page.memorySpaceId},${pair.resolution.judgmentRef},${pair.resolution.memoryId},${yield* resolutionPayloadCodec.encode(pair.payload)},${yield* headsCodec.encode(pair.resolution.inputRevisionIds)}) ON CONFLICT(space,payload_ref) DO NOTHING`,
            );
          }
        yield* stored(
          "checkpoint-stage",
          sql`INSERT INTO memory_inbox_pending (space,pending_key,record_kind,missing_parents_json,reason,hub_sequence,checkpoint_id,page_ordinal,metadata_json,operation_digest) VALUES (${page.memorySpaceId},${`checkpoint:${input.checkpointId}:${page.pageOrdinal}`},'checkpoint','[]','scanner_pending',${page.checkpointSequence},${input.checkpointId},${page.pageOrdinal},${json},${pageDigest})`,
        );
      }),
    );
  });
  const completeCheckpoint = Effect.fn("MemoryStore.completeCheckpoint")(function* (input: {
    memorySpaceId: M.MemorySpaceId;
    hubEnvironmentId: M.EnvironmentId;
    checkpointId: string;
    pageCount: number;
  }) {
    yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "checkpoint-pages",
          sql<{
            metadata_json: string;
          }>`SELECT metadata_json FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND checkpoint_id=${input.checkpointId} AND record_kind='checkpoint' ORDER BY page_ordinal`,
        );
        const staged = yield* Effect.forEach(rows, (row) =>
          stagedCheckpointCodec.decode(row.metadata_json, strict),
        );
        const pages = staged.map((record) => record.page);
        if (
          pages.length !== input.pageCount ||
          !pages.length ||
          pages.some(
            (p, i) => p.pageOrdinal !== i || p.checkpointSequence !== pages[0]!.checkpointSequence,
          ) ||
          !pages.at(-1)?.bootstrapComplete ||
          !M.validateMemoryCheckpointRecords(pages)
        )
          return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
        const last = pages.at(-1)!;
        const checkpointWatermark = yield* nextWatermark(input.memorySpaceId);
        for (const page of pages) {
          for (const identity of page.identities)
            yield* stored(
              "checkpoint-identity",
              sql`INSERT INTO memory_identity_ledger (space,memory_id,identity_json,fence_json,reserve_bytes) VALUES (${input.memorySpaceId},${identity.memoryId},${yield* identityCodec.encode(identity)},${yield* fenceCodec.encode(page.fences.find((f) => f.memoryId === identity.memoryId) ?? { memorySpaceId: input.memorySpaceId, memoryId: identity.memoryId, highestFencingToken: 0, activeLease: null })},${M.MEMORY_IDENTITY_CORE_MAX_BYTES + M.MEMORY_PAYLOAD_MAX_UTF8_BYTES}) ON CONFLICT(space,memory_id) DO NOTHING`,
            );
          for (const fence of page.fences)
            yield* stored(
              "checkpoint-fence",
              sql`UPDATE memory_identity_ledger SET fence_json=${yield* fenceCodec.encode(fence)} WHERE space=${input.memorySpaceId} AND memory_id=${fence.memoryId}`,
            );
          for (const compact of page.compactReceipts) yield* persistCompactReceipt(compact);
          for (const conflict of page.conflicts)
            yield* stored(
              "checkpoint-conflict",
              sql`INSERT INTO memory_conflicts (space,conflict_id,memory_id,heads_json,status,failure_code) VALUES (${input.memorySpaceId},${conflict.conflictId},${conflict.memoryId},${yield* headsCodec.encode(conflict.heads)},${conflict.status},${conflict.failureCode ?? null}) ON CONFLICT(space,conflict_id) DO UPDATE SET heads_json=excluded.heads_json,status=excluded.status,failure_code=excluded.failure_code`,
            );
          for (const pair of page.resolutions) {
            const r = pair.resolution;
            const execution: M.MemoryGenerationExecution = {
              requestedModelSelection: r.requestedModelSelection,
              effectiveProvider: r.effectiveProvider,
              effectiveModel: r.effectiveModel,
              providerInstanceId: r.requestedModelSelection.instanceId,
              environmentId: r.resolvingEnvironmentId,
            };
            yield* stored(
              "checkpoint-resolution",
              sql`INSERT INTO memory_resolutions (space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json) VALUES (${input.memorySpaceId},${r.resolutionId},${r.memoryId},${yield* headsCodec.encode(r.inputRevisionIds)},${yield* headsCodec.encode(r.inputPayloadRefs)},${r.judgmentRef},${yield* selectionCodec.encode(r.requestedModelSelection)},${yield* executionCodec.encode(execution)},${r.resolvingEnvironmentId},${r.fencingToken},${r.resultRevisionId},${Date.parse(r.appliedAtUtc)},${Date.parse(r.revertDeadlineUtc)},${yield* resolutionCodec.encode(r)}) ON CONFLICT(space,resolution_id) DO NOTHING`,
            );
          }
          for (const pair of page.revisions) {
            const r = pair.revision;
            yield* stored(
              "checkpoint-revision",
              sql`INSERT INTO memory_revisions (space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${input.memorySpaceId},${r.revisionId},${r.memoryId},${r.operationId},${yield* headsCodec.encode(r.parents)},${yield* scopeCodec.encode(r.scope)},${r.assertionKind},${yield* provenanceCodec.encode(r.provenance)},${r.payloadRef},${Date.parse(r.createdAtUtc)}) ON CONFLICT(space,revision_id) DO NOTHING`,
            );
          }
          for (const tombstone of page.tombstones) {
            yield* stored(
              "checkpoint-tombstone",
              sql`INSERT INTO memory_tombstones (space,memory_id,delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json) VALUES (${input.memorySpaceId},${tombstone.memoryId},${tombstone.deleteOperationId},${tombstone.deletingEnvironmentId},${Date.parse(tombstone.deletedAtUtc)},'[]','[]','[]') ON CONFLICT(space,memory_id) DO NOTHING`,
            );
            yield* purge(input.memorySpaceId, tombstone.memoryId, checkpointWatermark);
          }
          for (const record of page.suppressions) {
            const json = yield* suppressionCodec.encode(record);
            const key = hashText(
              yield* suppressionKeyCodec.encode(
                record.kind === "sourceKey"
                  ? { kind: record.kind, value: record.sourceKey }
                  : record.kind === "content"
                    ? { kind: record.kind, value: record.content }
                    : { kind: record.kind, value: record.exclusion },
              ),
            );
            yield* stored(
              "checkpoint-suppression",
              sql`INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) VALUES (${input.memorySpaceId},${record.kind},${key},${record.memoryId},${json}) ON CONFLICT(space,key_kind,key) DO NOTHING`,
            );
          }
          for (const item of page.items) {
            const old = yield* readItem(input.memorySpaceId, item.memoryId);
            if (old?.item.status === "forgotten" || old?.item.pendingSync) continue;
            const forgotten = yield* stored(
              "checkpoint-forgotten",
              sql`SELECT 1 FROM memory_tombstones WHERE space=${input.memorySpaceId} AND memory_id=${item.memoryId}`,
            );
            if (forgotten.length && item.status !== "forgotten") continue;
            const heads =
              staged
                .flatMap((record) => record.heads)
                .find((record) => record.memoryId === item.memoryId)?.heads ?? [];
            yield* putItem(item, heads, checkpointWatermark);
          }
        }
        yield* stored(
          "checkpoint-publish",
          sql`INSERT INTO memory_compaction_state (space,checkpoint_id,boundary_json,retained_revision_boundary,published) VALUES (${input.memorySpaceId},${input.checkpointId},${yield* boundaryCodec.encode(last.causalBoundary)},${last.retentionFloor},1) ON CONFLICT(space) DO UPDATE SET checkpoint_id=excluded.checkpoint_id,boundary_json=excluded.boundary_json,retained_revision_boundary=excluded.retained_revision_boundary,published=1`,
        );
        yield* stored(
          "checkpoint-cursor",
          sql`INSERT INTO memory_sync_cursors (space,hub_environment_id,after_sequence,bootstrap_state,checkpoint_id,checkpoint_sequence) VALUES (${input.memorySpaceId},${input.hubEnvironmentId},${last.checkpointSequence},'ready',${input.checkpointId},${last.checkpointSequence}) ON CONFLICT(space,hub_environment_id) DO UPDATE SET after_sequence=excluded.after_sequence,bootstrap_state='ready',checkpoint_id=excluded.checkpoint_id,checkpoint_sequence=excluded.checkpoint_sequence`,
        );
        yield* stored(
          "checkpoint-finish",
          sql`DELETE FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND checkpoint_id=${input.checkpointId} AND record_kind='checkpoint'`,
        );
        yield* emit({
          memorySpaceId: input.memorySpaceId,
          projectionWatermark: checkpointWatermark,
          kind: "reset",
        });
      }),
    );
  });

  const putLocalIntent = Effect.fn("MemoryStore.putLocalIntent")(function* (
    input: LocalMemoryIntent,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const intent = yield* stored("local-intent-codec", decodeLocalIntent(input, strict));
        const space = `_local:${intent.environmentId}`;
        const old = yield* stored(
          "local-intent",
          sql<{
            metadata_json: string;
          }>`SELECT metadata_json FROM memory_outbox WHERE id=${`local:${intent.environmentId}:${intent.intentId}`}`,
        );
        const json = yield* localMetadataCodec.encode({
          kind: "localIntent",
          intentId: intent.intentId,
          environmentId: intent.environmentId,
          memoryId: intent.memoryId,
          scope: intent.scope,
          provenance: intent.provenance,
          assertionKind: intent.assertionKind,
          createdAtUtc: intent.createdAtUtc,
          mapping: null,
        });
        if (old[0]) {
          if (old[0].metadata_json !== json)
            return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
          return;
        }
        yield* stored(
          "local-intent-payload",
          sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${intent.intentId},${intent.memoryId},${yield* payloadCodec.encode(intent.payload)},${yield* headsCodec.encode(intent.payload.derivedFromMemoryRevisions)})`,
        );
        yield* stored(
          "local-intent-outbox",
          sql`INSERT INTO memory_outbox (id,space,memory_id,kind,status,metadata_json,payload_ref,next_attempt_at) VALUES (${`local:${intent.environmentId}:${intent.intentId}`},${space},${intent.memoryId},'admin','pending',${json},${intent.intentId},0)`,
        );
      }),
    );
  });
  const materializeLocalIntent = Effect.fn("MemoryStore.materializeLocalIntent")(function* (input: {
    environmentId: M.EnvironmentId;
    intentId: string;
    memorySpaceId: M.MemorySpaceId;
    operationId: M.MemoryOperationId;
    revisionId: M.MemoryRevisionId;
  }) {
    return yield* transact(
      Effect.gen(function* () {
        const ready = yield* stored(
          "local-binding-ready",
          sql`SELECT 1 FROM memory_compaction_state WHERE space=${input.memorySpaceId} AND published=1`,
        );
        if (!ready.length) return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
        const id = `local:${input.environmentId}:${input.intentId}`;
        const rows = yield* stored(
          "local-intent",
          sql<{
            metadata_json: string;
            body_json: string;
          }>`SELECT o.metadata_json,p.body_json FROM memory_outbox o JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.id=${id} AND o.status!='cancelled'`,
        );
        const row = rows[0];
        if (!row) return yield* new MemoryStoreConflict({ code: "not_found" });
        const draft = yield* localMetadataCodec.decode(row.metadata_json, strict);
        if (draft.mapping && draft.mapping.memorySpaceId !== input.memorySpaceId)
          return yield* new MemoryStoreConflict({ code: "space_mismatch" });
        const mapping = draft.mapping ?? {
          memorySpaceId: input.memorySpaceId,
          operationId: input.operationId,
          revisionId: input.revisionId,
        };
        const payload = yield* payloadCodec.decode(row.body_json, strict);
        const operation = yield* stored(
          "materialize-codec",
          decodeOperation(
            {
              protocolVersion: 1,
              kind: "upsert",
              memorySpaceId: mapping.memorySpaceId,
              memoryId: draft.memoryId,
              operationId: mapping.operationId,
              originEnvironmentId: draft.environmentId,
              expectedHeads: [],
              revision: {
                memorySpaceId: mapping.memorySpaceId,
                memoryId: draft.memoryId,
                operationId: mapping.operationId,
                revisionId: mapping.revisionId,
                payloadRef: mapping.revisionId,
                parents: [],
                scope: draft.scope,
                assertionKind: draft.assertionKind,
                provenance: draft.provenance,
                createdAtUtc: draft.createdAtUtc,
              },
              payload,
            },
            strict,
          ),
        );
        yield* stored(
          "materialize-map",
          sql`UPDATE memory_outbox SET metadata_json=${yield* localMetadataCodec.encode({ ...draft, mapping })} WHERE id=${id}`,
        );
        return { operation, operationDigest: hashText(M.encodeMemoryOperation(operation)) };
      }),
    );
  });

  const usage = Effect.fn("MemoryStore.usage")(function* (
    space: M.MemorySpaceId,
    scope: M.MemoryScope,
  ) {
    const scoped = yield* stored(
      "usage-scope",
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_items WHERE space=${space} AND scope_key=${scopeKey(scope)} AND status!='forgotten'`,
    );
    const summaryCount = yield* stored(
      "usage-summaries",
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_items i WHERE space=${space} AND scope_key=${scopeKey(scope)} AND status!='forgotten' AND EXISTS (SELECT 1 FROM memory_revisions r JOIN json_each(i.heads_json) h WHERE r.space=i.space AND r.revision_id=h.value AND json_extract(r.provenance_json,'$.sourceThread') IS NOT NULL)`,
    );
    const local = yield* stored(
      "usage-local",
      sql<{ count: number }>`SELECT count(*) AS count FROM memory_items WHERE status!='forgotten'`,
    );
    const live = yield* stored(
      "usage-live",
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_items WHERE space=${space} AND status!='forgotten'`,
    );
    const identities = yield* stored(
      "usage-identities",
      sql<{
        count: number;
        bytes: number;
        reserved_receipts: number;
      }>`SELECT count(*) AS count,coalesce(sum(reserve_bytes),0) AS bytes,coalesce(sum(CASE WHEN NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=memory_identity_ledger.space AND t.memory_id=memory_identity_ledger.memory_id) THEN 1 ELSE 0 END),0) AS reserved_receipts FROM memory_identity_ledger WHERE space=${space}`,
    );
    const payloads = yield* stored(
      "usage-payloads",
      sql<{
        live: number;
        history: number;
        all_bytes: number;
      }>`SELECT coalesce(sum(CASE WHEN EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h WHERE i.space=p.space AND i.memory_id=p.memory_id AND h.value=p.payload_ref) THEN length(CAST(p.body_json AS BLOB)) ELSE 0 END),0) AS live,coalesce(sum(CASE WHEN NOT EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h WHERE i.space=p.space AND i.memory_id=p.memory_id AND h.value=p.payload_ref) THEN length(CAST(p.body_json AS BLOB)) ELSE 0 END),0) AS history,coalesce(sum(length(CAST(p.body_json AS BLOB))),0) AS all_bytes FROM memory_payloads p WHERE p.space=${space}`,
    );
    const receipts = yield* stored(
      "usage-receipts",
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM (SELECT operation_id FROM memory_events WHERE memory_space_id=${space} UNION SELECT operation_id FROM memory_compact_receipts WHERE space=${space})`,
    );
    const keys = yield* stored(
      "usage-keys",
      sql<{
        count: number;
        bytes: number;
      }>`SELECT count(*) AS count,coalesce(sum(length(CAST(record_json AS BLOB))),0) AS bytes FROM memory_import_keys WHERE space=${space}`,
    );
    const work = yield* stored(
      "usage-work",
      sql<{
        count: number;
        bytes: number;
      }>`SELECT count(*) AS count,coalesce(sum(length(CAST(metadata_json AS BLOB))),0) AS bytes FROM memory_outbox WHERE space=${space} AND status IN ('pending','retry','running')`,
    );
    const reports = yield* stored(
      "usage-reports",
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_report_outbox WHERE space=${space} AND state!='delivered'`,
    );
    const log = yield* stored(
      "usage-log",
      sql<{
        count: number;
        bytes: number;
      }>`SELECT count(*) AS count,coalesce(sum(length(CAST(metadata_json AS BLOB))+length(CAST(receipt_json AS BLOB))),0) AS bytes FROM memory_events WHERE memory_space_id=${space}`,
    );
    const environment = yield* stored(
      "usage-environment",
      sql<{
        live: number;
        history: number;
        ids: number;
        receipts: number;
        permanent: number;
      }>`SELECT
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p WHERE EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h WHERE i.space=p.space AND i.memory_id=p.memory_id AND h.value=p.payload_ref)) AS live,
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p WHERE NOT EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h WHERE i.space=p.space AND i.memory_id=p.memory_id AND h.value=p.payload_ref)) AS history,
      (SELECT count(*) FROM memory_identity_ledger) AS ids,
      (SELECT count(*) FROM (SELECT memory_space_id AS space,operation_id FROM memory_events UNION SELECT space,operation_id FROM memory_compact_receipts))+(SELECT count(*) FROM memory_identity_ledger l WHERE NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=l.space AND t.memory_id=l.memory_id)) AS receipts,
      (SELECT coalesce(sum(reserve_bytes),0) FROM memory_identity_ledger)+(SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM memory_import_keys) AS permanent`,
    );
    return {
      scopeItems: scoped[0]!.count,
      scopeSummaries: summaryCount[0]!.count,
      scopeExplicit: scoped[0]!.count - summaryCount[0]!.count,
      environmentItems: local[0]!.count,
      environmentLiveBytes: environment[0]!.live,
      environmentHistoryBytes: environment[0]!.history,
      environmentLifetimeIds: environment[0]!.ids,
      environmentReceipts: environment[0]!.receipts,
      environmentPermanentBytes:
        environment[0]!.permanent + environment[0]!.receipts * M.MEMORY_COMPACT_RECEIPT_MAX_BYTES,
      spaceItems: live[0]!.count,
      lifetimeIds: identities[0]!.count,
      permanentBytes:
        identities[0]!.bytes +
        keys[0]!.bytes +
        (receipts[0]!.count + identities[0]!.reserved_receipts) *
          M.MEMORY_COMPACT_RECEIPT_MAX_BYTES,
      receipts: receipts[0]!.count + identities[0]!.reserved_receipts,
      liveBytes: payloads[0]!.live,
      historyBytes: payloads[0]!.history,
      logicalBytes: payloads[0]!.all_bytes + log[0]!.bytes + keys[0]!.bytes,
      keys: keys[0]!.count,
      workItems: work[0]!.count,
      workBytes: work[0]!.bytes,
      reportItems: reports[0]!.count,
      logRows: log[0]!.count,
      logBytes: log[0]!.bytes,
    };
  });
  const readSuppressions = Effect.fn("MemoryStore.readSuppressions")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) {
    const rows = yield* stored(
      "suppression-read",
      sql<{
        record_json: string;
      }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND memory_id=${id} AND key_kind IN ('sourceKey','content','sourceExclusion') ORDER BY key_kind,key`,
    );
    return yield* Effect.forEach(rows, (row) => suppressionCodec.decode(row.record_json, strict));
  });
  const logicalBytes = Effect.fn("MemoryStore.logicalBytes")(function* () {
    const rows = yield* stored(
      "logical-bytes",
      sql<{ bytes: number }>`SELECT
      (SELECT coalesce(sum(length(CAST(body_json AS BLOB))),0) FROM memory_payloads)+
      (SELECT coalesce(sum(length(CAST(metadata_json AS BLOB))+length(CAST(receipt_json AS BLOB))),0) FROM memory_events)+
      (SELECT coalesce(sum(length(CAST(metadata_json AS BLOB))),0) FROM memory_inbox_pending)+
      (SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM memory_import_keys)+
      (SELECT coalesce(sum(reserve_bytes),0) FROM memory_identity_ledger) AS bytes`,
    );
    return rows[0]!.bytes;
  });

  const persistCompactReceipt = Effect.fn("MemoryStore.persistCompactReceipt")(function* (
    input: M.MemoryCompactReceipt,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const json = yield* compactCodec.encode(input);
        const record = yield* compactCodec.decode(json, strict);
        const old = yield* receipt(record.memorySpaceId, record.receipt.operationId);
        if (
          old &&
          (old.operationDigest !== record.receipt.operationDigest ||
            ("hubSequence" in old.receipt &&
              old.receipt.hubSequence !== record.receipt.hubSequence))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const ordinals = new Map<M.EnvironmentId, number>();
        for (const environment of [
          record.originEnvironmentId,
          ...(record.reportGuard ? [record.reportGuard.resolvingEnvironmentId] : []),
        ]) {
          const existing = yield* stored(
            "compact-environment",
            sql<{
              record_json: string;
            }>`SELECT record_json FROM memory_import_keys WHERE space=${record.memorySpaceId} AND key_kind='environment' AND key=${environment}`,
          );
          let ordinal: number;
          if (existing[0])
            ordinal = yield* environmentOrdinalCodec.decode(existing[0].record_json, strict);
          else {
            const counts = yield* stored(
              "compact-environment-count",
              sql<{
                count: number;
              }>`SELECT count(*) AS count FROM memory_import_keys WHERE space=${record.memorySpaceId} AND key_kind='environment'`,
            );
            ordinal = counts[0]!.count + 1;
            yield* stored(
              "compact-environment-write",
              sql`INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) VALUES (${record.memorySpaceId},'environment',${environment},${record.receipt.memoryId},${yield* environmentOrdinalCodec.encode(ordinal)})`,
            );
          }
          ordinals.set(environment, ordinal);
        }
        const binary = encodeCompactReceipt(record, (id) => ordinals.get(id)!);
        if (binary.length > M.MEMORY_COMPACT_RECEIPT_MAX_BYTES)
          return yield* new MemoryStoreConflict({ code: "payload_too_large" });
        yield* stored(
          "compact-receipt-write",
          sql`INSERT INTO memory_compact_receipts (space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json,compact_blob,report_key) VALUES (${record.memorySpaceId},${record.receipt.operationId},${record.receipt.operationDigest},${record.receipt.hubSequence!},${yield* receiptCodec.encode(record.receipt)},${json},${binary},${record.reportGuard?.reportId ?? null}) ON CONFLICT(space,operation_id) DO NOTHING`,
        );
      }),
    );
  });
  const prunePayloads = Effect.fn("MemoryStore.prunePayloads")(function* (
    now: number,
    limit: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "payload-retention",
          sql<{
            space: string;
            payload_ref: string;
          }>`SELECT p.space,p.payload_ref FROM memory_payloads p
        WHERE p.purge_eligible_after IS NOT NULL AND p.purge_eligible_after<=${now} AND (p.revert_deadline IS NULL OR p.revert_deadline<=${now})
        AND EXISTS (SELECT 1 FROM memory_compaction_state c WHERE c.space=p.space AND c.published=1)
        AND NOT EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h WHERE i.space=p.space AND h.value=p.payload_ref)
        AND NOT EXISTS (SELECT 1 FROM memory_conflicts c JOIN json_each(c.heads_json) h WHERE c.space=p.space AND c.status!='resolved' AND h.value=p.payload_ref)
        AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=p.space AND o.payload_ref=p.payload_ref AND o.status IN ('pending','retry','running'))
        AND NOT EXISTS (SELECT 1 FROM memory_revert_intents r WHERE r.space=p.space AND r.payload_ref=p.payload_ref)
        AND NOT EXISTS (SELECT 1 FROM memory_resolutions r JOIN json_each(r.input_payload_refs_json) refs WHERE r.space=p.space AND refs.value=p.payload_ref AND r.revert_deadline>${now})
        AND EXISTS (SELECT 1 FROM memory_revisions r JOIN memory_events e ON e.memory_space_id=r.space AND e.operation_id=r.operation_id WHERE r.space=p.space AND r.payload_ref=p.payload_ref AND json_extract(e.receipt_json,'$.hubSequence') IS NOT NULL)
        ORDER BY p.purge_eligible_after,p.space,p.payload_ref LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
        );
        for (const row of rows)
          yield* stored(
            "payload-retention-purge",
            sql`DELETE FROM memory_payloads WHERE space=${row.space} AND payload_ref=${row.payload_ref}`,
          );
        return rows.length;
      }),
    );
  });

  const forgetLocalIntent = Effect.fn("MemoryStore.forgetLocalIntent")(function* (
    environmentId: M.EnvironmentId,
    intentId: string,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const id = `local:${environmentId}:${intentId}`;
        const rows = yield* stored(
          "local-forget",
          sql<{ metadata_json: string }>`SELECT metadata_json FROM memory_outbox WHERE id=${id}`,
        );
        if (!rows[0]) return;
        const draft = yield* localMetadataCodec.decode(rows[0].metadata_json, strict);
        if (draft.mapping) return yield* new MemoryStoreConflict({ code: "space_mismatch" });
        yield* stored(
          "local-forget-purge",
          sql`DELETE FROM memory_payloads WHERE space=${`_local:${environmentId}`} AND payload_ref=${intentId}`,
        );
        yield* stored(
          "local-forget-fence",
          sql`UPDATE memory_outbox SET status='cancelled',payload_ref=NULL WHERE id=${id}`,
        );
      }),
    );
  });
  const readOperation = Effect.fn("MemoryStore.readOperation")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryOperationId,
  ) {
    const rows = yield* stored(
      "operation-metadata",
      sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_events WHERE memory_space_id=${space} AND operation_id=${id}`,
    );
    if (!rows[0]) return undefined;
    return yield* operationFromMetadata(yield* metadataCodec.decode(rows[0].metadata_json, strict));
  });
  const operationFromMetadata = Effect.fnUntraced(function* (metadata: typeof Metadata.Type) {
    if (metadata.kind === "forget")
      return yield* stored("operation-codec", decodeOperation(metadata, strict));
    if (!metadata.revision) return undefined;
    const rows = yield* stored(
      "operation-payload",
      sql<{
        body_json: string;
      }>`SELECT body_json FROM memory_payloads WHERE space=${metadata.memorySpaceId} AND payload_ref=${metadata.revision.payloadRef}`,
    );
    if (!rows[0]) return undefined;
    const payload = yield* payloadCodec.decode(rows[0].body_json, strict);
    if (metadata.kind === "resolve") {
      if (!metadata.resolution) return undefined;
      const judgments = yield* stored(
        "operation-judgment",
        sql<{
          body_json: string;
        }>`SELECT body_json FROM memory_payloads WHERE space=${metadata.memorySpaceId} AND payload_ref=${metadata.resolution.judgmentRef}`,
      );
      if (!judgments[0]) return undefined;
      return yield* stored(
        "operation-codec",
        decodeOperation(
          {
            ...metadata,
            payload,
            resolutionPayload: yield* resolutionPayloadCodec.decode(judgments[0].body_json, strict),
          },
          strict,
        ),
      );
    }
    return yield* stored("operation-codec", decodeOperation({ ...metadata, payload }, strict));
  });
  const readWorkOperation = Effect.fn("MemoryStore.readWorkOperation")(function* (id: string) {
    const rows = yield* stored(
      "work-operation",
      sql<WorkRow>`SELECT * FROM memory_outbox WHERE id=${id}`,
    );
    const work = (yield* workRows(rows))[0];
    return work && "protocolVersion" in work.metadata
      ? yield* operationFromMetadata(work.metadata)
      : undefined;
  });
  const pendingReceived = Effect.fn("MemoryStore.pendingReceived")(function* (
    space: M.MemorySpaceId,
    limit: number,
  ) {
    const rows = yield* stored(
      "pending-received",
      sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_inbox_pending WHERE space=${space} AND record_kind='operation' ORDER BY hub_sequence,pending_key LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
    );
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return yield* operationFromMetadata(yield* metadataCodec.decode(row.metadata_json, strict));
      }),
    );
  });
  const stageRevertIntent = Effect.fn("MemoryStore.stageRevertIntent")(function* (input: {
    operation: Extract<M.MemoryOperation, { kind: "revert" }>;
    requestDigest: string;
  }) {
    yield* transact(
      Effect.gen(function* () {
        const op = input.operation;
        const valid = yield* stored("revert-codec", decodeOperation(op, strict));
        if (valid.kind !== "revert")
          return yield* new MemoryStoreConflict({ code: "unsupported_operation" });
        const original = yield* stored(
          "revert-intent",
          sql<{
            request_digest: string;
            operation_id: string;
          }>`SELECT request_digest,operation_id FROM memory_revert_intents WHERE space=${op.memorySpaceId} AND resolution_id=${op.revertsResolutionId}`,
        );
        if (original[0]) {
          if (
            original[0].operation_id !== op.operationId ||
            original[0].request_digest !== input.requestDigest
          )
            return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
          return;
        }
        const current = yield* loadAggregate(op.memorySpaceId, op.memoryId);
        if (current.tombstone || current.pendingForget)
          return yield* new MemoryStoreConflict({ code: "forgotten" });
        const resolution = current.resolutions.find(
          (r) => r.resolutionId === op.revertsResolutionId,
        );
        if (
          !resolution ||
          !resolution.inputRevisionIds.includes(op.restoredRevisionId) ||
          current.heads.length !== 1 ||
          current.heads[0] !== resolution.resultRevisionId ||
          op.expectedHeads[0] !== resolution.resultRevisionId
        )
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        const now = yield* Clock.currentTimeMillis;
        if (now >= Date.parse(resolution.revertDeadlineUtc))
          return yield* new MemoryStoreConflict({ code: "revert_expired" });
        const body = yield* payloadCodec.encode(op.payload);
        const metadata = yield* metadataCodec.encode(metadataOf(op));
        const usage = yield* storeUsageForRevert(op.memorySpaceId);
        if (
          usage.items >= M.MEMORY_WORK_MAX_PENDING_ITEMS ||
          usage.bytes + new TextEncoder().encode(body + metadata).length >
            M.MEMORY_WORK_MAX_PAYLOAD_BYTES
        )
          return yield* new MemoryCapacityError({
            dimension: "work_bytes",
            limit: M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
          });
        yield* stored(
          "revert-stage-payload",
          sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json,revert_deadline) VALUES (${op.memorySpaceId},${op.revision.payloadRef},${op.memoryId},${body},${yield* headsCodec.encode(op.payload.derivedFromMemoryRevisions)},${Date.parse(resolution.revertDeadlineUtc)})`,
        );
        yield* stored(
          "revert-stage",
          sql`INSERT INTO memory_revert_intents (space,operation_id,memory_id,resolution_id,restored_revision_id,expected_heads_json,request_digest,submission_metadata_json,payload_ref,created_at) VALUES (${op.memorySpaceId},${op.operationId},${op.memoryId},${op.revertsResolutionId},${op.restoredRevisionId},${yield* headsCodec.encode(op.expectedHeads)},${input.requestDigest},${metadata},${op.revision.payloadRef},${now})`,
        );
        yield* enqueueWork({
          id: `revert:${op.memorySpaceId}:${op.operationId}`,
          space: op.memorySpaceId,
          memoryId: op.memoryId,
          kind: "revert_intent",
          status: "pending",
          metadata: metadataOf(op),
          payloadRef: op.revision.payloadRef,
          attempt: 0,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
        });
      }),
    );
  });
  const storeUsageForRevert = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const rows = yield* stored(
      "revert-work-budget",
      sql<{
        items: number;
        bytes: number;
      }>`SELECT count(*) AS items,coalesce(sum(length(CAST(o.metadata_json AS BLOB))+coalesce(length(CAST(p.body_json AS BLOB)),0)),0) AS bytes FROM memory_outbox o LEFT JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.space=${space} AND o.status IN ('pending','retry','running')`,
    );
    return rows[0]!;
  });

  const cleanupDerived = Effect.fn("MemoryStore.cleanupDerived")(function* (limit: number) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "cleanup-targets",
          sql<{
            space: string;
            memory_id: string;
            rowid: number;
            generation: number;
            item_json: string;
          }>`SELECT * FROM memory_items WHERE cleanup_pending=1 ORDER BY projection_watermark,memory_id LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
        );
        let count = 0;
        for (const row of rows) {
          const success = yield* sql`DELETE FROM memory_items_fts WHERE rowid=${row.rowid}`.pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!success) continue;
          const projection = yield* projectionCodec.decode(row.item_json, strict);
          const availability = { ...projection.localAvailability, cleanupPending: false };
          yield* stored(
            "cleanup-settle",
            sql`UPDATE memory_items SET cleanup_pending=0,indexed_bytes=0,indexed_revision=NULL,indexed_generation=NULL,item_json=${yield* projectionCodec.encode({ ...projection, localAvailability: availability })},availability_json=${yield* availabilityCodec.encode(availability)} WHERE space=${row.space} AND memory_id=${row.memory_id} AND generation=${row.generation}`,
          );
          count++;
        }
        return count;
      }),
    );
  });
  return MemoryStore.of({
    transact,
    receipt,
    loadAggregate: (space, id) => transact(loadAggregate(space, id)),
    apply: (decision) => applyDecision(decision),
    reconnectParked: (decision, generation) => applyDecision(decision, generation),
    readAncestry: (space, id, parents) => transact(readAncestry(space, id, parents)),
    withReceivedCursor,
    readCursor,
    readOperation,
    readWorkOperation,
    pendingReceived,
    stageRevertIntent,
    list: (filter) => transact(list(filter)),
    search: (filter, text, mode) => transact(search(filter, text, mode)),
    dueWork,
    enqueueWork,
    claimWork,
    finishWork,
    readEligibleOutbox,
    acknowledgeOutbox,
    preserveForgetIntent,
    enqueuePendingForget,
    forgetLocalIntent,
    pendingForgetIntents,
    settleForgetIntent,
    readDeferred,
    claimDeferred,
    finishDeferred,
    recoverDeferred,
    getProjectBinding,
    putProjectBinding,
    changes,
    reserve,
    usage,
    operationMetadataBytes: (operation) =>
      Effect.map(
        metadataCodec.encode(metadataOf(operation)),
        (text) => new TextEncoder().encode(text).length,
      ),
    persistCompactReceipt,
    prunePayloads,
    readSuppressions,
    logicalBytes: logicalBytes(),
    counters,
    ftsState,
    putFtsState,
    index,
    measureAllocation,
    mergeFts,
    cleanupDerived,
    recordSample,
    samples,
    putLocalIntent,
    materializeLocalIntent,
    installCheckpointPage,
    completeCheckpoint,
    readDueClaimCandidates,
    recoverClaimCandidates,
    claimCandidate,
    retryClaimCandidate,
    completeClaimCandidate,
    persistResolutionTicket,
    pendingReports,
    claimReport,
    acknowledgeReport,
    failReport,
    wake,
    subscribeWake: Effect.map(PubSub.subscribe(wakes), Stream.fromSubscription),
  });
});
export const layer = Layer.effect(MemoryStore, make);
