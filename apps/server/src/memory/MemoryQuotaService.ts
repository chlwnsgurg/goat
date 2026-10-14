import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Store from "./MemoryStore.ts";

export class MemoryQuotaService extends Context.Service<
  MemoryQuotaService,
  {
    readonly withAdmission: <A, E, R>(
      input: {
        readonly operation: M.MemoryOperation;
        readonly admission: Store.MemoryAdmissionContext;
        readonly environmentId: M.EnvironmentId;
        readonly receipt?: M.MemoryHubReceipt | M.MemoryMutationReceipt;
      },
      commit: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | Store.MemoryStorageError | Store.MemoryCapacityError, R>;
    readonly commit: <E, R>(
      decision: Store.MemoryDecision,
      environmentId: M.EnvironmentId,
      permit: Effect.Effect<void, E, R>,
    ) => Effect.Effect<
      Store.StoredReceipt,
      E | Store.MemoryStorageError | Store.MemoryCapacityError | Store.MemoryStoreConflict,
      R
    >;
    readonly recordStorageSample: (
      environmentId: M.EnvironmentId,
      sharedMetrics?: { readonly walBytes: number | null },
    ) => Effect.Effect<M.MemoryStorageGrowth, Store.MemoryStorageError>;
    readonly readStorageGrowth: (
      environmentId: M.EnvironmentId,
    ) => Effect.Effect<M.MemoryStorageGrowth, Store.MemoryStorageError>;
  }
>()("goat/memory/MemoryQuotaService") {}
const receiptJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Union([M.MemoryHubReceipt, M.MemoryMutationReceipt])),
);
const resolutionPayloadJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryResolutionPayload));
const payloadJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryPayload));
const suppressionJson = Schema.encodeEffect(Schema.fromJsonString(M.MemorySuppressionRecord));
const sampleDecode = Schema.decodeUnknownEffect(M.MemoryStorageSample);
const growthDecode = Schema.decodeUnknownEffect(M.MemoryStorageGrowth);
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const sourceKeyJson = Schema.encodeEffect(Schema.fromJsonString(M.MemorySourceKey));
const contentJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryContentSuppression));
const exclusionJson = Schema.encodeEffect(Schema.fromJsonString(M.MemorySourceExclusion));
const keyOf = (record: M.MemorySuppressionRecord) =>
  record.kind === "sourceKey"
    ? sourceKeyJson(record.sourceKey)
    : record.kind === "content"
      ? contentJson(record.content)
      : exclusionJson(record.exclusion);
const storageError = (cause: unknown) =>
  new Store.MemoryStorageError({ stage: "quota-codec", cause });

