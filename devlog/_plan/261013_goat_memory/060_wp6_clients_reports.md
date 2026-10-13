# 060 — WP6: Clients and reports

Enforcement limits and claim wording: [000 Enforcement inventory](000_plan.md#enforcement-inventory). Audit r1 rev 4 amendments supersede incompatible rev 2/3 recipes.

Status: executable implementation plan; no runtime implementation or verification claimed.
Baseline: `goat-si/goat`, `origin/dev` / HEAD `1e2418faf`, branch
`goat/goat-cross-device-provider-memory`, inspected 2026-10-13.
Authority: [000_plan.md](000_plan.md), especially Decisions, Shared names and the work-phase map.
[001_architect_proposal.md](001_architect_proposal.md) supplies M1–M18 reasoning; WP0's
amendments win: all six providers generate from the first release, forget purges GOAT payloads
while keeping provider transcripts, and the first hub is a settings choice, never a hostname constant.
This document meets `DIFFLEVEL-ROADMAP-01`. Original phase authoring wrote this file; rev 2 reconciles the allowed plans.

## 1. Purpose and predecessor acceptance

Make memory manageable from web, desktop and mobile, and make automatic resolution observable.
A person can save a scoped memory, distinguish local acceptance from sharing, inspect conflicting
originals and the applied resolution, revert once when its result is still current, forget, and
see the deletion metadata after the bodies disappear. Settings, search, command palette and report
links must route to the same owning environment and the same client-runtime commands.

WP6 owns M11's report consumer and M15's client surfaces. It consumes M1–M10 and M12–M18;
it does not reimplement their storage, lease, scanner, provider or authorization decisions.

| Producer | Required result before integrating WP6                                                                                                                                                                         | Evidence needed from that phase                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| WP1      | Shared names in `packages/contracts/src/memory.ts`; schemas, RPC methods, `memory:read/write/sync`; descriptor capability; additive report reference; typed failures and bounded pages                         | Contract round-trip, legacy omission and invalid-union tests on that PR head             |
| WP2      | `MemoryItem`, `MemoryConflict`, `MemoryResolution`, tombstone-safe history; atomic report intent in `memory_report_outbox`; stable receipts; all six `resolveMemoryConflict` / `generateMemorySummary` runners | Delete-wins, replay, stale-revert and generation-failure tests; no body in reports       |
| WP3      | `MemorySyncStatus`, `MemoryHubSettings`; connect/disconnect/credential rotation; bootstrap before outbox; durable progress; fresh status following reconnect                                                   | Three-environment scenario and credential tests; no automatic hub promotion              |
| WP4      | `packages/client-runtime/src/state/memory.ts` queries and guarded commands, exports and all destination permission checks; bounded invalidation/reload strategy                                                | Read-only, revocation, reconnect, scope and all six adapter input tests                  |
| WP5      | Import discover/preview/apply/status through the existing `memory.importProvider` name; cancel stops subsequent bounded calls; stable operation receipt and scope mapping; safe counts/reasons                 | Repeat NOOP, forgotten-source suppression, cancellation and source-byte invariance tests |

All predecessor fields are settled in 010 rev 3; section 10 assigns consumers, never a web-only
wire shape. Integrate WP6 against the reviewed predecessor heads; refresh cited lines after rebase.
The inspected baseline contains no memory implementation yet.

## 2. Source evidence and implementation anchors

These are verified baseline anchors, not claims that proposed code already exists.

| Current source                                                                  | Constraint / edit anchor                                                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/routes/settings.storage.tsx:1`                                    | Four-line file-route pattern; add `/settings/memory` in the same form                                                                               |
| `apps/web/src/routes/settings.tsx:46`                                           | Scope boundary; unavailable selection must remain unavailable                                                                                       |
| `apps/web/src/routes/settings.tsx:154`                                          | Provider settings alone currently request `singleEnvironment`; memory requires explicit single-destination handling                                 |
| `apps/web/src/components/settings/settingsScopeAxis.ts:58`                      | `selectSingleEnvironmentScope` selects primary/connected fallback when no machine is specified; do not use it to silently pick memory's destination |
| `apps/web/src/components/settings/SettingsScopeSentence.tsx:33`                 | Device-only pages; memory must not join this set                                                                                                    |
| `apps/web/src/components/settings/SettingsScopeSentence.tsx:63`                 | Existing sentence says “Applying settings”; memory scope is record ownership/filtering, not a settings bulk write                                   |
| `apps/web/src/components/settings/settingsSearch.ts:16`                         | `SettingsPath`; add path, label, anchors and capability filtering together                                                                          |
| `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts:23`        | Availability comes from actual environment descriptors; global “some server supports it” is insufficient for an explicit machine                    |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx:70`                    | Icons and generated navigation must agree with search availability                                                                                  |
| `apps/web/src/components/CommandPalette.tsx:2335`                               | Settings search already populates palette; its navigation currently supplies no explicit machine                                                    |
| `apps/mobile/src/Stack.tsx:220`                                                 | Native settings stack registration, linking and inferred screen parameters                                                                          |
| `apps/mobile/src/features/settings/SettingsRouteScreen.tsx:166`                 | Shared settings rows; local and cloud configurations must both expose memory                                                                        |
| `apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx:35` | Explicit `EnvironmentId` route and keyed per-environment local request state                                                                        |
| `apps/mobile/src/features/keyboard/CommandPalette.tsx:180`                      | Native action collection; add Memory here too                                                                                                       |
| `packages/client-runtime/src/state/channels.ts:23`                              | Existing query/command construction pattern; memory counterpart belongs to WP4                                                                      |
| `packages/client-runtime/src/state/runtime.ts:785`                              | Mutation helper authorizes destination at execution and exposes `permissionAtom`                                                                    |
| `apps/server/src/channels/ChannelBotTimeline.ts:35`                             | `record` accepts a `ChannelTimelineRecord` and deterministic revision; returns committed sequence                                                   |
| `apps/server/src/channels/ChannelBotTimeline.ts:89`                             | Transport `sourceOf` resolves only input/task; taskless memory reports cannot use this `send` path unchanged                                        |
| `apps/server/src/channels/ChannelBotRegistry.ts:123`                            | `ensure` calls `home.requireHome`; resolving environment can differ from `goatBotHome`                                                              |
| `apps/server/src/orchestration-v2/Orchestrator.ts:7730`                         | Timeline command checks canonical bot membership and upserts stable item IDs without provider work                                                  |
| `packages/contracts/src/channelCommon.ts:102`                                   | Additive metadata location; keep existing `result` / `failure` kinds                                                                                |
| `packages/contracts/src/channelLedger.ts:297`                                   | Existing message entry can carry memory report metadata without a task chip                                                                         |
| `packages/client-runtime/src/goatBot/readers.ts:84`                             | Metadata becomes presentation; report target must survive this transformation                                                                       |
| `packages/client-runtime/src/goatBot/rows.ts:202`                               | Presentation becomes bot rows; add target propagation here, not only in readers                                                                     |
| `apps/web/src/components/goatBot/GoatBotTimeline.tsx:100`                       | Bot row renders plain text, not a navigable Markdown link                                                                                           |
| `apps/mobile/src/features/goat-bot/GoatBotScreen.tsx:93`                        | Native row rendering likewise needs an explicit details action                                                                                      |

Also read: `AGENTS.md`; `docs/internals/effect-services.md:11`, `:95`, `:107`;
`docs/internals/overview.md:3`, `:23`, `:53`; `docs/internals/channels.md:19`, `:29`;
`docs/internals/connection-runtime.md:63`; `docs/internals/web-ui.md`;
`docs/user/permission-modes.md`, `docs/user/remote-access.md`;
`structure/manifest.json`, `structure/INDEX.md:7`, `structure/AGENTS.md:8`;
`.agents/skills/test-t3-app/SKILL.md:15`, `.agents/skills/test-t3-mobile/SKILL.md:31`.
Research inputs: `/Users/jun/Developer/goat_initiative/research/120_goat_memory_source_terrain.md:105`
and `/Users/jun/Developer/goat_initiative/docs/080_memory.md:61`. Historical research is a design
input; current source anchors above establish the actual client/report seams.

## 3. File change map for the future WP6 PR

Each row is an exact path. NEW means absent at the inspected baseline; MODIFY means existing.
No DELETE is required. Predecessor-owned modifications are listed separately in section 10.

| Action | Path                                                                         | Reason / concrete change                                                                                                              |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| NEW    | `apps/web/src/routes/settings.memory.tsx`                                    | Memory route with validated record deep-link search; preserve explicit machine                                                        |
| NEW    | `apps/web/src/components/settings/MemorySettings.tsx`                        | Bounded list/search, editor, details/history, conflicts, sync, hub and import controls                                                |
| NEW    | `apps/web/src/components/settings/MemorySettings.logic.ts`                   | Pure target/deep-link/form derivation; no transport or secret storage                                                                 |
| NEW    | `apps/web/src/components/settings/MemorySettings.logic.test.ts`              | Target validation, scope construction, stale draft and deep-link behavior                                                             |
| NEW    | `apps/web/src/components/settings/MemorySettings.test.tsx`                   | Interactive save/revert/forget/error behavior with a runtime boundary fixture                                                         |
| NEW    | `apps/web/src/state/memory.ts`                                               | Instantiate WP4 atoms with existing `connectionAtomRuntime`, like channels                                                            |
| MODIFY | `apps/web/src/routes/settings.tsx`                                           | Memory boundary preserves explicit destination; bypass settings bulk-target boundary only for this page; reset local draft by machine |
| MODIFY | `apps/web/src/components/settings/SettingsScopeSentence.tsx`                 | Memory sentence: “Memory on <environment>”; explicit picker, no All environments write target or project override sentence            |
| MODIFY | `apps/web/src/components/settings/settingsSearch.ts`                         | Add path/label, memory anchors and `requiresMemory` / `hasMemory` availability fields                                                 |
| MODIFY | `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts`        | Compute memory availability for selected destination; capability missing means unavailable                                            |
| MODIFY | `apps/web/src/components/settings/SettingsSidebarNav.tsx`                    | Memory icon and same capability decision as settings search                                                                           |
| MODIFY | `apps/web/src/components/settings/settingsSearch.test.ts`                    | Search aliases/anchors and mixed-capability/explicit-machine matrix                                                                   |
| MODIFY | `apps/web/src/components/CommandPalette.tsx`                                 | Route memory search hits with explicit contextual machine or chooser; preserve ordinary settings behavior                             |
| MODIFY | `apps/web/src/components/CommandPalette.logic.test.ts`                       | Memory navigation selection rules; no destructive palette shortcuts                                                                   |
| MODIFY | `apps/web/src/routeTree.gen.ts`                                              | Generated registration after adding the route; generate off this Mac without hand-editing route types                                 |
| NEW    | `apps/mobile/src/state/memory.ts`                                            | Instantiate the same WP4 runtime atoms                                                                                                |
| NEW    | `apps/mobile/src/features/settings/SettingsMemoryRouteScreen.tsx`            | Native editable management screen; chooser when no destination; full reverse actions                                                  |
| NEW    | `apps/mobile/src/features/settings/SettingsMemoryRouteScreen.logic.ts`       | Native navigation/search adapter sharing runtime presentation                                                                         |
| NEW    | `apps/mobile/src/features/settings/SettingsMemoryRouteScreen.logic.test.ts`  | Explicit destination, grouped/all filters, disappeared environment and record selection                                               |
| NEW    | `apps/mobile/src/features/settings/SettingsMemoryRouteScreen.test.tsx`       | Native interaction harness: permission revocation, stale result and failure retention                                                 |
| MODIFY | `apps/mobile/src/Stack.tsx`                                                  | Import/register `SettingsMemory`, linking `memory`, typed optional environment and record params                                      |
| MODIFY | `apps/mobile/src/features/settings/components/settings-sheet-targets.ts`     | Add `SettingsMemory` target, keep existing union values                                                                               |
| MODIFY | `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`                  | Memory row in both local/cloud variants; multi-environment filter opens chooser, never broadcasts                                     |
| MODIFY | `apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx` | Memory link for this exact environment and advertised capability                                                                      |
| MODIFY | `apps/mobile/src/features/keyboard/CommandPalette.tsx`                       | Native “Memory” action with scope/capability-aware destination                                                                        |
| MODIFY | `apps/mobile/src/features/keyboard/commandPaletteItems.test.ts`              | “memory”, “forget”, “conflict”, “sync” discoverability without executing a mutation                                                   |
| NEW    | `packages/client-runtime/src/memoryPresentation.ts`                          | Shared pure status labels, action eligibility and report target mapping from contracts                                                |
| NEW    | `packages/client-runtime/src/memoryPresentation.test.ts`                     | Cross-client status/permission/stale-revert decision matrix                                                                           |
| MODIFY | `packages/client-runtime/package.json`                                       | Add `./memory-presentation` subpath export; WP4 owns `./state/memory`                                                                 |
| MODIFY | `packages/client-runtime/src/goatBot/readers.ts`                             | Decode optional `memory` report reference into a details target                                                                       |
| MODIFY | `packages/client-runtime/src/goatBot/rows.ts`                                | Carry target into bot row; do not create task/reply/question state                                                                    |
| MODIFY | `packages/client-runtime/src/goatBot/readers.test.ts`                        | Old metadata remains plain text; valid report references survive                                                                      |
| MODIFY | `packages/client-runtime/src/goatBot/rows.test.ts`                           | Report never creates replying indicator; target and stable row identity survive replay                                                |
| MODIFY | `apps/web/src/components/goatBot/GoatBotTimeline.tsx`                        | Explicit View memory action; route with machine + IDs, gated by memory read                                                           |
| MODIFY | `apps/mobile/src/features/goat-bot/GoatBotScreen.tsx`                        | Same action opens `SettingsMemory`; resolving environment retained                                                                    |
| NEW    | `apps/server/src/memory/MemoryReportAdapter.ts`                              | Effect service consumes report outbox through WP2 worker; runless timeline bridge                                                     |
| NEW    | `apps/server/src/memory/MemoryReportAdapter.test.ts`                         | Atomic intent replay, delivery/ack crash, non-home bot, no body and no provider run                                                   |
| MODIFY | `apps/server/src/channels/ChannelBotRegistry.ts`                             | Internal `ensureForReport(owner)` reuses canonical creation/replacement without changing bot home                                     |
| NEW    | `apps/server/src/channels/ChannelBotRegistry.test.ts`                        | Report-only non-home creation/replacement; public ensure/ingress still reject non-home                                                |
| MODIFY | `apps/server/src/server.ts`                                                  | Compose report adapter once with existing channel and memory layers                                                                   |
| MODIFY | `apps/server/src/memory/MemoryWorker.ts`                                     | WP2-created file: inject adapter into existing drainable report pass; do not add another background loop                              |
| NEW    | `docs/user/memory.md`                                                        | Tasks: choose hub, scoped save/import, pending sharing, inspect/revert/forget and source-unavailable                                  |
| MODIFY | `docs/user/remote-access.md`                                                 | Concise memory permissions and link to memory workflow; no protocol field catalog                                                     |
| MODIFY | `docs/internals/channels.md`                                                 | Explain report-only non-home bot boundary; preserve home restriction for interactive ingress                                          |
| NEW    | `docs/internals/memory.md`                                                   | If not already introduced by WP2/3, own canonical-store/delete/revert/fencing/offline constraints; otherwise MODIFY that exact file   |
| MODIFY | `docs/internals/overview.md`                                                 | Link memory constraints and distinguish memory ownership from settings bulk targeting                                                 |
| NEW    | `structure/memory.md`                                                        | If not already introduced upstream in this stack, current memory boundary after integration; otherwise MODIFY                         |
| MODIFY | `structure/manifest.json`                                                    | Add/extend memory module entry and actual client/report source paths; no duplicate entry                                              |
| MODIFY | `structure/INDEX.md`                                                         | Derive reading order and inverse source map from manifest following `structure/AGENTS.md`                                             |

`apps/desktop` needs no shell/IPC changes: its renderer uses the web route and runtime. It still
needs a real packaged-client pass. `.github/scripts/pr-screenshot-gate.cjs` needs no modification.
NEW/MODIFY for predecessor-created files must be reconciled against the final WP5 tree before coding.

## 4. Concrete changes and code skeletons

### 4.1 Route and destination ownership

Before: `settings.storage.tsx:1` registers Storage; `settings.tsx:154` normalizes Provider scope
through a helper that can choose a primary environment. After: memory has its own guarded target
resolver. Do not just add memory to the Provider `singleEnvironment` boolean: that helper's default
selection at `settingsScopeAxis.ts:58` would turn an unset target into an implicit destination.

```tsx
// NEW apps/web/src/routes/settings.memory.tsx
import { createFileRoute } from "@tanstack/react-router";
import { MemorySettings } from "../components/settings/MemorySettings";
import { validateMemorySearch } from "../components/settings/MemorySettings.logic";

export const Route = createFileRoute("/settings/memory")({
  validateSearch: validateMemorySearch,
  component: MemorySettings,
});
```

`validateMemorySearch` decodes optional `memoryId` / `resolutionId` using WP1 branded schemas;
reject mismatched IDs at read time. The parent continues validating `machine/project/checkout`.
These URL fields are navigation state, not new RPC fields. Sidebar links retain them only on the
memory page; leaving the page clears record IDs. Report links explicitly clear project/checkout
and set machine so `retainSettingsScope` (`settingsScopeNavigation.ts:27`) cannot inherit a
previous environment. Browser history preserves the explicit machine.

```diff
// apps/web/src/components/settings/settingsSearch.ts:16,95
 export type SettingsPath =
+  | "/settings/memory"
   | "/settings/projects"
 // SETTINGS_SECTION_LABELS
+  "/settings/memory": "Memory",
 // SettingsSearchItem / SettingsSearchAvailability
+  readonly requiresMemory?: boolean;
+  // Availability interface only:
+  readonly hasMemory: boolean;
```

Add real anchors `memory-items`, `memory-conflicts`, `memory-history`, `memory-sync`, `memory-hub`,
`memory-import`; aliases include remember, forget, resolution, revert, sharing, Codex, Claude, omo.
All use `requiresMemory`. Filtering checks the explicit destination, otherwise offers supported
environment selection. Direct URLs to unsupported/missing environments show an update/reconnect
notice without issuing memory RPCs. At most one eligible environment may be selected automatically
when opening from a known thread/environment context; absence of context shows the chooser even
if only one environment is connected. No mutation runs merely by navigating.

Memory's sentence uses only the environment picker. The record scope picker is inside Memory:
User, Project (`MemoryProjectKey`), Thread (`ScopedThreadRef`). Global Settings project filters can
prefill a valid project candidate, but cannot change hub settings or multiply memory mutations.
Ambiguous/missing project mapping disables project save and explains the required mapping.

### 4.2 Shared runtime and screen mutations

```ts
// NEW apps/web/src/state/memory.ts and apps/mobile/src/state/memory.ts
// Export name is a WP4 handoff requirement, not an existing baseline export.
import { createMemoryEnvironmentAtoms } from "@goat/client-runtime/state/memory";
import { connectionAtomRuntime } from "../connection/runtime";
export const memoryEnvironment = createMemoryEnvironmentAtoms(connectionAtomRuntime);
```

The WP4 factory must expose search/list/read/history/syncStatus, upsert/forget/revertResolution,
readSource/importProvider, projectBinding get/update, changes invalidation state, and hubSettings get/update under Shared names. Mutation callers supply
`{ environmentId, input }`; buttons read that command's `permissionAtom(environmentId)` as in
`state/runtime.ts:785`. WP6 adds presentation, not raw RPC clients or a new runtime.

```ts
// NEW packages/client-runtime/src/memoryPresentation.ts — pure eligibility sketch
// Use MemoryItem / MemoryResolution fields finalized by WP1, not UI-authored mirrors.
export function canRevertMemoryResolution(input: {
  readonly permitted: boolean;
  readonly connected: boolean;
  readonly forgotten: boolean;
  readonly currentHeads: readonly string[];
  readonly resultRevisionId: string;
}) {
  return (
    input.permitted &&
    input.connected &&
    !input.forgotten &&
    input.currentHeads.length === 1 &&
    input.currentHeads[0] === input.resultRevisionId
  );
}
```

Use branded revision types in the implementation once WP1 lands. UI eligibility is advisory;
the server repeats the head/tombstone/grant check. Save captures `MemoryOperationId` once per
submit and reuses it when transport outcome is unknown. Editing a committed item sends its
current `expectedHeads`; an intentional new edit gets a new operation ID. Retain draft and
show typed errors after ordinary rejection; a committed remote forget/reset clears body-derived drafts (rev 3 below). Do not optimistically label the item shared or remove it on
forget until local acceptance is authoritative. After acceptance, refresh scoped list/detail,
history/conflict and sync status through WP4's invalidation; after disconnect, clear bodies, originals, source results and body-derived drafts; retain safe status metadata only. Changing environment clears draft, pagination and
late responses from the previous destination. Read-source never substitutes a same-ID local thread.

Revert is one action using `resolutionId`, explicit selected `restoredRevisionId` and `expectedHeads == [resultRevisionId]`; original
selection/restore semantics are owned by WP2 and shown before pressing it. Do not make the user
reconstruct an old body. `revision_changed` retains current content and refreshes eligibility.
Forget explains GOAT body purge and unchanged provider transcripts, accepts cancellation, then
shows metadata-only history. There is no undelete; explicit re-remember is a new MemoryId.

### 4.3 Native registration and report navigation

```tsx
// MODIFY apps/mobile/src/Stack.tsx:220, inside SettingsContentStack.screens
SettingsMemory: createNativeStackScreen({
  screen: SettingsMemoryRouteScreen,
  linking: "memory",
  options: { title: "Memory" },
}),
// NEW screen accepts StaticScreenProps with optional EnvironmentId, MemoryId,
// MemoryResolutionId. No environment => chooser; invalid explicit ID => unavailable.
```

The shared settings row and palette open this route. An environment detail or report passes
`environmentId`; a report also passes `memoryId` / `resolutionId`. Mobile renders editor, status,
history, source access, revert, forget, hub disconnect/rotation and import cancellation with the
same permission semantics. Reuse SettingsScreen/SettingsSection/SettingsActionRow and web UI
variants; no restyling shared UI internals or continuously repainting activity indicators.

### 4.4 Runless durable reports

Before: `ChannelBotTimeline.ts:138` rejects a taskless/inputless transport message.
After: `MemoryReportAdapter` calls `ChannelBotTimeline.record` directly, bypassing the channel
transport's source lookup, not its timeline commit. Keep existing transport behavior unchanged.
It is a small Effect service with Context.Service, private make and exported layer, following
`effect-services.md:40`; WP2 MemoryWorker's report pass invokes it after committed intent.

```ts
// NEW apps/server/src/memory/MemoryReportAdapter.ts — inside private make
// report is decoded WP2 outbox metadata; bot owner is server-owned, not request input.
const deliver = (report: CommittedMemoryReport) =>
  Effect.gen(function* () {
    const bot = yield* bots.ensureForReport(owner);
    const sequence = yield* timeline.record({
      threadId: bot.threadId,
      record: {
        recordKey: `memory-report:${report.reportId}`,
        entry: {
          type: "message",
          role: "assistant",
          text:
            report.outcome === "failed"
              ? "Memory resolution failed. View Memory for details."
              : report.outcome === "reverted"
                ? "Memory resolution reverted. View Memory for details."
                : "Memory conflict resolved. View Memory for details.",
          meta: {
            conversationId: conversationIdFor({
              ownerId: owner.ownerId,
              kind: "goat",
              connectionId: "goat",
              conversationKey: owner.ownerId,
            }),
            originKind: "goat",
            kind: report.outcome === "failed" ? "failure" : "result",
            memory: {
              memorySpaceId: report.memorySpaceId,
              environmentId: report.resolvingEnvironmentId,
              memoryId: report.memoryId,
              ...(report.resolutionId === null ? {} : { resolutionId: report.resolutionId }),
            },
          },
        },
      },
      revision: "v1",
    });
    return { sequence, reportThread: { environmentId: bot.environmentId, threadId: bot.threadId } };
  });
```

`CommittedMemoryReport` is an illustrative local worker row type, not a new Shared names schema.
Use WP2's decoded row fields and WP1 MemoryReportDelivery; do not add report fields here. A failed attempt uses its stable attempt
operation ID, not a random delivery ID. Report once per committed resolution, terminal failed
attempt or revert; suppress per-renewal/backoff spam. Pulling a foreign result updates Settings
but never enqueues another Bot report. A revert requested elsewhere reports on the recorded
resolving environment via stable resolver-local repair marker at accepted receive; delivery/report backlog is deferred, never gates cursor. Offline origin shows pending revert; approved outcome may coexist with local body hold and report pending.

`ensureForReport` is internal-only: extract canonical ensure logic from `ChannelBotRegistry.ts:123`;
public `ensure` still first calls `home.requireHome`; report ensure does not. Never expose this
method as RPC/MCP, alter `goatBotHome`, start reception/Slack, adopt a running legacy agent, or
create a coding task. Resolve/recreate the canonical bot on the resolving environment and use
that environment's trusted owner identity. If it cannot be created, leave the outbox pending.

Worker ordering: claim row under WP2's worker fence -> deliver -> await returned timeline sequence
-> persist delivery acknowledgement. Crash before dispatch retries intent; crash after timeline
commit before ack retries the identical command/record key. `timelineIdsFor` includes thread;
if the old bot was deleted, retry can deliver once into its canonical replacement, never two live
rows in the same bot. A delivered row is not replayed into future replacement bots.

The delivery ack stores its `reportThread: ScopedThreadRef` with the committed sequence.
`memory.history` on the resolver exposes a local report-delivery status and that pointer without
copying Bot rows into shared memory. Memory's result detail offers Open report when the client
also has `orchestration:read` there. Use the existing scoped thread route (web
`GoatBotTaskChip.tsx:109`; mobile thread selection at `GoatBotScreen.tsx:63`), not ensureBot or a
Bot-home change. On a foreign environment the details identify the resolver and offer an explicit
connection/read action; missing access remains unavailable. This makes non-home reports reachable
even when the client's ordinary GOAT Bot tab follows another home.

No report contains body, judgment, originals, transcript, paths, credential, raw cause or model
output. Details require `memory:read` on the target. Add `memory` metadata as an optional field,
keep `ChannelMessageKind` unchanged, and propagate it through readers -> rows -> both clients.
An explicit View memory action is necessary: both existing timelines render `row.text` as text.
Older clients show the safe sentence without the action. A forgotten target shows metadata only;
old Bot messages remain safe because they never copied the forgotten body.

## 5. Complete field and enum chains

All names below are contract handoff requirements for WP1/2/3/5 or local WP6 presentation additions.
Do not publish a feature capability until its contracts and runtime behavior exist. No new
MemoryOperation kind, MCP tool, hub endpoint or standalone RPC name is introduced by WP6.

| Field / full values                                                                                                                                                                      | Producer and persistence                                                                                    | Wire / runtime                                                             | Client and reverse behavior                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MemoryScope `user / project / thread`; MemoryProjectKey `repository / explicit`                                                                                                          | WP1 schemas; WP2 revisions/projection                                                                       | memory.upsert/list/search/read; WP4 atoms                                  | Separate record picker; project key validated; thread uses environment + thread ID; cannot reinterpret Settings bulk target                                                                                |
| MemoryAssertionKind `fact / inference`, MemoryProvenance                                                                                                                                 | WP2 committed revisions with evidence origin                                                                | MemoryItem/read/history                                                    | Label source and assertion; fact label is not a truth certificate; deleted history excludes evidence/body                                                                                                  |
| MemoryOperation `upsert / forget / resolve / revert`, operationId, expectedHeads                                                                                                         | WP2 receipt/events/outbox                                                                                   | Mutation request and typed receipt                                         | Stable retry ID; resolve server-only; forget has no inverse; revert stages an intent; only hub acceptance makes a new revision                                                                             |
| MemoryConflict.status `quarantined / resolving / failed / resolved`                                                                                                                      | WP2 conflict projection; WP3 fenced apply                                                                   | read/history/list conflict-management view                                 | Only conflicted item excluded from ordinary recall; failed stays quarantined; resolved details remain available                                                                                            |
| MemoryResolution inputRevisionIds, judgmentRef (separate nullable history payload), requestedModelSelection, effectiveProvider, effectiveModel, resolvingEnvironmentId, resultRevisionId | WP2 payload + metadata, purged on forget                                                                    | history/read, optionally resolution-focused page filter                    | Originals/judgment only behind read permission; all six provider labels; stale head disables revert                                                                                                        |
| MemorySyncStatus and processing (WP1 exact fields)                                                                                                                                       | WP2 canonical receive/local flags and WP3 status                                                            | syncStatus → shared runtime → web/desktop/mobile/MCP                       | Separate received sequence/lag, index coverage/backlog, scanner/parent hold, cleanupPending and report backlog from hub refusal; online+deferred valid; received never means visible/indexed/fully purged. |
| MemoryHubSettingsView / MemoryHubSettingsUpdateInput (WP1)                                                                                                                               | WP3 settings version and secret lifecycle                                                                   | hubSettings get/update through settings:write guarded commands             | Connect/disconnect map to configure member/disabled; provision/rotate/revoke/install/ack use WP1 actions; submitted bytes are ephemeral, never normal settings                                             |
| MemoryImportProviderInput/Result / MemoryImportReceipt (WP1)                                                                                                                             | WP5 source/item/batch receipts                                                                              | memory.importProvider guarded command for every action                     | discover/preview/apply/status; <=32 per apply; stop future chunks for cancel, admitted request may finish; status shows durable partial/completed outcomes, no queued/cancelled wire job enum              |
| ChannelMessageMeta.memory optional MemoryReportReference (WP1; includes memorySpaceId)                                                                                                   | WP2 report metadata -> WP6 adapter -> timeline event/projection                                             | Existing ChannelTimelineRecord; orchestration item.channel -> readers/rows | Explicit target action; omitted field compatible; no new ChannelMessageKind; replay preserves target                                                                                                       |
| MemoryReportDelivery / stable reportId                                                                                                                                                   | Minimum repair marker commits with approval; resolver-local report outbox materializes/drains independently | Safe decoded status, no shared Bot duplication                             | Delivery quota/failure cannot change approval/cursor; stable ID makes ACK/restart idempotent, no provider starts.                                                                                          |
| MemoryHistoryPage.reports / MemoryReportDelivery (WP1)                                                                                                                                   | WP2 report ack on resolver; safe failure status does not change memory outcome                              | memory.history on resolver -> WP4 query                                    | Open report uses existing scoped thread navigation plus orchestration:read; foreign details route explicitly to resolver                                                                                   |
| `capabilities.memory` optional protocol support (WP1 exact representation); absence = unsupported                                                                                        | Server descriptor WP1/WP4                                                                                   | Server config -> environment registry                                      | Hide nav/search/palette for unsupported target; direct URL notice; downgrade overrides cached memory data                                                                                                  |
| WP6 `requiresMemory?`, `hasMemory`; URL machine/memoryId/resolutionId; native SettingsMemory params                                                                                      | No DB; settings availability and navigation                                                                 | Web search availability, native navigation, runtime presentation           | Validate IDs; switching environment clears record selection; unavailable never falls back                                                                                                                  |

The table consumes WP1 schemas without alternate phase/import/action values. Local UI progress
is preview/running/stopped/completed/failed and is not serialized as an import job contract. Sync transport failure and conflict generation failure are distinct.

## 6. Branch scenarios and observable acceptance evidence

| Trigger / branch                                                 | Required result                                                                                   | Observable evidence on CI or another device                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Capability absent or server downgraded                           | No memory query; nav/search/palette hidden; direct link explains unsupported                      | RPC recorder has zero memory calls; cached item cannot enable action                                        |
| No target / All environments / project-group selection           | Explicit destination chooser; zero bulk mutations                                                 | Choose B; every request contains B, none A; hub config not written to project members                       |
| Explicit target removed/offline, same thread ID exists elsewhere | Show unavailable/stale; disable commands; no fallback                                             | B disconnects; A receives no read/upsert/readSource request                                                 |
| memory:read absent                                               | No list/history/source body; safe report sentence still safe                                      | UI cannot fetch body, server denies crafted RPC                                                             |
| read allowed, write denied or revoked while dialog open          | Read-only details; mutation blocked at execution                                                  | permissionAtom changes; no commit after revocation; draft survives                                          |
| settings:write denied / filesystem:read denied                   | Hub controls / import controls separately unavailable                                             | Normal memory save still works if memory:write allowed; denied operation commits nothing                    |
| Local save while hub offline                                     | Local accepted, pendingSync; last success unchanged                                               | Item exists in local projection; pending counter increases; no “Shared” label                               |
| Bootstrap/reconnect -> accepted shared write                     | Install remote tombstones before send; refresh authoritative status                               | A/B converge, pending falls; old forgotten item does not return                                             |
| Quarantined or resolving conflict                                | Inspect variants separately, disable ordinary conflict edit/revert; independent memories continue | Conflict omitted from recall search but visible in management; another item shares                          |
| Successful resolution                                            | Applied result + model/environment + judgment in history; one report on resolver                  | One live bot row, runId null; other environment has details but no duplicate report                         |
| Generation/lease/scanner failure                                 | Failed/awaiting resolution, safe reason; item still quarantined                                   | No result revision; terminal attempt report once; unrelated items still usable                              |
| Fresh resolution revert                                          | MemoryRevertResult pending until hub approval; keep current head and show waiting for hub         | Only accepted changes the head and permits a reverted success report; pending is not success                |
| Concurrent edit/delete before revert admission                   | MemoryRevertResult revision_changed / forgotten; refresh, preserve current head and end pending   | No resurrected payload, overwrite or success report; terminal status appears in web/desktop/mobile          |
| Forget cancelled / accepted / accepted then disconnected         | Cancel is no-op; accepted removes bodies locally; remote sharing may remain pending               | Metadata-only history; editor/original caches cleared; report contains no body; peer purges after reconnect |
| Source online / unavailable / forbidden                          | Exact source owner read / source_unavailable / denied                                             | Summary retained; no local same-ID transcript substituted                                                   |
| Import preview/apply/repeat/chunk-stop/status/failure            | Allowlisted environment-local sources; same source NOOP; suppression stays; cancel honest         | Counts and receipt stable; source bytes unchanged; cancellation cannot claim rollback of committed items    |
| Hub connect/disconnect/rotate/failure                            | Explicit settings command; typed error preserves previous configuration                           | Re-read get shows committed version; no secret in config/report/screenshots; offline writes retained        |
| Timeline delivery/ack crash, bot replacement                     | Durable retry; stable row; no provider start                                                      | Replayed identical command sequence; count one in current bot; worker drains deterministically              |
| Bot home elsewhere                                               | Internal resolver report remains local; public ingress still refuses non-home                     | Home setting unchanged; local bot status yields report thread; report details reachable from Memory history |
| Large history/search or late response after switching target     | Bounded page, no full log download; stale response ignored                                        | Page-size limit; request count bounded; B screen never displays A's response                                |

Use WP4 management list/history filters to expose quarantined and tombstone records without
weakening ordinary recall exclusion. A known item may open by ID even when absent from search.
Do not show imported source file paths or error bodies in generic failure banners.

## 7. Focused tests to write

Tests below run only in PR CI or on another machine. No static markup rendering, snapshot of
props, or callback-wiring-only test satisfies these acceptance cases.

1. `memoryPresentation.test.ts`: table-driven status dimensions, stale/correct heads, tombstone,
   capability downgrade, permission combinations; assertions on decisions and user-visible labels.
2. `MemorySettings.logic.test.ts` and native logic counterpart: validated IDs, exact destination,
   ambiguous project key, clearing drafts across machines, ignored stale page response.
3. `settingsSearch.test.ts` / `CommandPalette.logic.test.ts` / mobile palette tests: actual result
   set and selected navigation target for mixed capabilities and all-environment contexts.
4. Interactive web/native screen tests: submit real input through the production command boundary
   with fake transport; assert recorded destination/operation ID, persisted receipt handling,
   pending label, denial without commit, failure draft retention, stale revert and forget cache purge.
   Fake platform/network edges only; do not replace the screen's logic with mocked conclusions.
5. `MemoryReportAdapter.test.ts`: test SQL + real timeline dispatch/harness. Inject crash before
   delivery and after commit before ack; drain the worker or await a persisted sequence. Verify
   one current row, no task/provider run, no copied bodies, non-resolver no-op, retry after bot
   deletion, foreign accepted revert report repair on the original resolver and non-home internal reporting.
6. `ChannelBotRegistry.test.ts`: public ensure still returns not_home; report ensure can create
   canonical runless bot there; deleted bot replaced; archived bot retained; concurrent calls
   converge; running legacy candidate never adopted. No sleeps or polling to settle workers.
7. readers/rows tests: old metadata decode, report target preservation, no question options or
   artificial replying state. Forgotten links open metadata only through permission-checked queries.

CI must actually execute new files; listing a file in a plan is not test evidence. Record exact
PR SHA, task logs, executed file names and failures. No success claim from cancelled/skipped CI.

## 8. Verification and execution locality

**Jun's host rule:** on `juns-macbook-pro`, no bun/pnpm/vp test, vitest, e2e, native-client build,
repo/full build, server/Metro launch, fixture writes or real-user-data writes. This planning
task only performs source reads, document consistency/path checks and whitespace inspection.
Package typechecks/lint below are for future implementation; they are not claimed run here.

Run independently, from repository root, only for packages touched by the future PR:

```sh
vp exec tsc-rs --noEmit -p apps/web/tsconfig.json
vp exec tsc-rs --noEmit -p apps/mobile/tsconfig.json
vp exec tsc-rs --noEmit -p packages/client-runtime/tsconfig.json
vp exec tsc-rs --noEmit -p apps/server/tsconfig.json
```

Why these read the change: each package's `package.json` typecheck is `tsc-rs --noEmit`;
web tsconfig includes `src` (routes, components and state); client-runtime includes `src`;
server includes `src` (adapter, worker, registry and composition). Mobile tsconfig has no include
override, so TypeScript's package-root default includes Stack and native screens. Imports follow
contracts transitively, but no recursive workspace typecheck/build is invoked. The web route
generator runs on CI/another host before these checks; an absent generated route registration is
an unresolved prerequisite, never a reason to run a local Vite server or full build.

Target lint by explicit changed TS/TSX paths, not the repository root. Produce that list from
the WP6 diff against WP5, then review it to exclude unrelated changes:

```sh
# Read-only listing; choose the actual WP5 base SHA when implementing.
git diff --name-only --diff-filter=ACM <WP5-base-SHA> -- apps/web apps/mobile packages/client-runtime apps/server
# Full final mapped lint inputs (generated route is lint-exempt):
vp lint apps/web/src/components/CommandPalette.logic.test.ts apps/web/src/components/CommandPalette.tsx apps/web/src/components/ThreadNotificationCoordinator.test.tsx apps/web/src/components/auth/ConnectAgentSurface.test.tsx apps/web/src/components/auth/ConnectAgentSurface.tsx apps/web/src/components/goatBot/GoatBotTimeline.tsx apps/web/src/components/settings/MemorySettings.logic.test.ts apps/web/src/components/settings/MemorySettings.logic.ts apps/web/src/components/settings/MemorySettings.test.tsx apps/web/src/components/settings/MemorySettings.tsx apps/web/src/components/settings/SettingsScopeSentence.tsx apps/web/src/components/settings/SettingsSidebarNav.tsx apps/web/src/components/settings/settingsSearch.test.ts apps/web/src/components/settings/settingsSearch.ts apps/web/src/components/settings/useAvailableSettingsSearchItems.ts apps/web/src/routes/settings.memory.tsx apps/web/src/routes/settings.tsx apps/web/src/state/memory.ts --report-unused-disable-directives
vp lint apps/mobile/src/Stack.tsx apps/mobile/src/features/goat-bot/GoatBotScreen.tsx apps/mobile/src/features/keyboard/CommandPalette.tsx apps/mobile/src/features/keyboard/commandPaletteItems.test.ts apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx apps/mobile/src/features/settings/SettingsMemoryRouteScreen.logic.test.ts apps/mobile/src/features/settings/SettingsMemoryRouteScreen.logic.ts apps/mobile/src/features/settings/SettingsMemoryRouteScreen.test.tsx apps/mobile/src/features/settings/SettingsMemoryRouteScreen.tsx apps/mobile/src/features/settings/SettingsRouteScreen.tsx apps/mobile/src/features/settings/components/settings-sheet-targets.ts apps/mobile/src/state/memory.ts apps/mobile/src/testing/memoryNativeHarness.tsx --report-unused-disable-directives
vp lint packages/client-runtime/src/goatBot/readers.test.ts packages/client-runtime/src/goatBot/readers.ts packages/client-runtime/src/goatBot/rows.test.ts packages/client-runtime/src/goatBot/rows.ts packages/client-runtime/src/memoryPresentation.test.ts packages/client-runtime/src/memoryPresentation.ts --report-unused-disable-directives
vp lint apps/server/src/channels/ChannelBotRegistry.test.ts apps/server/src/channels/ChannelBotRegistry.ts apps/server/src/memory/MemoryReportAdapter.test.ts apps/server/src/memory/MemoryReportAdapter.ts apps/server/src/memory/MemoryWorker.ts apps/server/src/server.ts --report-unused-disable-directives
```

Reconcile any actual diff expansion with these full mapped file lists, including tests. Explicit file arguments select lint inputs using root `vite.config.ts:109` configuration;
this is not `vp check`, root lint, recursive typecheck or a test runner. Do not install missing
dependencies or silently broaden checks; report the missing tool prerequisite. Documentation-only
changes do not justify compiling four unchanged packages.

Off-host acceptance uses disposable seeded fixture state, never live userdata or provider homes.
On the selected host follow `.agents/skills/test-t3-app/SKILL.md` via Browser panel and
`.agents/skills/test-t3-mobile/SKILL.md` via Device panel. Missing native client is an authorized
off-host ensure/build step there; unavailable panels are explicit verification blockers.
Start/reuse isolated servers and Metro only there and retain captured PIDs. Use real fixture
projects and stopped threads with synthetic memory bodies and source files. No production hub
configuration; `juns-macbook-pro` is the intended first deployment hub, not this test fixture.

Capture before/after on local-hosted web, hosted-web-style remote connection, desktop renderer,
iOS and Android. For each: save -> share -> conflict result -> revert -> forget; additionally
offline/reconnect, read-only/revocation, report link and source-unavailable. Direct/Tailscale/relay
and tunnel routes must retain the same destination and single-origin behavior; never set
VITE_HTTP_URL/VITE_WS_URL. Settings search, palette and existing palette keybinding open the same
screen. No new dedicated mutation keybinding. Screenshots alone cannot prove dedup/permission:
retain receipts, event sequence and focused CI evidence alongside them.

Completion requires local targeted static evidence on the final implementation, focused CI green,
independent review, off-host integrated passes and screenshot evidence. This roadmap does not
claim any of those future gates passed.

## 9. PR delivery and documentation

Future title: `feat(memory): manage shared memories across clients and report resolutions`.
One WP6 PR based on WP5; this writing task creates no PR, commit or push.

Body outline:

> Shared memories need an editable management surface on every client and a durable report
> when automatic resolution succeeds or fails. Add scoped Memory settings, shared permission-aware
> commands, native navigation and runless GOAT Bot reports with links to history and guarded revert.
> Local acceptance is shown separately from sharing; forget clears GOAT bodies and originals.
>
> Validation: exact-head focused CI tests and review; targeted package typecheck/lint; off-host
> web/desktop/iOS/Android save, share, conflict, revert, forget and permission/reconnect evidence.
> Include the actual result and artifact links, not this prospective sentence.
>
> End with the actual model and harness used for implementation.

Embed before/after images in the rendered PR description for each affected client, including the
pending/failed state and applied resolution. Include a short video when proving timing/reconnect.
Baseline evidence shows existing Settings without Memory, captured on the same off-host client.
Use GitHub uploads or orphan `pr-assets` paths `<pr>/<name>.png`; embed
`https://raw.githubusercontent.com/goat-si/goat/<commit-sha>/<pr>/<name>.png`, never branch URLs.
No PR-only image assets on the implementation branch. Redact pairing links, credentials and real data.

Gate evidence: `.github/scripts/pr-screenshot-gate.cjs:16` marks apps/web/desktop/mobile/marketing
paths; test/Markdown files are excluded. `:85` requires rendered embedded images; plain links,
code-fenced image examples or HTML comments do not count. Drafts/non-UI PRs skip the gate; only a
maintainer may waive via `gui-screenshot-waived`. Current workflow calls it `screenshot-gate`
(`.github/workflows/goat-ci.yml:123`), and default mode is advisory unless configured enforce.
WP6 still requires actual images even if that configured mode warns. After description edits,
re-run that job against the final head; do not modify the gate to obtain green.

User docs explain hub selection, scopes, readonly imports, pending sharing, exact source owner,
forget/re-remember and guarded revert as tasks, with no buttons/icons catalog or internal field list.
Internal docs hold only canonical-store reasoning, delete versus revert, fencing, offline limits
and report-home boundary. Rewrite conflicting existing prose rather than appending a PR summary.
Structure docs state implemented boundaries in present tense after implementation. Extend the
memory entry once, derive INDEX by manifest ordering and inverse path map; there is no shipped
`structure:index` or `structure:check` script. Follow `structure/AGENTS.md` checks without inventing
a runner or adding retrospective ADRs for uncommitted design.

## 10. Settled phase boundaries and traps

| Owner            | Assigned producer / WP6 consumer                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP1              | Sole wire owner: MemoryItem blocked arm, exact sync fields, import/admin/report/history/channel schemas, scopes and capabilities. No WP6 status/action DTO.                                              |
| WP2              | Sole local table/ack/claim owner; reportId/operationId/resolver pointers and purge/revert/partial-import receipts already implemented. WP6 adapter only consumes/acknowledges.                           |
| WP3              | Hub-only SQL/config/bootstrap, common approved ingestion. Resolver-only repair marker persists with accepted catch-up, delivery may defer without stalled receive. No shared report outbox or extra RPC. |
| WP4              | createMemoryEnvironmentAtoms and every common guarded command/query; WP6 only instantiates on web/native, uses exact invalidation and destination availability/permission atoms.                         |
| WP5              | Import parser/coordinator and discover/preview/apply/status producer. Cancel means stop further 32-item calls; status/retry/re-preview reveals committed partial work.                                   |
| WP6 (this phase) | Multi-client management/navigation, runless timeline adapter and optional MemoryReportReference presentation; no new schemas/tables/migrations.                                                          |

Hit every surface: web local + hosted remote apply; desktop uses web and gets its own verification;
mobile is full management, not read-only. Settings sidebar/search/palette/report links apply;
existing keybinding opens palette, no new keybinding enum. Agent MCP and scheduled jobs already
use predecessor MemoryService; WP6 adds no channel reception or provider tools. All six provider
results are displayed without silently substituting models. OpenCode external MCP limitation is
WP4's advertised capability, not a reason to hide ordinary Memory settings.

Reverse states are explicit: connect/disconnect/rotate, import discover/preview/apply/status and client chunk-stop cancellation,
resolve/revert with current-head guard, forget/metadata-only history/new-ID re-remember. A server
offline from the client cannot accept that client's mutation; a server online to the client but
offline from its hub can commit locally. Do not conflate these two offline conditions.

Out of scope: team sharing, Aside/kim_wiki sync, provider-native memory writes or disabling,
semantic conflict detection between different IDs, deletion of provider transcripts/backups,
Markdown export editing, manual conflict-resolution engine, hub failover/migration wizard,
new transports, new permissions framework, full-log websocket broadcasts, merge/release/deploy,
or any live-data run. Respect the initial hub selection without baking its hostname into code.

Keep known limits visible: offline members learn remote tombstones only on reconnect; already
delivered provider context cannot be remotely recalled; generation can fail for any provider;
stale revert cannot overwrite later edits; delivered Bot reports are not proof that every
environment synced. Local static green is not WP6 DONE.

The UI shows local import progress only; Stop prevents the next chunk, then status on the
last admitted operationId determines partial/completed receipt outcomes. Restore selection sends
restoredRevisionId explicitly. Report details use MemoryHistoryPage.reports and null-aware
resolutionId/reportThread/sequence, with the stable reportId as the timeline record key.

## Cross-phase contract reconciliation (rev 2)

Removed alternate sync/import/admin field and enum vocabulary. Uses explicit selected-original revert, stable reportId/reference/ack and common runtime. Import cancellation is honest chunk stopping with partial receipt status; UI progress is local only.

## Reflection r1 fixes (rev 3)

### File change map (G1/G2/G3/G5/G6)

| Action              | Exact path                                                           | Concrete change                                                                                                                |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| MODIFY (NEW in WP6) | apps/web/src/components/settings/MemorySettings.tsx                  | Explicit project binding picker/get/update/reverse action, remote invalidation cleanup and safe metadata after forget.         |
| MODIFY (NEW in WP6) | apps/web/src/components/settings/MemorySettings.logic.ts             | Binding-version draft stamp and body eviction predicates; no raw RPC.                                                          |
| MODIFY (NEW in WP6) | apps/mobile/src/features/settings/SettingsMemoryRouteScreen.tsx      | Same project binding picker and forget/draft/original/source cleanup through shared runtime.                                   |
| MODIFY (NEW in WP6) | apps/mobile/src/features/settings/SettingsMemoryRouteScreen.logic.ts | Environment/binding/cache-generation stamps and reverse action semantics.                                                      |
| MODIFY              | apps/web/src/components/auth/ConnectAgentSurface.tsx                 | Explicit memory read/write consent selection, default empty; both approval arms serialize WP1 memoryScopes.                    |
| NEW                 | apps/web/src/components/auth/ConnectAgentSurface.test.tsx            | Interactive consent selection/one-click vs code/body capture through actual decision schema.                                   |
| MODIFY (NEW in WP6) | apps/web/src/components/settings/MemorySettings.test.tsx             | Binding save/reverse and open-screen remote forget races.                                                                      |
| MODIFY (NEW in WP6) | apps/mobile/src/features/settings/SettingsMemoryRouteScreen.test.tsx | Native interaction through production commands with platform-only DOM adapters; remote forget/late result/revocation.          |
| NEW                 | apps/mobile/src/testing/memoryNativeHarness.tsx                      | CI-only React Native primitive/navigation adapters for a DOM interaction harness; no fixture state or fake memory conclusions. |
| MODIFY              | .github/workflows/goat-ci.yml                                        | Add test-mobile-memory matrix task and exact focused command below, on existing EPYC runner.                                   |
| MODIFY (NEW in WP6) | apps/server/src/memory/MemoryReportAdapter.test.ts                   | Failure/success/revert recorded once, no provider run or notification effect.                                                  |
| MODIFY              | apps/web/src/components/ThreadNotificationCoordinator.test.tsx       | Runless failure report creates no OS/sound notification; existing normal run notifications still work.                         |

The native harness is NEW (no installed @testing-library/react-native or react-test-renderer is
assumed). Reuse React createRoot/act and jsdom already in apps/mobile dependencies and tests:
apps/mobile/src/features/goat-bot/useMobileGoatBotSession.test.tsx:1–3. Do not copy existing
renderToStaticMarkup tests as acceptance evidence; these new tests mount and interact.

### G1 project binding picker

```diff
 // BOTH MemorySettings and SettingsMemoryRouteScreen; selected environment stays explicit
+// fetch projectBinding.get through its memory:write guarded command for a local project
+// Show persisted effective key and pinned repository fallback; no path-based shared identity.
+// Owner selects an existing explicit shared id or enters one; save action is setExplicit.
+run(projectBindingUpdate, { environmentId, input: {
+  memorySpaceId, project: { environmentId, projectId }, requestId,
+  expectedVersion: binding.version, action: "setExplicit", sharedProjectId,
+}});
+// "Use repository identity" sends action:useRepository with same concurrency fields.
```

Web/desktop and mobile use the same WP4 command/permissionAtom; memory:write protects both
binding get/update. The picker is per selected local project, separate from hub settings and
per-memory scope selector. A second environment deliberately selects the same shared id; show
that it is explicit mapping, without copying local ProjectIds. Missing key disables project save,
not user/thread save. Restart preserves the key. A remote change does not silently rewrite it.

Binding ACK refreshes selection and invalidates prior import preview/project draft eligibility.
A rejected binding keeps input and displays revision_changed/denial. Reverse action restores
pinned repository identity/null for future operations only; existing memory scopes and accepted
import receipts remain unchanged. Clear or reconfirm scope-dependent draft after binding changes.
Shared chain: picker → WP1 JSON → WP4 live command → WP2 SQL/version → result decoder →
client picker and snapshot/import scope resolver. G1 two-environment persistence tests belong
WP2/WP3; client tests assert selected destination and version plus observable picker behavior.

### G2 external agent consent surface

The external MCP connect page is apps/web/src/components/auth/ConnectAgentSurface.tsx (shared
by web/desktop; a mobile OAuth handoff opens this server-served page). Current oneClickApproves
checks only access (:100–102), and both decision arms omit memory fields (:139–145).
Add two explicit independent grant selections defaulting to false. Write does not imply read;
source transcript access still requires orchestration:read and owner policy. Preserve the
existing access/runtime ceiling: choosing read-only cannot make a memory writer through consent.

```diff
 // ConnectAgentSurface.tsx
+const [memoryScopes, setMemoryScopes] = useState<ReadonlyArray<AuthMcpMemoryScope>>([]);
-function oneClickApproves(details, access) {
-  return details.csrfToken !== undefined && (details.oneClickAccess ?? []).includes(access);
+function oneClickApproves(details, access, memoryScopes) {
+  return details.csrfToken !== undefined && (details.oneClickAccess ?? []).includes(access)
+    && memoryScopes.every(scope => (details.oneClickMemoryScopes ?? []).includes(scope));
 }
-? { _tag: "browser-session", access, csrfToken }
-: { _tag: "pairing-code", access, code: pairingCode.trim() };
+? { _tag: "browser-session", access, memoryScopes, csrfToken }
+: { _tag: "pairing-code", access, memoryScopes, code: pairingCode.trim() };
 // call predicate with memoryScopes; include selection in useCallback dependencies.
 // Changing selected grant/access re-evaluates code requirement, no auto approval.
```

Use existing checkbox/UI variants, no new permission framework. Legacy details without
oneClickMemoryScopes mean no one-click memory delegation; pairing-code path can grant only
if that code's full scope set passes WP4. Rejection retains selection for correction; deny sends
only deny. No prechecked memory grants, token extension, implicit grant via access or model tool.

Contract chain: selection → AuthMcpApprovalDecisionRequest encoder → auth API strict decode →
WP4 complete-set approval/PendingCode/exchange/SessionStore → authenticated context and toolkit.
CI ConnectAgentSurface.test.tsx cases: `default access sends no memory grant`; `read and write
selection is copied to both decision proof arms`; `missing one click scope requires code`;
`denial contains no selected grants`; `read only ceiling cannot approve memory write`. Mount with
createRoot/act + jsdom and interact with form; fake only HTTP/navigation, decode posted JSON with
actual WP1 schema. Server grant/tool execution evidence remains WP4, not this UI test.

### G3 open-view forget purge

Both screens consume shared environment cache generation and MemoryLocalAvailability. Forget/hold/invalidate clears affected editor/originals/judgment/source/snippets/previews and closes obsolete body dialogs before refetch; IDs/status/repair remain. Every delayed source/history/save result checks generation, current grant/local eligibility and tombstone. Unrelated new draft survives capacity refusal. Reset/disconnect/revocation clears all body-derived state. These fences discard stale results, never hub-approved canonical operation.

```diff
 // MemorySettings.logic.ts + SettingsMemoryRouteScreen.logic.ts and their screen consumers
+// Draft stamp = {environmentId,memoryId|null,cacheGeneration,bindingVersion}.
+// Runtime invalidation changes stamp: drop body state before applying new query results.
+// Apply awaited source/history/save result ONLY if environment and generation still match.
+// A forgotten memoryId fence prohibits body restore even from a delayed successful request.
```

Client cache clearing uses WP4 runtime; screen state clearing consumes that same signal. Desktop
uses the web screen, no separate native body store. Provider transcripts remain untouched.
Offline clients cannot receive unknown remote deletion; reconnect reset plus hub tombstone sync
provides convergence. No stale body shown as offline display while a connected stream has
already reported forget. Stream/body request races must be proven, not merely query invalidation.

### G5 actual goat-ci mobile lane diff (CI-only text)

Inspected current .github/workflows/goat-ci.yml: jobs.ci, EPYC runs-on (:24), 40-minute timeout,
fail-fast:false, task list (:29–41), four server include shards (:43–56), Vite+ dependency setup
(:67–74), test only ssh/web (:98–102), separate contracts/runtime/shared and server steps. No
mobile task exists. apps/mobile/package.json:test uses root ../../vite.config.ts; root test
config has node environment and no mobile exclude (vite.config.ts:58–78). Pure tests therefore
use root config; screen interaction explicitly opts into jsdom. Do not assume package test runs
in any existing matrix task.

```diff
--- .github/workflows/goat-ci.yml
+++ .github/workflows/goat-ci.yml
       matrix:
         task:
           [
             test-client-runtime,
+            test-mobile-memory,
             test-shared,
             # all other existing tasks remain; server include shards unchanged
           ]
 # Insert sibling step after Test client runtime. CI cwd is repository root.
+      - name: Test mobile memory
+        if: matrix.task == 'test-mobile-memory'
+        run: >-
+          vp test run --config vite.config.ts
+          apps/mobile/src/features/settings/SettingsMemoryRouteScreen.logic.test.ts
+          apps/mobile/src/features/settings/SettingsMemoryRouteScreen.test.tsx
+          apps/mobile/src/features/keyboard/commandPaletteItems.test.ts
```

The matrix list snippet is an insertion anchor, not replacement of the entire list. The shown comments use YAML # syntax; the added step belongs under jobs.ci.steps. Existing Setup Vite+ installs dependencies for every non-screenshot task, so
this lane needs no new bootstrap, Electron ensure, Metro, simulator, native build or account.
Generated job name is goat-test-mobile-memory. Keep current runner labels/security/concurrency;
no new CI service and no broad suite invocation. Shared memoryPresentation/runtime tests remain
in test-client-runtime; web screen and connect-consent tests in test; report tests in server shards.

Add `// @vitest-environment jsdom` at the top of SettingsMemoryRouteScreen.test.tsx; import
memoryNativeHarness before production screen import. Harness vi.hoisted/vi.mock adapts only
react-native primitives, navigation and platform APIs: View→div, Pressable→button onClick,
TextInput→input with onChangeText(value), text/accessibility names preserved. Mock complex native
shell edges only where the screen requires them; do not mock permissionAtom, production command
factory, memory logic or resolved query outcomes. Instantiate real Atom registry/runtime with
fake RPC transport and synthetic connection descriptors, mount the **production screen**, act on
text inputs/buttons and feed actual WP1 receipts/MemoryChangeSignal through the fake transport.
No React Native/Expo runtime module is loaded before its adapter mock; do not add native Jest
transforms or pretend DOM adapters prove native layout/gesture behavior. Pure .logic.test.ts and
palette tests remain node-environment tests. Harness is imported, not a collected test file.

| Exact CI file                                                             | New cases / assertions                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| apps/mobile/src/features/settings/SettingsMemoryRouteScreen.logic.test.ts | `project picker uses persisted explicit binding`; `binding reverse action retains original receipt scope`; `stale generation drops old destination body`; no target fallback.                                                                                                                                                                                                                                                                            |
| apps/mobile/src/features/settings/SettingsMemoryRouteScreen.test.tsx      | `save sends selected destination and stable operation id`; `binding picker saves explicit key and restores repository identity`; `remote forget clears open editor originals source and draft`; `late history source and save responses cannot restore forgotten body`; `revoked grant blocks pending action`; `failed ordinary save retains draft`. Observable DOM and real command request/receipt/cache results, no static markup or prop assertions. |
| apps/mobile/src/features/keyboard/commandPaletteItems.test.ts             | `memory discoverability retains explicit destination or chooser`; `unsupported environment has no memory action`; selecting a result navigates, never writes.                                                                                                                                                                                                                                                                                            |
| apps/web/src/components/settings/MemorySettings.test.tsx                  | Same open-view G1/G3 scenarios for web/desktop through production runtime, with a second environment's forget event arriving while detail/source/revert dialog is open.                                                                                                                                                                                                                                                                                  |

CI must show all three exact mobile files collected, nonzero executed tests and no skipped
required cases on final PR SHA; skipped/cancelled job or missing file is failure, not green
acceptance. Use controlled Deferred/transport milestones for races, no sleeps/polling in tests.
This lane proves client interaction/contract handling; real iOS/Android, web and desktop passes
remain separate **off-host** evidence under section 8. No CI/test/build command is run here.

### G6 M11 report semantics

The report is the stable GOAT Bot result/failure/revert record **plus Memory settings status**.
No separate OS notification, sound, push notification or failure-alert job is added. Preserve
WP2's durable safe outbox/ack and resolver-only delivery, including terminal failure. A Bot
write failure keeps delivery pending/failed in Settings; it does not trigger another channel.
Reports are runless and do not synthesize failed/completed provider turns to invoke existing
thread notifications. The existing web ThreadNotificationCoordinator derives attention and
completion from run status (:134–148); a runless report must not change those inputs.

Chain: WP2 terminal outcome/reportId → report SQL codec → WP6 adapter → channel metadata/row
encoder → client readers/rows → safe Bot record + permission-checked Settings status. Foreign
receivers show shared state without another Bot record. No notification payload consumer exists.

CI MemoryReportAdapter.test.ts: `failed resolution reports once with settings status and no
provider or notification effect`; `report delivery failure remains visible and recoverable`.
ThreadNotificationCoordinator.test.tsx: `runless memory failure record emits no OS notification
or sound while ordinary failed runs still notify`. Use notification API spies and actual
thread presentation updates, no new notification source/production suppression rule unless a
real integrated report changes run state (which would violate the runless contract).

Summary: G1 adds the picker and reverse mapping, G2 explicit connect consent, G3 open-view body
purge and late-response guards, G5 a real EPYC matrix lane with exact test inputs/config, and G6
matches amended M11. All are planned diffs; implementation, PR CI, reflection r2 and independent
A audit remain unperformed.

## Audit r1 fixes (rev 4)

B5: hub controls use only memory.hubSettings.update with requestId/expectedVersion; generic settings
patches cannot configure the hub. B7: permissionAtom is UI availability, with server authorization
as the final boundary; see [Enforcement inventory](000_plan.md#enforcement-inventory).
B8: replace representative lint examples with complete mapped TS/TSX lists below. Generated
routeTree.gen.ts is typechecked but lint-exempt under the existing generated-file ignore;
all other changed source/test paths are lint inputs. Reconcile any actual diff expansion at phase P.
No integrated client test or screenshot was run/captured on this Mac.

### B8 — mechanical static-input coverage receipt

Final NEW/MODIFY map (including rev 2/3/4 additions): **44 TS/TSX paths**.
Compared path equality/explicit-directory ancestry against every `vp lint` argument and
package ownership against explicit `-p` / exact package-filter typecheck commands: **0 uncovered
lint targets, 0 uncovered typecheck targets** after declared generated-file exclusions.
Lint exclusion: `apps/web/src/routeTree.gen.ts` matches `vite.config.ts:119`; web typecheck still includes it.
Typecheck owners: `apps/mobile/tsconfig.json`, `apps/server/tsconfig.json`, `apps/web/tsconfig.json`, `packages/client-runtime/tsconfig.json`.
This is path/config reconciliation, not successful compiler/linter execution. Workflow YAML,
package manifests and prose are outside TS lint; review their diffs and validate in CI. At phase P
repeat with the actual diff, compiler file collection and lint ignores; an exit 0 without target
collection is insufficient. Authoring uses Python text checks only; no installation/check runner.

Mobile config exception: apps/mobile/tsconfig.json extends expo/tsconfig.base.json and declares
no include. The installed Expo base likewise has no include/files and excludes only node_modules,
config JS and native android/ios paths; default recursive TS/TSX inclusion reaches every mapped
src path. This is a config read, not compiler collection proof; phase P still checks actual inputs.

## Reflection r3 fixes (rev 5)

G1: shared client-runtime commands consume `MemoryRevertResult`, not MemoryMutationReceipt,
for RPC/MCP revert parity. Web/desktop Settings, mobile Settings, command palette/keybinding
and history/report revert actions display the same pending/accepted/revision_changed/forgotten
semantics. Pending says the request is waiting for hub approval, keeps the current canonical
body/head and disables duplicate revert for that request. Retry uses the same operationId.
After reconnect/restart, refetch bounded history.revertResults; never infer acceptance from
absence of an outbox row or from generic pendingSync. Committed status invalidation/refetch
updates an open view. revision_changed ends waiting, explains that a later change prevented
revert and refreshes history; forgotten closes/purges body. Accepted confirms hub outcome but
consumes compensation body only when localAvailability says visible. Held/index pending/report
pending states remain distinct; no rejected-status conversion or regeneration. Pending/rejected
intent emits no success report; approved repair delivers once on original resolver.

Future UI/runtime CI: offline/restart pending preserves body/intent; remote U then stale push
shows revision_changed with zero success report; approved replay under scanner/parent/index/report
hold shows accepted plus local availability, not ready body; forget clears pending/body and late
results never revive it. Cover web/desktop/iOS/Android shared runtime, palette/history/keybinding
entry points. WP2/WP3 own R/T/U network proof. Unrelated receive progresses while one item is held.
No client/server/test/build was run for this plan-only revision.

## Requirement 7 / M19 (rev 7)

All storage/deadline/error/M20 states come from WP1 through shared runtime to web/desktop/mobile/MCP. Separate local new-admission refusal, hub quota refusal and approved received/deferred status. online can coexist with local quota/full/brake/warnings, scanner/parent/index/report hold. Show lastReceivedHubSequence/lag, deferred counts/oldest age, indexCoverage and cleanupPending, never label received as indexed/visible/fully purged. Eligible unindexed body may read/inject; incomplete search coverage remains visible even for empty results. Keep unavailable allocation/timestamps explicit; shared DB/WAL/freelist are not memory-only. Physical brake limits local creation and index, never approved pull/checkpoint; forget controls remain available. A secret_detected hold has no timer release: only a scanner-policy-version rescan that allows the current generation releases it; there is no Rescan control. Initial scanner_pending clears on the automatic first scan and displays as checking.
Show server-produced growth for 1/7/30 days with signed delta, comparison timestamps and
actual elapsed time. Separate memoryLogicalBytes/memoryAllocatedBytes/ftsAllocatedBytes from
shared dbFileBytes/WAL/freelist; shared growth is never labeled memory growth. Missing baseline,
metric unavailable and clock discontinuity display unavailable, never zero. Partial samples
show available metrics independently. Restart retains baseline; no client-created history or
interpolation. Explain that FTS maintenance can reuse pages without shrinking the shared file.

Resolution details show revertDeadlineUtc and return revert_expired without claiming an
accepted compensation. Pending intent retains its initial deadline; accepted replay still
shows accepted. Originals/judgment may be absent after eligible retention and immediately
absent after forget; no indefinite-revert promise. base_compacted shows a stale offline edit
requiring review after bootstrap, preserving original pending text and allowing explicit new
submission/rebase or discard through authorized service paths. Never auto-parent/apply it.

Capacity failure preserves user/import draft content and intended selection, shows dimension/
current/limit/reclaimable, and offers narrower scope or retry after maintenance. Automatic
summary failure shows retained watermark/failure, not successful summary. Generic capacity
failure must not invoke remote-forget cache eviction. A real forget still purges drafts and
body caches per M5; this is separate from admission refusal. Storage diagnostics contain no
raw source/model body and normal sync progress is shown independently.

Report delivery keeps existing bounded retry/manual retry and stable ID/delivery guard. New local/hub admission reserves necessary guard; approved receive stores minimum repair flag even when report backlog is full, and deferred drain later creates/delivers one Bot report. Delivery state never changes hub outcome. Detailed report expires, stable guard remains, no payload/transcript copy.

Future client/runtime CI proves drafts retained on local refusal, approved+deferred under brake/full, unavailable metrics, online+scanner/index/report hold, safe body redaction, search coverage, deadline/base_compacted review, late-result fences and forget cleanupPending until actual purge. Integrated applicable web/desktop/mobile entry-point pass runs off-host/CI only. Exact-head source server CI is one evidence level; same-SHA actual packaged desktop backend measurement/maintenance/restart/forget/unavailable execution is separately mandatory. Source-only pass reports source-runtime verified / bundled-runtime pending; requirement 7 needs both. No runtime pass here.

## Audit r3 fixes (rev 7)

R1/R2: logical limits, sampled brake and local-creation refusal remain separate from approved receive/deferred; forget remains available with explicit cleanupPending on derived failure. R3: identical growth/timestamp/unavailable/M20 state semantics across runtime, web/desktop/mobile/MCP. Future client CI covers signed deltas/partial/restart, online+deferred, eligible unindexed reads, held body exclusion and generation-fenced forget. Integrated client proof and packaged-backend proof are distinct off-host evidence; this is documentation only, not runtime/requirement 7 closure.

## M20 replan (rev 8)

Directly separates received/accepted from indexed/visible/cleanup-complete/report delivery across shared runtime, web/desktop/mobile/MCP and all entry points. Preserves late-result fences; approved report backlog cannot block receive. Source CI, integrated off-host client pass and packaged backend evidence remain distinct.

Docs-only amendment; no source edits, installation, tests, builds, server/user-data writes, commit
or push. All newly specified runtime/CI cases are NOT RUN; no runtime CLOSED or requirement 7
completion is claimed.

## Reflection r7 fixes (rev 9)

- `scanner_pending` renders as a neutral "checking" state on web, desktop and mobile, never as an error or a secret warning; `secret_detected` keeps its hold message. A quarantined item whose only hold reason is `conflicted` shows "resolving automatically", not a stalled hold.

- Reflection r8 G3 (rev 9a): the no-automatic-release rule now applies only to secret_detected. Initial scanner_pending is released by the automatic first scan that the receive commit schedules and restart recovers; CI case (c) above also restarts between receive and scan and expects the item to become active without a rescan request.

## Audit r5 fixes (rev 10)

- R7: the secret hold view offers Forget only (no Rescan button), with the explanation that the hold clears automatically when the scanner policy changes and that re-creating the memory runs a fresh check.
