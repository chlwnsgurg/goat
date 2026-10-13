import * as M from "@goat/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@goat/shared/DrainableWorker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import { MEMORY_SCANNER_POLICY_VERSION, scanMemoryValue } from "./MemorySecretScanner.ts";

export class MemoryWorkerError extends Schema.TaggedError<MemoryWorkerError>()(
  "MemoryWorkerError",
  { code: M.MemoryFailureCode, cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message() {
    return "Memory work failed.";
  }
}
export class MemoryWorker extends Context.Service<
  MemoryWorker,
  {
    readonly start: () => Effect.Effect<void, MemoryWorkerError, Scope.Scope>;
    readonly drain: Effect.Effect<void, MemoryWorkerError>;
    readonly sweepDue: () => Effect.Effect<void, MemoryWorkerError>;
    readonly execute: (work: Store.MemoryWork) => Effect.Effect<void, MemoryWorkerError>;
  }
>()("goat/memory/MemoryWorker") {}
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(M.OrchestrationV2RunJson));
const decodeSelection = Schema.decodeUnknownEffect(M.MemoryModelSelection);
const decodeInput = Schema.decodeUnknownEffect(M.GenerateMemorySummaryInput);
const strict = { onExcessProperty: "error" } as const;
const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
export const memoryRetryDelay = (attempt: number) =>
  [5000, 30000, 120000][Math.max(0, attempt - 1)] ?? 600000;
