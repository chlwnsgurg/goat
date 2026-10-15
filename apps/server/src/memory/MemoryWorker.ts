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
  {
    code: M.MemoryFailureCode,
    stage: Schema.optionalKey(
      Schema.Literals([
        "catch-up",
        "deferred",
        "due-work",
        "claim-work",
        "read-work",
        "execute",
        "maintenance",
      ]),
    ),
    cause: Schema.optionalKey(Schema.Defect()),
  },
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
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(M.MessageId)));
const encodeGenerationMessage = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      messageId: M.MessageId,
      text: Schema.String,
      completed: Schema.Boolean,
    }),
  ),
);
const strict = { onExcessProperty: "error" } as const;
const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
export const memoryRetryDelay = (attempt: number) =>
  [5000, 30000, 120000][Math.max(0, attempt - 1)] ?? 600000;
// Internal ownership deadline for local work rows; this is not the hub resolution lease.
const workClaimMs = 600000;
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
const isWorkerError = Schema.is(MemoryWorkerError);
const workerError = (cause: unknown) =>
  isWorkerError(cause) ? cause : new MemoryWorkerError({ code: safeCode(cause), cause });
const sweepStage = <A, E>(
  stage: NonNullable<MemoryWorkerError["stage"]>,
  effect: Effect.Effect<A, E>,
) =>
  effect.pipe(
    Effect.mapError((cause) => new MemoryWorkerError({ code: safeCode(cause), stage, cause })),
  );
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
            sql`SELECT 1 FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${meta.sourceThread.threadId} AND sequence>${meta.observedThroughSequence ?? meta.sourceWatermark.throughSequence} AND (event_type='thread.deleted' OR event_type='message.updated' OR (event_type='run.updated' AND json_extract(payload_json,'$.status') IN ('completed','failed','interrupted','cancelled','rolled_back'))) LIMIT 1`,
          );
          if (newer.length) return yield* new MemoryWorkerError({ code: "source_invalidated" });
          const excluded = yield* store.readSuppressions(
            M.MemorySpaceId.make(
              work.space.startsWith("_local:") ? Service.memoryStableUuid(work.space) : work.space,
            ),
            meta.memoryId,
          );
          const exclusions = excluded.flatMap((r) =>
            r.kind === "sourceExclusion" &&
            r.exclusion.sourceThread.environmentId === environmentId &&
            r.exclusion.sourceThread.threadId === meta.sourceThread.threadId
              ? r.exclusion.messageIds
              : [],
          );
          // Filter eligibility before the bound; historical updates and skipped messages cannot fill a chunk.
          const rows = yield* query(sql<{
            payload_json: string;
            sequence: number;
            event_id: string;
          }>`
            SELECT e.payload_json,e.sequence,e.event_id FROM orchestration_events e
            WHERE e.application_event_version=2 AND e.aggregate_kind='thread' AND e.stream_id=${meta.sourceThread.threadId}
            AND e.event_type='message.updated' AND e.sequence>${meta.fromSequence ?? 0} AND e.sequence<=${meta.sourceWatermark.throughSequence}
            AND coalesce(json_extract(e.payload_json,'$.streaming'),0)=0 AND trim(json_extract(e.payload_json,'$.text'))!=''
            AND json_extract(e.payload_json,'$.role') IN ('user','assistant')
            AND json_extract(e.payload_json,'$.id') NOT IN (SELECT value FROM json_each(${yield* query(encodeIds(exclusions))}))
            AND NOT EXISTS (SELECT 1 FROM orchestration_events n WHERE n.application_event_version=2 AND n.aggregate_kind='thread' AND n.stream_id=e.stream_id AND n.event_type='message.updated' AND json_extract(n.payload_json,'$.id')=json_extract(e.payload_json,'$.id') AND n.sequence>e.sequence AND n.sequence<=${meta.observedThroughSequence ?? meta.sourceWatermark.throughSequence})
            AND (CASE WHEN json_extract(e.payload_json,'$.runId') IS NULL THEN '' ELSE coalesce((SELECT json_extract(r.payload_json,'$.status') FROM orchestration_events r WHERE r.application_event_version=2 AND r.aggregate_kind='thread' AND r.stream_id=e.stream_id AND r.event_type IN ('run.created','run.updated') AND json_extract(r.payload_json,'$.id')=json_extract(e.payload_json,'$.runId') AND r.sequence<=${meta.observedThroughSequence ?? meta.sourceWatermark.throughSequence} ORDER BY r.sequence DESC LIMIT 1),'') END)!='rolled_back'
            AND (json_extract(e.payload_json,'$.role')='user' OR (SELECT json_extract(r.payload_json,'$.status') FROM orchestration_events r WHERE r.application_event_version=2 AND r.aggregate_kind='thread' AND r.stream_id=e.stream_id AND r.event_type IN ('run.created','run.updated') AND json_extract(r.payload_json,'$.id')=json_extract(e.payload_json,'$.runId') AND r.sequence<=${meta.observedThroughSequence ?? meta.sourceWatermark.throughSequence} ORDER BY r.sequence DESC LIMIT 1)='completed')
            ORDER BY e.sequence LIMIT 101`);
          const messages: M.GenerateMemorySummaryInput["messages"][number][] = [];
          let bytes = 0;
          let last = rows[0];
          for (const row of rows) {
            const message = yield* query(decodeMessage(row.payload_json));
            const input = { messageId: message.id, text: message.text, completed: true };
            const size = new TextEncoder().encode(
              yield* query(encodeGenerationMessage(input)),
            ).length;
            if (messages.length === 100 || bytes + size > 180000) break;
            messages.push(input);
            bytes += size;
            last = row;
          }
          if (!messages.length) return yield* new MemoryWorkerError({ code: "source_invalidated" });
          if (scanMemoryValue({ messages }).kind !== "allowed")
            return yield* new MemoryWorkerError({ code: "secret_detected" });
          return {
            messages,
            watermark:
              messages.length < rows.length && last
                ? {
                    ...meta.sourceWatermark,
                    fromEventId: M.EventId.make(rows[0]!.event_id),
                    toEventId: M.EventId.make(last.event_id),
                    throughSequence: last.sequence,
                  }
                : { ...meta.sourceWatermark, fromEventId: M.EventId.make(rows[0]!.event_id) },
          };
        }),
      )
      .pipe(Effect.mapError(workerError));
  });
  const summaryEvidenceValid = Effect.fn("MemoryWorker.summaryEvidenceValid")(function* (
    work: Store.MemoryWork,
    payload: M.MemoryPayload,
  ) {
    if (work.metadata.kind !== "summary") return false;
    const meta = work.metadata;
    const records = yield* store.readSuppressions(
      M.MemorySpaceId.make(
        work.space.startsWith("_local:") ? Service.memoryStableUuid(work.space) : work.space,
      ),
      meta.memoryId,
    );
    for (const evidence of payload.evidence) {
      if (evidence.origin === "model") continue;
      if (
        !evidence.sourceThread ||
        !evidence.watermark ||
        evidence.sourceThread.environmentId !== environmentId ||
        evidence.sourceThread.threadId !== meta.sourceThread.threadId
      )
        return false;
      const ids = [...new Set(evidence.messageIds)];
      if (
        records.some(
          (r) =>
            r.kind === "sourceExclusion" &&
            r.exclusion.sourceThread.environmentId === environmentId &&
            r.exclusion.sourceThread.threadId === meta.sourceThread.threadId &&
            r.exclusion.messageIds.some((id) => ids.includes(id)),
        )
      )
        return false;
      const eligible = yield* query(sql<{ count: number }>`
        SELECT count(*) AS count FROM orchestration_events e
        WHERE e.application_event_version=2 AND e.aggregate_kind='thread' AND e.stream_id=${meta.sourceThread.threadId}
        AND e.event_type='message.updated' AND e.sequence<=${evidence.watermark.throughSequence}
        AND json_extract(e.payload_json,'$.id') IN (SELECT value FROM json_each(${yield* query(encodeIds(ids))}))
        AND coalesce(json_extract(e.payload_json,'$.streaming'),0)=0 AND trim(json_extract(e.payload_json,'$.text'))!=''
        AND json_extract(e.payload_json,'$.role') IN ('user','assistant')
        AND NOT EXISTS (SELECT 1 FROM orchestration_events n WHERE n.application_event_version=2 AND n.aggregate_kind='thread' AND n.stream_id=e.stream_id AND n.event_type='message.updated' AND json_extract(n.payload_json,'$.id')=json_extract(e.payload_json,'$.id') AND n.sequence>e.sequence)
        AND (CASE WHEN json_extract(e.payload_json,'$.runId') IS NULL THEN '' ELSE coalesce((SELECT json_extract(r.payload_json,'$.status') FROM orchestration_events r WHERE r.application_event_version=2 AND r.aggregate_kind='thread' AND r.stream_id=e.stream_id AND r.event_type IN ('run.created','run.updated') AND json_extract(r.payload_json,'$.id')=json_extract(e.payload_json,'$.runId') ORDER BY r.sequence DESC LIMIT 1),'') END)!='rolled_back'
        AND (json_extract(e.payload_json,'$.role')='user' OR (SELECT json_extract(r.payload_json,'$.status') FROM orchestration_events r WHERE r.application_event_version=2 AND r.aggregate_kind='thread' AND r.stream_id=e.stream_id AND r.event_type IN ('run.created','run.updated') AND json_extract(r.payload_json,'$.id')=json_extract(e.payload_json,'$.runId') ORDER BY r.sequence DESC LIMIT 1)='completed')`);
      if (eligible[0]?.count !== ids.length) return false;
    }
    return payload.evidence.some((e) => e.origin !== "model" && e.messageIds.length > 0);
  });
  const catchUp = Effect.fn("MemoryWorker.catchUp")(function* () {
    const now = yield* Clock.currentTimeMillis;
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
    const continuations = yield* query(sql<(typeof rows)[number]>`
      SELECT e.sequence,e.event_id,e.stream_id,e.event_type,e.payload_json,e.occurred_at FROM orchestration_events e
      JOIN orchestration_v2_projection_threads t ON t.thread_id=e.stream_id AND t.deleted_at IS NULL
      WHERE e.application_event_version=2 AND e.aggregate_kind='thread' AND e.event_type='run.updated'
      AND json_extract(e.payload_json,'$.status') IN ('completed','failed','interrupted','cancelled') AND e.sequence<=${watermark}
      AND NOT EXISTS (SELECT 1 FROM orchestration_events n WHERE n.application_event_version=2 AND n.aggregate_kind='thread' AND n.stream_id=e.stream_id AND n.event_type='run.updated' AND n.sequence>e.sequence)
      AND (EXISTS (SELECT 1 FROM orchestration_events m WHERE m.application_event_version=2 AND m.aggregate_kind='thread' AND m.stream_id=e.stream_id AND m.event_type='message.updated' AND m.sequence<=e.sequence AND m.sequence>coalesce((SELECT max(json_extract(o.metadata_json,'$.sourceWatermark.throughSequence')) FROM memory_outbox o WHERE o.kind IN ('summary','consolidate') AND o.status='completed' AND json_extract(o.metadata_json,'$.sourceThread.environmentId')=${environmentId} AND json_extract(o.metadata_json,'$.sourceThread.threadId')=e.stream_id),0)) OR (
      EXISTS (SELECT 1 FROM orchestration_events m WHERE m.application_event_version=2 AND m.aggregate_kind='thread' AND m.stream_id=e.stream_id AND m.event_type='message.updated' AND m.sequence<=e.sequence AND m.sequence>coalesce((SELECT max(json_extract(o.metadata_json,'$.sourceWatermark.throughSequence')) FROM memory_outbox o WHERE o.kind='consolidate' AND o.status='completed' AND json_extract(o.metadata_json,'$.sourceThread.environmentId')=${environmentId} AND json_extract(o.metadata_json,'$.sourceThread.threadId')=e.stream_id),0))
      AND ${now}-coalesce((SELECT max(json_extract(o.metadata_json,'$.completedAt')) FROM memory_outbox o WHERE o.kind='consolidate' AND o.status='completed' AND json_extract(o.metadata_json,'$.sourceThread.environmentId')=${environmentId} AND json_extract(o.metadata_json,'$.sourceThread.threadId')=e.stream_id AND json_extract(o.metadata_json,'$.sourceWatermark.throughSequence')>=coalesce(json_extract(o.metadata_json,'$.observedThroughSequence'),0)),(SELECT min(CAST((julianday(m.occurred_at)-2440587.5)*86400000 AS INTEGER)) FROM orchestration_events m WHERE m.application_event_version=2 AND m.aggregate_kind='thread' AND m.stream_id=e.stream_id AND m.event_type='message.updated'))>=86400000))
      AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.kind IN ('summary','consolidate') AND o.status IN ('pending','running','retry','failed') AND json_extract(o.metadata_json,'$.sourceThread.environmentId')=${environmentId} AND json_extract(o.metadata_json,'$.sourceThread.threadId')=e.stream_id AND coalesce(json_extract(o.metadata_json,'$.observedThroughSequence'),json_extract(o.metadata_json,'$.sourceWatermark.throughSequence'))=e.sequence)
      ORDER BY e.sequence LIMIT 100`);
    if (!rows.length && !continuations.length) return;
    const snapshot = yield* query(settings.getSettings);
    const modelSelection =
      snapshot.defaultModelSelection === null
        ? null
        : yield* query(decodeSelection(snapshot.defaultModelSelection, strict));
    const space = snapshot.memoryHub.mode === "disabled" ? null : snapshot.memoryHub.memorySpaceId;
    const work: Store.MemoryWork[] = [];
    yield* store
      .transact(
        Effect.gen(function* () {
          for (const row of [...rows, ...continuations]) {
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
            // A fresh install has no default model. Still process deletion/rollback and
            // advance the hook; continuations recover these summaries once a model is set.
            if (modelSelection === null) continue;
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
              consolidated_at: number | null;
            }>`SELECT max(CASE WHEN status='completed' THEN json_extract(metadata_json,'$.sourceWatermark.throughSequence') END) AS watermark,
          max(CASE WHEN kind='consolidate' AND status='completed' THEN json_extract(metadata_json,'$.sourceWatermark.throughSequence') END) AS consolidated,
          max(CASE WHEN kind='consolidate' AND status='completed' AND json_extract(metadata_json,'$.sourceWatermark.throughSequence')>=coalesce(json_extract(metadata_json,'$.observedThroughSequence'),0) THEN json_extract(metadata_json,'$.completedAt') END) AS consolidated_at FROM memory_outbox WHERE kind IN ('summary','consolidate') AND json_extract(metadata_json,'$.sourceThread.environmentId')=${environmentId} AND json_extract(metadata_json,'$.sourceThread.threadId')=${row.stream_id}`);
            const mode =
              now - (latest[0]?.consolidated_at ?? Date.parse(source[0].occurred_at)) >= 86400000
                ? ("consolidate" as const)
                : ("summary" as const);
            // Extraction and consolidation consume independent source ranges.
            const fromSequence =
              mode === "consolidate" ? (latest[0]?.consolidated ?? 0) : (latest[0]?.watermark ?? 0);
            const delta = yield* query(
              sql`SELECT 1 FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${row.stream_id} AND event_type='message.updated' AND sequence>${fromSequence} AND sequence<=${row.sequence} LIMIT 1`,
            );
            if (!delta.length) continue;
            const workId = `${key}:${row.sequence}:v1:${mode}`;
            const candidate: Store.MemoryWork = {
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
                fromSequence,
                observedThroughSequence: row.sequence,
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
            };
            const chunk = yield* readSource(candidate).pipe(
              Effect.catchTags({
                MemoryWorkerError: (error) =>
                  error.code === "source_invalidated"
                    ? Effect.succeed(null)
                    : Effect.succeed({
                        messages: [],
                        // Persist a work item so execute owns failure reporting and retry policy.
                        watermark: {
                          fromEventId: M.EventId.make(source[0]!.event_id),
                          toEventId: M.EventId.make(row.event_id),
                          throughSequence: row.sequence,
                        },
                      }),
              }),
            );
            if (!chunk || candidate.metadata.kind !== "summary") continue;
            const chunkId = `${workId}:chunk:${chunk.watermark.throughSequence}`;
            work.push({
              ...candidate,
              id: chunkId,
              metadata: {
                ...candidate.metadata,
                sourceWatermark: chunk.watermark,
                operationId: M.MemoryOperationId.make(
                  Service.memoryStableUuid(`${chunkId}:operation`),
                ),
                revisionId: M.MemoryRevisionId.make(
                  Service.memoryStableUuid(`${chunkId}:revision`),
                ),
              },
            });
          }
          yield* store.commitThreadHook({
            expectedWatermark: watermark,
            throughWatermark: rows.at(-1)?.sequence ?? watermark,
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
    // A summary can span several provider calls. Each call starts under a renewed claim,
    // and the latest claim snapshot is what commit and failure handling compare against.
    let owned = work;
    const renewClaim = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const renewed = yield* store.renewWork(owned, now, now + workClaimMs);
      if (!renewed) return yield* new MemoryWorkerError({ code: "attempt_expired" });
      owned = renewed;
    });
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
      let source = yield* readSource(work);
      const existingReceipt = work.space.startsWith("_local:")
        ? undefined
        : yield* store.receipt(M.MemorySpaceId.make(work.space), meta.operationId);
      if (existingReceipt) {
        yield* store.completeSummaryWork(owned);
        return;
      }
      const current = work.space.startsWith("_local:")
        ? undefined
        : yield* store.loadAggregate(M.MemorySpaceId.make(work.space), work.memoryId);
      if (current?.tombstone || current?.pendingForget)
        return yield* new MemoryWorkerError({ code: "forgotten" });
      // Reserve input space for the bounded previous payload, including its evidence.
      let previousSummary = work.space.startsWith("_local:")
        ? yield* store.readLocalSummaryPayload(
            environmentId,
            `${environmentId}:${meta.sourceThread.threadId}:summary`,
          )
        : (current?.revisions.find(
            (pair) => current.heads.length === 1 && current.heads[0] === pair.revision.revisionId,
          )?.payload ?? undefined);
      if (previousSummary && scanMemoryValue(previousSummary).kind !== "allowed")
        return yield* new MemoryWorkerError({ code: "secret_detected" });
      let sourceWork = work;
      if (previousSummary && !(yield* summaryEvidenceValid(work, previousSummary))) {
        previousSummary = undefined;
        sourceWork = { ...work, metadata: { ...meta, fromSequence: 0 } };
        source = yield* readSource(sourceWork);
      }
      const recheckSource = Effect.gen(function* () {
        yield* readSource(work);
        if (previousSummary && !(yield* summaryEvidenceValid(work, previousSummary)))
          return yield* new MemoryWorkerError({ code: "source_invalidated" });
      });
      const generated = yield* Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "memory-generation-" });
          while (true) {
            const input = yield* query(
              decodeInput(
                {
                  cwd,
                  sourceThread: meta.sourceThread,
                  sourceWatermark: source.watermark,
                  messages: source.messages,
                  ...(previousSummary ? { previousSummary } : {}),
                  modelSelection: meta.modelSelection,
                },
                strict,
              ),
            );
            if (!generation.generateMemorySummary)
              return yield* new MemoryWorkerError({ code: "unsupported_operation" });
            yield* renewClaim;
            const output = yield* generation
              .generateMemorySummary(input)
              .pipe(
                Effect.mapError((cause) => new MemoryWorkerError({ code: safeCode(cause), cause })),
              );
            if (!M.validateMemoryGenerationResult(input, output.result))
              return yield* new MemoryWorkerError({ code: "invalid_output" });
            if (scanMemoryValue(output.result).kind !== "allowed")
              return yield* new MemoryWorkerError({ code: "secret_detected" });
            if (source.watermark.throughSequence >= meta.sourceWatermark.throughSequence)
              return { input, output };
            previousSummary = {
              text: output.result.text,
              evidence: output.result.evidence,
              derivedFromMemoryRevisions: [],
            };
            sourceWork = {
              ...work,
              metadata: { ...meta, fromSequence: source.watermark.throughSequence },
            };
            source = yield* readSource(sourceWork);
          }
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
            yield* recheckSource;
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
            if (!(yield* store.completeSummaryWork(owned)))
              return yield* new MemoryWorkerError({ code: "attempt_expired" });
          }),
        );
      } else
        yield* service.commitSummary({
          work: owned,
          input: generated.input,
          generated: generated.output,
          expectedHeads: current!.heads,
          recheckSource: recheckSource.pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new Store.MemoryStoreConflict({ code: safeCode(cause) })),
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
            if (work.metadata.kind === "summary") {
              const recorded = yield* store.failGenerationAttempt({
                work: owned,
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
              // A lapsed claim cannot record a report, but while no one reclaimed the row it
              // still gets a backoff instead of being picked up again immediately.
              if (!recorded) yield* store.retryWork(owned, now + memoryRetryDelay(work.attempt));
            } else yield* store.retryWork(owned, now + memoryRetryDelay(work.attempt));
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
        if (target.kind === "scanner") {
          const chunk = yield* store.readScannerChunk(target);
          const scan = scanMemoryValue({ payloads: chunk.payloads });
          yield* store.finishOwnedDeferred(target, runtime.instanceId, now + 600000, {
            now,
            scannerPolicyVersion: MEMORY_SCANNER_POLICY_VERSION,
            ...(scan.kind === "allowed" && chunk.nextCursor
              ? { scannerCursor: chunk.nextCursor }
              : {}),
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
      if (
        aggregate.tombstone &&
        pending.submissionState === "rejected" &&
        pending.operationDigest
      ) {
        yield* service.retryForgetExpansion(pending).pipe(Effect.catch(() => Effect.void));
        continue;
      }
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
      yield* sweepStage("catch-up", catchUp());
      yield* sweepStage("deferred", deferred());
      const now = yield* Clock.currentTimeMillis;
      for (const candidate of yield* sweepStage("due-work", store.dueWork(now, 100))) {
        if (!["summary", "consolidate", "rebuild"].includes(candidate.kind)) continue;
        if (
          !(yield* sweepStage(
            "claim-work",
            store.claimWork(candidate.id, runtime.instanceId, now, now + workClaimMs),
          ))
        )
          continue;
        const work = yield* sweepStage("read-work", store.readWork(candidate.id));
        if (work) yield* sweepStage("execute", execute(work));
      }
      yield* sweepStage("maintenance", maintenance.cycle(environmentId));
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
        Effect.catch((error) =>
          Effect.logWarning("Memory sweep deferred", { code: error.code, stage: error.stage }),
        ),
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
