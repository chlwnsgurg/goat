// @effect-diagnostics-next-line nodeBuiltinImport:off -- server-owned checkpoint identifiers.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";

export type MemoryHubServiceError =
  | Service.MemoryServiceError
  | M.MemoryHubError
  | M.MemoryHubUnauthorizedError
  | M.MemoryHubForbiddenError;

/** The settings owner supplies a live read; it is repeated after the SQL lock. */
export class MemoryHubConfiguration extends Context.Service<
  MemoryHubConfiguration,
  {
    readonly read: Effect.Effect<
      { memorySpaceId: M.MemorySpaceId; hubEnvironmentId: M.EnvironmentId } | null,
      M.MemoryHubError
    >;
  }
>()("goat/memory/MemoryHubService/MemoryHubConfiguration") {}

export class MemoryHubService extends Context.Service<
  MemoryHubService,
  {
    readonly join: (
      input: M.MemoryHubJoinInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubJoinResult, MemoryHubServiceError>;
    readonly push: (
      input: M.MemoryHubPushInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubPushResult, MemoryHubServiceError>;
    readonly pull: (
      input: M.MemoryHubPullInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubPullResult, MemoryHubServiceError>;
    readonly claim: (
      input: M.MemoryHubClaimInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryResolutionLease, MemoryHubServiceError>;
    readonly renew: (
      input: M.MemoryHubRenewInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryResolutionLease, MemoryHubServiceError>;
    readonly release: (
      input: M.MemoryHubReleaseInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubReleaseResult, MemoryHubServiceError>;
    readonly applyResolution: (
      input: M.MemoryHubApplyResolutionInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubReceipt, MemoryHubServiceError>;
    readonly requestSourceRead: (
      input: M.MemoryHubSourceReadRequestInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadRequestResult, MemoryHubServiceError>;
    readonly collectSourceReads: (
      input: M.MemoryHubSourceReadCollectInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadCollectResult, MemoryHubServiceError>;
    readonly respondSourceRead: (
      input: M.MemoryHubSourceReadRespondInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadRespondResult, MemoryHubServiceError>;
    readonly resultSourceRead: (
      input: M.MemoryHubSourceReadResultInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadResultResult, MemoryHubServiceError>;
    readonly readStorageStatus: (
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryStorageStatus, MemoryHubServiceError>;
  }
>()("goat/memory/MemoryHubService") {}

/** @public Canonical service construction for application-owned layer composition. */
export const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const service = yield* Service.MemoryService;
  const quota = yield* Quota.MemoryQuotaService;
  const configuration = yield* MemoryHubConfiguration;
  const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
    );
  const checkConfiguration = Effect.fnUntraced(function* (principal: M.MemoryHubPrincipal) {
    const hub = yield* configuration.read;
    if (!hub) return yield* new M.MemoryHubError({ code: "hub_disabled" });
    if (hub.memorySpaceId !== principal.memorySpaceId)
      return yield* new M.MemoryHubError({ code: "space_mismatch" });
    return hub;
  });
  const authority = (principal: M.MemoryHubPrincipal): Store.HubAuthority => ({
    principal,
    now: Clock.currentTimeMillis,
    reauthorize: Effect.gen(function* () {
      // An operation batch cannot outlive a hub disable/space change between items.
      yield* checkConfiguration(principal).pipe(
        Effect.mapError(() => new M.MemoryHubForbiddenError({})),
      );
      yield* store.requireHubMemberTx(principal);
    }),
  });
  const authorize = Effect.fnUntraced(function* (
    principal: M.MemoryHubPrincipal,
    space: M.MemorySpaceId | null,
    environment?: M.EnvironmentId,
  ) {
    const hub = yield* checkConfiguration(principal);
    yield* store.requireHubMemberTx(principal);
    if (space !== null && space !== principal.memorySpaceId)
      return yield* new M.MemoryHubError({ code: "space_mismatch" });
    if (environment !== undefined && environment !== principal.environmentId)
      return yield* new M.MemoryHubForbiddenError({});
    return hub;
  });
  const join: MemoryHubService["Service"]["join"] = Effect.fn("MemoryHubService.join")(
    function* (input, principal) {
      const request = yield* decode(M.MemoryHubJoinInput, input);
      return yield* store.transact(
        Effect.gen(function* () {
          const hub = yield* authorize(principal, request.memorySpaceId, request.environmentId);
          const retention = yield* store.readHubRetentionTx(principal.memorySpaceId);
          if (!retention.checkpointId || !retention.causalBoundary)
            return yield* new M.MemoryHubError({ code: "bootstrap_required" });
          const handle = yield* store.prepareHubCheckpointTx({
            authority: authority(principal),
            checkpointId: retention.checkpointId,
            snapshotToken: NodeCrypto.randomBytes(32).toString("base64url"),
            hubEnvironmentId: hub.hubEnvironmentId,
          });
          return {
            protocolVersion: 1 as const,
            memorySpaceId: principal.memorySpaceId,
            hubEnvironmentId: hub.hubEnvironmentId,
            checkpointSequence: handle.checkpointSequence,
            snapshotToken: handle.snapshotToken,
            causalBoundary: retention.causalBoundary,
            retentionFloor: handle.retentionFloor,
          };
        }),
      );
    },
  );
  const push: MemoryHubService["Service"]["push"] = Effect.fn("MemoryHubService.push")(
    function* (input, principal) {
      const request = yield* decode(M.MemoryHubPushInput, input);
      yield* store.transact(authorize(principal, request.memorySpaceId, request.environmentId));
      const receipts = yield* Effect.forEach(request.operations, (operation) =>
        // This entry owns rollback and the separate null-sequence capacity-refusal read.
        service.admitHubOperation({ authority: authority(principal), operation }),
      );
      return { receipts };
    },
  );
  const pull: MemoryHubService["Service"]["pull"] = Effect.fn("MemoryHubService.pull")(
    function* (input, principal) {
      const request = yield* decode(M.MemoryHubPullInput, input);
      return yield* store.transact(
        Effect.gen(function* () {
          yield* authorize(principal, request.memorySpaceId, request.environmentId);
          if (request.snapshotToken !== undefined) {
            const page = yield* store.readHubCheckpointPageTx({
              authority: authority(principal),
              snapshotToken: request.snapshotToken,
              cursor: request.cursor ?? null,
            });
            return {
              highWatermark: page.checkpointSequence,
              throughSequence: page.checkpointSequence,
              hasMore: !page.bootstrapComplete,
              entries: [],
              checkpoint: page,
            };
          }
          return yield* store.readHubTailTx({
            memorySpaceId: request.memorySpaceId,
            afterSequence: request.afterSequence,
            highWatermark: request.highWatermark ?? null,
            limit: request.limit,
            maxBytes: M.MEMORY_PAGE_MAX_UTF8_BYTES,
          });
        }),
      );
    },
  );
  const lease = Effect.fnUntraced(function* (
    request: M.MemoryHubClaimInput | M.MemoryHubRenewInput | M.MemoryHubReleaseInput,
    principal: M.MemoryHubPrincipal,
    kind: "claim" | "renew" | "release",
  ) {
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId, request.holderEnvironmentId);
        // The discriminated Store action retains the frozen request shape.
        if (kind === "claim")
          return yield* store.transitionHubLeaseTx({
            authority: authority(principal),
            action: { kind, request: yield* decode(M.MemoryHubClaimInput, request) },
          });
        if (kind === "renew")
          return yield* store.transitionHubLeaseTx({
            authority: authority(principal),
            action: { kind, request: yield* decode(M.MemoryHubRenewInput, request) },
          });
        return yield* store.transitionHubLeaseTx({
          authority: authority(principal),
          action: { kind, request: yield* decode(M.MemoryHubReleaseInput, request) },
        });
      }),
    );
  });
  const claim: MemoryHubService["Service"]["claim"] = Effect.fn("MemoryHubService.claim")(
    function* (input, principal) {
      const result = yield* lease(yield* decode(M.MemoryHubClaimInput, input), principal, "claim");
      if (!result || !("fencingToken" in result))
        return yield* new M.MemoryHubError({ code: "lease_required" });
      return result;
    },
  );
  const renew: MemoryHubService["Service"]["renew"] = Effect.fn("MemoryHubService.renew")(
    function* (input, principal) {
      const result = yield* lease(yield* decode(M.MemoryHubRenewInput, input), principal, "renew");
      if (!result || !("fencingToken" in result))
        return yield* new M.MemoryHubError({ code: "lease_required" });
      return result;
    },
  );
  const release: MemoryHubService["Service"]["release"] = Effect.fn("MemoryHubService.release")(
    function* (input, principal) {
      const result = yield* lease(
        yield* decode(M.MemoryHubReleaseInput, input),
        principal,
        "release",
      );
      if (!result || !("released" in result))
        return yield* new M.MemoryHubError({ code: "lease_required" });
      return result;
    },
  );
  const applyResolution: MemoryHubService["Service"]["applyResolution"] = Effect.fn(
    "MemoryHubService.applyResolution",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubApplyResolutionInput, input);
    yield* store.transact(authorize(principal, request.memorySpaceId, request.holderEnvironmentId));
    return yield* service.admitHubOperation({
      authority: authority(principal),
      operation: request.operation,
      resolutionRequest: request,
    });
  });
  const requestSourceRead: MemoryHubService["Service"]["requestSourceRead"] = Effect.fn(
    "MemoryHubService.requestSourceRead",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubSourceReadRequestInput, input);
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId);
        return yield* store.requestHubSourceReadTx(authority(principal), request);
      }),
    );
  });
  const collectSourceReads: MemoryHubService["Service"]["collectSourceReads"] = Effect.fn(
    "MemoryHubService.collectSourceReads",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubSourceReadCollectInput, input);
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId);
        return yield* store.collectHubSourceReadsTx(authority(principal), request);
      }),
    );
  });
  const respondSourceRead: MemoryHubService["Service"]["respondSourceRead"] = Effect.fn(
    "MemoryHubService.respondSourceRead",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubSourceReadRespondInput, input);
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId);
        return yield* store.respondHubSourceReadTx(authority(principal), request);
      }),
    );
  });
  const resultSourceRead: MemoryHubService["Service"]["resultSourceRead"] = Effect.fn(
    "MemoryHubService.resultSourceRead",
  )(function* (input, principal) {
    const request = yield* decode(M.MemoryHubSourceReadResultInput, input);
    return yield* store.transact(
      Effect.gen(function* () {
        yield* authorize(principal, request.memorySpaceId);
        return yield* store.resultHubSourceReadTx(authority(principal), request);
      }),
    );
  });
  const readStorageStatus: MemoryHubService["Service"]["readStorageStatus"] = Effect.fn(
    "MemoryHubService.readStorageStatus",
  )(function* (principal) {
    const hub = yield* store.transact(authorize(principal, principal.memorySpaceId));
    return yield* quota.readStorageStatus({
      memorySpaceId: principal.memorySpaceId,
      environmentId: hub.hubEnvironmentId,
    });
  });
  return MemoryHubService.of({
    join,
    push,
    pull,
    claim,
    renew,
    release,
    applyResolution,
    requestSourceRead,
    collectSourceReads,
    respondSourceRead,
    resultSourceRead,
    readStorageStatus,
  });
});

export const layer = Layer.effect(MemoryHubService, make);
