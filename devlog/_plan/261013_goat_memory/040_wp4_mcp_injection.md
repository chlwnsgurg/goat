# 040 — WP4: memory MCP and provider injection (WP3 final re-anchor r1)

Date: 2026-10-14. Status: **READY_FOR_REVIEW**, not implementation approval or runtime proof.
This is the bounded planner handoff; architect reflection and independent A remain coordinator work.
This re-anchor writes only 040 and one WP3-final consumption record in the WP4 cycle of 000. Source changes,
other plans, tests, builds, push and PR creation are outside this pass. The explicit two-document
commit request overrides AGENTS.md's default against committing plans.

## 1. Baseline, outcome and stale check

- Re-anchor input HEAD: `b2a54d9ac5d81bdcba433f368cd32cd256c83d97`, branch
  `goat/memory-wp4-mcp-injection`, clean worktree `goat-wp4-plan`.
  This merges WP3 final `5f12fb1b8` onto WP4 plan `cfa07255f`; WP3 is present.
  #183 green is supplied predecessor evidence, not a fresh CI check in this pass.
- Authority: 000 WP3 B integration 1–3, 030 current §8 and decision rows rev 11f/11g,
  and the actual merged source. Previous WP4 A near-pass remains historical; this re-anchor
  requires fresh reflection/A before B. No remote ref movement or push is authorized.
- Scope: only 040 body and the WP4 cycle in 000; 030/050/060 are read-only.
  The explicit plan commit request overrides the general no-plan-commit default.
- Loop: satisfy-spec; trigger: WP3 final integration; goal: executable MCP/injection/source
  consumer plan; non-goals: implementation, tests/builds, push/PR. Verifier: static source
  comparison and two-file diff check (not runtime proof). Stop: local commit and
  `/tmp/goat-wp4-replan-r1.md`. Outcomes: PLAN_READY or NEEDS_DECISION. Escalate only a
  product/authority choice that cannot be resolved from M1–M20; none is required here.
  Architect reflection and independent A are coordinator work for this bounded re-anchor.

Outcome: six providers consume the same environment-owned service, a bounded snapshot at real
prompt start and explicitly granted MCP tools. Nine core memory tools remain; a separate
settings administration toolkit adds the narrow hub-disable tool (§6). Originals are requested
from the owner, through the transient hub relay; they never enter canonical memory or injection.
Forget/revoke fences new selection, pending reads and restoration; already delivered bytes
cannot be recalled and offline replicas learn deletion through WP3.

`S/` = `apps/server/src/`, `C/` = `packages/contracts/src/`. The table covers the prior 040
port/signature/location/ownership/test assumptions; OK means current seam, MISSING means WP4
work absent, STALE means the preceding plan's claim is incompatible with the merged code.

| ID | Prior assumption | State | Current evidence and disposition |
| --- | --- | --- | --- |
| R01 | WP3 absent / rev 11c frozen proposal | STALE | WP3 is merged at the input HEAD; 030 decision rows rev 11f/11g govern, not old base/ref wording. |
| R02 | Mutations and StoredReceipt | OK | S/memory/MemoryService.ts:162–176; same service methods; transport maps local receipt, never hub ACK. |
| R03 | List/search/read/history service ports | OK | S/memory/MemoryService.ts:177–192; keep live Permit and typed service failures. |
| R04 | Candidates retain list continuation already | MISSING | S/memory/MemoryService.ts:1100–1123 drops nextCursor; C/memory.ts:1179–1183 lacks it. L1 adds it before consumers. |
| R05 | Exact revision read and snapshot renderer | MISSING | S/memory/MemoryService.ts:1124–1165 provides exact-ID reads, but no nextCursor; C/memory.ts:1172 still requires raw text substring. L1 fixes producer/schema and adds renderer/snapshot. |
| R06 | No prepare/validate source ports | STALE | S/memory/MemoryService.ts:55–88,1200–1260 implements both. Public readSource remains absent; activation is WP4. |
| R07 | WP3 supplies activated owner policy/reader | STALE | S/memory/MemorySyncRuntimeLive.ts:168–171 denies both. S/memory/MemorySyncService.ts:1350–1375 converts access failure to terminal denied. WP4 owns policy, attestation and reader. |
| R08 | Source request proves caller rights | STALE | C/memory.ts:2247–2269 has scope snapshot and requester environment only; S/memory/MemoryService.ts:1211–1219 creates literal scopes. S/memory/MemoryStore.ts:7306–7345 stamps member environment/deadline, not caller identity. |
| R09 | Sync wrappers are future / all return ServiceError | STALE | S/memory/MemorySyncService.ts:87–115 exports wrappers now; Error = Hub.MemoryHubServiceError (:28); update uses AdministrationError or AccessError (:111–112). No guessed casts. |
| R10 | start/syncOnce/schedule are function calls | STALE | S/memory/MemorySyncService.ts:90–93 exports Effect values; shutdown is Effect<void>. readLocalReadiness/requireBootstrap are functions (:94–98). |
| R11 | Unbound status requires a space | STALE | S/memory/MemorySyncService.ts:1838–1844,1878–1915 returns unbound readiness and null-space storage/status; disabled is not an empty/fabricated success. |
| R12 | Settings cache is safe within SQL | STALE | S/serverSettings.ts:275–279,1617 provides committed Ref; S/server.ts:515–529 consumes it. Sync wrappers read full settings outside Tx (:197–200,1861–1896), which must not be called inside handler Tx. |
| R13 | No hub disable path exists | STALE | C/memory.ts:1452–1460 configure + settings.mode=disabled; S/memory/MemoryHubService.ts:382–398 administrator.update exists. Transport/client exposure remains MISSING; no new disable action enum. |
| R14 | Composition anchors at server.ts:588–605 | STALE | S/server.ts:481–500 service/worker,504–529 hub,619–634 sync/runtime; reuse those layers. |
| R15 | Core RPC schemas/guard entries mean routes active | MISSING | C/rpc.ts:2296–2396 declares schemas; C/clientRpcPermissions.ts:19–28,83–86 guards writes/settings/source, not all reads/status. WP4 activates routes and completes read/status guard tests. |
| R16 | MCP uses McpHttpServer/toolkits registration | OK | S/mcp/McpHttpServer.ts:868–881 toolkitRegistration remains the owner; memory toolkit absent. Current nine-tool catalog is C/memory.ts:2332–2343. |
| R17 | Provider memoryContext and cloud fields coexist | OK | packages/provider-core/src/server/ProviderAdapter.ts:419–422; observation-only resume stays distinct. Actual injection/renderer absent, so lifecycle recipes are proposed, not support claims. |
| R18 | Bounded output alone bounds index work | STALE | S/memory/MemoryService.ts:840–847 scope-wide COUNT is shared by list/search. Remove list aggregation and supply bounded/counter-backed search coverage; Store substring COUNT/SUM and instr query also need correction (S/memory/MemoryStore.ts:3056–3085); §4/§6/§8. |
| R19 | Source scenario belongs to completed WP3 tests | STALE | S/memory/MemoryHubSyncScenarios.test.ts:825–857 proves terminal denial and unrelated progress, not successful original relay. WP4 extends this actual test file with scenario g. |
| R20 | Tests are PR-CI-only and formatter from another worktree | STALE | This pass runs no tests; all implementation tests/typechecks/lint run only on macmini-cf. Local node_modules absent: skip vp fmt, do not access another worktree. |

## 2. Implemented ports and WP4 consumption

