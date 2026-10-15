import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../../persistence/Migrations/070_Memory.ts";
import hubMigration from "../../persistence/Migrations/071_MemoryHubSync.ts";
import searchMigration from "../../persistence/Migrations/072_MemorySearchCounters.ts";
import lineageMigration from "../../persistence/Migrations/074_MemoryImportLineage.ts";
import * as Service from "../MemoryService.ts";
import * as Store from "../MemoryStore.ts";
import * as Quota from "../MemoryQuotaService.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as RepositoryResolver from "../../project/RepositoryIdentityResolver.ts";
import { parseCodexMemory } from "./CodexMemoryImporter.ts";
import { parseClaudeMemory } from "./ClaudeMemoryImporter.ts";
import { parseOmoMemory } from "./OmoMemoryImporter.ts";
import {
  buildMemoryImportFixture,
  MEMORY_IMPORT_FIXTURE_PROFILES,
  snapshotMemoryImportFiles,
} from "./MemoryImportFixtures.fixture.ts";
import type { MemoryImportFixtureProfile } from "./MemoryImportFixtures.fixture.ts";
import type {
  ImportBatch,
  ImportItem,
  ImportPorts,
  ImportPrimitives,
  ImportRegistration,
  ImportSnapshot,
  MemoryImportParsers,
  MemoryImportReaderShape,
  PreparedImportCommit,
} from "./MemoryImportTypes.ts";
import { makeProviderMemoryImport } from "./ProviderMemoryImport.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(uuid(1));
const environmentId = M.EnvironmentId.make("synthetic-coordinator");
const stamp = M.MemoryUtcTimestamp.make("2026-10-15T00:00:00.000Z");
const isImportError = Schema.is(M.MemoryImportRpcError);
const isPayload = Schema.is(M.MemoryPayload);
const parsers: MemoryImportParsers = {
  codex: parseCodexMemory,
  claude: parseClaudeMemory,
  omo: parseOmoMemory,
};
const processing: M.MemoryProcessingStatus = {
  lastReceivedHubSequence: 0,
  receiveLag: null,
  deferred: 0,
  oldestDeferredAtUtc: null,
  unindexedItems: 0,
  scannerHeldItems: 0,
  scannerPendingItems: 0,
  missingParentItems: 0,
  pendingCleanupItems: 0,
  reportBacklog: 0,
  reportFailed: 0,
  hubAdmissionFailures: 0,
  indexCoverage: {
    status: "available",
    eligibleItems: 0,
    indexedItems: 0,
    unindexedItems: 0,
    projectionWatermark: 0,
  },
};
const storage: M.MemoryStorageStatus = {
  quotas: [],
  tables: [],
  measuredAtUtc: null,
  dbFileBytes: null,
  walBytes: null,
  freelistBytes: null,
  freelistRatio: null,
  retentionFloor: 0,
  checkpointSequence: 0,
  compaction: {
    lastRunAtUtc: null,
    removedRows: 0,
    reclaimedLogicalBytes: 0,
    reclaimableLogicalBytes: 0,
    blockedReasons: [],
  },
  ftsAdmission: {
    state: "open",
    changedAtUtc: null,
    lastMeasuredAtUtc: null,
    allocatedBytes: null,
    measurementStatus: "unavailable",
  },
  growth: {
    current: null,
    deltas: ([1, 7, 30] as const).flatMap((days) =>
      (
        [
          "memoryLogicalBytes",
          "memoryAllocatedBytes",
          "ftsAllocatedBytes",
          "dbFileBytes",
          "walBytes",
          "freelistBytes",
        ] as const
      ).map((metric) => ({
        days,
        metric,
        status: "unavailable" as const,
        baselineAtUtc: null,
        currentAtUtc: null,
        elapsedMs: null,
        deltaBytes: null,
        reason: "missing_baseline" as const,
      })),
    ),
  },
  warnings: [],
};
const sync: M.MemorySyncStatus = {
  memorySpaceId: space,
  state: "offline",
  pendingSync: 1,
  quarantined: 0,
  parked: 0,
  lastSuccessfulSyncAtUtc: null,
  lastHubSequence: 0,
  storage,
  processing,
};
const harness = (initial: ImportSnapshot) => {
  let serial = 100;
  let now = Date.parse(stamp);
  let source = initial;
  let reads = 0;
  let discoveries = 0;
  let ready = true;
  let retired = false;
  let commitError: Service.MemoryServiceError | undefined;
  let registration: ImportRegistration | undefined;
  let batch: ImportBatch | undefined;
  const items = new Map<string, ImportItem>();
  const commits: PreparedImportCommit[] = [];
  const addresses: M.EnvironmentId[] = [];
  const primitives: ImportPrimitives = {
    uuid: () => uuid(serial++),
    now: () => Effect.sync(() => now),
    environmentId,
  };
  const reader: MemoryImportReaderShape = {
    discover: () =>
      Effect.sync(() => {
        discoveries++;
        return [
          {
            slot: source.slot,
            parserVersion: source.parserVersion,
            profile: source.profile,
            sourceLocator: source.sourceLocator,
            label: "Synthetic source",
          },
        ];
      }),
    read: () =>
      Effect.sync(() => {
        reads++;
        return source;
      }),
  };
  const ports: ImportPorts = {
    readRegistration: (a, permit) =>
      permit.pipe(
        Effect.andThen(
          Effect.sync(() => {
            addresses.push(a.environmentId);
            return registration;
          }),
        ),
      ),
    saveRegistration: (a, permit) =>
      Effect.gen(function* () {
        yield* permit;
        if ((registration?.version ?? null) !== a.expectedVersion)
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        registration = a.next;
        return registration;
      }),
    preflightBatch: (a, permit) =>
      Effect.gen(function* () {
        yield* permit;
        addresses.push(a.environmentId);
        if (
          batch &&
          batch.operationId === a.operationId &&
          batch.selectionDigest !== a.selectionDigest
        )
          return yield* new M.MemoryImportRpcError({ issue: "operation_id_reused" });
        if (retired) return { kind: "retired" as const };
        if (!batch || batch.operationId !== a.operationId) return { kind: "new" as const };
        return batch.receipt.state === "completed"
          ? { kind: "completed" as const, receipt: batch.receipt }
          : { kind: "partial" as const, batch, receipt: batch.receipt };
      }),
    readReceipt: (a, permit) =>
      Effect.gen(function* () {
        yield* permit;
        addresses.push(a.environmentId);
        if (!batch || batch.operationId !== a.operationId || retired)
          return yield* new M.MemoryRpcError({ code: "not_found" });
        return batch.receipt;
      }),
    readItem: (a, permit) =>
      permit.pipe(Effect.andThen(Effect.sync(() => items.get(a.sourceItemKey)))),
    findMatch: (_a, permit) => permit.pipe(Effect.as({ kind: "none" as const })),
    binding: (a, permit) =>
      permit.pipe(Effect.as({ ...a, projectKey: null, repositoryKey: null, version: 0 })),
    resolveProjectKey: () => Effect.succeed(null),
    commit: (a, permit) =>
      Effect.gen(function* () {
        yield* permit;
        if (commitError) return yield* commitError;
        if (!registration || registration.version !== a.registrationVersion)
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        const result: M.MemoryImportItemResult = {
          sourceItemKey: a.next.sourceItemKey,
          outcome: a.next.outcome,
          memoryId:
            a.next.outcome === "rejected" || a.next.outcome === "suppressed"
              ? null
              : a.next.memoryId,
          revisionId:
            a.next.outcome === "rejected" || a.next.outcome === "suppressed"
              ? null
              : a.selection.revisionId,
          ...(a.next.rejected && a.next.outcome === "rejected"
            ? { issue: a.next.rejected.issue }
            : {}),
        };
        commits.push(a);
        items.set(a.next.sourceItemKey, a.next);
        const selections = a.batch.selections.map((s) =>
          s.selector.sourceItemKey === a.next.sourceItemKey ? { ...s, result } : s,
        );
        const remaining = selections.filter((s) => !s.result).length;
        batch = {
          ...a.batch,
          selections,
          receipt: {
            ...a.batch.receipt,
            items: selections.flatMap((s) => (s.result ? [s.result] : [])),
            remaining,
            state: remaining ? "partial" : "completed",
          },
        };
        registration = { ...registration, version: registration.version + 1 };
        return result;
      }),
    readiness: () =>
      Effect.sync(() => ({
        memorySpaceId: space,
        bootstrap: ready ? ("ready" as const) : ("staging" as const),
      })),
    requireBootstrap: () =>
      ready ? Effect.void : Effect.fail(new M.MemoryHubError({ code: "bootstrap_required" })),
    syncStatus: (_a, permit) => permit.pipe(Effect.as(sync)),
  };
  const make = (
    overrides: Partial<ImportPorts> = {},
    parserOverrides: Partial<MemoryImportParsers> = {},
  ) =>
    makeProviderMemoryImport(
      { ...ports, ...overrides },
      reader,
      { ...parsers, ...parserOverrides },
      primitives,
    );
  return {
    ports,
    reader,
    primitives,
    make,
    commits,
    addresses,
    counts: () => ({ reads, discoveries }),
    source: (s: ImportSnapshot) => {
      source = s;
    },
    now: (n: number) => {
      now = n;
    },
    ready: () => {
      ready = false;
    },
    retire: () => {
      retired = true;
    },
    failCommit: (e?: Service.MemoryServiceError) => {
      commitError = e;
    },
    seedItem: (item: ImportItem) => {
      items.set(item.sourceItemKey, item);
    },
    registration: () => registration,
    batch: () => batch,
  };
};
const prepare = (h: ReturnType<typeof harness>) =>
  Effect.gen(function* () {
    const runtime = h.make();
    const discover = yield* runtime.run(
      {
        action: "discover",
        memorySpaceId: space,
        format: h.reader ? (h.registration()?.source.format ?? "codex") : "codex",
      },
      Effect.void,
    );
    assert.equal(discover.action, "discover");
    if (discover.action !== "discover") throw new Error("discover");
    const sourceId = discover.sources[0]!.sourceId;
    const preview = yield* runtime.run(
      { action: "preview", memorySpaceId: space, sourceId },
      Effect.void,
    );
    assert.equal(preview.action, "preview");
    if (preview.action !== "preview") throw new Error("preview");
    const input: Extract<M.MemoryImportProviderInput, { action: "apply" }> = {
      action: "apply",
      memorySpaceId: space,
      sourceId,
      sessionId: preview.sessionId,
      operationId: M.MemoryOperationId.make(uuid(50)),
      items: preview.items
        .filter((r) => r.sourceFingerprint)
        .map((r) => ({
          sourceItemKey: r.sourceItemKey,
          sourceFingerprint: r.sourceFingerprint!,
          scope: { kind: "user" },
        })),
    };
    return { runtime, sourceId, preview, input };
  });
