// @effect-diagnostics-next-line nodeBuiltinImport:off -- server-owned checkpoint identifiers.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Secrets from "../auth/ServerSecretStore.ts";
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

/** Commit notifications include semantic refusals that do not change a memory item. */
export class MemoryHubActivity extends Context.Service<
  MemoryHubActivity,
  {
    readonly notify: Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("goat/memory/MemoryHubService/MemoryHubActivity") {}

export const activityLayer = Layer.effect(
  MemoryHubActivity,
  Effect.gen(function* () {
    const events = yield* PubSub.dropping<void>(1);
    return MemoryHubActivity.of({
      notify: Effect.asVoid(PubSub.publish(events, undefined)),
      subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
    });
  }),
);

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
  const activity = yield* MemoryHubActivity;
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
        service
          .admitHubOperation({ authority: authority(principal), operation })
          .pipe(Effect.tap(() => activity.notify)),
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
    return yield* service
      .admitHubOperation({
        authority: authority(principal),
        operation: request.operation,
        resolutionRequest: request,
      })
      .pipe(Effect.tap(() => activity.notify));
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

export type MemoryHubAdministrationError = MemoryHubServiceError | Secrets.SecretStoreError;
type AdminPermit = Effect.Effect<void, M.MemoryHubForbiddenError>;
type SafeAdminResult = Omit<M.MemoryHubSettingsUpdateResult, "credential">;

/** L3 binds the existing settings admin lock and dedicated idempotent settings CAS. */
export class MemoryHubAdminSettings extends Context.Service<
  MemoryHubAdminSettings,
  {
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly read: Effect.Effect<M.MemoryHubSettingsView, M.MemoryHubError>;
    readonly apply: (
      record: Store.AdminRecord,
      permit: AdminPermit,
    ) => Effect.Effect<SafeAdminResult, M.MemoryHubError | M.MemoryHubForbiddenError>;
  }
>()("goat/memory/MemoryHubService/MemoryHubAdminSettings") {}

/** Owner administration is separate from the memory:sync member principal. */
export class MemoryHubAdministrator extends Context.Service<
  MemoryHubAdministrator,
  {
    readonly update: (
      input: M.MemoryHubSettingsUpdateInput,
      permit: AdminPermit,
    ) => Effect.Effect<M.MemoryHubSettingsUpdateResult, MemoryHubAdministrationError>;
    readonly pending: (
      permit: AdminPermit,
    ) => Effect.Effect<readonly Store.AdminRecord[], MemoryHubAdministrationError>;
  }
>()("goat/memory/MemoryHubService/MemoryHubAdministrator") {}

/** @public Shares SQL/secret/settings owners without holding SQL across file writes. */
export const makeAdministrator = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const secrets = yield* Secrets.ServerSecretStore;
  const settings = yield* MemoryHubAdminSettings;
  const encode = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubSettingsUpdateInput));
  const decode = Schema.decodeUnknownEffect(M.MemoryHubSettingsUpdateInput);
  const tx = <A, E, R>(permit: AdminPermit, effect: Effect.Effect<A, E, R>) =>
    store.transact(Effect.andThen(permit, effect));
  const update: MemoryHubAdministrator["Service"]["update"] = Effect.fn(
    "MemoryHubAdministrator.update",
  )(function* (input, permit) {
    const request = yield* decode(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
    );
    const digest = NodeCrypto.createHash("sha256")
      .update(
        yield* encode(request).pipe(
          Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
        ),
      )
      .digest("hex");
    return yield* settings.withLock(
      Effect.gen(function* () {
        yield* permit;
        let record = yield* tx(permit, store.readHubAdminTx(request.requestId));
        if (record && record.requestDigest !== digest)
          return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
        const outgoing =
          request.action === "provisionMember" || request.action === "rotateMemberCredential";
        if (!record || record.stage === "prepared") {
          // An activated request must finish its settings CAS before another admin
          // can change membership. A full bounded page is conservatively blocked.
          const pending = yield* tx(
            permit,
            store.readPendingHubAdmins(M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS),
          );
          if (
            pending.length === M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS ||
            pending.some(
              (other) => other.requestId !== request.requestId && other.stage === "activated",
            )
          )
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          const view = yield* settings.read;
          if (view.version !== request.expectedVersion)
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        }
        if (!record) {
          const view = yield* settings.read;
          if (view.version !== request.expectedVersion)
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          let action: Store.PersistedAdminAction;
          if (request.action === "installCredential") {
            const { credential: _credential, ...safe } = request;
            if (!/^[A-Za-z0-9_-]{43}$/.test(request.credential))
              return yield* new M.MemoryHubError({ code: "invalid_output" });
            action = safe;
          } else action = request;
          record = yield* tx(
            permit,
            store.writeHubAdminTx({
              record: {
                requestId: request.requestId,
                requestDigest: digest,
                expectedVersion: request.expectedVersion,
                action,
                stage: "prepared",
                memberVersion: null,
                result: null,
                secretName:
                  outgoing || request.action === "installCredential"
                    ? `memory-hub-${request.action === "installCredential" ? "installed" : "outgoing"}-${request.requestId}`
                    : null,
              },
              expectedStage: null,
            }),
          );
        }
        if (record.stage === "prepared") {
          yield* permit;
          if (request.action === "installCredential") {
            // Retry stages identical bytes to the same private reference.
            yield* secrets.set(record.secretName!, new TextEncoder().encode(request.credential));
          }
          if (outgoing || request.action === "revokeMember") {
            const view = yield* settings.read;
            if (view.settings.mode !== "hub" || view.settings.memorySpaceId === null)
              return yield* new M.MemoryHubError({ code: "hub_disabled" });
            const memorySpaceId = view.settings.memorySpaceId;
            const environmentId = request.environmentId;
            let credentialDigest: string | null = null;
            if (outgoing) {
              const bytes = yield* secrets.getOrCreateRandom(record.secretName!, 32);
              credentialDigest = NodeCrypto.createHash("sha256")
                .update(Buffer.from(bytes).toString("base64url"))
                .digest("hex");
            }
            yield* tx(
              permit,
              Effect.gen(function* () {
                const member = yield* store.readHubMember(memorySpaceId, environmentId);
                if (request.action === "provisionMember" && member)
                  return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
                if (request.action !== "provisionMember" && !member)
                  return yield* new Store.MemoryStoreConflict({ code: "not_found" });
                yield* store.activateHubMemberTx({
                  requestId: request.requestId,
                  requestDigest: digest,
                  memorySpaceId,
                  environmentId,
                  expectedCredentialVersion: member?.credentialVersion ?? null,
                  next:
                    credentialDigest === null
                      ? "revoked"
                      : {
                          credentialDigest,
                          credentialVersion: (member?.credentialVersion ?? 0) + 1,
                        },
                  now: yield* Clock.currentTimeMillis,
                });
              }),
            );
            record = (yield* tx(permit, store.readHubAdminTx(request.requestId)))!;
          } else {
            record = yield* tx(
              permit,
              store.writeHubAdminTx({
                record: { ...record, stage: "activated" },
                expectedStage: "prepared",
              }),
            );
          }
        }
        if (record.stage === "activated") {
          if (request.action === "acknowledgeCredential") {
            const original = yield* tx(permit, store.readHubAdminTx(request.credentialRequestId));
            if (
              !original ||
              (original.stage !== "ready" && original.stage !== "acknowledged") ||
              (original.action.action !== "provisionMember" &&
                original.action.action !== "rotateMemberCredential")
            )
              return yield* new Store.MemoryStoreConflict({ code: "not_found" });
            yield* permit;
            if (original.secretName) yield* secrets.remove(original.secretName);
            yield* tx(
              permit,
              store.writeHubAdminTx({
                record: { ...original, stage: "acknowledged" },
                expectedStage: "ready",
              }),
            );
          }
          // The settings helper owns version/CAS, request-id replay and initial hub
          // bootstrap. It receives only a persisted action and private secret name.
          const result = yield* settings.apply(record, permit);
          record = yield* tx(
            permit,
            store.writeHubAdminTx({
              record: { ...record, stage: "ready", result },
              expectedStage: "activated",
            }),
          );
        }
        if (!record.result) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
        let credential: M.MemoryHubCredentialResult | null = null;
        if (outgoing && record.stage !== "acknowledged") {
          yield* permit;
          const saved = yield* secrets.get(record.secretName!);
          if (Option.isNone(saved))
            return yield* new M.MemoryHubError({ code: "source_unavailable" });
          const view = record.result.view;
          if (
            view.settings.mode !== "hub" ||
            view.settings.memorySpaceId === null ||
            record.memberVersion === null
          )
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          // Replaying a superseded rotation never discloses an obsolete credential.
          const member = yield* tx(
            permit,
            store.readHubMember(view.settings.memorySpaceId, request.environmentId),
          );
          if (
            !member ||
            member.status !== "active" ||
            member.credentialVersion !== record.memberVersion
          )
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          credential = {
            requestId: record.requestId,
            environmentId: request.environmentId,
            memorySpaceId: view.settings.memorySpaceId,
            credentialVersion: record.memberVersion,
            credential: Buffer.from(saved.value).toString("base64url"),
          };
        }
        return { ...record.result, credential };
      }),
    );
  });
  const pending: MemoryHubAdministrator["Service"]["pending"] = Effect.fn(
    "MemoryHubAdministrator.pending",
  )((permit) =>
    Effect.andThen(permit, store.readPendingHubAdmins(M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)),
  );
  return MemoryHubAdministrator.of({ update, pending });
});

export const administratorLayer = Layer.effect(MemoryHubAdministrator, makeAdministrator);
