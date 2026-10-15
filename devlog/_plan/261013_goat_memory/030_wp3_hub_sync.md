# 030 — WP3: hub synchronization and conflict leases

Enforcement limits and claim wording: [000 Enforcement inventory](000_plan.md#enforcement-inventory). Audit r1 rev 4 amendments supersede incompatible rev 2/3 recipes.

- Date: 2026-10-13
- Status: implementation PRD; no runtime changes or runtime verification in WP0.
- Baseline: `goat/goat-cross-device-provider-memory`, HEAD and local `origin/dev` = `1e2418fafb625604de1eb89250a10d971bcfd0fe` (verified while writing).
- Parent decisions and shared names: [000_plan.md](000_plan.md). Detailed rationale: [001_architect_proposal.md](001_architect_proposal.md).
- Implementation depends on [WP1 contracts](010_wp1_contracts.md) and [WP2 store and service](020_wp2_store_service.md). Rev 2 consumes the integrated contracts and local ports; these are planned APIs, not implemented behavior.
- Original phase-author scope: create this file only; rev 2 reconciles the seven allowed plans; no commits, pushes, tests, builds, server startup, or writes to live/provider state. Jun's host restriction also governs the eventual implementation's local verifier.

## 1. Purpose and acceptance boundary

Make committed GOAT memory converge through one user-selected hub environment. An offline environment can commit local changes, but cannot resolve shared conflicts without the hub. Only the first successful atomic claim may resolve a particular conflict head set. Expired, superseded, revoked, or deleted work must never apply. One conflicted or rejected memory must not stop unrelated memories or the replication cursor.

Implement M6–M9 and the synchronization parts of M1, M2, M5, M10, M11, M14 and M18. The amendments in `000_plan.md` override the proposal's older two-provider limitation: all six providers are WP2 generation consumers; WP3 never selects a fallback provider. Jun chose juns-macbook-pro as the initial hub, but no hostname, origin, or machine ID is built into code. This document does not configure that live hub.

Consumes these committed WP2 results:

| Input                                           | Required property / WP3 use                                                                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryService`, `MemoryDecider`, `MemoryStore` | Pure decisions followed by one SQL transaction; same operation replay is a NOOP; foreign operations can be applied without creating another outbound echo.                                                                   |
| `memory_outbox`                                 | Durable operation intent after a local commit, explicit pending/delivered/rejected metadata, retry scheduling, and recoverable delivery receipts. No network I/O in the transaction.                                         |
| memory_inbox_pending, memory_sync_cursors       | Canonical approved payload refs, parent/scanner holds and checkpoint pages are durable; original outcome/digest, minimal DAG/delete/deferred state and cursor commit atomically. Local hold is never a rejected hub receipt. |
| Tombstones, import suppression and scanner      | Delete wins regardless of ancestry or arrival order; purge bodies, resolution originals and derived artifacts; preserve source suppression metadata.                                                                         |
| `MemoryWorker`                                  | Tool-less generation through `resolveMemoryConflict`, a pinned model input, cancellable attempt, deterministic result operation ID, durable failure/report intent, and drainable finite work.                                |
| Conflicts and resolution records                | Stable conflict ID for sorted heads; complete input head set; original bodies held only until forget; revert remains a new compensating revision.                                                                            |

Done means focused PR CI tests prove the three-environment scenarios in section 8, targeted static checks pass, and review accepts the exact PR head. A local commit is not a hub acknowledgement. A successful claim is not a completed resolution. A transport timeout is an unknown outcome, not evidence of rejection.

## 2. Verified source anchors

All citations below refer to the baseline above, not hypothetical WP1/WP2 code.

| Source                                                                                                  | Current behavior and implementation implication                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/internals/effect-services.md:11`, `:40`, `:95`, `:100`, `:107`                                    | Domain services own multi-step behavior; transports decode/call/map; Context.Service modules and shared application layers; bounded typed errors. No feature-owned ManagedRuntime.                                         |
| `docs/internals/overview.md:53`, `:58`, `:64`, `:123`                                                   | Commit intent before effects; persisted history must replay; await worker idle or committed milestones. Memory uses its own aggregate, not thread commands.                                                                |
| `apps/server/src/auth/ServerSecretStore.ts:138`, `:172`, `:190`, `:227`                                 | get/set/create/remove of named bytes; names become filesystem paths; atomic rename and 0600 files, 0700 directory. Generate secret names internally; this is not encrypted storage.                                        |
| `apps/server/src/auth/EnvironmentAuth.ts:557`, `:569`, `:653`, `:671`                                   | Existing HTTP session authentication; MCP-specific bearer authentication; cookie precedes bearer in generic selection. Neither interface is a persistent server sync principal.                                            |
| `apps/server/src/auth/RpcAuthorization.ts:49`, `:100`, `:232`, `:234`, `:257`                           | Exhaustive RPC scope map and settings patch scope selection. WP4 owns memory RPC dispatch; WP3 HTTP authentication must not borrow RPC or MCP session authority.                                                           |
| `apps/server/src/auth/http.ts:41`, `apps/server/src/http.ts:315`                                        | no-store credential responses and raw route scope checks are precedents. The existing raw helper accepts orchestration scopes only; do not broaden it to accept sync tokens.                                               |
| `apps/server/src/server.ts:636`, `:741`, `:752`, `:1133`, `:1147`, `:1163`                              | Shared persistence dependencies; route composition; browser-auth middleware inside EnvironmentHttpApi; runtime readiness and one served router. Mount the hub route layer as a sibling with its own server authentication. |
| `apps/server/src/environment/ServerEnvironment.ts:49`, `:57`, `:183`, `:215`, `:228`, `:291`            | Stable persisted identity and descriptor capabilities; changing capability can be read per descriptor request. Reuse identity, never regenerate it for a hub or infer it from an endpoint.                                 |
| `apps/server/src/sshRemote/SshRemoteDispatch.ts:630`, `:977`, `:1288`, `:1313`                          | Remote identity decoding, explicit credentialed call, and authority recheck just before dispatch. Reuse the boundary discipline, not its MCP token/session or SSH process launcher.                                        |
| `packages/contracts/src/settings.ts:1176`, `:1233`, `:1430`, `:1571`, `:1757`                           | Decoding defaults, nullable defaultModelSelection, default settings generation and typed patches. Dedicated memoryHub administration requires settings:write through the existing domain classifier.                       |
| `apps/server/src/serverSettings.ts:76`, `:493`, `:666`, `:1071`, `:1217`                                | Schema JSON encoding, atomic settings objects, sparse settings persistence, write semaphore, startup readiness and change stream. Store only hub identity/endpoint/secret reference here.                                  |
| `packages/shared/src/serverSettings.ts:402`, `:432`, `:644`                                             | Settings patch merge includes special domain fields; reject memoryHub in generic merge. Dedicated administration replaces the whole discriminated mode.                                                                    |
| `apps/server/src/persistence/Migrations.ts:85`, `:161`, `:169`; `reconcileGoatMigrationIds.ts:9`, `:36` | Latest baseline migration is 068; static loader and stable GOAT names must both register the next migration. WP2 consumes the first new slot.                                                                              |
| `docs/internals/remote.md:11`, `:20`, `:26`, `:31`                                                      | Identity is independent of routes; public descriptor checks precede credential use; no silent loopback or other-environment fallback.                                                                                      |

## 3. File change map for the implementation PR

This is the future WP3 diff, not permission to edit these files during WP0. No DELETE entries: no existing implementation is replaced or removed. NEW/MODIFY below are relative to the integrated WP2 tree.

| Action | Exact path                                                         | Reason                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NEW    | `apps/server/src/memory/MemoryHubService.ts`                       | Hub membership, dedup/sequence, join/bootstrap read, atomic claim/renew/apply/release, administration and local hub ingestion.                                                                                                                                           |
| NEW    | `apps/server/src/memory/MemorySyncService.ts`                      | Startup sweep, bounded push/pull, cursor/bootstrap barrier, retry state, lease coordination and settings change cancellation.                                                                                                                                            |
| NEW    | `apps/server/src/memory/MemoryHubClient.ts`                        | Typed HTTP client port + implementation: identity preflight, explicit schemas, deadlines, no redirects and no credential leaks. Injectable transport for scenario tests.                                                                                                 |
| NEW    | `apps/server/src/memory/MemoryHubAuth.ts`                          | Authenticate only provisioned sync bearer credentials; produce a space/environment-bound server principal; membership recheck inside hub writes.                                                                                                                         |
| NEW    | `apps/server/src/memory/MemoryHubHttp.ts`                          | Eleven shared-name POST routes; bounded body decode, one service call, typed response mapping.                                                                                                                                                                           |
| NEW    | `apps/server/src/persistence/Migrations/071_MemoryHubSync.ts`      | Hub operations/members/leases plus transient source relay only; all local cursor/checkpoint columns/indexes already exist from WP2. Reserve 069 for WP2; if WP2 uses more slots, rename to the next free ID before implementation, preserving stable name MemoryHubSync. |
| MODIFY | `apps/server/src/persistence/Migrations.ts`                        | Import/register MemoryHubSync after WP2.                                                                                                                                                                                                                                 |
| MODIFY | `apps/server/src/persistence/reconcileGoatMigrationIds.ts`         | Add MemoryHubSync to GOAT_MIGRATION_NAMES.                                                                                                                                                                                                                               |
| MODIFY | `apps/server/src/memory/MemoryStore.ts`                            | Transaction-aware hub persistence methods and receive/bootstrap operations; no separate SQL runtime.                                                                                                                                                                     |
| MODIFY | `apps/server/src/memory/MemoryService.ts`                          | Expose transaction-composable foreign apply + bootstrap checkpoint install; suppress outbound echo. Domain deletion/DAG decisions remain WP2.                                                                                                                            |
| MODIFY | `apps/server/src/memory/MemoryWorker.ts`                           | Hand generation to the lease coordinator; submit validated output to hub before local visible apply; renew/cancel; owner-local report recovery. Generation itself remains WP2.                                                                                           |
| MODIFY | `apps/server/src/server.ts`                                        | Compose memory dependencies once and mount the hub routes before static fallback; activate sync only after migrations/settings/core startup are ready.                                                                                                                   |
| MODIFY | `apps/server/src/environment/ServerEnvironment.ts`                 | Publish WP1 memoryHubProtocolVersion only with working hub routes; general memory capability advertisement belongs to WP4.                                                                                                                                               |
| READ   | `packages/contracts/src/settings.ts`                               | Consume WP1 memoryHub defaults and dedicated administration schemas; no second contract definition.                                                                                                                                                                      |
| MODIFY | `apps/server/src/serverSettings.ts`                                | Reject memoryHub in generic updateSettings/updateProviderInstance; dedicated transition validates version and secret reference; change publication cancels old sync work.                                                                                                |
| MODIFY | `packages/shared/src/serverSettings.ts`                            | Reject reserved memoryHub in generic patch merge; whole replacement and disabled transitions belong only to dedicated administration.                                                                                                                                    |
| NEW    | `apps/server/src/memory/MemoryHubService.test.ts`                  | Real SQLite hub transactions, replay and competing claims.                                                                                                                                                                                                               |
| NEW    | `apps/server/src/memory/MemorySyncService.test.ts`                 | Delivery crash/restart, bootstrap and per-item progress with injected HTTP failures.                                                                                                                                                                                     |
| NEW    | `apps/server/src/memory/MemoryHubAuth.test.ts`                     | Server principal, membership binding, rotation/revocation, wrong route identity.                                                                                                                                                                                         |
| NEW    | `apps/server/src/memory/MemoryHubHttp.test.ts`                     | Exercise all eleven routes through in-memory router adapter; no listening server.                                                                                                                                                                                        |
| NEW    | `apps/server/src/memory/MemoryHubScenarios.test.ts`                | H, A and B with three real isolated stores, clocks and controlled generation/network.                                                                                                                                                                                    |
| NEW    | `apps/server/src/persistence/Migrations/071_MemoryHubSync.test.ts` | Migration registration/replay, uniqueness and permanent fence/receipt metadata. Rename with migration if needed.                                                                                                                                                         |
| MODIFY | `apps/server/src/serverSettings.test.ts`                           | Old settings defaults, complete mode replacement, reference validation and persistence failure.                                                                                                                                                                          |
| MODIFY | `packages/shared/src/serverSettings.test.ts`                       | Patch replacement and disabled transition preserve unrelated settings.                                                                                                                                                                                                   |

WP1 exclusively owns wire shapes, settings schemas, scopes, capability fields and exports.
All requested amendments have been incorporated in 010 rev 3. WP3 owns only runtime services,
settings activation and hub SQL. WP4 later registers core RPC; WP5 activates import RPC.

## 4. Contract consumption and complete field lifecycle

Consume [WP1 hub HTTP](010_wp1_contracts.md#hub-http-shapes-contract-only), administration,
binding and suppression schemas unchanged. Join returns a checkpoint handle; checkpoint pages
arrive through pull with snapshotToken/cursor, and nextCursor is the sole continuation field.
MemoryHubEntry has operation/metadata arms. Lease clock fields are UTC strings on wire and
converted to integer ms by SQL codecs. Only hub admission creates sequenced semantic rejection;
replica preserves outcome/digest and records local processing separately. Settings pins hub identity.

Consume MemorySyncStatus.state and its independent pendingSync/quarantined/parked counters,
lastSuccessfulSyncAtUtc/lastHubSequence/failureCode; no phase/failed/disconnected aliases.
Hub administration uses MemoryHubSettingsUpdateInput's configure/provisionMember/
rotateMemberCredential/revokeMember/installCredential/acknowledgeCredential actions and
MemoryHubSettingsView.version. HTTP authentication uses WP1 hub error tags, not RPC grants.
Permanent source/content/extraction suppression travels only through WP1 tombstone fragments
and import provenance. No duplicate suppression/checkpoint DTO or table replication.

All previous WP1/WP2/WP4/WP5 change requests are now assigned producer work, not open contracts.

| Field / enum                                                              | Creation → encoding/storage → decoding → every WP3 consumer; downstream owner                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| memoryHub.mode / hubEnvironmentId / endpoint / memorySpaceId / secretName | Authorized configuration creates a full union value; ServerSettings Schema → sparse settings.json → ServerSettings decode/default; MemorySyncService selects disabled/local-hub/member, MemoryHubAuth checks hub mode, ServerEnvironment advertises availability. WP4 RPC and WP6 UI consume the same schema. Only internally generated `[a-z0-9-]+` secret references are accepted. |
| `memory:sync`, server principal environmentId/space/version               | Hub provisionMember creates a versioned membership; secret bytes in ServerSecretStore, member verifier/version in SQL; Authorization bearer decode → MemoryHubAuth lookup → each service verifies current membership/space/environment in its write transaction. Never inserted into browser/MCP session contexts. Scope definitions and user grants: WP1/WP4.                       |
| protocolVersion=1                                                         | Contract encoder produces it for every request; endpoint decoder rejects anything else with 426; MemoryHubClient and MemoryHubHttp use it; descriptor publishes WP1 memoryHubProtocolVersion for hub HTTP independently of later client memory activation. No provider consumer.                                                                                                     |
| hubSequence / outcome / operationDigest / entry.kind                      | Hub admission creates original receipt → explicit HTTP codec → replica integrity decoder → canonical receive/ACK/terminal settlement. Local scanner/quota/FTS/report never rewrite outcome.                                                                                                                                                                                          |
| highWatermark / throughSequence / hasMore                                 | Hub fixed watermark bounds pages → codec → receive transaction commits canonical refs/original receipts/deferred/cursor → next page without drain wait.                                                                                                                                                                                                                              |
| snapshotToken / checkpointSequence / cursor                               | Hub-bound handle → durable canonical page staging/ordinal → strict codec and completeness checks → atomic canonical/boundary/receipt/deferred/cursor install; FTS/export do not gate completion. Tokens never in public status/logs.                                                                                                                                                 |
| conflictHeadSet / conflictId                                              | WP2 derives canonical sorted distinct heads; schema and SQL JSON round-trip; claim, renew, apply and release compare exact set/ID. Worker receives variants only after claim; WP2 history and WP6 resolution details retain IDs.                                                                                                                                                     |
| attemptId / holderEnvironmentId / fencingToken                            | Claim request's stable retry ID + authenticated holder; hub increments persistent per-memory fence; SQL → lease response → worker coordinator → apply/renew/release. MemoryResolution records the fence. Never give the model control of these values.                                                                                                                               |
| claimedAtHubTime / expiresAtHubTime / attemptDeadlineHubTime              | Hub Effect Clock only; SQL integer milliseconds → lease schema decode; hub checks expiry and fixed 10-minute deadline. Member clocks only schedule renewal; they never decide authority.                                                                                                                                                                                             |
| frozenDefaultModelSelection                                               | Claimant reads raw environment defaultModelSelection once; complete ModelSelection/options encode into lease; worker decodes and invokes WP2 generation; result records requested and effective provider/model. Changes to settings during the attempt do not change it. Null/unavailable default returns typed failure before claim, no title-generator fallback.                   |
| sync state / processing / counters / failureCode / received sequence      | WP2 durable receive/local flags and hub admission failures → WP1 MemoryProcessingStatus codec → WP4 RPC/MCP/runtime → WP6 surfaces; online plus deferred is valid; receipt is not visible/indexed/purged.                                                                                                                                                                            |
| MemoryOperation.kind / parents / provenance / suppression                 | Local/hub pre-admission scanner → approved operation codec → authenticated approvedReplica ingestion → canonical + local exposure gate, parent linking and deletion union; no scanner reapproval or sync echo.                                                                                                                                                                       |
| credential bytes                                                          | Crypto creates 32 random bytes; named local ServerSecretStore only; transfer once by an explicit owner administration action, decode only at auth/client boundary. N/A to operation serialization, snapshot, report, provider context or user settings: credentials are not memory.                                                                                                  |

Local-only SQL fields also need explicit codecs: member status active/revoked and credential_digest/version are produced by administration and consumed by auth and every transactional membership guard; they never leave the hub. Lease SQL started_at maps to claimedAtHubTime and started_at+600000 maps to attemptDeadlineHubTime; status is inferred from nullable holder fields and expiry, not a second wire enum. Cursor bootstrap_state consumes WP2's local codec (`unbound | staging | ready`), created by join/page install and read by sync/import guards; report delivery and pending retry timestamps remain WP2-local outbox metadata. Snapshot staging records use a versioned typed JSON discriminator, Schema encoding/decoding at MemoryStore, and contain no token in user-visible projections. Credential digest, active membership status, local retry timestamps and bootstrap staging are N/A to shared MemoryOperation serialization because they describe execution/authority, not memory facts.

## 5. Persistence, membership and authentication

### 5.1 Hub migration skeleton

Mirror the Effect.gen/SqlClient migration shape at `Migrations/058_WebhookRelayDeliveries.ts:4`. Register the stable name, not just a new file (`Migrations.ts:174` statically builds the loader).

```sql
CREATE TABLE IF NOT EXISTS memory_hub_members (
  memory_space_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  credential_digest TEXT NOT NULL, credential_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  joined_at INTEGER, PRIMARY KEY(memory_space_id, environment_id)
);
CREATE TABLE IF NOT EXISTS memory_hub_operations (
  hub_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_space_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  origin_environment_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL, outcome TEXT NOT NULL
    CHECK(outcome IN ('accepted','conflicted','deleted','rejected')),
  failure_code TEXT, operation_metadata_json TEXT NOT NULL,
  payload_ref TEXT, UNIQUE(memory_space_id, operation_id)
);
CREATE INDEX IF NOT EXISTS memory_hub_operations_space_sequence
  ON memory_hub_operations(memory_space_id, hub_sequence);
CREATE TABLE IF NOT EXISTS memory_hub_leases (
  memory_space_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(fencing_token >= 0),
  conflict_id TEXT, conflict_heads_json TEXT,
  holder_environment_id TEXT, credential_version INTEGER,
  attempt_id TEXT, started_at INTEGER, expires_at INTEGER,
  frozen_default_model_selection_json TEXT,
  PRIMARY KEY(memory_space_id, memory_id)
);
```

`memory_hub_operations` stores no inline body: reference WP2 memory_payloads, purge that body and clear payload_ref on forget while retaining operation_digest and compact receipt metadata forever in the bounded ledger, not detailed event JSON. The digest is over canonical allowed operation fields including payload at first admission; it is not recomputed from a subsequently purged body. Detect ID reuse without keeping forgotten text. Duplicate receipt lookup precedes a second apply, but every delivery still honors current tombstone state when deciding which bodies to return.

Keep lease rows after release, expiry, forget and credential revocation: clear active-holder fields, preserve/increment fencing_token. Do not delete/reset counters on reclaim. SQL row primary keys scope every memory and sequence query. Allocate an operation sequence in the same transaction as domain apply + receipt; rolled-back sequence gaps are harmless. Do not equate MAX(sequence) with a count.

Consume WP2's complete memory_sync_cursors/memory_inbox_pending inventory unchanged;
write after_sequence/bootstrap_state/checkpoint_sequence/snapshot_token/checkpoint_cursor
through its atomic ports. Hub checkpoint staging uses those existing rows and local codecs.
WP3 migration creates the three permanent hub tables above plus memory_hub_source_reads defined in rev 3; no duplicate local cursor/checkpoint migration.
Pending dependency replay is awakened by committed parents, including after restart.
Initial implementation includes MemoryCompactor: completed checkpoints publish a persistent retention floor before safe-prefix compaction. A long-offline cursor below that operational floor takes cursor_expired -> bootstrap -> tail pull -> pending review. Actual compactor CI produces the floor; injected floors are supplementary boundary tests only. Permanent compact tombstones, receipts and fences remain in bounded ledgers outside tail cleanup. No migration writes to provider directories.

### 5.2 Credential lifecycle and explicit administration

MemoryHubService administration is callable by the eventual WP4 hub-settings RPC, guarded by settings:write on the hub environment. Define `provisionMember(environmentId)`, `rotateMemberCredential(environmentId)` and `revokeMember(environmentId)` as service methods; join is NOT an unauthenticated enrollment endpoint. Owner provisions a per-environment credential on the hub, explicitly installs it on the member, then joins. Do not auto-copy another client's bearer token, reuse MCP/agent credentials or distribute a common space-wide secret.

Provisioning generates 32 random bytes, persists their verifier and credential version in memory_hub_members and stores a recoverable outgoing credential under an internally generated ServerSecretStore name. Secret filesystem and SQL are not atomic together: stage secret first, commit membership activation second, then mark the administration receipt ready. A crash between steps leaves an inactive/unreferenced secret; retry resumes with the same administration request ID, not a new active credential. Return bytes only in an explicit no-store administration response; clear outgoing material after owner acknowledgement. Client settings get only its own secret reference.

Rotation stages a new version, then activates it atomically and invalidates old-version leases. Revoke makes membership inactive and invalidates leases in one transaction. Retry of an administration request returns its same result/receipt. Store administration recovery metadata under WP2's existing admin outbox kind in memory_outbox, never as a shared memory event. Disconnect on a member stops sending and releases its lease best-effort but retains local data/outbox/cursor; revoking on the hub is a separate authorized action. Automatic hub promotion or hub identity replacement is out of scope.

MemoryHubAuth parses ONLY the Authorization bearer header, resolves its member digest and creates MemoryHubPrincipal. Reject cookies, reusable dev credentials, pairing grants, MCP tokens and relay identity alone. A browser cookie alongside a valid server bearer must neither replace nor broaden that bearer. Verify `(space, environment, credentialVersion, active status)` after waiting for the transaction lock, just before effects commit. `originEnvironmentId` in an operation must equal the authenticated member; provenance may reference earlier source environments without granting them authority.

The HTTP implementation uses existing public descriptor identity preflight and checks hubEnvironmentId + WP1 memoryHubProtocolVersion before sending a credential. Endpoint is an absolute http(s) server origin with no userinfo, query or fragment; preserve WP1's HTTP-on-loopback-only rule. Non-loopback LAN/tailnet endpoints need HTTPS or an explicitly configured secured tunnel presenting a loopback HTTP origin; do not silently substitute routes. Redirects are rejected, including same-origin redirects: owner updates the endpoint explicitly. Relay/tunnel routes may add their own transport authentication, but the hub still requires its bound server credential. If the chosen relay cannot carry the hub POST paths, return `route_unavailable`; do not launch SSH or fall back to localhost. Hosted web is a client, not the hub.

## 6. Service and integration skeletons

These are implementation skeletons: request/result schemas come from section 4/WP1, and store/domain method signatures below are WP2 handoff requirements. Each module follows `effect-services.md:40`; errors are Schema.TaggedError classes, with safe categories/IDs, immediate cause where wrapping is necessary, and Effect.catchTags for known tags.

### 6.1 MemoryHubService

The other NEW service ports have these concrete seams (interfaces inline in their Context.Service tags, errors and layer in the same modules):

```ts
// MemoryHubAuth.ts
authenticate: (request: HttpServerRequest.HttpServerRequest) =>
  Effect.Effect<MemoryHubPrincipal, MemoryHubUnauthorizedError | MemoryHubForbiddenError>;
// Implementation: parse bearer only -> bounded token digest -> active SQL membership
// lookup -> principal. No generic EnvironmentAuth cookie selection.

// MemoryHubClient.ts: same eleven typed methods as MemoryHubService, without principal arg.
preflight: (settings: Extract<MemoryHubSettings, { mode: "member" }>) =>
  Effect.Effect<void, MemoryHubTransportError>;
// Each request: preflight pinned identity -> get secret by internally validated name ->
// explicit schema JSON -> HTTP POST with Authorization and redirects disabled ->
// deadline/status map -> bounded response/schema decode. Recheck configuration epoch.

// MemoryHubService.ts: administration, invoked only through an owner authority port.
provisionMember: (input: { requestId: MemoryOperationId; environmentId: EnvironmentId }) =>
  Effect.Effect<MemoryHubCredentialResult, MemoryHubError>;
rotateMemberCredential: (input: { requestId: MemoryOperationId; environmentId: EnvironmentId }) =>
  Effect.Effect<MemoryHubCredentialResult, MemoryHubError>;
revokeMember: (input: { requestId: MemoryOperationId; environmentId: EnvironmentId }) =>
  Effect.Effect<void, MemoryHubError>;
// Owner authority is injected/rechecked by the administration service boundary;
// a MemoryHubPrincipal never grants administration. Result bytes are one-time/no-store.
```

WP2 shared ports applyReceived, withReceivedCursor, installCheckpointPage, completeCheckpoint, materializeLocalIntent, acknowledgeOutbox and readEligibleOutbox compose into the same SQL transaction. All approved pull/checkpoint/ACK/accepted-resolution paths use authenticated approvedReplica ingestion; local creation retains admission decider, not a repeated receive gate. Canonical state/original receipt/deferred/cursor settle before return; derived scanner/FTS/export/report drain independently. These are planned seams, not baseline exports.

```ts
export class MemoryHubService extends Context.Service<
  MemoryHubService,
  {
    readonly join: (
      p: MemoryHubPrincipal,
      input: MemoryHubJoinInput,
    ) => Effect.Effect<MemoryHubJoinResult, MemoryHubError>;
    readonly push: (
      p: MemoryHubPrincipal,
      input: MemoryHubPushInput,
    ) => Effect.Effect<MemoryHubPushResult, MemoryHubError>;
    readonly pull: (
      p: MemoryHubPrincipal,
      input: MemoryHubPullInput,
    ) => Effect.Effect<MemoryHubPullResult, MemoryHubError>;
    readonly claim: (
      p: MemoryHubPrincipal,
      input: MemoryHubClaimInput,
    ) => Effect.Effect<MemoryResolutionLease, MemoryHubError>;
    readonly renew: (
      p: MemoryHubPrincipal,
      input: MemoryHubRenewInput,
    ) => Effect.Effect<MemoryResolutionLease, MemoryHubError>;
    readonly applyResolution: (
      p: MemoryHubPrincipal,
      input: MemoryHubApplyResolutionInput,
    ) => Effect.Effect<MemoryHubReceipt, MemoryHubError>;
    readonly release: (
      p: MemoryHubPrincipal,
      input: MemoryHubReleaseInput,
    ) => Effect.Effect<{ readonly released: boolean }, MemoryHubError>;
    // provisionMember / rotateMemberCredential / revokeMember require owner authority.
  }
>()("goat/memory/MemoryHubService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* MemoryStore.MemoryStore;
  const scanner = yield* MemorySecretScanner.MemorySecretScanner;
  const service = yield* MemoryService.MemoryService;
  const claim = Effect.fn("MemoryHubService.claim")(function* (p, input) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* store.assertActiveMember(p); // authoritative post-lock check
        const now = yield* Clock.currentTimeMillis; // hub clock, no Date.now()
        const state = yield* store.readConflictForUpdate(input.memoryId);
        yield* assertNotForgottenAndExactHeads(state, input);
        const lease = yield* store.readLease(input.memoryId);
        if (sameLiveAttempt(lease, p, input, now)) return lease;
        if (isLiveOtherAttempt(lease, now))
          return yield* new MemoryHubError({
            code: "claim_busy",
            memoryId: input.memoryId,
          });
        return yield* store.replaceLease({
          ...input,
          holderEnvironmentId: p.environmentId,
          credentialVersion: p.credentialVersion,
          fencingToken: nextSafeFence(lease),
          claimedAtHubTime: utc(now),
          expiresAtHubTime: utc(now + MEMORY_LEASE_MS),
          attemptDeadlineHubTime: utc(now + MEMORY_RESOLUTION_ATTEMPT_MAX_MS),
        });
      }),
    );
  });
  // return MemoryHubService.of({ join, push, pull, claim, renew, applyResolution, release, ... });
});
export const layer = Layer.effect(MemoryHubService, make);
```

SQL read/replace above means a serialized transaction plus conditional UPDATE/INSERT affected-row check, not an unlocked read then upsert. Handle SQLite busy with a bounded typed retry, no duplicate fresh attemptId. At most one live lease row per memory. Sort/deduplicate heads with the contract helper before comparison and store canonical JSON.

`push`: validate the complete batch envelope, then process operations in separate transactions so a valid sibling still commits. Under the transaction: verify member, look up `(space, operationId)`, compare digest, apply scanner-safe WP2 decisions, persist domain event/revision/projection/receipt/outbox and hub sequence together. Same ID/same digest returns the first receipt without a second event/sequence; different digest returns operation_id_reused. A rejected item's receipt has a sequence so pull can advance without its body. A transient SQL failure creates no accepted/rejected receipt; caller retries that item.

Foreign apply does not enqueue a sync echo. Hub-local MemoryService writes still create the normal WP2 outbox; the hub sync lane ingests them directly through MemoryHubService using its internal active member, without HTTP to itself. The hub therefore participates as a third writer and claimant. Startup sweeps local unledgered outbox rows before conflict claims; local tombstones/heads are always checked in the same canonical projection. A gap between local intent commit and hub ledger ingestion is reported as pendingSync.

Only apply-resolution admits a new `resolve` operation. Ordinary push rejects new resolves as lease_required; replay of an already accepted resolve returns its receipt. `revert` uses the WP2 expected-head guard and is not a new model resolution. `renew` checks holder/version/attempt/fence/current heads/tombstone and requires `now < expiresAt`; expiry becomes `min(now + 120_000, startedAt + 600_000)`. At `now >= startedAt + 600_000`, deny renewal/apply and clear active ownership. A new head or forget invalidates the current lease in the same apply transaction and advances the persistent fence.

`applyResolution`: first dedup operation ID, then recheck active member, token, holder, attempt, strict unexpired lease, attempt cap, exact current head set and no tombstone. Validate output through WP2 scanner; parents consume ALL claimed heads. Commit revision/resolution/event/receipt/hub sequence together and clear active holder fields. Do not hold a transaction while the model runs. Returning a receipt is the apply ACK; response loss is recovered by replaying the identical request or pulling that operation, even after the original lease expired. Duplicate lookup cannot bypass current member authorization.

`release`: compare holder/attempt/token; only matching current ownership is cleared. Same request after release returns released=false (safe idempotence). A stale release must never clear a newer holder. Conflict remains quarantined after release/failure. Permanent lease counter remains.

### 6.2 MemorySyncService and worker contract

```ts
export class MemorySyncService extends Context.Service<
  MemorySyncService,
  {
    readonly start: Effect.Effect<void, MemorySyncError>;
    readonly syncOnce: Effect.Effect<void, MemorySyncError>;
    readonly syncStatus: Effect.Effect<MemorySyncStatus, MemorySyncError>;
    readonly getHubSettings: (
      permit: MemoryPermit,
    ) => Effect.Effect<MemoryHubSettingsView, MemorySyncError>;
    readonly updateHubSettings: (
      input: MemoryHubSettingsUpdateInput,
      permit: MemoryPermit,
    ) => Effect.Effect<MemoryHubSettingsUpdateResult, MemorySyncError>;
    readonly scheduleConflictResolution: (
      id: MemoryConflictId,
    ) => Effect.Effect<void, MemorySyncError>; // ticket + registration only
    readonly drain: Effect.Effect<void>; // finite queued items + current item, not periodic loop
  }
>()("goat/memory/MemorySyncService") {}

// Constructor dependencies: MemoryStore, MemoryService, MemoryHubClient,
// ServerEnvironmentIdentity, ServerSettingsService, ServerSecretStore,
// WP2 generation port; scheduler uses Effect Clock and is scoped to the app.
const syncOnce = Effect.gen(function* () {
  const settings = yield* settingsService.getSettings;
  if (settings.memoryHub.mode === "disabled") return;
  yield* bootstrapIfRequired; // includes tombstones; no push while incomplete
  yield* receiveBoundedPages; // learn remote forget before submitting pending bodies
  const batch = yield* store.readEligibleOutbox(100, 1024 * 1024);
  const safeBatch = yield* scanner.scanOutbound(batch);
  const receipts = yield* client.push(safeBatch);
  yield* store.acknowledgeOutbox(receipts); // settle revert intents; transport failure stays pending
  yield* receiveBoundedPages; // own ACK/reports and other writes converge
  yield* sweepClaimCandidates; // durable due rows, <=100 inspected, <=4 registered executions; never await model completion
});
```

Serialize syncOnce per environment for bounded transport/scheduling only; never wait for generation or deferred drain. <=1,000 pull entries/ten pages, one bounded push, then fair rescheduling. Preserve WP1 count/byte/codec bounds and whole-item progress. Only hub rejection/purge uses metadata arm; replica scanner hold retains approved body canonically. Each local-processing/relay/report failure is per-item; protocol/auth/canonical storage errors stop page without cursor skip.

On startup await settings/core readiness, sweep pending outbox/inbox/report receipts AND quarantined claim candidates, recover expired attempts and schedule sync. Wake on committed local outbox events and settings changes; a 30-second periodic pull discovers remote changes. Transport deadline is 15 seconds. Retry transient network/5xx/429 with bounded delays 1, 2, 4, 8, 16, 30 seconds; honor a bounded Retry-After (maximum 30 seconds). Persist retry eligibility and last safe error. Auth/protocol/identity failures block automatic retry until settings/credential/descriptor change or explicit reconnect. Generation failure releases and uses a 30-second per-conflict retry floor; ten-minute attempt cap prevents renewing forever. Clocks schedule retries in production, but tests advance TestClock and await signals, never sleep.

scheduleConflictResolution persists ticket and app-scope execution registration before returning; slot remains until finalization. Registry owns pinned generation/renew/apply/release/cancel. Before hub acceptance renewal/head failures invalidate attempt; after accepted receipt is known, recover approved canonical incorporation by identical ACK/pull, never regenerate/resubmit or relabel acceptance as lease/generation failure. Persist submission IDs before network apply. Canonical write failure retains recoverable approval and reports storage error. Resolver-local minimum stable report repair marker commits with receive; bounded delivery quota/failure defers report without blocking cursor or scheduling a new resolve.

### 6.3 Bootstrap, join and receive ordering

join is idempotent for a provisioned active member and returns hub identity/space and a checkpoint at committed high-watermark S. A repeated lost-response join may return a new checkpoint handle, but never create a new space/member identity. A member's null memorySpaceId means discovery only; the credential-bound hub returns the actual space. Already-bound different space is `space_mismatch`, not an automatic migration.

Before initial join, WP2 must distinguish unbound local intent from immutable shared MemoryOperation. Do not mutate an accepted operation's memorySpaceId or digest. Required handoff: local drafts/outbox intents can be materialized into their first shared operation after bootstrap attaches the hub-issued space, with durable assigned operationId/revisionId and preserved MemoryId/provenance. Retry must reuse that first materialization. Existing published memory from another space cannot be silently rebound: keep it separate and require an explicit future migration. Consume the WP2 materializeLocalIntent port; no new contract or immutable-space rewrite in WP3.

Consume [WP1 permanent checkpoint wire records](010_wp1_contracts.md#permanent-checkpoint-wire-records-rev-12), including `validateMemoryCheckpointRecords` and the combined page bounds; WP3 owns SQL-backed production/staging/atomic install, not wire field or codec definition.

Build the checkpoint under a consistent read transaction: current heads/projections, unresolved conflict, valid revert inputs, checkpoint causal boundary, compact receipts and EVERY permanent tombstone/suppression/fence at S; only checkpoint-required ancestry, never an unbounded historical DAG. Serve fixed pages from a durable materialized checkpoint in memory_inbox_pending; do not hold a DB transaction across HTTP requests. Token binds member, space, hub identity and S; 10-minute checkpoint expiry discards staging and restarts join, never installs a partial snapshot. A forget after S purges its body from staged pages too and is sent as a later tombstone; the checkpoint replaces affected active items with WP1 blocked/source_invalidated metadata and null revision payloads, rather than stale text. Snapshot token is not a substitute credential.

Stage pages until every ordinal and completeness check passes. Atomically install canonical revision/payload/delete/suppression/boundary, original receipts, local deferred flags and cursor=S; preserve local drafts/newer tombstones. FTS/export/report readiness is excluded from bootstrap completion. Canonical deletion and read fences are mandatory; derived cleanup may be cleanupPending. Partial page/crash installs nothing. Pull tail after S before local materialization/push.

Normal pull verifies authenticated hub/space/configuration epoch, supported protocol/codec, bounds, mode, ordered sequence and identity/digest. Per page commit approved canonical payload/revision/ref, original hub receipt, minimal frontier/delete/suppression, deferred flags and cursor atomically. Parent/scanner/conflict/index/report hold cannot reject approved operation or stop next page. Consume original hub metadata rejections unchanged. Tombstone discards late body while preserving original hub outcome. Collision with unapproved local intent preserves/settles intent for review, never refuses hub approval. Invalid envelope or contradictory approved identity/digest/DAG fails whole page with no writes/cursor move.

### M20 receive recovery and independent drain

| Fault                                                                       | Cursor and recovery                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Truncated/damaged page or transient transport                               | No commit, same cursor; bounded backoff retries identical request.                                                                                                                                                                                   |
| Unsupported codec/protocol or authenticated hub/space/config epoch mismatch | Safe sync error, no writes/skip; credential/config/protocol change or explicit reconnect resumes.                                                                                                                                                    |
| Authenticated approved identity/digest/DAG contradiction                    | Entire page rollback, safe protocol report; try fresh valid checkpoint recovery, stop repeated unrecoverable automatic retry. Unapproved local intent collision is not this fault: settle/preserve local intent for review and receive hub approval. |
| SQLITE_BUSY/transient canonical write error                                 | Original approval preserved without rejection; bounded retry identical page, cursor moves only with durable commit.                                                                                                                                  |
| ENOSPC/corruption/persistent write failure                                  | Report storage fault and preserve cursor; repair space/DB, then identical retry or complete checkpoint recovery. No guarantee of progress while durable recording impossible.                                                                        |

Pull receives next bounded page after canonical commit and post-commit wakeup, never waits for
index/scanner/parent/export/report drain. Deferred work has bounded fair scans independent of
pull scheduling (algorithm in WP2 §3 deferred drain), coalesces latest revision/generation and checks tombstone before writing. An
unrecoverable local hold can stay held while other memories advance; age/status stays durable.
Parent repair retries on parent commit/checkpoint/restart; persistent actual missing ancestry
requests checkpoint recovery and safe error, not shared rejection. Lost wakeup recovers by SQL
restart/reset. A secret_detected hold is released only by an allowed current-generation result of a
policy-version rescan (MemoryWorker, at start and on scanner policy upgrade), never timer release; no per-item explicit rescan entry point. Completion means durable receipt, not index/physical purge.

### 6.4 Route and configuration diffs

Mount exactly `POST /api/memory-hub/v1/join`, `/push`, `/pull`, `/claim`, `/renew`, `/apply-resolution`, `/release`, `/source-read/request`, `/source-read/collect`, `/source-read/respond`, `/source-read/result`. MemoryHubHttp's router layer may use the existing HttpRouter API; the shared schemas remain in contracts. Each handler: get server principal through MemoryHubAuth, decode bounded input, call its one MemoryHubService method, encode a no-store response, map typed errors. POST routes do not inherit browser cookie authorization. Authenticate before reading body beyond the bounded envelope; no request/response body logging.

```diff
// apps/server/src/server.ts:741-761, baseline route assembly
 const layerMakeRoutes = Layer.mergeAll(
   Layer.mergeAll(
     HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
       ...
       Layer.provide(AuthHttp.layerAuthenticatedAuth),
     ),
+    MemoryHubHttp.layer,
     ServerHttp.layerRuntimeDrainRoute,
     ...
     ServerHttp.layerStaticAndDevRoute,
```

Provide one app-owned memory core/hub/client/sync layer through shared runtime dependencies (`server.ts:636`, `:1133`, `:1166`). The existing WP2 core instance is reused by HTTP, worker and sync; Layer.provideMerge uses the same layer value and memoization scope. Hub service is constructed even in disabled mode but serves typed hub_disabled errors; it starts no network work. Start sync through the application startup sequence after migrations + settings/core readiness, not in an HTTP handler. Scope cancellation stops renewal/pull fibers. ServerEnvironmentIdentity and ServerSecretStore are shared services, not reconstructed per route.

WP1 adds ServerSettings.memoryHub but excludes memoryHub from generic ServerSettingsPatch. WP3 rejects the reserved key in both generic settings update paths before merge or persistence; only dedicated memory.hubSettings.update may call the CAS administration transition. No generic-to-dedicated delegation or fabricated requestId/expectedVersion is allowed.

Settings update validates reference/endpoint/space, stages any credential before committing its reference, and on failure preserves old settings and old active credential. Reuse settings write/rollback discipline (`serverSettings.ts:1071-1098`); do not annotate the secret reference as an inline settingsSecret string that materializes credential bytes into getSettings. Updating a mode cancels old coordinator epoch; late old-endpoint responses cannot update the new cursor/status. A hub's existing memorySpaceId cannot be changed by a normal patch. Disabled retains persisted data. WP1 defines capabilities.memory (protocolVersion plus optional hub/importProvider). WP3 leaves the general memory advertisement absent until WP4 core handlers and snapshots work; hub HTTP/preflight readiness uses the existing public environment identity plus installed hub protocol routes. WP4 advertises hub from actual mode; WP5 alone enables importProvider. Do not claim client memory support at WP3. `ServerEnvironment.ts:228`/`:291` populates it without changing persisted identity initialization.

## 7. Branches, guards and observable evidence

Every branch below gets a named focused test in section 8. HTTP errors expose a bounded typed code, not defect text. No error branch substitutes another environment or provider.

| Activation                                                                                   | Branch / result                                                                 | Observable evidence                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mode=disabled or endpoint is not a configured hub                                            | No sync starts; hub_disabled → HTTP 503                                         | Zero network calls; existing outbox remains pending; status disabled.                                                                                                       |
| Missing/invalid server bearer; cookie/dev/MCP token supplied                                 | unauthorized → 401                                                              | No domain or cursor writes; auth response no-store; no credential in logs.                                                                                                  |
| Active member with wrong environment/space, revoked version or scope                         | forbidden → 403; revoke/rotate invalidates lease                                | No accepted operation/claim; old token fails next request and post-lock recheck.                                                                                            |
| Descriptor answers as another hub or lacks v1                                                | identity_mismatch / unsupported_protocol (426)                                  | No credentialed HTTP call; blocked status; cursor unchanged.                                                                                                                |
| Endpoint redirect or route unavailable                                                       | Explicit transport failure                                                      | Credential never reaches redirect target; no SSH launch/local fallback.                                                                                                     |
| Push envelope >1 MiB, page >256 KiB, either payload >64 KiB, batch>100, limit outside 1..100 | 413/400; valid-envelope item rejection uses explicit receipt                    | Bounded request allocation; siblings with valid envelope still progress; no silent truncation.                                                                              |
| Same operation ID/digest / different digest                                                  | Return original receipt / rejected operation_id_reused (409 for singular apply) | One committed operation sequence; no duplicate revision/event/report; original projection unchanged.                                                                        |
| Network timeout, lost response, 429 or 5xx                                                   | Retain pendingSync and stable IDs, bounded retry                                | Outbox survives restart; hub may already have receipt; replay converges once.                                                                                               |
| Scanner blocks pre-admission / replica rescan differs                                        | Local/hub refusal metadata / replica-local scanner hold                         | Pre-admission body absent; approved body retained once canonically, original outcome/cursor preserved; no FTS/read/history/model/export exposure, other operations proceed. |
| Concurrent non-ancestral heads                                                               | Local eligibility quarantine                                                    | Approved variants durable, minimum candidate marker; full scheduler budget may defer resolution but not receive.                                                            |
| Approved parent missing / arrives / boundary-covered                                         | Preserve canonical revision/ref; defer link                                     | Cursor continues; parent connects once; checkpoint-covered ancestry not parked forever; unapproved stale intent alone needs base_compacted review.                          |
| Tombstone before/after edit/import/resolve/revert                                            | Canonical purge and all deferred generations invalidated                        | Normal derived purge immediate; derived failure fences read and records cleanupPending until physical cleanup, no false complete claim.                                     |
| Partial/expired checkpoint or cursor below real compactor floor                              | Restart complete checkpoint / keep push barrier until canonical install         | No partial install; complete install works under local brake/hold/quota, tail pull reaches later forget without index readiness.                                            |
| Existing bound space differs from joining hub                                                | space_mismatch, explicit migration required                                     | Prior space/data untouched, blocked state; no rewritten immutable operation.                                                                                                |
| Claim sees live other holder                                                                 | claim_busy → 409                                                                | Exactly one live lease and one model generation start across H/A/B.                                                                                                         |
| Same attempt retries claim while live                                                        | Same lease/fence                                                                | No reset of startedAt; no extra generation attempt.                                                                                                                         |
| Hub now equals expiry (120s) or attempt cap (600s)                                           | lease_expired/attempt_expired → 409                                             | Old apply cannot commit; new successful claim fence is greater.                                                                                                             |
| Renewal at 30s / lost renewal                                                                | Bounded extension / local cancel and quarantine                                 | Hub expiry=min(now+120s,start+600s); no local result commit after renewal failure.                                                                                          |
| Third edit changes heads or forget invalidates claim                                         | conflict_changed / forgotten → 409                                              | Fence advances; old output discarded; next claim has current full head set or cannot claim deleted item.                                                                    |
| Generic push contains new resolve                                                            | lease_required rejected receipt                                                 | No resolution projection; only valid apply-resolution can commit.                                                                                                           |
| Null/disabled/unavailable default model, generation failure or invalid output                | Typed failure, no fallback; release/backoff                                     | Frozen selection recorded; failure report intent once; memory remains quarantined.                                                                                          |
| Stale release versus newer claim                                                             | released=false, ownership preserved                                             | New holder/token unchanged.                                                                                                                                                 |
| Settings epoch changes mid-call                                                              | Discard old response/cancel work                                                | New configuration cursor/status unchanged by delayed old response.                                                                                                          |

## 8. Focused test plan (PR CI only)

### C-ACTIVATION-GROUNDING — M20 source-runtime obligations (NOT RUN)

All rows are future implementation obligations. Use isolated real stores/services/page codecs,
TestClock and Deferred/persisted milestones; no sleeps, direct cursor assignment or test-only
floor used to fake success. Exact-head source CI must record each actually executed case; suite
collection/build alone is not activation evidence.

#### apps/server/src/memory/MemoryHubScenarios.test.ts

| Case                               | Activation                                                                                                                                                                | Required observation                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4 core: ordered pages under brake | Persist B braked through real maintenance; H approves front-page new upsert, puts existing-memory forget in a later page; B normal syncOnce sequential pull through codec | Front upsert canonical+original receipt persists, FTS deferred; cursor passes first page and reaches later forget without bypass. Forget purges target; restart/rebuild cannot revive it. Front upsert is never lost. |
| Same-page upsert/forget            | Real hub page has front upsert then other existing-memory forget                                                                                                          | Page atomic commit reaches final sequence; approved upsert retained, forgotten body absent.                                                                                                                           |
| Parent before/after                | Approved descendant before parent, next unrelated operation, later parent; separate checkpoint-covered ancestry fixture                                                   | Approved payload/receipt durable and unrelated cursor progresses; actual missing parent connects exactly once; boundary-covered ancestry not permanently parked.                                                      |
| Accepted resolve/revert            | Approval ACK and pull with unrelated unsent local branch, scanner hold and brake; replay                                                                                  | Accepted revision/ancestry retained, frontier union preserved; no regeneration/resubmission. Local body/report may defer, original outcome fixed.                                                                     |
| Checkpoint/bootstrap               | Braked/scanner-held B receives multiple real checkpoint pages at S, tail contains forget                                                                                  | All-page canonical atomic install/cursor=S; no index-ready wait; normal tail reaches forget. Missing/truncated page installs nothing; hold payload remains purgeable canonical.                                       |
| Alias/suppression                  | Hub-approved alias upsert and multiple forget fragments while replica local alias quota full                                                                              | Every approved key union/receipt retained, cursor progresses; only new local alias refuses, re-import remains suppressed.                                                                                             |
| Relay failures                     | Owner offline, valid suspicious response, TTL expiration and revoked grant each through real relay service                                                                | Safe per-read termination/quarantine only transient cache; unrelated push/pull progresses, no transcript canonical/log/checkpoint promotion.                                                                          |
| N1/N2 regression                   | Joint real worker/sync start and actual MemoryCompactor publishes floor; third member below floor rejoins                                                                 | Registry sole generation, generic resolve execution count 0; real produced floor → complete bootstrap → tail pull; existing crash/token/pin expectations retained.                                                    |

#### apps/server/src/memory/MemorySyncService.test.ts

| Case                              | Activation                                                                                                                                                                                                                                  | Required observation                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scanner disagreement through sync | Hub allows, replica blocks during normal ordered pull; following memory operation                                                                                                                                                           | Canonical suspicious payload/receipt/outcome durable, local exposure/index/model held, cursor and unrelated operation continue; no local rejection receipt.                                                                                                                                                                                                                                       |
| Report backlog full               | Accepted resolve/revert catch-up at report delivery budget                                                                                                                                                                                  | Canonical receive/cursor succeeds, stable repair marker survives restart; bounded retry/manual retry delivers at most one Bot report.                                                                                                                                                                                                                                                             |
| Protocol faults                   | Truncated/malformed envelope, unsupported version and approved identity/digest contradiction through page codec                                                                                                                             | Whole page no writes/cursor move; safe protocol error. Observe bounded retry for transient corruption, config/reconnect for unsupported, checkpoint recovery for contradiction; stop repeated unrecoverable retries.                                                                                                                                                                              |
| Fairness/restart                  | Three deferred targets with the lowest ids fail on every attempt and one later held row exists, while a fourth target with a higher id has completable scanner/index/cleanup work; several actual finite pull cycles; restart in the middle | Unrelated cursor keeps progressing; the healthy fourth target completes within the second sweep because failed rows move behind it by backoff; the held row is never selected; no sweep exceeds MEMORY_DEFERRED_SWEEP_MAX_ITEMS/BYTES; after restart the order and backoff come from SQL and the healthy target is not re-run; durable oldest age/backlog without body copies or duplicate tasks. |

Write these tests in the implementation PR. **Do not execute tests, Vitest, e2e, bun/pnpm/vp test, or any build on juns-macbook-pro.** This document records proposed cases, not passed tests.

Use real migrated SQLite and real MemoryService/MemoryDecider/MemoryHubService. Stub external HTTP/descriptor, Crypto entropy, generation and FileSystem only where a fault/barrier is needed. H is the hub AND writer; A and B are members, giving three environments, not two writers plus an inert hub. Each has separate temp DB, ServerConfig, secrets and environment identity; none points to ~/.goat/userdata, ~/.t3, ~/.codex, ~/.claude or ~/.omo. TestClock.layer controls the hub clock; client clocks can intentionally differ. Direct in-memory HTTP/router adapters exercise encoding/auth without listening ports or server startup.

Source precedents: TestClock.adjust + layer at `auth/PairingGrantStore.test.ts:194-215`; gated competing operations at `sshRemote/SshWorkspaceSync.test.ts:661-681`; injected filesystem failure barrier at `auth/ServerSecretStore.test.ts:101-128`; drain accounting at `packages/shared/src/DrainableWorker.ts:45-93`; committed effect drain at `orchestration-v2/EffectWorker.ts:549`, `:799`. Await an explicit Deferred marking request entry/commit/generation or finite sync worker drain. A drain that swallowed a worker error does not prove success: assert persisted rows/receipts and failure state afterward. Do not use arbitrary polling, wall-clock sleeps, timeout-to-pass tests, or queue size as idle evidence.

| Test file                                    | Exact case name                                                               | Assertions / synchronization                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MemoryHubService.test.ts`                   | `deduplicates a committed operation after its response is lost`               | Inject drop after transaction commit; retry same bytes; one sequence/event/revision and identical receipt. Commit Deferred is barrier.                                                                                                                                                           |
| same                                         | `rejects a reused operation id with different content after payload purge`    | Forget original body then reuse ID; digest still rejects; no resurrection or forgotten text retained.                                                                                                                                                                                            |
| same                                         | `commits projection receipt and hub sequence together or rolls all back`      | Inject SQL failure between apply and receipt; no partial rows; retry succeeds once.                                                                                                                                                                                                              |
| same                                         | `serializes simultaneous claims and replays the winning attempt`              | Barrier starts H/A/B claims together; one winner, same-attempt retry retains fence/start; only one generation begins.                                                                                                                                                                            |
| same                                         | `retains the fencing counter across expiry release revoke and forget`         | Exercise transitions; reclaimed token strictly greater; old release cannot change new lease.                                                                                                                                                                                                     |
| same                                         | `rejects new resolve operations on push`                                      | Valid model-looking result via push fails lease_required; apply endpoint succeeds with valid lease.                                                                                                                                                                                              |
| same                                         | `rechecks membership after waiting for the transaction lock`                  | Pause admission, revoke/rotate, release barrier; stale principal cannot commit.                                                                                                                                                                                                                  |
| `MemoryHubAuth.test.ts`                      | `accepts only the active environment and space bound server bearer`           | Token table covers wrong identity/space/version, revoked, cookie/dev/MCP credentials; no writes.                                                                                                                                                                                                 |
| same                                         | `ignores browser cookies when authenticating a server bearer`                 | Valid bearer plus foreign cookie uses only server membership, no scope union.                                                                                                                                                                                                                    |
| same                                         | `recovers provisioning and rotation without exposing a partial credential`    | Inject secret write/SQL/persist response faults; stable request replay, staged inactive secret, old active credential until activation.                                                                                                                                                          |
| same                                         | `preflights hub identity and refuses redirects before credential forwarding`  | Wrong descriptor, unsupported v1 and redirect spy; zero credential calls to wrong/redirected origin.                                                                                                                                                                                             |
| `MemoryHubHttp.test.ts`                      | `round trips all eleven hub endpoints through the server principal`           | Table-driven join/push/pull/claim/renew/apply-resolution/release plus source-read request/collect/respond/result; schemas, status and no-store headers. In-memory adapter.                                                                                                                       |
| same                                         | `rejects invalid versions envelopes and bounds without domain writes`         | 426/400/413 cases, unknown body combinations, IDs/counters; cursor unchanged.                                                                                                                                                                                                                    |
| `MemorySyncService.test.ts`                  | `installs every tombstone before releasing the bootstrap push barrier`        | Multi-page checkpoint, pause final page, local old edit queued; zero pushes before completion; deleted receipt afterward.                                                                                                                                                                        |
| same                                         | `restarts an expired checkpoint without installing a partial projection`      | Advance hub TestClock to 600s while staging; prior projection/cursor survives; rejoin finishes.                                                                                                                                                                                                  |
| same                                         | `recovers a stale cursor and preserves unpublished local intent`              | Inject retention floor; full checkpoint; first materialization IDs stable on retry; immutable published operations unchanged.                                                                                                                                                                    |
| same                                         | `persists a missing parent while unrelated operations advance the cursor`     | Child first, independent memory next, restart, parent arrives; await parent commit then drain; pending clears and projection correct.                                                                                                                                                            |
| same                                         | `holds replica suspicious approval without stopping ordered pull`             | Hub scanner allows, replica scanner blocks; approved canonical payload/original receipt persist, exposure redacted, cursor/sibling advance. Pre-admission hub refusal remains a separate metadata-only receipt case.                                                                             |
| same                                         | `retains pending writes through offline retries and restart`                  | HTTP failures + TestClock backoff; local read works/pendingSync true; reconnect yields one operation.                                                                                                                                                                                            |
| same                                         | `bounds fixed watermark paging while new writes keep arriving`                | Inject later writes after first page; page through fixed T only, max ten pages; reschedule handles later entries.                                                                                                                                                                                |
| same                                         | `discards a delayed response from an earlier settings epoch`                  | Gate response, change endpoint/disable, release; new cursor/status unaffected.                                                                                                                                                                                                                   |
| same                                         | `ingests hub local writes without outbound echo or self HTTP`                 | Hub local commit/outbox→ledger; members pull; one sequence, no self HTTP or re-enqueue from foreign apply.                                                                                                                                                                                       |
| `MemoryHubScenarios.test.ts`                 | `three environments converge concurrent edits through one claimed resolution` | Start common revision, fork H/A/B edits, sync conflict, race claims; one pinned generation, all heads consumed, all three converge. Hold model Deferred and sync unrelated memory; it remains usable.                                                                                            |
| same                                         | `a stale holder cannot apply after hub expiry and a new claim`                | A holds result Deferred; adjust ONLY hub clock to exactly 120s, B claims greater fence; release A output, rejected; B commits. Deliberately skew member clocks.                                                                                                                                  |
| same                                         | `a third environment edit invalidates an in flight resolution`                | A claims H/A heads; B sends third variant while model paused; old result rejected, next claim consumes current three heads.                                                                                                                                                                      |
| same                                         | `forget beats an offline edit import revert and late model result`            | B offline queues old edit + import-derived intent; H forgets; A late model output; reconnect B via bootstrap/pull; no live bodies/FTS/snapshot/originals anywhere after purge drain, permanent source receipts suppress import. WP5 parser not needed here: supply its WP2 source receipt shape. |
| same                                         | `renewal failure and the ten minute cap never permit a local resolution`      | Hub clock advances 30s ticks with ack Deferred; failure cancels; second run renewal capped at 600s; no local result absent hub ACK.                                                                                                                                                              |
| same                                         | `lost apply acknowledgement repairs the resolving environment report once`    | Hub commits, drop response, restart A; replay/pull reconstructs one result/report; H/B receive no report copy.                                                                                                                                                                                   |
| same                                         | `pins the claimant default model without changing provider on failure`        | Table over six WP2 generator ports; edit settings mid-generation; old selection/options retained; typed provider failure leaves quarantine, one failure intent. No real provider process.                                                                                                        |
| `071_MemoryHubSync.test.ts`                  | `registers and replays MemoryHubSync with stable names and constraints`       | Migrate from WP2, repeat/reconcile ID shift; table/index/unique constraints, monotonic fences and payload-free retained receipts.                                                                                                                                                                |
| `serverSettings.test.ts`                     | `defaults old files to disabled and persists only a hub secret reference`     | Encode/decode old/new JSON; no raw credential; failed write restores old settings, epoch and credential.                                                                                                                                                                                         |
| `packages/shared/src/serverSettings.test.ts` | `replaces memoryHub modes as complete values`                                 | member→disabled→hub drops member fields; unrelated settings unchanged; no project override.                                                                                                                                                                                                      |

## 9. Verification commands and their actual coverage

Authoring this Markdown file needs source/document consistency review only. No package typecheck/lint was run while authoring: TypeScript checks do not validate a Markdown PRD, and the future implementation files do not exist yet. The following are the implementation's allowed local static commands, from repository root; they do not run tests or builds.

```sh
vp run --filter goat typecheck
vp run --filter @goat/contracts typecheck
vp run --filter @goat/shared typecheck
vp lint apps/server/src/memory apps/server/src/server.ts apps/server/src/environment/ServerEnvironment.ts apps/server/src/serverSettings.ts apps/server/src/serverSettings.test.ts apps/server/src/persistence/Migrations/071_MemoryHubSync.ts apps/server/src/persistence/Migrations/071_MemoryHubSync.test.ts apps/server/src/persistence/Migrations.ts apps/server/src/persistence/reconcileGoatMigrationIds.ts packages/contracts/src/settings.ts packages/shared/src/serverSettings.ts packages/shared/src/serverSettings.test.ts --report-unused-disable-directives apps/server/src/ws.test.ts apps/server/src/ws.ts
```

If the migration slot shifts, substitute the registered exact two migration paths. Wire contracts remain in WP1, including rev 3 relay contracts; WP3 defines no competing schema. Lint's memory directory includes the NEW services and focused tests; no --fix flag. Record command, exit code and any baseline diagnostics for each invocation. Do not call repo root typecheck/lint scripts or vp check.

| Command             | Why it reads the actual change                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| goat typecheck      | `apps/server/package.json:2` names the package goat, `:23` runs tsc-rs --noEmit, `apps/server/tsconfig.json:7` includes src (all new services, migration and test files) and existing integration scripts. Not the root recursive typecheck. |
| contracts typecheck | `packages/contracts/package.json:2`, `:32`; `packages/contracts/tsconfig.json:4` includes src, checking imports of WP1 settings/memory schemas, without redefining them.                                                                     |
| shared typecheck    | `packages/shared/package.json:2`, `:508` names the package and runs tsc-rs --noEmit; `packages/shared/tsconfig.json:6` includes src, covering whole-object patch helper/test.                                                                |
| explicit lint paths | CLI path arguments name all WP3 source/test roots; `vite.config.ts:109-125` configures lint and ignores vendored/generated/native trees, not these source files. No unrelated package directory argument.                                    |

Tests run in **PR CI (goat-ci)**, not this Mac. `.github/workflows/goat-ci.yml:1`, `:7`, `:24` selects PR events and EPYC runners; `:108-118` runs contracts/shared package tests; `:130-132` runs goat server test shards. `apps/server/package.json:24` points to vp test run; `apps/server/vite.config.ts:158-166` disables file parallelism and configures the sequencer/setup. Root `vite.config.ts:58-74` defines the Node environment/exclusions; new src/*.test.ts files are not excluded. No workflow changes are needed for discovery.

Collect exact-head goat-test-server shards plus goat-test-contracts/goat-test-shared and static job results as test evidence. A cancelled or skipped shard is not a pass. If CI has unrelated failures, report them separately; do not mark WP3 complete without evidence for its scenario suite. Local static checks alone cannot prove crash convergence or lease safety.

## 10. PR, boundaries and traps

Implementation PR title: **`feat(server): synchronize memory through a hub with fenced conflict leases`**.

Body gist: Memories committed on one environment previously remained local. Add authenticated per-environment hub membership, durable push/pull and tombstone-first bootstrap so offline writes converge without resurrecting forgotten content. Serialize conflict claims using hub-clock leases and persistent fencing; apply validated results only after checking membership, current heads and deletion. Describe focused three-environment CI evidence, static commands/exit codes, and the offline deletion visibility limitation. End with the actual model and harness used for implementation (do not copy the authoring session identity). One WP3 PR on WP2; no UI changes or screenshot assets in this phase. This authoring task creates no PR.

| Adjacent owner   | Settled responsibility                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP1              | Sole wire owner; consume its hub/admin/checkpoint/metadata-entry/status/capability/error schemas.                                                         |
| WP2              | Sole local SQL owner; consume foreign apply, checkpoint/materialization, permit, report repair/purge and pinned generation ports.                         |
| WP3 (this phase) | Hub-only tables, membership/settings secret recovery, cursor transactions through WP2 ports and claim/renew/coordinator. No import of later MemoryAccess. |
| WP4              | Core RPC/MCP and live settings:write adapters for WP3 methods; general memory advertisement.                                                              |
| WP5              | Receipt population and import activation after bootstrap; source suppression uses WP1 metadata.                                                           |
| WP6              | Client/report adapter; cancellation is bounded import chunk stopping and receipt status, no late contracts.                                               |

Out of scope: real hub setup or data import; provider-native writes; persistent transcript replication (bounded transient source relay is included); team sharing; semantic conflict across different memory IDs; automatic hub election, split-brain failover or migration to another published space; backup purge guarantees; UI, RPC/MCP handlers and provider snapshot formatting. Offline clients cannot know a remote forget before reconnect; convergence after receipt/bootstrap is the guarantee. Already sent provider context cannot be recalled by this protocol.

Implementation traps: generic browser auth silently selecting cookies; accepting a member's claimed origin instead of its principal; network/model I/O under SQL locks; duplicate domain apply via separate transactions; replay sending a body from before forget; whole-batch rejection stalling unrelated memory; local wall clock deciding lease authority; releasing by memoryId alone; resetting fences after release; resolve via generic push; generation fallback to title-model settings; checkpoint partial install erasing local intent; rebinding immutable operations to a different space; secret references interpreted as arbitrary paths; activation before settings/migrations ready; one runtime per feature; hub self-network/echo; reporting drain as successful without checking persisted failure receipts.

The contracts are settled in 010 rev 3. Refresh source anchors/migration slots against the integrated WP2 head before implementation; no contract ownership transfers to WP3.

Settings service methods accept WP2's repeatable permit, not the later MemoryAccess module.
getHubSettings validates settings:write before exposing MemoryHubSettingsView; every update
uses expectedVersion/requestId, body-free admin recovery and post-lock permit recheck.
MemoryHubSettingsView.version is persisted as memoryHubVersion (local server settings integer,
initial 0, absent old files decode to 0); it changes only after committed configuration change.
Hub admin actions consume the WP1 discriminator and return its update result, including only
explicit ephemeral provision/rotate credential responses. No generic settings patch bypass.

## Cross-phase contract reconciliation (rev 2)

Replaced competing wire DTOs with WP1 references; retained only hub SQL definitions. Unified cursor/store port names and UTC lease encoding, independent hub HTTP readiness, administration and resolver-only replay/report repair.

## Reflection r1 fixes (rev 3)

### File change map (G3/G4)

| Action              | Exact path                                                  | Diff to implement                                                                                                                                    |
| ------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| MODIFY (NEW in WP3) | apps/server/src/persistence/Migrations/071_MemoryHubSync.ts | Add transient memory_hub_source_reads to the same MemoryHubSync migration; no permanent transcript log.                                              |
| MODIFY (NEW in WP3) | apps/server/src/memory/MemoryHubService.ts                  | requestSourceRead/collectSourceReads/respondSourceRead/sourceReadResult with identity, TTL, reference, scanner, tombstone and delegated-read checks. |
| MODIFY (NEW in WP3) | apps/server/src/memory/MemoryHubClient.ts                   | Add four typed relay calls using existing principal auth/preflight/no-redirect/deadline/no-store codecs.                                             |
| MODIFY (NEW in WP3) | apps/server/src/memory/MemoryHubHttp.ts                     | Add four POST routes; decode/call-one-method/encode only, using WP1 contracts.                                                                       |
| MODIFY              | apps/server/src/memory/MemoryStore.ts                       | Hub request/outcome SQL codecs, transactional forget purge and relay TTL sweep; reuse memory_payloads for purgeable response bytes.                  |
| MODIFY (NEW in WP3) | apps/server/src/memory/MemorySyncService.ts                 | Owner collection/response pass inside syncOnce; requester bounded result loop through injected MemorySourceReadAuthority.                            |
| MODIFY              | apps/server/src/memory/MemoryService.ts                     | Consume the injected relay port, emit WP2 changes after foreign apply/cursor/checkpoint commit; no second publisher.                                 |
| MODIFY              | apps/server/src/server.ts                                   | Inject one MemorySourceReadAuthority from the existing sync instance, no separate runtime or connection.                                             |
| MODIFY (NEW in WP3) | apps/server/src/memory/MemoryHubScenarios.test.ts           | Real A→H→B→H→A page and forget/offline/revocation scenarios.                                                                                         |
| MODIFY (NEW in WP3) | apps/server/src/memory/MemoryHubHttp.test.ts                | All eleven routes through in-memory auth/router; wrong requester/owner rejected.                                                                     |
| MODIFY (NEW in WP3) | apps/server/src/memory/MemorySyncService.test.ts            | Relay restart/TTL/response race and foreign change publication.                                                                                      |

### 5.1 Hub migration extension: sole relay SQL inventory

Append this DDL to section 5.1's migration. The nullable response payload is in WP2's purgeable
memory_payloads, with the linked memory_id and dependency revisions; no response body in JSON
metadata, receipts or the hub operation log. payload_ref is requestId rendered in a private
source-read namespace, not a MemoryRevisionId claim. Its private payload codec decodes the WP1
MemorySourceReadOutcome available arm; dependency lookup and purge handle that codec too.

```sql
CREATE TABLE IF NOT EXISTS memory_hub_source_reads (
  memory_space_id TEXT NOT NULL, request_id TEXT NOT NULL,
  requester_environment_id TEXT NOT NULL, owner_environment_id TEXT NOT NULL,
  requester_credential_version INTEGER NOT NULL,
  memory_id TEXT NOT NULL, request_digest TEXT NOT NULL, request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','completed','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  outcome_metadata_json TEXT, response_payload_ref TEXT,
  response_digest TEXT,
  PRIMARY KEY(memory_space_id, request_id),
  CHECK(expires_at > created_at),
  CHECK(state = 'completed' OR response_payload_ref IS NULL)
);
CREATE INDEX IF NOT EXISTS memory_hub_source_reads_owner_deadline
  ON memory_hub_source_reads(memory_space_id, owner_environment_id, state, expires_at);
CREATE INDEX IF NOT EXISTS memory_hub_source_reads_memory
  ON memory_hub_source_reads(memory_space_id, memory_id);
```

request_json uses WP1 MemorySourceReadRequest (body-free locators/scope attestation/deadline).
SQL integer times encode/decode canonical UTC wire timestamps. outcome_metadata_json stores only
outcome kind/safe denial/failure or nullable page watermark/cursor, never messages. Result builds
the available outcome by loading its purgeable payload. Tables/codecs are not redefined by WP4.

Expire at hub now>=expires_at; erase response payload, cursor metadata and locators, then remove
expired transient row. A missing/expired id returns expired/source_unavailable, not an empty page.
No deletion of permanent tombstones/fences/operation receipts. Sweep expired rows at startup and
each sync cycle plus before each relay route read; response data never escapes after the deadline.
Keep at most 32 live requests per requester, each <=64 KiB, and bounded collection <=32/64 KiB;
excess admission returns unavailable, without slowing ordinary push/pull. Requests are transient
and may time out on hub restart; no promise of durable source delivery after their 75-second cap.

### G4 service, route and sync diffs

```diff
 // MemoryHubHttp.ts, MEMORY_HUB_PATHS maps to these service ports
+POST /api/memory-hub/v1/source-read/request -> requestSourceRead(principal,input)
+POST /api/memory-hub/v1/source-read/collect -> collectSourceReads(principal,input)
+POST /api/memory-hub/v1/source-read/respond -> respondSourceRead(principal,input)
+POST /api/memory-hub/v1/source-read/result -> sourceReadResult(principal,input)
 // MemorySyncService: receive tombstones first, finite relay pass before pending push
+yield* serviceExpiredSourceReads;
+yield* collectAndRespondSourceReads;
 // <=32 requests; each grant/scanner/TTL/owner/transport failure ends that read only, never pull
 // requester MemorySourceReadAuthority
+readSource(request, permit) -> requestSourceRead -> bounded sourceReadResult loop
+// resolve with available page OR typed denial/forgotten/source_unavailable before 75s
```

Requester server derives requestId once, stamps authorizedScopes only after live memory:read
AND orchestration:read, validates that sourceThread/messageIds/watermark are evidence of the
requested live memory, then posts to H. H stamps authenticated requester and hub deadline
(now+75s), verifies both active same-owner provisioned members, and deduplicates identical
requestId/digest. Changed digest yields operation_id_reused. H must not rely on a hostname or
request-supplied owner: owner is exactly sourceThread.environmentId.

B's existing 30-second sync loop collects only B-owned pending requests after it has received
remote tombstones. B validates active requester attestation and its **current same-owner
delegated source-read policy** (exact predicates defined by 010 rev 3), including explicit orchestration:read; memory:sync only permits
transport. Recheck policy/member/thread/memory deletion before a consistent committed source
read and again before response submission. Read only evidence-linked completed messages at the
fixed source watermark. The owner-local helper in MemoryService uses the existing injected
thread repository getThreadRecords(threadId,["messages"],{messageIds}) (precedent:
ThreadTitleRegenerationService.ts:73–78), inside a consistent committed read with source event
sequence validation. It filters streaming messages and rejects source events beyond the
retained watermark; malformed locator/watermark returns source_invalidated. It does not call
HostThreadsMcpService.readOnHost or SshRemoteDispatch. Run scanner
before responding. Forbidden returns denied; missing/offline/deleted thread returns unavailable.
No provider CLI, SSH route, requester-to-B browser connection or full transcript replication.
A local owner can use the same committed-read helper directly with the same permit checks.
The hub can also be owner/requester: use the same service transactions without self HTTP.

H accepts only authenticated owner responses bound to exact request/locators/64-KiB bound/deadline and current grant/tombstone. Scan before storing bounded transient relay cache; no canonical memory promotion, sequence/log/checkpoint/FTS. Duplicate digest ACKs; changed digest refuses only read. Expired/revoked/forgotten response is discarded. Requester repeats permit/eligibility/generation/locator checks after await; suspicious valid response is confined to existing TTL cache or ends safely as secret_detected. Offline/network/owner failure becomes source_unavailable. No direct route or colliding local-ID fallback. Production polling is bounded by 75s; CI uses TestClock/Deferred. Every read failure leaves unrelated memory push/pull running.

### G3 forget and field lifecycle

Hub forget first commits canonical purge, source eligibility fence and invalidation of transient response/staged/dependent payloads. Late owner/result retries recheck tombstone/generation before construction. Derived failure persists cleanupPending, not failed forget. Member receive/bootstrap emits body-free post-commit change signal only; lost wakeup recovers by reset/restart from SQL. No second sequence or body-bearing broadcast; remote offline convergence follows normal sync.

| Values                                          | Generation → serialization → deserialization → consumers                                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request id/digest/requester/owner/scopes/expiry | A service's live permit/locators → WP1 request HTTP JSON → H strict decode/member stamp/SQL request codec → B collect decoder/owner policy/committed reader. No client token or body.   |
| available page / denied / unavailable           | B bounded committed reader/scanner → WP1 respond codec → H row metadata + purgeable payload codec → A result decoder/permit → WP4 MemorySourcePage or safe auth/domain error.           |
| memoryId/dependencies/TTL                       | Validated reference/H clock → hub row/payload dependencies → forget/TTL transaction → scanner-safe result route; no checkpoint/outbox/provider consumer.                                |
| forget/invalidate/reset watermark               | WP2 applyReceived/completeCheckpoint commit (projection+cursor+purge) → WP1 signal → WP4 stream/runtime → WP6 open cache removal. Hub operation remains the durable replication source. |

### Activation scenarios and future CI cases

| Exact test file                                   | Case and observable assertion                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| apps/server/src/memory/MemoryHubScenarios.test.ts | `source page travels from A through H to B and back without a direct route`: three real stores/in-memory HTTP, B holds sole synthetic source, A has colliding local thread id; B sync collect/respond, A returns B text and exact watermark, zero A transcript reads and no operation/checkpoint transcript bytes. |
| same                                              | `offline source owner expires within the bounded wait`: no B sync; advance TestClock exactly 75s; typed source_unavailable, summary still searchable.                                                                                                                                                              |
| same                                              | `forget purges queued and completed source responses before return`: gate B read/A result with Deferred, H forget then resume; payloads absent, late response refused, safe outcome only.                                                                                                                          |
| same                                              | `source access is not implied by sync or memory read`: missing thread-read attestation, revoked member and owner-policy denial yield no committed source read/available page.                                                                                                                                      |
| apps/server/src/memory/MemoryHubHttp.test.ts      | `all eleven routes authenticate the correct member`; `only requester fetches and only owner responds`; `wrong page locator oversized page and changed request digest cannot persist`.                                                                                                                              |
| apps/server/src/memory/MemorySyncService.test.ts  | `relay crash retry preserves request identity until expiry`; `source failure does not block unrelated push pull`; `source TTL cleanup never removes permanent delete knowledge`; `foreign forget publishes after cursor commit and checkpoint publishes reset`.                                                    |

Run in existing server shards in PR CI only; no extra local test/server. Summary: G4 now has
one reachable transport, eleven typed hub routes and a transient purgeable table; G3 uses the
same committed publication path on every receive/bootstrap path. These are plan obligations,
not verified runtime claims.

## Audit r1 fixes (rev 4)

### Final change map additions (audit r1)

| Action | Exact path                   | Change                                                                                   |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------- |
| MODIFY | `apps/server/src/ws.ts`      | Generic settings reserved-key rejection preserves declared ServerSettingsError contract. |
| MODIFY | `apps/server/src/ws.test.ts` | Generic bypass rejected atomically; WP4 later verifies dedicated success.                |

### B2 — automatic claim scheduler and recovery

syncOnce invokes sweepClaimCandidates after bounded pull/push/pull even when push batch is empty.
start performs recoverClaimCandidates and an immediate syncOnce, then listens to committed claim
intent notifications as well as sync outbox/settings changes. Notifications are only wakeups;
SQL is authoritative. No tool/UI/manual claim call is needed to start resolution.

```ts
const sweepClaimCandidates = Effect.gen(function* () {
  const due = yield* store.readDueClaimCandidates(100, yield* Clock.currentTimeMillis);
  yield* Effect.forEach(due, (candidate) => scheduleConflictResolution(candidate.conflictId), {
    concurrency: MEMORY_RESOLUTION_MAX_ACTIVE,
    discard: true,
  });
});
// scheduleConflictResolution: tryReserveResolutionSlot(MEMORY_RESOLUTION_MAX_ACTIVE, memoryId) atomically; if full return
// -> local candidate CAS -> reload quarantined sorted heads/no tombstone -> hub claim
// -> persist ticket + kind resolve -> registerClaimedExecutionInAppScope(ticket, slot) -> return.
// ResolutionTicket / ResolutionSlot are private server types, not wire schemas.
// Registration acknowledges fiber ownership only, not runClaimedResolution completion.
const runClaimedResolution = (ticket: ResolutionTicket, slot: ResolutionSlot) =>
  Effect.gen(function* () {
    yield* withScopedRenewal(
      ticket,
      Effect.gen(function* () {
        const output = yield* pinnedGeneration(ticket);
        const accepted = yield* authority.applyResolution(ticket, output);
        // Original approval persists/reconciles by ACK/pull; local hold is not renewal failure.
        yield* store.commitAcceptedResolution(accepted); // canonical + repair flags only
      }),
    );
    // Registry owns execution; WP2 ports cannot schedule/recover it. Not held by syncOnce.
  }).pipe(
    Effect.ensuring(finalizeClaimedExecution(ticket)),
    Effect.ensuring(releaseResolutionSlot(slot)),
  );
// Finalizer stops renewal/generation and persists execution state; after hub approval, reconcile
// canonical receive/deferred repair without regeneration. Bounded release then outer slot return; shutdown awaits finalization.
```

At most four active attempts per environment, one per memory; due candidates beyond available
slots remain durable. The local claim deadline and coordinatorEpoch prevent repeated syncOnce
from duplicating work; no transaction is held across claim/generation/network. Claim succeeds
only for the reloaded head digest. Persist attemptId before request; retry an uncertain response
with that same id, recover its ticket rather than launch a competing attempt. Superseded heads
cancel the candidate and registered execution (including generation/renewal); the new frontier already has its own row.

claim_busy records retry metadata and keeps quarantine. If busy response supplies no expiry,
use a 30s backoff; if an authoritative ticket expiry is known, next attempt is no earlier than
that expiry. Transient claim failures use persisted 5s/30s/120s/10min capped backoff. Renewal
failure cancels generation and retries no earlier than known lease expiry; 10min total attempt
cap releases matching token and schedules a later attempt. Permanent schema/secret/auth/identity
failures stop that candidate until the relevant input/policy/settings changes. Pull may consume
another member's accepted result and complete/cancel the candidate before the retry is due.
Startup sweeps projection/candidate/ticket state; claim_busy, process crash and expired lease
all remain recoverable. The worker never generates before durable successful ticket admission.

MemorySyncService.test.ts CI cases: `start alone resolves a newly pulled conflict` and
`syncOnce alone starts first generation after quarantine commit` drive only these public entry
points, observe a Deferred at real WP2 generation and then the accepted persisted revision;
never seed or directly call claim/scheduleConflictResolution. Also cover restart after candidate commit,
crash after ticket before worker signal, competing busy claimant, retry at TestClock deadline,
lease expiry takeover, head change and tombstone cancellation. Capture unrelated-memory cursor
progress while a claim is busy.

### B4 — pull-before-push divergence

Hub push/apply-resolution/revert admission checks current hub heads and lease/fence as applicable.
Authenticated pull/checkpoint/ACK/accepted resolution use the same WP2 approvedReplica incorporation: immutable integrity checks, preserved canonical result/ancestry/original outcome/digest, local scanner/index/parent/report flags. No repeated local-head/lease/quota admission. Preserve unrelated ordinary unsent heads; pending/rejected revert is not a head. Minimum conflict/claim marker commits with cursor, scheduling is deferred if needed. Tombstone purges payloads and fences delayed work. Replay preserves ancestry and creates no sync echo.

MemoryHubScenarios.test.ts: H accepts resolve of A/B; C has a local unsent head from A, then
reconnects with pull BEFORE push. Assert H result is present in C DAG, frontier is result+C,
C is quarantined, cursor advances, unrelated memory progresses, and H's next descendant has
no missing parent. Push C afterward creates the corresponding hub conflict. Repeat with an
approved revert compensation and with forget (forgotten everywhere, zero retained payloads).
Use three isolated stores H/A/C and controlled network/clock; no live server or local test run.

### B5 — dedicated-only administration

Both serverSettings.ts generic `updateSettings` and `updateProviderInstance(mutation, patch)`, and
packages/shared/src/serverSettings.ts applyServerSettingsPatch, reject an OWN memoryHub key
before normalization/merge/persistence, including a mixed patch. Reject memoryHubVersion too:
version is server-owned, never a generic patch field. Schema reserved-key rejection in WP1
fails RPC payload decoding before a handler runs. A typed runtime patch rejection maps to
ServerSettingsError {settingsPath, operation: "normalize"}, already declared in that RPC error
union, with a safe reserved-key cause; never MemoryHubError or a new undeclared error.
Dedicated memory.hubSettings.update alone admits requestId/expectedVersion and settings:write;
it calls an internal applyMemoryHubTransition persistence helper under its existing admin lock,
not the public generic updater, avoiding recursive locks/re-entry. Recovery/admin outbox uses
that same internal helper with its stored request/version and post-lock permit.

Change map adds apps/server/src/ws.ts and ws.test.ts for explicit generic rejection mapping.
serverSettings.test.ts exercises both runtime entry points and mixed-patch atomic denial;
packages/shared/src/serverSettings.test.ts proves no generic merger bypass;
ws.test.ts checks authorized generic caller still cannot configure/provision via memoryHub,
while dedicated RPC tests in WP4 prove accepted transition and version retry. No secret staging,
credential rotation, settings publication or coordinator cancellation occurs on generic rejection.

B7: [Enforcement inventory](000_plan.md#enforcement-inventory) distinguishes hub CAS/fencing
from replica DAG merge and UI policy hints.

### B8 — mechanical static-input coverage receipt

Final NEW/MODIFY map (including rev 2/3/4 additions): **25 TS/TSX paths**.
Compared path equality/explicit-directory ancestry against every `vp lint` argument and
package ownership against explicit `-p` / exact package-filter typecheck commands: **0 uncovered
lint targets, 0 uncovered typecheck targets** after declared generated-file exclusions.
Typecheck owners: `apps/server/tsconfig.json`, `packages/contracts/tsconfig.json`, `packages/shared/tsconfig.json`.
This is path/config reconciliation, not successful compiler/linter execution. Workflow YAML,
package manifests and prose are outside TS lint; review their diffs and validate in CI. At phase P
repeat with the actual diff, compiler file collection and lint ignores; an exit 0 without target
collection is insufficient. Authoring uses Python text checks only; no installation/check runner.

## Reflection r3 fixes (rev 5)

### G1 — revert push receipts settle intent, not a rejected DAG branch

WP2 stages `PendingMemoryRevertIntent`; readEligibleOutbox serializes its existing WP1 revert
operation within the same batch/byte limits, without local DAG incorporation. Hub checks the
current result head at admission and dedups the stable operationId/digest. Only acceptance
creates compensation. acknowledgeOutbox uses approvedReplica to atomically record approval and settle intent with accepted plus localAvailability. Local hold/index/report may defer, never creates rejected DAG branch. Hub revision_changed/tombstone settles terminal status without head/success report; accepted metadata remains under later delete. Lost response retries identical submission, pull repairs once; startup reconciles known approval without new generation/submission. Tombstone cancels pending intent before push and wins all late ACKs.

MemoryHubScenarios.test.ts planned CI: resolve R -> offline C pending revert T -> H accepts U ->
restart C -> C pull U -> C push T rejected revision_changed -> restart C again. Assert C/H
frontier {U}, no T revision/descendants, no repeated exact-head claim failures, unrelated cursor
progress and zero reverted success reports. Also cover lost accepted ACK, same-ID replay and
tombstone arrival while intent is pending. Drive persisted events/Deferred, no sleeps.

### G2 — scheduling completes before the model

`scheduleConflictResolution` replaces the ambiguous resolveConflict entry point. Its return
means durable ticket + app-scope execution registration, not completed resolution. Registration
failure releases the reserved slot and records recoverable ticket state/release attempt. The sole
WP3 MemoryResolutionRegistry has at most MEMORY_RESOLUTION_MAX_ACTIVE reserved/running/finalizing executions per environment and
one per memory; repeated syncOnce cannot duplicate a ticket or oversubscribe. Full slots leave
candidates durable. Slot completion signals another finite sweep. Generation/renew/apply/release
belong to runClaimedResolution; only its finalizer returns the slot, using an outer ensuring even on cleanup failure. App shutdown closes the
registry to new registrations, interrupts each execution, awaits bounded cleanup and preserves
uncertain ticket/submission state for startup recovery. No request-scoped detached fibers.

MemorySyncService.test.ts planned CI: activate conflict via start/syncOnce; block the real model
on Deferred; while blocked, commit a second memory and call the SAME environment's next syncOnce.
Assert outbound receipt, inbound unrelated projection and cursor advancement before releasing
the model. Start five memories: four generation-start signals, fifth remains due; completing
one finalizer admits the fifth, with observed peak <=4. Shutdown with blocked generation:
renewal stops, matching release is attempted, slots/registry are cleaned and late output cannot
commit. Restart recovers a ticket persisted before registration without duplicate execution.
These are future CI cases; this document revision ran no tests/build/server.

## Requirement 7 / M19 (rev 7)

### Operational floor, checkpoint and admission

Add MemoryCompactor to WP3 app composition from the first release; extend WP3 migration with
memory_hub_retention PK(space) holding published checkpointSequence, causalBoundary,
retentionFloor and last compaction receipt. Local counters/staging/compact ledger use WP2
ports; do not introduce duplicate local SQL ownership. Maintenance triggers at the earliest
MEMORY_CHECKPOINT_INTERVAL_MS, MEMORY_CHECKPOINT_TRIGGER_TAIL_ROWS or
MEMORY_CHECKPOINT_TRIGGER_TAIL_BYTES. Publish a consistent complete recoverable checkpoint,
then advance floor and compact the prefix older than MEMORY_LOG_RETENTION_MS, in a crash-safe
publication transaction. Failed materialization leaves the prior floor/checkpoint intact.

Checkpoint includes current heads, unresolved conflicts, still-valid revert inputs, tombstones,
suppression/fences, bounded causal boundary and permanent compact receipts. It does not retain
all historical ancestry. F denotes the minimum afterSequence from which the remaining tail
can be read; afterSequence == F is valid. Compact only a contiguous safe prefix. Unsent or
protected input references and live token tail pins block unsafe deletion, not independent
unbounded logs. Tail MEMORY_LOG_MAX_TAIL_ROWS/MAX_TAIL_BYTES and aggregate logical budgets
refuse new log admission when safe compaction cannot make space; deletion uses its reserved
capacity. Never advance floor before a finished checkpoint is durably published.

Hub ACK and whole-replica ACK differ: eligible history needs hub acceptance plus checkpoint
recoverability, not all offline replicas. A long-offline member bootstraps. cursor < F follows
cursor_expired → join/bootstrap → tail pull → review pending unapproved edits. Only unapproved
local parent known below boundary becomes base_compacted, retaining original text for explicit
review in bounded intent storage. Approved ancestry replaced by checkpoint boundary is valid;
actual missing parent keeps canonical payload/ref and linkage hold with checkpoint recovery.
Approved hold uses canonical flags/refs, not MEMORY_WORK_* admission or duplicated payload.

A token pins the tail it needs for MEMORY_CHECKPOINT_TOKEN_TTL_MS from first issuance. One
valid handle per member; renewal/retry cannot extend initial deadline. MEMORY_HUB_MAX_MEMBERS,
MEMORY_CHECKPOINT_MAX_HANDLES_PER_MEMBER/MAX_HANDLES_PER_HUB and
MEMORY_CHECKPOINT_STAGING_MAX_BYTES govern hub new checkpoint preparation, not replica
reapproval of published pages. Replica requires actual durable storage, complete pages and atomic
install; local policy quota cannot refuse. Expired/explicitly replaced token restarts join; no partial install.
pages. Source relay uses MEMORY_SOURCE_READ_MAX_PER_ENVIRONMENT/MAX_PER_HUB and
MEMORY_SOURCE_READ_OUTCOME_MAX_BYTES; keep existing MEMORY_SOURCE_READ_TIMEOUT_MS, clean expired
rows before admission, purge consumed results early, retain first deadline across retries.
Source bodies never enter log, checkpoint or FTS.

Hub is final space-global canonical admission authority. localIntent reserves local creation budgets;
approvedReplica accounts and persists approved operations/checkpoints/receipts/aliases even above
local quota/brake/work/report limits. Device FTS allocation is never aggregated across replicas
or checked as hub request admission. Offline local commit may be hub-refused, preserving user
text for review. Actual canonical storage write failure retains cursor and original approval for
retry; it never creates capacity-rejected receipt or cursor skip. Approved ledger digest mismatch
is protocol error; unapproved local ID collision settles local intent for review instead. Hub new
operation/alias uses permanent ledgers/reserved forget capacity; detailed JSON is not retained forever.

### Registry-only resolve recovery (N1)

WP3 MemoryResolutionRegistry alone scans recoverable resolve tickets, reserves a slot, checks
local coordinator epoch/CAS and the hub lease/head/fence, registers runClaimedResolution and
owns generation/renew/apply/release/shutdown. Generic worker excludes claim/resolve/revert_intent
from due SELECT, sweep, recovery, claim and execute. WP2 pinned-generation/accepted-commit ports
are internal registry dependencies, not alternative scheduled execution routes. Existing
DrainableWorker direct execution therefore never sees a resolve ticket.

Persist ticket before registration. Registration failure records recoverable state, attempts
matching release and returns the slot without generation. Crash after persistence is recovered
by the same registry only; an old/uncertain lease is reconciled with hub before retry. Live
reservation spans execution/finalization and shutdown; startup never resets its ownership
without CAS/expiry. No duplicate generation from repeated syncOnce or generic restart.

Close CAS bypass inventory in implementation diff: public/direct service resolve calls,
MemoryWorker generic execute/due SELECT, DrainableWorker delegates, SQL recovery and manual
repair, MCP/RPC/agent/scheduled entry points, accepted replica/checkpoint installation and
local accepted-commit port. All resolution execution reaches the registry; accepted mutation
reaches hub authorization then WP2 transaction, not an arbitrary local boolean authority.

### Storage measurements and activation CI (N2)

MemorySyncService.syncStatus.storage forwards MemoryQuotaService live logical counters and
cached maintenance samples: table rows/logicalBytes/allocatedBytes, shared DB file/WAL/freelist,
retentionFloor/checkpointSequence and last compaction/removed rows/reclaimable/blocked reasons.
Forward WP2 readStorageStatus/readStorageGrowth and persisted ftsAdmission unchanged through
010 MemoryStorageStatus; no separate hub sample table, duplicate producer or history array.
WP2 owns startup/maintenance sampling, the 30 completed-UTC-day ring plus fixed current sample,
1/7/30-day baseline selection, signed deltas, actual elapsed time, restart/missing-day/partial
measurement semantics. Hub-local storage uses the same WP2 ports; remote member telemetry is
not combined with hub allocation. Shared DB/WAL/freelist deltas remain explicitly shared.
Source-runtime exact-head server CI executes real SQLite measurement/maintenance, persisted brake/unavailable and M20 ordered-pull activation. Same-SHA packaged desktop artifact/backend execution is separate mandatory off-host evidence; desktop build alone proves no runtime support. Unavailable dbstat is explicit, never zero, and observed support is distinct from injected failure. Physical brake gates local creation and index, not approved canonical receive. Canonical forget/cascade/compaction continues; derived failure uses read fence + cleanupPending. Braked replica must receive front upsert then later forget through normal sequential pages, never bypass/delete-only delivery. source-runtime verified / bundled-runtime pending until packaged evidence; requirement 7 needs both.
Shared freelist warning requires both MEMORY_FREELIST_WARNING_RATIO and
MEMORY_FREELIST_WARNING_MIN_BYTES. Do not scan all pages for each status request.

MemoryHubScenarios.test.ts must advance TestClock and run the REAL MemoryCompactor (not set
floor directly), await published checkpoint/compaction receipt, and reconnect a third offline
member with cursor below produced floor: bootstrap, pull after S and preserved stale edit
review. Include floor equality, publish crash rollback, pinned tail, explicit early token expiry,
normal token expiry/restart, protected-history blocking, receipt replay and forget after
checkpoint/rebuild. Injected floor tests remain only supplemental. Existing goat-ci server
suite runs these actual files; weighted shard collection is not operational activation proof.

MemorySyncService.test.ts must start the actual MemoryWorker AND MemorySyncService together;
inject shutdown immediately after ticket persistence, registration failure and restart.
Assert one generation start for the recovered ticket, registry peak <= MEMORY_RESOLUTION_MAX_ACTIVE,
generic resolve execute count zero, unrelated sync progress and bounded shutdown/renew/release.
Use Deferred/persisted milestones and TestClock, no sleeps. Exact-head CI plus audit is still
needed to call N1/N2 runtime CLOSED; this revision closes their documented execution gaps only.

## Audit r3 fixes (rev 7)

Historical audit r3 admission/cursor-stop expectation is superseded by M20. R1/R2 source CI now proves persisted-braked replica receives approved upsert with original receipt/canonical payload and FTS deferred, advances normal page cursor, then receives later forget and purges without resurrection after restart/rebuild. Local creation still fails; hub-global quota remains admission. R3 status round-trip preserves deltas/brake plus separate receive/processing progress. Maintenance release/restart/unavailable remain required. N1/N2 stay plan-level; no runtime CLOSED or requirement 7 approval.

## M20 replan (rev 8)

Directly unifies pull/checkpoint/ACK/accepted resolution under approved ingestion; replaces cursor-stop/replica reserve/bootstrap-drain expectations. Defines protocol/storage recovery, fair drain and per-read relay failures. Owning test sections include R4 normal sequential upsert→later forget plus every sync activation; real compactor/registry cases retained.

Docs-only amendment; no source edits, installation, tests, builds, server/user-data writes, commit
or push. All newly specified runtime/CI cases are NOT RUN; no runtime CLOSED or requirement 7
completion is claimed.

## Audit r5 fixes (rev 10)

- R6: fairness CI row strengthened to prove a healthy deferred row behind failing and held rows completes, with sweep caps and restart order.
- R7: replica secret holds release only by policy-version rescan; no explicit rescan entry point.
