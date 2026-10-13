# 050 — WP5: read-only provider memory import

Enforcement limits and claim wording: [000 Enforcement inventory](000_plan.md#enforcement-inventory). Audit r1 rev 4 amendments supersede incompatible rev 2/3 recipes.

- Date: 2026-10-13
- Status: executable implementation plan; implementation and runtime verification NOT RUN.
- Baseline: `goat-si/goat`, `goat/goat-cross-device-provider-memory`, HEAD and local `origin/dev` = `1e2418fafb625604de1eb89250a10d971bcfd0fe`.
- Owns: M17, import application of M3/M4/M5/M7/M18. Decisions and names: [000](000_plan.md#shared-names-all-phase-docs-must-use-these). Proposal details: [001](001_architect_proposal.md), especially lines 249-257. WP0 dispositions override the proposal's old provider-support and hub-location defaults.
- Original phase-author scope: this file only; rev 2 covers the seven allowed plans. No commits, pushes, provider-state writes, servers, tests, or builds on juns-macbook-pro.

## 1. Purpose, inputs, and acceptance

Let a user explicitly import supported Codex, Claude, or omo memories into GOAT without changing the provider's memory files, Git state, settings, or generation behavior. Imported items become normal `MemoryItem` projections with durable source provenance. A second import of unchanged input is a NOOP; changed input proposes a revision of the same `MemoryId`; forgotten items and exact copies remain suppressed. File removal never implies GOAT forget.

This is a bounded, deterministic parser and ingestion phase, not an LLM extraction phase. A file or Codex task group is the supported item unit. Do not split arbitrary paragraphs using a model or pretend every bullet is independently identifiable. All imported assertions are initially `inference`, with evidence origin `import`: a provider's label `fact`, `user`, or `project` does not verify truth in GOAT.

Required predecessor results:

| Owner                           | Consumed result                                                                                                                                                             | Gate before implementation                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WP1](010_wp1_contracts.md)     | `MemoryImportSourceId`, `MemoryScope`, `MemoryProjectKey`, `MemoryProvenance`, `MemoryOperation`, import RPC input/result/error schemas                                     | Consume the settled import-specific schemas in 010; use the Shared names without aliases.                                                           |
| [WP2](020_wp2_store_service.md) | `MemoryService`, `MemoryStore`, `MemorySecretScanner`, `memory_import_receipts`, permanent tombstones, payload purge, transactional receipts/outbox and deterministic drain | Receipt, revision and outbox must share a transaction; source aliases and content suppression survive forget.                                       |
| [WP3](030_wp3_hub_sync.md)      | `memorySpaceId`, joined membership, completed bootstrap, received tombstones, pending-sync operation transport                                                              | A newly joined member cannot import before installing bootstrap; a previously bootstrapped offline member can import with `pendingSync`.            |
| [WP4](040_wp4_mcp_injection.md) | Core RPC authorization, environment-scoped guarded import command factory, actual memory capability; import handler/group activated by WP5                                  | This phase registers the handler calling `MemoryService.importProvider`; require both `memory:write` and `filesystem:read`, including after a wait. |
| Existing server                 | Persisted environment identity, project repository identity and shared SQL client                                                                                           | Source roots belong to the destination environment, never the browser or desktop renderer.                                                          |

Acceptance is the focused CI evidence in section 7. No actual provider corpus is an acceptance fixture. All fixtures are synthetic and run against temporary homes/databases/repositories in goat-ci.

## 2. Evidence and supported formats

GOAT citations below refer to the baseline above. Memory modules do not exist there: source maps and proposed diffs below are changes **after** WP1-WP4, not claims about current functions. Verify predecessor heads and signatures before implementing; resolve a mismatched contract in its owning phase rather than adding compatibility shims.

| Evidence read                                                          | What it establishes                                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/internals/overview.md:3-19,53-71,123-128`                        | Environment owns filesystem; commit intent/receipt/outbox together; external I/O outside the transaction; deterministic worker completion.         |
| `docs/internals/effect-services.md:11-22,40-90,95-116`                 | Extend the domain service; thin transports; `Context.Service`, private `make`, `layer`; dependency injection; bounded errors without raw payloads. |
| `apps/server/src/project/GoatProjectFileLoader.ts:43-54,67-79,100-120` | Actual Effect filesystem/decode service pattern. Its best-effort absent-file fallback is **not** the import error policy.                          |
| `apps/server/src/remoteReports/RemoteReportService.ts:107-142,198-229` | Service interface and transactional dedup/receipt precedent.                                                                                       |
| `packages/contracts/src/environment.ts:293-309,319-329`                | `repositoryGroupingKeyOf` preserves fork identity; `ScopedThreadRef` includes environment.                                                         |
| `apps/server/src/vcs/VcsProcess.ts:23-55,129-143`                      | Existing injected argument-vector process service with timeout/output limit, no shell required.                                                    |
| `apps/server/src/server.ts:239-242`                                    | Shared SQL/settings composition precedent.                                                                                                         |
| Initiative `research/100_omo_memory.md:14-25`                          | Earlier beta.23 investigation; push-only backup is not sync. Past tests there are not evidence for this phase.                                     |
| Initiative `research/110_omo_memory_layer.md:3-22,37-47,53-78`         | Correct target is beta.63 `ebfa564862`; proposed file-canonical GOAT layout there is superseded by WP0's SQLite decision.                          |

Provider source pins are read from local Git without checkout:

- Codex: `/Users/jun/developer/codex/121_openai-codex` at `816fa702ec` (local HEAD observed while authoring). `git show 816fa702ec:codex-rs/memories/write/src/lib.rs`, lines 37-41,112-131, names `rollout_summaries`, `raw_memories.md`, `phase2_workspace_diff.md`, `extensions`, and `memories`. `storage.rs:12-25,57-74,118-133` distinguishes generated raw input and rollout summary metadata. `templates/memories/consolidation.md:119-140,179-190,201-211,235-273` defines handbook task groups, `applies_to`, task evidence links, consolidated sections and the derived `v1` summary. These are pinned source facts, not claims about every installed Codex version.
- Claude: the source corpus `/Users/jun/developer/codex/010_memory-pipeline/10_cc_memory.md:89-138` records `MEMORY.md` as an index and topic frontmatter `name/description/type`, with types `user/feedback/project/reference`. Its referenced deobfuscated `150_claude_code/src` checkout is absent on this host; do not describe it as freshly read. Read-only inspection of actual `~/.claude/projects/*/memory/*.md` confirmed both direct-type and nested `metadata.type` shapes. Record only shape keys, never private values, in this document or fixtures.
- omo: `/Users/jun/developer/codex/172_oh-my-openagent`, **`ebfa564862e82cfd1a8c3b45daa4993a40dc7cd6`**, accessed by `git show` only. `packages/memory-core/src/identity/layout.ts:47-78` defines `agents/<id>/{repo,runtime}`. `compile/compile.ts:25-43,56-69,106-111` reads committed files and separates `system` from external projections. `recall/provider.ts:25-58` pins HEAD and parses Markdown blobs. `memfs/frontmatter.ts:22-39,42-90` requires nonempty `description`, supports string `read_only`, `kind`, JSON-array `aliases`, tolerates `limit`, and preserves extra scalars. `facts/person-routing.ts:68-70,112-131` establishes monthly facts and people observation files. Do not import this source tree itself; it specifies the runtime memory repo format.

Actual Codex structure was read-only inventoried: `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, `rollout_summaries/`, `skills/`, `extensions/`, `.git`. Sample rollout summaries and ad-hoc notes were Markdown on this host. Reject JSONL in a `.md` file; session stores or historical JSONL wrappers are not this parser profile. Never traverse a `rollout_path` or use a provider session UUID as a GOAT `ThreadId`.

### 2.1 Allowlist and item keys

Each parser has a fixed `parserVersion`; a provider app version is provenance when known, not inferred from the path. Unknown layouts return `unsupported_format`, never a generic Markdown fallback.

| Format/profile                        | Allowed content and stable `sourceItemKey`                                                                                                                                                                                                                                                                      | Explicit exclusions                                                                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex` / `codex-handbook-v1`         | Each `# Task Group:` block in root `MEMORY.md`, requiring `scope:`; `applies_to:` optional for observed older handbooks. Key `MEMORY.md#task-group:<NFC title>`. Keep task-local evidence references as opaque local selectors in provenance; do not open linked raw sessions. Duplicate titles fail that file. | `memory_summary.md` is navigation only; `raw_memories.md` and `rollout_summaries/*.md` are backing evidence, not additional imported assertions; `.git`, SQLite, workspace diffs, skills, resources and transcripts excluded. |
| `codex` / `codex-ad-hoc-v1`           | `extensions/ad_hoc/notes/*.md`, a nonempty UTF-8 Markdown note, key `<relativePath>#body`. Scan root handbook and selected notes, but exact copies use one memory and multiple sources.                                                                                                                         | Unknown extensions, `instructions.md`, arbitrary recursive Markdown, or notes with JSONL/transcript envelopes.                                                                                                                |
| `claude` / `claude-topic-v1`          | Regular root-level topic `.md` under one selected `projects/<opaque>/memory/`; scalar `name`, `description`, `type`, type in `user/feedback/project/reference`; nonempty body; key `<relativePath>#body`.                                                                                                       | Root `MEMORY.md` is an index only; `.claude/agent-memory`, session memory, `CLAUDE.md`, rules, settings, arbitrary links, nested `structured/episodes`, symlinks.                                                             |
| `claude` / `claude-topic-metadata-v1` | Same as above, with `metadata.type` instead of direct `type`. Only scalar `metadata.node_type` and `metadata.originSessionId` are optional observations; do not copy their values into shared payload. If both type locations exist they must agree.                                                            | Other nested objects, YAML tags/anchors/aliases, duplicate keys, unsupported types or an empty type.                                                                                                                          |
| `omo` / `omo-memory-core-beta63`      | Selected explicit agent identity's `repo`: regular Git blob `.md` in `system/`, `notes/`, `people/`, `reference/`, `projects/`; mandatory frontmatter `description`, body nonempty. Key `<relativePath>#body`. Whole monthly ledger/observation file is one item.                                               | `runtime/`, skills, transcripts, job state, locks, worktrees, config dumps, root unknown trees, submodules, symlink blobs and untracked/dirty working-tree bytes.                                                             |

The omo tree allowlist is deliberately narrower than its recall reader, which accepts any non-system Markdown. Unknown trees are counted as excluded; a selected unsupported item returns `unsupported_format`. `system/persona.md` and `system/identity.md` may be selected as **untrusted memory data**, never installed as GOAT instructions or executed. `read_only` is source metadata only; GOAT may change its imported copy.

There is no fallback to importing `memory_summary.md` when the Codex handbook is missing. Return `unsupported_format` with a bounded code such as `missing_handbook`; ad-hoc notes can still be explicitly selected. A handbook without `applies_to` needs explicit scope selection. No pathname decoder guesses Claude project identity.

### 2.2 Scope mapping

The caller selects a `MemoryScope` per item, or one explicit batch scope plus per-item overrides. Absence is `scope_unmapped`. Scope suggestions are hints, never authorization or automatic assignment.

- `user`: explicitly selected by the owner. Claude `user/feedback` can suggest it; do not promote all Claude feedback or omo human records to global scope silently.
- `project`: resolve an environment-local `ScopedProjectRef` using the existing project/repository service. Call WP2 resolveProjectKey for the ScopedProjectRef: persisted explicit MemoryProjectKey first, otherwise its pinned repositoryGroupingKeyOf fallback. No remote/no explicit key means `scope_unmapped`. A supplied local ID from another environment is rejected; a supplied shared project key must match the resolved project binding. Do not rewrite the key after remote changes.
- `thread`: require a real `ScopedThreadRef` owned by the destination environment, nondeleted and authorized at preview and commit. Provider thread IDs are evidence labels only. If a project key accompanies the thread, validate that binding against its project. No automatic cross-environment lookup or fallback.
- Codex `applies_to.cwd`, Claude encoded directory names and omo auto-agent cwd hashes can suggest a local mapping, never establish cross-device identity. omo requires an explicitly selected agent id and supported profile; do not execute omo or read its provider configuration to discover identity.
- Changing scope for an existing source receipt is `mapping_changed`. Moving a receipt or re-remembering is a separate explicit user operation, not an import retry. Re-remember creates a new memory through WP2's explicit operation, retaining the old suppression record.

## 3. File change map for the WP5 implementation PR

These are planned changes. Only this roadmap file is written during authoring. `MODIFY (predecessor)` means the named file must already exist from its owning phase. No deletes or provider-adapter edits.

| Exact path                                                       | Action           | Reason                                                                                                                                                        |
| ---------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/memory/imports/MemoryImportReader.ts`           | NEW              | Read-only Effect service: discover bounded sources, register opaque source locators, read UTF-8 snapshots or pinned Git blobs, enforce size/path/type guards. |
| `apps/server/src/memory/imports/MemoryImportTypes.ts`            | NEW              | Internal snapshot/candidate types and parser limits; no public service-shape alias.                                                                           |
| `apps/server/src/memory/imports/CodexMemoryImporter.ts`          | NEW              | Pure handbook/ad-hoc profile parsing; summary/evidence exclusion. Shared name from WP0.                                                                       |
| `apps/server/src/memory/imports/ClaudeMemoryImporter.ts`         | NEW              | Pure topic/direct/nested frontmatter parsing; index exclusion. Shared name from WP0.                                                                          |
| `apps/server/src/memory/imports/OmoMemoryImporter.ts`            | NEW              | Pure beta63 frontmatter parser for committed, allowlisted blobs. Shared name from WP0.                                                                        |
| `apps/server/src/memory/imports/ProviderMemoryImport.ts`         | NEW              | Compose discovery, preview and bounded apply under the existing `MemoryService`; no second transaction owner.                                                 |
| `apps/server/src/memory/MemoryService.ts`                        | MODIFY (WP2/WP4) | Delegate `importProvider` to the coordinator, authorize scope/source access and use the same apply boundary as other writes.                                  |
| `apps/server/src/memory/MemoryStore.ts`                          | MODIFY (WP2)     | Atomic source receipt/alias and revision application; lookup exact-content suppression; receipt reads for retry/status.                                       |
| `apps/server/src/memory/MemoryDecider.ts`                        | MODIFY (WP2)     | Import receipt decision: NOOP/change/conflict/delete-wins; do not replace an existing concurrent head.                                                        |
| `packages/contracts/src/rpc.ts`                                  | MODIFY           | Merge the WP1 WsMemoryImportRpcGroup into the live group only after import service/handler exists; no schema definition.                                      |
| `apps/server/src/ws.ts`                                          | MODIFY           | Register one thin memory.importProvider handler consuming WP1 action/result union.                                                                            |
| `apps/server/src/auth/RpcAuthorization.ts`                       | MODIFY           | Register import scope entry using WP1 dual-grant declaration and WP4 live permit.                                                                             |
| `apps/server/src/environment/ServerEnvironment.ts`               | MODIFY           | Set capabilities.memory.importProvider only with ready parser/service/handler.                                                                                |
| `packages/contracts/src/rpc.test.ts`                             | MODIFY           | Core stays usable before import group activation; complete group exposes all fifteen predeclared schemas.                                                     |
| `apps/server/src/ws.test.ts`                                     | MODIFY           | Round-trip all four import actions; lost response status returns persisted partial/completed receipt.                                                         |
| `apps/server/src/auth/RpcAuthorization.test.ts`                  | MODIFY           | Newly registered import method enforces both grants and post-wait revocation.                                                                                 |
| `apps/server/src/environment/ServerEnvironment.test.ts`          | MODIFY           | importProvider stays false without implementation; ready producer advertises true.                                                                            |
| `apps/server/src/server.ts`                                      | MODIFY           | Compose `MemoryImportReader.layer` once with filesystem, path and `VcsProcess`; provide to existing memory layer.                                             |
| `apps/server/src/memory/imports/MemoryImportReader.test.ts`      | NEW              | Read-only guards, Git pinning, limits, no hidden state changes.                                                                                               |
| `apps/server/src/memory/imports/CodexMemoryImporter.test.ts`     | NEW              | Handbook and synthetic note parsing.                                                                                                                          |
| `apps/server/src/memory/imports/ClaudeMemoryImporter.test.ts`    | NEW              | Both supported frontmatter profiles and index exclusions.                                                                                                     |
| `apps/server/src/memory/imports/OmoMemoryImporter.test.ts`       | NEW              | beta63 grammar, allowlist, inert instructions.                                                                                                                |
| `apps/server/src/memory/MemoryImport.test.ts`                    | NEW              | Real memory service/store integration: receipts, races, scanner, suppression, provenance, scope.                                                              |
| `apps/server/src/memory/imports/MemoryImportFixtures.fixture.ts` | NEW              | In-memory synthetic strings and temp-tree builders; imported by the five test files. No copied corpus or committed Git repo.                                  |

No WP5 migration: WP2 already owns the complete source/batch/item receipt inventory. Refresh actual predecessor code before implementing; a missing earlier column is a WP2 acceptance gap, not a second schema definition here.

No WP5 new contract/client-runtime/UI definitions are planned (RPC group activation below consumes WP1 schemas). WP5 activates the predeclared WsMemoryImportRpcGroup and its handler/server scope entry after implementing the service. Their exact owner paths are in section 8. No DELETE entries: N/A, nothing is removed or moved. No new dependency: server already has `yaml` (`apps/server/package.json:66`); do not import code from the omo repo or `.repos/`.

## 4. Contracts, signatures and change skeletons

### 4.1 Bounded API consumed from WP1

Use [MemoryImportProviderInput/Result](010_wp1_contracts.md#import-rpc-contract-wp1-owner-wp5-producer)
unchanged: discover/preview/apply/status. Apply selects 1..32 opaque keys/fingerprints/scopes
and a stable batch operationId; each accepted item has its own operation ID. No arbitrary paths,
body preview, start/cancel action or import job enum. Required dual grants apply to every action.
A successful apply means bounded local item transactions committed, not hub acknowledgement.

Discover/preview return only scanner-approved bounded metadata. Apply/status return
MemoryImportReceipt partial/completed outcomes and MemorySyncStatus; status reads stored receipt
without reading provider files or committing new items. A missing batch returns not_found.
Per-item parse/mapping/change/secret failures use MemoryImportIssue rows; grant denial uses
EnvironmentAuthorizationError and storage failure stops the call. Permission failure is never
silently converted into an item success. Retry reuses request digest and stored completed rows.

WP6 cancellation stops further chunks; an admitted call may finish. Reconnect uses status or
exact apply retry/re-preview; cancellation never undoes committed items. No durable async cancel
promise is introduced. Populate import evidence/provenance from WP1 metadata schemas only.

### 4.2 Reader and parser skeletons

```ts
// imports/MemoryImportTypes.ts; internal only
export interface MemoryImportSnapshot {
  readonly sourceId: MemoryImportSourceId;
  readonly format: MemoryImportFormat;
  readonly parserVersion: string;
  readonly sourceLocator: string; // opaque environment-local locator, no home path
  readonly commitOid?: string; // observation, excluded from receipt identity
  readonly files: readonly { relativePath: string; bytes: Uint8Array }[];
}
export interface MemoryImportCandidate {
  readonly sourceId: MemoryImportSourceId;
  readonly sourceLocator: string;
  readonly sourceItemKey: string;
  readonly sourceFingerprint: string;
  readonly contentFingerprint: string;
  readonly parserVersion: string;
  readonly title: string;
  readonly body: string;
  readonly assertionKind: "inference";
}

// imports/MemoryImportReader.ts
export class MemoryImportReader extends Context.Service<
  MemoryImportReader,
  {
    readonly discover: (
      format: MemoryImportFormat,
    ) => Effect.Effect<MemoryImportSources, MemoryImportError>;
    readonly snapshot: (
      sourceId: MemoryImportSourceId,
    ) => Effect.Effect<MemoryImportSnapshot, MemoryImportError>;
  }
>()("goat/memory/MemoryImportReader") {}
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  // Resolve immutable configured roots from destination-server configuration.
  // Discover only immediate Claude project/omo agent directories, with limits.
  // Reconstruct stable handles from env + format + registered logical root.
  // snapshot: validate selected handle; read regular files without following links;
  // omo: pin commit, list allowlisted regular blobs, size-check then read by OID.
  return MemoryImportReader.of({ discover, snapshot });
});
export const layer = Layer.effect(MemoryImportReader, make);

// Each named importer exports a consumed pure parser, not a runtime/service.
export const parseCodexMemory: (snapshot: MemoryImportSnapshot) => ParseResult;
export const parseClaudeMemory: (snapshot: MemoryImportSnapshot) => ParseResult;
export const parseOmoMemory: (snapshot: MemoryImportSnapshot) => ParseResult;
// ParseResult = ordered candidates + bounded metadata-only issue rows.
```

Bodies for the three parsers follow these steps:

The coordinator scans each raw allowlisted input before it is parsed or displayed. A rejected file contributes only safe source/key/digest metadata; it is never handed to a model or retained as raw evidence.

1. Decode strictly as UTF-8, reject NUL/JSONL envelope, normalize CRLF to LF for parsing. Preserve provider bytes on disk.
2. Match only section 2.1's profile. Codex splits at root task-group headings outside fenced code blocks, validates unique titles and strips routing-only fields (`scope`, `applies_to`, `rollout_summary_files`, `keywords`, cwd/rollout-path annotations) from the imported assertion body. Source metadata references become opaque local selectors; absolute provider paths are not shared. It imports the task descriptions/consolidated guidance, not full evidence files. Claude parses a YAML document with duplicate-key rejection and forbidden tag/anchor detection before selecting only allowlisted scalar fields. omo reproduces the first-colon scalar grammar and JSON aliases validation; unknown scalar frontmatter is tolerated but never serialized into GOAT.
3. Reject empty/malformed body, ambiguous keys or unsupported nested data. Treat Markdown links and instructions as data; no includes, fetches, command execution or recursive link traversal.
4. Set stable item key; compute fingerprints; emit `assertionKind: "inference"`. Do not infer scope or mutate files in the parser.

Source reading is an Effect dependency; pure parsers do not use `fs`, spawn, SQL, current time or random IDs. Errors follow `Schema.TaggedError` with bounded sourceId/item selector and normalized issue. Retain lower-level cause only internally, with no cause/stderr serialization or logging.

### 4.3 Read-only implementation details

Roots are server-owned: default Codex `~/.codex/memories`, Claude `~/.claude/projects`, omo `~/.omo/memory`. An immutable trusted server-root configuration may replace them for explicit deployment overrides and test layers; a client cannot supply an absolute root. Changes to a root binding require an explicit source registration migration, not a new handle that silently evades receipts.

Persist logical source registrations with receipts in WP2, keyed by environment + format + logical root slot + selected Claude directory/omo agent identity. `MemoryImportSourceId` remains stable across restarts and Git HEAD moves. Raw filesystem paths stay local to the reader. Omo profile and selected explicit identity must accompany registration; dirname alone does not prove an auto-generated identity is shared.

For filesystem sources: validate root/ancestors with no symlink following, require regular final files, check containment, size and file identity, then read through a no-follow descriptor and restat the same descriptor. Reject changed identity/size/mtime as `source_changed`; atomic pathname replacement can leave a coherent old descriptor snapshot, but apply's fingerprint comparison catches a new version. If Effect's filesystem port cannot expose this safely, implement the descriptor read inside this named reader using a narrowly injected Node filesystem adapter; do not place Node I/O in pure helpers. Reject root symlinks rather than resolve them to an arbitrary home. No temporary files in provider directories.

For omo use `VcsProcess.run` with argument vectors and `GIT_OPTIONAL_LOCKS=0`, no shell, hooks, fetch, checkout, worktree, add, commit or index refresh:

```text
git -C <registered-repo> rev-parse --verify HEAD^{commit}    -> fixed commitOid
git -C <registered-repo> ls-tree -rz --full-tree <commitOid> -> mode/type/OID/path
git -C <registered-repo> cat-file -s <blobOid>              -> size guard
git -C <registered-repo> cat-file blob <blobOid>            -> bounded bytes
```

Accept only mode `100644`/`100755`, type `blob`, approved `.md` path. Reject mode `120000` and gitlinks; no filenames interpolated into revision expressions. No commit means `unsupported_format`. HEAD moving while reading does not mix commits: all blobs use the initially pinned OIDs. Missing objects, timeout (30 seconds, existing `VcsProcess` default at lines 57,138) or output truncation are explicit `source_unreadable`/`limit_exceeded`, not empty success. Set read command output caps explicitly; map errors without stderr. Binary-invalid UTF-8 flags (`VcsProcess.ts:43-47`) are checked before parsing.

Parser-local limits in `MemoryImportTypes.ts`: 128 discovered source roots, 512 enumerated files, 256 KiB per file/blob, title <=256 characters. Import memory admission constants come only from WP1: MEMORY_BODY_MAX_UTF8_BYTES, MEMORY_PAYLOAD_MAX_UTF8_BYTES, MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES, MEMORY_IMPORT_PREVIEW_MAX_ITEMS, MEMORY_IMPORT_APPLY_MAX_ITEMS and MEMORY_IMPORT_KEY_MAX_UTF8_BYTES. At a boundary equal to the limit is allowed; the next unit fails. Whole-file item granularity deliberately rejects an oversized ledger rather than truncate facts. Partial enumeration never masquerades as a complete preview: return `limit_exceeded` with counts and ask for a narrower source/selection. These are import limits, separate from WP4's 6,000-character/24-KiB injection limits.

### 4.4 Apply boundary and source receipts

```ts
// imports/ProviderMemoryImport.ts; called by MemoryService, dependencies from Effect
export const importProvider = Effect.fn("MemoryService.importProvider")(function* (
  input: MemoryImportProviderInput,
) {
  yield* authorizeImportAtDestination(); // memory:write AND filesystem:read
  yield* requireEstablishedMemorySpaceAndBootstrap();
  const reader = yield* MemoryImportReader.MemoryImportReader;
  if (input.action === "status") return yield* readBatchReceiptWithSyncStatus(input.operationId);
  if (input.action === "discover") return yield* reader.discover(input.format);
  if (input.action === "apply") yield* checkExistingBatchRetry(input);
  const snapshot = yield* reader.snapshot(input.sourceId);
  const inputChecked = yield* scanInputFilesBeforeParsing(snapshot);
  const parsed = parseByFormat(inputChecked);
  const scanned = yield* scanCandidatesAndSafeMetadata(parsed);
  if (input.action === "preview") return yield* previewWithReceiptStatus(scanned);
  return yield* Effect.forEach(
    input.items,
    Effect.fn(function* (selection) {
      const candidate = requireMatchingFingerprint(scanned, selection);
      const scope = yield* resolveAndAuthorizeScope(selection.scope);
      // Source I/O and input scanning finish BEFORE entering SQL transaction.
      return yield* commitImportedCandidate({
        candidate,
        scope,
        batchOperationId: input.operationId,
      }).pipe(Effect.catchTags({ MemoryImportItemError: metadataOnlyRejectedRow }));
    }),
    { concurrency: 1 },
  );
});
```

Validate/load the batch retry receipt before reading apply files; reject a changed request digest. The skeleton's helper functions also perform this batch comparison and save each outcome atomically with its item result.

The named helpers above are private coordinator functions, not extra services. `commitImportedCandidate` is the existing WP2 apply pipeline extended with an import source argument. Under the same transaction it rechecks caller permission, project/thread existence, membership, tombstone, suppression keys, receipt and heads; scans the accepted payload again; calls the pure decider; writes revision/payload/projection/receipt/outbox together. No provider I/O or network I/O occurs under SQL. Postcommit it signals WP2's existing worker/sync pipeline; do not start another `ManagedRuntime`.

Proposed predecessor extension (the actual baseline has no memory service):

```diff
 // apps/server/src/memory/MemoryService.ts: add the predeclared WP1 import port in WP5.
+ importProvider: ProviderMemoryImport.importProvider,
 // make dependencies also include MemoryImportReader via the application layer.

 // MemoryStore's atomic apply, not a second call after upsert
- apply(operation)
+ apply(operation, { importSource, sourceFingerprint, contentFingerprint,
+   parserVersion, expectedReceiptRevision })
 // same SQL transaction: receipt CAS + tombstone check + event/projection + outbox
```

Receipt identity is `(memorySpaceId, environmentId, format, sourceLocator, sourceItemKey)`. `MemoryImportSourceId` identifies the registered source root; the locator is an opaque value referring back to the origin environment. Absolute home path, cwd, hostname, provider instance/model guesses and Git commit are not identity. A parser version change does not mint a new source identity or clear suppression.

Consume the sole local receipt/table inventory in [WP2 section 3](020_wp2_store_service.md#3-sql-layout-and-commit-boundary):
source registration, batch retry and item arms with their partial unique indexes. WP5 populates
these existing columns through MemoryStore transactions; it adds no physical fields/migration.
Keep canonical accepted digests/source alias/suppression keys durable within hub-global admission;
local alias generation reserves local quota. approvedReplica preserves/union-applies admitted
metadata without local quota or scanner reapproval; only operation fragments are shared, not registration rows.
`sourceFingerprint = SHA256(parserVersion + canonical allowlisted parsed title/body/metadata)`. Do not include mtime, Git commit or mutable path labels. `contentFingerprint = SHA256(NFC(body).replace(CRLF, LF).trim())`; the exact-copy lookup additionally keys by `memorySpaceId`, canonical `MemoryScope` and assertion kind. No lowercase/semantic/NFKC equality: false-positive merging is worse than a visible duplicate. Hash collision candidates require equality of retained canonical bodies while live; a forgotten hash match is suppressed conservatively. Hashes are metadata, not public searchable content or a secrecy guarantee.

| Receipt/head condition, checked atomically in this order                           | Decision and writes                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source identity or exact-content key suppressed, or existing `memoryId` tombstoned | `suppressed`; metadata-only source alias receipt linked to the deleting memory; no payload, revision, resurrection or content-bearing outbox.                                                                                                                                                                                                           |
| Same identity has different mapped scope                                           | `mapping_changed`; leave old receipt and item unchanged.                                                                                                                                                                                                                                                                                                |
| Same identity, same source fingerprint, still live                                 | `noop`; no new revision/event/content outbox. May read current sync status.                                                                                                                                                                                                                                                                             |
| No receipt, same canonical live body in same scope                                 | `aliased`; preserve both sources and map the new receipt to that memory. Emit a normal `upsert` provenance revision with unchanged live payload, parent = its sole current head, and all source aliases; update both receipts to the resulting revision. There is one memory, not two. Only single-head nonquarantined live items qualify for aliasing. |
| No receipt and no exact copy                                                       | `created`; allocate new `MemoryId`, revision and operation, with empty parents.                                                                                                                                                                                                                                                                         |
| Existing receipt, changed fingerprint                                              | `revised` using the receipt's last accepted revision as parent, not whatever current head happens to be. Allocate one new operation/revision; same memoryId. If manual/remote edits advanced heads, the normal DAG decider retains both and returns `conflicted`.                                                                                       |
| A rejected new source                                                              | Metadata-only rejected receipt with issue/fingerprints; memoryId/revision nullable. Changed fingerprint can retry; suppression is permanent and always wins.                                                                                                                                                                                            |

The batch receipt stores only retry key, canonical selection digest and completed-item IDs/outcomes; it retains no request body. `operation_id_reused` does not read input files. Item receipt includes `sourceId`, identity fields, `parserVersion`, last accepted source/content fingerprints, `memoryId`, last accepted revision, original scope, outcome/issue and observed timestamp. Keep rejected observation fingerprint separate from last accepted fingerprint: a malformed/secret-changing source must not advance its parent revision. Source registration rows contain no body. Forget retains receipt/source aliases and all historical accepted content fingerprints, while purging payloads and derived copies. A path rename is a new source item; an exact copy attaches an alias or is suppressed. Rename plus paraphrase is outside exact-source/exact-content forget guarantees; never claim complete semantic forget.

Local live alias creation uses normal upsert provenance revision; local suppressed alias extension uses body-free forget fragment and receipt, retaining first deletion audit. Both local generation paths reserve admission. Once hub approved, remote alias upsert/forget fragments use M20 canonical receive/union despite full local alias/key/work budget; scanner hold delays local exposure/index only. No new operation kind or table replication. Retry/CAS returns committed IDs; no payload duplication or new admission on approved replay.

## 5. Full field and enum chain

No field may exist only in this parser or only in a report. WP1 owns schema codecs; WP2 owns SQL codecs/purge; WP3 owns explicit operation serialization. Every private field is listed with its non-wire reason.

| Field/value                                                                                                           | Creation -> serialization -> decoding -> every consumer                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryImportFormat`: `codex/claude/omo`; `action`: see WP1 MemoryImportProviderInput (including receipt-only status) | WP6 environment command -> WP1 RPC schema -> server RPC decode -> WP4 authorization -> `MemoryService.importProvider` -> reader/profile dispatch. Unsupported format/action fails schema decode; older servers hide capability, never fallback.                                                                                                                                           |
| apply `operationId` and batch request digest                                                                          | WP6 command creates a stable retry key -> WP1 apply schema -> RPC decode -> body-free batch receipt codec -> resume/conflicting-key guard -> per-item apply/results -> reconnect retry. Per-item operations, not the batch key, enter WP3 sync.                                                                                                                                           |
| `sourceId: MemoryImportSourceId`, `sourceLocator`, logical-root slot/profile                                          | Destination reader registration -> `memory_import_receipts` registration codec; opaque handle in RPC result -> WP1 decode -> WP6 selections -> reader stable resolution. Absolute root is local only; wire serialization N/A because exposing another user's host paths is unnecessary.                                                                                                   |
| `sourceItemKey`, `parserVersion`, `sourceFingerprint`                                                                 | Parser -> preview metadata schema -> client selection schema -> server comparison -> receipt SQL codec -> `MemoryProvenance.importSource` explicit encoder -> WP3 operation decoder -> WP2 provenance/history and suppression -> WP4 read responses -> WP6 detail/status. ParserVersion belongs in provenance so remote decoding does not guess grammar.                                  |
| `contentFingerprint`, historical fingerprints, source aliases/suppressedSourceKeys                                    | Parser/transaction -> WP2 receipt and tombstone codecs plus explicit operation metadata -> WP3 push/pull/bootstrap -> WP2 receiver suppression lookup and forget -> subsequent local/remote imports. Not inserted into a prompt or FTS. This chain prevents a different environment/provider copy reviving deleted content.                                                               |
| Resolved `MemoryScope`/`MemoryProjectKey`/`ScopedThreadRef`                                                           | Explicit selection including project ScopedProjectRef + destination resolver -> existing WP1 memory schema -> revision/projection/receipt encode -> WP2 SQL decode -> WP3 operation codec -> scope filters in WP2 search and WP4 snapshots/readSource -> WP6 display. No local-path identity and no provider-session-id casting.                                                          |
| assertionKind inference, evidence import                                                                              | Parser → pre-admission scanner → WP1 payload/operation codec → hub admission → approvedReplica canonical receive with local exposure hold → eligible WP4 context/read and WP6 detail. Replica rescan never discards approval or changes cursor.                                                                                                                                           |
| `created/revised/noop/aliased/suppressed/rejected/conflicted`, issue values in 4.1                                    | Transaction/reader outcome -> WP1 RPC result/error codec + receipt SQL codec where meaningful -> RPC/client decode -> WP6 counts, retry and result reporting. Suppressed/rejected data never reaches memory search/injection; conflict exclusion uses WP2's existing conflict states. Error-only issues need not persist a receipt when reading failed before an item identity was known. |
| `MemoryId`, revision/operation IDs, parents, `MemorySyncStatus`                                                       | WP2 transaction -> existing event/operation/projection/outbox schemas -> SQL and WP3 codec -> receiver decider -> WP4 readers and WP6 status. Never present a local committed receipt as a hub ACK.                                                                                                                                                                                       |
| `commitOid`, raw bytes, filesystem descriptor identity/mtime, parser-only YAML extras                                 | Reader snapshot -> parser/consistency guards only. Shared serialization N/A: not GOAT content/provenance beyond optional safe commit observation; never serialize raw bytes, YAML extras, local root or process output. Commit observation is optional provenance, never identity/dedup.                                                                                                  |
| New auth scope, MCP tool, `memoryContext`, generation operation                                                       | N/A in WP5: WP1/WP4 already own memory scopes/capability and delivery. WP5 activates only the predeclared importProvider flag. Import is deliberately not an agent arbitrary-path MCP tool; no provider generation or adapter change.                                                                                                                                                     |

Local source/preview/import strings are scanned before display/storage/sharing; recognized secrets refuse local admission with metadata only. Already-approved remote alias payload retains canonical content under M20 hold; expose only eligible explicit fields, never frontmatter/Error/raw cause. Missing optional legacy import metadata never authorizes dropping tombstone/approved metadata.

## 6. Branch activation and observable evidence

The following table is the branch checklist. Every row maps to a focused test below; outcomes must be observable through receipts/projections/events or bounded errors, not debug logs containing source bodies.

| Guard or branch                   | Activation scenario                                                                                                      | Observable evidence                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination capability/permission | Old server, no memory grant, no filesystem grant, revoked grant after reader waits                                       | Typed unavailable/auth failure; reader not entered for initial denial; zero accepted transactions after revocation.                                                 |
| Bootstrap gate/offline allowance  | New member has not installed tombstones; existing member loses hub                                                       | `bootstrap_required` with zero reads/commits for new member; existing member commits `pendingSync`, later converges.                                                |
| Path and source handle            | Foreign source handle, symlink root/ancestor/file, `../`, absolute/link target, Git symlink/submodule                    | `path_rejected`; sentinel outside source never read; no provider writes or index refresh.                                                                           |
| Missing/unreadable input          | Root absent, selected note disappeared, permission failure, Git object absent or process failure                         | `source_missing`/`source_unreadable` per selected source/item; no fallback to another root/environment and no GOAT forget.                                          |
| UTF-8/grammar/profile             | Invalid bytes, NUL, JSONL `.md`, duplicate Codex group, unsupported YAML or omo description absent                       | `invalid_utf8`/`unsupported_format`; metadata-only issue, zero accepted body.                                                                                       |
| Limits                            | 256-KiB blob or 64-KiB encoded payload plus one byte, >512 files, >128 roots/items, >8-MiB aggregate, 33 apply selectors | `limit_exceeded`; no truncation/import of partial facts. Equality boundary passes; over-boundary fails.                                                             |
| Preview/apply drift               | Source changes, file identity changes, new parser fingerprint differs after preview                                      | `source_changed`, unchanged old receipt; other selected items continue. Git HEAD change alone keeps pinned snapshot coherent.                                       |
| Mapping                           | No explicit scope, no repository/explicit key, foreign/deleted thread, same receipt new scope                            | `scope_unmapped`/`mapping_changed` or auth failure; no arbitrary global promotion.                                                                                  |
| Secret scanner                    | Credential in YAML description, title or body; safe sibling item                                                         | `secret_detected`, metadata-only rejected receipt; captured logs/errors/RPC/outbox/FTS contain no sentinel; sibling imports.                                        |
| First import/repeat/change        | Fresh source; identical retry; edit retained item key                                                                    | Created once; second run `noop`; third has same memoryId and parent = last accepted source revision.                                                                |
| Alias and forget                  | Same body from Codex and Claude in same scope; forget; reimport either or same body on another member                    | One live item, retained multiple source aliases; permanent suppression records; no new body/revision, empty search/snapshot after forget.                           |
| Different scope/text              | Identical text in distinct project keys; changed case/paraphrase                                                         | Separate items; exact-copy lookup never crosses scopes; semantic guarantees not claimed.                                                                            |
| Concurrent edit/forget            | Manual edit while read is blocked; forget between preview and apply                                                      | Changed import becomes variant/conflict, never overwrites unrelated head; forget wins and suppresses all accepted fingerprints.                                     |
| Crash/parallel retry              | Inject fault before commit, after commit before response; two same-source calls                                          | Precommit rollback includes receipt; postcommit retry is NOOP with same IDs; concurrent unique/CAS yields one accepted revision.                                    |
| Bounded cancellation              | WP6 stops chunking or request interruption between transactions                                                          | Earlier receipts persist; later chunks are not sent; in-flight atomic transaction completes or rolls back, never half-written. Re-preview explains persisted items. |

No automatic retry of malformed formats, secrets or mapping failures; users fix/select input and retry. Transient source/storage errors are explicitly retriable without clearing suppression. No timer/backoff worker is introduced. A failure on one memory cannot stop unrelated memory sync; existing WP2/WP3 own that guarantee.

## 7. Focused tests and verification commands

Write these tests in the paths from section 3. Fixtures contain invented repo names, synthetic note bodies and fake credential sentinels accepted by scanner test-rule policy; never copy a user's memory text. Temp Git commits are CI-only fixture construction, not provider-repo mutations. Read-only proof covers contents, index/ref/config bytes and filesystem calls, rather than treating access-time updates as content changes.

| Test file                              | Exact case name                                                                     | Assertion                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `imports/CodexMemoryImporter.test.ts`  | `imports handbook groups and ignores derived summary and backing evidence`          | One candidate/group; no summary/raw/rollout assertions; references inert.                                                    |
| same                                   | `accepts legacy scope header only with explicit mapping`                            | Missing applies_to preserves mapping requirement; does not infer global scope.                                               |
| same                                   | `imports ad hoc notes and rejects unknown extensions and jsonl`                     | Correct allowlist/key; metadata-only unsupported rows.                                                                       |
| same                                   | `keeps a group key stable across body edits and rejects duplicate titles`           | Same key, changed fingerprint; duplicate heading is error.                                                                   |
| `imports/ClaudeMemoryImporter.test.ts` | `imports direct and metadata type profiles without importing the index`             | Both topic shapes; index contributes zero candidates.                                                                        |
| same                                   | `rejects disagreeing types duplicate keys aliases and unknown nested fields`        | Each rejected grammar branch explicitly checked.                                                                             |
| same                                   | `does not derive project identity from the encoded directory`                       | Scope required regardless of plausible directory spelling.                                                                   |
| `imports/OmoMemoryImporter.test.ts`    | `parses beta63 descriptions quoted scalars and json aliases`                        | Pinned grammar parity; read_only not coerced into GOAT permission.                                                           |
| same                                   | `treats system instructions as data and imports a ledger as one item`               | No instruction execution; stable file key for updated monthly body.                                                          |
| same                                   | `rejects missing description and excludes skills runtime and unknown trees`         | No hidden fallback; selected unsupported files report issue.                                                                 |
| `imports/MemoryImportReader.test.ts`   | `reads only regular contained files and rejects unsafe handles and symlinks`        | Spy outside-root reader never called; root/ancestor/final-link cases.                                                        |
| same                                   | `pins omo commit and ignores dirty untracked and later head bytes`                  | Real temp Git repo; all candidates from one commit; index/refs/config unchanged by reader.                                   |
| same                                   | `reports missing unreadable and invalid utf8 sources without fallback`              | Error codes discriminate absence from access failure; no alternate root.                                                     |
| same                                   | `enforces all import limits without truncation`                                     | Parameterized equality/+1 cases for every limit in 4.3.                                                                      |
| same                                   | `rejects changed file identity and changed preview fingerprint`                     | Injected descriptor barrier and replacement; no stale apply.                                                                 |
| `memory/MemoryImport.test.ts`          | `commits receipt revision projection and outbox atomically`                         | Real temp SQL store; before-commit fail leaves none, postcommit-response fail retains all.                                   |
| same                                   | `repeats as noop and revises the existing memory after source change`               | IDs/counts/parents and outbox cardinality, not just result label.                                                            |
| same                                   | `serializes concurrent same source retries to one revision`                         | Deferred barriers, one receipt and accepted revision; batch key reuse with altered request is rejected before reads.         |
| same                                   | `aliases exact copies within scope and preserves every source through sync`         | Two formats, one item, alias metadata reaches second environment.                                                            |
| same                                   | `suppresses forgotten sources changed versions and copied content after bootstrap`  | Forget after several accepted versions; each prior digest and alias suppressed on third member; payload/FTS/snapshot purged. |
| same                                   | `never forgets goat memory when a provider file disappears`                         | Existing item/history retained, source_missing visible.                                                                      |
| same                                   | `quarantines a changed import racing a manual revision`                             | DAG has both heads; only that memory excluded from search; sibling remains available.                                        |
| same                                   | `rechecks tombstone and permissions after source reads wait`                        | Deferred barrier, forget/revoke then resume: no new payload/revision.                                                        |
| same                                   | `rejects secrets before preview commit logs and sync while importing safe siblings` | Known fake secret sentinel absent from RPC/error/log/storage/outbox/FTS captures.                                            |
| same                                   | `rejects missing or changed scope and foreign or deleted thread bindings`           | All mapping branches leave receipts/heads unchanged.                                                                         |
| same                                   | `requires initial bootstrap but permits bootstrapped offline pending imports`       | Typed new-member failure; old member pendingSync then converges.                                                             |
| same                                   | `preserves committed chunks when a caller stops further import requests`            | Re-preview reports prior receipt outcomes; no implicit rollback or duplicated revisions.                                     |
| same                                   | `leaves every synthetic provider file and git state unchanged`                      | Before/after byte hashes + write-call spy for all three formats; provider settings untouched.                                |

`same` paths are the preceding fully named test path under `apps/server/src/memory/`. Use real service logic and test layers only for filesystem/process/auth/fault signals. Subscribe to the persisted event before dispatch; use `Deferred.await` barriers for controlled races. After accepted operations, await `MemoryWorker.drain` and the WP3 sync drain/persisted receipt. If the fixture dispatches thread orchestration, also drain `OrchestrationEffectWorkerV2.drain`. Pure parser/reader tests await the effect return. No sleeps, timeout-based success, random polling, provider network calls or real-home fallback.

### 7.1 Local static checks only (implementation phase)

From the repository root, after predecessor contracts and WP5 code exist:

```sh
vp exec tsc --noEmit -p apps/server/tsconfig.json
vp exec tsc --noEmit -p packages/contracts/tsconfig.json
vp lint apps/server/src/memory apps/server/src/server.ts apps/server/src/ws.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/environment/ServerEnvironment.ts packages/contracts/src/rpc.ts packages/contracts/src/rpc.test.ts apps/server/src/ws.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/environment/ServerEnvironment.test.ts
```

- Typecheck coverage: explicit `-p apps/server/tsconfig.json`; `apps/server/tsconfig.json:7` includes `src`, so every new reader/parser/integration test and modified service/server source is read. Base `tsconfig.base.json:6-13` sets noEmit/strict options; `apps/server/package.json:23` alternatively exposes package `typecheck` as `tsc-rs --noEmit`. Compiler may resolve imported contracts/shared packages, but no recursive workspace check is invoked.
- Lint coverage: explicit `apps/server/src/memory` directory plus `apps/server/src/server.ts`; root `vite.config.ts:109-125` has no memory/server exclusion and loads the repo plugin. `vp lint` is source lint, not Markdown verification. Do not claim it validates this document or future contract fields that are not yet written.
- WP1 owns these schema checks; its static check is `vp exec tsc --noEmit -p packages/contracts/tsconfig.json` and `vp lint packages/contracts/src/memory.ts packages/contracts/src/memory.test.ts`; the explicit paths and `packages/contracts/tsconfig.json:4` (`include: ["src"]`) cover those schemas. Those commands are **not** extra WP5 checks unless WP5 actually changes contracts.

No `bun/pnpm/vp test`, vitest, e2e, full build, `vp check`, recursive checks or server launch here. This host policy overrides generic AGENTS verification defaults. This documentation-only authoring does not execute package typechecks/lint against unchanged code. Authoring-only checks: `git diff --no-index --check /dev/null devlog/_plan/261013_goat_memory/050_wp5_provider_import.md` and a Python structure check of this file (required sections, balanced fences, Shared names and command text); neither runs tests nor establishes implementation correctness.

### 7.2 Test evidence: PR CI only

PR CI **goat-ci** owns execution of the five focused files. `.github/workflows/goat-ci.yml:130-132` runs server tests via `vp run --filter goat test --shard ...`; `apps/server/package.json:24` is `vp test run`, `apps/server/vite.config.ts:155-166` configures deterministic nonparallel files and setup, and root `vite.config.ts:58-67` does not exclude `src/memory/*.test.ts`. WP1 round trips run in `test-contracts` (`goat-ci.yml:109-110`). New tests therefore land in the real package suite/shards; no workflow edit or unexecuted standalone test list is the proof.

Record PR URL, exact head SHA, all relevant shard terminal conclusions and focused case counts from CI logs. Cancelled/skipped CI is not a pass. Check that all newly added files were discovered, not merely that the job went green. CI uses temp provider homes with test layers; never configure its fixtures to use real installed memory. This plan records no CI success.

## 8. Settled phase boundaries

| Owner            | Assigned implementation / WP5 consumption                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP1              | Sole import wire owner, source/provenance/suppression metadata, bounded action/result/issue schemas and dual grants. Consume those exported schemas; no MemoryImportInput alias.                     |
| WP2              | Sole receipt/table/migration owner; source/batch/item atomic helpers, suppression/alias history and report metadata already created. WP5 never writes tables through a separate connection.          |
| WP3              | Established bootstrap guard and tombstone/import-provenance propagation before import. Previously bootstrapped offline apply remains pendingSync.                                                    |
| WP4              | Guarded import command factory and live permit/auth infrastructure; no stub import handler or availability advertised yet.                                                                           |
| WP5 (this phase) | Parser/coordinator plus receipt-only status; register import group/handler/server scope and capability using WP1 definitions after implementation.                                                   |
| WP6              | Explicit source/profile and per-item scopes; 32-item chunks, stop subsequent calls for cancel, show persisted partial outcomes via status/re-preview. No in-flight rollback or durable cancel claim. |

WP2 owns scanner/DAG/generation; WP3 owns hub-only SQL; WP4 owns six-provider delivery and MCP;
WP6 owns clients/docs/report adapter. No late wire/table contract request remains.

## 9. Implementation PR title and body

Title: `feat(memory): import provider memories without changing their sources`

Body outline:

> Provider memories currently stay in separate local stores. Add explicit, read-only Codex, Claude and committed omo imports through MemoryService with per-item scope selection and source provenance.
>
> Repeated sources are NOOPs, changed sources revise the existing memory, and tombstones suppress remembered sources and exact copies. Parsers read allowlisted formats, scan before storing/sharing, and keep provider bytes and settings unchanged. Import remains bounded and reports partial outcomes explicitly.
>
> Validation: targeted server typecheck/lint (commands and exit codes); exact-head goat-ci focused fixture evidence, including races, rollback, secret rejection, bootstrap and read-only byte checks. Tests were not run on juns-macbook-pro. No UI changes in this PR; WP6 owns the client surface.
>
> Model and harness: record the actual implementation runtime. This roadmap was authored by gpt-6.1-sol through the Codex harness in GOAT.

This is a future implementation PR brief, not authorization to create a PR or commit this plan. Follow WP0 stack ordering when authorized; do not merge or push protected branches.

## 10. Non-goals, traps and completion record

- No export/write-back, provider memory disablement, credentials/settings reads, provider CLI launch, Git backup mirroring, automatic import watcher, LLM parsing, semantic dedup or semantic erasure claim.
- No raw sessions, SQLite provider internals, rollout JSONL, unknown Codex extension resources, Claude nested episode trees or omo runtime/worktree ingestion. Markdown extension alone is not support.
- No broad recursive home scan. Remote/hosted-web/mobile callers operate on the selected server's memory roots. An unavailable destination cannot switch to the client home or another connected environment.
- No stable identity from content hash alone, mtime, absolute cwd, provider UUID or current Git SHA. Path/title rename plus content change cannot be reliably linked without a native stable item ID; show the new candidate and apply exact-source/content suppression, without promising alias inference.
- No replacing a concurrently edited GOAT item with a changed provider file; use the receipt revision as parent so WP2 exposes the real conflict.
- No receipt written after an already committed upsert, no raw rejected body retained for debugging, no scanner bypass on sync/alias paths. A rejected fingerprint is not an accepted parent.
- No inferred forget when a source disappears, is archived, or becomes unsupported. Minimal tombstones, aliases and historical accepted fingerprints remain indefinitely per M5.
- Source fingerprints observe content, not validity or verified truth. Git committed content is a consistent snapshot, not trusted instructions. Imported inference still needs evidence and review before a separate GOAT edit promotes it.
- Do not broaden this plan to other providers: Codex/Claude/omo import is distinct from six-provider common memory delivery and generation, which remain mandatory in their owning phases.

Completion record for authoring: the single requested English roadmap exists; baseline and cited source shapes inspected read-only; no implementation/test/build/server/commit/push performed. Implementation completion requires settled predecessor contracts implemented, all section 6 branches covered by the named tests, targeted static checks passing and exact-head goat-ci evidence. Do not label this phase DONE from document creation alone.

Status accepts operationId, returns the persisted MemoryImportReceipt without source reads,
and never resumes apply. Source/batch/item writes use only the WP2 inventory; rejected issue
observations do not overwrite accepted fingerprint/revision. Add focused status-after-lost-
response and core/import group activation tests to existing server/contract test files in
this phase; local verification remains document/static-only on this Mac.

## Cross-phase contract reconciliation (rev 2)

Uses WP1 discover/preview/apply/status schemas and WP2 sole receipt inventory. Activates the predeclared import RPC/capability only here; cancellation stops subsequent chunks and status reads durable receipts without source I/O.

## Reflection r1 fixes (rev 3)

G1 consumes the new earlier binding producer; import does not own another project map.

| Action              | Exact path                                             | Diff to implement                                                                                                |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| MODIFY (NEW in WP5) | apps/server/src/memory/imports/ProviderMemoryImport.ts | Replace free-form/current-remote project key derivation with WP2 resolveProjectKey and captured binding version. |
| MODIFY (NEW in WP5) | apps/server/src/memory/MemoryImport.test.ts            | Two-environment explicit mapping, remote change/restart and preview-to-commit binding race.                      |

```diff
 // preview/apply scope validation
-const key = explicitKey ?? repositoryGroupingKeyOf(currentRemote);
+const project = selection.project; // WP1 apply selector, required for project scope
+const binding = yield* memory.getProjectBinding({ memorySpaceId, project }, importMemoryWritePermit);
+// Existing WP2 service get; result is the WP1 MemoryProjectBinding, not a new wire DTO
+const key = yield* memory.resolveProjectKey(project);
+// Capture binding.version; repeat key/version/existence validation in item transaction.
```

The binding get uses the existing earlier service method and a repeatable live memory:write
permit; no second map or permission bypass. Import already requires
memory:write plus filesystem:read. An apply scope must equal the server-resolved key. No explicit
key and no pinned repositoryKey returns scope_unmapped. A changed key since preview is rejected by scope-vs-binding validation; a binding change between apply source read
and item commit returns mapping_changed and leaves accepted receipt scope/heads untouched.
Changing a project binding does not migrate existing source receipts. A fresh explicit memory
is required for a deliberate new scope; retry cannot evade suppression.

Chain: WP6 binding picker → WP4 guarded command → WP1 input/SQL binding codec → WP2 persisted
view → WP5 apply/version capture → strict MemoryScope/receipt encode → transaction recheck →
WP3 shared operation → WP4 snapshot. Local ScopedProjectRef is never synchronized.

Activation/CI cases in apps/server/src/memory/MemoryImport.test.ts: `two environments import
project sources under the same explicit binding`; `remote change and restart retain import
project key`; `binding change while source read waits returns mapping_changed without receipt
mutation`; `use repository does not reassign existing source receipts`. Use Deferred and real
store transactions; run existing server shards in PR CI only. G3 import cache purge follows
WP4 signals and WP6 view cleanup; no provider source is deleted or changed.

## Audit r1 fixes (rev 4)

B2/B4: import conflict commits use WP2’s same transactional claim candidate and approved-replica
merge paths; import does not directly start generation or bypass hub CAS. B7:
[Enforcement inventory](000_plan.md#enforcement-inventory) bounds scanner/suppression claims.
B8: the final change map is reconciled with static commands below; no parser, contract, runtime
or test execution is claimed by this documentation change.

### B8 — mechanical static-input coverage receipt

Final NEW/MODIFY map (including rev 2/3/4 additions): **24 TS/TSX paths**.
Compared path equality/explicit-directory ancestry against every `vp lint` argument and
package ownership against explicit `-p` / exact package-filter typecheck commands: **0 uncovered
lint targets, 0 uncovered typecheck targets** after declared generated-file exclusions.
Typecheck owners: `apps/server/tsconfig.json`, `packages/contracts/tsconfig.json`.
This is path/config reconciliation, not successful compiler/linter execution. Workflow YAML,
package manifests and prose are outside TS lint; review their diffs and validate in CI. At phase P
repeat with the actual diff, compiler file collection and lint ignores; an exit 0 without target
collection is insufficient. Authoring uses Python text checks only; no installation/check runner.

## Requirement 7 / M19 (rev 6)

Keep MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES, MEMORY_IMPORT_PREVIEW_MAX_ITEMS and
MEMORY_IMPORT_APPLY_MAX_ITEMS; additionally enforce MEMORY_IMPORT_SESSION_MAX_NEW_ITEMS and
MEMORY_IMPORT_SESSION_MAX_BODY_BYTES across every chunk in one source snapshot/session.
WP1 adds opaque sessionId to preview/apply receipt and bounded session counters; WP2 persists
session ownership/first fingerprint and counters in the batch receipt codec before WP5 uses
it. Accepted local NOOP does not re-charge; local replacement consumes history and session/cumulative identity/alias/digest budgets. Splitting chunks/session IDs cannot reset local/space admission counters. Hub applies space-global metadata/live limits and forget reserve. WP2 unique keys/compact guards retain permanent suppression with bounded row codec; detailed observations expire/replace. New local rejected identity/registration/alias, even forgotten-copy alias, requires admission; otherwise metadata-free pre-admission refusal. Approved remote alias/upsert/forget fragment never reruns those local limits: persist canonical approved metadata, union keys, account usage, defer local index/hold via canonical refs. No approved payload copied into work queue.

At apply, each selected item checks scope/live/import/history/identity/metadata/work budgets
and reserves atomically with its receipt/revision/outbox. Partial success returns exact per-item
operation/revision IDs and outcome; capacity_exceeded includes safe dimension/current/limit/
reclaimable for each refused item. Retry same batch digest returns compact recorded outcome,
not reapply successes. Changed import content revises the same MemoryId. Retained raw source
files/snapshot bytes are transient TTL cache only, never canonical source archive, FTS or log;
only selected approved memory text may become active/indexed. Preview staging consumes shared
MEMORY_CHECKPOINT_STAGING_MAX_BYTES and expires/replaces under MEMORY_DERIVED_CACHE_TTL_MS.

Future importer/service CI uses real WP2 transactions for local equality/+1 session/cumulative/multibyte/history quotas, split-session bypass, concurrent reservation, partial exact replay, permanent alias/digest limits, observation replacement and receipt expiry/retry guard. Add approved alias/suppression catch-up with full local alias/key/work budgets: all approved fragment keys union, canonical alias receipt/payload preserved, cursor advances, re-import stays suppressed; only new local alias refuses. Scanner disagreement preserves approved canonical body with local hold; forget/bootstrap/reindex purges and source files remain unchanged. NOT RUN here.

### apps/server/src/memory/MemoryImport.test.ts — M20 activation (NOT RUN)

| Case                                               | Activation                                                                                                                                                     | Required observation                                                                                                                                                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved alias/suppression under full local quotas | Fill local source/alias/digest/work budgets; normal WP3 pull delivers hub-approved alias upsert and multiple bounded forget fragments through real WP2 service | Every admitted alias/receipt and full suppression union retained; cursor advances; approved body is canonical once and local index may defer. New local alias alone refuses; re-import after restart/bootstrap stays suppressed; provider source files unchanged. |

## M20 replan (rev 8)

Directly keeps local import/new alias admission while approved alias upsert/forget union bypasses replica quota/scanner reapproval. Field chain and cumulative-key/CI clauses now distinguish modes; owning importer/service CI covers approved alias/suppression at full local budgets.

Docs-only amendment; no source edits, installation, tests, builds, server/user-data writes, commit
or push. All newly specified runtime/CI cases are NOT RUN; no runtime CLOSED or requirement 7
completion is claimed.