const fixtureTest = <E>(
  f: (h: ReturnType<typeof harness>, snapshot: ImportSnapshot) => Effect.Effect<void, E, never>,
  profile: MemoryImportFixtureProfile = "codex-ad-hoc-v1",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* buildMemoryImportFixture(profile);
      yield* f(harness(fixture.snapshot), fixture.snapshot);
    }),
  );
const issue = (e: unknown, expected: string) => {
  assert.instanceOf(e, M.MemoryImportRpcError);
  if (isImportError(e)) assert.equal(e.issue, expected);
};

describe("ProviderMemoryImport closed coordinator", () => {
  it.effect.each(MEMORY_IMPORT_FIXTURE_PROFILES)(
    "four actions with real parser %s and durable restart replay",
    (profile) =>
      fixtureTest(
        (h, s) =>
          Effect.gen(function* () {
            // Discovery's format is the actual frozen fixture format.
            const runtime = h.make();
            const d = yield* runtime.run(
              { action: "discover", memorySpaceId: space, format: s.format },
              Effect.void,
            );
            assert.equal(d.action, "discover");
            if (d.action !== "discover") return;
            const sourceId = d.sources[0]!.sourceId;
            const p = yield* runtime.run(
              { action: "preview", memorySpaceId: space, sourceId },
              Effect.void,
            );
            assert.equal(p.action, "preview");
            if (p.action !== "preview") return;
            const input: Extract<M.MemoryImportProviderInput, { action: "apply" }> = {
              action: "apply",
              memorySpaceId: space,
              sourceId,
              sessionId: p.sessionId,
              operationId: M.MemoryOperationId.make(uuid(50)),
              items: p.items.map((r) => ({
                sourceItemKey: r.sourceItemKey,
                sourceFingerprint: r.sourceFingerprint!,
                scope: { kind: "user" },
              })),
            };
            const a = yield* runtime.run(input, Effect.void);
            assert.equal(a.action, "apply");
            if (a.action !== "apply") return;
            assert.equal(a.receipt.items[0]!.outcome, "created");
            assert.equal(a.syncStatus.pendingSync, 1);
            assert.deepEqual(h.commits[0]!.candidate.payload.evidence, [
              { origin: "import", importSourceId: sourceId, messageIds: [] },
            ]);
            const before = h.counts();
            assert.deepEqual(yield* h.make().run(input, Effect.void), a);
            const status = yield* h
              .make()
              .run(
                { action: "status", memorySpaceId: space, operationId: input.operationId },
                Effect.void,
              );
            assert.equal(status.action, "status");
            assert.deepEqual(h.counts(), before);
            assert.ok(h.addresses.every((id) => id === environmentId));
          }),
        profile,
      ),
  );
  it.effect(
    "changed batch digest is rejected before any reader call, including retired guard",
    () =>
      fixtureTest((h) =>
        Effect.gen(function* () {
          const { runtime, input } = yield* prepare(h);
          yield* runtime.run(input, Effect.void);
          h.retire();
          const before = h.counts();
          issue(
            yield* runtime.run({ ...input, sessionId: "changed" }, Effect.void).pipe(Effect.flip),
            "operation_id_reused",
          );
          assert.deepEqual(h.counts(), before);
          const retired = yield* runtime.run(input, Effect.void).pipe(Effect.flip);
          assert.instanceOf(retired, M.MemoryRpcError);
          assert.deepEqual(h.counts(), before);
        }),
      ),
  );
  it.effect.each([
    "operation_id_reused",
    "not_found",
    "revision_changed",
    "bootstrap_required",
  ] as const)("maps commit race %s after rollback boundary", (code) =>
    fixtureTest((h) =>
      Effect.gen(function* () {
        const { input } = yield* prepare(h);
        h.failCommit(new Store.MemoryStoreConflict({ code }));
        const e = yield* h.make().run(input, Effect.void).pipe(Effect.flip);
        if (code === "operation_id_reused" || code === "bootstrap_required") issue(e, code);
        else {
          assert.equal(e._tag, code === "not_found" ? "MemoryRpcError" : "MemoryStoreConflict");
        }
        assert.equal(h.commits.length, 0);
      }),
    ),
  );
  it.effect("propagates the identical MemoryAccessError from final commit", () =>
    fixtureTest((h) =>
      Effect.gen(function* () {
        const { input } = yield* prepare(h);
        const denial = new Service.MemoryAccessError({ code: "unavailable" });
        h.failCommit(denial);
        assert.strictEqual(yield* h.make().run(input, Effect.void).pipe(Effect.flip), denial);
        assert.equal(h.commits.length, 0);
      }),
    ),
  );
  it.effect(
    "status accepts only its supplied permit and never calls registration/readiness/reader",
    () =>
      fixtureTest((h) =>
        Effect.gen(function* () {
          const { input, runtime } = yield* prepare(h);
          yield* runtime.run(input, Effect.void);
          const before = h.counts();
          const status = h.make({
            readRegistration: () => Effect.die("unexpected registration"),
            readiness: () => Effect.die("unexpected readiness"),
          });
          yield* status.run(
            { action: "status", memorySpaceId: space, operationId: input.operationId },
            Effect.void,
          );
          assert.deepEqual(h.counts(), before);
          const denial = new Service.MemoryAccessError({ code: "unavailable" });
          assert.strictEqual(
            yield* status
              .run(
                { action: "status", memorySpaceId: space, operationId: input.operationId },
                Effect.fail(denial),
              )
              .pipe(Effect.flip),
            denial,
          );
        }),
      ),
  );
  it.effect("preview reuses same snapshot session and refuses CAS conflict", () =>
    fixtureTest((h) =>
      Effect.gen(function* () {
        const { sourceId, preview } = yield* prepare(h);
        const again = yield* h
          .make()
          .run({ action: "preview", memorySpaceId: space, sourceId }, Effect.void);
        assert.equal(again.action, "preview");
        if (again.action === "preview") assert.equal(again.sessionId, preview.sessionId);
        const stale = new Store.MemoryStoreConflict({ code: "revision_changed" });
        assert.strictEqual(
          yield* h
            .make({ saveRegistration: () => Effect.fail(stale) })
            .run({ action: "preview", memorySpaceId: space, sourceId }, Effect.void)
            .pipe(Effect.flip),
          stale,
        );
      }),
    ),
  );
  it.effect("discover CAS loser rereads winner without replacing source identity", () =>
    fixtureTest((h, s) =>
      Effect.gen(function* () {
        let reads = 0;
        const base = h.make();
        yield* base.run(
          { action: "discover", memorySpaceId: space, format: s.format },
          Effect.void,
        );
        const winner = h.registration()!;
        const concurrent = h.make({
          readRegistration: () => Effect.sync(() => (++reads === 1 ? undefined : winner)),
          saveRegistration: () =>
            Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" })),
        });
        const d = yield* concurrent.run(
          { action: "discover", memorySpaceId: space, format: s.format },
          Effect.void,
        );
        assert.equal(d.action, "discover");
        if (d.action === "discover") assert.equal(d.sources[0]!.sourceId, winner.sourceId);
      }),
    ),
  );
  it.effect.each(["expiry", "snapshot", "profile", "bootstrap"] as const)(
    "rejects %s fence before commit",
    (kind) =>
      fixtureTest((h, s) =>
        Effect.gen(function* () {
          const { input } = yield* prepare(h);
          if (kind === "expiry") h.now(Date.parse(stamp) + M.MEMORY_DERIVED_CACHE_TTL_MS);
          if (kind === "snapshot") h.source({ ...s, snapshotDigest: "f".repeat(64) });
          if (kind === "profile") h.source({ ...s, profile: "changed" });
          if (kind === "bootstrap") h.ready();
          issue(
            yield* h.make().run(input, Effect.void).pipe(Effect.flip),
            kind === "bootstrap" ? "bootstrap_required" : "source_changed",
          );
          assert.equal(h.commits.length, 0);
        }),
      ),
  );
  it.effect.each(["raw", "locator", "title", "key"] as const)(
    "refuses secret in %s with a value-free error",
    (kind) =>
      fixtureTest((h, s) =>
        Effect.gen(function* () {
          const { sourceId } = yield* prepare(h);
          const secret = "sk-" + "synthetic".repeat(5);
          if (kind === "raw")
            h.source(
              snapshotMemoryImportFiles(s, [
                {
                  selector: "extensions/ad_hoc/notes/a.md",
                  text: secret,
                  byteCount: secret.length,
                },
              ]),
            );
          if (kind === "locator") h.source({ ...s, sourceLocator: secret });
          const poisoned: MemoryImportParsers["codex"] = (source) =>
            parsers.codex(source).pipe(
              Effect.map((rows) =>
                rows.map((r) =>
                  r.kind === "candidate"
                    ? {
                        ...r,
                        candidate: {
                          ...r.candidate,
                          ...(kind === "title" ? { title: secret } : { sourceItemKey: secret }),
                        },
                      }
                    : r,
                ),
              ),
            );
          const e = yield* h
            .make({}, kind === "title" || kind === "key" ? { codex: poisoned } : {})
            .run({ action: "preview", memorySpaceId: space, sourceId }, Effect.void)
            .pipe(Effect.flip);
          issue(e, "secret_detected");
          assert.ok(!JSON.stringify(e).includes(secret));
          assert.equal(h.commits.length, 0);
        }),
      ),
  );
  it.effect("rejects oversized parser output after evidence attachment", () =>
    fixtureTest((h) =>
      Effect.gen(function* () {
        const { input } = yield* prepare(h);
        const empty = { text: "", evidence: [], derivedFromMemoryRevisions: [] };
        const text = "x".repeat(M.MEMORY_PAYLOAD_MAX_UTF8_BYTES);
        assert.isFalse(isPayload({ ...empty, text }));
        const oversized: MemoryImportParsers["codex"] = (s) =>
          parsers.codex(s).pipe(
            Effect.map((rows) =>
              rows.map((r) =>
                r.kind === "candidate"
                  ? {
                      ...r,
                      candidate: {
                        ...r.candidate,
                        payload: { ...empty, text },
                        byteCount: text.length,
                      },
                    }
                  : r,
              ),
            ),
          );
        const a = yield* h.make({}, { codex: oversized }).run(input, Effect.void);
        assert.equal(a.action, "apply");
        if (a.action === "apply") {
          assert.equal(a.receipt.items[0]!.outcome, "rejected");
          assert.equal(a.receipt.items[0]!.issue, "limit_exceeded");
        }
      }),
    ),
  );
  it.effect("re-preview refreshes parser version without changing source identity", () =>
    fixtureTest((h, s) =>
      Effect.gen(function* () {
        const { sourceId, preview } = yield* prepare(h);
        const handbook =
          "# Task Group: New profile\nscope: synthetic task\n\n## Task 1: Stable guidance\n\n### learnings\nUse focused checks.";
        h.source({
          ...snapshotMemoryImportFiles(s, [
            { selector: "MEMORY.md", text: handbook, byteCount: handbook.length },
          ]),
          profile: "codex-handbook-v1",
          parserVersion: "codex-handbook-v1",
        });
        const p = yield* h
          .make()
          .run({ action: "preview", memorySpaceId: space, sourceId }, Effect.void);
        assert.equal(p.action, "preview");
        if (p.action === "preview") assert.notEqual(p.sessionId, preview.sessionId);
        assert.equal(h.registration()!.sourceId, sourceId);
        assert.equal(h.registration()!.source.parserVersion, "codex-handbook-v1");
      }),
    ),
  );
  it.effect("same source cannot change stored scope and accepted parent", () =>
    fixtureTest((h) =>
      Effect.gen(function* () {
        const { input } = yield* prepare(h);
        yield* h.make().run(input, Effect.void);
        const previous = h.commits[0]!.next;
        const thread = { environmentId, threadId: M.ThreadId.make("synthetic-thread") };
        const e = yield* h
          .make()
          .run(
            {
              ...input,
              operationId: M.MemoryOperationId.make(uuid(900)),
              items: input.items.map((s) => ({ ...s, scope: { kind: "thread", thread } })),
            },
            Effect.void,
          )
          .pipe(Effect.flip);
        issue(e, "mapping_changed");
        assert.equal(h.commits.length, 1);
        assert.deepEqual(h.commits[0]!.next, previous);
      }),
    ),
  );
  it.effect("suppressed source commits metadata without a pending revision", () =>
    fixtureTest((h) =>
      Effect.gen(function* () {
        const { input } = yield* prepare(h);
        yield* h
          .make({
            findMatch: (_a, p) =>
              p.pipe(
                Effect.as({
                  kind: "source_suppressed" as const,
                  memoryId: M.MemoryId.make(uuid(901)),
                }),
              ),
          })
          .run(input, Effect.void);
        assert.equal(h.commits[0]!.next.outcome, "suppressed");
        assert.isNull(h.commits[0]!.next.pending);
        assert.isNull(h.commits[0]!.next.accepted);
      }),
    ),
  );
  it.effect("refuses an unavailable current frontier instead of guessing pending ancestry", () =>
    fixtureTest((h) =>
      Effect.gen(function* () {
        const { input } = yield* prepare(h);
        yield* h.make().run(input, Effect.void);
        const e = yield* h
          .make()
          .run({ ...input, operationId: M.MemoryOperationId.make(uuid(902)) }, Effect.void)
          .pipe(Effect.flip);
        assert.equal(e._tag, "MemoryStoreConflict");
        if (e._tag === "MemoryStoreConflict") assert.equal(e.code, "revision_changed");
        assert.equal(h.commits.length, 1);
      }),
    ),
  );
  it.effect.each(["noop", "revised", "conflicted", "aliased"] as const)(
    "prepares %s with accepted parents and captured live head",
    (outcome) =>
      fixtureTest((h, s) =>
        Effect.gen(function* () {
          const { input } = yield* prepare(h);
          const rows = yield* parsers.codex(s);
          const row = rows[0]!;
          assert.equal(row.kind, "candidate");
          if (row.kind !== "candidate") return;
          const c = row.candidate;
          const memoryId = M.MemoryId.make(uuid(920));
          const head = M.MemoryRevisionId.make(uuid(921));
          const parent = outcome === "conflicted" ? M.MemoryRevisionId.make(uuid(922)) : head;
          if (outcome !== "aliased")
            h.seedItem({
              memorySpaceId: space,
              environmentId,
              sourceId: input.sourceId,
              codecVersion: 1,
              sourceItemKey: c.sourceItemKey,
              scope: { kind: "user" },
              memoryId,
              accepted: {
                sourceFingerprint: outcome === "noop" ? c.sourceFingerprint : "e".repeat(64),
                contentFingerprint: c.contentFingerprint,
                revisionId: parent,
                operationId: M.MemoryOperationId.make(uuid(923)),
              },
              pending: null,
              rejected: null,
              outcome: "created",
            });
          const revision: M.MemoryRevision = {
            memorySpaceId: space,
            memoryId,
            revisionId: head,
            operationId: M.MemoryOperationId.make(uuid(924)),
            parents: [],
            scope: { kind: "user" },
            payloadRef: head,
            assertionKind: "inference",
            provenance: { environmentId },
            createdAtUtc: stamp,
          };
          const payload =
            outcome === "noop" || outcome === "aliased"
              ? c.payload
              : { ...c.payload, text: "old body" };
          yield* h
            .make({
              findMatch: (_a, p) =>
                p.pipe(Effect.as({ kind: "live" as const, memoryId, revision, payload })),
            })
            .run(input, Effect.void);
          const commit = h.commits[0]!;
          assert.equal(commit.next.outcome, outcome);
          assert.equal(commit.next.memoryId, memoryId);
          assert.deepEqual(commit.expectedHeads, [head]);
          assert.deepEqual(commit.parents, outcome === "aliased" ? [head] : [parent]);
          if (outcome === "noop") assert.isNull(commit.next.pending);
          else assert.equal(commit.next.pending!.revisionId, commit.selection.revisionId);
        }),
      ),
  );
  it.effect("valid Claude item remains selectable beside malformed topic", () =>
    fixtureTest(
      (h, s) =>
        Effect.gen(function* () {
          const f = s.files[0]!;
          h.source(
            snapshotMemoryImportFiles(s, [
              f,
              { selector: "bad.md", text: "invalid", byteCount: 7 },
            ]),
          );
          const d = yield* h
            .make()
            .run({ action: "discover", memorySpaceId: space, format: "claude" }, Effect.void);
          assert.equal(d.action, "discover");
          if (d.action !== "discover") return;
          const sourceId = d.sources[0]!.sourceId;
          const p = yield* h
            .make()
            .run({ action: "preview", memorySpaceId: space, sourceId }, Effect.void);
          assert.equal(p.action, "preview");
          if (p.action !== "preview") return;
          assert.equal(p.items.length, 2);
          assert.equal(
            p.items.find((r) => r.sourceItemKey === "bad.md#body")!.issue,
            "unsupported_format",
          );
          yield* h.make().run(
            {
              action: "apply",
              memorySpaceId: space,
              sourceId,
              sessionId: p.sessionId,
              operationId: M.MemoryOperationId.make(uuid(903)),
              items: p.items
                .filter((r) => r.sourceFingerprint)
                .map((r) => ({
                  sourceItemKey: r.sourceItemKey,
                  sourceFingerprint: r.sourceFingerprint!,
                  scope: { kind: "user" },
                })),
            },
            Effect.void,
          );
          assert.equal(h.commits.length, 1);
          assert.equal(h.commits[0]!.next.outcome, "created");
        }),
      "claude-topic-v1",
    ),
  );
  it.effect("resumes only unfinished selections with frozen IDs after a partial restart", () =>
    fixtureTest((h, s) =>
      Effect.gen(function* () {
        const f = s.files[0]!;
        h.source(
          snapshotMemoryImportFiles(s, [
            f,
            {
              ...f,
              selector: "extensions/ad_hoc/notes/z.md",
              text: "second guidance",
              byteCount: 15,
            },
          ]),
        );
        const { input } = yield* prepare(h);
        let calls = 0;
        const runtime = h.make({
          commit: (a, p) =>
            ++calls === 2
              ? Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" }))
              : h.ports.commit(a, p),
        });
        yield* runtime.run(input, Effect.void).pipe(Effect.flip);
        assert.equal(h.commits.length, 1);
        const frozen = h.batch()!.selections[1]!;
        yield* h.make().run(input, Effect.void);
        assert.equal(h.commits.length, 2);
        assert.equal(h.commits[1]!.selection.operationId, frozen.operationId);
        assert.equal(h.commits[1]!.selection.revisionId, frozen.revisionId);
        assert.equal(h.commits[1]!.selection.memoryId, frozen.memoryId);
      }),
    ),
  );
});