`M` = `@goat/contracts`; `Permit` = repeatable SQL-free
`Effect.Effect<void, MemoryService.MemoryAccessError>`. Mutations, binding, changes,
list/search/read/history and context reads retain their actual MemoryService signatures.
ServiceError = MemoryAccessError | MemoryStorageError | MemoryStoreConflict | MemoryCapacityError.
StoredReceipt is the local store result; preserve forget base/expansion IDs and receipts.

| Owner / existing seam | Actual signature / responsibility | WP4 consumption |
| --- | --- | --- |
| MemorySyncService | start, syncOnce, scheduleConflictResolution: Effect<void, Hub.MemoryHubServiceError>; shutdown: Effect<void> | Reuse startup/shutdown; never invoke an Effect as a function or create another worker. |
| MemorySyncService | readLocalReadiness(): Effect<{memorySpaceId: MemorySpaceId|null; bootstrap: unbound|staging|ready}, Hub.MemoryHubServiceError>; requireBootstrap(space): Effect<void, Hub.MemoryHubServiceError> | Local snapshot readiness; no network requirement when bootstrapped. |
| MemorySyncService | getHubSettings(input, permit): Effect<MemoryHubSettingsView, Hub.MemoryHubServiceError>; syncStatus(input, permit): Effect<MemorySyncStatus, Hub.MemoryHubServiceError> | Thin settings/status RPC; preserve null-space storage, processing, holds and 1/7/30-day growth. Map declared errors to safe wire errors. |
| MemorySyncService | updateHubSettings(input, permit): Effect<MemoryHubSettingsUpdateResult, Hub.MemoryHubAdministrationError|MemoryAccessError> | settings:write; administrator performs versioned CAS and configure/disable. Never duplicate its file/SQL workflow in transport. |
| MemorySyncService | readSource: MemorySourceReadAuthority["readSource"] | Existing relay authority, not public MemoryService.readSource. §3 supplies requester evidence and live owner policy. |
| MemoryHubCommittedSettings | read: Effect<MemoryHubSettingsView>, backed by Ref | SQL-free committed hub projection/epoch for reauthorization, snapshot binding and owner policy. No reload/cache lock inside SQL. |
| MemoryHubAdminSettings / MemoryHubAdministrator | withLock/read/apply / update(input, AdminPermit) | Existing administration owner; call outside transport SQL, use committed view for nested SQL authority. |
| MemoryService | prepareSourceRead(input, permit) → ValidatedSourceRequest; validateSourceOutcome({request,outcome}, permit) → outcome | Preserve generation/locator/watermark/scanner checks; add public readSource composition without activating a permissive default. |
| Server composition | server.ts:481–634 provides service, hub, runtime and started sync once | Add access/snapshot/owner reader into the same memoized graph; source dependencies via service ports, no cyclic service acquisition. |

The frozen wire/context fields and actual provider turn field remain prerequisites. Candidate
nextCursor and escaped-render invariant are still WP4 contract changes, not existing behavior.
Search coverage/status remain truthfully incomplete when indexing is deferred; approved receive
and canonical receipt/cursor progress never depend on exposure or transport caches.

## 3. Source activation: consume WP3, do not rebuild it

Implemented non-wire signatures (`S/memory/MemoryService.ts:55–88`; server-produced request):

```ts
type ValidatedSourceRequest = {
  request: M.MemoryHubSourceReadRequestInput;
  generation: number;
};
type MemorySourceReadAuthority = {
  readSource: (
    input: ValidatedSourceRequest,
    permit: Permit,
  ) => Effect.Effect<M.MemorySourceReadOutcome, ServiceError | M.MemoryHubError>;
};
type MemoryOwnerCommittedReader = {
  readCommitted: (
    input: M.MemorySourceReadRequest,
    reauthorize: Permit,
  ) => Effect.Effect<M.MemorySourceReadOutcome, ServiceError>;
};
// WP3 MemoryService ports:
prepareSourceRead: (input: M.MemoryReadSourceInput, permit: Permit) =>
  Effect.Effect<ValidatedSourceRequest, ServiceError>;
validateSourceOutcome: (
  input: { request: ValidatedSourceRequest; outcome: M.MemorySourceReadOutcome },
  permit: Permit,
) => Effect.Effect<M.MemorySourceReadOutcome, ServiceError>;
// WP4 public MemoryService method:
readSource: (input: M.MemoryReadSourceInput, permit: Permit) =>
  Effect.Effect<M.MemorySourcePage, ServiceError>;
```

MemoryService.readSource executes prepareSourceRead → authority.readSource → validateSourceOutcome.
It maps typed HubError into the existing safe service error channel at the authority boundary.
Available returns the validated page; denied remains authorization denial. An unavailable outcome
preserves forgotten/source_invalidated/secret_detected when present; offline/expiry/missing owner
maps source_unavailable. Do not turn every outcome into source_unavailable or empty success.
Actual outcome arms are `C/memory.ts:2286–2305`; public readSource returns a page or typed error,
not the relay union. Transport error mapping preserves safe code/capacity/deadline fields and
never exposes raw cause, SQL, path, model output or source body in an error.

WP4 supplies live memory:read **and** orchestration:read before submission and after await.
The prior 040 source assumptions (old lines 96/103/133) are superseded here: 030 §8's required
same-owner attestation/policy is deferred by rev 11g, not implemented authority. Production stays
fail-closed until the following chain and scenario g pass. WP3 already owns bounded relay,
terminal denial, generation validation and retry/TTL; WP4 adds the committed original reader
and delegates authorization through application-owned ports, not the Worker summary reader.

### 3.1 Requester attestation decision (WP4 rev 1)

Current `MemoryHubSourceReadRequestInput` has no caller proof; `authorizedScopes` is a snapshot,
not permission. Hub authenticates a memory:sync member and stamps its environment and deadline
(`MemoryStore.ts:7306–7345`), which cannot establish the requester user/run's orchestration grant.
Public MemoryReadSourceInput remains unchanged: no caller-controlled attestation, arbitrary
thread ID, host/path or permission bypass. Three choices:

| Option | Contract / hub / owner | Revocation and cost |
| --- | --- | --- |
| A: Hub-attested live requester decision (recommended) | Extend internal hub request/collect schemas with a body-free attestation reference and verified decision. Requester creates a request-bound decision from authenticated session/provider policy; hub verifies it with the pinned requester environment, then stamps verified subject, requester env, owner env, exact locator digest, grant epoch, hub epoch and immutable deadline. Owner accepts only hub-verified proof on its authenticated collect channel and checks its own delegated read policy. | Online validation through hub→requester at admission and before response/result; fail-closed when verifier unavailable. Revocation invalidates the reference/epoch; no reusable token or new public caller authority. |
| B: Signed short-lived requester assertion | Internal request adds signed claims; hub verifies pinned member key and stamps receipt/deadline; owner verifies claims and owner policy. Requires key provisioning/rotation and schema/codec changes. | Expiry alone leaves a revoke window; strict immediate revoke still needs live introspection. More machinery without removing online requirement. |
| C: Hub alone grants access based on member identity | No requester proof contract; hub stamps member environment, owner checks an allowlist. | Cannot distinguish session/run read grants, revoke or expiry; a sync credential becomes transcript authority. Reject: conflicts with rev 11g/compound permit. |

Adopt A as the executable default; no human decision is required. Add a narrowly authenticated
**hub-to-requester validation** endpoint, separate from the eleven member relay paths. It is
not requester-to-owner connectivity and carries no source bytes. Authenticate the pinned hub
through application-owned membership/identity configuration; require an explicit same-owner
subject binding installed by authorized administration, not hostname, shared space or sync
credential equality. If the deployment cannot establish that binding, reads stay denied.
No bearer/session credential is embedded in request/collect, canonical operations, logs or proofs.

