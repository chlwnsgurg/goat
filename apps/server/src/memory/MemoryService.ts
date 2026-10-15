// @effect-diagnostics-next-line nodeBuiltinImport:off -- deterministic server-owned revision identifiers.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";

export class MemoryAccessError extends Schema.TaggedError<MemoryAccessError>()(
  "MemoryAccessError",
  {
    code: M.MemoryFailureCode,
  },
) {
  override get message() {
    return "Memory access denied.";
  }
}
export type MemoryServiceError =
  | MemoryAccessError
  | Store.MemoryStorageError
  | Store.MemoryStoreConflict
  | Store.MemoryCapacityError;
type Permit = Effect.Effect<void, MemoryAccessError>;
type SummaryCommit = {
  readonly work: Store.MemoryWork;
  readonly generated: M.GenerateMemorySummaryExecutionResult;
  readonly input: M.GenerateMemorySummaryInput;
  readonly expectedHeads: ReadonlyArray<M.MemoryRevisionId>;
  /** Re-read committed source/exclusions inside the commit transaction. */
  readonly recheckSource: Effect.Effect<void, MemoryServiceError>;
};
export type IntentBinding = {
  memorySpaceId: M.MemorySpaceId | null;
  coordinatorEpoch: number;
  enabled: boolean;
};
export type IntentCommitInput = {
  assignment: Omit<Store.IntentIdentityInput, "environmentId">;
  expectedEpoch: number;
  /** Fresh shared settings/stop authority; called inside the writer Tx, never cached or networked. */
  readBinding: Effect.Effect<IntentBinding, MemoryAccessError>;
};
export type ValidatedSourceRequest = {
  request: M.MemoryHubSourceReadRequestInput;
  generation: number;
};
export type MemorySourceReadAuthority = {
  readSource: (
    input: ValidatedSourceRequest,
    permit: Permit,
  ) => Effect.Effect<M.MemorySourceReadOutcome, MemoryServiceError | M.MemoryHubError>;
};
export type MemoryOwnerCommittedReader = {
  readCommitted: (
    input: M.MemorySourceReadRequest,
    reauthorize: Permit,
  ) => Effect.Effect<M.MemorySourceReadOutcome, MemoryServiceError>;
};
export class MemoryService extends Context.Service<
  MemoryService,
  {
    readonly commitLocalIntent: (
      input: IntentCommitInput,
    ) => Effect.Effect<
      Store.MaterializedIntent & { receipt: Store.StoredReceipt },
      MemoryServiceError
    >;
    readonly readSource: (
      input: M.MemoryReadSourceInput,
      permit: Permit,
    ) => Effect.Effect<M.MemorySourcePage, MemoryServiceError>;
    readonly prepareSourceRead: (
      input: M.MemoryReadSourceInput,
      permit: Permit,
    ) => Effect.Effect<ValidatedSourceRequest, MemoryServiceError>;
    readonly validateSourceOutcome: (
      input: { request: ValidatedSourceRequest; outcome: M.MemorySourceReadOutcome },
      permit: Permit,
    ) => Effect.Effect<M.MemorySourceReadOutcome, MemoryServiceError>;
    readonly admitHubOperation: (input: {
      authority: Store.HubAuthority;
      operation: M.MemoryOperation;
      resolutionRequest?: M.MemoryHubApplyResolutionInput;
    }) => Effect.Effect<
      M.MemoryHubReceipt,
      | MemoryServiceError
      | M.MemoryHubError
      | M.MemoryHubUnauthorizedError
      | M.MemoryHubForbiddenError
    >;
    readonly admitHubOperationTx: (input: {
      authority: Store.HubAuthority;
      operation: M.MemoryOperation;
      resolutionRequest?: M.MemoryHubApplyResolutionInput;
    }) => Store.InTx<
      M.MemoryHubReceipt,
      | MemoryServiceError
      | M.MemoryHubError
      | M.MemoryHubUnauthorizedError
      | M.MemoryHubForbiddenError
    >;
    readonly settleHubEntryTx: (input: {
      memorySpaceId: M.MemorySpaceId;
      hubEnvironmentId: M.EnvironmentId;
      localEnvironmentId: M.EnvironmentId;
      entry: M.MemoryHubEntry;
      workId?: string;
    }) => Store.InTx<Store.Settlement, MemoryServiceError>;
    readonly receiveHubPage: (input: {
      memorySpaceId: M.MemorySpaceId;
      hubEnvironmentId: M.EnvironmentId;
      localEnvironmentId: M.EnvironmentId;
      expectedSequence: number;
      page: M.MemoryHubPullResult;
      reauthorize: Permit;
    }) => Effect.Effect<readonly Store.Settlement[], MemoryServiceError>;
    readonly reconcileResolutionSubmission: (input: {
      ownership: Store.TicketOwner;
      now: number;
      hubEnvironmentId: M.EnvironmentId;
      localEnvironmentId: M.EnvironmentId;
      rejection?: M.MemoryHubReceipt;
      reauthorize: Permit;
    }) => Effect.Effect<Store.SubmissionReconciliation | null, MemoryServiceError>;
    readonly settleHubAcknowledgement: (input: {
      memorySpaceId: M.MemorySpaceId;
      hubEnvironmentId: M.EnvironmentId;
      localEnvironmentId: M.EnvironmentId;
      workId: string;
      receipt: M.MemoryHubReceipt;
      operation: { operationId: M.MemoryOperationId; operationDigest: string };
      reauthorize: Permit;
    }) => Effect.Effect<Store.Settlement, MemoryServiceError>;
    readonly getProjectBinding: (
      input: M.MemoryProjectBindingGetInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryProjectBinding, MemoryServiceError>;
    readonly updateProjectBinding: (
      input: M.MemoryProjectBindingUpdateInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryProjectBindingUpdateResult, MemoryServiceError>;
    readonly resolveProjectKey: (
      space: M.MemorySpaceId,
      project: M.ScopedProjectRef,
    ) => Effect.Effect<M.MemoryProjectKey | null, MemoryServiceError>;
    readonly changes: (
      input: M.MemoryChangesInput,
      permit: Permit,
    ) => Effect.Effect<
      Stream.Stream<M.MemoryChangeSignal, MemoryServiceError>,
      MemoryServiceError,
      Scope.Scope
    >;
    readonly upsert: (
      input: M.MemoryUpsertInput,
      permit: Permit,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly retryForgetExpansion: (
      intent: Store.PendingForgetIntent,
    ) => Effect.Effect<void, MemoryServiceError>;
    readonly forget: (
      input: M.MemoryForgetInput,
      permit: Permit,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly revertResolution: (
      input: M.MemoryRevertResolutionInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryRevertResult, MemoryServiceError>;
    readonly list: (
      input: M.MemoryListInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryPage, MemoryServiceError>;
    readonly search: (
      input: M.MemorySearchInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryPage, MemoryServiceError>;
    readonly read: (
      input: M.MemoryReadInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryItem, MemoryServiceError>;
    readonly history: (
      input: M.MemoryHistoryInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryHistoryPage, MemoryServiceError>;
    readonly applyReceived: (
      operation: M.MemoryOperation,
      receipt: M.MemoryHubReceipt,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly commitAcceptedResolution: (
      operation: Extract<M.MemoryOperation, { kind: "resolve" | "revert" }>,
      receipt: M.MemoryHubReceipt,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly commitSummary: (
      input: SummaryCommit,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly queueSummary: (work: Store.MemoryWork) => Effect.Effect<void, MemoryServiceError>;
    readonly queueResolution: Store.MemoryStore["Service"]["persistResolutionTicket"];
    readonly recoverWork: Store.MemoryStore["Service"]["dueWork"];
    readonly reconnectParked: (
      operation: M.MemoryOperation,
    ) => Effect.Effect<boolean, MemoryServiceError>;
    readonly pendingReports: Store.MemoryStore["Service"]["pendingReports"];
    readonly claimReport: Store.MemoryStore["Service"]["claimReport"];
    readonly acknowledgeReport: Store.MemoryStore["Service"]["acknowledgeReport"];
    readonly failReport: Store.MemoryStore["Service"]["failReport"];
    readonly readContextCandidates: (
      input: M.MemoryListInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryContextCandidates, MemoryServiceError>;
    readonly readContextRevisions: (
      space: M.MemorySpaceId,
      ids: ReadonlyArray<M.MemoryId>,
      permit: Permit,
    ) => Effect.Effect<M.MemoryContextCandidates, MemoryServiceError>;
  }
>()("goat/memory/MemoryService") {}
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(M.MemoryModelSelection));
const encodeHeads = Schema.encodeSync(Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)));
const encodeProjectKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(M.MemoryProjectKey)),
);
const strict = { onExcessProperty: "error" } as const;
const encodePageItem = Schema.encodeEffect(Schema.fromJsonString(M.MemoryItem));
const decodeBindingGet = Schema.decodeUnknownEffect(M.MemoryProjectBindingGetInput);
const decodeBindingUpdate = Schema.decodeUnknownEffect(M.MemoryProjectBindingUpdateInput);
const encodeBindingUpdate = Schema.encodeSync(
  Schema.fromJsonString(M.MemoryProjectBindingUpdateInput),
);
const decodeChanges = Schema.decodeUnknownEffect(M.MemoryChangesInput);
const decodeUpsert = Schema.decodeUnknownEffect(M.MemoryUpsertInput);
const decodeForget = Schema.decodeUnknownEffect(M.MemoryForgetInput);
const decodeRevert = Schema.decodeUnknownEffect(M.MemoryRevertResolutionInput);
const decodeRead = Schema.decodeUnknownEffect(M.MemoryReadInput);
const decodeList = Schema.decodeUnknownEffect(M.MemoryListInput);
const decodeSearch = Schema.decodeUnknownEffect(M.MemorySearchInput);
const decodeHistory = Schema.decodeUnknownEffect(M.MemoryHistoryInput);
const decodeSummary = Schema.decodeUnknownEffect(M.GenerateMemorySummaryExecutionResult);
const encodeRevert = Schema.encodeSync(Schema.fromJsonString(M.MemoryRevertResolutionInput));
const decodePage = Schema.decodeUnknownEffect(M.MemoryPage);
const decodeReportThread = Schema.decodeUnknownEffect(Schema.fromJsonString(M.ScopedThreadRef));
const decodeReport = Schema.decodeUnknownEffect(M.MemoryReportDelivery);
const encodeHubReceipt = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubReceipt));
const encodeReadSource = Schema.encodeEffect(Schema.fromJsonString(M.MemoryReadSourceInput));
const decodeReadSource = Schema.decodeUnknownEffect(M.MemoryReadSourceInput);
const decodeSourceRequest = Schema.decodeUnknownEffect(M.MemoryHubSourceReadRequestInput);
const decodeSourceOutcome = Schema.decodeUnknownEffect(M.MemorySourceReadOutcome);
const encodeSourceThread = Schema.encodeEffect(Schema.fromJsonString(M.ScopedThreadRef));
const encodeSourceWatermark = Schema.encodeEffect(Schema.fromJsonString(M.MemorySourceWatermark));
const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperation);
const decodeResolutionRequest = Schema.decodeUnknownEffect(M.MemoryHubApplyResolutionInput);
const decodeHubEntry = Schema.decodeUnknownEffect(M.MemoryHubEntry);
const decodeHubPage = Schema.decodeUnknownEffect(M.MemoryHubPullResult);
const decodeHubReceipt = Schema.decodeUnknownEffect(M.MemoryHubReceipt);
const decodeHistoryPage = Schema.decodeUnknownEffect(M.MemoryHistoryPage);
const isConflict = Schema.is(Store.MemoryStoreConflict);
const isFailureCode = Schema.is(M.MemoryFailureCode);
const invalid = () => new Store.MemoryStoreConflict({ code: "invalid_output" });
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
export const memoryStableUuid = (text: string) => {
  const h = hash(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const decodeSummaryPayload = Schema.decodeEffect(M.MemoryPayload);
const decode = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(invalid));
/** A missing revision cannot support forget's reverse walk; never reuse its derived text. */
export const validateSummaryDependencies = Effect.fn("MemoryService.validateSummaryDependencies")(
  function* (space: M.MemorySpaceId, payload: M.MemoryPayload) {
    const revisions = [...new Set(payload.derivedFromMemoryRevisions)];
    if (!revisions.length) return;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ count: number }>`
      SELECT count(*) AS count FROM memory_revisions r JOIN memory_items i ON i.space=r.space AND i.memory_id=r.memory_id
      WHERE r.space=${space} AND r.revision_id IN (SELECT value FROM json_each(${encodeHeads(revisions)}))
      AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending p WHERE p.space=r.space AND p.operation_id=r.operation_id AND p.record_kind='operation')
      AND i.status='active' AND json_extract(i.availability_json,'$.exposure')='visible'
      AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=r.space AND f.memory_id=r.memory_id)
    `.pipe(
      Effect.mapError(
        (cause) => new Store.MemoryStorageError({ stage: "summary-dependencies", cause }),
      ),
    );
    if (rows[0]?.count !== revisions.length)
      return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
  },
);
const make = Effect.fnUntraced(function* (
  sourceReadAuthority?: MemorySourceReadAuthority["readSource"],
) {
  const repositoryResolver = yield* RepositoryResolver.RepositoryIdentityResolver;
  const store = yield* Store.MemoryStore;
  const quota = yield* Quota.MemoryQuotaService;
  const identity = yield* Environment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const query = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) => new Store.MemoryStorageError({ stage: "service-read", cause })),
    );
  const projectRoot = Effect.fn("MemoryService.projectRoot")(function* (
    project: M.ScopedProjectRef,
  ) {
    if (project.environmentId !== environmentId)
      return yield* new MemoryAccessError({ code: "identity_mismatch" });
    const rows = yield* query(
      sql<{
        workspace_root: string;
      }>`SELECT workspace_root FROM projection_projects WHERE project_id=${project.projectId} AND deleted_at IS NULL`,
    );
    if (!rows[0]) return yield* new Store.MemoryStoreConflict({ code: "not_found" });
    return rows[0].workspace_root;
  });
  const getProjectBinding = Effect.fn("MemoryService.getProjectBinding")(function* (
    input: M.MemoryProjectBindingGetInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeBindingGet(input, strict));
    yield* permit;
    const root = yield* projectRoot(value.project);
    const observed = yield* repositoryResolver.resolve(root);
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* projectRoot(value.project);
        const old = yield* store.getProjectBinding(value.memorySpaceId, value.project);
        if (old?.repositoryKey || !observed)
          return old ?? { ...value, projectKey: null, repositoryKey: null, version: 0 };
        const repositoryKey = {
          kind: "repository" as const,
          groupingKey: M.repositoryGroupingKeyOf(observed),
        };
        const binding = {
          ...value,
          repositoryKey,
          projectKey: old?.projectKey?.kind === "explicit" ? old.projectKey : repositoryKey,
          version: old?.version ?? 0,
        };
        yield* store.putProjectBinding(
          binding,
          old?.version ?? null,
          yield* Clock.currentTimeMillis,
        );
        return binding;
      }),
    );
  });
  const updateProjectBinding = Effect.fn("MemoryService.updateProjectBinding")(function* (
    input: M.MemoryProjectBindingUpdateInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeBindingUpdate(input, strict));
    yield* getProjectBinding(
      { memorySpaceId: value.memorySpaceId, project: value.project },
      permit,
    );
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* projectRoot(value.project);
        const id = `binding:${value.memorySpaceId}:${value.requestId}`;
        const digest = hash(encodeBindingUpdate(value));
        const replay = yield* store.readWork(id);
        if (replay) {
          if (replay.metadata.kind !== "binding" || replay.metadata.requestDigest !== digest)
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          return replay.metadata.result;
        }
        const old = (yield* store.getProjectBinding(value.memorySpaceId, value.project)) ?? {
          memorySpaceId: value.memorySpaceId,
          project: value.project,
          repositoryKey: null,
          projectKey: null,
          version: 0,
        };
        if (old.version !== value.expectedVersion)
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        const projectKey =
          value.action === "setExplicit"
            ? { kind: "explicit" as const, sharedProjectId: value.sharedProjectId }
            : old.repositoryKey;
        const changed = encodeProjectKey(projectKey) !== encodeProjectKey(old.projectKey);
        const binding = { ...old, projectKey, version: old.version + Number(changed) };
        if (changed)
          yield* store.putProjectBinding(
            binding,
            (yield* store.getProjectBinding(value.memorySpaceId, value.project))?.version ?? null,
            yield* Clock.currentTimeMillis,
          );
        const result = { binding, requestId: value.requestId };
        yield* store.enqueueWork({
          id,
          space: value.memorySpaceId,
          memoryId: null,
          kind: "admin",
          status: "completed",
          metadata: { kind: "binding", requestDigest: digest, result },
          payloadRef: null,
          attempt: 0,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
        });
        return result;
      }),
    );
  });
  const resolveProjectKey = (space: M.MemorySpaceId, project: M.ScopedProjectRef) =>
    getProjectBinding({ memorySpaceId: space, project }, Effect.void).pipe(
      Effect.map((binding) => binding.projectKey),
    );
  const changes = Effect.fn("MemoryService.changes")(function* (
    input: M.MemoryChangesInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeChanges(input, strict));
    yield* permit;
    const stream = yield* store.changes(value.memorySpaceId);
    return stream.pipe(Stream.tap(() => permit));
  });
  const requireScope = (scope: M.MemoryScope) =>
    scope.kind === "thread" && scope.thread.environmentId !== environmentId
      ? Effect.fail(new MemoryAccessError({ code: "identity_mismatch" }))
      : Effect.void;
  const decide = (
    current: Store.MemoryAggregate,
    op: M.MemoryOperation,
    admission: Store.MemoryAdmissionContext,
    receipt?: M.MemoryHubReceipt,
    ancestry?: Store.MemoryAncestry,
  ) =>
    Effect.try({
      try: () =>
        decideMemoryOperation(
          current,
          op,
          admission,
          admission.kind === "approvedReplica" ? undefined : scanMemoryValue(op),
          receipt,
          ancestry,
        ),
      catch: (cause) => (isConflict(cause) ? cause : invalid()),
    });
  const apply = Effect.fn("MemoryService.apply")(function* (
    op: M.MemoryOperation,
    admission: Store.MemoryAdmissionContext,
    permit: Permit,
    approval?: M.MemoryHubReceipt,
  ) {
    const digest = yield* Effect.try({ try: () => memoryOperationDigest(op), catch: invalid });
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const old = yield* store.receipt(op.memorySpaceId, op.operationId);
        if (old) {
          if (
            old.operationDigest !== digest &&
            (admission.kind !== "localIntent" ||
              old.receipt.forgetExpansion?.requestDigest !== digest)
          )
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          if (
            !(
              admission.kind === "approvedReplica" &&
              approval &&
              (!("hubSequence" in old.receipt) || old.receipt.hubSequence === null)
            )
          )
            return old;
        }
        const current = yield* store.loadAggregate(op.memorySpaceId, op.memoryId);
        if (admission.kind !== "approvedReplica" && current.pendingForget && op.kind !== "forget")
          return yield* new Store.MemoryStoreConflict({ code: "forget_pending" });
        let ancestry: Store.MemoryAncestry | undefined;
        if (op.kind !== "forget") {
          if (admission.kind !== "approvedReplica") yield* requireScope(op.revision.scope);
          ancestry = yield* store.readAncestry(op.memorySpaceId, op.memoryId, op.revision.parents);
          if (ancestry.parents.some((p) => p.status === "crossMemory"))
            return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
          if (
            admission.kind !== "approvedReplica" &&
            ancestry.parents.some((p) => p.status === "compacted")
          )
            return yield* new Store.MemoryStoreConflict({ code: "base_compacted" });
        }
        const decision = yield* decide(current, op, admission, approval, ancestry);
        return yield* quota.commit(decision, environmentId, permit);
      }),
    );
  });
  const commitLocalIntent: MemoryService["Service"]["commitLocalIntent"] = Effect.fn(
    "MemoryService.commitLocalIntent",
  )(function* (input) {
    const permit = Effect.gen(function* () {
      const binding = yield* input.readBinding;
      if (
        !binding.enabled ||
        binding.coordinatorEpoch !== input.expectedEpoch ||
        binding.memorySpaceId !== input.assignment.memorySpaceId
      )
        return yield* new MemoryAccessError({ code: "fenced" });
    });
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const materialized = yield* store.materializeLocalIntentTx({
          ...input.assignment,
          environmentId,
        });
        const receipt = yield* apply(materialized.operation, Store.localIntent, permit);
        yield* permit;
        yield* store.completeLocalIntentTx({
          environmentId,
          intentId: input.assignment.intentId,
          materialized,
          now: yield* Clock.currentTimeMillis,
        });
        return { ...materialized, receipt };
      }),
    );
  });
  const upsert = Effect.fn("MemoryService.upsert")(function* (
    input: M.MemoryUpsertInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeUpsert(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* requireScope(value.scope);
        const old = yield* store.readOperation(value.memorySpaceId, value.operationId);
        const revisionId = M.MemoryRevisionId.make(
          memoryStableUuid(`${value.memorySpaceId}:${value.operationId}:revision`),
        );
        const op: M.MemoryOperation = {
          protocolVersion: 1,
          kind: "upsert",
          memorySpaceId: value.memorySpaceId,
          memoryId: value.memoryId,
          operationId: value.operationId,
          originEnvironmentId: environmentId,
          expectedHeads: value.expectedHeads,

          revision: {
            memorySpaceId: value.memorySpaceId,
            memoryId: value.memoryId,
            operationId: value.operationId,
            revisionId,
            payloadRef: revisionId,
            parents: value.expectedHeads,
            scope: value.scope,
            assertionKind: value.assertionKind,
            provenance: { environmentId },
            createdAtUtc:
              old && old.kind !== "forget"
                ? old.revision.createdAtUtc
                : M.MemoryUtcTimestamp.make(
                    DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
                  ),
          },
          payload: value.payload,
        };
        return yield* apply(op, Store.localIntent, permit);
      }),
    );
  });
  const forget = Effect.fn("MemoryService.forget")(function* (
    input: M.MemoryForgetInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeForget(input, strict));
    return yield* store
      .transact(
        Effect.gen(function* () {
          yield* permit;
          const current = yield* store.loadAggregate(value.memorySpaceId, value.memoryId);
          if (current.identity) yield* requireScope(current.identity.scope);
          const old = yield* store.readOperation(value.memorySpaceId, value.operationId);
          if (
            old &&
            (old.kind !== "forget" ||
              old.memoryId !== value.memoryId ||
              encodeHeads(old.expectedHeads) !== encodeHeads(value.expectedHeads))
          )
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          if (current.tombstone && !old)
            return {
              operationDigest: "0".repeat(64),
              receipt: {
                operationId: current.tombstone.deleteOperationId,
                memoryId: value.memoryId,
                outcome: "noop" as const,
                revisionId: null,
                pendingSync: false,
              },
            };
          const suppressedSourceKeys: M.MemorySourceKey[] = [];
          const sourceExclusions: M.MemorySourceExclusion[] = [];
          for (const { revision, payload } of current.revisions) {
            const p = revision.provenance;
            if (p.sourceThread && p.sourceWatermark) {
              const messageIds = [
                ...new Set((payload?.evidence ?? []).flatMap((e) => e.messageIds)),
              ];
              if (messageIds.length)
                sourceExclusions.push({
                  sourceThread: p.sourceThread,
                  sourceWatermark: p.sourceWatermark,
                  messageIds,
                });
            }
          }
          const op: Extract<M.MemoryOperation, { kind: "forget" }> = old ?? {
            protocolVersion: 1,
            kind: "forget",
            memorySpaceId: value.memorySpaceId,
            memoryId: value.memoryId,
            operationId: value.operationId,
            originEnvironmentId: environmentId,
            expectedHeads: value.expectedHeads,
            tombstone: {
              memorySpaceId: value.memorySpaceId,
              memoryId: value.memoryId,
              deleteOperationId: value.operationId,
              deletingEnvironmentId: environmentId,
              deletedAtUtc: M.MemoryUtcTimestamp.make(
                DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
              ),
              suppressedSourceKeys,
              suppressedContent: [],
              sourceExclusions,
            },
          };
          return yield* apply(op, Store.localIntent, permit);
        }),
      )
      .pipe(
        Effect.catchTags({
          MemoryCapacityError: (error) =>
            store
              .transact(
                Effect.gen(function* () {
                  yield* permit;
                  yield* store.preserveForgetIntent({
                    memorySpaceId: value.memorySpaceId,
                    memoryId: value.memoryId,
                    operationId: value.operationId,
                    requestedAtUtc: M.MemoryUtcTimestamp.make(
                      DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
                    ),
                    attempts: 0,
                    lastFailureCode: "capacity_exceeded",
                    operationDigest: null,
                    submissionState: "unsubmitted",
                  });
                }),
              )
              .pipe(Effect.andThen(Effect.fail(error))),
        }),
      );
  });

  const retryForgetExpansion = Effect.fn("MemoryService.retryForgetExpansion")(function* (
    intent: Store.PendingForgetIntent,
  ) {
    const original = yield* store.readOperation(intent.memorySpaceId, intent.operationId);
    if (
      !original ||
      original.kind !== "forget" ||
      memoryOperationDigest(original) !== intent.operationDigest
    )
      return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
    const operationId = M.MemoryOperationId.make(
      memoryStableUuid(`${intent.operationId}:${intent.attempts}:retry`),
    );
    const operation: M.MemoryOperation = {
      ...original,
      operationId,
      tombstone: { ...original.tombstone, deleteOperationId: operationId },
    };
    yield* store
      .transact(
        Effect.gen(function* () {
          const current = yield* store.loadAggregate(intent.memorySpaceId, intent.memoryId);
          if (current.identity) yield* requireScope(current.identity.scope);
          const decision = yield* decide(current, operation, Store.localIntent);
          const receipt = {
            ...decision.receipt,
            forgetRetryOf: {
              operationId: intent.operationId,
              operationDigest: intent.operationDigest!,
            },
          };
          // Failed retries retain one bounded intent and the original rejection, not another event per sweep.
          yield* quota.withAdmission(
            { operation, admission: Store.localIntent, environmentId, receipt },
            store.apply({ ...decision, receipt }),
          );
        }),
      )
      .pipe(
        Effect.catchTags({
          MemoryCapacityError: (error) =>
            store.preserveForgetIntent(intent).pipe(Effect.andThen(Effect.fail(error))),
        }),
      );
  });

  const revertResolution = Effect.fn("MemoryService.revertResolution")(function* (
    input: M.MemoryRevertResolutionInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeRevert(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const current = yield* store.loadAggregate(value.memorySpaceId, value.memoryId);
        if (current.identity) yield* requireScope(current.identity.scope);
        const resolution = current.resolutions.find((r) => r.resolutionId === value.resolutionId);
        if (!resolution) return yield* new Store.MemoryStoreConflict({ code: "not_found" });
        const result = {
          operationId: value.operationId,
          memoryId: value.memoryId,
          resolutionId: value.resolutionId,
          revertDeadlineUtc: resolution.revertDeadlineUtc,
        };
        const approved = yield* store.receipt(value.memorySpaceId, value.operationId);
        if (
          approved &&
          "hubSequence" in approved.receipt &&
          approved.receipt.outcome === "accepted"
        ) {
          const operation = yield* store.readOperation(value.memorySpaceId, value.operationId);
          if (
            operation?.kind !== "revert" ||
            operation.restoredRevisionId !== value.restoredRevisionId ||
            operation.revertsResolutionId !== value.resolutionId
          )
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          return {
            ...result,
            status: "accepted" as const,
            receipt: {
              operationId: value.operationId,
              memoryId: value.memoryId,
              outcome: "accepted" as const,
              revisionId: operation.revision.revisionId,
              pendingSync: false,
            },
            localAvailability: current.item!.localAvailability,
          };
        }
        const staged = yield* store.readWorkOperation(
          `revert:${value.memorySpaceId}:${value.operationId}`,
        );
        if (staged) {
          if (staged.kind !== "revert")
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          yield* store.stageRevertIntent({
            operation: staged,
            requestDigest: hash(encodeRevert(value)),
          });
          return { ...result, status: "pending" as const };
        }
        if (current.tombstone || current.pendingForget)
          return { ...result, status: "forgotten" as const };
        if (
          current.heads.length !== 1 ||
          current.heads[0] !== resolution.resultRevisionId ||
          value.expectedHeads[0] !== resolution.resultRevisionId
        )
          return { ...result, status: "revision_changed" as const };
        const now = yield* Clock.currentTimeMillis;

        const original = current.revisions.find(
          (r) => r.revision.revisionId === value.restoredRevisionId,
        );
        if (!original?.payload || !resolution.inputRevisionIds.includes(value.restoredRevisionId))
          return { ...result, status: "revision_changed" as const };
        const revisionId = M.MemoryRevisionId.make(memoryStableUuid(`${value.operationId}:revert`));
        yield* store.stageRevertIntent({
          requestDigest: hash(encodeRevert(value)),
          operation: {
            protocolVersion: 1,
            kind: "revert",
            memorySpaceId: value.memorySpaceId,
            memoryId: value.memoryId,
            operationId: value.operationId,
            originEnvironmentId: environmentId,
            expectedHeads: value.expectedHeads,
            revertsResolutionId: value.resolutionId,
            restoredRevisionId: value.restoredRevisionId,
            payload: original.payload,
            revision: {
              ...original.revision,
              revisionId,
              operationId: value.operationId,
              parents: value.expectedHeads,
              payloadRef: revisionId,
              provenance: { environmentId },
              createdAtUtc: M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(now))),
            },
          },
        });
        return { ...result, status: "pending" as const };
      }),
    );
  });
  const read = Effect.fn("MemoryService.read")(function* (
    input: M.MemoryReadInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeRead(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const current = yield* store.loadAggregate(value.memorySpaceId, value.memoryId);
        if (!current.item) return yield* new Store.MemoryStoreConflict({ code: "not_found" });
        if (current.identity) yield* requireScope(current.identity.scope);
        yield* permit;
        return current.item;
      }),
    );
  });
  const page = Effect.fn("MemoryService.page")(function* (
    input: M.MemoryListInput | M.MemorySearchInput,
    permit: Permit,
  ) {
    yield* permit;
    const scope = input.scope ?? { kind: "user" as const };
    yield* requireScope(scope);
    const scopeKey =
      scope.kind === "user"
        ? "user"
        : scope.kind === "thread"
          ? `thread:${scope.thread.environmentId.length}:${scope.thread.environmentId}:${scope.thread.threadId}`
          : scope.projectKey.kind === "repository"
            ? `repository:${scope.projectKey.groupingKey}`
            : `explicit:${scope.projectKey.sharedProjectId}`;
    const normalizedQuery = "query" in input ? input.query.normalize("NFC").trim() : undefined;
    const binding =
      "query" in input
        ? {
            memorySpaceId: input.memorySpaceId,
            queryDigest: NodeCrypto.createHash("sha256").update(normalizedQuery!).digest("hex"),
            mode: input.mode,
            scopeKey: NodeCrypto.createHash("sha256").update(scopeKey).digest("hex"),
          }
        : undefined;
    const cursor = input.cursor
      ? yield* Effect.try({
          try: () =>
            binding
              ? M.decodeMemorySearchCursor(input.cursor!, binding)
              : M.MemoryId.make(input.cursor!),
          catch: () => new Store.MemoryStoreConflict({ code: "invalid_cursor" }),
        })
      : undefined;
    if ("query" in input) {
      // Commit the bounded recovery batch even when substring is refused until ready.
      const coverage = yield* store.searchCoverage({
        memorySpaceId: input.memorySpaceId,
        scope: input.scope ?? { kind: "user" },
        limit: input.limit,
      });
      if (!coverage.ready) {
        yield* permit;
        if (input.mode === "substring")
          return yield* new Store.MemoryStoreConflict({ code: "unavailable" });
        const rows = yield* query(
          sql<{
            watermark: number;
          }>`SELECT coalesce((SELECT projection_watermark FROM memory_compaction_state WHERE space=${input.memorySpaceId}),0) AS watermark`,
        );
        const watermark = rows[0]!.watermark;
        yield* permit;
        return {
          items: [],
          projectionWatermark: watermark,
          nextCursor: null,
          indexCoverage: {
            status: "unavailable" as const,
            eligibleItems: 0,
            indexedItems: 0,
            unindexedItems: 0,
            projectionWatermark: watermark,
          },
        };
      }
    }
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const filter: Store.MemoryReadFilter = {
          memorySpaceId: input.memorySpaceId,
          scope,
          limit: input.limit,
          ...(cursor ? { afterMemoryId: cursor } : {}),
        };
        const coverage = "query" in input ? yield* store.searchCoverage(filter) : undefined;
        const searched =
          "query" in input && coverage?.ready
            ? yield* store.search(filter, normalizedQuery!, input.mode)
            : undefined;
        if ("query" in input && input.mode === "substring" && !coverage?.ready)
          return yield* new Store.MemoryStoreConflict({ code: "unavailable" });
        let items = "query" in input ? (searched?.items ?? []) : yield* store.list(filter);
        let nextCursor =
          "query" in input
            ? searched && !searched.exhausted && searched.examinedAfterMemoryId
              ? M.encodeMemorySearchCursor(binding!, searched.examinedAfterMemoryId)
              : null
            : items.length === input.limit
              ? (items.at(-1)?.memoryId ?? null)
              : null;
        if (!("query" in input)) {
          let bytes = 2048;
          const bounded: M.MemoryItem[] = [];
          for (const item of items) {
            const encoded = yield* query(encodePageItem(item));
            const size = new TextEncoder().encode(encoded).length + 1;
            if (bytes + size > M.MEMORY_PAGE_MAX_UTF8_BYTES) {
              if (!bounded.length)
                return yield* new Store.MemoryStoreConflict({ code: "payload_too_large" });
              nextCursor = bounded.at(-1)!.memoryId;
              break;
            }
            bytes += size;
            bounded.push(item);
          }
          items = bounded;
        }
        if ("includeQuarantined" in input && !input.includeQuarantined)
          items = items.filter((i) => i.status !== "quarantined");
        const rows = yield* query(
          sql<{
            watermark: number;
          }>`SELECT coalesce((SELECT projection_watermark FROM memory_compaction_state WHERE space=${input.memorySpaceId}),0) AS watermark`,
        );
        const state = {
          watermark: rows[0]!.watermark,
          eligible: coverage?.ready ? coverage.eligible : 0,
          indexed: coverage?.ready
            ? "query" in input && input.mode === "substring"
              ? coverage.eligible
              : coverage.indexed
            : 0,
        };
        yield* permit;
        return yield* decode(
          decodePage(
            {
              items,
              projectionWatermark: state.watermark,
              nextCursor,
              ...("query" in input
                ? {
                    indexCoverage: {
                      status: !coverage?.ready
                        ? "unavailable"
                        : state.eligible === state.indexed
                          ? "available"
                          : state.indexed === 0
                            ? "unavailable"
                            : "partial",
                      eligibleItems: state.eligible,
                      indexedItems: state.indexed,
                      unindexedItems: state.eligible - state.indexed,
                      projectionWatermark: state.watermark,
                    },
                  }
                : {}),
            },
            strict,
          ),
        );
      }),
    );
  });
  const list = (input: M.MemoryListInput, permit: Permit) =>
    decode(decodeList(input, strict)).pipe(Effect.flatMap((v) => page(v, permit)));
  const search = Effect.fn("MemoryService.search")(function* (
    input: M.MemorySearchInput,
    permit: Permit,
  ) {
    // Validate every non-cursor field first, preserving strictness and its error channel.
    const { cursor: _cursor, ...rest } = input;
    yield* decode(decodeSearch(rest, strict));
    const value = yield* decodeSearch(input, strict).pipe(
      Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_cursor" })),
    );
    return yield* page(value, permit);
  });
  const history = Effect.fn("MemoryService.history")(function* (
    input: M.MemoryHistoryInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeHistory(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        const item = yield* read(
          { memorySpaceId: value.memorySpaceId, memoryId: value.memoryId },
          permit,
        );
        const current = yield* store.loadAggregate(value.memorySpaceId, value.memoryId);
        const offset = value.cursor ? Number(value.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          return yield* new Store.MemoryStoreConflict({ code: "invalid_cursor" });
        const visible = item.localAvailability.exposure === "visible";
        const allResolutions = yield* Effect.forEach(current.resolutions, (resolution) =>
          Effect.gen(function* () {
            const revision = current.revisions.find(
              (r) => r.revision.revisionId === resolution.resultRevisionId,
            );
            const op = revision
              ? yield* store.readOperation(value.memorySpaceId, revision.revision.operationId)
              : undefined;
            return {
              resolution,
              payload: visible && op?.kind === "resolve" ? op.resolutionPayload : null,
            };
          }),
        );
        const reportRows = yield* query(
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
          }>`SELECT * FROM memory_report_outbox WHERE space=${value.memorySpaceId} AND memory_id=${value.memoryId} ORDER BY created_at,report_id`,
        );
        const reports = yield* Effect.forEach(reportRows, (row) =>
          Effect.gen(function* () {
            return yield* decode(
              decodeReport(
                {
                  reportId: row.report_id,
                  operationId: row.operation_id,
                  outcome: row.outcome,
                  resolvingEnvironmentId: row.resolving_environment_id,
                  resolutionId: row.resolution_id,
                  state: row.state,
                  ...(row.failure_code ? { failureCode: row.failure_code } : {}),
                  reportThread: row.report_thread_json
                    ? yield* decode(decodeReportThread(row.report_thread_json, strict))
                    : null,
                  sequence: row.delivered_sequence,
                },
                strict,
              ),
            );
          }),
        );
        // One offset covers every history category, so no page exceeds the shared 100-row budget.
        const revisionEnd = current.revisions.length;
        const resolutionEnd = revisionEnd + allResolutions.length;
        const reportEnd = resolutionEnd + reports.length;
        const end = offset + value.limit;
        const revisions = current.revisions
          .slice(offset, end)
          .map((r) => ({ ...r, payload: visible ? r.payload : null }));
        const resolutions = allResolutions.slice(
          Math.max(0, offset - revisionEnd),
          Math.max(0, end - revisionEnd),
        );
        const selectedReports = reports.slice(
          Math.max(0, offset - resolutionEnd),
          Math.max(0, end - resolutionEnd),
        );
        const tombstone =
          current.tombstone && offset <= reportEnd && end > reportEnd ? current.tombstone : null;
        const total = reportEnd + Number(current.tombstone !== undefined);
        yield* permit;
        return yield* decode(
          decodeHistoryPage(
            {
              memoryId: value.memoryId,
              revisions,
              resolutions,
              tombstone,
              reports: selectedReports,
              revertResults: [],
              localAvailability: item.localAvailability,
              nextCursor: end < total ? String(end) : null,
            },
            strict,
          ),
        );
      }),
    );
  });
  const reconnectParked = Effect.fn("MemoryService.reconnectParked")(function* (
    op: M.MemoryOperation,
  ) {
    if (op.kind === "forget") return false;
    return yield* store.transact(
      Effect.gen(function* () {
        const current = yield* store.loadAggregate(op.memorySpaceId, op.memoryId);
        const old = yield* store.receipt(op.memorySpaceId, op.operationId);
        if (!old || !("hubSequence" in old.receipt)) return false;
        const ancestry = yield* store.readAncestry(
          op.memorySpaceId,
          op.memoryId,
          op.revision.parents,
        );
        if (ancestry.parents.some((p) => p.status !== "retained" && p.status !== "compacted"))
          return false;
        const decision = yield* decide(current, op, Store.approvedReplica, old.receipt, ancestry);
        yield* store.reconnectParked(decision, current.generation);
        return !decision.pending;
      }),
    );
  });
  const commitSummary = Effect.fn("MemoryService.commitSummary")(function* (input: SummaryCommit) {
    const generated = yield* decode(decodeSummary(input.generated, strict));
    const work = input.work;
    if (work.metadata.kind !== "summary" || !work.memoryId)
      return yield* new Store.MemoryStoreConflict({ code: "unsupported_operation" });
    const meta = work.metadata;
    if (
      generated.execution.environmentId !== environmentId ||
      generated.execution.providerInstanceId !== meta.modelSelection.instanceId ||
      encodeSelection(generated.execution.requestedModelSelection) !==
        encodeSelection(meta.modelSelection)
    )
      return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
    if (!M.validateMemoryGenerationResult(input.input, generated.result)) return yield* invalid();
    if (scanMemoryValue(generated.result).kind !== "allowed")
      return yield* new Store.MemoryStoreConflict({ code: "secret_detected" });
    return yield* store.transact(
      Effect.gen(function* () {
        const currentWork = yield* store.readWork(work.id);
        if (
          !currentWork ||
          currentWork.status !== "running" ||
          currentWork.claimedBy !== work.claimedBy ||
          currentWork.attempt !== work.attempt ||
          currentWork.claimedUntil !== work.claimedUntil ||
          work.claimedUntil === null ||
          work.claimedUntil <= (yield* Clock.currentTimeMillis)
        )
          return yield* new Store.MemoryStoreConflict({ code: "attempt_expired" });
        yield* input.recheckSource;
        const current = yield* store.loadAggregate(
          M.MemorySpaceId.make(work.space),
          work.memoryId!,
        );
        if (current.tombstone || current.pendingForget)
          return yield* new Store.MemoryStoreConflict({ code: "forgotten" });
        if (encodeHeads(current.heads) !== encodeHeads(input.expectedHeads))
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        // The final input also carries lineage across in-memory generation chunks. Rebuilds
        // without the old summary must not inherit dependencies from the discarded head.
        const payload = yield* decode(
          decodeSummaryPayload(
            {
              text: generated.result.text,
              evidence: generated.result.evidence,
              derivedFromMemoryRevisions: [
                ...new Set(input.input.previousSummary?.derivedFromMemoryRevisions ?? []),
              ],
            },
            strict,
          ),
        );
        yield* validateSummaryDependencies(M.MemorySpaceId.make(work.space), payload).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const execution = generated.execution;
        const receipt = yield* apply(
          {
            protocolVersion: 1,
            kind: "upsert",
            memorySpaceId: M.MemorySpaceId.make(work.space),
            memoryId: work.memoryId!,
            operationId: meta.operationId,
            originEnvironmentId: environmentId,
            expectedHeads: input.expectedHeads,
            payload,
            revision: {
              memorySpaceId: M.MemorySpaceId.make(work.space),
              memoryId: work.memoryId!,
              revisionId: meta.revisionId,
              operationId: meta.operationId,
              parents: input.expectedHeads,
              scope: { kind: "thread", thread: meta.sourceThread },
              payloadRef: meta.revisionId,
              assertionKind: generated.result.assertionKind,
              createdAtUtc: M.MemoryUtcTimestamp.make(
                DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
              ),
              provenance: {
                environmentId,
                providerInstanceId: execution.providerInstanceId,
                provider: execution.effectiveProvider,
                requestedModelSelection: execution.requestedModelSelection,
                effectiveModel: execution.effectiveModel,
                sourceThread: meta.sourceThread,
                sourceWatermark: meta.sourceWatermark,
              },
            },
          },
          Store.localIntent,
          Effect.void,
        );
        if (!(yield* store.completeSummaryWork(work)))
          return yield* new Store.MemoryStoreConflict({ code: "attempt_expired" });
        return receipt;
      }),
    );
  });
  const queueSummary = Effect.fn("MemoryService.queueSummary")(function* (work: Store.MemoryWork) {
    if (
      !["summary", "consolidate"].includes(work.kind) ||
      work.metadata.kind !== "summary" ||
      work.metadata.sourceThread.environmentId !== environmentId
    )
      return yield* new Store.MemoryStoreConflict({ code: "unsupported_operation" });
    yield* store.transact(store.enqueueWork(work));
  });
  const readContextCandidates = Effect.fn("MemoryService.readContextCandidates")(function* (
    input: M.MemoryListInput,
    permit: Permit,
  ) {
    const result = yield* list(input, permit);
    return {
      memorySpaceId: input.memorySpaceId,
      projectionWatermark: result.projectionWatermark,
      nextCursor: result.nextCursor,
      items: result.items.flatMap((i) =>
        i.status === "active" && i.localAvailability.exposure === "visible"
          ? [
              {
                memoryId: i.memoryId,
                revisionId: i.revision.revisionId,
                scope: i.scope,
                provenance: i.revision.provenance,
                assertionKind: i.revision.assertionKind,
                text: i.payload.text,
              },
            ]
          : [],
      ),
    };
  });
  const readContextRevisions = Effect.fn("MemoryService.readContextRevisions")(function* (
    space: M.MemorySpaceId,
    ids: ReadonlyArray<M.MemoryId>,
    permit: Permit,
  ) {
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        if (ids.length > M.MEMORY_PAGE_MAX_ITEMS)
          return yield* new Store.MemoryStoreConflict({ code: "payload_too_large" });
        const items = yield* Effect.forEach(ids, (memoryId) =>
          read({ memorySpaceId: space, memoryId }, permit),
        );
        const rows = yield* query(
          sql<{
            watermark: number;
          }>`SELECT projection_watermark AS watermark FROM memory_compaction_state WHERE space=${space}`,
        );
        yield* permit;
        return {
          memorySpaceId: space,
          projectionWatermark: rows[0]?.watermark ?? 0,
          nextCursor: null,
          items: items.flatMap((i) =>
            i.status === "active" && i.localAvailability.exposure === "visible"
              ? [
                  {
                    memoryId: i.memoryId,
                    revisionId: i.revision.revisionId,
                    scope: i.scope,
                    provenance: i.revision.provenance,
                    assertionKind: i.revision.assertionKind,
                    text: i.payload.text,
                  },
                ]
              : [],
          ),
        };
      }),
    );
  });
  const sourceLocator = Effect.fn("MemoryService.sourceLocator")(function* (
    input: M.MemoryReadSourceInput,
  ) {
    const aggregate = yield* store.loadAggregate(input.memorySpaceId, input.memoryId);
    if (aggregate.tombstone || aggregate.pendingForget)
      return yield* new Store.MemoryStoreConflict({ code: "forgotten" });
    if (!aggregate.item || aggregate.item.localAvailability.exposure !== "visible")
      return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
    const thread = yield* decode(encodeSourceThread(input.sourceThread));
    for (const pair of aggregate.revisions) {
      const provenance = pair.revision.provenance;
      if (
        !aggregate.heads.includes(pair.revision.revisionId) ||
        !pair.payload ||
        !provenance.sourceThread ||
        !provenance.sourceWatermark
      )
        continue;
      if ((yield* decode(encodeSourceThread(provenance.sourceThread))) !== thread) continue;
      const evidence = new Set(
        pair.payload.evidence
          .filter(
            (value) =>
              value.origin === "thread" &&
              value.sourceThread?.environmentId === input.sourceThread.environmentId &&
              value.sourceThread.threadId === input.sourceThread.threadId &&
              value.watermark?.fromEventId === provenance.sourceWatermark?.fromEventId &&
              value.watermark?.toEventId === provenance.sourceWatermark?.toEventId &&
              value.watermark?.throughSequence === provenance.sourceWatermark?.throughSequence,
          )
          .flatMap((value) => value.messageIds),
      );
      if (input.messageIds.every((id) => evidence.has(id)))
        return { generation: aggregate.generation, sourceWatermark: provenance.sourceWatermark };
    }
    return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
  });
  const prepareSourceRead: MemoryService["Service"]["prepareSourceRead"] = Effect.fn(
    "MemoryService.prepareSourceRead",
  )(function* (input, permit) {
    const value = yield* decode(decodeReadSource(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const locator = yield* sourceLocator(value);
        const encoded = yield* decode(encodeReadSource(value));
        return {
          generation: locator.generation,
          request: {
            ...value,
            protocolVersion: 1 as const,
            sourceWatermark: locator.sourceWatermark,
            requestId: M.MemorySourceReadRequestId.make(
              memoryStableUuid(`${environmentId}:${locator.generation}:${encoded}`),
            ),
            authorizedScopes: ["memory:read", "orchestration:read"] as const,
          },
        };
      }),
    );
  });
  const validateSourceOutcome: MemoryService["Service"]["validateSourceOutcome"] = Effect.fn(
    "MemoryService.validateSourceOutcome",
  )(function* (input, permit) {
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const request = yield* decode(decodeSourceRequest(input.request.request, strict));
        const outcome = yield* decode(decodeSourceOutcome(input.outcome, strict));
        // Owner denial is authoritative after the live permit, even if the locator changed.
        if (outcome.kind === "denied") return outcome;
        const { memorySpaceId, memoryId, sourceThread, messageIds, limit, cursor } = request;
        const locator = yield* sourceLocator({
          memorySpaceId,
          memoryId,
          sourceThread,
          messageIds,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (
          locator.generation !== input.request.generation ||
          (yield* decode(encodeSourceWatermark(locator.sourceWatermark))) !==
            (yield* decode(encodeSourceWatermark(request.sourceWatermark)))
        )
          return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
        if (outcome.kind === "available") {
          if (
            (yield* decode(encodeSourceThread(outcome.page.sourceThread))) !==
              (yield* decode(encodeSourceThread(request.sourceThread))) ||
            (yield* decode(encodeSourceWatermark(outcome.page.watermark))) !==
              (yield* decode(encodeSourceWatermark(request.sourceWatermark))) ||
            outcome.page.messages.length > request.limit ||
            outcome.page.messages.some((message) => !request.messageIds.includes(message.messageId))
          )
            return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
          if (scanMemoryValue(outcome).kind !== "allowed")
            return { kind: "unavailable" as const, code: "secret_detected" as const };
        }
        return outcome;
      }),
    );
  });
  const readSource: MemoryService["Service"]["readSource"] = Effect.fn("MemoryService.readSource")(
    function* (input, permit) {
      yield* permit;
      // L5 binds Sync's existing authority seam; production remains closed without that port.
      if (!sourceReadAuthority) return yield* new MemoryAccessError({ code: "unavailable" });
      const request = yield* prepareSourceRead(input, permit);
      yield* permit;
      const outcome = yield* sourceReadAuthority(request, permit).pipe(
        Effect.catchTags({
          MemoryHubError: (error) =>
            Effect.gen(function* () {
              if (error.code === "capacity_exceeded" && error.capacity) {
                const { dimension, current, limit, reclaimable } = error.capacity;
                return yield* new Store.MemoryCapacityError({
                  dimension,
                  current,
                  limit,
                  reclaimable,
                });
              }
              return yield* new Store.MemoryStoreConflict({
                code: isFailureCode(error.code) ? error.code : "source_unavailable",
              });
            }),
        }),
      );
      yield* permit;
      const validated = yield* validateSourceOutcome({ request, outcome }, permit);
      yield* permit;
      if (validated.kind === "available") return validated.page;
      if (validated.kind === "denied") return yield* new MemoryAccessError({ code: "unavailable" });
      return yield* new Store.MemoryStoreConflict({ code: validated.code });
    },
  );
  const admitHubOperationTx: MemoryService["Service"]["admitHubOperationTx"] = Effect.fn(
    "MemoryService.admitHubOperationTx",
  )(function* (input) {
    // These effects require the outer Store transaction and run after its SQL write lock.
    yield* input.authority.reauthorize;
    const member = yield* store.requireHubMemberTx(input.authority.principal);
    const now = yield* input.authority.now;
    const op = yield* decode(decodeOperation(input.operation, strict));
    if (
      op.memorySpaceId !== member.memorySpaceId ||
      op.originEnvironmentId !== member.environmentId
    )
      return yield* new M.MemoryHubForbiddenError({});
    const digest = memoryOperationDigest(op);
    const replay = yield* store.readHubReceiptTx(op.memorySpaceId, op.operationId);
    if (replay) {
      if (replay.entry.receipt.operationDigest !== digest)
        return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
      return replay.entry.receipt;
    }
    const current = yield* store.loadAggregate(op.memorySpaceId, op.memoryId);
    // Only the read-only semantic decision is caught; every subsequent write can fail the outer transaction.
    const prepared = yield* Effect.gen(function* () {
      if (op.kind !== "forget" && current.pendingForget)
        return yield* new Store.MemoryStoreConflict({ code: "forget_pending" });
      let approval: M.MemoryResolutionApproval | undefined;
      if (op.kind === "resolve") {
        if (!input.resolutionRequest)
          return yield* new M.MemoryHubError({ code: "lease_required" });
        const request = yield* decode(decodeResolutionRequest(input.resolutionRequest, strict));
        const lease = current.fence?.activeLease;
        if (
          request.memorySpaceId !== op.memorySpaceId ||
          request.holderEnvironmentId !== member.environmentId ||
          M.encodeMemoryOperation(request.operation) !== M.encodeMemoryOperation(op)
        )
          return yield* new M.MemoryHubError({ code: "identity_mismatch" });
        if (!lease) return yield* new M.MemoryHubError({ code: "lease_required" });
        if (
          lease.attemptId !== request.attemptId ||
          lease.holderEnvironmentId !== member.environmentId ||
          lease.fencingToken !== op.fencingToken ||
          current.fence?.highestFencingToken !== op.fencingToken
        )
          return yield* new M.MemoryHubError({ code: "fenced" });
        if (
          Date.parse(lease.expiresAtHubTime) <= now ||
          Date.parse(lease.attemptDeadlineHubTime) <= now
        )
          return yield* new M.MemoryHubError({ code: "lease_expired" });
        if (
          encodeSelection(lease.frozenDefaultModelSelection) !==
            encodeSelection(op.resolution.requestedModelSelection) ||
          op.resolution.resolvingEnvironmentId !== member.environmentId
        )
          return yield* new M.MemoryHubError({ code: "identity_mismatch" });
        const iso = (value: number) =>
          M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(value)));
        approval = {
          resolutionId: op.resolution.resolutionId,
          appliedAtUtc: iso(now),
          revertDeadlineUtc: iso(now + M.MEMORY_REVERT_WINDOW_MS),
        };
      } else if (input.resolutionRequest)
        return yield* new M.MemoryHubError({ code: "identity_mismatch" });
      const ancestry =
        op.kind === "forget"
          ? undefined
          : yield* store.readAncestry(op.memorySpaceId, op.memoryId, op.revision.parents);
      const decision = yield* Effect.try({
        try: () =>
          decideMemoryOperation(
            current,
            op,
            Store.hubAdmission,
            scanMemoryValue(op),
            undefined,
            ancestry,
            now,
          ),
        catch: (cause) => (isConflict(cause) ? cause : invalid()),
      });
      return { kind: "decision" as const, decision, approval };
    }).pipe(
      Effect.catchTags({
        MemoryHubError: (error) =>
          Effect.succeed({ kind: "refusal" as const, failureCode: error.code }),
        MemoryStoreConflict: (error) =>
          Effect.succeed({ kind: "refusal" as const, failureCode: error.code }),
      }),
    );
    if (prepared.kind === "refusal") {
      if (prepared.failureCode === "capacity_exceeded")
        return yield* new Store.MemoryStoreConflict({ code: "capacity_exceeded" });
      const ledger = yield* store.appendHubEntryTx({
        operation: op,
        operationDigest: digest,
        outcome: "rejected",
        failureCode: prepared.failureCode,
        now,
      });
      yield* settleHubEntryTx({
        memorySpaceId: op.memorySpaceId,
        hubEnvironmentId: environmentId,
        localEnvironmentId: environmentId,
        entry: ledger.entry,
      });
      return ledger.entry.receipt;
    }
    const { decision, approval } = prepared;
    return yield* quota.withAdmission(
      { operation: op, admission: Store.hubAdmission, environmentId, receipt: decision.receipt },
      Effect.gen(function* () {
        const ledger = yield* store.appendHubEntryTx({
          operation: op,
          operationDigest: digest,
          outcome: decision.receipt.outcome === "noop" ? "accepted" : decision.receipt.outcome,
          ...(approval ? { resolutionApproval: approval } : {}),
          now,
        });
        yield* store.apply({
          ...decision,
          receipt: ledger.entry.receipt,
          ...(op.kind === "resolve"
            ? {
                execution: {
                  requestedModelSelection: op.resolution.requestedModelSelection,
                  effectiveProvider: op.resolution.effectiveProvider,
                  effectiveModel: op.resolution.effectiveModel,
                  providerInstanceId: op.resolution.requestedModelSelection.instanceId,
                  environmentId: member.environmentId,
                },
              }
            : {}),
        });
        if (current.fence?.activeLease)
          yield* store.transitionHubLeaseTx({
            authority: input.authority,
            action: {
              kind: "invalidate",
              memoryId: op.memoryId,
              expectedToken: current.fence.highestFencingToken,
              reason: op.kind === "forget" ? "forget" : "heads",
            },
          });
        // Hub-local work receives the same terminal settlement as an ACK or pulled entry.
        yield* settleHubEntryTx({
          memorySpaceId: op.memorySpaceId,
          hubEnvironmentId: environmentId,
          localEnvironmentId: environmentId,
          entry: ledger.entry,
        });
        return ledger.entry.receipt;
      }),
    );
  });
  // Transport entry: owns the rollback boundary. Tx callers must propagate capacity failures.
  const admitHubOperation: MemoryService["Service"]["admitHubOperation"] = (input) =>
    store.transact(admitHubOperationTx(input), { requireOuter: true }).pipe(
      Effect.catchTags({
        MemoryCapacityError: (error) =>
          store.transact(
            Effect.gen(function* () {
              // The failed append/apply has rolled back before this separate authorization/replay read.
              yield* input.authority.reauthorize;
              const member = yield* store.requireHubMemberTx(input.authority.principal);
              if (
                input.operation.memorySpaceId !== member.memorySpaceId ||
                input.operation.originEnvironmentId !== member.environmentId
              )
                return yield* new M.MemoryHubForbiddenError({});
              const digest = memoryOperationDigest(input.operation);
              const replay = yield* store.readHubReceiptTx(
                input.operation.memorySpaceId,
                input.operation.operationId,
              );
              if (replay) {
                if (replay.entry.receipt.operationDigest !== digest)
                  return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
                return replay.entry.receipt;
              }
              return yield* decode(
                decodeHubReceipt(
                  {
                    operationId: input.operation.operationId,
                    memoryId: input.operation.memoryId,
                    operationDigest: digest,
                    outcome: "rejected" as const,
                    hubSequence: null,
                    failureCode: "capacity_exceeded" as const,
                    capacity: {
                      code: "capacity_exceeded" as const,
                      dimension: error.dimension,
                      current: error.current ?? error.limit,
                      limit: error.limit,
                      reclaimable: 0,
                    },
                  },
                  strict,
                ),
              );
            }),
          ),
      }),
    );
  const settleHubEntryTx: MemoryService["Service"]["settleHubEntryTx"] = Effect.fn(
    "MemoryService.settleHubEntryTx",
  )(function* (input) {
    const entry = yield* decode(decodeHubEntry(input.entry, strict));
    if (
      entry.kind === "operation" &&
      (entry.operation.memorySpaceId !== input.memorySpaceId ||
        memoryOperationDigest(entry.operation) !== entry.receipt.operationDigest)
    )
      return yield* invalid();
    const old = yield* store.receipt(input.memorySpaceId, entry.receipt.operationId);
    if (old && old.operationDigest !== entry.receipt.operationDigest)
      return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
    if (
      old &&
      "hubSequence" in old.receipt &&
      old.receipt.hubSequence !== null &&
      (yield* decode(encodeHubReceipt(old.receipt))) !==
        (yield* decode(
          encodeHubReceipt({
            ...entry.receipt,
            ...(old.receipt.forgetExpansion
              ? { forgetExpansion: old.receipt.forgetExpansion }
              : {}),
            ...(old.receipt.forgetRetryOf ? { forgetRetryOf: old.receipt.forgetRetryOf } : {}),
          }),
        ))
    )
      return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
    const incorporated =
      entry.receipt.outcome !== "rejected" &&
      (!old || !("hubSequence" in old.receipt) || old.receipt.hubSequence === null);
    if (entry.kind === "operation")
      yield* apply(entry.operation, Store.approvedReplica, Effect.void, entry.receipt);
    else yield* store.settleMetadataEntryTx({ memorySpaceId: input.memorySpaceId, entry });
    if (entry.kind === "metadata" && entry.compactReceipt)
      yield* store.reconcileResolutionReportTx({
        record: entry.compactReceipt,
        localEnvironmentId: input.localEnvironmentId,
      });
    const workId = input.workId ?? `sync:${input.memorySpaceId}:${entry.receipt.operationId}`;
    const work =
      (yield* store.readWork(workId)) ??
      (input.workId
        ? undefined
        : yield* store.readWork(`revert:${input.memorySpaceId}:${entry.receipt.operationId}`));
    if (
      work &&
      "operationId" in work.metadata &&
      work.metadata.operationId === entry.receipt.operationId
    )
      yield* store.acknowledgeOutbox(work.id, entry.receipt);
    return {
      receipt: entry.receipt,
      incorporated,
      intent:
        work?.kind === "revert_intent"
          ? entry.receipt.outcome === "rejected"
            ? "rejected"
            : "completed"
          : "none",
    };
  });
  const receiveHubPage: MemoryService["Service"]["receiveHubPage"] = Effect.fn(
    "MemoryService.receiveHubPage",
  )(function* (input) {
    const page = yield* decode(decodeHubPage(input.page, strict));
    if (page.checkpoint)
      return yield* new Store.MemoryStoreConflict({ code: "bootstrap_required" });
    let previous = input.expectedSequence;
    for (const entry of page.entries) {
      if (entry.hubSequence <= previous || entry.hubSequence > page.throughSequence)
        return yield* new Store.MemoryStoreConflict({ code: "invalid_cursor" });
      previous = entry.hubSequence;
    }
    if (previous !== page.throughSequence || page.throughSequence < input.expectedSequence)
      return yield* new Store.MemoryStoreConflict({ code: "invalid_cursor" });
    return yield* store.transact(
      Effect.gen(function* () {
        yield* input.reauthorize;
        const current = yield* store.readCursor(input.memorySpaceId, input.hubEnvironmentId);
        if (current >= page.throughSequence) return [];
        return yield* store.withReceivedCursor(
          {
            memorySpaceId: input.memorySpaceId,
            hubEnvironmentId: input.hubEnvironmentId,
            expectedSequence: input.expectedSequence,
            afterSequence: page.throughSequence,
          },
          Effect.forEach(page.entries, (entry) => settleHubEntryTx({ ...input, entry })),
        );
      }),
    );
  });
  const reconcileResolutionSubmission: MemoryService["Service"]["reconcileResolutionSubmission"] =
    Effect.fn("MemoryService.reconcileResolutionSubmission")(function* (input) {
      return yield* store.transact(
        Effect.gen(function* () {
          yield* input.reauthorize;
          const result = yield* store.reconcileResolutionSubmissionTx(input);
          if (!result || result.outcome !== "admitted") return result;
          const operation = result.row.submission!.operation;
          yield* settleHubEntryTx({
            memorySpaceId: input.ownership.memorySpaceId,
            hubEnvironmentId: input.hubEnvironmentId,
            localEnvironmentId: input.localEnvironmentId,
            entry: {
              kind: "operation",
              operation,
              receipt: result.receipt,
              hubSequence: result.receipt.hubSequence!,
            },
          });
          yield* input.reauthorize;
          const row = yield* store.transitionResolutionTicketTx({
            ownership: { ...input.ownership, version: result.row.version },
            now: input.now,
            nextState: "terminal",
            ownedUntil: null,
            nextAttemptAt: input.now,
          });
          if (!row) return yield* new Store.MemoryStoreConflict({ code: "fenced" });
          return { ...result, row };
        }),
      );
    });
  const settleHubAcknowledgement: MemoryService["Service"]["settleHubAcknowledgement"] = Effect.fn(
    "MemoryService.settleHubAcknowledgement",
  )(function* (input) {
    const receipt = yield* decode(decodeHubReceipt(input.receipt, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* input.reauthorize;
        const work = yield* store.readWork(input.workId);
        if (
          !work ||
          work.space !== input.memorySpaceId ||
          !("operationId" in work.metadata) ||
          work.metadata.operationId !== input.operation.operationId ||
          receipt.operationId !== input.operation.operationId ||
          receipt.operationDigest !== input.operation.operationDigest ||
          work.memoryId !== receipt.memoryId
        )
          return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
        const stored = yield* store.receipt(input.memorySpaceId, input.operation.operationId);
        const operation = yield* store.readWorkOperation(input.workId);
        if (
          (stored && stored.operationDigest !== input.operation.operationDigest) ||
          (operation && memoryOperationDigest(operation) !== input.operation.operationDigest)
        )
          return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
        if (!stored && !operation)
          return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
        if (receipt.hubSequence === null) {
          if (receipt.outcome !== "rejected") return yield* invalid();
          yield* store.acknowledgeOutbox(input.workId, receipt);
          return {
            receipt,
            incorporated: false,
            intent: work.kind === "revert_intent" ? ("rejected" as const) : ("none" as const),
          };
        }
        if (
          !M.validateMemoryResolutionApproval(
            work.metadata.kind === "resolve" ? "resolve" : (operation?.kind ?? "upsert"),
            operation?.kind === "resolve"
              ? operation.resolution.resolutionId
              : work.metadata.kind === "resolve"
                ? work.metadata.resolution?.resolutionId
                : null,
            receipt,
          )
        )
          return yield* new Store.MemoryStoreConflict({ code: "unsupported_protocol" });
        if (operation)
          return yield* settleHubEntryTx({
            ...input,
            entry: { kind: "operation", operation, receipt, hubSequence: receipt.hubSequence },
          });
        if (!("protocolVersion" in work.metadata)) return yield* invalid();
        const meta = work.metadata;
        const resolutionId =
          meta.kind === "resolve"
            ? meta.resolution?.resolutionId
            : meta.kind === "revert"
              ? meta.revertsResolutionId
              : null;
        const compactReceipt: M.MemoryCompactReceipt = {
          memorySpaceId: input.memorySpaceId,
          originEnvironmentId: meta.originEnvironmentId,
          operationKind: meta.kind,
          receipt,
          revisionId:
            receipt.outcome === "rejected" || meta.kind === "forget"
              ? null
              : (meta.revision?.revisionId ?? null),
          resolutionId: resolutionId ?? null,
          revertsResolutionId: meta.kind === "revert" ? (resolutionId ?? null) : null,
          attemptId: meta.kind === "resolve" ? meta.operationId : null,
          fencingToken: meta.kind === "resolve" ? (meta.fencingToken ?? null) : null,
          reportGuard:
            resolutionId && receipt.outcome !== "rejected"
              ? {
                  reportId: Store.resolutionReportId(
                    input.memorySpaceId,
                    meta.operationId,
                    resolutionId,
                  ),
                  resolvingEnvironmentId: meta.originEnvironmentId,
                  resolutionId,
                  outcome: meta.kind === "resolve" ? "resolved" : "reverted",
                }
              : null,
        };
        return yield* settleHubEntryTx({
          ...input,
          entry: {
            kind: "metadata",
            operationKind: work.metadata.kind,
            compactReceipt,
            ...(meta.revision ? { revision: meta.revision } : {}),
            memoryId: receipt.memoryId,
            receipt,
            hubSequence: receipt.hubSequence,
            ...(work.metadata.kind === "resolve" && work.metadata.resolution
              ? { resolutionId: work.metadata.resolution.resolutionId }
              : {}),
          },
        });
      }),
    );
  });
  return MemoryService.of({
    commitLocalIntent,
    readSource,
    prepareSourceRead,
    validateSourceOutcome,
    admitHubOperation,
    admitHubOperationTx,
    settleHubEntryTx,
    receiveHubPage,
    reconcileResolutionSubmission,
    settleHubAcknowledgement,
    getProjectBinding,
    updateProjectBinding,
    resolveProjectKey,
    changes,
    upsert,
    forget,
    retryForgetExpansion,
    revertResolution,
    read,
    list,
    search,
    history,
    commitSummary,
    queueSummary,
    reconnectParked,
    applyReceived: (op, receipt) => apply(op, Store.approvedReplica, Effect.void, receipt),
    commitAcceptedResolution: (op, receipt) =>
      apply(op, Store.approvedReplica, Effect.void, receipt),
    queueResolution: store.persistResolutionTicket,
    recoverWork: store.dueWork,
    pendingReports: store.pendingReports,
    claimReport: store.claimReport,
    acknowledgeReport: store.acknowledgeReport,
    failReport: store.failReport,
    readContextCandidates,
    readContextRevisions,
  });
});
export const layer = Layer.effect(MemoryService, make());
/** Bind an application-owned callback, without importing Sync or constructing a cyclic layer. */
export const layerWithSourceReadAuthority = (authority: MemorySourceReadAuthority["readSource"]) =>
  Layer.effect(MemoryService, make(authority));
