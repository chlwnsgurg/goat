# 040 — WP4: memory MCP and provider injection (P correction r1)

Date: 2026-10-14. Status: **READY_FOR_REVIEW**, not implementation approval or runtime proof.
This is the bounded planner handoff; architect reflection and independent A remain coordinator work.
This correction writes only 040 and one reflection/audit treatment record in the WP4 cycle of 000. Source changes,
other plans, tests, builds, push and PR creation are outside this pass. The explicit two-document
commit request overrides AGENTS.md's default against committing plans.

## 1. Baseline, outcome and stale check

- Worktree: `goat-wp4-plan`; branch: `goat/memory-wp4-mcp-injection`.
- Correction input HEAD: `7f38b5787d38b12237321b7c40c6b950cda69436`, with a clean worktree
  and the specified branch verified. The preceding rewrite used WP3 plan base
  `55d77f1f8d7ac4cc7a3b222d05a878accf065c4d` after integrating actual WP2.
  WP3 implementation is **absent** here and is being built in another lane.
- Required dev baseline: `637a9835190829b691622dc5bd4b9a147e714ae8` (#171 cloud foundation),
  already integrated. Provider input must retain both memory and cloud fields.
- WP3 authority: 030 §4, §4.2 and §12, including rev 11c claim-retirement correction at
  `162851dc0`. Its heading still says rev 11b; the later correction and 000 WP3 A record govern.
  The older WP3 baseline/WP2 D wording is historical, not a reason to replace this checkout.
- Previous rewrite remote check (not refreshed in this correction): `refs/heads/dev` is now `5c55f20022513a57be65e8ab7948514d9ab12945`.
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

| ID  | Old assumption                                                              | Current disposition                                                                                               |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| S01 | `1e2418faf` and pre-cloud line anchors describe current source              | Pin actual WP2/WP3 base and dev above; use §2/§5 anchors.                                                         |
| S02 | Public `applyOperation(input, permit)` exists                               | Use upsert/forget/revertResolution and StoredReceipt (§2).                                                        |
| S03 | `readContextCandidates({thread})` resolves all scopes                       | Actual input is MemoryListInput plus Permit; snapshot owns a consistent three-scope read (§4).                    |
| S04 | `readContextRevisions(snapshot)` refilters a snapshot                       | Actual arguments are space, ids, Permit; compare exact revisions after reread (§4).                               |
| S05 | WP2 already exports source authority/owner reader                           | WP3 prepares/validates and composes these; WP4 activates public readSource (§3).                                  |
| S06 | Sync settings/status/readiness are existing WP2 exports                     | Frozen WP3 additions with exact permit/error contracts (§2).                                                      |
| S07 | Memory grants follow access/capability automatically                        | Complete OAuth and provider credential producer/live-check chains (§6).                                           |
| S08 | Core RPC definitions mean active server/client routes                       | Schemas/guard map exist; registration, handlers and shared runtime remain WP4 (§6).                               |
| S09 | A start-only snapshot covers reuse, native compaction and cloud attach      | Distinguish real prompts, control commands, restoration and observation-only attach (§5).                         |
| S10 | Restoration can replay cached bodies                                        | Revalidate IDs/revisions/eligibility and clear stale native entries (§4–5).                                       |
| S11 | Growth/status and deferred receive can be simplified at transport           | Preserve M19/M20 status and separate local exposure from canonical receive (§6–8).                                |
| S12 | Append-only rev 2–8 recipes and their command lists form an executable plan | Fold into this body; disjoint owners, dependencies and CI-only evidence (§7–9).                                   |
| S13 | Escaping text is compatible with raw `renderedText.includes(item.text)`     | Actual schema conflicts for special characters; amend that derived-text invariant before renderer consumers (§4). |

## 2. Implemented / WP3-provided / WP4 adds

All source anchors below refer to checked HEAD, not future line numbers. `S/` means
`apps/server/src/`, `C/` means `packages/contracts/src/`, `M` means `@goat/contracts`,
`E<A,X>` means `Effect.Effect<A,X>`. `ServiceError` = MemoryService.MemoryServiceError;
`Permit` = `E<void, MemoryService.MemoryAccessError>` (repeatable, live, no network).
MemoryServiceError is the union of MemoryAccessError, MemoryStorageError,
MemoryStoreConflict and MemoryCapacityError (`S/memory/MemoryService.ts:20–35`).

| Concern                 | Implemented                                                                                                                                                                                                                                                                                                                                                                             | WP3-provided (frozen proposal, NOT present yet)                                                                                                                                                                                                                                                                                                                 | WP4 adds / consumes                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mutations               | `upsert(input: M.MemoryUpsertInput, permit: Permit): E<Store.StoredReceipt, ServiceError>`; `forget(input: M.MemoryForgetInput, permit: Permit): E<Store.StoredReceipt, ServiceError>`; `revertResolution(input: M.MemoryRevertResolutionInput, permit: Permit): E<M.MemoryRevertResult, ServiceError>` — `S/memory/MemoryService.ts:67–81`                                             | L1 retains these; resolves hub approvals/settlement without device-clock expiry (030 §4/§12).                                                                                                                                                                                                                                                                   | Thin RPC/MCP calls. StoredReceipt is `{operationDigest, receipt}` (`S/memory/MemoryStore.ts:86–92`); map its local mutation receipt to WP1 wire success, never cast a hub receipt into it. Preserve split forget base/expansion outcomes and operation IDs.        |
| Reads                   | `list(input: M.MemoryListInput, permit: Permit): E<M.MemoryPage, ServiceError>`; `search(input: M.MemorySearchInput, permit: Permit): E<M.MemoryPage, ServiceError>`; `read(input: M.MemoryReadInput, permit: Permit): E<M.MemoryItem, ServiceError>`; `history(input: M.MemoryHistoryInput, permit: Permit): E<M.MemoryHistoryPage, ServiceError>` — `S/memory/MemoryService.ts:82–97` | Preserve canonical receipt vs local exposure and history.revertResults (030 §12).                                                                                                                                                                                                                                                                               | Same methods for tools/clients; preserve quarantine, localAvailability, coverage and cleanup state.                                                                                                                                                                |
| Candidate read          | `readContextCandidates(input: M.MemoryListInput, permit: Permit): E<M.MemoryContextCandidates, ServiceError>` — `S/memory/MemoryService.ts:119–122,956–979`; one scope/page, not thread orchestration.                                                                                                                                                                                  | Local readiness, not a replacement candidate API.                                                                                                                                                                                                                                                                                                               | L1 extends the existing contracts type MemoryContextCandidates with `nextCursor: M.MemoryPage["nextCursor"]` and preserves list continuation before eligibility filtering (§4); no new wire DTO. Snapshot uses bounded pages; one page need not cover every scope. |
| Restore read            | `readContextRevisions(space: M.MemorySpaceId, ids: ReadonlyArray<M.MemoryId>, permit: Permit): E<M.MemoryContextCandidates, ServiceError>` — `S/memory/MemoryService.ts:123–127,980–1010`                                                                                                                                                                                               | Preserve eligibility after approved receive/forget.                                                                                                                                                                                                                                                                                                             | Match original exact revisions/scope; no newer replacements. Missing/error can omit entire memory snapshot safely.                                                                                                                                                 |
| Binding / signals       | `getProjectBinding(input: M.MemoryProjectBindingGetInput, permit: Permit): E<M.MemoryProjectBinding, ServiceError>`; `updateProjectBinding(input: M.MemoryProjectBindingUpdateInput, permit: Permit): E<M.MemoryProjectBindingUpdateResult, ServiceError>`; `resolveProjectKey(space: M.MemorySpaceId, project: M.ScopedProjectRef): E<M.MemoryProjectKey                               | null, ServiceError>`; `changes(input: M.MemoryChangesInput, permit: Permit): Effect.Effect<Stream.Stream<M.MemoryChangeSignal, ServiceError>, ServiceError, Scope.Scope>`—`S/memory/MemoryService.ts:47–66`                                                                                                                                                     | Persisted bootstrap/binding and body-free settlement changes.                                                                                                                                                                                                      | Binding commands, one environment-keyed change subscription, cache generation fences. |
| Source                  | No public readSource, prepareSourceRead, validateSourceOutcome or MemorySyncService in WP2. Worker private summary reader is not this API.                                                                                                                                                                                                                                              | Exact §3 signatures from 030 §4.2:527–563; authority implementation in WP3 L4 and owner-reader injection in WP3 L5.                                                                                                                                                                                                                                             | `readSource(input: M.MemoryReadSourceInput, permit: Permit): E<M.MemorySourcePage, ServiceError>` per 030 §12:1183. Activate without rebuilding relay or owner reader.                                                                                             |
| Settings/status         | Wire schemas only; no WP2 SyncService exports.                                                                                                                                                                                                                                                                                                                                          | `getHubSettings(input: M.MemoryHubSettingsGetInput, permit: Permit): E<M.MemoryHubSettingsView, ServiceError>`; `updateHubSettings(input: M.MemoryHubSettingsUpdateInput, permit: Permit): E<M.MemoryHubSettingsUpdateResult, ServiceError>`; `syncStatus(input: M.MemorySyncStatusInput, permit: Permit): E<M.MemorySyncStatus, ServiceError>` — 030 §12:1184. | RPC calls with settings:write / memory:read respectively; status MCP. Consume WP3 readStorageStatus assembly; never recompute storage.                                                                                                                             |
| Readiness               | No WP2 SyncService readiness API.                                                                                                                                                                                                                                                                                                                                                       | `readLocalReadiness(): E<{memorySpaceId: M.MemorySpaceId                                                                                                                                                                                                                                                                                                        | null; bootstrap: "unbound"                                                                                                                                                                                                                                         | "staging"                                                                             | "ready"}, ServiceError>`; `requireBootstrap(space: M.MemorySpaceId): E<void, ServiceError>` — 030 §12:1185. | Snapshot reads local persisted readiness; unbound/staging means no snapshot. Offline but bootstrapped does not block on network. |
| Schemas / adapter input | `C/memory.ts:89–100,1146–1177,2270–2280`; `ProviderAdapterV2TurnInput.memoryContext?: MemoryContextSnapshot` at `packages/provider-core/src/server/ProviderAdapter.ts:419`, alongside cloudLaunchSource/cloudSource at :421–422; observation-only resume type at :621.                                                                                                                  | WP3 contract amendments are prerequisites, not WP4 schema inventions.                                                                                                                                                                                                                                                                                           | Renderer/validator, nine-tool registration, real producers/consumers and truthful capability advertisement. Preserve cloud types and fields.                                                                                                                       |
| Composition             | One Store/Quota/Service/Worker graph: `S/server.ts:588–605`.                                                                                                                                                                                                                                                                                                                            | WP3 reuses this graph and injects source authority/committed reader once (030 §8).                                                                                                                                                                                                                                                                              | Provide snapshot/access/tool layers into this same graph; no extra SQL connection, worker or ManagedRuntime.                                                                                                                                                       |

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
`C/memory.ts:1172–1175` contracts type to retain its existing fields plus
`nextCursor: M.MemoryPage["nextCursor"]`; `readContextCandidates` keeps its input/error signature
and copies `MemoryService.list`'s actual nextCursor before filtering candidates. Continuation is
based on the last unfiltered store row (`MemoryService.ts:690–693,710`), including a page whose
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

Immediately before Codex restoration is delivered, call `revalidate(snapshot, { threadId, runId })`
with the server-captured current execution. Restoration uses
readContextRevisions(space, selected IDs, permit), compares **exact** original
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
| memory_read_source           | MemoryService.readSource       | memory:read + orchestration:read + WP3 owner policy | reads; readonly, no SSH host-reaching declaration |

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
are marked NEW; existing files MODIFY. No lane edits WP3 while it is active; integrate/freeze its
implementation first, then re-anchor this map. Interface gaps return to the coordinator.

| Lane                       | Exclusive files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Output / dependency                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 contracts and domain    | MODIFY `C/memory.ts`, `C/memory.test.ts`; MODIFY `S/memory/MemoryService.ts` and `.test.ts`; NEW `S/memory/MemorySnapshot.ts`, `MemorySnapshot.test.ts`, `MemoryAccess.ts`, `MemoryAccess.test.ts`; NEW `packages/provider-core/src/server/memoryContext.ts` and `.test.ts`; MODIFY `packages/provider-core/package.json`                                                                                                                                                                                                                                                                                                  | Escaped-render schema correction plus candidate nextCursor contract/producer correction, public source activation, bounded snapshot and execution-aware revalidation, and pure validator. Consume WP3 source/readiness as frozen; no hub/registry reimplementation. L1 owns exports before consumers compile.                                                                                                                              |
| L2 auth and MCP            | MODIFY `S/auth/{McpOAuth,EnvironmentAuth,SessionStore,mcpOAuthHttp}.ts` and their existing/needed focused tests; MODIFY `S/mcp/{McpInvocationContext,McpSessionRegistry,McpHttpServer}.ts` and tests; MODIFY `S/orchestration-v2/ProviderSessionManager.ts` and test; NEW `S/mcp/toolkits/memory/{tools,handlers}.ts`, `handlers.test.ts`                                                                                                                                                                                                                                                                                  | OAuth server grant chain consuming L4 consent payloads, provider grants, live reauthorization, nine-tool toolkit and registration. Depends on L1 error/permit contract; no MemoryService edits.                                                                                                                                                                                                                                            |
| L3 provider delivery       | MODIFY `S/orchestration-v2/Adapters/{CodexAdapterV2,ClaudeAdapterV2,AntigravityAdapterV2}.ts` and tests; MODIFY `packages/provider-core/src/server/ProviderAdapter.ts`; MODIFY `S/provider/CodexDeveloperInstructions.ts` and `.test.ts`; MODIFY `packages/provider-{cursor,acp,grok}/src/server/adapter.ts` and tests; MODIFY `packages/provider-opencode/src/server/adapter.ts`, `adapter.test.ts`, `v2/adapter.ts`; NEW `v2/adapter.memory.test.ts`                                                                                                                                                                     | All §5 paths, including shared ACP flavors, explicit compaction and restore. Depends on L1 renderer and L2 truthful availability contract. Existing optional turn field stays; no cloud field loss.                                                                                                                                                                                                                                        |
| L4 shared client           | NEW `packages/client-runtime/src/state/memory.ts`, `memory.test.ts`; MODIFY `packages/client-runtime/src/rpc/client.ts`, `client.test.ts`; MODIFY `packages/client-runtime/package.json` to export `./state/memory`; NEW thin `apps/web/src/state/memory.ts` and `apps/mobile/src/state/memory.ts` wrappers using their existing connectionAtomRuntime; MODIFY `C/clientRpcPermissions.ts` only if an actual guard amendment is needed; MODIFY its `.test.ts` for compound import behavior; MODIFY `apps/web/src/components/auth/ConnectAgentSurface.tsx`; NEW `apps/web/src/components/auth/ConnectAgentSurface.test.tsx` | Guarded destination commands including importProvider, actual OAuth consent producer/both proof arms/full-union one-click behavior, body-free stream/reset, late-result fences. Consume existing DTOs; no auth/server source edits. Follow `state/attachments.ts:26–37` factory pattern and existing web/mobile attachment wrappers; no second runtime. Other UI screens stay WP6-owned; OAuth consent producer/test moves from WP6 to L4. |
| L5 coordinator integration | MODIFY `S/{ws,server}.ts` and ws tests, `S/auth/RpcAuthorization.ts` and tests, `S/orchestration-v2/{RunExecutionService,runtimeLayer}.ts` and relevant tests, `S/environment/ServerEnvironment.ts` and tests, `C/rpc.ts` / tests only for actual group activation needs; owning 040/000 records and boundary map only when required                                                                                                                                                                                                                                                                                       | One composition, 14 core RPCs, snapshot insertion, cloud observation guard and capability gating. Coordinator alone edits these shared junctions. Integrated OAuth screen verification with test-t3-app and before/after PR screenshots (goat-screenshot-gate) are required. CI configuration changes, if needed, are coordinator-only after inspecting actual CI collection.                                                              |

Integration order: freeze actual WP3 implementation SHA/ports → L1 schema/renderer/domain exports →
L2 and L3 consumers plus L4 client in disjoint files → L5 composition/RPC/turn insertion → integrated
exact-head review and focused PR CI. WP3 supplies owner reader/authority once; L5 must not install
another. Do not add a second runtime/store/worker. Changes to a shared file are returned to its
owner, never patched from another lane. Only L5 performs the integrated real-client pass; implementation sublanes do not launch dev servers.

## 8. Focused acceptance and evidence plan

All automated implementation tests below are **PR CI only — NOT RUN**. L5 also owes the
pre-approved test-t3-app real-screen pass on an authorized verification host, outside this
docs-only pass and without prohibited local test/build commands. These are requested observable cases,
not verified commands or evidence of compilation. Do not execute bun, pnpm, vp test, vitest, e2e,
repo-wide checks or a full build on this Mac. CI must collect the actual changed test paths and
inspect steps/logs at the final SHA; job conclusion without execution is insufficient.

| Owner / focused test targets                          | Activation → observable proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 MemorySnapshot / provider-core memoryContext       | Page watermark and final readiness/binding fences → three scopes never mix committed views; concurrent change discards selection without unbounded retry; explicit/repository/unmapped project and foreign scoped IDs → only correct space entries, one watermark. Real-store first page entirely excluded, next page eligible → list nextCursor reaches the eligible row without repetition; exact-ID revision reads return null continuation. Pagination beyond 100 → deterministic selection. All excluded/all output-oversize items hit the 10-page/1,000-slot/640-KiB scan ceilings independently of output size; pre-filter encoded pages obey 64 KiB. Short page reads release the common transaction lane so forget/approved receive can commit between pages. Escaped special characters, emoji/combining text, exact cap/+1 → both framed budgets hold, whole facts only, altered frame rejected. Forget/conflict/hold/forget_pending between selection and restore → no stale body; FTS pending remains eligible. |
| L1 MemoryService / MemoryAccess                       | WP3 real-store source seam: local owner and A/H/B relay succeed with no direct owner connection; offline/expiry → source_unavailable; denied → auth denial; forgotten/source_invalidated/secret_detected preserved. Deferred gates then revoke/forget before response or lock acquisition → no bytes/commit/outbox. Scanner/watermark/message selection enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| L2 auth / ProviderSessionManager / McpSessionRegistry | Real prepare→issue→resolve→tool path for read/write/thread grants; reuse rotates on policy change; preparation before activeRunId succeeds, inactive/deleted caller invocation fails. OAuth browser and pairing proof→code→exchange→authenticated tool; unselected/legacy/access-only/reused/expired/escalated code cannot mint memory grants; approver union checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| L2 toolkit / McpHttpServer                            | List exact nine tools with metadata; readonly calls denied without explicit grants, writes denied on read-only ceiling; revoke during service transaction wait prevents mutation. Tool result is strict JSON with no undefined optional fields; safe capacity/deadline/code retained.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| L3 each provider adapter                              | Actual captured native payload contains bounded data on first and second ordinary prompt/resume/retry. Both ACP flavors covered. Claude query not restarted; native compact/compress unchanged; no synthetic wake. Codex restore Deferred + foreign-thread snapshot reuse, binding change followed by late compaction, run termination, permission loss, delete/revision change/duplicate completion → cleared memory or surviving exact items only, retry after failed inject. OpenCode v2 failed put → no prompt, successful empty put after forget → stale value cleared, cache updated only on success. External OpenCode snapshot succeeds without falsely advertising MCP.                                                                                                                                                                                                                                                                                                                                             |
| L4 client-runtime / rpc / clientRpcPermissions        | Selected remote/tunnel destination used; unavailable old environment never falls back locally. Real reset/forget/hold/dependency stream evicts affected bodies and derived edits; late response cannot resurrect; unrelated drafts/environment intact. Disconnect/downgrade/reset handshake fences exposure; write-only never subscribes. importProvider({ environmentId, input }) and permissionAtom require both memory:write and filesystem:read; either missing/revoked grant denies, unsupported destination is unavailable, selected destination is retained. ConnectAgentSurface behavior tests capture both proof-arm payloads through the existing schema, default empty scopes, changed selection and full-union one-click acceptance/rejection.                                                                                                                                                                                                                                                                   |
| L5 ws / RpcAuthorization / RunExecutionService        | All 14 core methods reach services with repeatable permits; binding change and useRepository reversal; settings CAS wrappers and status projection unchanged. Ordinary start and explicit compact get snapshot; cloud reattach calls observation-only resume without launching or sending memory/user message. One Store/Worker/runtime and ready capability gate. L5 runs test-t3-app against the actual OAuth consent screen (both proof paths/selection changes), attaches before/after screenshots to the UI PR and satisfies goat-screenshot-gate; formatter/unit evidence alone cannot close this UI acceptance.                                                                                                                                                                                                                                                                                                                                                                                                       |
| L5 integrated M19/M20                                 | Local new mutation at capacity → safe capacity_exceeded; forget still uses deletion path; authenticated approved receive under local brake/scan/index/parent holds still persists receipt/cursor with deferred state. Search/status expose incomplete coverage and 1/7/30-day signed growth with partial/unavailable endpoints. Source/cache/provider preparation failure cannot stall sync. No new index/archive or unbounded snapshot cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
  actions remain WP6. Providers: six decisions in §5. Agents: same nine service-backed tools,
  including scheduled/delegated callers. Contracts: existing wire shapes plus S13 correction and nextCursor on the existing non-wire candidate contracts type; revalidate execution identity stays internal.
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
| WP5 / WP6 | WP4 L4 exports guarded importProvider({ environmentId, input }) with the existing memory:write + filesystem:read compound guard and unavailable destination behavior/tests. WP5 retains server group/handler/capability activation; WP6 consumes the command.                                                                                           |

Authoring verification: correction input HEAD/branch, clean worktree and affected source/contract
ports were checked statically. The two-document diff and formatter results are recorded in the
author's handoff report. Formatting uses the installed tool from goat-78999bf5 against absolute
paths, since this worktree has no node_modules; vp fmt and vp fmt --check both exited 0
on the two files, correcting the inherited formatting violation. git diff --check also passed.
No dependency install was needed. Implementation
tests, builds, typechecks and integrated UI verification are NOT RUN in this docs-only correction.
Reflection r1 MISALIGNED (G-1/G-2 High, G-3 Medium) and audit r1 FAIL (A#1/A#2 High, A#3 Medium)
are addressed in this current body; a fresh reflection/audit must assess the correction before B.

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

No superseded appendix remains an alternate instruction source. This document is the current WP4
consumer plan; WP1/WP2 implementation and WP3 frozen ownership remain authoritative for their ports.