Creation → codec → consumers: MemoryAccess captures the authenticated session/provider caller,
current policy epoch and request binding; NEW MemorySourceReadAccess holds at most 32 body-free
live references/environment with <=75s immutable expiry. Public readSource calls prepare first,
then issues the reference **outside SQL**. L1 extends existing hub schemas and a narrow owner-delegation administration contract
(settings:write, no implicit enrollment); L6 carries the fields
through HubClient/HubHttp/HubService, Store locator codec and collect/result validation; owner
permit consumes the hub-stamped decision. Old persisted relay rows without proof decode through
an explicit legacy arm and terminate denied/expired, never become authorized. Request IDs now
bind caller/reference as well as locator/generation so two callers cannot share a result; stable
same-reference retries preserve digest/deadline. Expiry is min(caller expiry, grant decision expiry,
original 75s hub deadline); retry cannot extend it. Body-free references disappear on completion,
revoke, expiry or restart; restart invalidates pending assertions rather than recreating grants.

Hub network validation happens outside SQL, then a SQL-free admitted-decision/epoch permit is
rechecked after lock acquisition. The hub stamps authenticated membership credential version,
verified same-owner subject/policy epoch and locator binding; it does not assert that an owner
thread is readable. L6 supplies a service-owned versioned owner-delegation policy; authorized settings RPC installs/
revokes exact same-owner subject + requester environment + explicit orchestration:read binding.
L1 owns its strict schema/RPC guard, L5 activates the handler; WP6 owns visible policy controls.
No policy by default; no derivation from membership or memory grant. Owner rechecks active member/credential, pinned hub epoch, local delegated
policy and explicit orchestration:read, exact sourceThread owner, completed committed messages,
watermark, requested IDs, forget/generation and scanner before read and again before response.
Remote requester liveness is checked outside the read Tx; local policy/epoch/read permits inside
Tx are SQL-free. Hub checks current requester decision before accepting available response and
before returning it; requester checks live compound permit/generation again before exposing bytes.
Revoke observed before these boundaries discards pending output; previously sent bytes remain
outside recall. Missing proof, wrong caller/owner/digest, expired grant or failed live check yields
typed denied; offline owner/relay timeout yields source_unavailable. Sync continues independently.

Local owner/hub executes the same service policy and attestation verification without an HTTP
hop; no Effect.void owner permit fallback. Owner committed reader returns only selected completed
messages through the evidence watermark, bounded by the existing page/outcome budget. Available,
denied, forgotten, source_invalidated and secret_detected retain distinct safe mappings. Originals
never enter canonical memory, FTS, provider snapshots, checkpoints, reports or durable client caches.

## 4. Snapshot selection, framing and invalidation

NEW `S/memory/MemorySnapshot.ts` is a normal Effect Context.Service with private make/layer,
namespace imports and typed errors. Proposed non-wire methods are
`forThread(threadId: M.ThreadId): E<M.MemoryContextSnapshot|undefined, ServiceError>` and
`revalidate(snapshot: M.MemoryContextSnapshot, execution: { threadId: M.ThreadId; runId: M.RunId }): E<M.MemoryContextSnapshot|undefined, ServiceError>`.
The execution argument is server-captured current execution identity, never snapshot provenance
or caller-supplied wire authority. L1/L3 retain the original selection owner and space/project
binding association in server-owned snapshot/adapter state, outside the unchanged wire snapshot.
Revalidation compares that association with the current active run, owning thread, live read
policy and current space/project binding. Reuse by another thread/run, changed binding, ended
run or lost permission clears the memory entry. No new permission system or wire DTO is added.
It depends on existing MemoryService, Store, WP3 SyncService, server identity and committed thread/
project readers. No SQL or provider/network call in handlers or the pure Orchestrator.

For each real start, use short individual `MemoryStore.transact` reads
(`MemoryStore.ts:426–429`) for readiness/binding and each candidate page, reusing the same SQL
service/journal. Never hold the common transaction lane across multiple pages, rendering or
provider preparation. No network inside a read transaction. Build a repeatable trusted internal
read permit from the owning thread/run policy; this is not an MCP-token requirement and not an
externally selectable bypass flag. Capture the initial space, binding and projection watermark;
each page must match that view, and recheck readiness/binding/watermark at selection completion
and the actual delivery boundary. On drift, discard the selection rather than combine views or
restart an unbounded scan. Real-store fixtures must prove this fence under concurrent mutations.

Select only user scope of the ready space, current explicit/repository project key via
resolveProjectKey, and full current ScopedThreadRef. Missing project mapping excludes only project
memory; no cwd/foreign local-ID inference. Order current-thread, project, user, then memory ID.
Use MemoryListInput with explicit scope, limit <=100 and cursor. L1 changes the existing
`C/memory.ts:1179–1183` contracts type to retain its existing fields plus
`nextCursor: M.MemoryPage["nextCursor"]`; `readContextCandidates` keeps its input/error signature
and copies `MemoryService.list`'s actual nextCursor before filtering candidates. Continuation is
based on the last unfiltered store row (`MemoryService.ts:834–837,854`), including a page whose
eligible items are empty. Never infer cursor or exhaustion from filtered candidate IDs/counts.
`readContextRevisions` shares this result type and returns nextCursor null: it is a bounded exact-ID
read, not pagination. L1 owns both producers and contract tests before consumers compile.

One snapshot selection has explicit aggregate scan ceilings across all three scopes:
**10 pages, 1,000 examined row slots and 640 KiB encoded-page budget**. Conservatively charge
100 row slots and 64 KiB before each page read, including all-excluded or all-oversize pages;
unused page allowance is not reclaimed. These charges bound work without adding scan metadata
or deriving it from eligible item counts. The actual encoded MemoryPage, before candidate
filtering, must obey the existing 64-KiB limit; a required single oversize item follows the
existing payload_too_large policy. Stop at the first scan ceiling, output budget or exhausted
scope; on a scan ceiling return the deterministic partial selection already packed, without
background continuation. Whole eligible items too large for the output are skipped within
these fixed scan ceilings. Output size and scan work are separate invariants/tests.
The scan ceilings only bound work if a page read is itself bounded: L1 removes the scope-wide
eligible/indexed coverage count from list and candidate pages (search reports coverage from transaction-maintained scoped counters, not a scope-wide COUNT), so each page read costs its returned rows plus the watermark.

Include active visible single-head entries only. Tombstone, forget_pending, conflict, scanner,
parent/dependency or grant holds fence exposure. FTS-pending eligible entries may inject: index
coverage is not read eligibility. Empty/unready/error returns no memory, with bounded diagnostics.

NEW `packages/provider-core/src/server/memoryContext.ts` exports pure packing, validation and
text helpers plus a static data-boundary reminder. Preserve the WP1 snapshot fields exactly:
protocolVersion, memorySpaceId, projectionWatermark, items (memoryId/revisionId/scope/provenance/
assertionKind/text), renderedText. Safe public provenance only, no absolute import paths.
Render a fixed data frame with escaped text/locators; count the complete native outer
`<external_goat_memory>` frame, reminder, separators and escaping. Maximum is **6,000 Unicode
code points AND 24 KiB UTF-8**, using `C/memory.ts:90–92`, not UTF-16 string length. Drop whole
items that do not fit; never truncate a fact or load full transcripts/history for injection.

