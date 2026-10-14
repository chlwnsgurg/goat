# 040 — WP4: memory MCP and provider injection (current P rewrite)

Date: 2026-10-14. Status: **READY_FOR_REFLECTION**, not implementation approval or runtime proof.
This is the bounded planner handoff; architect reflection and independent A remain coordinator work.
This authoring pass writes only 040 and one P record in the new WP4 cycle of 000. Source changes,
other plans, tests, builds, push and PR creation are outside this pass. The explicit two-document
commit request overrides AGENTS.md's default against committing plans.

## 1. Baseline, outcome and stale check

- Worktree: `goat-wp4-plan`; branch: `goat/memory-wp4-mcp-injection`.
- Checked HEAD: `55d77f1f8d7ac4cc7a3b222d05a878accf065c4d`, the WP3 plan branch after merging
  actual WP2. WP3 implementation is **absent** here and is being built in another lane.
- Required dev baseline: `637a9835190829b691622dc5bd4b9a147e714ae8` (#171 cloud foundation),
  already integrated. Provider input must retain both memory and cloud fields.
- WP3 authority: 030 §4, §4.2 and §12, including rev 11c claim-retirement correction at
  `162851dc0`. Its heading still says rev 11b; the later correction and 000 WP3 A record govern.
  The older WP3 baseline/WP2 D wording is historical, not a reason to replace this checkout.
- Live remote check: `refs/heads/dev` is now `5c55f20022513a57be65e8ab7948514d9ab12945`.
  GitHub compare against `637a98351` shows one commit changing only
  `packages/ssh/src/tunnel.protocol-manager.test.ts` and `tunnel.protocol-stop.test.ts`
  (test timeout adjustments). No memory/provider/MCP port changed. Keep the requested pinned
  baseline; recheck the actual integrated WP3 SHA before B. No branch/ref update was performed.
- Authority: [000 decisions and enforcement inventory](000_plan.md), [WP3 frozen handoff](030_wp3_hub_sync.md#12-handoffs-risks-and-authoring-verification),
  actual WP2 source, AGENTS.md and `docs/internals/effect-services.md:9–22,40–100`.

Outcome: all six supported providers use one environment-owned memory service, through nine MCP
operations and a bounded snapshot at each real prompt start. Tools and snapshot delivery are
independent capabilities. Thread originals are read on the owning environment when requested;
only summary plus scoped evidence locators are shared. Forget/delete-wins fences search, source,
client caches and subsequent injection/restoration immediately after local commit. Previously
sent provider bytes cannot be recalled; an offline replica learns remote deletion through WP3.

**13 stale items** were replaced, counted once per incompatible assumption:

| ID | Old assumption | Current disposition |
| --- | --- | --- |
| S01 | `1e2418faf` and pre-cloud line anchors describe current source | Pin actual WP2/WP3 base and dev above; use §2/§5 anchors. |
| S02 | Public `applyOperation(input, permit)` exists | Use upsert/forget/revertResolution and StoredReceipt (§2). |
| S03 | `readContextCandidates({thread})` resolves all scopes | Actual input is MemoryListInput plus Permit; snapshot owns a consistent three-scope read (§4). |
| S04 | `readContextRevisions(snapshot)` refilters a snapshot | Actual arguments are space, ids, Permit; compare exact revisions after reread (§4). |
| S05 | WP2 already exports source authority/owner reader | WP3 prepares/validates and composes these; WP4 activates public readSource (§3). |
| S06 | Sync settings/status/readiness are existing WP2 exports | Frozen WP3 additions with exact permit/error contracts (§2). |
| S07 | Memory grants follow access/capability automatically | Complete OAuth and provider credential producer/live-check chains (§6). |
| S08 | Core RPC definitions mean active server/client routes | Schemas/guard map exist; registration, handlers and shared runtime remain WP4 (§6). |
| S09 | A start-only snapshot covers reuse, native compaction and cloud attach | Distinguish real prompts, control commands, restoration and observation-only attach (§5). |
| S10 | Restoration can replay cached bodies | Revalidate IDs/revisions/eligibility and clear stale native entries (§4–5). |
| S11 | Growth/status and deferred receive can be simplified at transport | Preserve M19/M20 status and separate local exposure from canonical receive (§6–8). |
| S12 | Append-only rev 2–8 recipes and their command lists form an executable plan | Fold into this body; disjoint owners, dependencies and CI-only evidence (§7–9). |
| S13 | Escaping text is compatible with raw `renderedText.includes(item.text)` | Actual schema conflicts for special characters; amend that derived-text invariant before renderer consumers (§4). |

## 2. Implemented / WP3-provided / WP4 adds

All source anchors below refer to checked HEAD, not future line numbers. `S/` means
`apps/server/src/`, `C/` means `packages/contracts/src/`, `M` means `@goat/contracts`,
`E<A,X>` means `Effect.Effect<A,X>`. `ServiceError` = MemoryService.MemoryServiceError;
`Permit` = `E<void, MemoryService.MemoryAccessError>` (repeatable, live, no network).
MemoryServiceError is the union of MemoryAccessError, MemoryStorageError,
MemoryStoreConflict and MemoryCapacityError (`S/memory/MemoryService.ts:20–35`).

| Concern | Implemented | WP3-provided (frozen proposal, NOT present yet) | WP4 adds / consumes |
| --- | --- | --- | --- |
| Mutations | `upsert(input: M.MemoryUpsertInput, permit: Permit): E<Store.StoredReceipt, ServiceError>`; `forget(input: M.MemoryForgetInput, permit: Permit): E<Store.StoredReceipt, ServiceError>`; `revertResolution(input: M.MemoryRevertResolutionInput, permit: Permit): E<M.MemoryRevertResult, ServiceError>` — `S/memory/MemoryService.ts:67–81` | L1 retains these; resolves hub approvals/settlement without device-clock expiry (030 §4/§12). | Thin RPC/MCP calls. StoredReceipt is `{operationDigest, receipt}` (`S/memory/MemoryStore.ts:86–92`); map its local mutation receipt to WP1 wire success, never cast a hub receipt into it. Preserve split forget base/expansion outcomes and operation IDs. |
| Reads | `list(input: M.MemoryListInput, permit: Permit): E<M.MemoryPage, ServiceError>`; `search(input: M.MemorySearchInput, permit: Permit): E<M.MemoryPage, ServiceError>`; `read(input: M.MemoryReadInput, permit: Permit): E<M.MemoryItem, ServiceError>`; `history(input: M.MemoryHistoryInput, permit: Permit): E<M.MemoryHistoryPage, ServiceError>` — `S/memory/MemoryService.ts:82–97` | Preserve canonical receipt vs local exposure and history.revertResults (030 §12). | Same methods for tools/clients; preserve quarantine, localAvailability, coverage and cleanup state. |
| Candidate read | `readContextCandidates(input: M.MemoryListInput, permit: Permit): E<M.MemoryContextCandidates, ServiceError>` — `S/memory/MemoryService.ts:119–122,956–979`; one scope/page, not thread orchestration. | Local readiness, not a replacement candidate API. | Snapshot uses exact input and bounded pages; do not assume one page covers every scope. |
| Restore read | `readContextRevisions(space: M.MemorySpaceId, ids: ReadonlyArray<M.MemoryId>, permit: Permit): E<M.MemoryContextCandidates, ServiceError>` — `S/memory/MemoryService.ts:123–127,980–1010` | Preserve eligibility after approved receive/forget. | Match original exact revisions/scope; no newer replacements. Missing/error can omit entire memory snapshot safely. |
| Binding / signals | `getProjectBinding(input: M.MemoryProjectBindingGetInput, permit: Permit): E<M.MemoryProjectBinding, ServiceError>`; `updateProjectBinding(input: M.MemoryProjectBindingUpdateInput, permit: Permit): E<M.MemoryProjectBindingUpdateResult, ServiceError>`; `resolveProjectKey(space: M.MemorySpaceId, project: M.ScopedProjectRef): E<M.MemoryProjectKey|null, ServiceError>`; `changes(input: M.MemoryChangesInput, permit: Permit): Effect.Effect<Stream.Stream<M.MemoryChangeSignal, ServiceError>, ServiceError, Scope.Scope>` — `S/memory/MemoryService.ts:47–66` | Persisted bootstrap/binding and body-free settlement changes. | Binding commands, one environment-keyed change subscription, cache generation fences. |
| Source | No public readSource, prepareSourceRead, validateSourceOutcome or MemorySyncService in WP2. Worker private summary reader is not this API. | Exact §3 signatures from 030 §4.2:527–563; authority implementation in WP3 L4 and owner-reader injection in WP3 L5. | `readSource(input: M.MemoryReadSourceInput, permit: Permit): E<M.MemorySourcePage, ServiceError>` per 030 §12:1183. Activate without rebuilding relay or owner reader. |
| Settings/status | Wire schemas only; no WP2 SyncService exports. | `getHubSettings(input: M.MemoryHubSettingsGetInput, permit: Permit): E<M.MemoryHubSettingsView, ServiceError>`; `updateHubSettings(input: M.MemoryHubSettingsUpdateInput, permit: Permit): E<M.MemoryHubSettingsUpdateResult, ServiceError>`; `syncStatus(input: M.MemorySyncStatusInput, permit: Permit): E<M.MemorySyncStatus, ServiceError>` — 030 §12:1184. | RPC calls with settings:write / memory:read respectively; status MCP. Consume WP3 readStorageStatus assembly; never recompute storage. |
| Readiness | No WP2 SyncService readiness API. | `readLocalReadiness(): E<{memorySpaceId: M.MemorySpaceId|null; bootstrap: "unbound"|"staging"|"ready"}, ServiceError>`; `requireBootstrap(space: M.MemorySpaceId): E<void, ServiceError>` — 030 §12:1185. | Snapshot reads local persisted readiness; unbound/staging means no snapshot. Offline but bootstrapped does not block on network. |
| Schemas / adapter input | `C/memory.ts:89–100,1146–1177,2270–2280`; `ProviderAdapterV2TurnInput.memoryContext?: MemoryContextSnapshot` at `packages/provider-core/src/server/ProviderAdapter.ts:419`, alongside cloudLaunchSource/cloudSource at :421–422; observation-only resume type at :621. | WP3 contract amendments are prerequisites, not WP4 schema inventions. | Renderer/validator, nine-tool registration, real producers/consumers and truthful capability advertisement. Preserve cloud types and fields. |
| Composition | One Store/Quota/Service/Worker graph: `S/server.ts:588–605`. | WP3 reuses this graph and injects source authority/committed reader once (030 §8). | Provide snapshot/access/tool layers into this same graph; no extra SQL connection, worker or ManagedRuntime. |

## 3. Source activation: consume WP3, do not rebuild it

Frozen non-wire signatures (030 §4.2; `ValidatedSourceRequest` is server-produced):

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
Actual outcome arms are `C/memory.ts:2224–2243`; public readSource returns a page or typed error,
not the relay union. Transport error mapping preserves safe code/capacity/deadline fields and
never exposes raw cause, SQL, path, model output or source body in an error.

WP4 supplies live memory:read **and** orchestration:read checks before submission and after await.
WP3 owns same-owner delegated policy, exact owner ScopedThreadRef, committed completed-message
selection and evidence watermark, scanner, bounded relay, retries and TTL. Its eleven bearer-only
hub routes and transient maximum 75-second/64-KiB outcome remain unchanged (030 §8:966–1008).
No hostname, SSH alias, path, arbitrary thread ID or caller attestation in public input; no
requester-to-owner connection or same-number local fallback. Local owner/hub takes the same
policy path without network. Forget/revoke/generation/expiry before response discards that read
only; canonical receive and unrelated sync keep progressing. Originals never enter canonical
memory, FTS, snapshots, checkpoints, reports or durable client caches.

## 4. Snapshot selection, framing and invalidation

NEW `S/memory/MemorySnapshot.ts` is a normal Effect Context.Service with private make/layer,
namespace imports and typed errors. Proposed non-wire methods are
`forThread(threadId: M.ThreadId): E<M.MemoryContextSnapshot|undefined, ServiceError>` and
`revalidate(snapshot: M.MemoryContextSnapshot): E<M.MemoryContextSnapshot|undefined, ServiceError>`.
It depends on existing MemoryService, Store, WP3 SyncService, server identity and committed thread/
project readers. No SQL or provider/network call in handlers or the pure Orchestrator.

For each real start, use one outer `MemoryStore.transact` (`MemoryStore.ts:426–429`) around local
readiness, committed thread/project binding resolution and all candidate reads. Reuse the same SQL
service/journal; existing service reads nest into it. Require this consistency in CI rather than
pretending three independently committed list calls share a watermark. No network inside this
transaction. Build a repeatable trusted internal read permit from the owning thread/run policy;
this is not an MCP-token requirement and not an externally selectable bypass flag.

Select only user scope of the ready space, current explicit/repository project key via
resolveProjectKey, and full current ScopedThreadRef. Missing project mapping excludes only project
memory; no cwd/foreign local-ID inference. Order current-thread, project, user, then memory ID.
Use MemoryListInput with explicit scope, limit <=100 and cursor; consume bounded pages until the
render budget is full or the relevant scope is exhausted, with the same transaction/watermark.
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

Required WP4 contract correction: `C/memory.ts:1165` checks raw item text occurs in renderedText.
That fails valid escaping of `&`, `<`, `>` and cannot prove correct framing. Remove that raw
substring predicate while retaining uniqueness, typed items and both final-size checks. The
provider-core validator must recompute the deterministic escaped rendering and compare equality;
all six adapter admission paths call it. Keep original item text unchanged. Do not import a
renderer into contracts or weaken excess-property validation. Tests must accept escaped special
characters and reject altered renderedText at actual adapter delivery. This is a proposed WP4
contract change for reflection, not a claim the existing schema accepts escaped output today.

Restoration uses readContextRevisions(space, selected IDs, permit), compares **exact** original
revision/scope and current eligibility, and repacks survivors only; never add replacements or
new items. IDs are capped at 100; the packer also bounds selected count. Revalidation error or
missing ID may clear the whole memory delivery. Clear snapshot/native cache on detach/stop/thread
replacement, permission change, forget/hold/dependency signal and TTL. Derived caches are current
views under `MEMORY_DERIVED_CACHE_MAX_BYTES` (32 MiB aggregate) and TTL (10 minutes), not archives.
Source has its stricter WP3 75-second bound. Cache eviction never rejects approved ingestion.
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
revalidate on the originally selected snapshot, not refresh, so restoration cannot grow context.
This closes creation → in-process propagation → native serialization → all consumer chains
without importing a server service into a reusable package.

## 5. Provider decisions and lifecycle

These are WP4 implementation decisions, **not current support claims**. MCP availability is
advertised only when the installed memory service and explicit credential grants are present.
Snapshot-only paths must not claim tools. Stored bodies are untrusted data, never developer policy.

| Provider | Actual delivery seam / evidence at HEAD | WP4 decision, resume and compaction |
| --- | --- | --- |
| Codex | `S/orchestration-v2/Adapters/CodexAdapterV2.ts:710–782` builds untrusted additionalContext; :6376–6390 stores it; :1743–1785 restores it; :6746 explicit compact. | Add reserved goat_memory untrusted entry independently of MCP app entries. Every ordinary/resumed prompt replaces it. Explicit compact installs fresh snapshot/generation before native command. Restoration rereads exact selected revisions, sends bounded surviving data as user external context, never developer text. Dedup by native thread + compaction item + generation; mark success after inject succeeds. Preserve forked notification handling and existing restore timeout. Error clears memory and logs category, without failing an already-running turn. |
| Claude | `S/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1049–1054` system append; :1071–1094 read-only tools; :8250–8275 persistent query; :8532–8540 and :8788–8791 actual message builders; :8966 compact. | Static reminder/tool availability only in system. Put fresh framed snapshot in each real user-message builder, including fallback/retry/resume; preserve attachments, UUID, echo and effort handling. Do not restart query or change queryPolicyKey for memory. Native compact/wake continuation makes no synthetic user turn; next ordinary prompt refreshes. Allow six read tools with full mcp__goat__ prefix, never three writes, on read-only policy. |
| Cursor | `packages/provider-cursor/src/server/adapter.ts:2111–2185` resolveUserMessage; :2116 native /compress; :2206 SDK submit; :2443 compact. | Fresh framed text in ordinary text/image message after validating original input; retain runtime/attachment/skill handling. Resumed agents refresh. Preserve exact native /compress early return, then refresh next real prompt. No provider memory/config file writes. MCP attachment independent of snapshot. |
| Grok | `packages/provider-grok/src/server/adapter.ts:336` uses shared ACP; `packages/provider-acp/src/server/adapter.ts:6784–6855` prompt parts; :6978 invocation. | One separate memory text block on every ordinary ACP prompt; do not place it in first-run/state-change instruction cache. Preserve HTTP/stdio MCP bridge. Resume refreshes; native control/wake paths do not receive synthetic prompts. Test Grok flavor explicitly. |
| Antigravity | `S/orchestration-v2/Adapters/AntigravityAdapterV2.ts:238` uses same ACP factory. | Same ordinary-turn snapshot rule, separate flavor fixture for profile and MCP restrictions. Actual denied/unavailable MCP is reported truthfully; data injection remains independent. No invented native compact support. |
| OpenCode | v1 `packages/provider-opencode/src/server/adapter.ts:972` external disables MCP; :3281 prompt system. v2 `packages/provider-opencode/src/server/v2/adapter.ts:3374–3433` prepareTurn/instructions; :4031 before submission. | v1 adds independent framed system-list data plus static trust reminder. v2 owns a separate goat_memory instruction key and last-successful value; put fresh value before each ordinary prompt, including resume, and send empty string to clear. Update cache only after successful put; failure prevents this prompt, not sync/pull. Native compaction stays native; next real prompt prepares again. External connections can be snapshot-only; no automatic GOAT credential forwarding. |
| oh-my-openagent (omo) | No dedicated adapter or integration symbol found in GOAT provider implementation search. | Conditional compatibility through the chosen OpenCode runtime only. No first-class support claim: plugin behavior/instruction preservation and child-agent MCP inheritance are not proven. Reuse OpenCode delivery if compatible; validate with an optional off-host fixture later. A plugin dropping instructions/tools is explicitly unsupported by WP4; do not add a seventh adapter or provider-specific memory store. |

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

| MCP name (exact WP1 catalog) | Service method | Required live grants | Declaration / annotation |
| --- | --- | --- | --- |
| memory_search | MemoryService.search | memory:read | reads; readonly |
| memory_list | MemoryService.list | memory:read | reads; readonly |
| memory_read | MemoryService.read | memory:read | reads; readonly |
| memory_history | MemoryService.history | memory:read | reads; readonly |
| memory_sync_status | MemorySyncService.syncStatus | memory:read | reads; readonly |
| memory_upsert | MemoryService.upsert | memory:write | writesWithCapability; mutating |
| memory_forget | MemoryService.forget | memory:write | writesWithCapability; destructive |
| memory_revert_resolution | MemoryService.revertResolution | memory:write | writesWithCapability; destructive |
| memory_read_source | MemoryService.readSource | memory:read + orchestration:read + WP3 owner policy | reads; readonly, no SSH host-reaching declaration |

MCP inputs/results use WP1 schemas/catalog (`C/memory.ts:2270–2280`). Pagination defaults to 20,
max 100 with 64-KiB encoded pages; whole items/cursors only. Oversize required single content
returns payload_too_large, not a partial fact. No arbitrary-path import tool, raw resolve/receive
port, settings tool or authority flag. WP5 owns import activation.

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
   union (`mcpOAuthHttp.ts:130`). Add the memory-scope selection to existing `mcpOAuthHtml.ts` consent rendering and carry it through the existing decision schema, not a parallel API. Extend SessionStore with a token-free active-scope read using current revocation/expiry predicates for live checks. Preserve a memory-only write grant without inferring orchestration:operate or elevating the runtimeModeCeiling. Legacy codes/sessions get no new grants. No exchange escalation.
2. Provider: `ProviderSessionManager.ts:474–533` prepare/reuse → McpCredentialRequest
   (`McpSessionRegistry.ts:15–25`) → issued token registry → resolve/context → live permit.
   Add stored grantedScopes and internal readCurrentPolicy callback; issuance checks current
   thread/provider and installed policy before reuse, rotates on policy change, and invocation
   rechecks live caller/run/deletion. Thread read is independently granted orchestration:read,
   never inferred from memory:read. Preparing before activeRunId commits must not deadlock start;
   require active-run ownership at invocation. Do not put a callback or grants into agent input.

NEW shared `packages/client-runtime/src/state/memory.ts` uses createEnvironmentRpcCommand for
mutations/binding/settings and permissionAtom for UI availability. Raw clients remain in rpc/.
Use existing EnvironmentRegistry/followStreamInEnvironment subscription lifecycle; add memoryChanges
subscription tag in rpc/client.ts. Export `createMemoryEnvironmentAtoms(runtime)` from the new state module, using the existing state/runtime.ts helpers; web/mobile instantiate it against their existing connectionAtomRuntime, with desktop reusing web. One stream per connected memory-capable environment while
consumers exist. Initial reset/reconnect clears bodies before refetch; downgrade, disconnect,
backpressure or auth failure disables body exposure until a new reset. Forget/hold/dependency
signals bump generation, cancel pending reads and evict search/list/read/history/source/snippets
and edits derived from affected memory. Late output checks generation, grant, TTL and tombstone;
a later watermark cannot resurrect a deleted ID. Unrelated new drafts survive. No localStorage,
IndexedDB or native persistence for bodies. A write-only caller does not acquire a read stream.

Web (hosted/local), desktop and mobile consume this same runtime factory; WP6 owns visible memory
screens/Settings/palette/keybinding wiring and reverse controls. Test selected environment routing
for local, remote/relay and tunnel; unavailable/old destinations return capability unavailable,
never route to client-local state. Do not set VITE_HTTP_URL/VITE_WS_URL. Capability advertisement
starts only when actual core routes and producers are ready; import and hub protocol remain
independent. Scheduled/delegated agents use the same services and admission policy.

## 7. Disjoint implementation lanes and integration

This is a future file-ownership map; it grants no source-writing authority in this P pass.
One WP4 change/PR when later requested; bounded lanes are not separate top-level work streams.
Each listed source owns its adjacent tests, unless a test is explicitly assigned below. New files
are marked NEW; existing files MODIFY. No lane edits WP3 while it is active; integrate/freeze its
implementation first, then re-anchor this map. Interface gaps return to the coordinator.

| Lane | Exclusive files | Output / dependency |
| --- | --- | --- |
| L1 contracts and domain | MODIFY `C/memory.ts`, `C/memory.test.ts`; MODIFY `S/memory/MemoryService.ts` and `.test.ts`; NEW `S/memory/MemorySnapshot.ts`, `MemorySnapshot.test.ts`, `MemoryAccess.ts`, `MemoryAccess.test.ts`; NEW `packages/provider-core/src/server/memoryContext.ts` and `.test.ts`; MODIFY `packages/provider-core/package.json` | Schema correction, public source activation, snapshot and pure validator. Consume WP3 source/readiness as frozen; no hub/registry reimplementation. L1 owns exports before consumers compile. |
| L2 auth and MCP | MODIFY `S/auth/{McpOAuth,EnvironmentAuth,SessionStore,mcpOAuthHttp,mcpOAuthHtml}.ts` and their existing/needed focused tests; MODIFY `S/mcp/{McpInvocationContext,McpSessionRegistry,McpHttpServer}.ts` and tests; MODIFY `S/orchestration-v2/ProviderSessionManager.ts` and test; NEW `S/mcp/toolkits/memory/{tools,handlers}.ts`, `handlers.test.ts` | Explicit OAuth/provider grant chains, live reauthorization, nine-tool toolkit and registration. Depends on L1 error/permit contract; no MemoryService edits. |
| L3 provider delivery | MODIFY `S/orchestration-v2/Adapters/{CodexAdapterV2,ClaudeAdapterV2,AntigravityAdapterV2}.ts` and tests; MODIFY `packages/provider-core/src/server/ProviderAdapter.ts`; MODIFY `S/provider/CodexDeveloperInstructions.ts` and `.test.ts`; MODIFY `packages/provider-{cursor,acp,grok}/src/server/adapter.ts` and tests; MODIFY `packages/provider-opencode/src/server/adapter.ts`, `adapter.test.ts`, `v2/adapter.ts`; NEW `v2/adapter.memory.test.ts` | All §5 paths, including shared ACP flavors, explicit compaction and restore. Depends on L1 renderer and L2 truthful availability contract. Existing optional turn field stays; no cloud field loss. |
| L4 shared client | NEW `packages/client-runtime/src/state/memory.ts`, `memory.test.ts`; MODIFY `packages/client-runtime/src/rpc/client.ts`, `client.test.ts`; MODIFY `packages/client-runtime/package.json` to export `./state/memory`; NEW thin `apps/web/src/state/memory.ts` and `apps/mobile/src/state/memory.ts` wrappers using their existing connectionAtomRuntime; MODIFY `C/clientRpcPermissions.ts`, `.test.ts` only if an actual guard amendment is needed | Guarded destination commands, body-free stream/reset, late-result fences. Consume existing DTOs; no auth/server source edits. Follow `state/attachments.ts:26–37` factory pattern and existing web/mobile attachment wrappers; no second runtime. UI screens stay WP6-owned. |
| L5 coordinator integration | MODIFY `S/{ws,server}.ts` and ws tests, `S/auth/RpcAuthorization.ts` and tests, `S/orchestration-v2/{RunExecutionService,runtimeLayer}.ts` and relevant tests, `S/environment/ServerEnvironment.ts` and tests, `C/rpc.ts` / tests only for actual group activation needs; owning 040/000 records and boundary map only when required | One composition, 14 core RPCs, snapshot insertion, cloud observation guard and capability gating. Coordinator alone edits these shared junctions. CI configuration changes, if needed, are coordinator-only after inspecting actual CI collection. |

Integration order: freeze actual WP3 implementation SHA/ports → L1 schema/renderer/domain exports →
L2 and L3 consumers plus L4 client in disjoint files → L5 composition/RPC/turn insertion → integrated
exact-head review and focused PR CI. WP3 supplies owner reader/authority once; L5 must not install
another. Do not add a second runtime/store/worker. Changes to a shared file are returned to its
owner, never patched from another lane. No lane launches a dev server.

## 8. Focused acceptance and evidence plan

All implementation tests below are **PR CI only — NOT RUN**. These are requested observable cases,
not verified commands or evidence of compilation. Do not execute bun, pnpm, vp test, vitest, e2e,
repo-wide checks or a full build on this Mac. CI must collect the actual changed test paths and
inspect steps/logs at the final SHA; job conclusion without execution is insufficient.

| Owner / focused test targets | Activation → observable proof |
| --- | --- |
| L1 MemorySnapshot / provider-core memoryContext | Three scopes in one committed view; explicit/repository/unmapped project and foreign scoped IDs → only correct space entries, one watermark. Pagination beyond 100 → bounded deterministic selection. Escaped special characters, emoji/combining text, exact cap/+1 → both framed budgets hold, whole facts only, altered frame rejected. Forget/conflict/hold/forget_pending between selection and restore → no stale body; FTS pending remains eligible. |
| L1 MemoryService / MemoryAccess | WP3 real-store source seam: local owner and A/H/B relay succeed with no direct owner connection; offline/expiry → source_unavailable; denied → auth denial; forgotten/source_invalidated/secret_detected preserved. Deferred gates then revoke/forget before response or lock acquisition → no bytes/commit/outbox. Scanner/watermark/message selection enforced. |
| L2 auth / ProviderSessionManager / McpSessionRegistry | Real prepare→issue→resolve→tool path for read/write/thread grants; reuse rotates on policy change; preparation before activeRunId succeeds, inactive/deleted caller invocation fails. OAuth browser and pairing proof→code→exchange→authenticated tool; unselected/legacy/access-only/reused/expired/escalated code cannot mint memory grants; approver union checked. |
| L2 toolkit / McpHttpServer | List exact nine tools with metadata; readonly calls denied without explicit grants, writes denied on read-only ceiling; revoke during service transaction wait prevents mutation. Tool result is strict JSON with no undefined optional fields; safe capacity/deadline/code retained. |
| L3 each provider adapter | Actual captured native payload contains bounded data on first and second ordinary prompt/resume/retry. Both ACP flavors covered. Claude query not restarted; native compact/compress unchanged; no synthetic wake. Codex restore Deferred + delete/revision change/duplicate completion → surviving exact items only, retry after failed inject. OpenCode v2 failed put → no prompt, successful empty put after forget → stale value cleared, cache updated only on success. External OpenCode snapshot succeeds without falsely advertising MCP. |
| L4 client-runtime / rpc / clientRpcPermissions | Selected remote/tunnel destination used; unavailable old environment never falls back locally. Real reset/forget/hold/dependency stream evicts affected bodies and derived edits; late response cannot resurrect; unrelated drafts/environment intact. Disconnect/downgrade/reset handshake fences exposure; write-only never subscribes. Commands and permissionAtom honor compound grants. |
| L5 ws / RpcAuthorization / RunExecutionService | All 14 core methods reach services with repeatable permits; binding change and useRepository reversal; settings CAS wrappers and status projection unchanged. Ordinary start and explicit compact get snapshot; cloud reattach calls observation-only resume without launching or sending memory/user message. One Store/Worker/runtime and ready capability gate. |
| L5 integrated M19/M20 | Local new mutation at capacity → safe capacity_exceeded; forget still uses deletion path; authenticated approved receive under local brake/scan/index/parent holds still persists receipt/cursor with deferred state. Search/status expose incomplete coverage and 1/7/30-day signed growth with partial/unavailable endpoints. Source/cache/provider preparation failure cannot stall sync. No new index/archive or unbounded snapshot cache. |

Use TestClock/Deferred and real service/store fixtures; event-sourced milestones use worker drain
or persisted event, never sleeps/polling. Targeted package typechecks/lint and exact focused test
collection run in PR CI, not here. Server tests belong to existing goat-ci shards; shared runtime
cases belong to test-client-runtime; provider package tests require explicit collection in the
existing root Vite config. Do not invent a new parallel runner or claim a broad glob covers new
files without checking collection. Every actual changed file must have an owner/CI collection
entry before B closes. M19 packaged/off-host evidence remains separate from source CI.

## 9. Risks, surfaces and reflection handoff

- WP3 is a dependency, not completed code. Verify actual source-preparation/validation/error and
  settings/status/readiness signatures before implementation. A mismatch requires owner repair,
  not transport-side SQL or a guessed fallback.
- Snapshot consistency and nested transaction behavior need real-store proof. Recheck local
  readiness/binding and exact revision filtering at the admission/restore boundary. No paid
  model, source relay or network authentication inside SQL.
- Schema/renderer amendment S13 and provider-specific instruction semantics need reflection.
  OpenCode v2 clearing failure must fail preparation; Codex replay must not resurrect deletion.
- Explicit provider/OAuth grants require full producer-to-consumer proof. Existing capability or
  full-access selection does not confer memory/thread rights. UI guards are availability hints;
  service live permits are the authoritative path. Alternate raw handler entry is a bypass to
  test, not a claim of unbypassable enforcement (E7; 000 enforcement inventory).
- Web local/hosted, desktop and mobile share client state; visible entry points and reverse
  actions remain WP6. Providers: six decisions in §5. Agents: same nine service-backed tools,
  including scheduled/delegated callers. Contracts: existing wire shapes plus S13 correction.
  Reverse states: forget/revert, binding useRepository and settings disable/revoke clear exposure.
  Connection modes: local, remote/relay and tunnel preserve destination and owner authority.
- omo remains conditional OpenCode compatibility; no native integration or plugin inheritance
  proof. Cloud observation-only attach cannot retrofit memory into an already-running remote task.
- **User decisions required: none.** These are implementation/reflection risks within existing
  M1–M20 requirements, not new product choices. Architect reflection and independent A are next;
  READY_FOR_REFLECTION does not mean READY_TO_BUILD, passing CI or runtime CLOSED.

Authoring verification: the two-file diff, source anchors and pinned baselines were inspected;
`git diff --check` passed. `vp fmt --check` with these exact two Markdown paths exited 1 before
formatting: no project-local vite-plus installation, and vite.config.ts could not resolve
`vite-plus` / `vite-plus/test/config`. No install or fallback package command was run. This is
**formatting NOT VERIFIED**, not a formatting pass. No implementation tests have run in this pass.

## Folded revision correspondence

| Prior material | Current home |
| --- | --- |
| rev 2 cross-phase contracts and rev 3 producer/consumer/source fixes | §2–3, §6–7 |
| rev 4 live provider/thread authorization and static-input coverage | §6–8; actual CI collection replaces obsolete 60-file command receipt |
| prior snapshot/provider recipes | §4–5 with current ports, cloud semantics and S13 correction |
| rev 7 requirement 7 / M19 and audit fixes; rev 8 M20 | §3–4, §6, §8–9; approved receive remains independent of local exposure |

No superseded appendix remains an alternate instruction source. This document is the current WP4
consumer plan; WP1/WP2 implementation and WP3 frozen ownership remain authoritative for their ports.