describe("ProviderMemoryImport Hub error boundaries", () => {
  it.effect.each(["readiness", "requireBootstrap", "syncStatus"] as const)(
    "maps directly injected Hub failures at %s",
    (boundary) =>
      fixtureTest((h) =>
        Effect.gen(function* () {
          const { input } = yield* prepare(h);
          yield* h.make().run(input, Effect.void);
          for (const error of [
            new M.MemoryHubUnauthorizedError({}),
            new M.MemoryHubForbiddenError({}),
            new M.MemoryHubError({ code: "bootstrap_required" }),
            new M.MemoryHubError({ code: "storage_failed" }),
          ]) {
            const failure = () => Effect.fail(error);
            const runtime = h.make({ [boundary]: failure });
            const e = yield* runtime
              .run(
                boundary === "syncStatus"
                  ? { action: "status", memorySpaceId: space, operationId: input.operationId }
                  : { ...input, operationId: M.MemoryOperationId.make(uuid(80)) },
                Effect.void,
              )
              .pipe(Effect.flip);
            if (error._tag === "MemoryHubError") issue(e, error.code);
            else {
              assert.instanceOf(e, Service.MemoryAccessError);
              if (e._tag === "MemoryAccessError") assert.equal(e.code, "unavailable");
            }
          }
          assert.equal(h.commits.length, 1);
        }),
      ),
  );
});