Required WP4 contract correction: `C/memory.ts:1172` checks raw item text occurs in renderedText.
That fails valid escaping of `&`, `<`, `>` and cannot prove correct framing. Remove that raw
substring predicate while retaining uniqueness, typed items and both final-size checks. The
provider-core validator must recompute the deterministic escaped rendering and compare equality;
all six adapter admission paths call it. Keep original item text unchanged. Do not import a
renderer into contracts or weaken excess-property validation. Tests must accept escaped special
characters and reject altered renderedText at actual adapter delivery. This is a proposed WP4
contract change for reflection, not a claim the existing schema accepts escaped output today.

Immediately before Codex restoration is delivered, call `revalidate(snapshot, { threadId, runId })`
with the server-captured current execution. Restoration uses
readContextRevisions(space, selected IDs, permit), compares **exact** original
revision/scope and current eligibility, and repacks survivors only; never add replacements or
new items. IDs are capped at 100; the packer also bounds selected count. Revalidation error or
missing ID may clear the whole memory delivery. Clear snapshot/native cache on detach/stop/thread
replacement, permission change, forget/hold/dependency signal and TTL. Derived caches are current
views under `MEMORY_DERIVED_CACHE_MAX_BYTES` (32 MiB aggregate) and TTL (10 minutes), not archives.
Source has its stricter existing 75-second bound. Cache eviction never rejects approved ingestion.
Codex is a server-owned adapter: acquire MemorySnapshot from its existing Effect layer for
restore revalidation, and provide the same layer instance through runtimeLayer. Do not import
a server service into provider-core or the reusable provider packages. Validate/reselect at the
actual delivery boundary after asynchronous preparation/retry; a previously prepared snapshot
is not authority to resend forgotten bytes. Proposed non-wire turn-input addition, owned by L3:
`refreshMemoryContext?: () => Effect.Effect<MemoryContextSnapshot | undefined, ProviderAdapterTurnStartError>`.
L5 creates this closure from the current thread/run and MemorySnapshot.forThread, maps typed read
failure to an omitted snapshot with safe diagnostics, and puts it only on the in-process turn
input. Each ordinary adapter send calls it after preparation, then validates the returned frame;
fallback/retry sends call it again. Omission clears memory. No function/grant enters wire codecs,
provider payloads, saved commands or events; serialization/deserialization is N/A for this callback.
Only the returned validated text crosses native serialization, through every §5 delivery seam.
Observation-only resume never invokes it to create a prompt. Codex restoration still calls
revalidate with the originally selected snapshot and current server-captured threadId/runId, not refresh, so restoration cannot grow context.
This closes creation → in-process propagation → native serialization → all consumer chains
without importing a server service into a reusable package.

## 5. Provider decisions and lifecycle

These are WP4 implementation decisions, **not current support claims**. MCP availability is
advertised only when the installed memory service and explicit credential grants are present.
Snapshot-only paths must not claim tools. Stored bodies are untrusted data, never developer policy.

| Provider              | Actual delivery seam / evidence at HEAD                                                                                                                                                                                     | WP4 decision, resume and compaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                 | `S/orchestration-v2/Adapters/CodexAdapterV2.ts:710–782` builds untrusted additionalContext; :6376–6390 stores it; :1743–1785 restores it; :6746 explicit compact.                                                           | Add reserved goat_memory untrusted entry independently of MCP app entries. Every ordinary/resumed prompt replaces it. Explicit compact installs fresh snapshot/generation before native command. Restoration revalidates current execution ownership/read policy/space and project binding immediately before delivery, rereads exact selected revisions and sends bounded surviving data as user external context, never developer text. Late compaction after binding change or run termination clears goat_memory; a foreign-thread snapshot cannot restore. Dedup by native thread + compaction item + generation; mark success after inject succeeds. Preserve forked notification handling and existing restore timeout. Error clears memory and logs category, without failing an already-running turn. |
| Claude                | `S/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1049–1054` system append; :1071–1094 read-only tools; :8250–8275 persistent query; :8532–8540 and :8788–8791 actual message builders; :8966 compact.                        | Static reminder/tool availability only in system. Put fresh framed snapshot in each real user-message builder, including fallback/retry/resume; preserve attachments, UUID, echo and effort handling. Do not restart query or change queryPolicyKey for memory. Native compact/wake continuation makes no synthetic user turn; next ordinary prompt refreshes. Allow six read tools with full mcp__goat__ prefix, never three writes, on read-only policy.                                                                                                                                                                                                                                                                                                                                                     |
| Cursor                | `packages/provider-cursor/src/server/adapter.ts:2111–2185` resolveUserMessage; :2116 native /compress; :2206 SDK submit; :2443 compact.                                                                                     | Fresh framed text in ordinary text/image message after validating original input; retain runtime/attachment/skill handling. Resumed agents refresh. Preserve exact native /compress early return, then refresh next real prompt. No provider memory/config file writes. MCP attachment independent of snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Grok                  | `packages/provider-grok/src/server/adapter.ts:336` uses shared ACP; `packages/provider-acp/src/server/adapter.ts:6784–6855` prompt parts; :6978 invocation.                                                                 | One separate memory text block on every ordinary ACP prompt; do not place it in first-run/state-change instruction cache. Preserve HTTP/stdio MCP bridge. Resume refreshes; native control/wake paths do not receive synthetic prompts. Test Grok flavor explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Antigravity           | `S/orchestration-v2/Adapters/AntigravityAdapterV2.ts:238` uses same ACP factory.                                                                                                                                            | Same ordinary-turn snapshot rule, separate flavor fixture for profile and MCP restrictions. Actual denied/unavailable MCP is reported truthfully; data injection remains independent. No invented native compact support.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| OpenCode              | v1 `packages/provider-opencode/src/server/adapter.ts:972` external disables MCP; :3281 prompt system. v2 `packages/provider-opencode/src/server/v2/adapter.ts:3374–3433` prepareTurn/instructions; :4031 before submission. | v1 adds independent framed system-list data plus static trust reminder. v2 owns a separate goat_memory instruction key and last-successful value; put fresh value before each ordinary prompt, including resume, and send empty string to clear. Update cache only after successful put; failure prevents this prompt, not sync/pull. Native compaction stays native; next real prompt prepares again. External connections can be snapshot-only; no automatic GOAT credential forwarding.                                                                                                                                                                                                                                                                                                                     |
| oh-my-openagent (omo) | No dedicated adapter or integration symbol found in GOAT provider implementation search.                                                                                                                                    | Conditional compatibility through the chosen OpenCode runtime only. No first-class support claim: plugin behavior/instruction preservation and child-agent MCP inheritance are not proven. Reuse OpenCode delivery if compatible; validate with an optional off-host fixture later. A plugin dropping instructions/tools is explicitly unsupported by WP4; do not add a seventh adapter or provider-specific memory store.                                                                                                                                                                                                                                                                                                                                                                                     |

Common insertion point is now `S/orchestration-v2/RunExecutionService.ts:1516–1525,1547–1667`,
not the old :1406 path. Add snapshot to the in-process turn input while retaining appContext,
pending reports, cloudLaunchSource and cloudSource. Ordinary starts use :1700; explicit compact
uses :1690. #171 reattach at :1668–1686 removes message/launch checkout and calls resumeTurn to
**observe** an existing cloud task. Do not launch, resend saved user text, or create a memory
prompt during observation-only attach. An optional memoryContext field is not proof the remote
harness consumes it; a provider lacking an actual cloud prompt seam is observation-only here.
A later real follow-up start refreshes via the normal adapter path. Remote cloud tool access
requires an authenticated reachable MCP route; never bake a localhost origin into a bundle.

