// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned submission IDs.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Client from "./MemoryHubClient.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";

type Error = Hub.MemoryHubServiceError;
type Permit = Effect.Effect<void, Service.MemoryAccessError>;
type Bootstrap = {
  state: "unbound" | "staging" | "ready";
  checkpointId: string | null;
  snapshotToken: string | null;
  checkpointSequence: number;
  cursor: string | null;
  pageCount: number;
};
/** Application-owned committed reads and authorization; never a transport or Worker reader. */
export class MemorySyncRuntime extends Context.Service<
  MemorySyncRuntime,
  {
    readonly cwd: string;
    readonly readBootstrap: (
      space: M.MemorySpaceId,
      hub: M.EnvironmentId,
    ) => Effect.Effect<Bootstrap, Service.MemoryServiceError>;
    readonly discardBootstrap: (
      space: M.MemorySpaceId,
      hub: M.EnvironmentId,
      token: string,
    ) => Effect.Effect<void, Service.MemoryServiceError>;
    readonly readProcessing: (
      space: M.MemorySpaceId,
      hub: M.EnvironmentId,
    ) => Effect.Effect<
      {
        processing: M.MemoryProcessingStatus;
        pendingSync: number;
        quarantined: number;
        parked: number;
      },
      Store.MemoryStorageError
    >;
    readonly available: (
      selection: M.MemoryModelSelection,
    ) => Effect.Effect<void, M.MemoryHubError>;
    readonly ownerPermit: (request: M.MemorySourceReadRequest) => Permit;
    readonly ownerReader: Service.MemoryOwnerCommittedReader;
  }
>()("goat/memory/MemorySyncService/MemorySyncRuntime") {}

