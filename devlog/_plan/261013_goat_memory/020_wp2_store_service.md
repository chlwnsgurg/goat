# 020 — WP2: memory store, service and worker

Enforcement limits and claim wording: [000 Enforcement inventory](000_plan.md#enforcement-inventory). Audit r1 rev 4 amendments supersede incompatible rev 2/3 recipes.

GOAT needs a durable memory aggregate before it can share memories or expose them to agents. WP2 adds the SQLite ledger, pure revision decisions, atomic service methods, secret screening, indexed reads, and restartable generation work. A committed write means local intent and its effects survived together; it does not mean a hub acknowledged it or a bot delivered a report.

Parent: [000_plan.md](000_plan.md), especially M1-M5, M7-M11, M16-M18 and Shared names. Design rationale: [001_architect_proposal.md](001_architect_proposal.md). The roadmap's dispositions override the proposal's older Codex/Claude-only generation table: **both memory operations are implemented for all six providers from the first release**. Antigravity configuration restrictions remain typed execution failures, not silent provider substitution.

Baseline inspected: HEAD and local origin/dev `1e2418fafb625604de1eb89250a10d971bcfd0fe`, branch `goat/goat-cross-device-provider-memory`, 2026-10-13. Source citations below refer to that baseline; recheck migration numbers and affected signatures on the stacked WP1 head. This is an implementation PRD, not evidence that the implementation or tests passed. Original phase authoring created only this document; rev 2 reconciles the allowed plans without commits or pushes.

## 1. Inputs, outputs and acceptance

Consume [WP1](010_wp1_contracts.md): exported schemas/brands from `packages/contracts/src/memory.ts`; strict scope and provenance validation; operation/result/error schemas; provider generation input/output types and capability declarations. Use `MemoryProjectKey`, never the proposal's shorthand `ProjectKey`. Use `MemoryOperationId` separately from `MemoryRevisionId`. WP2 does not redefine RPC, auth scopes, `memoryContext`, or the public memory protocol.

The WP1 handoff includes the settled contracts in 010; section 11 assigns consumers. Revert consumes the caller's explicit `restoredRevisionId`, one of the resolution's original inputs; the worker must not arbitrarily pick an original. Missing implementation of a settled WP1 contract blocks acceptance; no cast or second schema is allowed. Sibling drafts appeared during this writing session; the final pass aligned revert and generation limits with their WP1 schemas.

Deliver a separate memory aggregate on the existing `statev2.sqlite` client. No fake thread is created for a user/project memory. `EventSink` is a precedent and source of committed thread events, not the sink for memory events. Existing atomic commit behavior is in `apps/server/src/orchestration-v2/EventSink.ts:529-587`; SQL setup and the in-memory test layer are in `apps/server/src/persistence/Sqlite.ts:15-56`. The service format and safe error attributes are required by `docs/internals/effect-services.md:40-116`.

Acceptance is independently observable through service tests:

- Same operation and content returns the original receipt; changed content under the same ID is rejected.
- Failure before commit leaves no partial ledger/projection/outbox. Failure after commit leaves complete intent that a fresh worker recovers.
- Forget wins over concurrent edit, resolution, revert, parked input and delayed summary. Forgotten GOAT bodies, resolution originals/judgment and derived text are removed; minimal deletion and suppression knowledge remains.
- Non-ancestral heads quarantine only their memory. Other reads and work continue. An ordinary upsert cannot clear a conflict.
- Both generation operations dispatch to each of Codex, Claude, Cursor, Grok, OpenCode (v1 and v2), and Antigravity. Tools are disabled by runner policy, not by a prompt alone. Failure leaves the affected memory quarantined and records a safe report intent.
- Committed thread termination produces owner-local summary intent; replay/restart cannot create a duplicate revision. Turn completion never waits for generation.
- Server and affected provider packages pass targeted typecheck/lint; focused tests pass on the exact PR head in **PR CI (`goat-ci`)**. Tests and builds must not run on juns-macbook-pro.

## 2. File change map

This map is for the future WP2 implementation PR. NEW tests are listed individually in section 8. No DELETE files are planned. Public types already introduced by WP1 are consumed, not introduced again here.

| Action | Exact path                                                      | Change and reason                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NEW    | `apps/server/src/persistence/Migrations/069_Memory.ts`          | Create the local canonical tables, durable execution rows and derived FTS index. `069` is provisional until the WP1 parent is refreshed. Stable ledger name is `Memory`.                                           |
| MODIFY | `apps/server/src/persistence/Migrations.ts`                     | Import the migration and append `[69, "Memory", Migration0069]`; current final entry is `068_RemoteReportRelay` at lines 85, 169.                                                                                  |
| MODIFY | `apps/server/src/persistence/reconcileGoatMigrationIds.ts`      | Add `"Memory"` to `GOAT_MIGRATION_NAMES` at lines 9-17 so later upstream numbering changes reconcile by stable name.                                                                                               |
| NEW    | `apps/server/src/memory/MemoryStore.ts`                         | Effect SQL service: row codecs, consistent aggregate reads, atomic commits, durable receipts/jobs/report intents, read indexes and restart queries.                                                                |
| NEW    | `apps/server/src/memory/MemoryDecider.ts`                       | Pure create/edit/conflict/forget/resolve/revert decisions. Takes decoded state and validated input, emits metadata/projection/payload changes. No SQL, clock, filesystem or model access.                          |
| NEW    | `apps/server/src/memory/MemoryService.ts`                       | Effect service for search/list/read/history/upsert/forget/revertResolution and internal receive/summary/resolution application. Own validation, authorization callback recheck, scanner, decision and transaction. |
| NEW    | `apps/server/src/memory/MemorySecretScanner.ts`                 | One pure, deterministic scanner shared by commit, generation input/output and later import/sync. Reports rule IDs and lengths, never matching text.                                                                |
| NEW    | `apps/server/src/memory/MemoryWorker.ts`                        | Scoped drainable durable worker: committed-event catch-up, owner summary jobs, 24-hour consolidation, authorized resolution generation, derived-index recovery. No hub transport or bot delivery.                  |
| NEW    | `packages/provider-core/src/server/memoryGenerationPrompts.ts`  | Common untrusted-data prompt builders and output validation for both operations; use WP1 result schemas.                                                                                                           |
| MODIFY | `packages/provider-core/src/server/textGenerationOperations.ts` | Add both operations to `fromRunner` and a pure `isMemoryOperation` predicate; request has no `investigate` and no attachments. Current request/decoder/factory are at lines 35-49, 79-95, 107-231.                 |
| MODIFY | `packages/provider-core/package.json`                           | Add a source subpath export for `server/memoryGenerationPrompts` if provider tests import it; existing exports use source `types`/`import` pairs (lines 5-25). Avoid an unused public export otherwise.            |
| MODIFY | `apps/server/src/textGeneration/TextGeneration.ts`              | Extend operation union, input/result re-exports and instance routing for both methods; current union is lines 33-39, dispatch is lines 64-108.                                                                     |
| MODIFY | `apps/server/src/textGeneration/CodexTextGeneration.ts`         | Apply reception-strength no-tool/config isolation to memory operations; capture effective model at alias resolution; fail closed when isolated home cannot be established.                                         |
| MODIFY | `apps/server/src/textGeneration/ClaudeTextGeneration.ts`        | Include memory operations in empty-directory selection; retain `--tools ""`, hook disabling, strict MCP config; return requested/effective model metadata.                                                         |
| MODIFY | `packages/provider-cursor/src/server/textGeneration.ts`         | Add explicit memory-operation no-tool enforcement to the SDK invocation, preserve auth guards, deny the unsandboxed fallback for memory unless an independently enforced no-tool mode is available.                |
| MODIFY | `packages/provider-grok/src/server/textGeneration.ts`           | Run memory requests in empty directories with explicit approval-required mode and no-tool callbacks; reject tool events/permission/elicitation and configured pre-prompt tools.                                    |
| MODIFY | `packages/provider-grok/src/server/acpSupport.ts`               | Add an isolated text-generation spawn policy only where required to disable global hooks/MCP; preserve ordinary agent spawn behavior. Current mode override is lines 46-61; argv/environment are lines 64-78.      |
| MODIFY | `packages/provider-opencode/src/server/textGeneration.ts`       | Consume the operation enum widened in WP1 and ensure memory sessions carry tool-deny policy, empty working directory, timeout and removal finalizer; capture effective model.                                      |
| MODIFY | `packages/provider-opencode/src/server/v2/textGeneration.ts`    | Reject any tool/permission attempt for memory, preserve subscribe-before-prompt and cleanup, use isolated directory and return effective model metadata.                                                           |
| MODIFY | `apps/server/src/textGeneration/AntigravityTextGeneration.ts`   | Preserve availability gate and all tool callback rejection; wrap memory results with effective model metadata and test both operation names.                                                                       |
| MODIFY | `apps/server/src/server.ts`                                     | Compose one shared memory store/service/worker with existing SQL, settings, registry, text generation and committed event sink; start worker scoped.                                                               |
| MODIFY | `.github/workflows/goat-ci.yml`                                 | Add a focused provider-memory test step to the existing `matrix.task == 'test'` lane: current lines 98-102 run ssh/web, not provider packages. Server shards already run server tests at lines 130-132.            |

`apps/server/src/persistence/Sqlite.ts`, `apps/server/src/orchestration-v2/EventSink.ts`, `apps/server/src/orchestration-v2/ThreadTitleRegenerationService.ts`, and `apps/server/src/textGeneration/TextGenerationPresets.ts`: **N/A, no modification**. Reuse their services; memory model selection does not use title presets. Codex, Claude and Antigravity one-shot sources actually live in `apps/server/src/textGeneration`, not nonexistent `packages/provider-codex`, `provider-claude`, or `provider-antigravity` packages. Current driver wiring proves this: `CodexDriver.ts:33,276`, `ClaudeDriver.ts:26,194`, `AntigravityDriver.ts:27,446` under `apps/server/src/provider/Drivers/`. Pi/Muse are outside the roadmap's six-provider product scope; WP1 optional memory methods let their existing factories remain compatible.

## 3. SQL layout and commit boundary

The following column specification is normative; use Effect Schema codecs for every JSON column. Keys are composite with `memory_space_id` even when IDs are globally unique. Integer sequences are nonnegative, timestamps use UTC milliseconds, booleans use CHECK-constrained 0/1. Parameterize values with the tagged SQL client. Migration DDL must use `IF NOT EXISTS` and follow the Effect default-export convention in `apps/server/src/persistence/Migrations/068_RemoteReportRelay.ts:1-23`.

| Table                    | Columns, keys and indexes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Ownership                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_events`          | `sequence INTEGER PRIMARY KEY AUTOINCREMENT`, `protocol_version`, `memory_space_id`, `memory_id`, `operation_id`, `kind`, `origin_environment_id`, `operation_digest`, `metadata_json`, `receipt_json`, `created_at`. UNIQUE(space, operation_id); INDEX(space, memory_id, sequence). `metadata_json` has no body, judgment, raw source or raw operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Bounded detailed tail; permanent minimal dedup moves to memory_compact_receipts before safe prefix deletion. Receipt survives payload purge.                                                                                                                                      |
| `memory_revisions`       | `(space, revision_id)` PK; `memory_id`, `operation_id`, `parents_json`, `scope_json`, `assertion_kind`, `provenance_json`, nullable `payload_ref`, `created_at`. INDEX(space, memory_id); enforce immutable metadata/parent IDs. Content-bearing evidence belongs in payloads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Canonical DAG metadata bounded by published checkpoint causal boundary; protected heads/conflicts/revert inputs remain.                                                                                                                                                           |
| `memory_payloads`        | `(space, payload_ref)` PK; `memory_id`, `body_json`, `dependencies_json`. INDEX(space, memory_id). Body includes memory text, content-bearing evidence and resolution judgment/originals when applicable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Purgeable canonical content; NEVER copied into event JSON.                                                                                                                                                                                                                        |
| `memory_items`           | `rowid INTEGER PRIMARY KEY`, `space`, `memory_id`, `scope_json`, `scope_key`, `heads_json`, `status`, `payload_ref`, `projection_watermark`. UNIQUE(space, memory_id), INDEX(space, scope_key, status, memory_id). Status matches MemoryItem: `active/quarantined/forgotten/blocked`. Only eligible active single-head items have visible payloads; canonical approved body may remain when local view is blocked. Add local availability, scanner policy/version/rule IDs/time, index state, revision/generation, cleanup/report flags and bounded attempt/due/reason refs. FTS readiness is independent.                                                                                                                                                                                                                                                                                                                                                             | Derived projection.                                                                                                                                                                                                                                                               |
| `memory_tombstones`      | `(space, memory_id)` PK; `delete_operation_id`, `deleting_environment_id`, `deleted_at`, `suppressed_source_keys_json`, `suppressed_content_json`, `source_exclusions_json`. JSON uses WP1 suppression schemas; retain the quota-bounded permanent union as memory_import_keys unique rows; JSON contains only bounded wire fragments. No text. No TTL/cascade from thread deletion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Permanent delete knowledge.                                                                                                                                                                                                                                                       |
| `memory_conflicts`       | `(space, conflict_id)` PK; `memory_id`, `heads_json`, `status` (`quarantined/resolving/failed/resolved`), nullable `failure_code` (WP1 MemoryFailureCode), nullable `attempt_id`. INDEX(space, memory_id, status). Sorted heads determine conflict identity; no originals in this row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Canonical conflict metadata; execution attempt details remain local.                                                                                                                                                                                                              |
| `memory_resolutions`     | `(space, resolution_id)` PK; `memory_id`, `input_revision_ids_json`, `input_payload_refs_json`, `judgment_payload_ref`, `requested_model_selection_json`, `effective_provider_model_json`, `resolving_environment_id`, `fencing_token`, `result_revision_id`, `applied_at`, nullable `revert_operation_id`. INDEX(space, memory_id). UNIQUE(space, result_revision_id).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Canonical accepted result record, with purgeable content references.                                                                                                                                                                                                              |
| `memory_revert_intents`  | `(space, operation_id)` PK; `memory_id`, `resolution_id`, `restored_revision_id`, `expected_heads_json`, `request_digest`, `submission_metadata_json`, `payload_ref`, `created_at`. Metadata encodes a stable proposed operation/revision ID and parents, with body stored only in memory_payloads; no memory_revisions row. INDEX(space, memory_id); UNIQUE(space, resolution_id) for the pending intent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Private `PendingMemoryRevertIntent`, outside canonical DAG/projection/FTS; purge on terminal receipt or tombstone.                                                                                                                                                                |
| `memory_outbox`          | `id TEXT PRIMARY KEY`, `space`, nullable `memory_id`, `kind`, `status`, `metadata_json`, nullable `payload_ref`, `attempt`, `next_attempt_at`, nullable `claimed_by`, nullable `claimed_until`, nullable `completed_receipt_json`. UNIQUE(kind, id); INDEX(status, next_attempt_at). Kinds `sync/revert_intent/summary/consolidate/claim/resolve/rebuild/admin`; claim metadata is body-free `{ conflictId, sortedHeads, headSetDigest, attemptId?, leaseExpiresAt?, coordinatorEpoch? }`, UNIQUE deterministic claim id per space/memory/head-set; status `pending/running/retry/completed/cancelled/failed`.                                                                                                                                                                                                                                                                                                                                                         | Local durable intent, summary identity/receipt and worker recovery. No raw transcripts. Revert intent table holds staging only; minimal terminal result/digest stays in completed_receipt_json for retry/history, not a second receipt table.                                     |
| `memory_inbox_pending`   | `(space, pending_key)` PK; `record_kind` (`operation/checkpoint`), nullable `operation_id`, `memory_id`, `operation_digest`, `missing_parents_json`, `reason` (safe MemoryDeferredReason for approved hold; base_compacted for unapproved intent review), `hub_sequence`, `checkpoint_id`, `page_ordinal`; `metadata_json`, nullable `payload_ref`. Partial UNIQUE(space, operation_id) for operation rows; INDEX(space, memory_id), UNIQUE(space, checkpoint_id, page_ordinal) for checkpoint rows. Approved scanner-held/missing-parent rows reference the single purgeable canonical payload; no metadata-only replacement or deferred body copy. base_compacted is unapproved intent review only; approved checkpoint pages require ordinal/completeness and actual durable storage, not local work/staging quota admission.                                                                                                                                       | Local parked input/checkpoint staging; WP3 attaches received sequence/cursor atomically.                                                                                                                                                                                          |
| `memory_sync_cursors`    | `(space, hub_environment_id)` PK; `after_sequence`, `bootstrap_state` (`unbound/staging/ready`), nullable `checkpoint_id`, `checkpoint_sequence`, `snapshot_token`, `checkpoint_cursor`, nullable `last_success_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Created empty here; WP3 owns mutations and bootstrap.                                                                                                                                                                                                                             |
| `memory_import_receipts` | `receipt_id TEXT PRIMARY KEY`, `space`, `environment_id`, `record_kind` (`source/batch/item`), `source_id`, `format`, `source_locator`, `source_item_key`, `parser_version`, `scope_json`, `accepted_source_fingerprint`, `accepted_content_fingerprints_json`, `observed_rejected_fingerprint`, nullable `memory_id`, `accepted_revision_id`, `batch_operation_id`, `request_digest`, `completed_items_json`, `outcome`, `issue`, `observed_at_utc`, `suppressed`, `source_aliases_json`, `registration_json` (local root slot/profile only). CHECK required/forbidden fields per arm; source UNIQUE(space,environment_id,source_id), batch UNIQUE(space,environment_id,batch_operation_id), item UNIQUE(space,environment_id,source_id,source_item_key), each a partial index on its record_kind. Item scope/fingerprint lookup indexed; rejected rows have nullable memory/revision. Body-free batch uses WP1 MemoryImportReceipt; registration never goes on wire. | WP2 defines all columns/codecs/atomic helpers; WP5 populates source/item/batch receipts. Source identity survives parser changes; compact accepted digest/alias/suppression keys never expire within M19 budgets; detailed batches expire under MEMORY_IMPORT_BATCH_RETENTION_MS. |
| `memory_report_outbox`   | `report_id TEXT PRIMARY KEY`, `space`, `memory_id`, `operation_id`, nullable `resolution_id`, nullable `attempt_id`, `resolving_environment_id`, `outcome` (`resolved/failed/reverted`), `state` (`pending/delivered/failed`), nullable `failure_code`, `created_at`, nullable `delivered_at`, `claimed_by`, `claimed_until`, `report_thread_json`, `delivered_sequence`. CHECK delivered iff thread+sequence+delivered_at present; failed requires safe failure_code. UNIQUE stable report ID; INDEX(state, claimed_until). JSON pointer is ScopedThreadRef; no body/model response.                                                                                                                                                                                                                                                                                                                                                                                  | Local report intent/claim/ack is WP2; WP6 delivers using MemoryReportDelivery and stable reportId.                                                                                                                                                                                |
| `memory_items_fts`       | Standalone FTS5 body for eligible active single-head text; unicode61; rowid matches item row. Revision/generation fences every writer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Derived only. Normal forget deletes immediately; FTS failure invalidates index/read access and records cleanupPending while canonical forget commits.                                                                                                                             |

Create the standalone FTS index when available; keep canonical readiness separate from search readiness. FTS5/dbstat absence reports unavailable search/metrics and deferred indexing, never prevents replication startup. No silent alternate search backend.

Create no `memory_hub_operations`, `memory_hub_members`, `memory_hub_leases`, or `memory_hub_source_reads` in WP2; [WP3](030_wp3_hub_sync.md) owns those. Do not copy local job/receipt/report state into hub operations. SQLite WAL/busy timeout already exist at `Sqlite.ts:18-24`; changing them or adding a second connection is unnecessary.

Migration patch based on `Migrations.ts:85,169` and `reconcileGoatMigrationIds.ts:9-17`:

```diff
 import Migration0068 from "./Migrations/068_RemoteReportRelay.ts";
+import Migration0069 from "./Migrations/069_Memory.ts";
 // ... migrationEntries
   [68, "RemoteReportRelay", Migration0068],
+  [69, "Memory", Migration0069],
 // ... GOAT_MIGRATION_NAMES, in reconcileGoatMigrationIds.ts
   "RemoteReportRelay",
+  "Memory",
```

The migration's one normative column inventory is the table above. Implement it as the
Effect.gen default-export migration; no second abbreviated DDL inventory. Do not backfill
provider homes or transcripts. `memory_inbox_pending` owns both received-operation and
checkpoint staging, including hub-produced materialized pages (a private pending_key namespace,
member-bound checkpoint_id/page_ordinal). WP3 creates no staging/cursor tables or columns.
Local unbound drafts use a private reserved SQL namespace/codec, never a MemorySpaceId brand.
Administration recovery uses the admin outbox kind and body-free metadata/secret handle only;
credential bytes stay in ServerSecretStore. `memoryHubVersion` is local settings persistence,
owned by WP3, not a memory event/table.

The store owns the transaction; pure decisions read current state inside it. All entry points carry an internal unforgeable admission mode. localIntent/hubAdmission reserve and decide atomically; approvedReplica commits canonical payload/revision, original hub outcome/digest, minimal DAG/delete state, deferred flags and cursor. FTS, scanner recheck, report delivery and export drain after commit; their failures never roll back receive. Canonical SQL failure rolls back the whole receive page. Signal follows commit; startup SQL recovery covers lost wakeup.

```ts
// MemoryStore.ts — Context.Service interface, errors then private make then layer.
export class MemoryStore extends Context.Service<
  MemoryStore,
  {
    readonly transact: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | MemoryStorageError, R>;
    readonly receipt: (
      space: MemorySpaceId,
      id: MemoryOperationId,
    ) => Effect.Effect<StoredReceipt | undefined, MemoryStorageError>;
    readonly loadAggregate: (
      space: MemorySpaceId,
      id: MemoryId,
    ) => Effect.Effect<MemoryAggregate, MemoryStorageError>;
    readonly apply: (decision: MemoryDecision) => Effect.Effect<StoredReceipt, MemoryStorageError>;
    readonly dueWork: (
      now: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<MemoryWork>, MemoryStorageError>;
    readonly wake: Effect.Effect<void>;
  }
>()("goat/memory/MemoryStore") {}

// MemoryService.ts — helper names below are local implementation names, not wire types.
const applyOperation = (
  input: MemoryOperation,
  admission: MemoryAdmissionContext,
  permit: Effect.Effect<void, MemoryAccessError>,
) =>
  Effect.gen(function* () {
    const operation = yield* decodeOperationExplicitFields(input);
    const digest = yield* digestCanonicalOperation(operation);
    const result = yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const old = yield* store.receipt(operation.memorySpaceId, operation.operationId);
        if (old !== undefined) return yield* replayApprovedOrIntent(old, digest, admission);
        const current = yield* store.loadAggregate(operation.memorySpaceId, operation.memoryId);
        // approvedReplica records canonical data + original receipt + deferred flags;
        // caller withReceivedCursor commits page cursor in this SAME transaction.
        const scan = admission.kind === "approvedReplica" ? undefined : scanOperation(operation);
        return yield* store.apply(decideMemoryOperation(current, operation, admission, scan));
      }),
    );
    yield* store.wake; // SQL recovery survives lost wake; derived failures do not roll back receive.
    return result;
  });
```

`StoredReceipt`, `MemoryAggregate`, `MemoryDecision`, `MemoryWork`, and storage/access errors are private server types/codecs. Add methods below to the inline `MemoryService` interface, not a parallel `MemoryServiceShape`: `upsert`, `forget`, `revertResolution`, `search`, `list`, `read`, `history`, `applyReceived`, `commitSummary`, `commitAcceptedResolution`, `queueSummary`, `queueResolution`, `recoverWork`, `pendingReports`, `claimReport`, `acknowledgeReport`, `failReport`, `readContextCandidates`, and `readContextRevisions`. Their inputs/results derive from WP1 schemas. `commitAcceptedResolution` and `applyReceived` are internal server-principal entry points; never expose a bool `skipAuthorization` to RPC callers. WP4 supplies transport authorization and a live recheck callback. Scope filtering always happens in SQL before paging, including user-memory-space and thread-environment identity checks.

Local `pendingSync` derives from unsent `sync` outbox rows. Pending revert is a separate MemoryRevertResult status, not a changed MemoryItem head or successful mutation. WP2 never claims `synced`: without WP3 acknowledgement there is no last successful sharing time. A local unresolved operation can be read only if its projection is active; a pending sync is not itself a quarantine.

Internal shared ports remain withReceivedCursor, materializeLocalIntent, installCheckpointPage, completeCheckpoint, acknowledgeOutbox and readEligibleOutbox. withReceivedCursor commits authenticated approved payload/ref, original outcome/digest, minimal frontier/tombstone/suppression, local deferred flags and cursor atomically; hub metadata rejection is preserved as received. No sync echo. Parent/scanner replay updates local hold/linkage only, never readmits approval.

Before a hub-issued `memorySpaceId` exists, a private `LocalMemoryIntent` is not a `MemoryOperation`: it has stable MemoryId, local intent ID, scope, provenance and purgeable payload, with no fabricated hub-space ID or published revision. If unbound local drafts are enabled, store them atomically under a private SQL namespace in payload/item/outbox rows, decode with a separate local codec, and keep them out of public MemoryItem/search and all wire serializers until binding. WP3 first installs its checkpoint, then calls `materializeLocalIntent` to allocate and persist the first shared operation/revision IDs and digest; retry reuses that mapping. Do not mutate a previously accepted shared operation's space/digest. A draft forget purges its payload and suppresses its sources before materialization. Already published memories from another space remain separate. This local draft seam is required by the concurrent WP3 plan; it is not public unjoined memory RPC support.

Checkpoint staging uses operation/checkpoint row tags, hub-approved canonical payload refs, fixed sequence, page ordinal and complete-page manifest. Verify all ordinals/completeness before atomic canonical state/boundary/original receipt/deferred/cursor install. No replica quota/scanner/FTS admission. Forget purges staged bodies. Preserve local intents/newer tombstones; no partial active state. Bootstrap completion excludes FTS/export readiness, whose flags persist locally.

### M20 durable deferred ownership

Extend WP2 canonical rows and existing pending/maintenance metadata; no new generic job system.
Every canonical approved payload is stored once; pending/checkpoint/deferred state uses refs.

| Work                            | Persisted key/state                                                                           | Retry trigger and termination                                                                                                                                                                                                                                                                                                                     | Observation                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Approved receive                | sequence/digest/original outcome + canonical payload/ref                                      | Same sequence/digest replay idempotent; SQL failure retry whole page                                                                                                                                                                                                                                                                              | lastReceivedHubSequence/receiveLag                           |
| Index                           | revision/generation, pending/held/ready, reason/time                                          | Brake release/index budget/maintenance/restart; coalesce latest target                                                                                                                                                                                                                                                                            | unindexedItems/oldestDeferredAtUtc/indexCoverage             |
| Scanner                         | policy/version/rules/time, held revision/generation, state scanner_pending or secret_detected | scanner_pending: automatic first scan scheduled by the receive commit, recovered on restart, allowed result clears it; secret_detected: rescan scheduled by MemoryWorker when the stored policyVersion is older than the current scanner policy (checked at start and on policy upgrade), allowed result clears it; tombstone cancels/purges both | scannerHeldItems (secret_detected), scannerPendingItems, age |
| Parent                          | canonical revision ref/missing IDs/boundary                                                   | Parent commit/checkpoint/restart; actual persistent missing requests recovery                                                                                                                                                                                                                                                                     | missingParentItems/age/safe failure                          |
| Projection/export/cache/cleanup | target generation/kind/attempt/due/reason                                                     | Post-commit bounded drain/restart; deletion beats creation                                                                                                                                                                                                                                                                                        | pendingCleanupItems/cleanupPending                           |
| Report                          | stable repair report ID + delivery state                                                      | Existing bounded automatic/manual retry; no regeneration                                                                                                                                                                                                                                                                                          | reportBacklog/reportFailed                                   |

Work rows/flags are bounded per canonical item; accepted state is not subject to local pending
work count or payload-byte admission. Worker fetches bounded scans and never queues payload
copies. Deferred drain algorithm: select runnable rows (state pending, not held, due_at <= now) ordered by
(due_at, last_attempt_at NULLS FIRST, memory_id, kind), at most MEMORY_DEFERRED_SWEEP_MAX_ITEMS rows and
MEMORY_DEFERRED_SWEEP_MAX_BYTES of referenced canonical payload per sweep; a failed attempt sets
due_at = now + min(2^attempt * 5 s, 1 h) and increments attempt, so failing rows move behind healthy ones;
held rows are released into pending only by their own release trigger. Order, attempt and due_at live in
SQL, so restart resumes the same order without re-running completed rows. Atomic receive installs scanner_pending exposure fence until scan succeeds. An index-only
hold does not hide otherwise eligible list/read/injection, but scanner/parent/conflict hold does.
Late drains recheck generation/revision/tombstone and cancel or coalesce. Physical derived purge
can remain pending behind an invalid index/read fence without rolling back canonical deletion.

## 4. Pure decision rules, purge and replay

New function signatures:

```ts
export const decideMemoryOperation = (
  current: MemoryAggregate,
  operation: MemoryOperation,
  admission: MemoryAdmissionContext,
  scan: MemoryScanResult | undefined,
): MemoryDecision => {
  /* admission-specific branch order below; no I/O */
};

export const scanMemoryValue = (value: unknown): MemoryScanResult => {
  /* deterministic allowlisted string traversal */
};
// MemoryScanResult = { kind: "allowed" } |
//   { kind: "blocked"; ruleIds: ReadonlyArray<string>; inspectedBytes: number }.
```

Decode immutable envelope/ids/codec/digest first and compare approved ledger identity. All decision entry points distinguish localIntent, hubAdmission and approvedReplica. Before admission, scanner-blocked input keeps metadata only and parent/current-state checks apply. After approval, retain canonical body and hold exposure when scanner differs; missing parents defer linkage, genuine contradictory approved DAG/identity/digest is a page protocol error. Tombstone precedes every payload writer; replay preserves hub receipt without rematerializing forgotten content. An ID collision with unapproved local intent settles/preserves that intent for failure/review and admits the hub record.

For `upsert`: empty `parents`/`expectedHeads` means creation only if the ID has never existed. An edit with unknown parents is parked durably, not mistaken for a root. Parents must belong to the same memory/space; self-parent, cycle, cross-scope move and revision-ID reuse with different metadata fail. A local stale expected-head write returns `revision_changed`; an authenticated received non-ancestral edit is retained as a variant and quarantines the memory. Existing quarantine stays until an authorized resolution consumes **all** current heads. Additional edits change that head set and invalidate queued resolution attempts.

For forget: canonical delete-wins purges payload, staged/held bodies, pending intent, originals/judgment and dependent content, unions suppression and invalidates ALL deferred work atomically. Keep original approved hub receipt unchanged even for a later body discarded under tombstone. Normal FTS deletion is immediate; if derived store fails, commit canonical delete, invalidate index and fence every read, persist cleanupPending, retry bounded cleanup. Physical purge completion is not asserted until verified. Late writers recheck tombstone plus revision/generation.

A later distinct forget on an already tombstoned ID must union any new `suppressedSourceKeys`, not short-circuit before retaining deletion knowledge. WP1 bounds each envelope to 100 source keys: retain the permanent logical union across fragments, including 101+ keys, while each outbound fragment remains bounded. Same-ID/same-digest replay stays a receipt NOOP. Keep historical exact-content digests scoped and nonreversible for known replicated-source suppression; do not use content equality across unrelated scopes to merge identities.

Dependency purge uses `memory_payloads.dependencies_json` for `MemoryRevisionId` references and source-watermark suppression in durable summary metadata. Walk the reverse dependency closure in the transaction; quarantine/invalidate derived projections and erase their payloads, not just their search row. Schedule regeneration from only unsuppressed input. Also retain per-thread extraction exclusions `(ScopedThreadRef, throughWatermark, sourceMessageLocators)` after forgetting a generated summary so subsequent consolidation cannot re-extract the same transcript passage. Keep those in tombstone/suppression metadata and completed summary job metadata; never write or edit provider transcripts.

Local pre-submit/hub resolve requires exact heads, current lease/fence and scanner-approved inputs/result/judgment. Hub commits accepted canonical revision/receipt. Owner and replicas ingest through approvedReplica, preserving unrelated unsent frontier and deferring FTS/display/report repair. A minimum stable report repair marker commits with acceptance; report quota/delivery cannot change outcome. Model cannot supply IDs/token/identity/provenance. No repeated replica CAS.

For pre-submit local validation and hub admission of `revert`: match `expectedHeads == [resultRevisionId]`, unchanged resolution and no tombstone; require `restoredRevisionId` to be one of `inputRevisionIds` with an unpurged original payload. Local validation atomically stores a PendingMemoryRevertIntent plus kind revert_intent outbox row, with stable proposed IDs/digest/purgeable payload, and returns MemoryRevertResult pending. It creates no revision/event/projection/FTS/report or claim candidate; edits cannot parent the proposal. Hub admission alone creates the fresh compensating revision copying the selected original, with `parents = [resultRevisionId]` and `revertsResolutionId`. The origin incorporates the approved operation in approvedReplica mode, then records revertOperationId and one resolver-owned reverted report; no sync echo. Other originals and the resolution remain in history only within M19 retention and protected-input rules; no immutable revision is rewritten. Same-ID retry returns stored pending/terminal result. A second distinct revert or later edit returns revision_changed at validation/admission; forget returns forgotten. Only an approved compensation can be the single active head. A received hub-approved revert with an unrelated local head instead follows the replica merge rule below and queues the new conflict. If product wants all alternatives reopened instead, that requires a separate WP1 contract decision; it is not implemented implicitly here.

Search joins only eligible indexed active projection rows behind generation/index-validity fences. list/read/history and injection depend on scanner/ancestry/conflict/delete eligibility, not FTS readiness; held history redacts every content-bearing field. Search returns same-scope/watermark indexCoverage even for empty results. Rebuild is a bounded derived drain, not canonical receive admission. Every cache/export/FTS writer rechecks revision/generation and tombstone; cleanup failure remains pending.

Use the one scanner for local input/hub admission and replica-local exposure. Pre-admission secrets keep metadata only; approved secrets remain once in purgeable canonical payload, with policy/version/rule IDs/time hold. secret_detected has no timer release: MemoryWorker records the scanner policyVersion with every hold, and at server start and after a scanner-policy upgrade it compares the stored policyVersion with the current one and schedules a durable rescan for every hold recorded under an older version; clear only on an allowed result for the current generation. There is no per-item explicit rescan RPC or MCP tool; a user who believes a hold is a false positive forgets the memory and creates it again, which runs the normal pre-admission scan. Initial scanner_pending uses the automatic first scan. Exclude held text/originals/judgment/source from read/history/FTS/injection/resolve/summary/export. Safe reports carry IDs/rules/version/state only, no strings/raw cause. Forget purges held content and cancels reinspection.

## 5. Worker, thread hook and authority boundary

The worker exposes `start`, `drain`, `sweepDue`, and `execute` Effect methods. Obtain SQL/service/settings/text generation/event sink from Context; do not use `ManagedRuntime.make`, `runPromise`, module globals or per-feature runtimes. Reuse `makeDrainableWorker` for queue/current-item completion (`packages/shared/src/DrainableWorker.ts:17-29,45-93`), while SQL outbox is the durable queue. Catch failures per work item into safe durable categories before allowing the drainable worker's generic logger to see them.

```ts
export class MemoryWorker extends Context.Service<
  MemoryWorker,
  {
    readonly start: () => Effect.Effect<void, MemoryWorkerError, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly sweepDue: Effect.Effect<void, MemoryWorkerError>;
    readonly execute: (work: MemoryWork) => Effect.Effect<void, MemoryWorkerError>;
    // No resolve execution/recovery method: WP3 registry consumes private pinned-generation
    // and MemoryStore.commitAcceptedResolution ports; generic execute rejects its ticket kinds.
  }
>()("goat/memory/MemoryWorker") {}

const executeSummary = (work: SummaryWork) =>
  Effect.gen(function* () {
    const source = yield* readCommittedOwnerSnapshot(work.sourceThread, work.sourceWatermark);
    yield* checkThreadExistsAndSourceEligible(source, work);
    yield* requireAllowedScan(source.selectedText);
    const frozen = yield* loadOrPersistDefaultModelSelection(work);
    const generated = yield* generation.generateMemorySummary({
      ...source.generationInput, // sourceThread, sourceWatermark, messages
      cwd: yield* isolatedScratchDirectory,
      modelSelection: frozen,
    });
    yield* requireAllowedScan(generated.result);
    yield* memory.commitSummary({ work, generated });
    // commitSummary rechecks thread existence, source watermark/exclusions,
    // dependency tombstones, receipt and expected target heads IN its transaction.
  });
```

Source acquisition uses a short read transaction and a fixed event watermark; never holds SQL across generation. Share only summary, scoped source locator, committed range and message locators. Job metadata has no transcript; re-read bounded committed source at execution. Current title service filters streaming messages at `ThreadTitleRegenerationService.ts:95-105` but chooses `textGenerationModelSelection` at lines 111-120. Memory must freeze the owning environment's **`defaultModelSelection` including instance ID, model and options**. Do not use project title-generation overrides or fall back to another environment/provider. Consume MemoryGenerationExecution from the trusted runner and persist the effective resolved alias/model in provenance; the model result cannot select it. Persist execution metadata in the generation result and subsequent provenance.

Subscribe to `EventSinkV2.stream` for committed `run.updated` terminal transitions and `thread.deleted`, then catch up from persisted high-watermark with the same SQL client. Current event schema is `packages/contracts/src/orchestrationV2.ts:1853`; terminal-status handling precedent is `ThreadSettlementService.ts:605-621`. Use terminal `completed` for ordinary extraction; failed/interrupted/cancelled runs allow only committed user statements and demonstrably completed results, no unfinished assistant prose. `rolled_back` invalidates affected source jobs rather than extracts reverted answers. Ignore live provider chunks and `provider-turn.updated` until corresponding durable source is eligible. A completed run with no source delta creates no job.

Summary job identity is deterministic `(ScopedThreadRef, sourceWatermark, operationVersion=1, mode=summary|consolidate)`, persisted as `memory_outbox.id`; summary MemoryId itself is stable per ScopedThreadRef across watermarks, and each admitted result replaces its head with a new revision; deterministic result operation/revision IDs derive from that identity and approved item keys. Compact completed job receipts and latest thread watermark so replay cannot regenerate another result; never retain a new live item per watermark. Retrying after provider failure may change attempt ID/model only through an explicit new attempt; commit result IDs remain stable. If source watermark advanced during generation, cancel that result and enqueue the newer watermark. Never let it overwrite a newer summary head. Thread deletion/forget cancels intent and rejects late output.

Turn extraction and consolidation are separate work kinds. Consolidation is due only when unsummarized committed changes exist **and** `now - lastConsolidatedAt >= 86_400_000` (24h); initialize last consolidation baseline from the first committed source timestamp. Do not run nightly consolidation over an unchanged thread. Restart sweeps replay committed termination events and unfinished jobs using a durable watermark stored in a reserved worker metadata row of `memory_outbox` (kind `rebuild`, stable ID `memory:thread-hook:v1`; never mark it runnable). Advance hook watermark in the same transaction as inserted summary intent. Deleted threads preserve their suppression knowledge.

Local work claim is SQL compare-and-set, with an internal 10-minute ownership deadline and per-start runtime identity. CAS prevents two worker instances executing one row; restart only reclaims expired ownership or the explicitly retired prior runtime. It is not the hub lease. Read/claim at most 100 due rows per sweep; due retry backoff is 5s, 30s, 120s, then 10min (cap), stored as `next_attempt_at`; no busy loops. Permanent input/schema/secret failures stop; transient provider/network failure retries. Tests advance a controlled clock and call `sweepDue`, never sleep. Timer wakeups are production scheduling only; drain waits for currently eligible work, not future retries or hub availability.

Resolution executes only in WP3 registry with pinned WP2 generation/accepted-commit ports. Before hub acceptance, lease/head/secret/provider failures retain quarantine and a safe attempt failure. After acceptance, persist/recover original approved receipt via ACK/pull and commit canonical result without CAS; local scanner/index/report delays are deferral, never failed generation or reason to regenerate/resubmit. Accepted foreign revert creates only a resolver-local stable repair marker; report backlog drains after receipt commit. Stable IDs derive from environment + resolution/attempt/revert + kind, and WP6 idempotent delivery/ACK cannot change acceptance.

## 6. Text generation changes and provider decisions

WP1 owns method/result contracts in `packages/provider-core/src/server/textGeneration.ts`. Optional methods allow old/custom drivers and Pi/Muse to compile; built-in six providers must return concrete implementations from `fromRunner`. `TextGeneration` routing returns typed `unsupported_operation` for a missing implementation, not a fallback. Wrap existing `TextGenerationError` causes into safe memory failure categories before persisting/reporting; existing `detail` may contain provider text and is not a report body.

Factory additions based on `textGenerationOperations.ts:212-231`:

```ts
const resolveMemoryConflict: NonNullable<ProviderTextGeneration["resolveMemoryConflict"]> =
  Effect.fn(`${name}.resolveMemoryConflict`)(function* (input) {
    return yield* runMemory({
      operation: "resolveMemoryConflict", cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildMemoryConflictPrompt(input),
    }); // no investigate or attachments; server validates IDs/references afterwards
  });
const generateMemorySummary: NonNullable<ProviderTextGeneration["generateMemorySummary"]> =
  Effect.fn(`${name}.generateMemorySummary`)(function* (input) {
    return yield* runMemory({
      operation: "generateMemorySummary", cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildMemorySummaryPrompt(input),
    });
  });
return { /* existing methods */, resolveMemoryConflict, generateMemorySummary };
```

Prompts treat all variant/transcript text as untrusted data and contain the entire allowed input. Output schemas allow bounded content, `fact/inference`, evidence references and a short judgment, never tool directives or model-selected authority fields. Consume WP1's generation input budget of 256KiB UTF-8 and output budget of 64KiB; also bound the rendered prompt including wrapper, with no silent sentence truncation. Oversize input maps to WP1 generation_input_too_large; validated model JSON is wrapped in the trusted WP1 execution envelope before it reaches the worker. A summary may partition source by whole committed messages into stable subjobs; a conflict must include every head and fails if it cannot fit. Evidence references must point to supplied revision/message IDs. Missing non-model evidence for a `fact`, an empty result, unknown reference or extra authority field is invalid output. These are generation budgets, not WP4's 6,000-character/24KiB injection budget.

Router patch anchored at `TextGeneration.ts:33-39,64-71`:

```diff
   | "generateReviewGuide";
+// Add "resolveMemoryConflict" and "generateMemorySummary" to TextGenerationOp.
 // TextGeneration.of({ ... })
+resolveMemoryConflict: (input) =>
+  resolveInstance(registry, "resolveMemoryConflict", input.modelSelection.instanceId).pipe(
+    Effect.flatMap((tg) => tg.resolveMemoryConflict === undefined
+      ? unsupportedMemoryOperation("resolveMemoryConflict")
+      : tg.resolveMemoryConflict(input)),
+  ),
+generateMemorySummary: (input) =>
+  resolveInstance(registry, "generateMemorySummary", input.modelSelection.instanceId).pipe(
+    Effect.flatMap((tg) => tg.generateMemorySummary === undefined
+      ? unsupportedMemoryOperation("generateMemorySummary")
+      : tg.generateMemorySummary(input)),
+  ),
```

A separate required built-in MemoryRunner returns `{ result, execution }` from the actual resolved selection. The generic Runner continues returning schema values for existing methods. fromRunner uses options.memoryRunner for memory methods and returns typed unsupported_operation when it is absent; all six built-ins supply it. The concrete signature and wrapping below are mandatory, not conditional. Do not ask the model which model it is. Explicit schema serialization/deserialization validates the generated content portion before returning the server-stamped envelope.

| Provider    | Current source and precise change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Failure behavior/evidence                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `CodexTextGeneration.ts:36-55` has reception no-tool args; lines 255-290 enable them only for reception. Add `isPromptOnly = isChannelReception                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                  | isMemoryOperation(operation)`, use empty cwd and isolated home with no AGENTS/config/rules/MCP/hooks. Capture selected `model` at lines 247-254. Memory-home setup must fail if isolation cannot be established; current home helper falls back to real home at lines 121-125 and must not do so for memory. | Fake CLI asserts switches, no checkout configuration, no tools; isolation failure never spawns. Existing credential refresh handling remains confined to the configured provider instance; fixtures use temporary homes only. |
| Claude      | `ClaudeTextGeneration.ts:171-175,183-195,212-225` disables hooks/tools/MCP and isolates only title/reception cwd. Extend cwd condition to both memory operations and retain no-tool branch; use API model resolved at line 205 for provenance.                                                                                                                                                                                                                                                                                                                                                                                             | Fake CLI asserts `--tools ""`, strict MCP, disable hooks/slash commands, empty cwd, effort/options preserved. No live CLI run on this Mac.                                                                                                                       |
| Cursor      | `provider-cursor/src/server/textGeneration.ts:86-112,131-159` uses plan mode, empty cwd/settings and sandbox fallback; these do not establish that the SDK has no executable tools. Set top-level `AgentOptions.tools: []` on Agent.create and every Agent.resume for memory under pinned @cursor/sdk 1.0.35, plus `disallowedTools: ["mcp", "task"]`, `mcpServers: {}`, no local.customTools, isolated settingSources/hooks. Fail typed if this policy is unavailable; do not treat plan mode as tool-less. Memory requests must not use the unsandboxed fallback at lines 134-136 unless the no-tool boundary is independently enforced. | SDK fixture emits a tool attempt and sees rejection before execution; bad sandbox config at lines 91-98 remains unavailable; no alternate provider. A runner that cannot enforce this is an explicit availability failure, never advertised as a successful run. |
| Grok        | `provider-grok/src/server/textGeneration.ts:33-45,59-83` creates an ACP session without an explicit permission mode/tool handlers. Add isolated cwd, `runtimeMode: "approval-required"`, reject permission/elicitation/file/terminal/extensions and tool-call events, and disable pre-prompt MCP/hooks through supported isolated configuration in `acpSupport.ts`. Capture session-resolved model and reasoning effort.                                                                                                                                                                                                                   | ACP fixture asserts mode override and callback denial, including tool-call-before-answer. If native internal tools or global hooks cannot be disabled, return typed `unavailable` before prompting; do not rely solely on denying ACP file callbacks.            |
| OpenCode v1 | `provider-opencode/src/server/textGeneration.ts:13-20` has a closed operation schema widened in WP1; consume it unchanged. Lines 189-225 set deny permissions but propagate selected agent; memory must use a fixed no-tool agent/policy, not a user agent capable of hooks. Use empty cwd, explicit timeout and session removal.                                                                                                                                                                                                                                                                                                          | SDK fixture sees deny-all, no user agent override, bounded response, cleanup on failure. External servers that cannot certify isolation return unavailable; do not change their configuration.                                                                   |
| OpenCode v2 | `provider-opencode/src/server/v2/textGeneration.ts:89-97,129-154` rejects permission asks but permits text completion afterwards. For memory, any attempted tool fails the generation as well as rejecting permission. Keep event subscription before session creation, 3-minute timeout and removal at lines 140-143,155-166.                                                                                                                                                                                                                                                                                                             | Event fixture sends tool/permission attempt then apparent success: no accepted memory output. Effective model/variant comes from server session selection.                                                                                                       |
| Antigravity | `AntigravityTextGeneration.ts:64-91,112-117` blocks global hooks/MCP; lines 149-186 deny tool requests/events, 260-282 enforce empty directory/output/timeout. Retain these gates for both new methods and capture applied model at lines 217-227.                                                                                                                                                                                                                                                                                                                                                                                         | Configured hooks/MCP, non-file or >64,000-byte config, invalid JSON, tool attempt, >128,000-char runner response or timeout fails safely. Memory output also obeys the 64KiB encoded schema budget. No other model is tried.                                     |

All six operation paths must be present and fixture-tested. Per-instance disabled/missing credentials or an unsafe runtime is a typed failure reported to the owner; it does not justify omitting four implementations from the initial release. Do not add provider chat adapter injection here; see [WP4](040_wp4_mcp_injection.md).

Composition patch uses the existing shared SQL and EventSink references (`server.ts:317,609-637`, `RuntimeLayer.ts:86`) and must avoid duplicate TextGeneration layers already reached by Git and title work (`server.ts:368`, `RuntimeLayer.ts:300-302`):

```ts
const layerMemoryStore = MemoryStore.layer; // SqlClient comes from shared layerPersistence.
const layerMemoryService = MemoryService.layer.pipe(Layer.provideMerge(layerMemoryStore));
const layerMemoryWorker = MemoryWorker.layer.pipe(
  Layer.provideMerge(layerMemoryService),
  Layer.provide(RuntimeLayer.layerEventSink),
  // Existing shared TextGeneration, registry, settings and owner identity context.
);
const layerMemoryStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* MemoryWorker.MemoryWorker;
    yield* worker.start();
  }),
).pipe(Layer.provideMerge(layerMemoryWorker));
// Provide layerMemoryStarted once into layerRuntimeCoreDependenciesBase.
// Lift/reuse one TextGeneration layer reference if current composition duplicates it.
```

## 7. New values: complete producer/codec/consumer chains

Use `Schema.fromJsonString` + encode/decode Effects for SQL JSON, matching `RemoteReportService.ts:64-70`; no unchecked `JSON.parse` casts. Explicit-field wire serialization lives in WP1 and is invoked at every WP2 boundary; scanner does not bless arbitrary object spread.

| Field/value family                                                                                                                                                   | Creation -> serialization -> deserialization -> every consumer                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brands, `MemoryScope`, `MemoryProjectKey`, `MemoryAssertionKind`, `MemoryProvenance`, operation kind `upsert/forget/resolve/revert`                                  | WP1 validated caller/server stamps -> explicit WP1 operation codec -> service decoder and SQL row codecs -> decider, projection/read filters, history, worker, outbound operation builder; later WP3/WP4/WP5 consume the same schemas. No renamed local public IDs.                                                                                                                         |
| `parents`, `expectedHeads`, revision/result IDs, `payloadRef`, dependency IDs                                                                                        | Caller/stamped operation and generated evidence -> metadata JSON/reference columns; body stored separately -> decoded aggregate -> DAG validation, stale guard, conflict, resolution, revert, tombstone dependency purge, FTS rebuild; WP3 shares explicit operations, never local references without corresponding allowed payload.                                                        |
| `operationDigest`, receipt outcomes `accepted/conflicted/deleted/rejected`                                                                                           | Canonical schema-approved operation -> event digest + receipt JSON -> receipt codec -> retry response, replay, worker idempotence, future receive dedup. Operation ID reuse mismatch returns typed error; rejected receipt contains safe category only.                                                                                                                                     |
| Projection state consumes WP1 MemoryItem (`active/quarantined/forgotten/blocked`), conflict `quarantined/resolving/failed/resolved`                                  | Decider/authorized attempt lifecycle -> CHECK-constrained columns -> row schema -> search/list/read/history, worker eligibility, sync status/report queries, future WP4 snapshots and WP6 UI. Local status must not become an invented wire enum. WP1 exposes corresponding supported view state.                                                                                           |
| Job `sync/revert_intent/summary/consolidate/claim/resolve/rebuild/admin`; `pending/running/retry/completed/cancelled/failed`; `attempt`, ownership, deadline/backoff | Atomic decision or committed hook -> outbox row/metadata codec -> generic dueWork/CAS/execute/sweep/drain/restart only for sync/summary/consolidate/rebuild/admin. claim/resolve/revert_intent are excluded from every generic chain; WP3 alone recovers/schedules them. Reserved hook watermark row is excluded from runnable SELECT. N/A wire: local execution state is not synchronized. |
| `sourceThread`, `sourceWatermark`, message locators, exclusions, operationVersion, consolidation baseline                                                            | Owner committed event read -> job metadata, summary provenance/payload and tombstone exclusions -> schemas -> source snapshot reader, replay/staleness/delete checks, consolidation scheduler; WP4 routes source reads, WP3 shares summary/locator only. Raw transcript serialization is N/A because forbidden.                                                                             |
| Frozen selection, effective provider/model/options, attempt ticket/token                                                                                             | Environment settings at attempt/claim plus actual runner resolution -> job/resolution/provenance JSON; ticket remains local -> typed codecs -> generation routing, authority apply, audit history; WP3 authority consumes token, WP6 displays model/result. Prompt serialization of token/credential is N/A because forbidden.                                                              |
| Import source identity, alias/fingerprint, suppressed bit                                                                                                            | WP5 importer later; WP2 forget/receipt helper -> import receipt/tombstone metadata -> row decoder -> import suppression gate, delete purge, sync suppression builder. No parser/home writes here.                                                                                                                                                                                           |
| Report kind `resolved/failed/reverted`, report ID/category and delivery timestamp                                                                                    | Atomic result/failure/revert -> report-outbox row -> safe row codec -> `pendingReports`; WP6 delivery/ack. WP3 must not replicate report intents. Body/raw cause fields N/A: disallowed.                                                                                                                                                                                                    |
| Scanner allowed/blocked, policy/version/rule IDs/time and local hold                                                                                                 | Pre-admission scanner → metadata-only refusal; approved rescan → canonical-row local flags → safe codecs → eligibility for read/history/model/export/FTS; never matching strings or shared rejection.                                                                                                                                                                                       |
| FTS rows/watermarks/index coverage                                                                                                                                   | Canonical revision → bounded derived scan → generation-fenced index transaction/counter → eligible search JOIN + coverage decoder. Receive does not wait. Tombstone/index invalidation fences stale reads/rebuild; no wire synchronization of index.                                                                                                                                        |

No new client, adapter-turn or auth enum is created in WP2. `memoryContext`, scopes and RPC serialization chains are owned by [WP1](010_wp1_contracts.md) and [WP4](040_wp4_mcp_injection.md).

## 8. Branch scenarios and focused tests

### C-ACTIVATION-GROUNDING — M20 source-runtime obligations (NOT RUN)

All rows are future implementation obligations. Use isolated real stores/services/page codecs,
TestClock and Deferred/persisted milestones; no sleeps, direct cursor assignment or test-only
floor used to fake success. Exact-head source CI must record each actually executed case; suite
collection/build alone is not activation evidence.

#### apps/server/src/memory/MemoryStore.test.ts

| Case                          | Activation                                                                                               | Required observation                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canonical commit crash        | Crash barrier before/after real payload/receipt/cursor page commit; restart and codec replay             | All rollback or all durable, original outcome preserved, no loss/duplicate.                                                                                                          |
| Canonical storage unavailable | Explicit busy/write failure on otherwise writable canonical store, then recover and retry identical page | Cursor unchanged, no rejected hub receipt, safe storage_failed; same approval commits after recovery. Persistent ENOSPC/corruption additionally reports repair requirement; no skip. |

#### apps/server/src/memory/MemoryService.test.ts

| Case                     | Activation                                                               | Required observation                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scanner disagreement     | Hub allows fixture, replica scanner blocks approved receive              | Body retained only canonical; original outcome/receipt and cursor persist. FTS/read/history/source/injection/resolve/summary/export exclude body; unrelated operation proceeds.    |
| Scanner hold then forget | Pull tombstone after held payload, then reinspection/restart             | Canonical held/staged/derived bytes purged; deferred scan/writer cancelled; no revival.                                                                                            |
| Local quota/work full    | Fill local draft/work/index budgets then receive hub-approved operation  | New local creation refuses with original input preserved; approval succeeds canonically, flags/ref only, no duplicated deferred payload.                                           |
| FTS failure              | Actual derived index operation fails while canonical DB remains writable | Receive/cursor commits; index invalid/deferred and safe read/search fence; eligible unindexed read/injection allowed, coverage incomplete; recovery drain restores index coverage. |
| Derived purge failure    | Fail derived cleanup, receive forget, then restore/drain                 | Canonical body absent/exposure blocked/cleanupPending true; no fully-purged claim. After drain actual FTS/derived bytes absent and cleanupPending false.                           |

Tests use isolated SQLite/filesystems/provider fixtures and controllable clock/authority. Inject SQL failure at the named write boundary to prove rollback. After committed thread events, drain `OrchestrationEffectWorkerV2.drain` where a provider/effect initiated the event, then await the persisted summary intent or an EventSink subscription barrier before `MemoryWorker.drain`. A queue that is empty before the event listener enqueues is not proof of completion. Fake generators expose Deferred `started`/`release`; await them for delete/third-head races. No sleep, timeout-to-pass or polling.

The case names below are literal test titles; their assertions also define each guard's observable evidence.

| File (action)                                                                | Test case names and proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/memory/MemoryDecider.test.ts` (NEW)                         | `creates a root only for a never-seen ID`: empty-parent new ID accepted, edited/deleted ID rejected. `parks an edit with missing parents`: pending metadata exists, no active row. `rejects cross-memory parents and cycles`: safe rejection, no payload. `keeps an ordinary edit quarantined`: variant retained, conflict remains. `uses all heads for resolution`: two/three-head inputs required. `stale forget beats every operation kind`: tombstone defeats upsert/resolve/revert. `approved revert restores the explicitly selected original`: pending intent creates no DAG head; hub-approved fresh single-head compensation, parent=result, all originals still in history, no destructive rewrite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/server/src/memory/MemoryStore.test.ts` (NEW)                           | `rolls back each pre-commit failure boundary`: fail payload/event/projection/receipt/outbox/report insertion and compare all table counts to baseline. `preserves committed intent after a lost wakeup`: fresh worker sees complete event/projection/outbox. `serializes concurrent identical operation reservations`: one receipt/sequence/revision. `rejects changed payload under an operation ID`: original receipt/digest unchanged. `removes forgotten text from FTS and payload tables`: direct table/index inspection, then rebuild still absent. `search excludes only quarantined memory`: independent active item returned. `scope filter precedes paging`: foreign user/project/thread does not consume or leak page. `escapes FTS input and caps pages`: metacharacters treated as text; 0/101 rejected; stable page boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/server/src/memory/MemoryService.test.ts` (NEW)                         | `returns the original receipt after replay and forget`: no body resurrection. `rechecks a revoked permit inside the transaction`: Deferred blocks entry, permission revoked, no writes. `purges resolution originals and dependent summaries on forget`: recursive text purge and regenerated summary excludes source. `suppresses known import aliases after forget`: same source/fingerprint cannot get a new ID. `forgets an unseen memory before its delayed revision`: tombstone-first delete receipt. `stale local expected heads do not overwrite`: revision_changed. `received non-ancestral edits quarantine one item`: other memory unaffected. `late resolution and revert lose to tombstone`: no new payload. `revert refuses a later edit or repeated distinct request`: exact head guard; replay same request remains NOOP. `history is metadata-only after forget`: no judgment/original/body. `parked input is retried after its parent commits`: single apply/receipt; cursor metadata preserved.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/server/src/memory/MemorySecretScanner.test.ts` (NEW)                   | `blocks fabricated tokens and PEM private keys`: safe rule IDs without substring echo. `screens input output judgment and originals`: all content-bearing fields traversed. `allows ordinary memory prose`: no blanket block. `unknown secret-bearing fields cannot enter operation encoding`: explicit codec rejection/stripping according to WP1. `pre-admission blocked operation keeps metadata only`: local/hub errors/receipts contain no sentinel; approved replica fixture instead retains canonical payload with local exposure hold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/server/src/memory/MemoryWorker.test.ts` (NEW)                          | `does not generate before summary intent commits`: generator Deferred never triggered by rolled-back intent. `replays committed termination once across restart`: deterministic IDs, one revision. `ignores streaming and rolled-back answers`: source selection assertions. `does not block thread completion on generation`: persisted terminal event before generator release. `rejects output after thread deletion watermark advance or forget`: each race uses Deferred, no output commit. `summarizes only on the source-owning environment`: foreign ScopedThreadRef skipped. `consolidates changed sources at the 24-hour boundary`: 24h-1ms absent, 24h eligible; unchanged absent. `freezes default selection instead of title selection`: full options/instance unchanged after settings edit. `recovers expired work ownership but not a live claimant`: controlled clock/CAS. `defers retry until its stored due time`: 5s/30s/120s/10min boundaries, no busy loop. `requires hub acceptance before resolution commit`: missing authority/expired lease/third head leaves quarantine. `records one safe failure report per attempt`: generator/schema/tool failure, same attempt replay. `pending revert creates no revision or automatic resolution intent`: original head remains active; only an approved compensation can replace it. `drain waits for the current item and excludes future retries`: block/release generator deterministically. |
| `apps/server/src/memory/MemoryMigration.test.ts` (NEW)                       | `upgrades a schema through RemoteReportRelay without importing data`: tables empty and all indexes present. `reruns Memory DDL idempotently`: no duplicate tables or lost metadata. `keeps deletion metadata independent of thread deletion`: no cascade. `rejects invalid enum and duplicate keys`: SQL constraints. `source SQLite FTS removes and rebuilds eligible rows`: real operational source-CI proof; FTS-unavailable migration leaves canonical replication ready. Packaged artifact requires separate same-SHA off-host execution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/server/src/memory/MemoryStore.test.ts` (NEW, additional handoff cases) | `received cursor commits with parked receipt or not at all`: injected failure leaves cursor/input unchanged. `materializes an unbound intent once after checkpoint install`: no fabricated space, retry uses assigned shared IDs, existing published space cannot rebind. `partial checkpoint stays invisible and forget purges staged bodies`: install marker gates reads. `unions 101 suppressed source keys across bounded forget fragments`: replay/second fragment retains every key and no body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/persistence/reconcileGoatMigrationIds.test.ts` (MODIFY)     | `reconciles Memory by stable name after upstream claims its old ID`: history moves, displaced upstream migration runs, memory data survives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/server/src/textGeneration/TextGeneration.test.ts` (MODIFY)             | `routes both memory operations by pinned instance`: six instances, unchanged input selection. `missing instance or operation has no fallback`: typed failure, other instance invocation count zero.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/provider-core/src/server/memoryGenerationPrompts.test.ts` (NEW)    | `treats memory text as data and offers no tools`: bounded prompt and schemas. `rejects oversize input output and unknown evidence`: 256KiB/64KiB exact boundary and extra fields. `conflict prompt contains every input head`: stable order; no omission. `summary partitions at whole-message boundaries`: stable subjob IDs, no partial message facts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/provider-core/src/server/textGenerationOperations.test.ts` (NEW)   | `memory operations omit investigation and attachments`: runner request assertion. `decodes both memory result schemas`: valid results round-trip, malformed output fails. `keeps existing generation results compatible`: title/commit/review shapes preserved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/server/src/textGeneration/CodexTextGeneration.test.ts` (MODIFY)        | `runs both memory operations without tools or checkout configuration`: fake argv/home/cwd and effective alias metadata. `memory isolation failure never falls back to the real home`: spawn count zero.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/server/src/textGeneration/ClaudeTextGeneration.test.ts` (MODIFY)       | `runs both memory operations with tools hooks and MCP disabled`: fake CLI settings/args and empty cwd, selection options/effective model recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/provider-cursor/src/server/textGeneration.test.ts` (MODIFY)        | `both memory operations reject SDK tool execution`: fixture tool denied before side effect. `memory requests refuse unsafe sandbox fallback`: unsupported sandbox/no-tool unavailable, no unsandboxed run. `disabled credential and custom sandbox guards are reported safely`: no result/no fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/textGeneration/GrokTextGeneration.test.ts` (MODIFY)         | `both memory operations reject ACP tools and user input`: runtime callbacks/events, explicit mode. `configured pre-prompt tools prevent generation`: unavailable before prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/provider-grok/src/server/acpSupport.test.ts` (MODIFY)              | `isolated memory policy does not change ordinary agent launch`: isolated args/environment vs baseline mode switch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/provider-opencode/src/server/textGeneration.test.ts` (MODIFY)      | `both memory operations use deny-all temporary sessions`: no selected agent override; effective metadata. `failed or timed-out memory generation removes its session`: Deferred-driven timeout with test clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/server/src/textGeneration/OpenCode2TextGeneration.test.ts` (MODIFY)    | `both memory operations fail after a permission attempt even if text succeeds`: stream fixture; rejected output. `memory stream loss timeout and cleanup are deterministic`: subscribed-first, removal/interrupt evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/server/src/textGeneration/AntigravityTextGeneration.test.ts` (MODIFY)  | `both memory operations keep configuration and tool guards`: global config absent/empty vs nonempty/invalid/oversize; callback denial, tool events, output/timeout limits; unavailable leaves quarantine via worker test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

NEW/MODIFY actions above were checked against this baseline; refresh them on the WP1 parent and do not duplicate an existing test file. Server test fixtures import package implementations through their existing source exports, so all six are exercised in server CI as well as targeted package tests. No live accounts, provider homes, hub connection, user database, or actual remote bot messages are needed.

## 9. Verification commands and execution ownership

**On juns-macbook-pro: typecheck and targeted lint only. Never run bun/pnpm/vp test, Vitest, e2e, a server or any build. No repo-wide check.** The commands here are for the future implementation; they have not been run for this docs-only task. Run from the repository root with installed dependencies; missing dependencies are a prerequisite report, not permission to run installation/build/test here.

```sh
vp exec tsc --noEmit -p apps/server/tsconfig.json
vp exec tsc --noEmit -p packages/provider-core/tsconfig.json
vp exec tsc --noEmit -p packages/provider-cursor/tsconfig.json
vp exec tsc --noEmit -p packages/provider-grok/tsconfig.json
vp exec tsc --noEmit -p packages/provider-opencode/tsconfig.json
```

Coverage proof: `apps/server/tsconfig.json:7` includes `src`, including memory/migration/server/generator/tests; each listed provider `tsconfig.json:6` includes `src`, including the changed server sources and new tests. `tsconfig.base.json:6-7` sets noEmit/importable TS sources, and strict options are lines 11-15. These package checks naturally follow imported contracts/shared/provider sources; they do not recursively invoke workspace scripts. `apps/server/package.json:23` uses `tsc-rs --noEmit`, but direct explicit `-p` above removes working-directory ambiguity. Do not invoke root `package.json:28-29` recursive typecheck.

Targeted lint (all explicit paths are in this phase's map; no bare `vp lint`):

```sh
vp lint --report-unused-disable-directives apps/server/src/memory apps/server/src/persistence/Migrations/069_Memory.ts apps/server/src/persistence/Migrations.ts apps/server/src/persistence/reconcileGoatMigrationIds.ts apps/server/src/persistence/reconcileGoatMigrationIds.test.ts apps/server/src/server.ts apps/server/src/provider/Drivers/AntigravityDriver.ts apps/server/src/provider/Drivers/ClaudeDriver.ts apps/server/src/provider/Drivers/CodexDriver.ts packages/provider-core/src/server/memoryGenerationRunner.test.ts packages/provider-core/src/server/memoryGenerationRunner.ts packages/provider-cursor/src/server/driver.ts packages/provider-grok/src/server/driver.ts packages/provider-opencode/src/server/driver.ts apps/server/src/provider/ProviderHostLive.ts packages/provider-core/src/server/ProviderHost.ts
vp lint --report-unused-disable-directives apps/server/src/textGeneration/TextGeneration.ts apps/server/src/textGeneration/TextGeneration.test.ts apps/server/src/textGeneration/CodexTextGeneration.ts apps/server/src/textGeneration/CodexTextGeneration.test.ts apps/server/src/textGeneration/ClaudeTextGeneration.ts apps/server/src/textGeneration/ClaudeTextGeneration.test.ts apps/server/src/textGeneration/AntigravityTextGeneration.ts apps/server/src/textGeneration/AntigravityTextGeneration.test.ts apps/server/src/textGeneration/GrokTextGeneration.test.ts apps/server/src/textGeneration/OpenCode2TextGeneration.test.ts
vp lint --report-unused-disable-directives packages/provider-core/src/server/memoryGenerationPrompts.ts packages/provider-core/src/server/memoryGenerationPrompts.test.ts packages/provider-core/src/server/textGenerationOperations.ts packages/provider-core/src/server/textGenerationOperations.test.ts packages/provider-cursor/src/server/textGeneration.ts packages/provider-cursor/src/server/textGeneration.test.ts packages/provider-grok/src/server/textGeneration.ts packages/provider-grok/src/server/acpSupport.ts packages/provider-grok/src/server/acpSupport.test.ts packages/provider-opencode/src/server/textGeneration.ts packages/provider-opencode/src/server/textGeneration.test.ts packages/provider-opencode/src/server/v2/textGeneration.ts
```

Coverage proof: every argument is an implementation/test file or the new memory directory, not a root scope. Root lint script establishes the flag at `package.json:30`; configuration in `vite.config.ts:109-125` ignores vendored/build/native generated files but none of these TS paths. Package JSON and workflow YAML are reviewed as structured diffs; the TS lint command does not claim to validate them. If migration numbering moved, substitute its real path in both map and command before execution. Existing unchanged title/preset files are not lint targets.

**CI only**, add this focused step to `.github/workflows/goat-ci.yml`'s existing Test lane; do not copy it into a local verifier:

```yaml
- name: Test memory generation in provider packages
  if: matrix.task == 'test'
  run: >-
    vp test run
    packages/provider-core/src/server/memoryGenerationPrompts.test.ts
    packages/provider-core/src/server/textGenerationOperations.test.ts
    packages/provider-cursor/src/server/textGeneration.test.ts
    packages/provider-grok/src/server/acpSupport.test.ts
    packages/provider-opencode/src/server/textGeneration.test.ts
```

Server cases run through the existing `vp run --filter goat test --shard ...` step (`goat-ci.yml:130-132`, server script `apps/server/package.json:24`). Root test exclude globs (`vite.config.ts:58-67`) do not exclude these paths; server config merges root and adds setup/shard sequencer (`apps/server/vite.config.ts:155-166`). The added explicit provider paths fix the otherwise absent provider-test lane; a test written outside server would not automatically run just because server shards are green. Require executed case counts/no skipped relevant fixtures and exact PR SHA from CI, plus independent review. CI infrastructure failure/cancellation is not a pass. No CI change is made during this document-writing task.

## 10. PR shape, limits and traps

Future implementation PR title: `feat(server): persist memory and run recoverable generation jobs`.

Body gist: GOAT has no shared canonical memory state today. Add a separate transactional memory aggregate, delete-wins/replay/conflict/revert rules, secret screening, durable summary/resolution/report intents and tool-less generation through all six providers. Explain that local commit and hub acknowledgement are different; resolution waits for WP3 authority and bot delivery is WP6. Validation: actual package static command/exit results and exact-head goat-ci tests, never inferred local green. End with the actual model/harness, e.g. `Model: gpt-6.1-sol. Harness: Codex in GOAT.` No PR is created by this task.

Out of scope: hub credentials/HTTP/bootstrap/cursors/lease implementation; transport handlers/MCP/adapter injection/compaction; provider import parsers; bot delivery/client controls; user/internal/structure documentation changes; operating a real hub. See section 11 links. WP2 runs no UI, and changes no client surface. Local/remote/tunnel callers later use the same owning-environment service; no code assumes juns-macbook-pro is the hub. User/project/thread memory isolation is exercised here; source relay transport is WP3, activated by the WP4 readSource service path.

Implementation traps to avoid:

- Event metadata, JSON receipts, pending wire JSON, FTS or diagnostic text containing a second copy of a forgotten body defeats purge. Store references; inspect every table after forget.
- Receipt/job/source suppression cleanup by TTL resurrects old operations/imports. No such retention cleanup in WP2.
- A DAG update decided before the write transaction loses concurrent edits. Read/decide/apply under SQL ownership; CAS is for local execution ownership, not distributed resolution authority.
- A startup scan of projections without committed-event catch-up can miss a terminal transition. Persist hook watermark and summary intent together; replay plus receipt dedup covers the subscriber/startup race.
- `read` filtering alone does not remove sensitive text from history, originals, derived summaries, parked bodies or stale exports. Purge the dependency closure; recheck tombstones on every delayed result.
- A generated `fact` is not certified truth. Preserve its evidence origin; failure to prove evidence references is invalid output.
- Read-only sandbox/plan mode and a prompt saying “no tools” do not enforce tool-less generation. Prove each runner boundary or fail before execution. Custom/global provider configuration can act before callbacks are registered.
- Provider error `detail`/CLI stdout/stderr is not a safe report. Normalize fixed categories; keep immediate causes in Effect error causes only and prevent raw-cause logging.
- The current Codex reception home uses auth symlink/refresh writeback and a real-home fallback (`CodexTextGeneration.ts:97-137`). Memory must fail closed on isolation failure. No test uses a real home; this task must not trigger those paths.
- SQLite body deletion is logical live-state purge, not a claim that historical backups/provider transcripts or all forensic WAL bytes are erased. Never run destructive database rewrites against a live install to manufacture that claim.
- Forget can suppress known source aliases/fingerprints/dependencies; it does not claim arbitrary paraphrase detection. Offline environments can use a remote-deleted memory until receiving its tombstone; WP3 convergence is the guarantee.

## 11. Settled phase boundaries

| Owner            | Assigned implementation against [WP1](010_wp1_contracts.md)                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP1              | Single wire owner: blocked item, source exclusions/suppression fragments, generation execution envelopes, import/admin/report contracts and failure tags. No downstream schema request remains.                            |
| WP2 (this phase) | Create the local tables once; implement atomic foreign apply/checkpoint/draft/outbox/report primitives, candidate reads/refilter and repeatable permit. No dependency on WP3 service classes or WP4 renderer/MemoryAccess. |
| WP3              | Install space/bootstrap binding, implement injected lease authority and hub-only SQL; consume the store ports named in section 3, repair resolver-local reports from accepted replay.                                      |
| WP4              | Adapt live authenticated grants to the WP2 permit, register core RPC/MCP, implement MemorySnapshot/source relay activation and createMemoryEnvironmentAtoms.                                                               |
| WP5              | Populate the existing receipt arms through atomic helpers; parser service and import RPC activation, no migration or separate SQL writer.                                                                                  |
| WP6              | Deliver/ack stable reportId through WP2 claim/ack, consume runtime commands and bounded import receipts; no report schema/table added late.                                                                                |

Completion of this plan task: one new English document, source-grounded change/test/command map and explicit sibling handoffs. Completion of WP2 implementation remains contingent on the static checks and CI evidence described above; neither is claimed by this document.

MemoryPermit is a server-local repeatable Effect<void,EnvironmentAuthorizationError> defined
by WP2; getHubSettings and mutations take it before WP4 adapts request credentials. Report
methods return WP1 MemoryReportDelivery plus stored memorySpaceId/memoryId/attemptId as needed
for the private worker row; claim/ack/failure updates use local worker ownership and same
stable reportId. Forget purges content but retains safe report state/pointer/identity.
read/readHistory use bounded deletion-audit views; sync/checkpoint exporters fragment the
complete suppression union. The migration owns bootstrap codecs/columns once, even if the
WP2 production instance initially has no hub binding.

## Cross-phase contract reconciliation (rev 2)

Aligned projection states and query default with WP1; defined complete local cursor/import/admin/report storage once. Added suppression, candidate/refilter, permit and report-ack ports before consumers; no dependency on later services/renderers.

## Reflection r1 fixes (rev 3)

### G1 local binding persistence and producer

Extend the **existing WP2 Memory migration and section 3 inventory**, not a later WP6 migration.
This table is environment-local and must never be replicated as local project records.

| Table                   | Columns, constraints and codec owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| memory_project_bindings | memory_space_id TEXT, environment_id TEXT, project_id TEXT, project_key_json TEXT nullable, repository_key_json TEXT nullable, version INTEGER NOT NULL CHECK(version>=0), updated_at INTEGER; PK(memory_space_id,environment_id,project_id). JSON decodes WP1 MemoryProjectKey; repository key must be repository arm. Store update replay rows in existing memory_outbox kind admin with namespaced id memory:project-binding:<requestId>, body-free digest/result metadata. No new receipt table. |

| Action              | Exact path                                           | Concrete extension                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MODIFY (NEW in WP2) | apps/server/src/persistence/Migrations/069_Memory.ts | Add CREATE TABLE memory_project_bindings with above PK/checks, same stable Memory migration.                                                                                                 |
| MODIFY (NEW in WP2) | apps/server/src/memory/MemoryStore.ts                | Binding row codec, transactional pin/update/read, typed replay receipt; post-commit changes publication and snapshot/reset barrier.                                                          |
| MODIFY (NEW in WP2) | apps/server/src/memory/MemoryService.ts              | getProjectBinding/updateProjectBinding/resolveProjectKey; use same resolver in readContextCandidates and summary scope assignment. Expose changes as a service stream (transport lands WP4). |
| MODIFY (NEW in WP2) | apps/server/src/memory/MemoryWorker.ts               | Catch up committed project creation/repository identity events and seed pinned fallback through the store; same startup sweep, no new loop.                                                  |
| MODIFY (NEW in WP2) | apps/server/src/memory/MemoryStore.test.ts           | Binding persistence/replay and commit-before-signal cases below.                                                                                                                             |
| MODIFY (NEW in WP2) | apps/server/src/memory/MemoryService.test.ts         | Project scope resolution and deletion signal tests below.                                                                                                                                    |
| MODIFY (NEW in WP2) | apps/server/src/memory/MemoryMigration.test.ts       | Binding table constraints, restart and no copied provider data.                                                                                                                              |

```diff
--- apps/server/src/memory/MemoryService.ts (WP2 inline interface)
+++ apps/server/src/memory/MemoryService.ts
+getProjectBinding(input: MemoryProjectBindingGetInput, permit: MemoryPermit)
+  // Effect<MemoryProjectBinding, MemoryRpcError|EnvironmentAuthorizationError>
+updateProjectBinding(input: MemoryProjectBindingUpdateInput, permit: MemoryPermit)
+  // Effect<MemoryProjectBindingUpdateResult, same errors>
+resolveProjectKey(project: ScopedProjectRef)
+  // internal Effect<MemoryProjectKey|null, MemoryStorageError>
+changes(input: MemoryChangesInput, permit: MemoryPermit)
+  // Stream<MemoryChangeSignal, MemoryRpcError|EnvironmentAuthorizationError>
 // candidate and import scope resolver
-// explicit id is presumed available
+// resolve the persisted binding; explicit key wins, else pinned repositoryKey, else null
```

On first valid project/repository observation, pin repositoryGroupingKeyOf once; first use also
ensures the pin via a short store transaction if the event worker has not caught up. The snapshot
read follows that transaction and then reads the resolved key and candidates consistently. A
remote change never rewrites a pinned key. If no remote exists initially, repositoryKey stays null
until its first valid observation; explicit set remains possible. Deleted/foreign projects fail.
updateProjectBinding repeats memory:write after transaction ownership, verifies project exists,
expectedVersion and request digest; commits key/version/replay metadata atomically. setExplicit
sets the key; useRepository restores the pinned fallback/null. Successful no-change requests
replay without version inflation. Binding changes affect future reads/imports; existing memory
scope/revisions/source receipts are immutable. No model or hub I/O under the binding transaction.

Two machines share a project by separately binding ScopedProjectRef A and B to the same explicit
sharedProjectId. Bindings remain local across disconnect/restart. Shared operations carry only
MemoryProjectKey, so scope matching works after ordinary hub sync without syncing local IDs.

### G3 committed body-free change publication

The service publishes MemoryChangeSignal **only after commit** for local writes, received hub
operations, checkpoint installation and dependent invalidation. Forget emits forget for the
root and invalidate for each derived memory whose payload was purged; all use the committed
projectionWatermark. Signal contains ids/watermark/kind only. Rollback and exact NOOP replay emit
no item signal. Bindings cause a reset after their commit to invalidate project-filtered results.

```diff
 // MemoryStore commit lane; publication is serialized with commit order
-commit(decision); wakeWorker();
+commit(decision); publishCommittedChanges(decision); wakeWorker();
 // foreign apply / completeCheckpoint use this SAME post-commit lane
+// completeCheckpoint publishes reset after the installation commit.
```

Use an app-scoped PubSub plus a subscribe/read-watermark barrier in this existing store lane.
Each subscriber gets reset first, even on initial connect; install subscription before acquiring
current committed watermark and releasing buffered signals. Drop signals <=reset watermark.
No durable body-bearing event stream table. A lost process wakeup/socket/backpressure ends the
subscription; reconnect always resets and refetches committed state, never claims lossless replay.
Do not silently drop an overflowing invalidation queue while leaving the socket healthy. Repeat
the read permit before subscription and each emission; revocation closes it and WP4 evicts cache.

MemorySourceReadAuthority is an optional non-wire method port {readSource(request, permit): Effect<MemorySourcePage, MemoryRpcError|EnvironmentAuthorizationError>}; request uses WP1 validated relay locator fields and is defined here for later WP3 supply. The owner-local committed reader is injected at WP3 composition; WP2 initially exposes no live readSource RPC. Absence yields
source_unavailable; WP2 must not import MemorySyncService or activate source RPC. Purge closure
also emits safe invalidation decisions that WP3 uses to cancel/purge transient source responses.

### Contract chains, activation and CI cases

| Gap / chain                                                                                                                      | Activation / exact future CI case                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 picker → WP1 input → WP2 live permit/row JSON → strict row decode → candidate/summary/import resolver → WP4 snapshot/commands | MemoryService.test.ts: `two environment projects select the same explicit key`; `explicit binding survives remote change and restart`; `unbound project with no repository yields no project candidates`; `use repository restores pinned key without moving memories`; `binding revision mismatch and revoked permit commit nothing`. |
| G1 update → version/digest/result → memory_outbox admin codec → restart/retry                                                    | MemoryStore.test.ts: `binding update and replay receipt commit together`; inject failure at each write; `binding exact retry retains version and changed request id reuse is rejected`. MemoryMigration.test.ts: `binding table keys by space environment and project`.                                                                |
| G3 decider purge → commit → signal allowlist → WP4 RPC stream → runtime eviction → all clients                                   | MemoryStore.test.ts: `rollback emits no forget signal`; `received forget emits after cursor and purge commit`; `derived payload purge emits invalidate ids`; `subscription reset covers commit during subscribe`; `restart resets rather than replaying lost wakeup`. Await Deferred/committed milestones, never timers.               |
| G3 binding/checkpoint commit → reset signal → scope cache generation fence                                                       | MemoryService.test.ts: `binding and checkpoint resets carry only committed watermark`; serialized signal has no synthetic body/judgment/source. Client races are owned by WP4/WP6.                                                                                                                                                     |

All named future test paths above are under apps/server/src/memory/ and must be collected by
the existing goat-ci server shards once implemented; actual case execution is required evidence. This authoring writes no source/migration/test or database and runs no tests. Summary:
G1 now has persisted producers and reverse action; G3 has a shared post-commit publication port.

## Audit r1 fixes (rev 4)

### Final change map additions (audit r1)

| Action | Exact path                                                         | Change                                                                                                        |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| NEW    | `packages/provider-core/src/server/memoryGenerationRunner.ts`      | Inferred bound runner context and trusted explicit envelope helper; no new runtime service.                   |
| MODIFY | `packages/provider-core/src/server/ProviderHost.ts`                | Optional environmentId: EnvironmentId supplied by host; absent identity fails memory generation before spawn. |
| MODIFY | `apps/server/src/provider/ProviderHostLive.ts`                     | Populate environmentId from ServerEnvironmentIdentity, provide layerIdentity without descriptor dependency.   |
| NEW    | `packages/provider-core/src/server/memoryGenerationRunner.test.ts` | Runner metadata cannot originate in model JSON; request/bound instance mismatch denies before invocation.     |
| MODIFY | `apps/server/src/provider/Drivers/CodexDriver.ts`                  | Pass instanceId and generation environment into one-shot factory.                                             |
| MODIFY | `apps/server/src/provider/Drivers/ClaudeDriver.ts`                 | Pass instanceId and generation environment into one-shot factory.                                             |
| MODIFY | `apps/server/src/provider/Drivers/AntigravityDriver.ts`            | Pass instanceId and generation environment into one-shot factory.                                             |
| MODIFY | `packages/provider-cursor/src/server/driver.ts`                    | Pass bound memory runner context.                                                                             |
| MODIFY | `packages/provider-grok/src/server/driver.ts`                      | Pass bound memory runner context.                                                                             |
| MODIFY | `packages/provider-opencode/src/server/driver.ts`                  | Pass bound context to both v1 and v2 text generation factories.                                               |

### B2 — durable conflict-to-claim handoff

MemoryStore.apply commits quarantine plus a bounded canonical claim-candidate flag/head digest
with revision/original receipt/cursor for approved receive. Deferred scheduling materializes the
existing memory_outbox kind claim (`claim:<space>:<memoryId>:<SHA256(sortedHeads)>`) when work
capacity permits; full queue cannot reject receive. Local new admission may reserve its claim row
atomically. Insert-on-conflict preserves retry timing. New frontier updates/coalesces the flag;
resolved, forgotten or changed-head state cancels/fences obsolete execution, and so does a hold whose
reason makes an input head unusable (scanner_pending, secret_detected, missing_parent,
dependency_invalidated). A hold whose only reason is conflicted (plus index/report reasons) keeps the
candidate; the registry reads the canonical variant payloads for generation.

Add MemoryStore ports `readDueClaimCandidates(limit, now)`, `recoverClaimCandidates(now)`,
`claimCandidate(id, epoch, now)` (local ownership CAS), `retryClaimCandidate(id, nextAttemptAt,
failureCode, leaseExpiresAt?)`, `completeClaimCandidate(id)` and `persistResolutionTicket(ticket)`.
Candidate serialization is SQL-only, contains IDs/heads/digest/attempt timing, no variant bodies.
The worker's generic due/sweep/claim/execute excludes claim, resolve and revert_intent: WP3 MemorySyncService/MemoryResolutionRegistry alone owns scheduling and resolve recovery.
Expose a private injected pinned-generation port (not generic `MemoryWorker.executeClaimedResolution`);
WP3 first persists the ticket + kind resolve with pinned selection, then registers runClaimedResolution
in its sole app-scope registry. Registration returns without awaiting generation or accepted apply. WP3 execution
uses WP2's commitAcceptedResolution port with the authority's accepted apply result and retains its slot until its finalizer ends.
No WP2-to-WP3 import or local boolean authority is introduced.

Restart sweep reconstructs absent claim rows from quarantined projections, cancels stale head
sets, and recovers expired local ownership using the existing claimed_until policy. A successful
hub ticket must be persisted before generation; a crash in between releases/retries after lease
expiry, never starts with unrecorded ticket. Canonical receive failure rolls back its minimum
candidate flag; deferred queue insertion failure retains that flag for SQL restart recovery,
without rolling back approved receive. Service/store tests distinguish both boundaries;
WP3 owns registry start/syncOnce activation.

### B4 — replica merge is not hub admission

Add internal, transport-unforgeable admission union to decideMemoryOperation:
`localIntent | hubAdmission | approvedReplica { hubEnvironmentId, memorySpaceId, configurationEpoch, hubSequence, originalReceipt, operationDigest }`; verify receipt/sequence/digest agreement. The context is internal MemoryAdmissionContext, never wire input.
Only authenticated WP3 receive creates approvedReplica; no RPC/MCP/model payload selects it.
Local resolve/revert pre-submit validation and hub admission retain exact-current-head CAS; local revert validation stages an intent only, never a DAG revision. Approved replica
upsert/resolve/revert never repeat that CAS, lease expiry or local default-model checks.
Validate authenticated hub/space/protocol/envelope/digest and genuine DAG consistency; scanner is local exposure only. Preserve approved revision, canonical payload, parents and original receipt/outcome. Missing parents record bounded canonical references/local hold, commit cursor, and reconnect once parent arrives. Boundary-covered ancestry is not missing. Neither local frontier nor expired lease cancels approval.

Compute the ancestry-pruned union of approved result and local unsent frontier. Local heads
that are ancestors of the approved result are consumed; unrelated local heads remain. If a
local head descends from that result, normal DAG frontier pruning retains the descendant. A
A non-ancestral frontier >=2 quarantines only that memory; retain approved result and unrelated local heads. Minimum candidate/repair flags commit with cursor; scheduling can defer at full work/report budgets. Do not rewrite ordinary unsent operations; pending/rejected revert proposals are not heads. Approved result may remain historical under descendants. No receiver sync echo or foreign report. Forget purges every canonical/staged/held/pending/dependent body, cancels claims and invalidates all delayed writers. Scanner-blocked approved payload remains canonical with local hold, not metadata-only replacement.

CI MemoryService.test.ts: `approved resolve and revert preserve unrelated unsent heads`;
`approved descendant has its parent after divergent receive`; `approved forget wins all frontiers`;
`parked approved result replays without replica CAS`; `minimum claim marker commits and rolls back with canonical
quarantine while full scheduler queue defers without stopping receive`. These are real-store tests driven by committed receipts/Deferred, not sleeps.

### B6 — mandatory memory runner envelope

Keep legacy Runner unchanged. Extend textGenerationOperations.ts with inferred contract types:

```ts
type MemoryOperationName = "resolveMemoryConflict" | "generateMemorySummary";
type MemoryRunner = <S extends Schema.Top>(
  request: Request<S> & { readonly operation: MemoryOperationName },
) => Effect.Effect<
  {
    readonly result: S["Type"];
    readonly execution: MemoryGenerationExecution;
  },
  TextGenerationError,
  S["DecodingServices"]
>;
// FromRunnerOptions gains memoryRunner?: MemoryRunner.
// Both shared memory methods call this runner with their result-only outputSchema.
const runMemory: MemoryRunner = options.memoryRunner ?? unsupportedMemoryRunner;
```

At provider construction bind `{providerInstanceId, environmentId}` once: instanceId comes
from each driver's create input; environmentId comes from ProviderHost's new optional identity
field. Define inferred MemoryGenerationRunnerContext and the explicit envelope helper in
packages/provider-core/src/server/memoryGenerationRunner.ts, exporting it through provider-core/
package.json. ProviderHostLive reads ServerEnvironmentIdentity.getEnvironmentId and supplies
that field; provide the existing layerIdentity in its composition (memoized shared layer), never
the descriptor service, so no provider-registry/descriptor cycle is introduced. Package drivers
read the existing ProviderHost service and pass `{providerInstanceId: instanceId,
environmentId: host.environmentId}` to their one-shot factories, including v2 runtime wiring.
An absent environmentId preserves legacy/custom host compile compatibility but memoryRunner
returns typed unavailable before spawn; all built-in production hosts must provide it.
Each memory runner compares modelSelection.instanceId with the bound instance before execution.
No new Context service or provider-create requirement is introduced; package runners never
import apps/server or infer identity from process environment/model output.

```diff
// packages/provider-core/src/server/ProviderHost.ts
+ readonly environmentId?: EnvironmentId; // host identity, not process env vars
// apps/server/src/provider/ProviderHostLive.ts
+ const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
+ const environmentId = yield* identity.getEnvironmentId;
  return ProviderHost.ProviderHost.of({
+   environmentId,
    // existing host fields
  });
// Each of the six driver's constructor calls passes bound context as its new options field.
+ memoryRunnerContext: { providerInstanceId: instanceId, environmentId: host.environmentId }
```

Concrete constructor seams: apps/server/src/provider/Drivers/CodexDriver.ts:276,
ClaudeDriver.ts:194, AntigravityDriver.ts:446; packages/provider-cursor/src/server/driver.ts:210,
packages/provider-grok/src/server/driver.ts:146, packages/provider-opencode/src/server/driver.ts:362
(including its v2 layer factory). The server-side three filenames share the Drivers directory;
the package drivers do not live there. All are in the final change map below.

In each runner factor a private `runSelected(request)` returning decoded result plus trusted
selection metadata; legacy run maps `.result`, memoryRunner wraps exactly `{result, execution}`.
Stamp execution AFTER selection succeeds, before the envelope leaves the runner. Do not run a
second generation or infer effectiveModel by asking the model. Each runner explicitly builds
requestedModelSelection from request, effectiveProvider from its driver, providerInstanceId and
environmentId from bound context; execution is never spread from outputSchema/JSON.

| Runner                                                              | Effective selection producer and wrapping                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodexTextGeneration.ts                                              | Alias lookup at baseline 247-254; capture model sent to --model and full requested options. Same runSelected used by legacy and memory paths.                                                                 |
| ClaudeTextGeneration.ts                                             | resolveClaudeModelSlug/catalog produces resolvedModelSelection; capture model supplied at 205, never raw returned text.                                                                                       |
| provider-cursor/server/textGeneration.ts                            | cursorSdkModelSelection result (id/params) used by Agent.create; capture that id. Set tools: [] and disallowedTools: ["mcp", "task"] on create/resume, mcpServers: {}, no customTools or user hooks/settings. |
| provider-grok/server/textGeneration.ts                              | resolveGrokAcpBaseModelId plus successful applyGrokAcpModelSelection/session setup; use the acknowledged selection. Failure to select produces no execution envelope.                                         |
| provider-opencode/server/textGeneration.ts and v2/textGeneration.ts | parseOpenCodeModelSlug and actual prompt model/Model.Ref; capture the provider/model pair and variant from that selection. Both versions supply memoryRunner.                                                 |
| AntigravityTextGeneration.ts                                        | Successfully selected session model at baseline 219-224; capture it with bound instance/environment; unavailable session returns typed failure.                                                               |

EffectiveModel means runner-resolved model sent/acknowledged by the provider, not independently
verified backend routing. A provider that does not disclose subsequent internal rerouting cannot
justify a stronger claim. Requested options are preserved; no invented actual option values.
Tests in each existing runner test file assert alias/instance/environment provenance and forged
execution rejection; shared textGenerationOperations.test.ts proves legacy result shapes remain
unchanged and both memory methods return the envelope. Scanner runs on decoded result, then
worker consumes allowlisted execution into provenance and resolution records. Add execution
instance/environment fields to effective_provider_model_json codec in this phase's SQL table;
no model-authored metadata can reach it.

B7: the provider SDK/callback limits are individually classified in
[Enforcement inventory](000_plan.md#enforcement-inventory), including Cursor pinned tools policy.

### B8 — mechanical static-input coverage receipt

Final NEW/MODIFY map (including rev 2/3/4 additions): **48 TS/TSX paths**.
Compared path equality/explicit-directory ancestry against every `vp lint` argument and
package ownership against explicit `-p` / exact package-filter typecheck commands: **0 uncovered
lint targets, 0 uncovered typecheck targets** after declared generated-file exclusions.
Typecheck owners: `apps/server/tsconfig.json`, `packages/provider-core/tsconfig.json`, `packages/provider-cursor/tsconfig.json`, `packages/provider-grok/tsconfig.json`, `packages/provider-opencode/tsconfig.json`.
This is path/config reconciliation, not successful compiler/linter execution. Workflow YAML,
package manifests and prose are outside TS lint; review their diffs and validate in CI. At phase P
repeat with the actual diff, compiler file collection and lint ignores; an exit 0 without target
collection is insufficient. Authoring uses Python text checks only; no installation/check runner.

## Reflection r3 fixes (rev 5)

### G1 — staged revert and terminal reconciliation

`revertResolution` rechecks live permission, expected result head, selected unpurged original
and tombstone in the intent transaction. Stage the existing WP1 revert submission with stable
IDs/digest; a second distinct request while this resolution has a pending intent returns
revision_changed. The proposed revision is never queryable as history/DAG and cannot have descendants.
`readEligibleOutbox` includes due revert_intent submissions. Worker generic sweep excludes them;
WP3 push is their sole network owner. Startup retries pending submissions with identical IDs.

acknowledgeOutbox verifies authenticated receipt/digest and atomically incorporates approvedReplica canonical result plus terminal intent settlement; preserve approved payload, purge orphan staging only. Pull-before-ACK repairs once. Accepted status includes localAvailability, not body readiness; FTS/report repair is separate. Hub revision_changed rejection removes proposed intent, records body-free terminal result and no revision/head/report. Transport uncertainty stays pending. Tombstone purges intent and wins late ACK; accepted historical metadata remains with no body. Commit emits body-free invalidation; lost signals recover by reset/restart. History exposes bounded terminal/pending statuses without proposed bodies.

Planned CI: R resolved -> C offline stages T -> H approves U -> restart C with same T -> C
pulls U -> pushes T -> revision_changed -> restart again. Assert final C/H frontier {U}, no T
revision/descendant or repeated claim, no reverted success report, same-ID terminal replay,
pending display recovery, and tombstone cancellation. Use isolated stores and Deferred milestones.

### G2 — registered execution boundary

Ticket persistence and app-scope execution registration are the scheduler's completion boundary.
WP3 runClaimedResolution owns generation, accepted apply/commit, renew/release/cancellation;
WP2 exposes only pinned generation and accepted-commit ports. No generic worker resolve path
or sync transaction/semaphore spans model work.
One attempt per memory, at most four per environment including registering/running/finalizing;
release slot only after execution finalization, not after scheduler returns. App shutdown
interrupts generation/renewal, attempts bounded matching-token release and retains recoverable
SQL state if release cannot reach hub. Restart uses ticket/lease recovery, no untracked launch.
Planned CI observes Deferred generation, shutdown finalization and no late local commit.
This revision specifies future tests; none were run.

## Requirement 7 / M19 (rev 7)

### Transactional admission and SQL amendments

Extend the WP2 migration/MemoryStore SQL mappings, not transport handlers, with:
Wire fields and validation are owned by [WP1 permanent checkpoint wire records](010_wp1_contracts.md#permanent-checkpoint-wire-records-rev-12); map `MemoryIdentityRecord`, `MemoryCompactReceipt`, `MemoryFenceRecord` and `MemorySuppressionRecord` losslessly. This phase defines SQL representation and execution, not a second wire codec.

| Table / change                | Bounded persisted state and atomic owner                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| memory_quota_counters         | PK(space,dimension,scope_key); localIntent/hubAdmission reserve counters transactionally. approvedReplica accounts real usage without capacity refusal. Hub owns space-global logical quotas; device allocations are not combined into admission.                  |
| memory_identity_ledger        | PK(space,memory_id), immutable identity, bounded core deletion/fence/delivery reserve; allocated at creation and retained after forget.                                                                                                                            |
| memory_compact_receipts       | PK(space,operation_id), original operation digest, outcome, sequence, essential IDs and report/retry guard; MEMORY_COMPACT_RECEIPT_MAX_BYTES encoded, unique report delivery key. Replace detailed event/completed_receipt JSON only after checkpoint publication. |
| memory_import_keys            | PK(space,key_kind,key), source identity, alias, accepted digest and suppression relations as unique bounded key rows. No growing JSON arrays; WP5 writes through these earlier ports.                                                                              |
| memory_compaction_state       | Published local checkpoint/boundary, retained revision boundary, one fixed current MemoryStorageSample and safe blocked reason; publication pointer never points at partial staging.                                                                               |
| memory_fts_maintenance_state  | One environment row: persisted open/braked state, changed_at, last available allocation/time, latest measurement availability and coalesced bounded merge work. MemoryFtsMaintenance owns transitions.                                                             |
| memory_storage_samples        | PK(environment,utc_day); at most MEMORY_STORAGE_SAMPLE_MAX_DAYS completed daily rows per environment, not per space. MemoryQuotaService owns bounded codec/upsert/oldest eviction in one transaction.                                                              |
| memory_payloads / resolutions | Add replaced_at, resolved_at, purge_eligible_after and revert_deadline; protect current heads, unresolved conflict, executing resolve and pending revert references.                                                                                               |
| memory_inbox_pending / outbox | Distinguish base_compacted, checkpoint token expiry and ownership; coalesce summary target watermark per thread; completed jobs become compact receipts/watermarks.                                                                                                |

Reserve admission only for localIntent/hubAdmission: upsert/summary/import/resolve/revert submissions, new identity/alias/receipt/report intent and hub checkpoint/log preparation. Reclaim only eligible history/derived detail, then safe capacity_exceeded; failed admission rolls back all writes and preserves original input. No oldest-live deletion. Hub pre-reserves valid forget/cascade and next checkpoint needs inside global budget.

approvedReplica never calls reserveMemoryAdmission for canonical receive/checkpoint install/ACK. It accounts approved bytes/rows and persists bounded canonical-row deferred refs regardless of local quota, protected history, work 10,000-item/32-MiB budget or report backlog. No duplicate payload in deferred queues. Real SQL/ENOSPC/corruption is a storage fault: unchanged cursor, no rejected hub receipt, retry same page after repair.

Creation pre-reserves initial tombstone, required fence and delivery/dedup metadata (including
receipt/log space for that deletion), so reaching ordinary write limits cannot prevent forget.
Reserve bytes/counts are included in totals, not extra capacity beyond the ceiling. Forget
consumes its reserve and immediately purges content, even within retention/revert windows.
Forget (local or received), recursive purge, compactor cleanup, eligible resolved-original
expiry and old-body cleanup during summary replacement are exempt from ALL capacity gates,
including logical quotas and the FTS brake. Their required metadata uses only the existing
pre-reserved forget capacity; normal admission cannot spend it. Before admitting a dependency,
reserve its dependent-summary delete/fence/delivery needs so cascade purge never requires
fresh metadata admission. Cleanup decrements counters atomically and consumes reserve at
full budgets. New replacement bodies still require admission; failed replacement does not
independently authorize discarding the previous body.
This preserves logical growth bounds: cleanup is a net logical decrease. FTS delete-key
allocation can temporarily grow; maintenance reclaims/reuses that space. No instantaneous
physical cap or shared-file shrink is promised.
New local/hub alias/operation admission consumes permanent identity/receipt/key budgets. Already approved aliases, fragments, receipts and checkpoint records preserve hub authority, union deletion knowledge and account locally without reapproval. Compact receipts retain original digest/outcome. Binary record bounds and measured SQL overhead remain distinct.

### Retention, summary and search

A superseded body is retained until replacement + MEMORY_REPLACED_PAYLOAD_RETENTION_MS;
resolution originals/judgment until acceptance + MEMORY_RESOLUTION_PAYLOAD_RETENTION_MS.
Eligible history removal still requires hub ACK, checkpoint recoverability and closed revert window; not every replica ACK. Protect current/conflict/executing/pending-revert inputs. Full protected history refuses new local/hub admission only, never approved receive. Unaccepted pending revert expires at original deadline; accepted replay remains accepted. Retain compact audit after payload purge.

One thread summary MemoryId is mapped durably from ScopedThreadRef; latest eligible watermark
replaces it. Summary/consolidation jobs are receipts and targets, not a growing live history.
MEMORY_THREAD_MAX_SUMMARIES and MEMORY_THREAD_MAX_EXPLICIT_ITEMS are distinct counters.
Imported revisions on an existing MemoryId consume history budget when replacing payload.

FTS indexes eligible active single-head payload.text only, excluding transcripts/tools/source/evidence/originals/judgment/history. MEMORY_FTS_INDEXED_TEXT_MAX_BYTES caps actual index work per local environment/space. Counter and FTS revision/generation update share a derived transaction; failure leaves canonical data/cursor intact and marks index deferred/invalid. Persisted brake gates local new creation/submission and derived addition/rebuild, not approved canonical ingestion/checkpoint. Eligible unindexed content can list/read/inject; coverage/backlog expose missing search coverage. Deletes use exempt path; failed delete uses fence/cleanupPending.
Shadow/index allocation is measured only by post-commit maintenance, never a transaction gate.
Use one unicode61 tokenizer. Explicit substring mode first applies scope filters, counts
candidates and text bytes against MEMORY_SUBSTRING_MAX_ITEMS/MAX_UTF8_BYTES, then scans; if
exceeded return capacity_exceeded and request narrower scope without partial results.
Korean inflection/substring limits remain visible; no hidden trigram fallback.

MemoryFtsMaintenance schedules merge at the earlier MEMORY_FTS_MERGE_TRIGGER_CHANGES or
MEMORY_FTS_MERGE_INTERVAL_MS; steps use MEMORY_FTS_MERGE_MAX_PAGES. Weekly-equivalent optimize
and large-purge optimize are split into bounded steps, never full optimize on request paths.
After committed writes, MemoryFtsMaintenance measures the complete FTS shadow/index inventory
using dbstat outside content mutation transactions; pending FTS writes are not a commit
measurement guarantee. At MEMORY_FTS_ALLOCATED_WARNING_BYTES schedule coalesced bounded
merge/optimize; at MEMORY_FTS_ALLOCATED_BRAKE_BYTES persist braked before publishing status.
Admissions committed before that transition may overshoot: this is a sampled brake, not a
physical hard cap. Refuse local new upsert/import/summary/resolve/revert submissions; preserve user intent. Hub applies only space-global logical admission to requests from other replicas; its own physical FTS brake only delays its index. Approved upsert/checkpoint/ACK always durably receives and marks FTS deferred; forget/cleanup continue.
Persist brake across restart. Only successful maintenance plus fresh complete allocation
below MEMORY_FTS_ALLOCATED_RESUME_BYTES clears it. Missing dbstat returns unavailable,
preserves any brake and still enforces logical counters; do not fail storage setup for it.
Cleanup/deletes continue; maintenance runs off request paths and may write while braked.
Exact-head source server CI executes real SQLite measurement, bounded maintenance, persistent brake/unavailable and M20 receive cases. Packaged desktop is separate mandatory off-host evidence at the same SHA: real artifact/backend launch, measurement/maintenance/restart/forget/unavailable. A desktop build alone is not runtime proof; no nonexistent verifier command is claimed.
Merge/optimize is not DB VACUUM.

Keep shared statev2.sqlite (M1). Do not change DB-wide auto_vacuum/max_page_count or run automatic
full VACUUM from memory migration/maintenance. Existing NONE -> incremental can require whole
DB VACUUM; it is not a local memory-only migration. DELETE frees pages for reuse and need not
shrink the file or keep freelist low. MEMORY_CANONICAL_STAGING_MAX_BYTES is logical memory
budget; actual shared-file size/WAL/freelist are telemetry and separate maintenance concerns.

### N1 single-owner boundary and proof

Generic MemoryWorker dueWork, sweep, recovery, CAS claim AND execute reject claim/resolve/
revert_intent, including direct calls. Remove executeClaimedResolution as a generic execution
entry; WP2 provides only pinned generation and commitAcceptedResolution ports. WP3 registry
owns ticket recovery, slot reservation, registration, renew/apply/release and shutdown.
A durable resolve row is not permission for the generic DrainableWorker to execute it.
WP2 startup may rebuild claim metadata but must not consume/recover resolve ownership.

Required CI in MemoryStore/MemoryService/MemoryWorker tests: every equality/+1 quota,
concurrent writer race, rollback counters, forget reserve at full budgets, ACK/protected-history
retention, clock-driven eligible purge, compact receipt replay/ID reuse rejection, one live
summary through repeated watermarks and forget absent after restart/reindex/checkpoint.
Repeated replace/delete/compact fixture must show logical bytes decreasing and observe
post-maintenance allocation/reuse without assuming every deletion shrinks physical allocation. File-size reduction is a separate isolated-DB
VACUUM case, never a production DELETE guarantee. WP3 joint-start N1 cases below are mandatory.

## Audit r3 fixes (rev 7)

R1/R2 future source CI: real committed SQLite writes near threshold, maintenance measures allocation and persists brake. Local new creation fails, approved upsert/checkpoint succeeds canonically with index deferred, and normal ordered pull reaches later forget. Assert no data loss, deletion absent after restart/rebuild, actual logical admission rollback/equality/+1, bounded maintenance, fresh-below-resume release and restart/unavailable never clearing brake. Actual allocation is not mocked dbstat. source-runtime verified / bundled-runtime pending until same-SHA packaged off-host evidence; no execution here.
R3 production/storage/delta rules and implementation CI follow; no tests ran here.

### Bounded storage sample producer and deltas

MemoryQuotaService.recordStorageSample runs at startup and every MemoryFtsMaintenance cycle
(MEMORY_FTS_MERGE_INTERVAL_MS and earlier change/purge-triggered runs). Measure committed
state using a consistent post-commit read for memory counters/table allocation; record file/WAL
telemetry at the same sampling cycle without claiming a cross-filesystem atomic snapshot.
MemoryStorageSample.memoryLogicalBytes is the canonical/retained/staging aggregate current
logical charge (not a sum of overlapping quota dimensions). Store one fixed current sample in memory_compaction_state, and at UTC day rollover
archive the preceding current sample under its measured UTC day. Upsert by day and evict
oldest completed days atomically: memory_storage_samples never exceeds
MEMORY_STORAGE_SAMPLE_MAX_DAYS. Same-day runs replace current, never append.
Every daily/current row obeys MEMORY_STORAGE_SAMPLE_MAX_UTF8_BYTES and
MEMORY_STORAGE_SAMPLE_MAX_TABLES; unavailable values are null, no growing diagnostics.
Fixed telemetry rows are pre-reserved system metadata within the existing aggregate budget,
not fresh admission per sample; setup reservation cannot borrow forget reserve. Cleanup at
full budgets never depends on successful sample recording. No per-request page scans.

MemoryQuotaService.readStorageGrowth compares current to the stored sample for exactly
current.utcDay minus 1/7/30 UTC days, reports actual endpoint timestamps/elapsedMs and signed
byte differences. Thirty completed daily rows plus current allow 30-day comparison without
31 ring rows. Missing days are not interpolated: missing_baseline returns null delta.
Ring and current persist through restart. Startup archives only the prior sample's actual
day; it never fills days the process missed. Backward clock/day or non-increasing endpoint
time returns clock_discontinuity until comparable endpoints exist; never overwrite a later
sample with an earlier timestamp.

Logical metrics come from committed counters; memoryAllocatedBytes from complete allowlisted
memory dbstat groups including FTS, without double counting. dbFileBytes/WAL/freelist describe
the WHOLE shared DB. Failed/unsupported reads yield partial if some metrics exist, unavailable
if none. Delta availability is per metric: missing allocation never becomes zero growth just
because logical metrics exist. Do not attribute shared DB/WAL/freelist growth to memory.

MemoryStore/MemoryService CI: 31+ UTC days retain exactly 30 completed rows plus current;
same-day replacement, exact 1/7/30 baselines and signed deltas, missed days/partial dbstat,
clock rollback, bounded encoding and restart-preserved delta. A non-memory table/WAL growth
fixture changes shared metrics while memory logical/allocated metrics stay unchanged.

## M20 replan (rev 8)

Directly separates local/hub admission from approved canonical receive, with single payload storage, durable local holds, independent bounded generation-fenced drain and delete-wins. Replaced FTS setup/quota/brake/CI expectations; owning store/service activation sections cover crash/storage/scanner/quota/index/purge. Source CI differs from mandatory packaged off-host evidence.

Docs-only amendment; no source edits, installation, tests, builds, server/user-data writes, commit
or push. All newly specified runtime/CI cases are NOT RUN; no runtime CLOSED or requirement 7
completion is claimed.

## Reflection r7 fixes (rev 9)

- G1: a conflict-only exposure hold no longer cancels claim/resolve. Cancellation is limited to resolved, forgotten or changed heads and to holds that make an input head unusable (scanner_pending, secret_detected, missing_parent, dependency_invalidated).
- G2: `scanner_pending` is a MemoryFailureCode and an allowed blocked-arm code meaning "replica-local scan not finished"; it clears on the first allowing scan, unlike secret_detected.
- CI (PR CI only): (a) two-head conflict with clean scanner and linked parents, received through normal pull, is claimed and auto-resolved while the item reports exposure held with reason conflicted; (b) the same conflict with one head in scanner_pending or missing_parent keeps the candidate unscheduled and starts generation once the hold clears; (c) a single-head approved revision read while its scan is stopped with a Deferred returns the body-free blocked arm with failureCode scanner_pending and becomes active after the scan allows it.

- Reflection r8 G3 (rev 9a): the no-automatic-release rule now applies only to secret_detected. Initial scanner_pending is released by the automatic first scan that the receive commit schedules and restart recovers; CI case (c) above also restarts between receive and scan and expects the item to become active without a rescan request.

## Audit r5 fixes (rev 10)

- R6: deferred drain order (due_at, last_attempt_at NULLS FIRST, memory_id, kind), per-sweep item/byte caps, exponential backoff capped at 1 h, held rows excluded, SQL-resident order for restart. CI (MemoryService.test.ts): failing rows with low ids plus a held row ahead of a healthy row; the healthy row completes by the second sweep, the held row is never selected, caps hold, restart preserves order.
- R7: secret_detected release only through MemoryWorker policy-version rescan (start and scanner policy upgrade). CI: hold recorded under policyVersion N, start with N+1 allowing the text, item becomes active; a forget committed before the rescan wins and the rescan is cancelled. No explicit rescan entry point.

## WP1 code review r1 handoff (2026-10-14)

- Checkpoint report-guard digests: WP1 now validates only digest format and structural links. WP2 computes and verifies the report-id formula with Node crypto before WP3 installs a snapshot; contracts carry no SHA-256 implementation.
