# 050 — WP5: read-only provider memory import

A user can explicitly bring supported Codex, Claude and omo memories into GOAT with their
source provenance. GOAT never changes those sources. Re-import observes stable source keys,
content changes and permanent forget suppression; every environment submits the same ordinary
local intents to the configured hub. Imported text is untrusted inference, not instructions.

- Date: 2026-10-14. Status: current P plan, **READY_FOR_REFLECTION**; reflection and independent
  A remain coordinator work. WP5 implementation, focused tests and runtime evidence: **NOT RUN**.
- Authoring branch: `goat/memory-wp5-provider-import`, worktree `goat-wp5-plan`, input HEAD
  `cfa07255fa5a3dcc74fa0f2abe6f7973b5ec84af` (040 A near-pass after audit r2).
  Actual WP2 is integrated through `55d77f1f8`; its implementation head is
  `637b3032772c50b7d3bc1d53f4ef90387768358a`. WP3 and WP4 implementation are absent.
- Dependency pins: [030](030_wp3_hub_sync.md) §4/§12 frozen interfaces, coordinator revision
  **11c** (the inherited document title still says 11b), and [040](040_wp4_mcp_injection.md)
  at `cfa07255f`. Planned ports below are not current exports.
- Fresh dev: `origin/dev` fetched and remote tip checked at
  `8aa674910542868a7f6bf66fa689778fbd071dc9`. From the WP2-integrated dev ancestor
  `637a98351`, only `packages/ssh/package.json` and three SSH test files changed; no import,
  memory, authorization or provider port drift. Dev itself does not contain the WP1/WP2 stack.
  Do not interpret a branch-to-dev diff deleting memory files as a dev regression.