const isFailureCode = Schema.is(M.MemoryFailureCode);
const safeCode = (error: unknown): M.MemoryFailureCode => {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && isFailureCode(error.code)) return error.code;
    if ("_tag" in error && error._tag === "TextGenerationError") {
      // Only exact public enum codes may cross the provider's diagnostic boundary.
      if ("detail" in error && isFailureCode(error.detail)) return error.detail;
      return "generation_failed";
    }
  }
  return "storage_failed";
};
const workerError = (cause: unknown) => new MemoryWorkerError({ code: safeCode(cause), cause });
const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const service = yield* Service.MemoryService;
  const maintenance = yield* Maintenance.MemoryFtsMaintenance;
  const settings = yield* Settings.ServerSettingsService;
  const generation = yield* Generation.TextGeneration;
  const events = yield* Events.EventSinkV2;
  const identity = yield* Environment.ServerEnvironmentIdentity;
  const runtime = yield* RuntimeIdentity.RuntimeIdentity;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* identity.getEnvironmentId;
  const sweepLock = yield* Semaphore.make(1);
  const started = yield* Ref.make(false);
  const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(workerError));
  const readSource = Effect.fn("MemoryWorker.readSource")(function* (work: Store.MemoryWork) {
    if (
      work.metadata.kind !== "summary" ||
      work.metadata.sourceThread.environmentId !== environmentId
    )
      return yield* new MemoryWorkerError({ code: "identity_mismatch" });
    const meta = work.metadata;
    return yield* store
      .transact(
        Effect.gen(function* () {
          const thread = yield* query(
            sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=${meta.sourceThread.threadId} AND deleted_at IS NULL`,
          );
          if (!thread.length) return yield* new MemoryWorkerError({ code: "source_invalidated" });
          const newer = yield* query(
            sql`SELECT 1 FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${meta.sourceThread.threadId} AND sequence>${meta.sourceWatermark.throughSequence} AND (event_type='thread.deleted' OR event_type='message.updated' OR (event_type='run.updated' AND json_extract(payload_json,'$.status') IN ('completed','failed','interrupted','cancelled','rolled_back'))) LIMIT 1`,
          );
          if (newer.length) return yield* new MemoryWorkerError({ code: "source_invalidated" });
          const rows = yield* query(sql<{
            payload_json: string;
            sequence: number;
          }>`SELECT e.payload_json,e.sequence FROM orchestration_events e
        WHERE e.application_event_version=2 AND e.aggregate_kind='thread' AND e.stream_id=${meta.sourceThread.threadId} AND e.event_type='message.updated'
        AND e.sequence<=${meta.sourceWatermark.throughSequence}
        AND NOT EXISTS (SELECT 1 FROM orchestration_events n WHERE n.application_event_version=2 AND n.aggregate_kind='thread' AND n.stream_id=e.stream_id AND n.event_type='message.updated' AND json_extract(n.payload_json,'$.id')=json_extract(e.payload_json,'$.id') AND n.sequence>e.sequence AND n.sequence<=${meta.sourceWatermark.throughSequence})
        ORDER BY e.sequence LIMIT 101`);
          if (rows.length > 100)
            return yield* new MemoryWorkerError({ code: "generation_input_too_large" });
          const messages: M.GenerateMemorySummaryInput["messages"][number][] = [];
          const excluded = yield* store.readSuppressions(
            M.MemorySpaceId.make(
              work.space.startsWith("_local:") ? Service.memoryStableUuid(work.space) : work.space,
            ),
            meta.memoryId,
          );
          const exclusions = new Set(
            excluded.flatMap((r) =>
              r.kind === "sourceExclusion" &&
              r.exclusion.sourceThread.environmentId === environmentId &&
              r.exclusion.sourceThread.threadId === meta.sourceThread.threadId
                ? r.exclusion.messageIds
                : [],
            ),
          );
          for (const row of rows) {
            const message = yield* query(decodeMessage(row.payload_json));
            if (
              message.streaming ||
              !message.text.trim() ||
              message.role === "system" ||
              exclusions.has(message.id)
            )
              continue;
            let status: string | undefined;
            if (message.runId) {
              const runs = yield* query(
                sql<{
                  payload_json: string;
                }>`SELECT payload_json FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${meta.sourceThread.threadId} AND event_type IN ('run.created','run.updated') AND json_extract(payload_json,'$.id')=${message.runId} AND sequence<=${meta.sourceWatermark.throughSequence} ORDER BY sequence DESC LIMIT 1`,
              );
              status = runs[0] ? (yield* query(decodeRun(runs[0].payload_json))).status : undefined;
            }
            if (status === "rolled_back") continue;
            if (message.role === "assistant" && status !== "completed") continue;
            if (message.role === "user" || status === "completed")
              messages.push({ messageId: message.id, text: message.text, completed: true });
          }
          if (!messages.length) return yield* new MemoryWorkerError({ code: "source_invalidated" });
          if (scanMemoryValue({ messages }).kind !== "allowed")
            return yield* new MemoryWorkerError({ code: "secret_detected" });
          return messages;
        }),
      )
      .pipe(Effect.mapError(workerError));
  });
  const catchUp = Effect.fn("MemoryWorker.catchUp")(function* () {
    const watermark = yield* store.readThreadHookWatermark();
    const rows = yield* query(
      sql<{
        sequence: number;
        event_id: string;
        stream_id: string;
        event_type: string;
        payload_json: string;
        occurred_at: string;
      }>`SELECT sequence,event_id,stream_id,event_type,payload_json,occurred_at FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND sequence>${watermark} ORDER BY sequence LIMIT 100`,
    );
    if (!rows.length) return;
    const snapshot = yield* query(settings.getSettings);
    const modelSelection = yield* query(decodeSelection(snapshot.defaultModelSelection, strict));
    const space = snapshot.memoryHub.mode === "disabled" ? null : snapshot.memoryHub.memorySpaceId;
    const work: Store.MemoryWork[] = [];
    yield* store
      .transact(
        Effect.gen(function* () {
          for (const row of rows) {
            const thread = { environmentId, threadId: M.ThreadId.make(row.stream_id) };
            if (row.event_type === "thread.deleted") {
              yield* store.cancelThreadWork(thread);
              yield* store
                .forgetLocalIntent(environmentId, `${environmentId}:${row.stream_id}:summary`)
                .pipe(
                  Effect.catchTags({
                    MemoryStoreConflict: (error) =>
                      error.code === "space_mismatch" ? Effect.void : Effect.fail(error),
                  }),
                );
              for (let index = work.length - 1; index >= 0; index--) {
                const queued = work[index]?.metadata;
                if (queued?.kind === "summary" && queued.sourceThread.threadId === thread.threadId)
                  work.splice(index, 1);
              }
              continue;
            }
            if (row.event_type !== "run.updated") continue;
            const run = yield* query(decodeRun(row.payload_json));
            if (run.status === "rolled_back") {
              yield* store.cancelThreadWork(thread);
              continue;
            }
            if (!terminal.has(run.status)) continue;
            const source = yield* query(
              sql<{
                event_id: string;
                occurred_at: string;
                sequence: number;
              }>`SELECT event_id,occurred_at,sequence FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${row.stream_id} AND event_type='message.updated' AND sequence<=${row.sequence} ORDER BY sequence LIMIT 1`,
            );
            if (!source[0]) continue;
            const key = `${environmentId}:${row.stream_id}`;
            const memoryId = M.MemoryId.make(Service.memoryStableUuid(`${key}:summary`));
            const latest = yield* query(sql<{
              watermark: number;
              consolidated: number | null;
            }>`SELECT max(CASE WHEN status='completed' THEN json_extract(metadata_json,'$.sourceWatermark.throughSequence') END) AS watermark,
          max(CASE WHEN kind='consolidate' AND status='completed' THEN json_extract(metadata_json,'$.sourceWatermark.throughSequence') END) AS consolidated FROM memory_outbox WHERE kind IN ('summary','consolidate') AND json_extract(metadata_json,'$.sourceThread.environmentId')=${environmentId} AND json_extract(metadata_json,'$.sourceThread.threadId')=${row.stream_id}`);
            const delta = yield* query(
              sql`SELECT 1 FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${row.stream_id} AND event_type='message.updated' AND sequence>${latest[0]?.watermark ?? 0} AND sequence<=${row.sequence} LIMIT 1`,
            );
            if (!delta.length) continue;
            const lastConsolidated = latest[0]?.consolidated;
            const baseline = lastConsolidated
              ? yield* query(
                  sql<{
                    occurred_at: string;
                  }>`SELECT occurred_at FROM orchestration_events WHERE sequence=${lastConsolidated}`,
                )
              : [];
            const mode =
              Date.parse(row.occurred_at) -
                Date.parse(baseline[0]?.occurred_at ?? source[0].occurred_at) >=
              86400000
                ? ("consolidate" as const)
                : ("summary" as const);
            const workId = `${key}:${row.sequence}:v1:${mode}`;
            work.push({
              id: workId,
              space: space ?? `_local:${environmentId}`,
              memoryId,
              kind: mode,
              status: "pending",
              payloadRef: null,
              attempt: 0,
              nextAttemptAt: 0,
              claimedBy: null,
              claimedUntil: null,
              metadata: {
                kind: "summary",
                sourceThread: thread,
                sourceWatermark: {
                  fromEventId: M.EventId.make(source[0].event_id),
                  toEventId: M.EventId.make(row.event_id),
                  throughSequence: row.sequence,
                },
                memoryId,
                operationId: M.MemoryOperationId.make(
                  Service.memoryStableUuid(`${workId}:operation`),
                ),
                revisionId: M.MemoryRevisionId.make(Service.memoryStableUuid(`${workId}:revision`)),
                modelSelection,
              },
            });
          }
          yield* store.commitThreadHook({
            expectedWatermark: watermark,
            throughWatermark: rows.at(-1)!.sequence,
            work,
          });
        }),
      )
      .pipe(Effect.mapError(workerError));
  });
  const execute = Effect.fn("MemoryWorker.execute")(function* (work: Store.MemoryWork) {
    if (
      !["summary", "consolidate", "rebuild"].includes(work.kind) ||
      work.metadata.kind === "threadHook"
    )
      return yield* new MemoryWorkerError({ code: "unsupported_operation" });
    if (work.claimedBy !== runtime.instanceId || work.status !== "running")
      return yield* new MemoryWorkerError({ code: "attempt_expired" });
    const run = Effect.gen(function* () {
      if (work.kind === "rebuild") {
        if (work.metadata.kind !== "rebuild" || !work.memoryId || !work.metadata.revisionId)
          return yield* new MemoryWorkerError({ code: "unsupported_operation" });
        const metadata = work.metadata;
        yield* store.transact(
          Effect.gen(function* () {
            const owner = yield* store.readWork(work.id);
            if (
              owner?.status !== "running" ||
              owner.claimedBy !== work.claimedBy ||
              owner.attempt !== work.attempt ||
              owner.claimedUntil === null ||
              owner.claimedUntil <= (yield* Clock.currentTimeMillis)
            )
              return yield* new MemoryWorkerError({ code: "attempt_expired" });
            const current = yield* store.loadAggregate(
              M.MemorySpaceId.make(work.space),
              work.memoryId!,
            );
            if (current.tombstone || current.generation !== metadata.generation) {
              yield* store.finishWork(work.id, "cancelled");
              return;
            }
            const repaired = yield* maintenance.repair({
              memorySpaceId: M.MemorySpaceId.make(work.space),
              memoryId: work.memoryId!,
              revisionId: metadata.revisionId!,
              generation: metadata.generation,
            });
            if (repaired) yield* store.finishWork(work.id, "completed");
            else
              yield* store.retryWork(
                work,
                (yield* Clock.currentTimeMillis) + memoryRetryDelay(work.attempt),
              );
          }),
        );
        return;
      }
      if (work.metadata.kind !== "summary" || !work.memoryId)
        return yield* new MemoryWorkerError({ code: "unsupported_operation" });
      const meta = work.metadata;
      const source = yield* readSource(work);
      const existingReceipt = work.space.startsWith("_local:")
        ? undefined
        : yield* store.receipt(M.MemorySpaceId.make(work.space), meta.operationId);
      if (existingReceipt) {
        yield* store.completeSummaryWork(work);
        return;
      }
      const current = work.space.startsWith("_local:")
        ? undefined
        : yield* store.loadAggregate(M.MemorySpaceId.make(work.space), work.memoryId);
      if (current?.tombstone || current?.pendingForget)
        return yield* new MemoryWorkerError({ code: "forgotten" });
      const generated = yield* Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "memory-generation-" });
          const input = yield* query(
            decodeInput(
              {
                cwd,
                sourceThread: meta.sourceThread,
                sourceWatermark: meta.sourceWatermark,
                messages: source,
                modelSelection: meta.modelSelection,
              },
              strict,
            ),
          );
          if (!generation.generateMemorySummary)
            return yield* new MemoryWorkerError({ code: "unsupported_operation" });
          const output = yield* generation
            .generateMemorySummary(input)
            .pipe(
              Effect.mapError((cause) => new MemoryWorkerError({ code: safeCode(cause), cause })),
            );
          if (!M.validateMemoryGenerationResult(input, output.result))
            return yield* new MemoryWorkerError({ code: "invalid_output" });
          if (scanMemoryValue(output.result).kind !== "allowed")
            return yield* new MemoryWorkerError({ code: "secret_detected" });
          return { input, output };
        }),
      );
      if (work.space.startsWith("_local:")) {
        if (
          generated.output.execution.environmentId !== environmentId ||
          generated.output.execution.providerInstanceId !== meta.modelSelection.instanceId
        )
          return yield* new MemoryWorkerError({ code: "identity_mismatch" });
        yield* store.transact(
          Effect.gen(function* () {
            yield* readSource(work);
            const owner = yield* store.readWork(work.id);
            if (
              owner?.status !== "running" ||
              owner.claimedBy !== work.claimedBy ||
              owner.attempt !== work.attempt ||
              owner.claimedUntil === null ||
              owner.claimedUntil <= (yield* Clock.currentTimeMillis)
            )
              return yield* new MemoryWorkerError({ code: "attempt_expired" });
            const execution = generated.output.execution;
            yield* store.refreshLocalSummaryIntent({
              intentId: `${environmentId}:${meta.sourceThread.threadId}:summary`,
              memoryId: work.memoryId!,
              environmentId,
              scope: { kind: "thread", thread: meta.sourceThread },
              assertionKind: generated.output.result.assertionKind,
              createdAtUtc: M.MemoryUtcTimestamp.make(
                DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
              ),
              payload: {
                text: generated.output.result.text,
                evidence: generated.output.result.evidence,
                derivedFromMemoryRevisions: [],
              },
              provenance: {
                environmentId,
                sourceThread: meta.sourceThread,
                sourceWatermark: meta.sourceWatermark,
                providerInstanceId: execution.providerInstanceId,
                provider: execution.effectiveProvider,
                requestedModelSelection: execution.requestedModelSelection,
                effectiveModel: execution.effectiveModel,
              },
            });
            if (!(yield* store.completeSummaryWork(work)))
              return yield* new MemoryWorkerError({ code: "attempt_expired" });
          }),
        );
      } else
        yield* service.commitSummary({
          work,
          input: generated.input,
          generated: generated.output,
          expectedHeads: current!.heads,
          recheckSource: readSource(work).pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new Store.MemoryStoreConflict({ code: cause.code })),
          ),
        });
    });
    yield* run
      .pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const code = safeCode(error);
            if (
              code === "source_invalidated" ||
              code === "forgotten" ||
              code === "revision_changed"
            ) {
              yield* store.transact(
                Effect.gen(function* () {
                  const current = yield* store.readWork(work.id);
                  if (
                    current?.status === "running" &&
                    current.claimedBy === work.claimedBy &&
                    current.attempt === work.attempt
                  )
                    yield* store.finishWork(work.id, "cancelled");
                }),
              );
              return;
            }
            const now = yield* Clock.currentTimeMillis;
            if (work.metadata.kind === "summary")
              yield* store.failGenerationAttempt({
                work,
                environmentId,
                failureCode: code,
                now,
                retryAt: [
                  "generation_failed",
                  "unavailable",
                  "route_unavailable",
                  "storage_failed",
                ].includes(code)
                  ? now + memoryRetryDelay(work.attempt)
                  : null,
              });
            else yield* store.retryWork(work, now + memoryRetryDelay(work.attempt));
          }),
        ),
      )
      .pipe(Effect.mapError(workerError));
  });
  const deferred = Effect.fn("MemoryWorker.deferred")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* store.recoverDeferred(MEMORY_SCANNER_POLICY_VERSION, now);
    for (const target of yield* store.readDeferred(now, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)) {
      if (!(yield* store.claimDeferred(target, runtime.instanceId, now, now + 600000))) continue;
      const process = Effect.gen(function* () {
        const current = yield* store.loadAggregate(target.memorySpaceId, target.memoryId);
        if (current.tombstone || current.generation !== target.generation) return;
        if (target.kind === "scanner") {
          const resolutionPayloads = yield* Effect.forEach(current.resolutions, (resolution) =>
            Effect.gen(function* () {
              const revision = current.revisions.find(
                (r) => r.revision.revisionId === resolution.resultRevisionId,
              );
              const op = revision
                ? yield* store.readOperation(target.memorySpaceId, revision.revision.operationId)
                : undefined;
              return op?.kind === "resolve" ? op.resolutionPayload : null;
            }),
          );
          const scan = scanMemoryValue({
            payloads: current.revisions.map((r) => r.payload),
            originals: resolutionPayloads,
          });
          yield* store.finishOwnedDeferred(target, runtime.instanceId, now + 600000, {
            now,
            scannerPolicyVersion: MEMORY_SCANNER_POLICY_VERSION,
            ...(scan.kind === "blocked"
              ? { failure: "secret_detected", ruleIds: scan.ruleIds }
              : {}),
          });
        } else if (target.kind === "index" && target.revisionId) {
          const repaired = yield* maintenance.repair({
            memorySpaceId: target.memorySpaceId,
            memoryId: target.memoryId,
            revisionId: target.revisionId,
            generation: target.generation,
          });
          yield* store.finishOwnedDeferred(target, runtime.instanceId, now + 600000, {
            now,
            ...(!repaired ? { failure: "index_unavailable" as const } : {}),
          });
        } else if (target.kind === "cleanup") {
          yield* store.cleanupDerived(M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
          yield* store.finishOwnedDeferred(target, runtime.instanceId, now + 600000, { now });
        } else
          yield* store.finishOwnedDeferred(target, runtime.instanceId, now + 600000, {
            now,
            failure: target.reason ?? "dependency_invalidated",
          });
      });
      yield* process.pipe(
        Effect.catch(() =>
          store
            .finishOwnedDeferred(target, runtime.instanceId, now + 600000, {
              now,
              failure: target.reason ?? "dependency_invalidated",
            })
            .pipe(Effect.asVoid),
        ),
      );
    }
    for (const op of yield* store.readParked(100))
      yield* service.reconnectParked(op).pipe(Effect.catch(() => Effect.succeed(false)));
    for (const pending of yield* store.pendingForgetIntents(100)) {
      const aggregate = yield* store.loadAggregate(pending.memorySpaceId, pending.memoryId);
      if (aggregate.tombstone) {
        yield* store.settleForgetIntent(pending.memorySpaceId, pending.memoryId);
        continue;
      }
      if (pending.submissionState === "uncertain") continue;
      const operationId =
        pending.submissionState === "rejected"
          ? M.MemoryOperationId.make(
              Service.memoryStableUuid(`${pending.operationId}:${pending.attempts}:retry`),
            )
          : pending.operationId;
      yield* service
        .forget(
          {
            memorySpaceId: pending.memorySpaceId,
            memoryId: pending.memoryId,
            operationId,
            expectedHeads: aggregate.heads,
          },
          Effect.void,
        )
        .pipe(Effect.catch(() => Effect.void));
    }
  });
  const sweepDue = Effect.fn("MemoryWorker.sweepDue")(
    function* () {
      yield* catchUp();
      yield* deferred();
      const now = yield* Clock.currentTimeMillis;
      for (const candidate of yield* store.dueWork(now, 100)) {
        if (!["summary", "consolidate", "rebuild"].includes(candidate.kind)) continue;
        if (!(yield* store.claimWork(candidate.id, runtime.instanceId, now, now + 600000)))
          continue;
        const work = yield* store.readWork(candidate.id);
        if (work) yield* execute(work);
      }
      yield* maintenance.cycle(environmentId);
    },
    Effect.mapError(workerError),
    sweepLock.withPermits(1),
  );
  const queue = yield* Ref.make<DrainableWorker<void> | undefined>(undefined);
  const start = Effect.fn("MemoryWorker.start")(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    const queued = yield* Ref.make(false);
    const worker = yield* makeDrainableWorker<void, never, never>(() =>
      Ref.set(queued, false).pipe(
        Effect.andThen(sweepDue()),
        Effect.catch((error) => Effect.logWarning("Memory sweep deferred", { code: error.code })),
      ),
    );
    const wake = Ref.getAndSet(queued, true).pipe(
      Effect.flatMap((already) => (already ? Effect.void : worker.enqueue(undefined))),
    );
    yield* Ref.set(queue, worker);
    yield* Effect.addFinalizer(() =>
      Ref.set(started, false).pipe(Effect.andThen(Ref.set(queue, undefined))),
    );
    const wakes = yield* store.subscribeWake;
    yield* Stream.runForEach(wakes, () => wake).pipe(Effect.forkScoped);
    yield* events.stream({ afterSequence: yield* store.readThreadHookWatermark() }).pipe(
      Stream.runForEach(() => wake),
      Effect.catch(() => Effect.void),
      Effect.forkScoped,
    );
    yield* wake;
    yield* wake.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
  }, Effect.mapError(workerError));
  const drain = Effect.gen(function* () {
    const worker = yield* Ref.get(queue);
    if (worker) {
      yield* worker.enqueue(undefined);
      yield* worker.drain;
    } else yield* sweepDue();
  });
  return MemoryWorker.of({ start, drain, sweepDue, execute });
});
export const layer = Layer.effect(MemoryWorker, make);