Immediate means every new local selection/restore and still-pending output is fenced by committed
deletes. Previously delivered context can remain inside the provider. No timer-based compaction
restore, context growth, model reranking or synthetic wake turn merely to refresh memory.

## 6. MCP, RPC, authorization and clients

`S/mcp/OrchestratorMcpService.ts:1073–1181` owns orchestration caller policy; it is not the memory
store. Registration is `S/mcp/McpHttpServer.ts:868,1019–1036` via toolkitRegistration and merged
layers, not a guessed McpServer.ts. Add `toolkits/memory/tools.ts` and `handlers.ts`, using
Tool.make requirements, McpInvocationContext, domain services and McpToolAccess.toLayer.
A handler decodes, calls ONE service method and maps typed errors. No SQL, relay workflow or
provider start in a handler. `McpToolAccess.reads` is not authorization (`:136–138`);
`writesWithCapability` retains read-only ceiling/live-caller checks plus explicit memory grants.

| MCP name (exact WP1 catalog) | Service method                 | Required live grants                                | Declaration / annotation                          |
| ---------------------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------------------- |
| memory_search                | MemoryService.search           | memory:read                                         | reads; readonly                                   |
| memory_list                  | MemoryService.list             | memory:read                                         | reads; readonly                                   |
| memory_read                  | MemoryService.read             | memory:read                                         | reads; readonly                                   |
| memory_history               | MemoryService.history          | memory:read                                         | reads; readonly                                   |
| memory_sync_status           | MemorySyncService.syncStatus   | memory:read                                         | reads; readonly                                   |
| memory_upsert                | MemoryService.upsert           | memory:write                                        | writesWithCapability; mutating                    |
| memory_forget                | MemoryService.forget           | memory:write                                        | writesWithCapability; destructive                 |
| memory_revert_resolution     | MemoryService.revertResolution | memory:write                                        | writesWithCapability; destructive                 |
| memory_read_source           | MemoryService.readSource       | memory:read + orchestration:read + WP4 owner policy | reads; readonly, no SSH host-reaching declaration |

MCP inputs/results use WP1 schemas/catalog (`C/memory.ts:2332–2343`). Pagination defaults to 20,
max 100 with 64-KiB encoded pages; whole items/cursors only. Oversize required single content
returns payload_too_large, not a partial fact. No arbitrary-path import tool, raw resolve/receive port or authority flag. WP5 owns import activation.

A separate administration toolkit exposes `memory_hub_disable` only, with settings:write and
mutating/destructive annotations. Input is requestId + expectedVersion; NEW MemorySyncService.disableHub(input, permit)
(L6-owned, typed administration errors and safe non-credential result) is the one service
method called by the MCP handler. It
builds the existing update input `{ action: "configure", settings: { mode: "disabled" } }`.
Add its schema/catalog separately from the exact nine core tools; no credential installation,
provisioning or secret-returning administration MCP tool. RPC exposes get/updateHubSettings
unchanged, including configure-disabled; both require settings:write. syncStatus RPC/MCP requires
memory:read, including unbound/disabled status. CLIENT_GUARDED_RPC_SCOPES keeps existing settings
entries and adds list/search/read/history/changes/syncStatus read guards; source keeps compound
read grants. Behavior tests assert destination/live revoke for every addition. Server remains
authoritative; MCP metadata and client permissionAtom are availability only.

**Requirement 7:** list/search use indexed keyset pages, default 20/max 100, <=64 KiB encoded
response, no auto-drain or full-history expansion. List/candidates read watermark without scope
aggregation. Search coverage uses exact transaction-maintained scoped eligible/indexed counters;
L6 owns Store/counter migration and L1 consumes the port. Preserve the existing MEMORY_SUBSTRING_MAX_ITEMS/MAX_UTF8_BYTES refusal policy, but read
its scope item/byte totals from maintained counters rather than current Store COUNT/SUM.
Substring search must not run an
unbounded instr scan: bound examined candidates to 1,000 per request with continuation based on
examined keyset rows, permit short/empty pages with nextCursor, and never report exhausted from
filtered results. FTS uses indexed keyset-window queries with <=1,000 candidate rows before matching and
materializing payloads; do not treat final LIMIT after a broad match/sort as proof of bounded
work. Continuation tracks examined rows for both modes, with at most 100 returned items. No new duplicate content index.
Real-store large-scope fixtures inspect query plans/counter updates and count examined work,
not elapsed sleeps or result length alone; compare MCP and RPC cursor semantics.

**Transport lock rule (rev 11f):** no handler opens SQL around a service call. Hub settings
authority reads use MemoryHubCommittedSettings.read (Ref, SQL-free); settings cache reload,
MemoryHubAdminSettings.withLock/file transition, network validation and token exchange must
never be awaited inside SQL Tx. L6 changes hub-only getHubSettings/authority projections to the committed Ref; full settings
remain allowed outside Tx only when actual non-hub configuration (for example model selection)
is needed. Existing Sync wrappers may read full settings outside Tx;
transport cannot move them inside one. Admin commands call the existing administrator workflow
outside SQL and preserve interruption-safe CAS. Invalid external settings retain last valid
committed epoch; diagnostics/UI presentation stay WP6.

Core RPC definitions already exist in `C/rpc.ts:2302–2396`: activate all **14** core methods,
including binding get/update, changes and hub settings. Import group stays separate for WP5.
Use exact MemoryService methods from §2 and WP3 wrappers, not new handler workflows.
`CLIENT_GUARDED_RPC_SCOPES` already contains memory writes, binding get/update (memory:write),
hub settings get/update (settings:write) and readSource in `C/clientRpcPermissions.ts:19–28`;
its helper at :78–96 adds orchestration:read for readSource and filesystem:read for import.
Extend behavior tests if a guard changes; do not describe existing entries as missing. Server
RpcAuthorization adds authoritative core method coverage and compound live checks. MemoryChanges,
ordinary reads and status require memory:read, regardless of UI availability.

NEW request-scoped `S/memory/MemoryAccess.ts` adapts authenticated live checks into Permit.
Missing grantedScopes/reauthorize denies memory (`S/mcp/McpInvocationContext.ts:60–64`). Recheck
mutations after SQL lock ownership immediately before decision/commit; no network or token
exchange in the transaction. Reads/source/stream recheck after waits and before exposing bytes.
Map denial to MemoryAccessError/safe transport auth error, without laundering it as availability.
Internal approved receive/registry paths remain unforgeable and outside public transport.

Complete the two credential producer chains, not just invocation types:

1. OAuth: existing AuthMcpApprovalDecisionRequest.memoryScopes (`C/auth.ts:621,627`) → browser
   consent / pairing proof → PendingCode stored selection → exchange → SessionStore scope codec →
   authenticated client → McpHttpServer context grantedScopes + repeatable reauthorize. Current
   `S/auth/McpOAuth.ts:454,540` and `EnvironmentAuth.ts:91,1325,1367` still derive from access;
   WP4 must preserve explicit selected union instead. One-click approver must cover the entire
   union (`mcpOAuthHttp.ts:130`). L4 owns the actual consent producer `apps/web/src/components/auth/ConnectAgentSurface.tsx` and its behavior test. `mcpOAuthHtml.ts` renders an error page and has no consent-producer assignment. Both browser-session and pairing-code proof arms send the explicitly selected memoryScopes (default empty); selection changes update payload and callback dependencies. The one-click predicate checks the entire access + memory scope union before choosing a proof arm. Carry selection through the existing decision schema, not a parallel API. Extend SessionStore with a token-free active-scope read using current revocation/expiry predicates for live checks. Preserve a memory-only write grant without inferring orchestration:operate or elevating the runtimeModeCeiling. Legacy codes/sessions get no new grants. No exchange escalation.