export class MemorySyncService extends Context.Service<
  MemorySyncService,
  {
    readonly start: Effect.Effect<void, Error>;
    readonly syncOnce: Effect.Effect<void, Error>;
    readonly shutdown: Effect.Effect<void>;
    readonly scheduleConflictResolution: Effect.Effect<void, Error>;
    readonly readLocalReadiness: () => Effect.Effect<
      { memorySpaceId: M.MemorySpaceId | null; bootstrap: "unbound" | "staging" | "ready" },
      Error
    >;
    readonly requireBootstrap: (space: M.MemorySpaceId) => Effect.Effect<void, Error>;
    readonly syncStatus: (
      input: M.MemorySyncStatusInput,
      permit: Permit,
    ) => Effect.Effect<M.MemorySyncStatus, Error>;
    readonly getHubSettings: (
      input: M.MemoryHubSettingsGetInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryHubSettingsView, Error>;
    readonly readSource: Service.MemorySourceReadAuthority["readSource"];
    readonly activeResolutions: Effect.Effect<number>;
  }
>()("goat/memory/MemorySyncService") {}

const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));
const uuid = () => NodeCrypto.randomUUID();
const stableId = (attempt: string, kind: string) => {
  const h = NodeCrypto.createHash("sha256").update(`${attempt}:${kind}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const sameHeads = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((h, i) => h === [...b].sort()[i]);
const decodePull = Schema.decodeUnknownEffect(M.MemoryHubPullResult);
const decodeSource = Schema.decodeUnknownEffect(M.MemorySourceReadOutcome);
const decodeGenerated = Schema.decodeUnknownEffect(M.ResolveMemoryConflictExecutionResult);
const decodeResolveInput = Schema.decodeUnknownEffect(M.ResolveMemoryConflictInput);
const decodeSubmission = Schema.decodeUnknownEffect(M.MemoryHubApplyResolutionInput);
const encodePush = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubPushInput));
const failureCode = (e: Error): M.MemoryFailureCode =>
  e._tag === "MemoryHubUnauthorizedError" || e._tag === "MemoryHubForbiddenError"
    ? "route_unavailable"
    : e._tag === "MemoryStorageError"
      ? "storage_failed"
      : e._tag === "MemoryCapacityError"
        ? "capacity_exceeded"
        : e.code;
const transient = (e: Error) =>
  e._tag === "MemoryHubError" && ["unavailable", "storage_failed"].includes(e.code);

const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const service = yield* Service.MemoryService;
  const client = yield* Client.MemoryHubClient;
  const hub = yield* Hub.MemoryHubService;
  const settings = yield* Settings.ServerSettingsService;
  const runtime = yield* MemorySyncRuntime;
  const quota = yield* Quota.MemoryQuotaService;
  const generation = yield* Generation.TextGeneration;
  const identity = yield* Environment.ServerEnvironmentIdentity;
  const local = yield* identity.getEnvironmentId;
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const registryMutex = yield* Semaphore.make(1);
  const owner = uuid();
  let stopped = false;
  let started = false;
  let lastSuccess: string | null = null;
  let lastFailure: M.MemoryFailureCode | undefined;
  const background: Fiber.Fiber<void, never>[] = [];
  // Slots remain reserved through persistence and bounded release in the outer finalizer.
  const executions = new Map<string, { epoch: number; fiber: Fiber.Fiber<void, never> | null }>();
  const readSettings = settings.getSettings.pipe(
    Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
  );
  const ensureEpoch = (epoch: number): Permit =>
    readSettings.pipe(
      Effect.flatMap((s) =>
        s.memoryHubVersion === epoch && !stopped
          ? Effect.void
          : Effect.fail(new Service.MemoryAccessError({ code: "fenced" })),
      ),
      Effect.mapError(() => new Service.MemoryAccessError({ code: "fenced" })),
    );
  const route = Effect.fnUntraced(function* () {
    const s = yield* readSettings;
    if (s.memoryHub.mode === "disabled") return null;
    const principal =
      s.memoryHub.mode === "hub" && s.memoryHub.memorySpaceId !== null
        ? yield* store.readHubMember(s.memoryHub.memorySpaceId, local)
        : undefined;
    if (s.memoryHub.mode === "hub" && !principal)
      return yield* new M.MemoryHubError({ code: "bootstrap_required" });
    const connection: Client.HubConnection | null =
      s.memoryHub.mode === "member" ? { ...s.memoryHub, epoch: s.memoryHubVersion } : null;
    const p: M.MemoryHubPrincipal | null = principal
      ? {
          memorySpaceId: principal.memorySpaceId,
          environmentId: local,
          credentialVersion: principal.credentialVersion,
          scopes: ["memory:sync"],
        }
      : null;
    return {
      settings: s,
      connection,
      principal: p,
      hubId: connection?.hubEnvironmentId ?? local,
      space: s.memoryHub.memorySpaceId,
    };
  });
  type Route = NonNullable<Effect.Success<ReturnType<typeof route>>>;
  const callPull = (r: Route, i: M.MemoryHubPullInput) =>
    r.connection ? client.pull(r.connection, i) : hub.pull(i, r.principal!);
  const release = (r: Route, ticket: M.MemoryResolutionLease) => {
    const input: M.MemoryHubReleaseInput = {
      protocolVersion: 1,
      memorySpaceId: ticket.memorySpaceId,
      memoryId: ticket.memoryId,
      conflictId: ticket.conflictId,
      holderEnvironmentId: local,
      attemptId: ticket.attemptId,
      fencingToken: ticket.fencingToken,
    };
    return (
      r.connection ? client.release(r.connection, input) : hub.release(input, r.principal!)
    ).pipe(Effect.timeout("15 seconds"), Effect.ignore);
  };
  const eligibility = Effect.fnUntraced(function* (ticket: M.MemoryResolutionLease) {
    const aggregate = yield* store.loadAggregate(ticket.memorySpaceId, ticket.memoryId);
    if (
      aggregate.tombstone ||
      aggregate.pendingForget ||
      !sameHeads(aggregate.heads, ticket.conflictHeadSet) ||
      aggregate.item?.status !== "quarantined" ||
      aggregate.item.localAvailability.reasons.some((r) =>
        [
          "secret_detected",
          "scanner_pending",
          "missing_parent",
          "dependency_invalidated",
          "forget_pending",
        ].includes(r),
      )
    )
      return yield* new M.MemoryHubError({ code: "conflict_changed" });
    return aggregate;
  });
  const ownership = (row: Store.TicketRow): Store.TicketOwner => ({
    memorySpaceId: row.ticket.memorySpaceId,
    attemptId: row.ticket.attemptId,
    owner,
    coordinatorEpoch: row.coordinatorEpoch,
    version: row.version,
  });

  const runClaimedResolution = Effect.fn("MemorySyncService.runClaimedResolution")(function* (
    r: Route,
    initial: Store.TicketRow,
  ) {
    let row = initial;
    let renewable = true;
    const transition = Effect.fnUntraced(function* (
      state: Store.TicketState,
      approval?: M.MemoryHubReceipt,
      retireClaim?: { expectedGeneration: number; attemptId: string },
    ) {
      const now = yield* Clock.currentTimeMillis;
      const next = yield* store.transact(
        store.transitionResolutionTicketTx({
          ownership: ownership(row),
          nextState: state,
          now,
          ownedUntil:
            state === "terminal" || state === "recoverable" || state === "submitting"
              ? null
              : now + 60000,
          nextAttemptAt: now + (state === "recoverable" || state === "submitting" ? 30000 : 0),
          ...(approval ? { approval } : {}),
          ...(retireClaim ? { retireClaim } : {}),
        }),
      );
      if (!next) return yield* new M.MemoryHubError({ code: "fenced" });
      row = next;
    });
    const settle = Effect.fnUntraced(function* (receipt: M.MemoryHubReceipt) {
      if (!row.submission) return yield* new M.MemoryHubError({ code: "invalid_output" });
      const operation = row.submission.operation;
      yield* ensureEpoch(r.settings.memoryHubVersion);
      yield* store.transact(
        service.settleHubEntryTx({
          memorySpaceId: row.ticket.memorySpaceId,
          hubEnvironmentId: r.hubId,
          localEnvironmentId: local,
          entry: { kind: "operation", hubSequence: receipt.hubSequence!, operation, receipt },
        }),
      );
      yield* transition("terminal");
      yield* store.completeClaimCandidate(
        `claim:${row.ticket.memorySpaceId}:${row.ticket.memoryId}`,
      );
    });
    const execute = Effect.gen(function* () {
      yield* ensureEpoch(r.settings.memoryHubVersion);
      if (row.approval) {
        yield* settle(row.approval);
        return;
      }
      if (!row.submission) {
        yield* transition("running");
        const aggregate = yield* eligibility(row.ticket);
        yield* runtime.available(row.ticket.frozenDefaultModelSelection);
        const heads = aggregate.revisions
          .filter(
            (h) => row.ticket.conflictHeadSet.includes(h.revision.revisionId) && h.payload !== null,
          )
          .map((h) => ({ revision: h.revision, payload: h.payload! }));
        const input = yield* decodeResolveInput({
          cwd: runtime.cwd,
          memorySpaceId: row.ticket.memorySpaceId,
          memoryId: row.ticket.memoryId,
          conflictId: row.ticket.conflictId,
          heads,
          modelSelection: row.ticket.frozenDefaultModelSelection,
        }).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })));
        const model = generation.resolveMemoryConflict;
        if (!model) return yield* new M.MemoryHubError({ code: "route_unavailable" });
        const renew = Effect.gen(function* () {
          while (renewable) {
            yield* Effect.sleep("30 seconds");
            if (!renewable) return;
            yield* ensureEpoch(r.settings.memoryHubVersion);
            yield* eligibility(row.ticket);
            const i: M.MemoryHubRenewInput = {
              protocolVersion: 1,
              memorySpaceId: row.ticket.memorySpaceId,
              memoryId: row.ticket.memoryId,
              conflictId: row.ticket.conflictId,
              holderEnvironmentId: local,
              attemptId: row.ticket.attemptId,
              fencingToken: row.ticket.fencingToken,
            };
            yield* r.connection ? client.renew(r.connection, i) : hub.renew(i, r.principal!);
            yield* transition("running");
          }
        });
        const generated = yield* Effect.scoped(
          Effect.gen(function* () {
            // Renewal failure interrupts the provider, including a hung one-shot execution.
            return yield* Effect.raceFirst(
              model(input).pipe(
                Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
              ),
              renew.pipe(Effect.flatMap(() => Effect.never)),
            );
          }),
        ).pipe(
          Effect.timeout("10 minutes"),
          Effect.catchTags({
            TimeoutError: () => Effect.fail(new M.MemoryHubError({ code: "lease_expired" })),
          }),
        );
        renewable = false;
        const trusted = yield* decodeGenerated(generated).pipe(
          Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
        );
        if (
          trusted.execution.environmentId !== local ||
          !Equal.equals(
            trusted.execution.requestedModelSelection,
            row.ticket.frozenDefaultModelSelection,
          ) ||
          !M.validateMemoryGenerationResult(input, trusted.result) ||
          scanMemoryValue(trusted.result).kind !== "allowed"
        )
          return yield* new M.MemoryHubError({ code: "invalid_output" });
        yield* ensureEpoch(r.settings.memoryHubVersion);
        yield* eligibility(row.ticket);
        const now = yield* Clock.currentTimeMillis;
        const operationId = M.MemoryOperationId.make(stableId(row.ticket.attemptId, "operation"));
        const revisionId = M.MemoryRevisionId.make(stableId(row.ticket.attemptId, "revision"));
        const resolutionId = M.MemoryResolutionId.make(
          stableId(row.ticket.attemptId, "resolution"),
        );
        const submission = yield* decodeSubmission({
          protocolVersion: 1,
          memorySpaceId: row.ticket.memorySpaceId,
          holderEnvironmentId: local,
          attemptId: row.ticket.attemptId,
          operation: {
            protocolVersion: 1,
            operationId,
            memorySpaceId: row.ticket.memorySpaceId,
            originEnvironmentId: local,
            memoryId: row.ticket.memoryId,
            expectedHeads: row.ticket.conflictHeadSet,
            kind: "resolve",
            conflictId: row.ticket.conflictId,
            fencingToken: row.ticket.fencingToken,
            revision: {
              memorySpaceId: row.ticket.memorySpaceId,
              memoryId: row.ticket.memoryId,
              operationId,
              revisionId,
              payloadRef: revisionId,
              parents: row.ticket.conflictHeadSet,
              scope: heads[0]!.revision.scope,
              assertionKind: trusted.result.assertionKind,
              provenance: {
                environmentId: local,
                providerInstanceId: trusted.execution.providerInstanceId,
                provider: trusted.execution.effectiveProvider,
                requestedModelSelection: row.ticket.frozenDefaultModelSelection,
                effectiveModel: trusted.execution.effectiveModel,
              },
              createdAtUtc: iso(now),
            },
            payload: {
              text: trusted.result.text,
              evidence: trusted.result.evidence,
              derivedFromMemoryRevisions: row.ticket.conflictHeadSet,
            },
            resolution: {
              resolutionId,
              memorySpaceId: row.ticket.memorySpaceId,
              memoryId: row.ticket.memoryId,
              inputRevisionIds: row.ticket.conflictHeadSet,
              inputPayloadRefs: row.ticket.conflictHeadSet,
              judgmentRef: resolutionId,
              requestedModelSelection: row.ticket.frozenDefaultModelSelection,
              effectiveProvider: trusted.execution.effectiveProvider,
              effectiveModel: trusted.execution.effectiveModel,
              resolvingEnvironmentId: local,
              fencingToken: row.ticket.fencingToken,
              resultRevisionId: revisionId,
              appliedAtUtc: iso(now),
              revertDeadlineUtc: iso(now + M.MEMORY_REVERT_WINDOW_MS),
            },
            resolutionPayload: { resolutionId, judgment: trusted.result.judgment },
          },
        }).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })));
        row = yield* store.transact(
          store.persistResolutionSubmissionTx({
            ownership: ownership(row),
            submission,
            digest: memoryOperationDigest(submission.operation),
          }),
        );
      }
      yield* ensureEpoch(r.settings.memoryHubVersion);
      const receipt = yield* r.connection
        ? client.applyResolution(r.connection, row.submission!)
        : hub.applyResolution(row.submission!, r.principal!);
      if (receipt.outcome === "rejected" || receipt.hubSequence === null) {
        yield* transition("terminal", receipt);
        return;
      }
      yield* transition("approved", receipt);
      yield* settle(receipt);
    });
    yield* execute.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          renewable = false;
          if (row.state !== "terminal") {
            // Unknown apply outcomes and known approvals retain the immutable submission.
            yield* transition(
              row.submission ? (row.approval ? "approved" : "submitting") : "recoverable",
            ).pipe(Effect.ignore);
          }
          yield* release(r, row.ticket);
        }),
      ),
    );
  });

  const register = Effect.fnUntraced(function* (r: Route, saved: Store.TicketRow) {
    if (
      stopped ||
      executions.size >= 4 ||
      executions.has(saved.ticket.memoryId) ||
      saved.ticket.holderEnvironmentId !== local ||
      saved.ticket.memorySpaceId !== r.space
    )
      return;
    executions.set(saved.ticket.memoryId, { epoch: r.settings.memoryHubVersion, fiber: null });
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const acquired = yield* store.transact(
          store.acquireResolutionTicketTx({
            key: { memorySpaceId: saved.ticket.memorySpaceId, attemptId: saved.ticket.attemptId },
            expectedVersion: saved.version,
            owner,
            coordinatorEpoch: r.settings.memoryHubVersion,
            now,
            ownedUntil: now + 60000,
          }),
        );
        if (!acquired) {
          executions.delete(saved.ticket.memoryId);
          return;
        }
        const fiber = yield* restore(runClaimedResolution(r, acquired)).pipe(
          Effect.catch((e) =>
            Effect.sync(() => {
              lastFailure = failureCode(e);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              executions.delete(saved.ticket.memoryId);
            }),
          ),
          Effect.ensuring(store.wake),
          Effect.forkIn(scope),
        );
        const slot = executions.get(saved.ticket.memoryId);
        if (slot) slot.fiber = fiber;
      }),
    ).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          executions.delete(saved.ticket.memoryId);
        }),
      ),
    );
  });
  const sweep = registryMutex.withPermit(
    Effect.gen(function* () {
      const r = yield* route();
      if (!r || !r.space || stopped) return;
      const now = yield* Clock.currentTimeMillis;
      yield* store.recoverClaimCandidates(now);
      const saved = yield* store.readRecoverableResolutionTickets({ now, limit: 100 });
      for (const ticket of saved) yield* register(r, ticket);
      const candidates = yield* store.readDueClaimCandidates(100, now);
      for (const work of candidates) {
        if (executions.size >= 4) break;
        if (
          !work.memoryId ||
          executions.has(work.memoryId) ||
          work.metadata.kind !== "claim" ||
          work.space !== r.space
        )
          continue;
        const metadata = work.metadata;
        const prepare = {
          memorySpaceId: r.space,
          candidateId: work.id,
          expectedGeneration: metadata.generation ?? 0,
          conflictHeads: metadata.sortedHeads,
        };
        const attempt = yield* Effect.result(
          Effect.gen(function* () {
            let frozen = yield* store.transact(store.prepareClaimAttemptTx(prepare));
            if (!frozen) {
              const selection = (yield* readSettings).defaultModelSelection;
              if (!selection) return yield* new M.MemoryHubError({ code: "route_unavailable" });
              yield* runtime.available(selection);
              frozen = yield* store.transact(
                store.prepareClaimAttemptTx({
                  ...prepare,
                  proposedClaim: {
                    protocolVersion: 1,
                    memorySpaceId: r.space!,
                    memoryId: work.memoryId!,
                    conflictId: metadata.conflictId,
                    holderEnvironmentId: local,
                    attemptId: M.MemoryOperationId.make(uuid()),
                    conflictHeadSet: metadata.sortedHeads,
                    frozenDefaultModelSelection: selection,
                  },
                }),
              );
            }
            if (!frozen) return;
            yield* ensureEpoch(r.settings.memoryHubVersion);
            const ticket = yield* r.connection
              ? client.claim(r.connection, frozen.claim)
              : hub.claim(frozen.claim, r.principal!);
            yield* ensureEpoch(r.settings.memoryHubVersion);
            if (
              ticket.attemptId !== frozen.claim.attemptId ||
              !sameHeads(ticket.conflictHeadSet, frozen.claim.conflictHeadSet) ||
              !Equal.equals(
                ticket.frozenDefaultModelSelection,
                frozen.claim.frozenDefaultModelSelection,
              )
            )
              return yield* new M.MemoryHubError({ code: "invalid_output" });
            yield* store.persistResolutionTicket(ticket);
            for (const row of yield* store.readRecoverableResolutionTickets({
              now: yield* Clock.currentTimeMillis,
              limit: 100,
            }))
              if (row.ticket.attemptId === ticket.attemptId) yield* register(r, row);
          }),
        );
        if (attempt._tag === "Failure") {
          lastFailure = failureCode(attempt.failure);
          yield* store.retryClaimCandidate(
            work.id,
            now +
              (lastFailure === "claim_busy"
                ? 30000
                : Math.min(600000, [5000, 30000, 120000, 600000][Math.min(work.attempt, 3)]!)),
            lastFailure,
          );
        }
      }
    }),
  );

  const pullTail = Effect.fnUntraced(function* (
    r: Route,
    budget: { pages: number; entries: number },
  ) {
    let highWatermark: number | undefined;
    while (budget.pages < 10 && budget.entries < 1000) {
      const after = yield* store.readCursor(r.space!, r.hubId);
      const page = yield* callPull(r, {
        protocolVersion: 1,
        memorySpaceId: r.space!,
        environmentId: local,
        afterSequence: after,
        limit: Math.min(100, 1000 - budget.entries),
        ...(highWatermark === undefined ? {} : { highWatermark }),
      }).pipe(
        Effect.flatMap(decodePull),
        Effect.mapError((e) =>
          e._tag === "SchemaError" ? new M.MemoryHubError({ code: "invalid_output" }) : e,
        ),
      );
      yield* ensureEpoch(r.settings.memoryHubVersion);
      if (
        page.checkpoint ||
        (highWatermark !== undefined && page.highWatermark !== highWatermark) ||
        page.throughSequence < after ||
        (page.hasMore && page.throughSequence === after)
      )
        return yield* new M.MemoryHubError({ code: "invalid_output" });
      highWatermark = page.highWatermark;
      yield* service.receiveHubPage({
        memorySpaceId: r.space!,
        hubEnvironmentId: r.hubId,
        localEnvironmentId: local,
        expectedSequence: after,
        page,
        reauthorize: ensureEpoch(r.settings.memoryHubVersion),
      });
      budget.pages++;
      budget.entries += page.entries.length;
      if (!page.hasMore) break;
    }
  });
  const bootstrap = Effect.fnUntraced(function* (
    r: Route,
    budget: { pages: number; entries: number },
  ) {
    if (!r.space) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
    let state = yield* runtime.readBootstrap(r.space, r.hubId);
    if (state.state === "ready") return true;
    if (!r.connection) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
    if (state.state === "unbound") {
      const join = yield* client.join(r.connection, {
        protocolVersion: 1,
        environmentId: local,
        memorySpaceId: r.space,
      });
      yield* ensureEpoch(r.settings.memoryHubVersion);
      state = {
        state: "staging",
        checkpointId: `hub:${join.snapshotToken}`,
        snapshotToken: join.snapshotToken,
        checkpointSequence: join.checkpointSequence,
        cursor: null,
        pageCount: 0,
      };
      yield* store.transact(
        store.advanceBootstrapTx({
          memorySpaceId: r.space,
          hubEnvironmentId: r.hubId,
          expectedState: "unbound",
          nextState: "staging",
          checkpointId: state.checkpointId!,
          snapshotToken: state.snapshotToken,
          checkpointSequence: state.checkpointSequence,
          nextCursor: null,
        }),
      );
    }
    while (budget.pages < 10) {
      const response = yield* Effect.result(
        callPull(r, {
          protocolVersion: 1,
          memorySpaceId: r.space,
          environmentId: local,
          afterSequence: state.checkpointSequence,
          limit: 100,
          snapshotToken: state.snapshotToken!,
          ...(state.cursor ? { cursor: state.cursor } : {}),
        }),
      );
      if (response._tag === "Failure") {
        if (
          response.failure._tag === "MemoryHubError" &&
          response.failure.code === "cursor_expired"
        )
          yield* runtime.discardBootstrap(r.space, r.hubId, state.snapshotToken!);
        return yield* response.failure;
      }
      const page = (yield* decodePull(response.success).pipe(
        Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
      )).checkpoint;
      if (
        !page ||
        page.pageOrdinal !== state.pageCount ||
        page.checkpointSequence !== state.checkpointSequence
      )
        return yield* new M.MemoryHubError({ code: "invalid_output" });
      yield* ensureEpoch(r.settings.memoryHubVersion);
      yield* store.transact(
        Effect.gen(function* () {
          yield* store.installCheckpointPage({ checkpointId: state.checkpointId!, page });
          if (page.bootstrapComplete)
            yield* store.completeCheckpoint({
              memorySpaceId: r.space!,
              hubEnvironmentId: r.hubId,
              localEnvironmentId: local,
              checkpointId: state.checkpointId!,
              pageCount: state.pageCount + 1,
            });
          else
            yield* store.advanceBootstrapTx({
              memorySpaceId: r.space!,
              hubEnvironmentId: r.hubId,
              expectedState: "staging",
              nextState: "staging",
              checkpointId: state.checkpointId!,
              snapshotToken: state.snapshotToken,
              checkpointSequence: state.checkpointSequence,
              nextCursor: page.nextCursor,
            });
        }),
      );
      budget.pages++;
      state = { ...state, pageCount: state.pageCount + 1, cursor: page.nextCursor };
      if (page.bootstrapComplete) return true;
    }
    return false;
  });
  const relay = Effect.fnUntraced(function* (r: Route) {
    const now = yield* Clock.currentTimeMillis;
    yield* store.transact(store.purgeHubTransientTx({ memorySpaceId: r.space!, now, limit: 100 }));
    const input: M.MemoryHubSourceReadCollectInput = {
      protocolVersion: 1,
      memorySpaceId: r.space!,
      limit: 32,
    };
    const collected = yield* r.connection
      ? client.collectSourceReads(r.connection, input)
      : hub.collectSourceReads(input, r.principal!);
    for (const request of collected.requests) {
      yield* Effect.gen(function* () {
        if (
          request.sourceThread.environmentId !== local ||
          Date.parse(request.expiresAtHubTime) <= (yield* Clock.currentTimeMillis)
        )
          return;
        const permit = runtime
          .ownerPermit(request)
          .pipe(Effect.andThen(ensureEpoch(r.settings.memoryHubVersion)));
        yield* permit;
        const outcome = yield* runtime.ownerReader.readCommitted(request, permit);
        yield* permit;
        const checked = yield* decodeSource(outcome).pipe(
          Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
        );
        const safe: M.MemorySourceReadOutcome =
          scanMemoryValue(checked).kind === "allowed"
            ? checked
            : { kind: "unavailable", code: "secret_detected" };
        const response: M.MemoryHubSourceReadRespondInput = {
          protocolVersion: 1,
          memorySpaceId: r.space!,
          requestId: request.requestId,
          outcome: safe,
        };
        yield* r.connection
          ? client.respondSourceRead(r.connection, response)
          : hub.respondSourceRead(response, r.principal!);
      }).pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            lastFailure = failureCode(e);
          }),
        ),
      );
    }
  });
  const push = Effect.fnUntraced(function* (r: Route) {
    const now = yield* Clock.currentTimeMillis;
    const candidates = yield* store.readEligibleOutbox(r.space!, now, 100);
    let bytes = 0;
    for (const candidate of candidates) {
      const operation = yield* store.readWorkOperation(candidate.work.id);
      if (!operation) continue;
      const input: M.MemoryHubPushInput = {
        protocolVersion: 1,
        memorySpaceId: r.space!,
        environmentId: local,
        operations: [operation],
      };
      const encoded = yield* encodePush(input).pipe(
        Effect.mapError(() => new M.MemoryHubError({ code: "payload_too_large" })),
      );
      const length = new TextEncoder().encode(encoded).length;
      if (bytes + length > 1048576) break;
      bytes += length;
      const acquired = yield* store.transact(
        store.acquireSyncWorkTx({
          workId: candidate.work.id,
          operationId: candidate.operationId,
          operationDigest: candidate.operationDigest,
          owner,
          expectedVersion: candidate.version,
          now,
          ownedUntil: now + 30000,
        }),
      );
      if (!acquired) continue;
      const result = yield* Effect.result(
        Effect.gen(function* () {
          yield* ensureEpoch(r.settings.memoryHubVersion);
          const ack = yield* r.connection
            ? client.push(r.connection, input)
            : hub.push(input, r.principal!);
          yield* ensureEpoch(r.settings.memoryHubVersion);
          const receipt = ack.receipts[0];
          if (
            ack.receipts.length !== 1 ||
            !receipt ||
            receipt.operationId !== acquired.operationId ||
            receipt.operationDigest !== acquired.operationDigest
          )
            return yield* new M.MemoryHubError({ code: "invalid_output" });
          yield* service.settleHubAcknowledgement({
            memorySpaceId: r.space!,
            hubEnvironmentId: r.hubId,
            localEnvironmentId: local,
            workId: acquired.workId,
            receipt,
            operation: acquired,
            reauthorize: ensureEpoch(r.settings.memoryHubVersion),
          });
        }),
      );
      if (result._tag === "Failure") {
        lastFailure = failureCode(result.failure);
        const time = yield* Clock.currentTimeMillis;
        yield* store.transact(
          store.retrySyncWorkTx({
            ownership: acquired,
            now: time,
            nextAttemptAt: transient(result.failure)
              ? time + Math.min(30000, 1000 * 2 ** Math.min(candidate.work.attempt, 5))
              : Number.MAX_SAFE_INTEGER,
            failureCode: lastFailure,
          }),
        );
      }
    }
  });
  const syncOnce = mutex.withPermit(
    Effect.gen(function* () {
      if (stopped) return;
      const r = yield* route();
      if (!r) return;
      for (const entry of executions.values())
        if (entry.epoch !== r.settings.memoryHubVersion && entry.fiber)
          yield* Fiber.interrupt(entry.fiber);
      const budget = { pages: 0, entries: 0 };
      if (!(yield* bootstrap(r, budget))) return;
      yield* pullTail(r, budget);
      yield* relay(r).pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            lastFailure = failureCode(e);
          }),
        ),
      );
      // Tail checkpoint S is incorporated before any local identity assignment or push.
      for (const intent of yield* store.listMaterializableIntents(local, 100)) {
        const assigned = yield* store.transact(
          store.assignIntentIdentityTx({
            environmentId: local,
            intentId: intent.intentId,
            memorySpaceId: r.space!,
            operationId: M.MemoryOperationId.make(uuid()),
            revisionId: M.MemoryRevisionId.make(uuid()),
          }),
        );
        yield* store.materializeLocalIntent({
          environmentId: local,
          intentId: intent.intentId,
          memorySpaceId: assigned.memorySpaceId,
          operationId: assigned.operationId,
          revisionId: assigned.revisionId,
        });
      }
      yield* push(r);
      yield* pullTail(r, budget);
      yield* sweep;
      lastSuccess = iso(yield* Clock.currentTimeMillis);
    }),
  );
  const guardedSync = syncOnce.pipe(
    Effect.catch((e) =>
      Effect.sync(() => {
        lastFailure = failureCode(e);
      }),
    ),
  );
  const shutdown = Effect.gen(function* () {
    stopped = true;
    for (const fiber of background) yield* Fiber.interrupt(fiber);
    for (const entry of [...executions.values()])
      if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
  });
  yield* Effect.addFinalizer(() => shutdown);
  const start = Effect.gen(function* () {
    if (started || stopped) return;
    started = true;
    const wakes = yield* store.subscribeWake.pipe(Effect.provideService(Scope.Scope, scope));
    const changes = yield* settings.subscribeChanges.pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    background.push(yield* Stream.runForEach(wakes, () => guardedSync).pipe(Effect.forkIn(scope)));
    background.push(
      yield* Stream.runForEach(changes, () => guardedSync).pipe(Effect.forkIn(scope)),
    );
    background.push(
      yield* Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(guardedSync))).pipe(
        Effect.forkIn(scope),
      ),
    );
    yield* guardedSync;
  });
  const readLocalReadiness = Effect.fnUntraced(function* () {
    const r = yield* route();
    if (!r?.space) return { memorySpaceId: null, bootstrap: "unbound" as const };
    return {
      memorySpaceId: r.space,
      bootstrap: (yield* runtime.readBootstrap(r.space, r.hubId)).state,
    };
  });
  return MemorySyncService.of({
    start,
    syncOnce,
    shutdown,
    scheduleConflictResolution: sweep,
    activeResolutions: Effect.sync(() => executions.size),
    readLocalReadiness,
    requireBootstrap: (space) =>
      readLocalReadiness().pipe(
        Effect.flatMap((r) =>
          r.memorySpaceId === space && r.bootstrap === "ready"
            ? Effect.void
            : Effect.fail(new M.MemoryHubError({ code: "bootstrap_required" })),
        ),
      ),
    getHubSettings: (_input, permit) =>
      permit.pipe(
        Effect.andThen(readSettings),
        Effect.map((s) => ({ settings: s.memoryHub, version: s.memoryHubVersion })),
      ),
    syncStatus: (_input, permit) =>
      Effect.gen(function* () {
        yield* permit;
        const r = yield* route();
        if (!r?.space) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
        const persisted = yield* runtime.readProcessing(r.space, r.hubId);
        const storage = yield* quota.readStorageStatus({
          memorySpaceId: r.space,
          environmentId: local,
        });
        yield* permit;
        return {
          memorySpaceId: r.space,
          state: lastFailure ? "offline" : "online",
          pendingSync: persisted.pendingSync,
          quarantined: persisted.quarantined,
          parked: persisted.parked,
          lastSuccessfulSyncAtUtc: lastSuccess,
          lastHubSequence: persisted.processing.lastReceivedHubSequence,
          storage,
          processing: persisted.processing,
          ...(lastFailure ? { failureCode: lastFailure } : {}),
        };
      }),
    readSource: (validated, permit) =>
      Effect.gen(function* () {
        yield* permit;
        const r = yield* route();
        if (!r || r.space !== validated.request.memorySpaceId)
          return yield* new M.MemoryHubError({ code: "space_mismatch" });
        const requested = yield* r.connection
          ? client.requestSourceRead(r.connection, validated.request)
          : hub.requestSourceRead(validated.request, r.principal!);
        const deadline = Math.min(
          (yield* Clock.currentTimeMillis) + 75000,
          Date.parse(requested.request.expiresAtHubTime),
        );
        while ((yield* Clock.currentTimeMillis) < deadline) {
          yield* permit;
          yield* ensureEpoch(r.settings.memoryHubVersion);
          yield* relay(r);
          const i = {
            protocolVersion: 1 as const,
            memorySpaceId: validated.request.memorySpaceId,
            requestId: validated.request.requestId,
          };
          const result = yield* r.connection
            ? client.resultSourceRead(r.connection, i)
            : hub.resultSourceRead(i, r.principal!);
          if (result.state === "completed")
            return yield* service.validateSourceOutcome(
              { request: validated, outcome: result.outcome },
              permit,
            );
          if (result.state === "expired") break;
          yield* Effect.sleep(Math.min(1000, deadline - (yield* Clock.currentTimeMillis)));
        }
        yield* permit;
        return { kind: "unavailable", code: "source_unavailable" } as const;
      }).pipe(
        Effect.catchTags({
          MemoryHubUnauthorizedError: () =>
            Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" })),
          MemoryHubForbiddenError: () =>
            Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" })),
        }),
      ),
  });
});

export const layer = Layer.effect(MemorySyncService, make);