const batchSnapshot = (s: ImportSnapshot) =>
  snapshotMemoryImportFiles(
    s,
    ["a", "b", "z"].map((key) => ({
      ...s.files[0]!,
      selector: `extensions/ad_hoc/notes/${key}.md`,
      text: `${key} guidance`,
      byteCount: 10,
    })),
  );

// Capture all synthetic memory tables, including receipt/item/session/intent/outbox/quota rows.
const inventory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
    WHERE type='table' AND name LIKE 'memory_%' ORDER BY name`;
  return yield* Effect.forEach(tables, ({ name }) =>
    sql
      .unsafe(`SELECT * FROM "${name}" ORDER BY rowid`)
      .pipe(Effect.map((rows) => ({ name, rows }))),
  );
});

const database = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(searchMigration),
    Effect.andThen(lineageMigration),
  ),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const live = Service.layer.pipe(
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(
    Quota.layer.pipe(Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(database)))),
  ),
);
describe("ProviderMemoryImport actual Service/Store ports", () => {
  it.effect.each([
    { refusal: "scope", partial: false },
    { refusal: "frontier", partial: false },
    { refusal: "scope", partial: true },
    { refusal: "frontier", partial: true },
  ] as const)(
    "pre-admission refuses $refusal partial=$partial without any additional writes",
    ({ refusal, partial }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
          const h = harness(batchSnapshot(fixture.snapshot));
          const service = yield* Service.MemoryService;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1)`;
          let commits = 0;
          let failSecond = false;
          const runtime = makeProviderMemoryImport(
            {
              ...h.ports,
              ...service.importPorts,
              commit: (a, permit) => {
                commits++;
                return failSecond && commits === 2
                  ? Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" }))
                  : service.importPorts.commit(a, permit);
              },
            },
            h.reader,
            parsers,
            {
              ...h.primitives,
              now: () => Effect.succeed(Date.parse(stamp) + 12 * 60 * 60 * 1000),
            },
          );
          const d = yield* runtime.run(
            { action: "discover", memorySpaceId: space, format: "codex" },
            Effect.void,
          );
          assert.equal(d.action, "discover");
          if (d.action !== "discover") return;
          const sourceId = d.sources[0]!.sourceId;
          const p = yield* runtime.run(
            { action: "preview", memorySpaceId: space, sourceId },
            Effect.void,
          );
          assert.equal(p.action, "preview");
          if (p.action !== "preview") return;
          const input: Extract<M.MemoryImportProviderInput, { action: "apply" }> = {
            action: "apply",
            memorySpaceId: space,
            sourceId,
            sessionId: p.sessionId,
            operationId: M.MemoryOperationId.make(uuid(70)),
            items: p.items
              .filter((r) => partial || !r.sourceItemKey.endsWith("/b.md#body"))
              .map((r) => ({
                sourceItemKey: r.sourceItemKey,
                sourceFingerprint: r.sourceFingerprint!,
                scope:
                  refusal === "scope" && r.sourceItemKey.endsWith("/z.md#body")
                    ? {
                        kind: "thread",
                        thread: { environmentId, threadId: M.ThreadId.make("synthetic-thread") },
                      }
                    : { kind: "user" },
              })),
          };
          assert.equal(input.items.length, partial ? 3 : 2);
          assert.equal(input.items.filter((r) => r.sourceItemKey.endsWith("/z.md#body")).length, 1);
          if (partial) {
            failSecond = true;
            const e = yield* runtime.run(input, Effect.void).pipe(Effect.flip);
            assert.equal(e._tag, "MemoryStoreConflict");
            const receipt = yield* service.importPorts.readReceipt(
              { memorySpaceId: space, environmentId, operationId: input.operationId },
              Effect.void,
            );
            assert.equal(receipt.items.length, 1);
            assert.equal(receipt.state, "partial");
            failSecond = false;
          }
          // z becomes an existing pending item after any prior independent a commit.
          yield* runtime.run(
            {
              ...input,
              operationId: M.MemoryOperationId.make(uuid(71)),
              items: input.items
                .filter((r) => r.sourceItemKey.endsWith("/z.md#body"))
                .map((r) => ({ ...r, scope: { kind: "user" } })),
            },
            Effect.void,
          );
          const before = yield* inventory;
          commits = 0;
          const e = yield* runtime.run(input, Effect.void).pipe(Effect.flip);
          if (refusal === "scope") issue(e, "mapping_changed");
          else {
            assert.equal(e._tag, "MemoryStoreConflict");
            if (e._tag === "MemoryStoreConflict") assert.equal(e.code, "revision_changed");
          }
          assert.equal(commits, 0);
          assert.deepEqual(yield* inventory, before);
        }),
      ).pipe(Effect.provide(live)),
  );

  it.effect.each([false, true])(
    "actual ports rollback after-write denial=%s or replay committed receipt",
    (deny) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
          const h = harness(fixture.snapshot);
          const service = yield* Service.MemoryService;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1)`;
          const quota = yield* Quota.MemoryQuotaService;
          const ports: ImportPorts = {
            ...h.ports,
            ...service.importPorts,
            syncStatus: (_a, permit) =>
              permit.pipe(
                Effect.andThen(quota.readStorageStatus({ memorySpaceId: space, environmentId })),
                Effect.map((storage) => ({ ...sync, storage })),
              ),
          };
          const runtime = makeProviderMemoryImport(ports, h.reader, parsers, {
            ...h.primitives,
            now: () => Effect.succeed(Date.parse(stamp) + 12 * 60 * 60 * 1000),
          });
          const d = yield* runtime.run(
            { action: "discover", memorySpaceId: space, format: "codex" },
            Effect.void,
          );
          assert.equal(d.action, "discover");
          if (d.action !== "discover") return;
          const sourceId = d.sources[0]!.sourceId;
          const p = yield* runtime.run(
            { action: "preview", memorySpaceId: space, sourceId },
            Effect.void,
          );
          assert.equal(p.action, "preview");
          if (p.action !== "preview") return;
          const input: Extract<M.MemoryImportProviderInput, { action: "apply" }> = {
            action: "apply",
            memorySpaceId: space,
            sourceId,
            sessionId: p.sessionId,
            operationId: M.MemoryOperationId.make(uuid(60)),
            items: p.items.map((r) => ({
              sourceItemKey: r.sourceItemKey,
              sourceFingerprint: r.sourceFingerprint!,
              scope: { kind: "user" },
            })),
          };
          if (deny) {
            const before = yield* sql`SELECT * FROM memory_import_receipts ORDER BY receipt_id`;
            const denial = new Service.MemoryAccessError({ code: "unavailable" });
            // Keep only the access error typed; SQL fixture failures are defects.
            const recheck = Effect.gen(function* () {
              const rows = yield* sql`SELECT COUNT(*) AS n FROM memory_events`.pipe(Effect.orDie);
              if (Number(rows[0]!.n) > 0) return yield* denial;
            });
            assert.strictEqual(yield* runtime.run(input, recheck).pipe(Effect.flip), denial);
            assert.deepEqual(
              yield* sql`SELECT * FROM memory_import_receipts ORDER BY receipt_id`,
              before,
            );
            assert.equal((yield* sql`SELECT * FROM memory_events`).length, 0);
            assert.equal((yield* sql`SELECT * FROM memory_outbox`).length, 0);
            return;
          }
          const a = yield* runtime.run(input, Effect.void);
          assert.equal(a.action, "apply");
          if (a.action !== "apply") return;
          assert.equal(a.receipt.items[0]!.outcome, "created");
          const store = yield* Store.MemoryStore;
          const aggregate = yield* store.loadAggregate(space, a.receipt.items[0]!.memoryId!);
          assert.deepEqual(aggregate.revisions[0]!.payload!.evidence, [
            { origin: "import", importSourceId: sourceId, messageIds: [] },
          ]);
          const before = h.counts();
          const replay = yield* runtime.run(input, Effect.void);
          assert.equal(replay.action, "apply");
          if (replay.action === "apply") assert.deepEqual(replay.receipt, a.receipt);
          assert.deepEqual(h.counts(), before);
        }),
      ).pipe(Effect.provide(live)),
  );
});