/** Exact-day endpoints; missing metrics or days remain unavailable rather than becoming zero growth. */
export function storageDeltas(
  current: M.MemoryStorageSample | null,
  samples: ReadonlyArray<M.MemoryStorageSample>,
  clockDiscontinuity = false,
): ReadonlyArray<M.MemoryStorageDelta> {
  return ([1, 7, 30] as const).flatMap((days) =>
    M.MemoryStorageMetric.literals.map((metric) => {
      const target = current
        ? DateTime.formatIsoDateUtc(
            DateTime.add(DateTime.makeUnsafe(current.utcDay), { days: -days }),
          )
        : null;
      const baseline = samples.find((sample) => sample.utcDay === target);
      const elapsed =
        current && baseline
          ? Date.parse(current.measuredAtUtc) - Date.parse(baseline.measuredAtUtc)
          : null;
      const reason =
        clockDiscontinuity || (elapsed !== null && elapsed <= 0)
          ? ("clock_discontinuity" as const)
          : !baseline
            ? ("missing_baseline" as const)
            : !current || current[metric] === null || baseline[metric] === null
              ? ("metric_unavailable" as const)
              : null;
      return {
        days,
        metric,
        status: reason ? ("unavailable" as const) : ("available" as const),
        baselineAtUtc: baseline?.measuredAtUtc ?? null,
        currentAtUtc: current?.measuredAtUtc ?? null,
        elapsedMs: elapsed !== null && elapsed >= 0 ? elapsed : null,
        deltaBytes: reason || !current || !baseline ? null : current[metric]! - baseline[metric]!,
        reason,
      };
    }),
  );
}
const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const withAdmission: MemoryQuotaService["Service"]["withAdmission"] = (input, commit) =>
    store.transact(
      Effect.gen(function* () {
        const op = input.operation;
        if (yield* store.receipt(op.memorySpaceId, op.operationId)) return yield* commit;
        const current = yield* store.loadAggregate(op.memorySpaceId, op.memoryId);
        const scope =
          op.kind === "forget"
            ? (current.identity?.scope ?? { kind: "user" as const })
            : op.revision.scope;
        const usage = yield* store.usage(op.memorySpaceId, scope);
        const charges: Store.MemoryQuotaCharge[] = [];
        const charge = (
          dimension: string,
          used: number,
          delta: number,
          limit: number,
          scopeKey = "space",
        ) =>
          charges.push({
            space: op.memorySpaceId,
            dimension,
            scopeKey,
            current: used,
            delta,
            limit,
          });
        const identityNew = current.identity === undefined;
        const firstForget =
          op.kind === "forget" && current.tombstone === undefined && current.identity !== undefined;
        const heldReservation = yield* store.readForgetReservation(op.memorySpaceId, op.memoryId);
        const neededReservation =
          op.kind !== "forget" && !current.tombstone
            ? yield* store.firstForgetReservation(op)
            : heldReservation;
        const oldLive = current.item !== undefined && current.item.status !== "forgotten";
        const addedLive =
          op.kind === "forget" ? -Number(oldLive) : Number(!oldLive && !current.tombstone);
        const metadataBytes = yield* store.operationMetadataBytes(op);
        const receipt = input.receipt ?? {
          operationId: op.operationId,
          memoryId: op.memoryId,
          outcome: op.kind === "forget" ? ("deleted" as const) : ("accepted" as const),
          revisionId: op.kind === "forget" ? null : op.revision.revisionId,
          pendingSync: input.admission.kind === "localIntent",
        };
        const receiptBytes = utf8(yield* receiptJson(receipt).pipe(Effect.mapError(storageError)));
        const payloadBytes =
          op.kind === "forget"
            ? 0
            : utf8(yield* payloadJson(op.payload).pipe(Effect.mapError(storageError)));
        const oldPayloadBytes = yield* Effect.reduce(
          current.revisions.filter(
            (pair) => current.heads.includes(pair.revision.revisionId) && pair.payload !== null,
          ),
          () => 0,
          (sum, pair) => Effect.map(payloadJson(pair.payload!), (json) => sum + utf8(json)),
        ).pipe(Effect.mapError(storageError));
        if (input.admission.kind === "localIntent" && op.kind !== "forget") {
          const brake = yield* store.ftsState(input.environmentId);
          if (brake.state === "braked")
            return yield* new Store.MemoryCapacityError({
              dimension: "fts_admission_brake",
              limit: M.MEMORY_FTS_ALLOCATED_BRAKE_BYTES,
            });
        }
        charge("lifetime_ids", usage.lifetimeIds, Number(identityNew), M.MEMORY_MAX_LIFETIME_IDS);
        charge(
          "receipts",
          usage.receipts,
          firstForget ? 0 : 1 + Number(identityNew && op.kind !== "forget"),
          M.MEMORY_DEDUP_MAX_RECEIPTS,
        );
        // Identity core and its first-forget receipt are charged before normal writers can spend them.
        charge(
          "permanent_metadata",
          usage.permanentBytes,
          (identityNew ? M.MEMORY_IDENTITY_CORE_MAX_BYTES : 0) +
            (op.kind !== "forget"
              ? Math.max(0, neededReservation.bytes - heldReservation.bytes)
              : identityNew
                ? M.MEMORY_PAYLOAD_MAX_UTF8_BYTES
                : 0) +
            (firstForget ? 0 : M.MEMORY_COMPACT_RECEIPT_MAX_BYTES) *
              (1 + Number(identityNew && op.kind !== "forget")),
          M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
        );
        if (op.kind !== "forget")
          charge(
            "import_source_items",
            usage.keys,
            Math.max(0, neededReservation.keys - heldReservation.keys),
            M.MEMORY_IMPORT_MAX_SOURCE_ITEMS,
          );
        if (op.kind === "forget") {
          const existing = yield* store.readSuppressions(op.memorySpaceId, op.memoryId);
          const keys = new Set(
            yield* Effect.forEach(existing, (record) =>
              Effect.map(keyOf(record), (text) => record.kind + ":" + text),
            ).pipe(Effect.mapError(storageError)),
          );
          const t = op.tombstone;
          const records = Store.memorySuppressionRecords(t);
          let newKeys = 0,
            newBytes = 0;
          for (const record of records) {
            const key =
              record.kind + ":" + (yield* keyOf(record).pipe(Effect.mapError(storageError)));
            if (keys.has(key)) continue;
            keys.add(key);
            newKeys++;
            newBytes += utf8(yield* suppressionJson(record).pipe(Effect.mapError(storageError)));
          }
          // Consume only the reserved first fragment; expanded excess still needs admission.
          charge(
            "import_source_items",
            usage.keys,
            newKeys - (firstForget ? heldReservation.keys : 0),
            M.MEMORY_IMPORT_MAX_SOURCE_ITEMS,
          );
          charge(
            "permanent_metadata",
            usage.permanentBytes,
            newBytes -
              (firstForget
                ? heldReservation.bytes
                : identityNew
                  ? M.MEMORY_PAYLOAD_MAX_UTF8_BYTES
                  : 0),
            M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
          );
        } else {
          const scopeDimension =
            scope.kind === "user"
              ? "user_items"
              : scope.kind === "project"
                ? "project_items"
                : op.revision.provenance.sourceThread
                  ? "thread_summaries"
                  : "thread_items";
          const scopeLimit =
            scope.kind === "user"
              ? M.MEMORY_USER_MAX_ITEMS
              : scope.kind === "project"
                ? M.MEMORY_PROJECT_MAX_ITEMS
                : scopeDimension === "thread_summaries"
                  ? M.MEMORY_THREAD_MAX_SUMMARIES
                  : M.MEMORY_THREAD_MAX_EXPLICIT_ITEMS;
          charge(
            scopeDimension,
            scopeDimension === "thread_summaries"
              ? usage.scopeSummaries
              : scopeDimension === "thread_items"
                ? usage.scopeExplicit
                : usage.scopeItems,
            addedLive,
            scopeLimit,
            scope.kind === "user"
              ? "user"
              : scope.kind === "thread"
                ? `${scope.thread.environmentId.length}:${scope.thread.environmentId}:${scope.thread.threadId}`
                : scope.projectKey.kind === "repository"
                  ? scope.projectKey.groupingKey
                  : scope.projectKey.sharedProjectId,
          );
          charge("space_live_items", usage.spaceItems, addedLive, M.MEMORY_SPACE_MAX_LIVE_ITEMS);
          charge(
            "environment_live_items",
            usage.environmentItems,
            addedLive,
            M.MEMORY_ENVIRONMENT_MAX_LIVE_ITEMS,
          );
          charge(
            "live_payload_bytes",
            usage.liveBytes,
            payloadBytes - oldPayloadBytes,
            M.MEMORY_LIVE_MAX_PAYLOAD_BYTES,
          );
          charge(
            "history",
            usage.historyBytes,
            oldPayloadBytes +
              (op.kind === "resolve"
                ? utf8(
                    yield* resolutionPayloadJson(op.resolutionPayload).pipe(
                      Effect.mapError(storageError),
                    ),
                  )
                : 0),
            M.MEMORY_HISTORY_MAX_PAYLOAD_BYTES,
          );
          charge(
            "work_items",
            usage.workItems,
            input.admission.kind === "localIntent" ? 1 : 0,
            M.MEMORY_WORK_MAX_PENDING_ITEMS,
          );
          charge(
            "work_bytes",
            usage.workBytes,
            input.admission.kind === "localIntent" ? metadataBytes : 0,
            M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
          );
          charge("log_tail_rows", usage.logRows, 1, M.MEMORY_LOG_MAX_TAIL_ROWS);
          charge(
            "log_tail_bytes",
            usage.logBytes,
            metadataBytes + receiptBytes,
            M.MEMORY_LOG_MAX_TAIL_BYTES,
          );
        }
        if (input.admission.kind !== "hubAdmission") {
          const baselines: Record<string, number> = {
            lifetime_ids: usage.environmentLifetimeIds,
            receipts: usage.environmentReceipts,
            permanent_metadata: usage.environmentPermanentBytes,
            live_payload_bytes: usage.environmentLiveBytes,
            history: usage.environmentHistoryBytes,
          };
          for (const entry of [...charges]) {
            const current = baselines[entry.dimension];
            if (current !== undefined)
              charges.push({ ...entry, space: `_environment:${input.environmentId}`, current });
          }
        }
        const combined = new Map<string, Store.MemoryQuotaCharge>();
        for (const next of charges) {
          const key = `${next.space}:${next.dimension}:${next.scopeKey}`;
          const old = combined.get(key);
          combined.set(key, old ? { ...old, delta: old.delta + next.delta } : next);
        }
        yield* store.reserve(input.admission, [...combined.values()]);
        return yield* commit;
      }),
    );
  const commit = Effect.fn("MemoryQuotaService.commit")(function* <E, R>(
    decision: Store.MemoryDecision,
    environmentId: M.EnvironmentId,
    permit: Effect.Effect<void, E, R>,
  ) {
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const op = decision.operation;
        const aggregate = yield* store.loadAggregate(op.memorySpaceId, op.memoryId);
        const identity = decision.identity ??
          aggregate.identity ?? {
            memorySpaceId: op.memorySpaceId,
            memoryId: op.memoryId,
            scope: op.kind === "forget" ? { kind: "user" as const } : op.revision.scope,
            creatingEnvironmentId: op.originEnvironmentId,
            createOperationId: op.operationId,
            createdAtUtc:
              op.kind === "forget" ? op.tombstone.deletedAtUtc : op.revision.createdAtUtc,
          };
        if (
          op.kind === "forget" &&
          aggregate.identity &&
          !aggregate.tombstone &&
          decision.receipt.outcome !== "rejected" &&
          !(yield* store.receipt(op.memorySpaceId, op.operationId))
        ) {
          const reservation = yield* store.readForgetReservation(op.memorySpaceId, op.memoryId);
          const records = Store.memorySuppressionRecords(op.tombstone);
          const reservedKeys = new Set<string>();
          for (const { revision, payload } of aggregate.revisions) {
            const { sourceThread, sourceWatermark } = revision.provenance;
            if (!sourceThread || !sourceWatermark) continue;
            for (const messageId of new Set((payload?.evidence ?? []).flatMap((e) => e.messageIds)))
              reservedKeys.add(
                "sourceExclusion:" +
                  (yield* exclusionJson({
                    sourceThread,
                    sourceWatermark,
                    messageIds: [messageId],
                  }).pipe(Effect.mapError(storageError))),
              );
          }
          const unique = new Map<string, number>();
          for (const record of records) {
            const key =
              record.kind + ":" + (yield* keyOf(record).pipe(Effect.mapError(storageError)));
            unique.set(
              key,
              utf8(yield* suppressionJson(record).pipe(Effect.mapError(storageError))),
            );
          }
          const selected = new Set<string>();
          let baseBytes = 0;
          // Reserved source evidence wins over optional expansion of the delete request.
          for (const [key, bytes] of [...unique].sort(
            ([a], [b]) => Number(reservedKeys.has(b)) - Number(reservedKeys.has(a)),
          )) {
            if (selected.size < reservation.keys && baseBytes + bytes <= reservation.bytes) {
              selected.add(key);
              baseBytes += bytes;
            }
          }
          const fragment = (included: ReadonlySet<string>) =>
            Effect.gen(function* () {
              const sourceKeys: M.MemorySourceKey[] = [];
              const content: M.MemoryContentSuppression[] = [];
              const exclusions: M.MemorySourceExclusion[] = [];
              for (const sourceKey of op.tombstone.suppressedSourceKeys)
                if (
                  included.has(
                    "sourceKey:" +
                      (yield* sourceKeyJson(sourceKey).pipe(Effect.mapError(storageError))),
                  )
                )
                  sourceKeys.push(sourceKey);
              for (const value of op.tombstone.suppressedContent)
                if (
                  included.has(
                    "content:" + (yield* contentJson(value).pipe(Effect.mapError(storageError))),
                  )
                )
                  content.push(value);
              for (const exclusion of op.tombstone.sourceExclusions) {
                const messageIds: M.MessageId[] = [];
                for (const messageId of exclusion.messageIds)
                  if (
                    included.has(
                      "sourceExclusion:" +
                        (yield* exclusionJson({ ...exclusion, messageIds: [messageId] }).pipe(
                          Effect.mapError(storageError),
                        )),
                    )
                  )
                    messageIds.push(messageId);
                if (messageIds.length) exclusions.push({ ...exclusion, messageIds });
              }
              return {
                ...op.tombstone,
                suppressedSourceKeys: sourceKeys,
                suppressedContent: content,
                sourceExclusions: exclusions,
              };
            });
          const base = yield* fragment(selected);
          const result = yield* withAdmission(
            {
              operation: { ...op, tombstone: base },
              admission: decision.admission,
              environmentId,
              receipt: decision.receipt,
            },
            store.apply({ ...decision, identity, admittedForget: base }),
          );
          const excess = new Set([...unique.keys()].filter((key) => !selected.has(key)));
          if (!excess.size) return result;
          const extra = yield* fragment(excess);
          const bytes = [...excess].reduce((sum, key) => sum + unique.get(key)!, 0);
          const usage = yield* store.usage(op.memorySpaceId, aggregate.identity.scope);
          const charges: Store.MemoryQuotaCharge[] = [
            {
              space: op.memorySpaceId,
              dimension: "import_source_items",
              scopeKey: "space",
              current: usage.keys,
              delta: excess.size,
              limit: M.MEMORY_IMPORT_MAX_SOURCE_ITEMS,
            },
            {
              space: op.memorySpaceId,
              dimension: "permanent_metadata",
              scopeKey: "space",
              current: usage.permanentBytes,
              delta: bytes,
              limit: M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
            },
          ];
          if (decision.admission.kind !== "hubAdmission")
            charges.push({
              ...charges[1]!,
              space: `_environment:${environmentId}`,
              current: usage.environmentPermanentBytes,
            });
          const status = yield* store
            .reserve(decision.admission, charges)
            .pipe(
              Effect.as("accepted" as const),
              Effect.catchTags({ MemoryCapacityError: () => Effect.succeed("rejected" as const) }),
            );
          yield* store.settleForgetFragment({
            operation: op,
            operationDigest: decision.operationDigest,
            fragment: extra,
            keys: excess.size,
            bytes,
            status,
          });
          return result;
        }
        return yield* withAdmission(
          {
            operation: op,
            admission: decision.admission,
            environmentId,
            receipt: decision.receipt,
          },
          store.apply(
            decision.receipt.outcome === "rejected" ? decision : { ...decision, identity },
          ),
        );
      }),
    );
  });
  const readStorageGrowth = Effect.fn("MemoryQuotaService.readStorageGrowth")(function* (
    environmentId: M.EnvironmentId,
  ) {
    const samples = yield* store.samples(environmentId);
    const current = samples.at(-1) ?? null;
    return yield* growthDecode({ current, deltas: storageDeltas(current, samples) }).pipe(
      Effect.mapError(storageError),
    );
  });
  const recordStorageSample = Effect.fn("MemoryQuotaService.recordStorageSample")(function* (
    environmentId: M.EnvironmentId,
    sharedMetrics?: { walBytes: number | null },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const logical = yield* store.logicalBytes;
    const measured = yield* store.measureAllocation();
    const sample = yield* sampleDecode({
      measuredAtUtc: DateTime.formatIso(DateTime.makeUnsafe(now)),
      utcDay: DateTime.formatIsoDateUtc(DateTime.makeUnsafe(now)),
      status:
        measured.memoryBytes !== null &&
        sharedMetrics?.walBytes !== undefined &&
        sharedMetrics.walBytes !== null
          ? "available"
          : "partial",
      memoryLogicalBytes: logical,
      memoryAllocatedBytes: measured.memoryBytes,
      ftsAllocatedBytes: measured.ftsBytes,
      dbFileBytes: measured.dbFileBytes,
      walBytes: sharedMetrics?.walBytes ?? null,
      freelistBytes: measured.freelistBytes,
      tables: measured.tables,
    }).pipe(Effect.mapError(storageError));
    const accepted = yield* store.recordSample(environmentId, sample);
    const previous = yield* readStorageGrowth(environmentId);
    return accepted
      ? previous
      : { current: previous.current, deltas: storageDeltas(previous.current, [], true) };
  });
  return MemoryQuotaService.of({ withAdmission, commit, readStorageGrowth, recordStorageSample });
});
export const layer = Layer.effect(MemoryQuotaService, make);