2. Provider: `ProviderSessionManager.ts:474–533` prepare/reuse → McpCredentialRequest
   (`McpSessionRegistry.ts:15–25`) → issued token registry → resolve/context → live permit.
   Add stored grantedScopes and internal readCurrentPolicy callback; issuance checks current
   thread/provider and installed policy before reuse, rotates on policy change, and invocation
   rechecks live caller/run/deletion. Thread read is independently granted orchestration:read,
   never inferred from memory:read. Preparing before activeRunId commits must not deadlock start;
   require active-run ownership at invocation. Do not put a callback or grants into agent input.

NEW shared `packages/client-runtime/src/state/memory.ts` uses createEnvironmentRpcCommand for
mutations/binding/settings and permissionAtom for UI availability. Raw clients remain in rpc/.
Expose guarded `importProvider({ environmentId, input })` through the same factory, using the
existing compound guard in `C/clientRpcPermissions.ts:23,84`: memory:write AND filesystem:read.
Its permissionAtom and execution check use the destination environment; unsupported destinations
return unavailable without local fallback. Behavior tests cover both grants, either missing grant,
revocation, selected destination and missing capability. WP5 alone activates the server import
group/handler and import capability; this factory does not activate a server route.
Use existing EnvironmentRegistry/followStreamInEnvironment subscription lifecycle; add memoryChanges
subscription tag in rpc/client.ts. Export `createMemoryEnvironmentAtoms(runtime)` from the new state module, using the existing state/runtime.ts helpers; web/mobile instantiate it against their existing connectionAtomRuntime, with desktop reusing web. One stream per connected memory-capable environment while
consumers exist. Initial reset/reconnect clears bodies before refetch; downgrade, disconnect,
backpressure or auth failure disables body exposure until a new reset. Forget/hold/dependency
signals bump generation, cancel pending reads and evict search/list/read/history/source/snippets
and edits derived from affected memory. Late output checks generation, grant, TTL and tombstone;
a later watermark cannot resurrect a deleted ID. Unrelated new drafts survive. No localStorage,
IndexedDB or native persistence for bodies. A write-only caller does not acquire a read stream.

Web (hosted/local), desktop and mobile consume this same runtime factory; WP6 owns visible memory
screens/Settings/palette/keybinding wiring and reverse controls. The OAuth consent producer
and its behavior tests are a WP4 L4 exception, moved from WP6 ownership (handoff in §9). Test selected environment routing
for local, remote/relay and tunnel; unavailable/old destinations return capability unavailable,
never route to client-local state. Do not set VITE_HTTP_URL/VITE_WS_URL. Capability advertisement
starts only when actual core routes and producers are ready; import and hub protocol remain
independent. Scheduled/delegated agents use the same services and admission policy.

## 7. Disjoint implementation lanes and integration

This is a future file-ownership map; it grants no source-writing authority in this P pass.
One WP4 change/PR when later requested; bounded lanes are not separate top-level work streams.
Each listed source owns its adjacent tests, unless a test is explicitly assigned below. New files
are marked NEW; existing files MODIFY. WP3 final is integrated. Treat its existing modules as this map’s exclusive owners;
interface gaps return to the coordinator. Every lane runs tests only remotely on macmini-cf;
no tests, builds, typechecks or lint on this Mac. No shell-profile sourcing or sensitive data reads.

| Lane                       | Exclusive files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Output / dependency                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 contracts/RPC permissions and domain | MODIFY `C/memory.ts`, `C/memory.test.ts`, `C/rpc.ts`, its tests, `C/clientRpcPermissions.ts` and its tests; MODIFY `S/memory/MemoryService.ts` and `.test.ts`; NEW `S/memory/MemorySnapshot.ts`, `MemorySnapshot.test.ts`, `MemoryAccess.ts`, `MemoryAccess.test.ts`; NEW `packages/provider-core/src/server/memoryContext.ts` and `.test.ts`; MODIFY `packages/provider-core/package.json`                                                                                                                                                                                                                                                                                                  | Escaped-render schema correction plus candidate nextCursor contract/producer correction, public source activation, bounded snapshot and execution-aware revalidation, and pure validator. Consume WP3 source/readiness as frozen; no hub/registry reimplementation. L1 owns proof/admin schemas, core/read/status permission guards and exports before consumers compile.                                                                                                                              |
| L2 auth and MCP            | MODIFY `S/auth/{McpOAuth,EnvironmentAuth,SessionStore,mcpOAuthHttp}.ts` and their existing/needed focused tests; MODIFY `S/mcp/{McpInvocationContext,McpSessionRegistry,McpHttpServer}.ts` and tests; MODIFY `S/orchestration-v2/ProviderSessionManager.ts` and test; NEW `S/mcp/toolkits/memory/{tools,handlers}.ts`, `handlers.test.ts`; NEW narrow `S/mcp/toolkits/memoryAdministration/{tools,handlers}.ts` / `handlers.test.ts`                                                                                                                                                                                                                                                                                  | OAuth server grant chain consuming L4 consent payloads, provider grants, live reauthorization, nine-tool toolkit and separate narrow disable toolkit registration. Grant/attestation resolution ports are produced here and consumed by L6; L2 does not own relay verification/Store. Depends on L1 error/permit contract; no MemoryService edits.                                                                                                                                                                                                                                            |
| L3 provider delivery       | MODIFY `S/orchestration-v2/Adapters/{CodexAdapterV2,ClaudeAdapterV2,AntigravityAdapterV2}.ts` and tests; MODIFY `packages/provider-core/src/server/ProviderAdapter.ts`; MODIFY `S/provider/CodexDeveloperInstructions.ts` and `.test.ts`; MODIFY `packages/provider-{cursor,acp,grok}/src/server/adapter.ts` and tests; MODIFY `packages/provider-opencode/src/server/adapter.ts`, `adapter.test.ts`, `v2/adapter.ts`; NEW `v2/adapter.memory.test.ts`                                                                                                                                                                     | All §5 paths, including shared ACP flavors, explicit compaction and restore. Depends on L1 renderer and L2 truthful availability contract. Existing optional turn field stays; no cloud field loss.                                                                                                                                                                                                                                        |
| L4 shared client           | NEW `packages/client-runtime/src/state/memory.ts`, `memory.test.ts`; MODIFY `packages/client-runtime/src/rpc/client.ts`, `client.test.ts`; MODIFY `packages/client-runtime/package.json` to export `./state/memory`; NEW thin `apps/web/src/state/memory.ts` and `apps/mobile/src/state/memory.ts` wrappers using their existing connectionAtomRuntime; Consume L1-owned permission guards/tests; MODIFY `apps/web/src/components/auth/ConnectAgentSurface.tsx`; NEW `apps/web/src/components/auth/ConnectAgentSurface.test.tsx` | Guarded destination commands including importProvider, actual OAuth consent producer/both proof arms/full-union one-click behavior, body-free stream/reset, late-result fences. Consume existing DTOs; no auth/server source edits. Follow `state/attachments.ts:26–37` factory pattern and existing web/mobile attachment wrappers; no second runtime. Other UI screens stay WP6-owned; OAuth consent producer/test moves from WP6 to L4. |
| L5 coordinator integration | MODIFY `S/{ws,server}.ts` and ws tests, `S/auth/RpcAuthorization.ts` and tests, `S/orchestration-v2/{RunExecutionService,runtimeLayer}.ts` and relevant tests, `S/environment/ServerEnvironment.ts` and tests, Consume L1-owned RPC contracts; owning 040/000 records and boundary map only when required                                                                                                                                                                                                                                                                                       | One composition, 14 core RPCs, snapshot insertion, cloud observation guard and capability gating. Coordinator alone edits these shared junctions. Integrated OAuth screen verification with test-t3-app and before/after PR screenshots (goat-screenshot-gate) are required. CI configuration changes, if needed, are coordinator-only after inspecting actual CI collection.                                                              |
| L6 source relay / bounded store | MODIFY `S/memory/{MemorySyncRuntimeLive,MemorySyncService,MemoryHubService,MemoryHubClient,MemoryHubHttp,MemoryStore}.ts` and adjacent tests; MODIFY actual `S/memory/MemoryHubSyncScenarios.test.ts`; NEW `S/memory/MemorySourceReadAccess.ts` / `.test.ts`, `MemoryOwnerSourceReader.ts` / `.test.ts`; Store scoped-counter migration under `S/persistence/Migrations/` and registration only if needed (unreleased migration edit policy from WP3 rev 11f; never rewrite deployed migrations) | Consume L1 proof/schema/access ports and L2 live credential producer. Implement attestation validation, fail-closed same-owner policy, original reader and hub stamps/relay codecs; scoped counters/bounded search Store ports. L1 alone edits MemoryService public activation/consumer. L5 alone assembles. No file overlaps. |

