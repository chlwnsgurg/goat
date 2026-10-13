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
export class MemoryService extends Context.Service<
  MemoryService,
  {
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
const decodeHistoryPage = Schema.decodeUnknownEffect(M.MemoryHistoryPage);
const isConflict = Schema.is(Store.MemoryStoreConflict);
const invalid = () => new Store.MemoryStoreConflict({ code: "invalid_output" });
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
export const memoryStableUuid = (text: string) => {
  const h = hash(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const decode = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(invalid));
const make = Effect.gen(function* () {
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
    return yield* store
      .transact(
        Effect.gen(function* () {
          yield* permit;
          const old = yield* store.receipt(op.memorySpaceId, op.operationId);
          if (old) {
            if (old.operationDigest !== digest)
              return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
            return old;
          }
          const current = yield* store.loadAggregate(op.memorySpaceId, op.memoryId);
          if (admission.kind !== "approvedReplica" && current.pendingForget && op.kind !== "forget")
            return yield* new Store.MemoryStoreConflict({ code: "forget_pending" });
          let ancestry: Store.MemoryAncestry | undefined;
          if (op.kind !== "forget") {
            if (admission.kind !== "approvedReplica") yield* requireScope(op.revision.scope);
            ancestry = yield* store.readAncestry(
              op.memorySpaceId,
              op.memoryId,
              op.revision.parents,
            );
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
      )
      .pipe(Effect.tap(() => store.wake));
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
        if (now >= Date.parse(resolution.revertDeadlineUtc))
          return { ...result, status: "revert_expired" as const };
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
        return current.item;
      }),
    );
  });
  const page = Effect.fn("MemoryService.page")(function* (
    input: M.MemoryListInput | M.MemorySearchInput,
    permit: Permit,
  ) {
    return yield* store.transact(
      Effect.gen(function* () {
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
        const cursor = input.cursor
          ? yield* decode(Effect.try({ try: () => M.MemoryId.make(input.cursor!), catch: invalid }))
          : undefined;
        const filter: Store.MemoryReadFilter = {
          memorySpaceId: input.memorySpaceId,
          scope,
          limit: input.limit,
          ...(cursor ? { afterMemoryId: cursor } : {}),
        };
        let items =
          "query" in input
            ? yield* store.search(filter, input.query, input.mode)
            : yield* store.list(filter);
        const last = items.at(-1)?.memoryId;
        const nextCursor = items.length === input.limit ? (last ?? null) : null;
        if ("includeQuarantined" in input && !input.includeQuarantined)
          items = items.filter((i) => i.status !== "quarantined");
        const rows = yield* query(sql<{
          watermark: number;
          eligible: number;
          indexed: number;
        }>`SELECT
        coalesce((SELECT projection_watermark FROM memory_compaction_state WHERE space=${input.memorySpaceId}),0) AS watermark,
        count(CASE WHEN status='active' THEN 1 END) AS eligible,
        count(CASE WHEN status='active' AND index_state='ready' AND indexed_generation=generation THEN 1 END) AS indexed
        FROM memory_items WHERE space=${input.memorySpaceId} AND scope_key=${scopeKey}`);
        const state = rows[0]!;
        if ("query" in input && input.mode === "substring") state.indexed = state.eligible;
        return yield* decode(
          decodePage(
            {
              items,
              projectionWatermark: state.watermark,
              nextCursor,
              ...("query" in input
                ? {
                    indexCoverage: {
                      status:
                        state.eligible === state.indexed
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
  const search = (input: M.MemorySearchInput, permit: Permit) =>
    decode(decodeSearch(input, strict)).pipe(Effect.flatMap((v) => page(v, permit)));
  const history = Effect.fn("MemoryService.history")(function* (
    input: M.MemoryHistoryInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeHistory(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        const item = yield* read(value, permit);
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
            payload: {
              text: generated.result.text,
              evidence: generated.result.evidence,
              derivedFromMemoryRevisions: [],
            },
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
    yield* store.enqueueWork(work);
    yield* store.wake;
  });
  const readContextCandidates = Effect.fn("MemoryService.readContextCandidates")(function* (
    input: M.MemoryListInput,
    permit: Permit,
  ) {
    const result = yield* list(input, permit);
    return {
      memorySpaceId: input.memorySpaceId,
      projectionWatermark: result.projectionWatermark,
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
        return {
          memorySpaceId: space,
          projectionWatermark: rows[0]?.watermark ?? 0,
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
  return MemoryService.of({
    getProjectBinding,
    updateProjectBinding,
    resolveProjectKey,
    changes,
    upsert,
    forget,
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
export const layer = Layer.effect(MemoryService, make);