- Authority: [000 decisions](000_plan.md#decisions-main-dispositions-of-m1-m20) M17/M19/M20,
  [shared names](000_plan.md#shared-names-all-phase-docs-must-use-these) and
  [enforcement limits](000_plan.md#enforcement-inventory). Research is evidence, not authority.

Loop spec: **satisfy-spec**, triggered by this WP5 stale-check/rewrite request. Goal: a bounded,
source-grounded implementation handoff for read-only import. Non-goals: implementation, other
plan edits, home-corpus inspection, provider execution, UI, watchers, write-back, push or PR
creation. Verifiers for this authoring are two-file formatting/check and `git diff --check`;
runtime acceptance is future exact-head PR CI only, NOT RUN. Stop after rewriting 050, adding
one WP5 P record to 000 and making the requested single docs commit. Memory artifact: this
plan and that record. Outcomes: READY_FOR_REFLECTION or BLOCKED by an unresolved requirement;
escalate a predecessor signature/schema incompatibility to its owner before B, never hide it
behind an import compatibility shim. No product decision is currently outstanding.

## 1. Stale check and evidence boundary

**15 stale assumptions replaced**, counted by semantic decision rather than moved citations:

| ID  | Superseded assumption                                                                     | Current disposition                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Baseline is `1e2418faf` and the original authoring ban prevents a commit.                 | Use the branch/dependency/dev pins above and this request's two-file, one-commit authorization.                                                          |
| S02 | Memory modules are absent.                                                                | WP2 Store/Service/Quota/Worker/FTS, contracts and migration are implemented here.                                                                        |
| S03 | All source/batch/item receipt APIs already exist in WP2.                                  | Tables exist; registration, session, batch/item codecs and CAS APIs are WP5 additions.                                                                   |
| S04 | `apply(operation, { importSource, ... })` is an existing extension seam.                  | Store.apply accepts MemoryDecision; extend the existing service transaction, not Store.apply's operation shape.                                          |
| S05 | `resolveProjectKey(project)` or current remote/cwd determines scope.                      | Use `resolveProjectKey(space, project)` and persisted binding version; explicit per-item scope.                                                          |
| S06 | Readiness/bootstrap is an existing service or a network check.                            | Consume future 030 §12 persisted local readiness and requireBootstrap; bootstrapped offline is allowed.                                                  |
| S07 | Materialization can construct changed imports with any parent.                            | Existing materializeLocalIntent hardcodes empty parents; it is only the initial-intent seam. Revisions use the normal parent-aware local operation path. |
| S08 | Import upserts immediately prove hub acceptance.                                          | Local receipt/intent is pending; hub admission and canonical settlement are sole M20 authority, including on the hub environment.                        |
| S09 | Existing forget already gathers imported aliases and content hashes.                      | MemoryService.forget currently produces empty imported source/content arrays; WP5 must supply them before import activation.                             |
| S10 | Provider exclusion is a provider session masquerading as a GOAT thread.                   | MemorySourceKey suppresses provider items; MemorySourceExclusion is only actual GOAT thread/watermark/messages.                                          |
| S11 | Source-local session counters are already persisted, or chunks alone bound growth.        | WP5 persists source/session ownership and cumulative counters atomically; new session IDs cannot reset lifetime/space admission.                         |
| S12 | Full local alias/key/work budgets may refuse approved replica metadata.                   | Canonical approved union/receipt/cursor persists; local scanner/FTS holds defer exposure only.                                                           |
| S13 | WP5 must build the guarded client command.                                                | 040 L4 provides importProvider({ environmentId, input }); WP5 owns only server activation.                                                               |
| S14 | Prior real-home observations and the old omo checkout establish current supported shapes. | No provider home is inspected in this run. Codex/public-source pin and Claude research profile; omo beta.63 pin, not current 4.5.12 checkout.            |
| S15 | Old static coverage counts/CI paths/appendices prove this new plan.                       | Reconcile the actual lane map and current server shards below; fold revisions into this body, all implementation proof NOT RUN.                          |

Read-only evidence: initiative `research/075_cross_provider_memory_cases.md:31–49,81–117`,
`100_omo_memory.md:3–25`, `110_omo_memory_layer.md:3–47,49–78`,
`120_goat_memory_source_terrain.md:13–43,61–102`. These dated investigations distinguish
provider canonical text from navigation, transcripts and execution state. Their Git-canonical
GOAT proposal, provider-disable option and older test results are not adopted as current GOAT
behavior. WP2 SQLite plus 030 hub admission supersede that storage/sync proposal.

Provider source references in §2 are pinned local **public source repositories**, read via
`git show` without checkout or execution. Claude's corpus is a dated research account; no
fresh Claude implementation or installed layout is claimed. No actual provider memory corpus,
settings, credentials, transcripts or provider Git state was inspected or changed. The small
Codex/Aside/wiki guidance lookup supplied no relevant WP5 implementation history.

## 2. Provider source and parser decisions

Roots are resolved inside the **selected destination environment**, never the browser,
Electron renderer, mobile device or coordinator machine. Trusted immutable server root slots
can replace defaults for deployment overrides and temporary fixtures. The RPC contains no
absolute path or free-form profile. Do not read provider settings to discover overridden roots.
An unsupported layout is explicit `unsupported_format`, not arbitrary Markdown fallback.

| Provider / parser profile           | Source location and item unit                                                                                                                                                                                                      | Parser decision and exclusions                                                                                                                                                                                                                                                                                                                                                                                           | Evidence / version policy                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex / `codex-handbook-v1`         | `<codex-home>/memories/MEMORY.md`, default `~/.codex/memories`; one `# Task Group:` block requiring `scope:`, optional supported `applies_to:` routing metadata. Key `MEMORY.md#task-group:<NFC title>`.                           | Pure UTF-8 Markdown parser tracks fences; duplicate normalized group titles reject the file. Keep guidance/task text; remove scope/routing/evidence-list metadata from assertion text. `memory_summary.md`, `raw_memories.md`, rollout summaries, sessions/JSONL, SQLite, skills, workspace diffs and Git internals are excluded. No links or rollout_path are followed. Missing handbook does not fall back to summary. | Public Codex repo pin `816fa702ec66a4c81b204701a03371a1ac3511e6`: `codex-rs/memories/write/src/lib.rs:37–41,112–131`; `codex-rs/memories/write/templates/memories/consolidation.md:119–140,179–210,235–273`. The old shortened template path was wrong. Grammar, not an inferred installed app version, selects support.                                                                                                                                                  |
| Codex / `codex-ad-hoc-v1`           | Same root, `extensions/ad_hoc/notes/*.md`; one whole nonempty note, `<relativePath>#body`.                                                                                                                                         | Strict UTF-8 Markdown; reject NUL/JSONL transcript envelopes. Exclude all other extensions/resources and instructions.md; no recursive extension scan. Notes may be selected without a handbook.                                                                                                                                                                                                                         | Same public pin, `codex-rs/ext/memories/src/local/ad_hoc_note.rs:12–23,26–39`. Source bytes are never edited.                                                                                                                                                                                                                                                                                                                                                             |
| Claude / `claude-topic-v1`          | Default `~/.claude/projects/<opaque>/memory/*.md`, one explicitly selected immediate memory directory; whole root-level topic, `<relativePath>#body`.                                                                              | YAML frontmatter has scalar name/description/type; type is user/feedback/project/reference; nonempty body. Reject duplicate keys, tags, anchors, unsupported nested data/types. MEMORY.md is navigation only. Exclude agent-memory, CLAUDE.md/rules, episodes, settings, sessions, symlinks and linked outside files. Encoded dirname is not project identity.                                                           | Research `110:28–30`, corpus `010_memory-pipeline/10_cc_memory.md:89–138`, referenced by that research. AutoMemoryDirectory/remote overrides exist in the account but are not discovered from private settings. Unknown header returns unsupported_format.                                                                                                                                                                                                                |
| Claude / `claude-topic-metadata-v1` | Same registered source and whole-file key.                                                                                                                                                                                         | Compatibility profile for scalar name/description plus metadata.type. If direct type also appears it must agree. Optional metadata.node_type/originSessionId are ignored; neither is shared or treated as a GOAT identity. All other nested objects reject.                                                                                                                                                              | Prior 050 recorded this shape from a home observation; it is **historical, unverified here**, not public-source confirmation. Keep narrowly isolated synthetic fixtures; no broad YAML fallback or claim of current universal compatibility.                                                                                                                                                                                                                              |
| omo / `omo-memory-core-beta63`      | Default `~/.omo/memory/agents/<explicitly selected id>/repo`; pin one HEAD commit. Regular Git Markdown blobs under system/, notes/, people/, reference/, projects/. Whole monthly ledger/observation file, `<relativePath>#body`. | Reproduce first-colon scalar frontmatter: required nonempty description, optional string read_only/kind, JSON string-array aliases; tolerate limit/other scalar fields but do not share them. Reject malformed/ambiguous headers. system/persona.md and identity.md are untrusted data only. Exclude runtime, worktrees, locks, skills, transcripts, jobs, untracked/dirty bytes, symlink blobs and gitlinks.            | Public repo pin `ebfa564862e82cfd1a8c3b45daa4993a40dc7cd6`: `packages/memory-core/src/identity/layout.ts:47–78`, `memfs/frontmatter.ts:22–90`, `compile/compile.ts:25–43`, `recall/provider.ts:25–58`, `facts/person-routing.ts:68–70,112–131`. Current reference checkout HEAD `f83f934325d72d15a85d4a797d7f9a3c0798bf9a` is 4.5.12 without memory-core; do not parse its task/session state as this profile. beta.23 tests in 100 are historical, not WP5 verification. |
| Cursor                              | Unsupported.                                                                                                                                                                                                                       | No supported file profile in MemoryImportFormat and no pinned canonical source contract here; do not scrape settings/session caches.                                                                                                                                                                                                                                                                                     | Import scope is separate from WP4 common-memory delivery.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Grok                                | Unsupported.                                                                                                                                                                                                                       | No researched, pinned provider-native durable memory format in these inputs; ACP delivery does not establish a source importer.                                                                                                                                                                                                                                                                                          | Future profile needs owner contract and fixtures.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OpenCode without omo                | Unsupported.                                                                                                                                                                                                                       | OpenCode sessions/plugin state are not the omo committed memory repository.                                                                                                                                                                                                                                                                                                                                              | omo is a source format, not a new GOAT provider driver.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Antigravity                         | Unsupported.                                                                                                                                                                                                                       | No researched, pinned provider-native memory file contract here; do not infer it from ACP.                                                                                                                                                                                                                                                                                                                               | WP4 delivery remains supported independently.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Other providers/extensions          | Unsupported.                                                                                                                                                                                                                       | MemoryImportFormat accepts only codex/claude/omo; instructions, arbitrary Markdown and conversation archives are outside import.                                                                                                                                                                                                                                                                                         | Adding support requires a new explicit format/profile decision, never a generic fallback.                                                                                                                                                                                                                                                                                                                                                                                 |

Parser versions are explicit constants; known native app version is not in the current import
DTO and must not be invented in provenance. A profile/parser update re-previews under the same
source ID/item key, preserving suppression and accepted history. Never key identity by version,
mtime or Git HEAD. Ambiguous key migration stops with unsupported_format; a deliberate source
registration migration must transfer old aliases/suppression before enabling a new key. A path
or title rename is a new source key, checked against exact-content suppression; rename plus
paraphrase has no semantic erasure guarantee. Oversized whole-file items reject, never truncate.

## 3. Implemented / WP3-provided / WP4-provided / WP5 adds

`S` = `apps/server/src`, `C` = `packages/contracts/src`, `M` = `@goat/contracts`,
`E<A, X>` = `Effect.Effect<A, X>`, `Permit` = repeatable `E<void, MemoryAccessError>`.
Path:line references are at the input branch SHA, or the named frozen plan. All future
signatures below are planned seam definitions, not compile evidence.

| Port / owner state                       | Exact signature / shape and source anchor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | WP5 use or addition                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implemented — binding                    | MemoryService.getProjectBinding(input: M.MemoryProjectBindingGetInput, permit: Permit): E<M.MemoryProjectBinding, MemoryServiceError>; resolveProjectKey(space: M.MemorySpaceId, project: M.ScopedProjectRef): E<M.MemoryProjectKey \| null, MemoryServiceError>. `S/memory/MemoryService.ts:47–58,187–215,281–284`.                                                                                                                                                                                                                                                                                                                                                                  | Use selected readiness space. Capture binding.version and resolved key under live import permit; recheck inside commit. resolveProjectKey internally uses Effect.void, so it is not the authorization boundary.                                                                                  |
| Implemented — transactional operation    | MemoryStore.transact<A,E,R>(effect: Effect.Effect<A,E,R>): Effect.Effect<A,E \| MemoryStorageError,R>; apply(decision: MemoryDecision): E<StoredReceipt, MemoryStorageError \| MemoryStoreConflict>; receipt(space: M.MemorySpaceId, id: M.MemoryOperationId): E<StoredReceipt \| undefined, MemoryStorageError>. `S/memory/MemoryStore.ts:426–439`. MemoryService.upsert(input: M.MemoryUpsertInput, permit: Permit): E<StoredReceipt, MemoryServiceError>, `:67–70,357–399`.                                                                                                                                                                                                        | Extend the parent-aware service's local-intent transaction with import provenance and receipt CAS. Current public upsert builds only environment provenance; calling it then saving provenance/receipt is insufficient.                                                                          |
| Implemented — initial intents            | putLocalIntent(input: Store.LocalMemoryIntent): E<void, MemoryStorageError \| MemoryStoreConflict>; materializeLocalIntent(input: {environmentId: M.EnvironmentId; intentId: string; memorySpaceId: M.MemorySpaceId; operationId: M.MemoryOperationId; revisionId: M.MemoryRevisionId}): E<{operation: M.MemoryOperation; operationDigest: string}, MemoryStorageError \| MemoryStoreConflict>. `S/memory/MemoryStore.ts:93–103,684–703,3506–3572`.                                                                                                                                                                                                                                   | Requires published=1; empty expectedHeads/parents at :3549–3556. Do not use it for changed/aliased items or rewrite its frozen signature. Established-space imports can submit normal parent-aware operations directly through WP3's local pending path.                                         |
| Implemented — receipt storage, not APIs  | 070_Memory source/batch/item columns and unique indexes, `S/persistence/Migrations/070_Memory.ts:173–201,322–324`; memory_import_keys `(space,key_kind,key,memory_id,record_json)`, :260–267. No importProvider or registration/batch/item methods in MemoryService/Store.                                                                                                                                                                                                                                                                                                                                                                                                            | WP5 adds strict private codecs, source/session/batch/item transaction helpers and bounded key lookup. Reuse tables; no direct SQL in reader/parsers/transport.                                                                                                                                   |
| Implemented — suppression primitives     | readSuppressions(space: M.MemorySpaceId, id: M.MemoryId): E<readonly M.MemorySuppressionRecord[], MemoryStorageError>, `S/memory/MemoryStore.ts:641–644`; write/restore suppression `:1416–1424,3332–3345`; forget(input: M.MemoryForgetInput, permit: Permit): E<StoredReceipt, MemoryServiceError>, `S/memory/MemoryService.ts:74–77,433–466`.                                                                                                                                                                                                                                                                                                                                      | Existing forget gathers thread exclusions but imported source keys and content hashes are empty. WP5 must gather durable import aliases/history before forget, use WP3 split-fragment pipeline, and query source/content keys before re-import.                                                  |
| Implemented — quota, scanner, metrics    | MemoryQuotaService.withAdmission<A,E,R>(input: {operation: M.MemoryOperation; admission: Store.MemoryAdmissionContext; environmentId: M.EnvironmentId; receipt?: M.MemoryHubReceipt \| M.MemoryMutationReceipt}, commit: Effect.Effect<A,E,R>): Effect.Effect<A,E \| MemoryStorageError \| MemoryCapacityError,R>; recordStorageSample(environmentId, sharedMetrics?: {walBytes: number \| null}): E<M.MemoryStorageGrowth, MemoryStorageError>, readStorageGrowth(environmentId): same. `S/memory/MemoryQuotaService.ts:13–40`. scanMemoryValue(value: unknown): MemoryScanResult, `S/memory/MemorySecretScanner.ts:32–50`.                                                          | Existing generic operation quotas are not complete import-session/receipt accounting. WP5 adds explicit import counters/reservations and scanner calls for raw/title/header strings; arbitrary field names are not scanned by the contentFields walker. Reuse physical sampling/FTS maintenance. |
| Implemented — wire contracts             | M.MemoryImportProviderInput/Result and Receipt, `C/memory.ts:1559–1718`; WsMemoryImportProviderRpc payload/success/error, `C/rpc.ts:2373–2376`; WsMemoryImportRpcGroup with RpcScopeAuthorization, :2394–2396; compound clientRpcRequiredScopes(method,input), `C/clientRpcPermissions.ts:80–85`.                                                                                                                                                                                                                                                                                                                                                                                     | Consume existing discover/preview/apply/status and dual grants unchanged. Current WsRpcGroup at C/rpc.ts:2294 omits staged memory groups; client guard alone is not server activation.                                                                                                           |
| WP3-provided — readiness/status          | MemorySyncService.readLocalReadiness(): E<{memorySpaceId: M.MemorySpaceId \| null; bootstrap: "unbound" \| "staging" \| "ready"}, MemoryServiceError>; requireBootstrap(space: M.MemorySpaceId): E<void, MemoryServiceError>; syncStatus(input: M.MemorySyncStatusInput, permit: Permit): E<M.MemorySyncStatus, MemoryServiceError>. `030:1184–1186` (§12).                                                                                                                                                                                                                                                                                                                           | Read persisted settings/bootstrap, no network. Absent/staging/mismatched space rejects import with bootstrap_required; already bootstrapped offline submits pendingSync. Status needs an internal authorized read, not an added public memory:read prerequisite.                                 |
| WP3-provided — initial assignment        | listMaterializableIntents(environment: M.EnvironmentId, limit: number): E<readonly Store.LocalMemoryIntent[], MemoryStorageError>; assignIntentIdentityTx(input: {environmentId: M.EnvironmentId; intentId: string; memorySpaceId: M.MemorySpaceId; operationId: M.MemoryOperationId; revisionId: M.MemoryRevisionId}): InTx<AssignedIntent>. `030:331–339` (§4; aliases/error context :110–121; AssignedIntent :144–149).                                                                                                                                                                                                                                                            | Sync owns first assigned IDs and bootstrap sequencing. WP5 neither manufactures a new materializer nor rebinds immutable published space.                                                                                                                                                        |
| WP3-provided — M20 settlement            | receiveHubPage(input: {memorySpaceId: M.MemorySpaceId; hubEnvironmentId: M.EnvironmentId; localEnvironmentId: M.EnvironmentId; expectedSequence: number; page: M.MemoryHubPullResult; reauthorize: E<void,MemoryAccessError>}): E<readonly Settlement[],MemoryServiceError>; settleHubAcknowledgement(input: {memorySpaceId: M.MemorySpaceId; hubEnvironmentId: M.EnvironmentId; localEnvironmentId: M.EnvironmentId; workId: string; receipt: M.MemoryHubReceipt; operation: {operationId: M.MemoryOperationId; operationDigest: string}; reauthorize: E<void,MemoryAccessError>}): E<Settlement,MemoryServiceError>. Settlement is frozen at `030:139–143`; ports at `030:441–457`. | Sync owns canonical receive/ACK and settlement; WP5 hooks accepted import metadata into the same transaction. approvedReplica unions aliases/suppression without local quota/scanner re-admission.                                                                                               |
| WP4-provided — destination command/auth  | Guarded importProvider({ environmentId, input }) where environmentId is M.EnvironmentId and input is M.MemoryImportProviderInput, with permissionAtom requiring memory:write + filesystem:read. `040:319–324,355,423`; existing guard `C/clientRpcPermissions.ts:84–85`. WP4 owns repeatable live permits and core composition.                                                                                                                                                                                                                                                                                                                                                       | Consume in WP6. WP5 does not edit client-runtime or consent UI; destination unavailable never falls back locally. Recheck both grants after every wait and SQL lock.                                                                                                                             |
| WP5 adds — public service and activation | MemoryService.importProvider(input: M.MemoryImportProviderInput, permit: Permit): E<M.MemoryImportProviderResult, MemoryServiceError \| M.MemoryImportRpcError>. Proposed addition to existing `S/memory/MemoryService.ts:44–129`; compound transport grant maps to live Permit.                                                                                                                                                                                                                                                                                                                                                                                                      | Implement reader/parsers/coordinator and transaction helpers below; activate server import group, thin handler, scope declaration and capability together after dependencies exist.                                                                                                              |

Before B, re-anchor on the **merged WP3 implementation SHA and then WP4 implementation SHA**,
record their exact hashes, compare §4/§12 and 040 handoff, and confirm source interfaces and
canonical settlement behavior. Their absence blocks B, not this requested P artifact. Never
claim WP3/WP4 functionality has been tested by inspecting these plans.

## 4. Bounded read-only flow, identity and settlement

### 4.1 Actions, roots and snapshots

All four actions require memory:write **and** filesystem:read at the destination. Discover
uses input.memorySpaceId and format; preview uses sourceId and returns a server sessionId;
apply supplies space/source/session/batch operationId and 1–32 selectors
`{sourceItemKey, sourceFingerprint, scope, project?}`; status takes space and operationId.
No body preview, caller path, free-form parserVersion, start/cancel job or new wire field.
Results obey 64-KiB encoded limit as well as item counts (`C/memory.ts:1683–1716`).

The reader registers an opaque UUID sourceId once per `(space, environment, format, trusted
logical root slot, selected Claude directory/omo agent)`. Persist registration in the source
arm of memory_import_receipts; paths stay server-local. Display labels and item selectors are
scanner-checked, bounded metadata without home paths. Provider settings/CLI are never used to
resolve identity. Changing trusted root requires explicit registration migration preserving
source IDs/suppression, not minting a new ID to bypass forget.

Filesystem reader: reject symlink roots/ancestors/final files, escapes and nonregular files;
open read-only with no-follow and descriptor identity checks, bounded reads, strict UTF-8 and
restat. Detect identity/size/mtime change during read as source_changed. On platforms without a
safe no-follow/ancestor check, fail path_rejected rather than silently follow a link. If Effect
filesystem cannot provide descriptor safety, inject a narrow Node read-only adapter inside
MemoryImportReader only. No provider-side temp file, lock, chmod, mkdir or write capability.

omo reader: use existing VcsProcess.run argument vectors (`S/vcs/VcsProcess.ts:23–55`),
`GIT_OPTIONAL_LOCKS=0`, no shell. Resolve HEAD^{commit} once, bounded `ls-tree -rz --full-tree`
on that OID, then size-check/read regular blobs by object ID with cat-file. Only modes
100644/100755 and approved paths qualify. Gitlink/120000 rejects; dirty/untracked content is
ignored. HEAD moves cannot mix commits. No fetch, status/index refresh, checkout, hooks,
worktree, add/commit or provider process. Timeout/output truncation/absent objects return a
bounded issue, never empty success; do not serialize stderr or filesystem causes.

Reader-local hard ceilings: 128 discovered roots, 512 visited entries per selected root
(including excluded entries), depth 8 and relative selector <=512 UTF-8 bytes; 256 KiB per
file/blob; 8 MiB aggregate source bytes; 128 preview candidates; title <=256 Unicode code
points. Omo tree output also has an 8-MiB cap independent of approved blobs. Codex's large
handbook can therefore be refused explicitly; never read an unbounded file just to decide it
is too large. Count before retaining; +1 yields limit_exceeded and a narrower-source request,
not a seemingly complete partial enumeration. Request output encoding can reach its cap before
128 items; reject a complete oversized preview rather than silently drop rows. Pure parsers
never perform I/O, SQL, time/randomness, includes, fetches, link traversal or model extraction.

Scan every raw allowlisted file and human-readable header/title/key before returning metadata;
then scan normalized accepted payload. The current scanner only recognizes its configured
patterns and content fields: a detected secret blocks the item/file, but this is not a claim
of complete secret detection. Blocked/suppressed preview rows omit title as required by
`C/memory.ts:1625–1640`; no rejected raw content appears in receipts/logs/errors/model input.

### 4.2 Sessions, replay and changes

`sourceItemKey` is stable within the parser profile. Receipt identity is
`(memorySpaceId, environmentId, sourceId, sourceItemKey)` as in 070's item index, **not** an
invented SQL key containing format/locator. sourceLocator/format are registered provenance.
`sourceFingerprint = SHA256(parserVersion + canonical allowlisted title/body/metadata)`;
`contentFingerprint = SHA256(NFC(body).replace(CRLF, LF).trim())`. No case-fold/NFKC/semantic
matching. Exact-copy lookup includes space, scope and assertion kind. Live matches also compare
retained canonical bodies; forgotten hash matches suppress conservatively. Hashes are not a
privacy guarantee and are not exposed as searchable text.

Persist a bounded source registration/session envelope in existing registration_json: active
server session ID, source/profile/snapshot digest, creation/expiry, applied item charges and
session counters; no raw bytes. Session ID <=64 bytes as required by apply/receipt; one current
session per source, expiry bounded by MEMORY_DERIVED_CACHE_TTL_MS. Re-preview replaces transient
bytes only, never historical item identity/accepted parent. The same snapshot's source session
must span its 32-item chunks; concurrent callers use CAS. New session/source registrations
still face cumulative metadata/source/live admission, so chunk/session splitting cannot reset
M19. No persistent raw snapshot archive; staged bytes share
MEMORY_CHECKPOINT_STAGING_MAX_BYTES and expire/purge on forget. Prefer re-read to disk caching.

First validate batch `(space, environment, operationId)` and canonical selection digest
including source/session/fingerprints/scopes/projects, **before source I/O**. Same digest returns
stored completed outcomes/IDs; changed digest yields operation_id_reused without reading files.
A partial exact retry processes only unfinished selectors. Stable per-item operation/revision
IDs are assigned/persisted before first submission; uncertain retries preserve identical bytes.
Batch completed_items_json carries a versioned strict envelope of compact selectors/outcomes,
remaining count and session totals; no request body. Item receipt keeps accepted source hash,
accepted content hash history, accepted revision, original scope and separate rejected hash.
Never advance accepted fingerprint/parent for malformed, secret or failed observations.

Detailed batch results expire under MEMORY_IMPORT_BATCH_RETENTION_MS; keep a bounded compact
operation-ID/digest reuse guard charged to existing receipt/permanent-metadata budgets. Retired
batch exact retry/status returns a typed not_found through existing MemoryRpcError, never
reruns import; changed digest still rejects. Source/item/suppression identity remains permanent.
Prove the compact codec maximum (MEMORY_COMPACT_RECEIPT_MAX_BYTES), or amend with the owning
contract phase before B; a fabricated expiry issue/action is not acceptable. Status reads only
persisted receipt and internal sync status, no source, no resume. New/pending/hub rejected/local
held are reported by syncStatus; an import item locally created is not proof of hub approval.
WP6 cancel stops future chunk calls; an admitted call may commit, with no rollback promise.

Apply re-reads a coherent snapshot, validates the session/profile/fingerprint and caller scope,
then commits selected items serially in independent transactions. File removal/unsupported
layout returns an issue; it never means GOAT forget. Source_changed leaves prior accepted item
untouched and requires re-preview. Git commit is an observation only; unchanged selected
content at a new HEAD remains noop.

### 4.3 Scope, provenance, suppression and M20

User explicitly selects user/project/thread scope. Project scope requires destination-local
ScopedProjectRef, live getProjectBinding permit, `resolveProjectKey(readinessSpace, project)`,
non-null matching scope key and captured binding.version. Recheck project existence/key/version
under the transaction; drift returns mapping_changed without receipt/head mutation. Current
remote URL, Codex applies_to.cwd, encoded Claude dirname and omo auto-agent cwd hash are hints
only. Thread scope requires a real authorized nondeleted ScopedThreadRef in the destination;
provider UUID/session IDs are never GOAT ThreadId. No binding change migrates old receipts.

Create MemoryPayload evidence `{origin: "import", importSourceId, messageIds: []}` and revision
assertionKind inference. Provenance is `{environmentId, importSource: {sourceId, format,
parserVersion, sourceLocator, sourceItemKey, sourceFingerprint, contentFingerprint,
sourceAliases, acceptedContentFingerprints, commitOid?}}` (`C/memory.ts:334–405`). Actual known
Codex/Claude provider can be recorded; omo uses importSource.format, not a fabricated driver.
Do not guess providerInstanceId/model/appVersion or populate sourceThread/watermark from a
provider transcript. Absolute source paths, raw headers and opaque foreign session values are
not shared. Links in imported text stay data; never execute system/persona or Markdown commands.

Under the existing Store.transact, reauthorize both grants after lock, verify readiness/space,
scope/binding, receipt/session CAS, tombstone/pending forget and source/content suppression;
reserve import metadata/session/local queue charges; persist source/item/batch outcomes and
ordinary local intent/outbox atomically. Source/process/network I/O finishes before SQL.
Use existing parent-aware service operation preparation, scanner and decider; do not call
public upsert followed by a separate receipt save. After commit, existing worker/sync owns
submission, hub-only admission, canonical settlement and indexing. No second SQL connection,
ManagedRuntime, generation worker, hub or import network protocol.

| Atomic condition / activation                                                                                       | Required result                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source key, accepted historical content hash, confirmed alias or target tombstone suppressed; pending forget exists | Suppressed metadata-only result (or hold/reject for pending forget), no readable payload, revision resurrection or content outbox. Fresh suppressed alias metadata itself needs bounded local/hub admission.                                                                                                                                                                               |
| Same source receipt mapped to different scope                                                                       | rejected + mapping_changed; keep accepted scope/revision. Explicit re-remember is a separate operation; never clear suppression.                                                                                                                                                                                                                                                           |
| Same source hash and live accepted/pending item                                                                     | noop; no new identity, history, FTS work or session charge. Return current settlement state.                                                                                                                                                                                                                                                                                               |
| New source, exact same live body/scope/assertion, single nonquarantined head                                        | aliased; one memory, union provenance revision with that head as parent, bounded new alias admission, both receipts updated after settlement.                                                                                                                                                                                                                                              |
| New source without copy                                                                                             | created local intent with stable memory/operation/revision identity, pendingSync until hub settles.                                                                                                                                                                                                                                                                                        |
| Same source changed                                                                                                 | revised local intent, same MemoryId, revision.parents = last accepted receipt revision, expectedHeads = current heads captured/rechecked under the local transaction; manual/remote divergence follows normal DAG/hub frontier logic, never adopts the newest head as its parent. If the accepted base is compacted, retain the intent for explicit review rather than fabricate ancestry. |
| Rejected raw/input/scanner/capacity                                                                                 | Bounded metadata-only issue, capacity dimension/current/limit/reclaimable where applicable. No accepted parent mutation; pre-admission refusal may allocate no row.                                                                                                                                                                                                                        |
| Hub receives any local import, even originating on hub                                                              | HubService admission through 030 §4 admitHubOperationTx; no import bypass or hub-local precommit called approval. Hub rejection settles the same immutable intent/receipt.                                                                                                                                                                                                                 |
| Replica receives hub-approved alias/upsert/forget                                                                   | 030 canonical settlement transaction persists receipt, union keys and cursor, without local admission/scanner veto. Scanner disagreement/FTS brake defers local exposure/index on canonical refs, no duplicate body queue.                                                                                                                                                                 |

The shared MemoryService hub-admission preparation must also run the indexed import source/
content suppression lookup under HubService's transaction, immediately before the pure decider.
A delayed offline proposal created before another environment's forget must be rejected at the
hub even if its local replica has not received that forget yet. This is an L1 MemoryService
change used by the existing 030 admitHubOperationTx path, not only a check in the coordinator.
approvedReplica settlement preserves the already admitted result without rerunning that check;
local read fences still honor a later tombstone.

WP5 extends forget preparation to gather **all durable accepted** imported source keys/aliases
and content fingerprints (including earlier accepted versions, not merely current heads) before
payload purge. Store.firstForgetReservation/reservationForRevisions (:3602–3638) and Quota's
reservedKeys calculation (:378–403) currently gather only thread exclusions; L1 extends both
with the same imported source/content union so first-forget capacity is actually reserved.
Persist accepted imported alias/content history as bounded canonical metadata before detailed
revision compaction, and reconstruct it from approved operation/checkpoint metadata on every
replica. Origin-local batch receipts alone cannot supply another environment's later forget;
no accepted alias/hash may disappear merely because a detailed receipt/revision expires. Thread extraction sourceExclusions remain the existing true thread/watermark/
message codec (`C/memory.ts:348–353`); provider sources use MemorySourceKey, not that codec.
Persist source/content suppression in memory_import_keys with exactly the existing canonical
key encoding/hash used at Store:1416–1424; add indexed lookup by computed key, not whole-store
scan. Permanent keys survive restart, checkpoint install and compaction; no expiry with batch
observations. Local rejected aliases cannot erase existing suppression. A lookup hit on any
registered alias blocks the changed source too, even while provider original text still exists.

If the union exceeds the tombstone's 100-entry wire cap (`C/memory.ts:433–445`), consume WP3's
base-deletion plus body-free forgetExpansion fragments with distinct immutable IDs/digests and
separate pending/rejected/accepted receipts. Preserve reserved first forget and immediate read
fence; excess metadata admission refusal cannot undo base deletion. Re-import consults durable
receipt/tombstone history during pending expansion, never only the first fragment. Approved
replica union is not refused by full local alias/key/work budgets. No semantic forget or source
file deletion claim; source-key and exact-content guarantees are the defined boundary.

### 4.4 M19 budgets and growth measurement

Use exported constants, not parser-specific substitutes (`C/memory.ts:103,116–127,151,167–169`):

| Dimension                             | Ceiling / accounting                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item body / encoded payload           | 16,384 / 65,536 UTF-8 bytes; oversize whole item rejects.                                                                                                                                             |
| Source snapshot / preview / apply     | 8,388,608 bytes / 128 items / 32 items, plus 64-KiB response framing and reader limits in §4.1.                                                                                                       |
| Session                               | 128 new items / 2,097,152 accepted body bytes across chunks; changed replacement also charges retained history/body growth. NOOP does not charge twice.                                               |
| Import live                           | 10,000 items / 67,108,864 body bytes, alongside general user/project/thread/environment/space/live limits.                                                                                            |
| Cumulative identity / alias / content | 50,000 source items / 100,000 aliases / 100,000 content digests; key <=512 and digest <=64 UTF-8 bytes. Count registrations, rejected identities and suppressed aliases where they allocate metadata. |
| Staging / detailed observations       | Shared checkpoint staging 128 MiB; derived cache TTL 10 minutes; batch details 30 days, compact replay guard retained. No raw files indexed or archived.                                              |

WP5's Store/Quota lane implements missing import-specific counters and receipt/session
reservations on top of generic WP2 quota.commit/withAdmission. Local allocations have explicit
admission; hub independently enforces space-global live/history/permanent metadata plus forget
reserve. approvedReplica never reruns those admission checks. Capacity failure returns the
actual dimension, not an empty success or silently truncated batch. CAS prevents simultaneous
imports spending the same remaining quota. Sequential item commits preserve partial outcomes.

Reuse MemoryQuotaService.recordStorageSample/readStorageGrowth and MemoryFtsMaintenance:
measure before/after admitted import and after existing worker drain in CI, with logical live,
history, permanent metadata, FTS indexed/allocated, DB/freelist and WAL metrics where available;
reuse bounded daily samples and 1/7/30-day deltas. No per-item physical SQLite scan or DB-wide
VACUUM/auto_vacuum/max_page_count. FTS warning/brake/resume follows WP2 contracts (96/128/96 MiB),
never canonical admission refusal on replica. Missing dbstat/WAL/baseline stays unavailable,
not zero growth. Repeated noop must show unchanged logical payload/revision/index counts;
changed import shows bounded history, not an additional live identity. Source bytes never
enter FTS/export/report, and forgotten text cannot return through rebuild/held caches.

## 5. Disjoint lanes, file ownership and integration order

This is a future implementation map, **not authorization to edit source in this P run**.
`S/` and `C/` use §3 aliases. Every listed file has one WP5 owner; predecessor changes finish
first. No parser edits a shared service/contract and no integration lane rewrites parser files.

| Lane                     | Exact owned files (NEW / MODIFY)                                                                                                                                                     | Delivered boundary                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 durable import seam   | MODIFY S/memory/MemoryStore.ts, MemoryService.ts, MemoryQuotaService.ts and their three .test.ts files; NEW S/memory/imports/MemoryImportTypes.ts, S/memory/MemoryImport.test.ts.    | Strict private receipt/session codecs, indexed dedup/suppression lookup, CAS and quota reservation; importProvider interface/service delegation; parent-aware intents, settlement metadata and forget extraction/fragments. No reader I/O or second transaction owner. |
| L2 read-only reader      | NEW S/memory/imports/MemoryImportReader.ts, MemoryImportReader.test.ts, MemoryImportFixtures.fixture.ts.                                                                             | Trusted root registration references, descriptor/Git snapshots, hard ceilings, read-only fault fixtures. Consumes L1 types/ports; shared synthetic fixture builder is owned here, not modified by parser lanes.                                                        |
| L3 deterministic parsers | NEW S/memory/imports/CodexMemoryImporter.ts, CodexMemoryImporter.test.ts, ClaudeMemoryImporter.ts, ClaudeMemoryImporter.test.ts, OmoMemoryImporter.ts, OmoMemoryImporter.test.ts.    | Pure supported-profile parsers, routing/evidence exclusions, stable item keys and canonical candidates. No SQL/process/provider configuration.                                                                                                                         |
| L4 coordinator           | NEW S/memory/imports/ProviderMemoryImport.ts, ProviderMemoryImport.test.ts.                                                                                                          | Four action orchestration, raw/title/output scans, profile/session/source-change fences, per-item selection and errors, dependency calls to L1 without direct SQL. L1 owns the new real-store MemoryImport.test.ts and imports this module for integrated cases.       |
| L5 server activation     | MODIFY C/rpc.ts, rpc.test.ts; S/ws.ts, ws.test.ts; S/auth/RpcAuthorization.ts, RpcAuthorization.test.ts; S/environment/ServerEnvironment.ts, ServerEnvironment.test.ts; S/server.ts. | Merge only the staged import group into WP4's live core group; one thin handler, dual-grant scope coverage/live permits and real capability; compose reader once with existing memory layer. No new wire schema/client command/MCP tool/UI.                            |

Integration: merged WP3 and WP4 code → L1 types/service/store seam → L2 and L3 in parallel →
L4 composition → L5 activation → one integrated exact-head CI pass. L1 owns final integration
of its service/test files after L4 lands; L5 owns server composition after all implementation
ports exist. This ordering encodes dependencies, not effort. No new migration, package,
dependency, enum, memory.ts field, client-runtime, provider adapter, mobile/web/desktop UI or
other plan file is currently assigned. If real codecs cannot fit existing storage/framing,
return to the schema owner before B rather than adding an undeclared field/migration.

Planned private additions (L1; fields bound by §4 and encoded only under Store):

```ts
// Proposed non-wire Store ports; all Tx methods require Store.Transaction.
type InTx<A> = Effect.Effect<
  A,
  Store.MemoryStorageError | Store.MemoryStoreConflict | Store.MemoryCapacityError,
  Store.Transaction
>;
readImportRegistrationTx: (
  space: M.MemorySpaceId,
  environment: M.EnvironmentId,
  source: M.MemoryImportSourceId,
) => InTx<ImportRegistration | undefined>;
writeImportRegistrationTx: (input: { next: ImportRegistration; expectedVersion: number | null }) =>
  InTx<ImportRegistration>;
readImportBatchTx: (
  space: M.MemorySpaceId,
  environment: M.EnvironmentId,
  operation: M.MemoryOperationId,
) => InTx<ImportBatch | undefined>;
readImportItemTx: (
  space: M.MemorySpaceId,
  environment: M.EnvironmentId,
  source: M.MemoryImportSourceId,
  key: string,
) => InTx<ImportItem | undefined>;
findImportMatchTx: (input: {
  memorySpaceId: M.MemorySpaceId;
  source: M.MemorySourceKey;
  content: M.MemoryContentSuppression;
}) => InTx<ImportMatch>;
commitImportItemTx: (input: {
  registrationVersion: number;
  batch: ImportBatch;
  previous: ImportItem | null;
  next: ImportItem;
  commitIntent: Effect.Effect<void, MemoryServiceError, Store.Transaction>;
}) => InTx<M.MemoryImportItemResult>;
```

ImportRegistration owns source/profile/locator and bounded active session/CAS version;
ImportBatch owns request digest, immutable selected IDs, outcomes/remaining and counters;
ImportItem owns stable scope/accepted hashes/revision/aliases versus rejected observations;
ImportMatch distinguishes source/content suppression, pending forget and live exact copy.
Their strict codecs live in MemoryImportTypes and are consumed by Store; these are additions,
not WP2 exports. commitImportItemTx runs inside existing transaction journal and charges the
session/receipt allocation before invoking the ordinary local-intent callback. It is not an
approved-replica API. L1 adds separate canonical-settlement receipt update using 030's existing
transaction, not by recursively invoking local import.

Field chain: sourceId/profile/sessionId are created by destination reader/coordinator, encoded
in the existing source registration and RPC result, decoded by existing strict DTO/private
Store codecs, then consumed by WP6 selectors/L4 apply/L1 CAS. Import aliases/content history
are created by L1, encoded in existing MemoryProvenance/receipt arms, decoded on Store reload
and WP3 operation/checkpoint receive, consumed by matching/forget/settlement and WP4 injection.
Private absolute roots never cross the wire; raw snapshot bytes have no persistent codec;
provider app version has no field. Existing format/action/outcome/issue values stay unchanged;
unknown values reject via contracts, not default parser dispatch. New capability creation →
ServerEnvironment descriptor/events → strict capability DTO → WP4 destination availability/
WP6 consumption is tested by L5. Direct generic upserts cannot fabricate import receipts;
no client flag can select approvedReplica or bypass hub admission.

## 6. Focused acceptance — temporary fixtures, PR CI only, NOT RUN

All scenarios use temporary homes, SQLite databases and synthetic repositories. Override roots
and inject FS/Vcs/auth/clock/fault layers; never fall back to process HOME or installed provider
state. Byte hashes, directory inventories, Git refs/index/config and write-call spies before/
after prove fixture sources unchanged, including failure and cancellation paths. No corpus,
settings, credentials, provider network/model call or provider binary is a test dependency.

| Owner / focused file                                                            | Activation scenario → observable requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L2 imports/MemoryImportReader.test.ts                                           | Root/ancestor/file symlink, traversal, Git symlink/gitlink, malformed UTF-8, NUL, missing file/object, file swap during read, Git HEAD move, process timeout/truncation → typed issue/no mixed snapshot, no stderr/path leakage and zero writes. Equality/+1 for roots/visited entries/depth/file/tree/snapshot/preview framing → explicit refusal, bounded reads/allocations.                                                                                                                                                                                                                                                                                                                                                         |
| L3 imports/CodexMemoryImporter.test.ts                                          | Synthetic fenced heading, duplicate NFC title, supported optional applies_to, ad-hoc note, JSONL in .md, summary/raw/rollout/skills links → only allowed units, stable keys; no linked evidence traversal or inferred scope. Oversize task/file rejects rather than slicing/truncating.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| L3 imports/ClaudeMemoryImporter.test.ts                                         | Four direct types and isolated metadata.type compatibility; disagreement, duplicate YAML keys/tags/anchors/nested fields, index/CLAUDE.md/episodes → deterministic profile/issue. Encoded dirname never assigns project; ignored foreign session values absent from provenance.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| L3 imports/OmoMemoryImporter.test.ts                                            | beta63 scalar/quoted headers, aliases JSON, tolerated limit/extra scalars, monthly ledger, persona, dirty/untracked changes, unsupported older checkout → only pinned committed units, instructions remain data, no runtime fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L4 imports/ProviderMemoryImport.test.ts                                         | All actions, no public memory:read requirement on status, changed batch digest before read, expired session, source_changed, raw/header/title secret while normalized text is safe, selected valid item after malformed file → bounded rows/no raw retention, no accepted-parent mutation; status performs no FS/Vcs/apply.                                                                                                                                                                                                                                                                                                                                                                                                            |
| L1 memory/MemoryImport.test.ts + MemoryStore.test.ts                            | Real transactions: unchanged retry/restart no new revision/index work; changed source same ID/receipt parent; manual/remote edit → real conflict; same-scope copy alias, another scope no false alias; rejected observation not accepted hash. Lost response/status/partial retry, compact retired batch, changed operation-ID digest → exact committed IDs or explicit not_found, never reapplication. Deferred-controlled race rollback leaves intent/receipt/session/quota all committed or all absent.                                                                                                                                                                                                                             |
| L1 MemoryService.test.ts + memory/MemoryImport.test.ts                          | Two environments same explicit project key, pinned remote/restart, foreign thread/project, binding or permission revocation during source wait/SQL lock → mapping_changed/authorization denial without receipt mutation, no local fallback. Bootstrap unbound/staging/mismatched space → bootstrap_required; bootstrapped offline → pending, later hub settles. Hub environment follows same local submission path.                                                                                                                                                                                                                                                                                                                    |
| L1 memory/MemoryImport.test.ts                                                  | Import multiple aliases and changed versions, forget, leave original fixture untouched, restart/re-preview/source content change/exact-copy rename → suppressed with no body exposure. >100 suppression entries → actual WP3 base+fragments and separate receipts; pending/rejected expansion does not resurrect; checkpoint/rebuild/compaction and offline third member retain suppression. An offline proposal built before remote forget is rejected by real hub admission even before local catch-up. A different environment forgets an imported item after accepted receipt/revision compaction and retains every accepted alias/hash. True GOAT thread source exclusion remains intact; provider IDs never become sourceThread. |
| L1 MemoryQuotaService.test.ts + memory/MemoryImport.test.ts                     | Equality/+1 and multibyte session/live/source/alias/digest/metadata/history budgets; 32-item chunk split/new session/concurrent reservation; rejected/suppressed new alias → no quota bypass, exact partial receipts. Fill local alias/key/work budgets then receive real hub-approved upsert/alias/forget → full canonical union/receipt/cursor, deferred index only. Scanner disagreement holds approved body without re-admission.                                                                                                                                                                                                                                                                                                  |
| L1 quota/store tests                                                            | Before/after import/drain and repeated noop samples, FTS brake/resume, absent dbstat/WAL/baseline, forget/rebuild → bounded growth and truthful unavailable metrics; no duplicate raw text/history identity/index, forgotten text absent. Use existing maintenance, no new physical sampler per item.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L5 rpc.test.ts, ws.test.ts, RpcAuthorization.test.ts, ServerEnvironment.test.ts | Before activation only WP4 core; after activation discover/preview/apply/status round trips and actual capability. Missing/revoked either grant after wait/lock denies every action; no handler-local bypass, old destination unavailable. Lost WS response status returns persisted partial/completed receipt without source reads.                                                                                                                                                                                                                                                                                                                                                                                                   |

Use Deferred barriers/persisted events and existing MemoryWorker.drain plus WP3 settlement/drain
milestones. If thread orchestration is involved, drain OrchestrationEffectWorkerV2 too. No
sleeps or polling-based success. Measure canonical approval versus local readability separately;
a locally committed item is not a hub approval or physical cleanup proof.

Current CI wiring: `.github/workflows/goat-ci.yml:147–149` runs server package shards;
`apps/server/package.json:24` runs its test suite; `apps/server/vite.config.ts:155–169` uses
nonparallel files and weighted shards, with all new server .test.ts files in scope. Contracts
run at `goat-ci.yml:125–127`. L5 does not edit workflow or claim old r4 static counts apply.
Future targeted static checks belong to changed server/contracts files in PR CI; no local
compiler/linter/test/build command is executed in this authoring. Capture exact PR head,
discovered focused files/case counts and actual logs/steps; cancelled/skipped/toolchain failures
are not passing tests. No local bun/pnpm/vp test, vitest, e2e, repo checks, full build, pnpm,
dependency installation or dev server on this Mac.

## 7. Risks, ownership and reflection handoff

User decisions required: **none**. Explicit selections (source and per-item scope) are ordinary
future product inputs, not a new design approval request. WP6 owns web/desktop/mobile import
screens, settings/command-palette/keybinding reachability, chunk stop/status presentation and
user guidance. WP4 owns common delivery to all six providers, MCP/core auth and guarded
import command. WP3 owns hub bootstrap/materialization, admission/settlement and canonical
receive. WP5 owns read-only source import and server import group/handler/capability activation.
Local/remote/relay/tunnel calls always use selected environment roots; all environments are
equal writers. No new MCP import tool or provider adapter/UI is needed in this phase.

Implementation risks for reflection: complete source/receipt/session private codecs on the
actual WP2 table inventory; parent-aware intent integration without hub-local precommit;
accepted-vs-pending receipt reconciliation; permanent imported alias/content extraction before
forget purge; compact batch guard framing/retention; filesystem no-follow portability and
large Codex/omo ledger refusal; narrow historically observed Claude metadata profile. Each has
an owner and activation case above. None authorizes an undeclared schema change, corpus read,
source rewrite or semantic-erasure promise. Scanner pattern misses, rename+paraphrase and
privileged direct DB edits remain limits; tested service paths are the enforcement surface,
not a guarantee over arbitrary external writers. Root bypasses/profile changes require
migration retaining suppression, not a downgrade of the read-only claim.

Coordinator reflection packet: this input SHA/dependency/dev pins, S01–S15, §2 parser decisions,
§3 actual versus planned ports, L1–L5 ownership, and §6 NOT RUN evidence. Obtain architect
reflection and independent A on this concrete rewrite before B. This bounded planner produced
no architect consultation handle or A result; READY_FOR_REFLECTION does not claim either.
Before B replace future WP3/WP4 references with their real implementation hashes/anchors and
verify private import codecs fit existing public contracts. Source-of-truth target is this
050 and the one 000 WP5 cycle record for P; a future code PR updates structure docs only if a
real module boundary/decision changes, not as an implementation diary.

Authoring verification: only 050 and the new 000 WP5 P record are written. From the installed
formatter checkout `goat-78999bf5`, `vp fmt <both absolute paths>` then
`vp fmt --check <both absolute paths>` cover these exact documents; `git diff --check` checks
the target worktree. Results are recorded in the P handoff/000 record. Runtime tests, typecheck,
lint, source implementation, PR creation and push: NOT RUN. No dependency install is needed.

## Folded revision correspondence

| Previous amendment                    | Current home                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| rev 2 action/receipt ownership        | §3 and §4.1–2: implemented DTO/table versus WP5 private helpers, no cancel job, status without source I/O.                                        |
| reflection r1 / rev 3 project binding | §3 and §4.3: corrected two-argument resolveProjectKey, live permit/version recheck and real scoped identity.                                      |
| audit r1 / rev 4 B2/B4/B7/B8          | §4.3, §5–7: existing decider and hub settlement, limits of claims, current owned-file/CI map instead of historical coverage counts.               |
| M19 / rev 6                           | §4.2/4.4 and §6: source session across chunks, permanent suppression/cumulative admission, bounded staging and measured growth.                   |
| M20 / rev 8                           | §3/4.3–4.4 and §6: every environment submits ordinary intents, hub-only admission, approved replica canonical union with local exposure deferral. |