Integration order: pin merged WP3 → L1 contracts/access/renderer exports → L2 grant producers and
L6 source/counter service ports → L1 domain consumption → L3 provider and L4 client consumers →
L5 composition/RPC/turn insertion → exact-head review and macmini-cf focused verification.
This staged handoff is dependency ordered; L1/L6 exchange typed ports without concurrent edits
to any shared file. L5 replaces the production fail-closed reader/permit once after proof; it
retains the existing Sync source authority. Do not add a second runtime/store/worker. Changes to a shared file are returned to its
owner, never patched from another lane. Only L5 performs the integrated real-client pass; implementation sublanes do not launch dev servers.

## 8. Focused acceptance and evidence plan

All automated implementation tests below run **only remotely on macmini-cf — NOT RUN in this pass**. L5 also owes the
pre-approved test-t3-app real-screen pass on an authorized verification host, outside this
docs-only pass and without prohibited local test/build commands. These are requested observable cases,
not verified commands or evidence of compilation. Do not execute bun, pnpm, vp test, vitest, e2e,
repo-wide checks or a full build on this Mac. The macmini-cf runner must collect the actual changed test paths and
inspect steps/logs at the final SHA; job conclusion without execution is insufficient.

| Owner / focused test targets                          | Activation → observable proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 MemorySnapshot / provider-core memoryContext       | Page watermark and final readiness/binding fences → three scopes never mix committed views; concurrent change discards selection without unbounded retry; explicit/repository/unmapped project and foreign scoped IDs → only correct space entries, one watermark. Real-store first page entirely excluded, next page eligible → list nextCursor reaches the eligible row without repetition; exact-ID revision reads return null continuation. Pagination beyond 100 → deterministic selection. All excluded/all output-oversize items hit the 10-page/1,000-slot/640-KiB scan ceilings independently of output size; pre-filter encoded pages obey 64 KiB. Short page reads release the common transaction lane so forget/approved receive can commit between pages. Escaped special characters, emoji/combining text, exact cap/+1 → both framed budgets hold, whole facts only, altered frame rejected. Forget/conflict/hold/forget_pending between selection and restore → no stale body; FTS pending remains eligible. Candidate and list pages run no scope-wide coverage aggregate: a scope far larger than one page costs only the page reads, and a forget committed between pages proceeds. |
| L1 MemoryService / MemoryAccess                       | WP4-activated real-store source seam: local owner and A/H/B relay succeed with no direct owner connection; offline/expiry → source_unavailable; denied → auth denial; forgotten/source_invalidated/secret_detected preserved. Deferred gates then revoke/forget before response or lock acquisition → no bytes/commit/outbox. Scanner/watermark/message selection enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L2 auth / ProviderSessionManager / McpSessionRegistry | Real prepare→issue→resolve→tool path for read/write/thread grants; reuse rotates on policy change; preparation before activeRunId succeeds, inactive/deleted caller invocation fails. OAuth browser and pairing proof→code→exchange→authenticated tool; unselected/legacy/access-only/reused/expired/escalated code cannot mint memory grants; approver union checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| L2 toolkit / McpHttpServer                            | List exact nine core tools plus separately gated administration disable tool; readonly calls denied without explicit grants, writes denied on read-only ceiling; revoke during service transaction wait prevents mutation. Tool result is strict JSON with no undefined optional fields; safe capacity/deadline/code retained.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L3 each provider adapter                              | Actual captured native payload contains bounded data on first and second ordinary prompt/resume/retry. Both ACP flavors covered. Claude query not restarted; native compact/compress unchanged; no synthetic wake. Codex restore Deferred + foreign-thread snapshot reuse, binding change followed by late compaction, run termination, permission loss, delete/revision change/duplicate completion → cleared memory or surviving exact items only, retry after failed inject. OpenCode v2 failed put → no prompt, successful empty put after forget → stale value cleared, cache updated only on success. External OpenCode snapshot succeeds without falsely advertising MCP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| L4 client-runtime / rpc / clientRpcPermissions        | Selected remote/tunnel destination used; unavailable old environment never falls back locally. Real reset/forget/hold/dependency stream evicts affected bodies and derived edits; late response cannot resurrect; unrelated drafts/environment intact. Disconnect/downgrade/reset handshake fences exposure; write-only never subscribes. importProvider({ environmentId, input }) and permissionAtom require both memory:write and filesystem:read; either missing/revoked grant denies, unsupported destination is unavailable, selected destination is retained. ConnectAgentSurface behavior tests capture both proof-arm payloads through the existing schema, default empty scopes, changed selection and full-union one-click acceptance/rejection.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| L5 ws / RpcAuthorization / RunExecutionService        | All 14 core methods reach services with repeatable permits; binding change and useRepository reversal; settings CAS wrappers preserve semantics, configure-disabled reaches administrator, unbound status preserves counters/processing; settings:write for get/update/disable, memory:read for status. Deferred settings reload with concurrent SQL reauthorization completes without lock cycle. Revocation while update waits prevents commit. Ordinary start and explicit compact get snapshot; cloud reattach calls observation-only resume without launching or sending memory/user message. One Store/Worker/runtime and ready capability gate. L5 runs test-t3-app against the actual OAuth consent screen (both proof paths/selection changes), attaches before/after screenshots to the UI PR and satisfies goat-screenshot-gate; formatter/unit evidence alone cannot close this UI acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| L5 integrated M19/M20                                 | Local new mutation at capacity → safe capacity_exceeded; forget still uses deletion path; authenticated approved receive under local brake/scan/index/parent holds still persists receipt/cursor with deferred state. Search/status expose incomplete coverage and 1/7/30-day signed growth with partial/unavailable endpoints. Source/cache/provider preparation failure cannot stall sync. No new index/archive or unbounded snapshot cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 8.1 Source relay scenario g and denial/revocation (L6)

Extend actual `MemoryHubSyncScenarios.test.ts`, plus Access/OwnerReader/HubClient/HTTP/Store
focused files. Do not count WP3's terminal-denial fixture as success evidence.

