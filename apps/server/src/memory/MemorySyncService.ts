// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned submission IDs.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
      space: M.MemorySpaceId | null,
      hub: M.EnvironmentId | null,
    ) => Effect.Effect<
      {
        processing: M.MemoryProcessingStatus;
        pendingSync: number;
        quarantined: number;
        parked: number;
      },
      Store.MemoryStorageError
    >;
    /** Counter-backed global/local storage snapshot when no space is bound. */
    readonly readUnboundStorage: Effect.Effect<M.MemoryStorageStatus, Store.MemoryStorageError>;
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
    readonly updateHubSettings: (
      input: M.MemoryHubSettingsUpdateInput,
      permit: Permit,
    ) => Effect.Effect<
      M.MemoryHubSettingsUpdateResult,
      Hub.MemoryHubAdministrationError | Service.MemoryAccessError
    >;
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
const selectionKey = Schema.encodeSync(Schema.fromJsonString(M.MemoryModelSelection));
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
  const coordinator = yield* Semaphore.make(1);
  let cycle: Fiber.Fiber<void, Error> | null = null;
  let pendingSweep = false;
  let pendingSync = false;
  let cancelling = false;
  let statusEpoch: number | null = null;
  const registryMutex = yield* Semaphore.make(1);
  const owner = uuid();
  let stopped = false;
  let started = false;
  let reservations = 0;
  let lastSuccess: { epoch: number; at: string } | null = null;
  let lastFailure: { epoch: number; code: M.MemoryFailureCode } | undefined;
  const background: Fiber.Fiber<void, never>[] = [];
  // Slots remain reserved through persistence and bounded release in the outer finalizer.
  const executions = new Map<
    string,
    { epoch: number; ticket: M.MemoryResolutionLease; fiber: Fiber.Fiber<void, never> | null }
  >();
  const readSettings = settings.getSettings.pipe(
    Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
  );
  let settingsEpoch = (yield* readSettings).memoryHubVersion;
  const ensureEpoch = (epoch: number): Permit =>
    readSettings.pipe(
      Effect.flatMap((s) =>
        s.memoryHubVersion === epoch && !stopped
          ? Effect.void
          : Effect.fail(new Service.MemoryAccessError({ code: "fenced" })),
      ),
      Effect.mapError(() => new Service.MemoryAccessError({ code: "fenced" })),
    );
  const resetStatus = (epoch: number) => {
    if (statusEpoch !== epoch) {
      statusEpoch = epoch;
      lastFailure = undefined;
      lastSuccess = null;
    }
  };
  const noteFailure = Effect.fn("MemorySyncService.noteFailure")(
    function* (epoch: number, error: Error) {
      const s = yield* readSettings;
      if (!stopped && s.memoryHubVersion === epoch) {
        resetStatus(epoch);
        lastFailure = { epoch, code: failureCode(error) };
      }
    },
    (effect) => Effect.ignore(effect),
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
    ).pipe(
      Effect.interruptible,
      Effect.timeout("15 seconds"),
      Effect.map((result) => result.released),
      Effect.catch(() => Effect.succeed(false)),
    );
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
    let currentLease = initial.ticket;
    let renewalFailed = false;
    let definitiveFailure = false;
    const transition = Effect.fnUntraced(function* (
      state: Store.TicketState,
      approval?: M.MemoryHubReceipt,
      retireClaim?: { expectedGeneration: number; attemptId: string },
      relinquish = false,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const next = yield* store.transact(
        store.transitionResolutionTicketTx({
          ownership: ownership(row),
          nextState: state,
          now,
          ownedUntil:
            relinquish || state === "terminal" || state === "recoverable" || state === "submitting"
              ? null
              : now + 60000,
          nextAttemptAt: Math.max(
            renewalFailed ? Date.parse(currentLease.expiresAtHubTime) : 0,
            now +
              (relinquish || retireClaim || state === "recoverable" || state === "submitting"
                ? 30000
                : 0),
          ),
          ...(approval ? { approval } : {}),
          ...(retireClaim ? { retireClaim } : {}),
        }),
      );
      if (!next) return yield* new M.MemoryHubError({ code: "fenced" });
      row = { ...next, ticket: currentLease };
    });
    const refreshLease = Effect.fnUntraced(function* () {
      const current = currentLease;
      const input: M.MemoryHubRenewInput = {
        protocolVersion: 1,
        memorySpaceId: current.memorySpaceId,
        memoryId: current.memoryId,
        conflictId: current.conflictId,
        holderEnvironmentId: local,
        attemptId: current.attemptId,
        fencingToken: current.fencingToken,
      };
      const renewed = yield* (
        r.connection ? client.renew(r.connection, input) : hub.renew(input, r.principal!)
      ).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            renewalFailed = true;
          }),
        ),
      );

      yield* ensureEpoch(r.settings.memoryHubVersion);
      if (
        renewed.memorySpaceId !== current.memorySpaceId ||
        renewed.memoryId !== current.memoryId ||
        renewed.conflictId !== current.conflictId ||
        renewed.holderEnvironmentId !== local ||
        renewed.attemptId !== current.attemptId ||
        renewed.fencingToken !== current.fencingToken ||
        renewed.claimedAtHubTime !== current.claimedAtHubTime ||
        renewed.attemptDeadlineHubTime !== current.attemptDeadlineHubTime ||
        !sameHeads(renewed.conflictHeadSet, current.conflictHeadSet) ||
        selectionKey(renewed.frozenDefaultModelSelection) !==
          selectionKey(current.frozenDefaultModelSelection)
      )
        return yield* new M.MemoryHubError({ code: "fenced" });
      currentLease = renewed;
      row = { ...row, ticket: renewed };
      const slot = executions.get(renewed.memoryId);
      if (slot) slot.ticket = renewed;
    });
    const settle = Effect.fnUntraced(function* (receipt: M.MemoryHubReceipt) {
      if (!row.submission) return yield* new M.MemoryHubError({ code: "invalid_output" });
      const operation = row.submission.operation;
      const candidate = (yield* store.readDueClaimCandidates(100, Number.MAX_SAFE_INTEGER)).find(
        (work) =>
          work.memoryId === row.ticket.memoryId &&
          work.metadata.kind === "claim" &&
          sameHeads(work.metadata.sortedHeads, row.ticket.conflictHeadSet),
      );
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
      if (candidate) yield* store.completeClaimCandidate(candidate.id);
    });
    const execute = Effect.gen(function* () {
      yield* ensureEpoch(r.settings.memoryHubVersion);
      if (row.approval) {
        yield* settle(row.approval);
        return;
      }
      if (!row.submission) {
        yield* transition("running");
        yield* refreshLease();
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
          while (true) {
            yield* Effect.sleep("30 seconds");
            yield* ensureEpoch(r.settings.memoryHubVersion);
            yield* eligibility(row.ticket);
            yield* refreshLease();
            yield* transition("running");
          }
        });
        yield* ensureEpoch(r.settings.memoryHubVersion);
        yield* eligibility(row.ticket);
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
          // Member time schedules cancellation only; Hub remains the admission authority.
          Effect.timeout(
            Math.max(
              0,
              Date.parse(currentLease.attemptDeadlineHubTime) - (yield* Clock.currentTimeMillis),
            ),
          ),
          Effect.catchTags({
            TimeoutError: () => Effect.fail(new M.MemoryHubError({ code: "lease_expired" })),
          }),
        );
        const trusted = yield* decodeGenerated(generated).pipe(
          Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
        );
        if (
          trusted.execution.environmentId !== local ||
          selectionKey(trusted.execution.requestedModelSelection) !==
            selectionKey(row.ticket.frozenDefaultModelSelection) ||
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
      Effect.tapError((error) =>
        Effect.sync(() => {
          definitiveFailure = !row.submission && !transient(error);
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          const released = yield* release(r, row.ticket);
          if (row.state !== "terminal") {
            if (definitiveFailure && released) {
              const candidates = yield* store.readDueClaimCandidates(100, Number.MAX_SAFE_INTEGER);
              const candidate = candidates.find(
                (work) => work.memoryId === row.ticket.memoryId && work.metadata.kind === "claim",
              );
              if (candidate?.metadata.kind === "claim") {
                const retired = yield* Effect.result(
                  transition("terminal", undefined, {
                    expectedGeneration: candidate.metadata.generation ?? 0,
                    attemptId: row.ticket.attemptId,
                  }),
                );
                if (retired._tag === "Success") return;
              }
            }
            {
              // Unknown apply outcomes and known approvals retain the immutable submission.
              yield* transition(
                row.submission ? (row.approval ? "approved" : "submitting") : "recoverable",
                undefined,
                undefined,
                true,
              ).pipe(Effect.ignore);
            }
          }
        }).pipe(Effect.ignore),
      ),
    );
  });

  const register = Effect.fnUntraced(function* (r: Route, saved: Store.TicketRow) {
    if (
      stopped ||
      cancelling ||
      executions.size >= 4 ||
      executions.has(saved.ticket.memoryId) ||
      saved.ticket.holderEnvironmentId !== local ||
      saved.ticket.memorySpaceId !== r.space
    )
      return;
    executions.set(saved.ticket.memoryId, {
      epoch: r.settings.memoryHubVersion,
      ticket: saved.ticket,
      fiber: null,
    });
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
        if (
          stopped ||
          (yield* Effect.result(ensureEpoch(r.settings.memoryHubVersion)))._tag === "Failure"
        ) {
          yield* store
            .transact(
              store.transitionResolutionTicketTx({
                ownership: ownership(acquired),
                nextState: "recoverable",
                now,
                ownedUntil: null,
                nextAttemptAt: now + 30000,
              }),
            )
            .pipe(Effect.ignore);
          yield* release(r, acquired.ticket);
          executions.delete(saved.ticket.memoryId);
          return;
        }
        const fiber = yield* restore(runClaimedResolution(r, acquired)).pipe(
          Effect.catch((e) => noteFailure(r.settings.memoryHubVersion, e)),
          Effect.ensuring(
            Effect.sync(() => {
              executions.delete(saved.ticket.memoryId);
            }),
          ),
          Effect.ensuring(store.wake),
          Effect.ensuring(
            Effect.suspend(() => requestCycle(sweep, true)).pipe(
              Effect.ignore,
              Effect.forkIn(scope),
              Effect.asVoid,
            ),
          ),
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
  const sweep: Effect.Effect<void, Error> = registryMutex.withPermit(
    Effect.gen(function* () {
      const r = yield* route();
      if (!r || !r.space || stopped || cancelling) return;
      yield* ensureEpoch(r.settings.memoryHubVersion);
      const now = yield* Clock.currentTimeMillis;
      // The current L1 recovery sweep cancels all resolve rows; do not destroy a durable ticket.
      // L1 must make that sweep frontier-aware before concurrent new-conflict recovery is enabled.
      const existing = yield* store.readRecoverableResolutionTickets({
        now: Number.MAX_SAFE_INTEGER,
        limit: 100,
      });
      if (existing.length === 0 && executions.size === 0) yield* store.recoverClaimCandidates(now);
      const saved = yield* store.readRecoverableResolutionTickets({ now, limit: 100 });
      for (const ticket of saved) yield* register(r, ticket);
      const candidates = yield* store.readDueClaimCandidates(100, now);
      for (const work of candidates) {
        if (executions.size + reservations >= 4) break;
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
        let reserved = false;
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
            if (!(yield* store.claimCandidate(work.id, r.settings.memoryHubVersion, now))) return;
            reservations++;
            reserved = true;
            yield* ensureEpoch(r.settings.memoryHubVersion);
            const ticket = yield* r.connection
              ? client.claim(r.connection, frozen.claim)
              : hub.claim(frozen.claim, r.principal!);
            yield* ensureEpoch(r.settings.memoryHubVersion);
            if (
              ticket.memorySpaceId !== r.space ||
              ticket.memoryId !== work.memoryId ||
              ticket.holderEnvironmentId !== local ||
              ticket.conflictId !== frozen.claim.conflictId ||
              ticket.attemptId !== frozen.claim.attemptId ||
              !sameHeads(ticket.conflictHeadSet, frozen.claim.conflictHeadSet) ||
              selectionKey(ticket.frozenDefaultModelSelection) !==
                selectionKey(frozen.claim.frozenDefaultModelSelection)
            )
              return yield* new M.MemoryHubError({ code: "invalid_output" });
            yield* store.persistResolutionTicket(ticket);
            yield* store.retryClaimCandidate(
              work.id,
              Date.parse(ticket.expiresAtHubTime),
              "lease_required",
            );
            reservations--;
            reserved = false;
            for (const row of yield* store.readRecoverableResolutionTickets({
              now: yield* Clock.currentTimeMillis,
              limit: 100,
            }))
              if (row.ticket.attemptId === ticket.attemptId) yield* register(r, row);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (reserved) reservations--;
              }),
            ),
          ),
        );
        if (attempt._tag === "Failure") {
          yield* ensureEpoch(r.settings.memoryHubVersion);
          yield* noteFailure(r.settings.memoryHubVersion, attempt.failure);
          const code = failureCode(attempt.failure);
          const knownExpiry =
            code === "claim_busy"
              ? (yield* store.loadAggregate(r.space, work.memoryId!)).fence?.activeLease
                  ?.expiresAtHubTime
              : undefined;
          yield* store.retryClaimCandidate(
            work.id,
            now +
              (code === "claim_busy"
                ? 30000
                : Math.min(600000, [5000, 30000, 120000, 600000][Math.min(work.attempt, 3)]!)),
            code,
            knownExpiry === undefined ? undefined : Date.parse(knownExpiry),
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
  const relayMutex = yield* Semaphore.make(1);
  // One relay cycle at a time, at most 32 items, 15s total including permits and transport.
  const relay = (r: Route) =>
    relayMutex
      .withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* store.transact(
            store.purgeHubTransientTx({ memorySpaceId: r.space!, now, limit: 100 }),
          );
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
              const outcome = yield* runtime.ownerReader.readCommitted(request, permit).pipe(
                Effect.timeout("15 seconds"),
                Effect.catchTags({
                  TimeoutError: () =>
                    Effect.succeed({ kind: "unavailable", code: "source_unavailable" } as const),
                }),
              );
              yield* permit;
              if (Date.parse(request.expiresAtHubTime) <= (yield* Clock.currentTimeMillis)) return;
              const checked = yield* decodeSource(outcome).pipe(
                Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
              );
              if (
                checked.kind === "available" &&
                (checked.page.sourceThread.environmentId !== request.sourceThread.environmentId ||
                  checked.page.sourceThread.threadId !== request.sourceThread.threadId ||
                  checked.page.watermark.fromEventId !== request.sourceWatermark.fromEventId ||
                  checked.page.watermark.toEventId !== request.sourceWatermark.toEventId ||
                  checked.page.watermark.throughSequence !==
                    request.sourceWatermark.throughSequence ||
                  checked.page.messages.length > request.limit ||
                  checked.page.messages.some(
                    (message) => !request.messageIds.includes(message.messageId),
                  ))
              )
                return yield* new M.MemoryHubError({ code: "source_invalidated" });
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
            }).pipe(Effect.catch((e) => noteFailure(r.settings.memoryHubVersion, e)));
          }
        }),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.catchTags({
          TimeoutError: () => Effect.void,
        }),
      );
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
        yield* ensureEpoch(r.settings.memoryHubVersion);
        yield* noteFailure(r.settings.memoryHubVersion, result.failure);
        const time = yield* Clock.currentTimeMillis;
        yield* store.transact(
          store.retrySyncWorkTx({
            ownership: acquired,
            now: time,
            nextAttemptAt: transient(result.failure)
              ? time + Math.min(30000, 1000 * 2 ** Math.min(candidate.work.attempt, 5))
              : Number.MAX_SAFE_INTEGER,
            failureCode: failureCode(result.failure),
          }),
        );
      }
    }
  });
  const syncCycle = mutex.withPermit(
    Effect.gen(function* () {
      if (stopped) return;
      const s = yield* readSettings;
      resetStatus(s.memoryHubVersion);
      const r = yield* route();
      if (!r) {
        for (const entry of executions.values())
          if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
        return;
      }
      for (const entry of executions.values())
        if (entry.epoch !== r.settings.memoryHubVersion && entry.fiber)
          yield* Fiber.interrupt(entry.fiber);
      lastFailure = undefined;
      const budget = { pages: 0, entries: 0 };
      if (!(yield* bootstrap(r, budget)) || budget.pages >= 10) return;
      yield* pullTail(r, budget);
      for (const entry of executions.values()) {
        if (entry.fiber && (yield* Effect.result(eligibility(entry.ticket)))._tag === "Failure")
          yield* Fiber.interrupt(entry.fiber);
      }
      yield* relay(r).pipe(Effect.catch((e) => noteFailure(r.settings.memoryHubVersion, e)));
      yield* ensureEpoch(r.settings.memoryHubVersion);
      // Tail checkpoint S is incorporated before any local identity assignment or push.
      for (const intent of yield* store.listMaterializableIntents(local, 100)) {
        yield* ensureEpoch(r.settings.memoryHubVersion);
        const assigned = yield* store.transact(
          store.assignIntentIdentityTx({
            environmentId: local,
            intentId: intent.intentId,
            memorySpaceId: r.space!,
            operationId: M.MemoryOperationId.make(uuid()),
            revisionId: M.MemoryRevisionId.make(uuid()),
          }),
        );
        // L1 exact admission + canonical/outbox commit + intent completion port is pending.
        // This materialization returns an operation only; it does not complete the intent.
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
      yield* ensureEpoch(r.settings.memoryHubVersion);
      lastSuccess = { epoch: r.settings.memoryHubVersion, at: iso(yield* Clock.currentTimeMillis) };
    }),
  );
  // A single tracked cycle includes manual sync and registry sweeps. Waiters coalesce;
  // A pending full sync outranks a completion sweep; both are single coalesced hints.
  const requestCycle = (effect: Effect.Effect<void, Error>, sweepOnly = false, wait = true) =>
    Effect.gen(function* () {
      const active = yield* coordinator.withPermit(
        Effect.gen(function* () {
          if (stopped || cancelling) return null;
          if (cycle) {
            if (sweepOnly) pendingSweep = true;
            else pendingSync = true;
            return cycle;
          }
          const epoch = (yield* readSettings).memoryHubVersion;
          resetStatus(epoch);
          cycle = yield* Effect.gen(function* () {
            yield* effect;
            while (pendingSync || pendingSweep) {
              if (stopped || cancelling) break;
              yield* ensureEpoch(epoch);
              if (pendingSync) {
                pendingSync = false;
                pendingSweep = false;
                yield* syncCycle;
              } else {
                pendingSweep = false;
                yield* sweep;
              }
            }
          }).pipe(
            Effect.tapError((e) => noteFailure(epoch, e)),
            Effect.ensuring(
              Effect.sync(() => {
                cycle = null;
              }),
            ),
            Effect.forkIn(scope),
          );
          return cycle;
        }),
      );
      if (!active || !wait) return;
      const exit = yield* Fiber.await(active);
      if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause))
        return yield* Effect.failCause(exit.cause);
    });
  const syncOnce = requestCycle(syncCycle);
  const guardedSync = syncOnce.pipe(Effect.ignore);
  const cancelEpoch = coordinator.withPermit(
    Effect.gen(function* () {
      cancelling = true;
      pendingSweep = false;
      pendingSync = false;
      const active = cycle;
      // No sync/registry mutex is held while cancellation is requested. Cycle interruption
      // finishes any registration reservation first; matching release has a 15s bound.
      yield* Fiber.interruptAll([
        ...(active ? [active] : []),
        ...[...executions.values()].flatMap((e) => (e.fiber ? [e.fiber] : [])),
      ]);
      const s = yield* readSettings.pipe(Effect.catch(() => Effect.succeed(null)));
      if (s) {
        settingsEpoch = s.memoryHubVersion;
        resetStatus(s.memoryHubVersion);
      }
      cancelling = false;
    }),
  );
  const shutdown = Effect.gen(function* () {
    stopped = true;
    yield* cancelEpoch;
    yield* Fiber.interruptAll(background);
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
      yield* Stream.runForEach(changes, (s) =>
        Effect.gen(function* () {
          if (s.memoryHubVersion !== settingsEpoch) yield* cancelEpoch;
          // Do not block the settings consumer on the next transport.
          yield* requestCycle(syncCycle, false, false).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkIn(scope)),
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
    scheduleConflictResolution: requestCycle(sweep, true),
    activeResolutions: Effect.sync(() => executions.size + reservations),
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
    updateHubSettings: (input, permit) =>
      Effect.gen(function* () {
        yield* permit;
        const admin = yield* Effect.serviceOption(Hub.MemoryHubAdministrator);
        if (Option.isNone(admin)) return yield* new M.MemoryHubError({ code: "route_unavailable" });
        const result = yield* admin.value.update(
          input,
          permit.pipe(Effect.mapError(() => new M.MemoryHubForbiddenError({}))),
        );
        yield* guardedSync;
        return result;
      }),
    syncStatus: (_input, permit) =>
      Effect.gen(function* () {
        yield* permit;
        const s = yield* readSettings;
        const epoch = s.memoryHubVersion;
        resetStatus(epoch);
        const space = s.memoryHub.mode === "disabled" ? null : s.memoryHub.memorySpaceId;
        const hubId = s.memoryHub.mode === "member" ? s.memoryHub.hubEnvironmentId : local;
        const bootstrap = space ? (yield* runtime.readBootstrap(space, hubId)).state : "unbound";
        const persisted = yield* runtime.readProcessing(space, space ? hubId : null);
        const storage = space
          ? yield* quota.readStorageStatus({ memorySpaceId: space, environmentId: local })
          : yield* runtime.readUnboundStorage;
        yield* permit;
        const current = yield* readSettings;
        if (current.memoryHubVersion !== epoch)
          return yield* new M.MemoryHubError({ code: "fenced" });
        const failure = lastFailure?.epoch === epoch ? lastFailure.code : undefined;
        const success = lastSuccess?.epoch === epoch ? lastSuccess.at : null;
        return {
          memorySpaceId: space,
          state:
            s.memoryHub.mode === "disabled"
              ? "disabled"
              : bootstrap !== "ready"
                ? "bootstrapping"
                : failure
                  ? "offline"
                  : "online",
          pendingSync: persisted.pendingSync,
          quarantined: persisted.quarantined,
          parked: persisted.parked,
          lastSuccessfulSyncAtUtc: success,
          lastHubSequence: persisted.processing.lastReceivedHubSequence,
          storage,
          processing: persisted.processing,
          ...(failure ? { failureCode: failure } : {}),
        };
      }),
    readSource: (validated, permit) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        return yield* Effect.gen(function* () {
          yield* permit;
          const r = yield* route();
          if (!r || r.space !== validated.request.memorySpaceId)
            return yield* new M.MemoryHubError({ code: "space_mismatch" });
          yield* service.validateSourceOutcome(
            { request: validated, outcome: { kind: "unavailable", code: "source_unavailable" } },
            permit,
          );
          const requested = yield* r.connection
            ? client.requestSourceRead(r.connection, validated.request)
            : hub.requestSourceRead(validated.request, r.principal!);
          yield* ensureEpoch(r.settings.memoryHubVersion);
          const deadline = Math.min(
            startedAt + 75000,
            Date.parse(requested.request.expiresAtHubTime),
          );
          return yield* Effect.gen(function* () {
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
              yield* ensureEpoch(r.settings.memoryHubVersion);
              if ((yield* Clock.currentTimeMillis) >= deadline) break;
              if (result.state === "completed")
                return yield* service.validateSourceOutcome(
                  { request: validated, outcome: result.outcome },
                  permit,
                );
              if (result.state === "expired") break;
              yield* Effect.sleep(Math.min(1000, deadline - (yield* Clock.currentTimeMillis)));
            }
            return { kind: "unavailable", code: "source_unavailable" } as const;
          }).pipe(Effect.timeout(Math.max(0, deadline - (yield* Clock.currentTimeMillis))));
        }).pipe(Effect.timeout(Math.max(0, startedAt + 75000 - (yield* Clock.currentTimeMillis))));
      }).pipe(
        Effect.catchTags({
          TimeoutError: () =>
            Effect.succeed({ kind: "unavailable", code: "source_unavailable" } as const),
        }),
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