- **g (original relay success):** B owns a stopped thread with completed evidence messages;
  A has only its summary/ScopedThreadRef/watermark. A authenticated MCP or RPC caller has live
  memory:read + orchestration:read; hub H verifies requester decision and explicit same-owner
  binding; B owner policy permits that requester. A cannot connect directly to B. Real
  prepare→attest→H request→B collect/read/respond→H result→A validate returns exact selected
  original bytes through the watermark, bounded once, with no bytes in canonical/FTS/events/
  snapshots/report/cache archives. Repeat local owner/hub path with the same checks.
- Missing/forged/old proof, sync-only member, wrong owner/caller/digest, changed grant epoch,
  inactive run/session, expired session/reference or unbound owner delegation → typed denied
  and no transcript read; old rows without proof stay denied. Valid local caller cannot reuse
  another caller's request ID/result. Same retry keeps original deadline/digest.
- Deferred before owner read, owner response, hub acceptance/result and requester return:
  revoke requester grant/member or owner policy, disable hub, forget/invalidate memory, or
  end provider run. Resume milestone → no exposed bytes, no pending request forever, unrelated
  sync/forget proceeds. TTL boundary/expired reference/restart invalidation cannot extend reads.
- Offline owner and unavailable verifier preserve availability/authorization distinctions;
  no source-success fallback. Scanner denial and generation/watermark drift discard late output.
  Hub/requester verification outside Tx plus committed local epoch checks must show no
  SQL→settings/network lock cycle. Exact request schema/codec, HTTP round-trip and safe errors
  are tested with synthetic identities/proofs, never real credentials or user databases.

L6 also tests scoped coverage counters under write/forget/approved receive/reindex and rollback,
large-scope list/search examined-row limits, bounded substring empty-page continuation and FTS
query plan. L1 tests service/MCP-facing semantics using those real Store ports. L2 tests disable
handler invokes the one settings service wrapper with settings:write; L4 tests guarded disable
through updateHubSettings and read-status availability. L5 verifies one composition and no
fallback owner permit before activation.

Use TestClock/Deferred and real service/store fixtures; event-sourced milestones use worker drain
or persisted event, never sleeps/polling. Targeted package typechecks/lint and exact focused test
collection run on macmini-cf, not here. Hosted CI receipts are separate evidence and must
be inspected if later used; this plan does not authorize tests on other execution hosts. Server tests belong to existing goat-ci shards; shared runtime
cases belong to test-client-runtime; provider package tests require explicit collection in the
existing root Vite config. Do not invent a new parallel runner or claim a broad glob covers new
files without checking collection. Every actual changed file must have an owner/CI collection
entry before B closes. M19 packaged/off-host evidence remains separate from source CI.

## 9. Risks, surfaces and reflection handoff

- WP3 final is the implemented dependency. Recheck the pinned signatures at B integration.
  The source attestation/owner-reader activation and bounded search counters remain WP4 work. A mismatch requires owner repair,
  not transport-side SQL or a guessed fallback.
- Snapshot page/final watermark fences, conservative scan ceilings and transaction-lane release
  need real-store proof; no cross-page transaction is permitted. Recheck local
  readiness/binding and exact revision filtering at the admission/restore boundary. No paid
  model, source relay or network authentication inside SQL.
- Schema/renderer amendment S13 and provider-specific instruction semantics need reflection.
  OpenCode v2 clearing failure must fail preparation; Codex replay must not resurrect deletion.
- Explicit provider/OAuth grants require full producer-to-consumer proof. Existing capability or
  full-access selection does not confer memory/thread rights. UI guards are availability hints;
  service live permits are the authoritative path. Alternate raw handler entry is a bypass to
  test, not a claim of unbypassable enforcement (E7; 000 enforcement inventory).
- Web local/hosted, desktop and mobile share client state; visible entry points and reverse
  actions remain WP6. Providers: six decisions in §5. Agents: nine core service-backed tools and settings-gated disable,
  including scheduled/delegated callers. Contracts: S13, candidate nextCursor, internal source-proof/legacy codec and explicit owner-delegation admin schemas; public readSource input stays unchanged and execution identity stays internal.
  Reverse states: forget/revert, binding useRepository and settings disable/revoke clear exposure.
  Connection modes: local, remote/relay and tunnel preserve destination and owner authority.
- omo remains conditional OpenCode compatibility; no native integration or plugin inheritance
  proof. Cloud observation-only attach cannot retrofit memory into an already-running remote task.
- **User decisions required: none.** These are implementation/reflection risks within existing
  M1–M20 requirements, not new product choices. Architect reflection and independent A are next;
  READY_FOR_REVIEW does not mean READY_TO_BUILD, passing CI or runtime CLOSED.

### Cross-phase handoff ownership

| Recipient | WP4 output / retained boundary                                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP6       | OAuth consent producer ConnectAgentSurface.tsx and its behavior test move from 060's WP6 assignment to WP4 L4. WP4 supplies both memoryScopes proof arms, selection/full-union one-click behavior and L5 real-screen/before-after screenshot evidence. Other visible memory screens remain WP6; reconcile 060 before B without editing it in this pass. |
| WP3 | Follow-up 030 §8/handoff should explicitly say owner policy/reader and attestation are WP4 activation; retain WP3 terminal-denial baseline and rev 11g, and correct wrapper error types. No 030 edit in this pass. |
| WP5 / WP6 | WP4 L4 exports guarded importProvider({ environmentId, input }) with the existing memory:write + filesystem:read compound guard and unavailable destination behavior/tests. WP5 retains server group/handler/capability activation; WP6 consumes the command.                                                                                           |

Authoring verification: input HEAD/branch, clean status and current source ports were inspected.
Only the two authorized documents change. node_modules is absent in this worktree, so vp fmt
is skipped per the task; no formatter from another worktree and no dependency install. Fresh
git diff --check and the local commit are recorded in `/tmp/goat-wp4-replan-r1.md`.
Tests/builds/typechecks/lint/UI verification are NOT RUN; runtime success is not claimed.

## Folded revision correspondence

| Prior material                                                       | Current home                                                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| rev 2 cross-phase contracts and rev 3 producer/consumer/source fixes | §2–3, §6–7                                                                                                           |
| rev 4 live provider/thread authorization and static-input coverage   | §6–8; actual CI collection replaces obsolete 60-file command receipt                                                 |
| reflection r1 G-1 / audit r1 A#2                                     | §2, §4, L1 ownership and §8: preserved list nextCursor, candidate contract and real-store excluded-page continuation |
| reflection r1 G-2/G-3                                                | §4–5, §8–9: execution-aware restore, explicit scan ceilings, short page transactions and drift fences                |
| audit r1 A#1/A#3                                                     | §6–9: L4 actual consent producer and guarded import command; L5 UI proof; WP5/WP6 handoff                            |
| prior snapshot/provider recipes                                      | §4–5 with current ports, cloud semantics and S13 correction                                                          |
| rev 7 requirement 7 / M19 and audit fixes; rev 8 M20                 | §3–4, §6, §8–9; approved receive remains independent of local exposure                                               |
| WP4 rev 1: WP3 final re-anchor (2026-10-14) | §1–3 replaces absent/future ports with actual wrappers/errors and rev 11g fail-closed source; §3.1 adopts hub-attested live requester decision with explicit same-owner owner policy; §4/§6 bound list/search work; §6 consumes committed settings, exposes disable, read/status guards and prohibits SQL/settings lock cycles; §7–8 adds disjoint L6 source/counters and scenario g; all tests only macmini-cf. Prior A near-pass is historical; fresh reflection/A required. |

No superseded appendix remains an alternate instruction source. This document is the current WP4
consumer plan; WP1/WP2 implementation and merged WP3 service ownership remain authoritative for their ports.
