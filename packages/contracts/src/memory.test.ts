import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as M from "./index.ts";
const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-10-14T00:00:00.000Z";
const thread = { environmentId: "env", threadId: "thread" };
const watermark = { fromEventId: "e1", toEventId: "e2", throughSequence: 2 };
const selection = {
  instanceId: "codex",
  model: "alias",
  options: [
    { id: "effort", value: "high" },
    { id: "flag", value: false },
  ],
};
const payload = {
  text: "Synthetic memory",
  evidence: [{ origin: "user", messageIds: [] }],
  derivedFromMemoryRevisions: [],
};
const revision = {
  memorySpaceId: id(),
  memoryId: id(2),
  revisionId: id(3),
  operationId: id(4),
  parents: [],
  scope: { kind: "user" },
  payloadRef: id(3),
  assertionKind: "fact",
  provenance: { environmentId: "env" },
  createdAtUtc: now,
};
const tombstone = {
  memorySpaceId: id(),
  memoryId: id(2),
  deleteOperationId: id(4),
  deletingEnvironmentId: "env",
  deletedAtUtc: now,
  suppressedSourceKeys: [],
  suppressedContent: [],
  sourceExclusions: [],
};
const operation = {
  protocolVersion: 1,
  operationId: id(4),
  memorySpaceId: id(),
  originEnvironmentId: "env",
  memoryId: id(2),
  expectedHeads: [],
  kind: "upsert",
  revision,
  payload,
};
function decode<S extends Schema.Top>(schema: S, value: unknown): S["Type"] {
  return Schema.decodeUnknownSync(schema as S & Schema.ConstraintDecoder<unknown>)(value);
}
function round<S extends Schema.Top>(schema: S, value: unknown) {
  const typed = decode(schema, value);
  const json = Schema.encodeSync(
    Schema.fromJsonString(schema as S & Schema.ConstraintEncoder<unknown>),
  )(typed);
  expect(decode(Schema.fromJsonString(schema), json)).toEqual(typed);
  return typed;
}
function rejects<S extends Schema.Top>(schema: S, value: unknown) {
  expect(() => decode(schema, value)).toThrow();
}
describe("memory canonical contracts", () => {
  it("round-trips all eight memory ids and rejects malformed UUIDs", () => {
    for (const schema of [
      M.MemoryId,
      M.MemorySpaceId,
      M.MemoryRevisionId,
      M.MemoryOperationId,
      M.MemoryConflictId,
      M.MemoryResolutionId,
      M.MemoryImportSourceId,
      M.MemorySourceReadRequestId,
    ]) {
      round(schema, id());
      rejects(schema, "not-a-uuid");
      rejects(schema, id().toUpperCase().replace("4000", "0000"));
    }
  });
  it("round-trips user project and thread scopes", () => {
    for (const scope of [
      { kind: "user" },
      { kind: "project", projectKey: { kind: "repository", groupingKey: "repo" } },
      { kind: "thread", thread, projectKey: { kind: "explicit", sharedProjectId: "shared" } },
    ])
      round(M.MemoryScope, scope);
  });
  it("rejects malformed scope discriminants and missing locators", () => {
    rejects(M.MemoryScope, { kind: "unknown" });
    rejects(M.MemoryScope, { kind: "project" });
    rejects(M.MemoryScope, { kind: "thread" });
  });
  it("round-trips fact and inference provenance with source watermarks", () => {
    for (const assertionKind of ["fact", "inference"])
      round(M.MemoryOperation, {
        ...operation,
        revision: {
          ...revision,
          assertionKind,
          provenance: { environmentId: "env", sourceThread: thread, sourceWatermark: watermark },
        },
      });
  });
  it("rejects fact without non-model evidence", () => {
    rejects(M.MemoryOperation, {
      ...operation,
      payload: { ...payload, evidence: [{ origin: "model", messageIds: [] }] },
    });
    round(M.MemoryOperation, {
      ...operation,
      revision: { ...revision, assertionKind: "inference" },
      payload: { ...payload, evidence: [{ origin: "model", messageIds: [] }] },
    });
  });
  it("rejects legacy and malformed memory model options", () => {
    for (const options of [
      [{ id: "x", value: 1 }],
      [{ id: "x", value: null }],
      [{ id: "x", value: {} }],
      [{ id: "x", value: [] }],
      [{ id: "", value: true }],
      [{ id: "x", value: "" }],
      [
        { id: "x", value: true },
        { id: "x", value: false },
      ],
      [{ id: "x", value: true, extra: true }],
      [{ id: " x", value: true }],
      [{ id: "x", value: " padded " }],
    ]) {
      const raw = { ...selection, options };
      rejects(M.MemoryModelSelection, raw);
      expect(() => M.MemoryModelSelection.make(raw as never)).toThrow();
      expect(() => Schema.encodeSync(M.MemoryModelSelection)(raw as never)).toThrow();
    }
    for (const raw of [
      { provider: "codex", model: "alias" },
      { ...selection, instanceId: " codex" },
      { ...selection, model: "alias " },
    ])
      rejects(M.MemoryModelSelection, raw);
  });
  it("preserves canonical memory model options round-trip", () => {
    round(M.MemoryModelSelection, selection);
    round(M.MemoryModelSelection, { instanceId: "codex", model: "alias" });
    round(M.MemoryModelSelection, { ...selection, options: [] });
  });
  it("rejects mismatched ids self parents and duplicate heads", () => {
    rejects(M.MemoryOperation, { ...operation, memoryId: id(9) });
    rejects(M.MemoryRevision, { ...revision, parents: [id(3)] });
    rejects(M.MemoryOperation, { ...operation, expectedHeads: [id(5), id(5)] });
  });
  it("rejects unsupported protocol and unknown fields", () => {
    rejects(M.MemoryOperation, { ...operation, protocolVersion: 2 });
    rejects(M.MemoryOperation, { ...operation, credential: "synthetic" });
    rejects(M.MemoryOperation, { ...operation, payload: { ...payload, credential: "synthetic" } });
  });
  it("rejects excess fields on default decode encode and make paths", () => {
    for (const [schema, raw] of [
      [M.MemoryModelSelection, { ...selection, extra: true }],
      [M.MemoryModelSelection, { ...selection, options: [{ id: "x", value: false, extra: true }] }],
      [
        M.MemoryImportProviderInput,
        { memorySpaceId: id(), action: "discover", format: "codex", path: "/private" },
      ],
      [M.MemoryHubSettings, { mode: "disabled", endpoint: "https://old.invalid" }],
      [
        M.MemoryChangeSignal,
        { kind: "reset", memorySpaceId: id(), projectionWatermark: 1, text: "private" },
      ],
    ] as const) {
      rejects(schema, raw);
      expect(() => Schema.encodeUnknownSync(schema)(raw)).toThrow();
      expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(schema))(raw)).toThrow();
      expect(() => Schema.encodeUnknownSync(Schema.toCodecJson(schema))(raw)).toThrow();
      expect(() => schema.make(raw as never)).toThrow();
      expect(() => Schema.decodeUnknownSync(schema, { onExcessProperty: "ignore" })(raw)).toThrow();
    }
  });
  it("encodes events without memory or judgment bodies", () => {
    const value = decode(M.MemoryOperation, operation);
    const json = M.encodeMemoryEventMetadata(value);
    expect(json).not.toContain("Synthetic memory");
    expect(json).not.toContain("evidence");
    expect(M.decodeMemoryOperation(M.encodeMemoryOperation(value))).toEqual(value);
    expect(() =>
      M.encodeMemoryEventMetadata({
        ...value,
        revision: { ...revision, credential: "synthetic" },
      } as never),
    ).toThrow();
  });
  it("encodes tombstones without recoverable content", () => {
    const value = decode(M.MemoryOperation, {
      protocolVersion: 1,
      operationId: id(4),
      memorySpaceId: id(),
      originEnvironmentId: "env",
      memoryId: id(2),
      expectedHeads: [],
      kind: "forget",
      tombstone,
    });
    expect(M.encodeMemoryEventMetadata(value)).not.toContain("Synthetic memory");
    rejects(M.MemoryTombstone, { ...tombstone, text: "body" });
  });
  it("accepts stale structurally valid forget heads", () =>
    round(M.MemoryOperation, {
      protocolVersion: 1,
      operationId: id(6),
      memorySpaceId: id(),
      originEnvironmentId: "other",
      memoryId: id(2),
      expectedHeads: [id(9)],
      kind: "forget",
      tombstone,
    }));
  it("enforces payload limits at equality and overflow", () => {
    round(M.MemoryPayload, { ...payload, text: "x".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES) });
    rejects(M.MemoryPayload, { ...payload, text: "x".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES + 1) });
    round(M.MemoryPayload, {
      ...payload,
      text: "한".repeat(Math.floor(M.MEMORY_BODY_MAX_UTF8_BYTES / 3)),
    });
  });
});
const visible = { exposure: "visible", reasons: [], deferred: [], cleanupPending: false };
const held = {
  exposure: "held",
  reasons: ["scanner_pending"],
  deferred: [],
  cleanupPending: false,
};
const receipt = {
  operationId: id(4),
  memoryId: id(2),
  operationDigest: "a".repeat(64),
  outcome: "accepted",
  hubSequence: 1,
};
const compact = {
  memorySpaceId: id(),
  originEnvironmentId: "env",
  operationKind: "upsert",
  receipt,
  revisionId: id(3),
  resolutionId: null,
  revertsResolutionId: null,
  attemptId: null,
  fencingToken: null,
  reportGuard: null,
};
const identity = {
  memorySpaceId: id(),
  memoryId: id(2),
  scope: { kind: "user" },
  creatingEnvironmentId: "env",
  createOperationId: id(4),
  createdAtUtc: now,
};
const fence = { memorySpaceId: id(), memoryId: id(2), highestFencingToken: 7, activeLease: null };
const checkpoint = {
  memorySpaceId: id(),
  checkpointSequence: 1,
  retentionFloor: 0,
  causalBoundary: { checkpointSequence: 1, boundaryId: "boundary" },
  pageOrdinal: 0,
  items: [],
  revisions: [],
  tombstones: [],
  conflicts: [],
  resolutions: [],
  compactReceipts: [compact],
  identities: [identity],
  fences: [fence],
  suppressions: [],
  nextCursor: null,
  bootstrapComplete: true,
};
const lease = {
  memorySpaceId: id(),
  memoryId: id(2),
  conflictId: id(8),
  conflictHeadSet: [id(3), id(5)],
  holderEnvironmentId: "env",
  attemptId: id(4),
  frozenDefaultModelSelection: selection,
  fencingToken: 7,
  claimedAtHubTime: now,
  expiresAtHubTime: "2026-10-14T00:02:00.000Z",
  attemptDeadlineHubTime: "2026-10-14T00:10:00.000Z",
};
const resolution = {
  resolutionId: id(7),
  memorySpaceId: id(),
  memoryId: id(2),
  inputRevisionIds: [id(5), id(6)],
  inputPayloadRefs: [id(5), id(6)],
  judgmentRef: id(7),
  requestedModelSelection: selection,
  effectiveProvider: "codex",
  effectiveModel: "effective",
  resolvingEnvironmentId: "env",
  fencingToken: 7,
  resultRevisionId: id(3),
  appliedAtUtc: now,
  revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
};
const history = {
  memoryId: id(2),
  revisions: [{ revision, payload: null }],
  resolutions: [{ resolution, payload: null }],
  tombstone: null,
  reports: [],
  revertResults: [],
  localAvailability: visible,
  nextCursor: null,
};
describe("memory sync and views", () => {
  it("round-trips each operation arm", () => {
    round(M.MemoryOperation, operation);
    round(M.MemoryOperation, {
      protocolVersion: 1,
      operationId: id(4),
      memorySpaceId: id(),
      originEnvironmentId: "env",
      memoryId: id(2),
      expectedHeads: [],
      kind: "forget",
      tombstone,
    });
    round(M.MemoryOperation, {
      ...operation,
      kind: "resolve",
      expectedHeads: [id(5), id(6)],
      revision: { ...revision, parents: [id(5), id(6)] },
      resolution,
      resolutionPayload: { resolutionId: id(7), judgment: "Synthetic decision" },
      conflictId: id(8),
      fencingToken: 7,
    });
    round(M.MemoryOperation, {
      ...operation,
      kind: "revert",
      expectedHeads: [id(5)],
      revision: { ...revision, parents: [id(5)] },
      revertsResolutionId: id(7),
      restoredRevisionId: id(6),
    });
  });
  it("rejects resolve authority in client upsert", () => {
    rejects(M.MemoryUpsertInput, {
      memorySpaceId: id(),
      operationId: id(4),
      memoryId: id(2),
      expectedHeads: [],
      scope: { kind: "user" },
      assertionKind: "fact",
      payload,
      baseBoundary: null,
      kind: "resolve",
      fencingToken: 7,
    });
  });
  it("keeps purged history payload nullable", () => round(M.MemoryHistoryPage, history));
  it("requires selected original and one expected head for revert", () => {
    const v = {
      memorySpaceId: id(),
      memoryId: id(2),
      operationId: id(4),
      resolutionId: id(7),
      restoredRevisionId: id(6),
      expectedHeads: [id(5)],
    };
    round(M.MemoryRevertResolutionInput, v);
    rejects(M.MemoryRevertResolutionInput, { ...v, expectedHeads: [] });
    const { restoredRevisionId: _, ...missing } = v;
    rejects(M.MemoryRevertResolutionInput, missing);
  });
  it("enforces snapshot Unicode and UTF8 limits including wrappers", () => {
    const base = { protocolVersion: 1, memorySpaceId: id(), projectionWatermark: 1, items: [] };
    const length = M.MEMORY_CONTEXT_MAX_CHARS - Array.from(M.MEMORY_CONTEXT_OUTER_FRAME).length;
    round(M.MemoryContextSnapshot, { ...base, renderedText: "😀".repeat(length) });
    rejects(M.MemoryContextSnapshot, { ...base, renderedText: "😀".repeat(length + 1) });
  });
  it("includes outer-frame cost in snapshot equality", () => {
    const base = { protocolVersion: 1, memorySpaceId: id(), projectionWatermark: 0, items: [] };
    round(M.MemoryContextSnapshot, {
      ...base,
      renderedText: "x".repeat(6000 - M.MEMORY_CONTEXT_OUTER_FRAME.length),
    });
    rejects(M.MemoryContextSnapshot, { ...base, renderedText: "x".repeat(6000) });
  });
  it("round-trips permanent checkpoint ledger records after purge", () => {
    const p = round(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      revisions: [{ revision, payload: null }],
    });
    expect(M.validateMemoryCheckpointRecords([p])).toBe(true);
  });
  it("preserves original digest outcome and report retry identities", () => {
    expect(round(M.MemoryCompactReceipt, compact).receipt).toEqual(receipt);
    rejects(M.MemoryCompactReceipt, {
      ...compact,
      reportGuard: {
        reportId: "b".repeat(64),
        resolvingEnvironmentId: "env",
        resolutionId: id(7),
        outcome: "resolved",
      },
    });
  });
  it("rejects mismatched duplicate or missing checkpoint ledger identities", () => {
    for (const bad of [
      { ...checkpoint, identities: [] },
      { ...checkpoint, fences: [] },
      { ...checkpoint, identities: [identity, identity] },
      {
        ...checkpoint,
        revisions: [
          {
            revision: {
              ...revision,
              scope: {
                kind: "project",
                projectKey: { kind: "explicit", sharedProjectId: "wrong" },
              },
            },
            payload: null,
          },
        ],
      },
    ])
      expect(M.validateMemoryCheckpointRecords([decode(M.MemoryHubCheckpointPage, bad)])).toBe(
        false,
      );
  });
  it("rejects incomplete ordinals and boundary mismatches", () => {
    expect(
      M.validateMemoryCheckpointRecords([
        decode(M.MemoryHubCheckpointPage, { ...checkpoint, pageOrdinal: 1 }),
      ]),
    ).toBe(false);
    rejects(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      causalBoundary: { checkpointSequence: 2, boundaryId: "boundary" },
    });
  });
  it("links retained resolutions to the same memory resolver and input/result revisions", () => {
    const resolveReceipt = {
      ...compact,
      operationKind: "resolve",
      receipt: { ...receipt, operationId: id(12), hubSequence: 2 },
      revisionId: id(3),
      resolutionId: id(7),
      attemptId: id(13),
      fencingToken: 7,
      reportGuard: {
        reportId: "1de81be9ef4203181b25b4fc4996a81492602dc4b6e61205546257fbb04e8e90",
        resolvingEnvironmentId: "env",
        resolutionId: id(7),
        outcome: "resolved",
      },
    };
    const input = (revisionId: string, operationId: string, memoryId = id(2)) => ({
      revision: { ...revision, memoryId, revisionId, payloadRef: revisionId, operationId },
      payload: null,
    });
    const bIdentity = { ...identity, memoryId: id(20), createOperationId: id(21) };
    const bReceipt = {
      ...compact,
      receipt: { ...receipt, memoryId: id(20), operationId: id(21) },
      revisionId: id(22),
    };
    const result = {
      revision: { ...revision, operationId: id(12), parents: [id(5), id(6)] },
      payload: null,
    };
    const page = {
      ...checkpoint,
      checkpointSequence: 2,
      causalBoundary: { checkpointSequence: 2, boundaryId: "boundary" },
      identities: [identity, bIdentity],
      fences: [fence, { ...fence, memoryId: id(20) }],
      compactReceipts: [
        { ...compact, revisionId: id(5) },
        { ...compact, receipt: { ...receipt, operationId: id(14) }, revisionId: id(6) },
        resolveReceipt,
        bReceipt,
      ],
      revisions: [input(id(5), id(4)), input(id(6), id(14)), result, input(id(22), id(21), id(20))],
      resolutions: [{ resolution, payload: null }],
    };
    expect(M.validateMemoryCheckpointRecords([decode(M.MemoryHubCheckpointPage, page)])).toBe(true);
    const emptyLedger = {
      ...page,
      pageOrdinal: 1,
      identities: [],
      fences: [],
      compactReceipts: [],
      revisions: [],
      resolutions: [],
    };
    for (const collection of [
      "identities",
      "fences",
      "compactReceipts",
      "revisions",
      "resolutions",
    ] as const) {
      expect(
        M.validateMemoryCheckpointRecords([
          decode(M.MemoryHubCheckpointPage, {
            ...page,
            nextCursor: "next",
            bootstrapComplete: false,
          }),
          decode(M.MemoryHubCheckpointPage, {
            ...emptyLedger,
            [collection]: [page[collection][0]],
          }),
        ]),
      ).toBe(false);
    }
    const rejectedAttempt = {
      ...resolveReceipt,
      receipt: {
        ...resolveReceipt.receipt,
        operationId: id(30),
        outcome: "rejected",
        failureCode: "fenced",
      },
      revisionId: null,
      reportGuard: null,
    };
    // An earlier rejected attempt does not hide the committed resolve receipt.
    expect(
      M.validateMemoryCheckpointRecords([
        decode(M.MemoryHubCheckpointPage, {
          ...page,
          compactReceipts: [rejectedAttempt, ...page.compactReceipts],
        }),
      ]),
    ).toBe(true);
    expect(
      M.validateMemoryCheckpointRecords([
        decode(M.MemoryHubCheckpointPage, {
          ...page,
          compactReceipts: [
            ...page.compactReceipts,
            {
              ...resolveReceipt,
              receipt: { ...resolveReceipt.receipt, operationId: id(31) },
            },
          ],
        }),
      ]),
    ).toBe(false);
    for (const bad of [
      // Both identities and fences exist: a retained B resolution cannot reuse A's receipt.
      {
        ...page,
        resolutions: [{ resolution: { ...resolution, memoryId: id(20) }, payload: null }],
      },
      {
        ...page,
        resolutions: [
          { resolution: { ...resolution, resolvingEnvironmentId: "other" }, payload: null },
        ],
      },
      { ...page, revisions: page.revisions.filter((v) => v.revision.revisionId !== id(3)) },
      { ...page, revisions: page.revisions.filter((v) => v.revision.revisionId !== id(6)) },
      {
        ...page,
        resolutions: [
          {
            resolution: {
              ...resolution,
              inputRevisionIds: [id(5), id(22)],
              inputPayloadRefs: [id(5), id(22)],
            },
            payload: null,
          },
        ],
        revisions: [
          page.revisions[0],
          page.revisions[1],
          { ...result, revision: { ...result.revision, parents: [id(5), id(22)] } },
          page.revisions[3],
        ],
      },
      {
        ...page,
        revisions: [
          page.revisions[0],
          page.revisions[1],
          { ...result, revision: { ...result.revision, parents: [id(5)] } },
          page.revisions[3],
        ],
      },
      {
        ...page,
        revisions: [
          page.revisions[0],
          page.revisions[1],
          { ...result, revision: { ...result.revision, provenance: { environmentId: "other" } } },
          page.revisions[3],
        ],
      },
    ])
      expect(M.validateMemoryCheckpointRecords([decode(M.MemoryHubCheckpointPage, bad)])).toBe(
        false,
      );
  });
  it("restores deletion suppression and released lease fencing across pages", () => {
    const deletion = { ...receipt, operationId: id(9), outcome: "deleted", hubSequence: 2 };
    const common = {
      ...checkpoint,
      checkpointSequence: 2,
      causalBoundary: { checkpointSequence: 2, boundaryId: "boundary" },
    };
    const rows = Array.from({ length: 101 }, (_, i) => ({
      kind: "sourceKey",
      memorySpaceId: id(),
      memoryId: id(2),
      deleteOperationId: id(9),
      sourceKey: { environmentId: "env", sourceId: id(10), sourceItemKey: `item-${i}` },
    }));
    const first = decode(M.MemoryHubCheckpointPage, {
      ...common,
      compactReceipts: [
        compact,
        { ...compact, operationKind: "forget", receipt: deletion, revisionId: null },
      ],
      tombstones: [{ ...tombstone, deleteOperationId: id(9) }],
      suppressions: rows.slice(0, 90),
      nextCursor: "next",
      bootstrapComplete: false,
    });
    const second = decode(M.MemoryHubCheckpointPage, {
      ...common,
      pageOrdinal: 1,
      compactReceipts: [],
      identities: [],
      fences: [],
      suppressions: rows.slice(90),
    });
    expect(M.validateMemoryCheckpointRecords([first, second])).toBe(true);
    expect(first.fences[0]?.highestFencingToken).toBe(7);
  });
  it("enforces combined checkpoint record and UTF8 bounds at equality and overflow", () => {
    const rows = Array.from({ length: 98 }, (_, i) => ({ ...identity, memoryId: id(i + 20) }));
    round(M.MemoryHubCheckpointPage, { ...checkpoint, identities: rows });
    rejects(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      identities: [...rows, identity],
    });
  });
  it("uses UTC lease timestamps and safe integer fences", () => {
    round(M.MemoryResolutionLease, lease);
    rejects(M.MemoryResolutionLease, { ...lease, fencingToken: Number.MAX_SAFE_INTEGER + 1 });
    rejects(M.MemoryResolutionLease, { ...lease, expiresAtHubTime: "2026-10-14T00:02:00Z" });
    rejects(M.MemoryResolutionLease, { ...lease, expiresAtHubTime: "2026-10-14T00:11:00.000Z" });
  });
  it("round-trips pinned model options and lease timestamps", () => {
    expect(round(M.MemoryResolutionLease, lease).frozenDefaultModelSelection).toEqual(selection);
    rejects(M.MemoryResolutionLease, {
      ...lease,
      frozenDefaultModelSelection: { ...selection, options: [{ id: "x", value: 2 }] },
    });
  });
  it("requires failure code on rejected receipts", () => {
    rejects(M.MemoryHubReceipt, { ...receipt, outcome: "rejected" });
    round(M.MemoryHubReceipt, { ...receipt, outcome: "rejected", failureCode: "invalid_output" });
  });
  it("round-trips metadata-only checkpoint pages and rejects mixed normal paging", () => {
    round(M.MemoryHubCheckpointPage, checkpoint);
    rejects(M.MemoryHubPullInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      environmentId: "env",
      afterSequence: 0,
      cursor: "bad",
    });
    rejects(M.MemoryHubPullResult, {
      highWatermark: 1,
      throughSequence: 1,
      hasMore: false,
      entries: [{ kind: "metadata", hubSequence: 1, receipt, memoryId: id(2) }],
      checkpoint,
    });
  });
  it("rejects body-bearing quarantined forgotten and blocked items", () => {
    for (const item of [
      {
        status: "blocked",
        scope: { kind: "user" },
        failureCode: "scanner_pending",
        localAvailability: held,
      },
      {
        status: "quarantined",
        scope: { kind: "user" },
        conflict: {
          conflictId: id(8),
          memorySpaceId: id(),
          memoryId: id(2),
          heads: [id(3), id(5)],
          status: "quarantined",
        },
        localAvailability: held,
      },
      {
        status: "forgotten",
        tombstone,
        localAvailability: { ...visible, exposure: "forgotten", cleanupPending: true },
      },
    ]) {
      const v = { memorySpaceId: id(), memoryId: id(2), pendingSync: false, ...item };
      round(M.MemoryItem, v);
      rejects(M.MemoryItem, { ...v, payload });
    }
  });
  it("round-trips report reference and delivery pointers", () => {
    round(M.MemoryReportReference, {
      memorySpaceId: id(),
      environmentId: "env",
      memoryId: id(2),
      resolutionId: id(7),
    });
    const r = {
      reportId: "a".repeat(64),
      operationId: id(4),
      outcome: "resolved",
      resolvingEnvironmentId: "env",
      resolutionId: id(7),
      state: "delivered",
      reportThread: thread,
      sequence: 1,
    };
    round(M.MemoryReportDelivery, r);
    rejects(M.MemoryReportDelivery, { ...r, reportThread: null });
  });
  it("validates model evidence against input without letting output choose ids", () => {
    const input = decode(M.GenerateMemorySummaryInput, {
      cwd: "scratch",
      sourceThread: thread,
      sourceWatermark: watermark,
      messages: [{ messageId: "m1", text: "Synthetic", completed: true }],
      modelSelection: selection,
    });
    const result = decode(M.GenerateMemorySummaryResult, {
      text: "Synthetic",
      assertionKind: "fact",
      evidence: [{ origin: "thread", sourceThread: thread, watermark, messageIds: ["m1"] }],
    });
    expect(M.validateMemoryGenerationResult(input, result)).toBe(true);
    expect(
      M.validateMemoryGenerationResult(input, {
        ...result,
        evidence: [{ ...result.evidence[0]!, messageIds: [M.MessageId.make("unknown")] }],
      }),
    ).toBe(false);
    rejects(M.GenerateMemorySummaryResult, { ...result, revisionId: id(3) });
  });
});
describe("memory bounded transport", () => {
  it("round-trips eleven hub requests and receipts", () => {
    const hub = { protocolVersion: 1, memorySpaceId: id() };
    const leaseKey = {
      ...hub,
      memoryId: id(2),
      conflictId: id(8),
      holderEnvironmentId: "env",
      attemptId: id(4),
    };
    const source = {
      ...hub,
      requestId: id(11),
      memoryId: id(2),
      sourceThread: thread,
      sourceWatermark: watermark,
      messageIds: ["m1"],
      authorizedScopes: ["memory:read", "orchestration:read"],
    };
    const requests: [Schema.Top, unknown][] = [
      [M.MemoryHubJoinInput, { ...hub, environmentId: "env" }],
      [M.MemoryHubPushInput, { ...hub, environmentId: "env", operations: [operation] }],
      [M.MemoryHubPullInput, { ...hub, environmentId: "env", afterSequence: 0 }],
      [
        M.MemoryHubClaimInput,
        { ...leaseKey, conflictHeadSet: [id(3), id(5)], frozenDefaultModelSelection: selection },
      ],
      [M.MemoryHubRenewInput, { ...leaseKey, fencingToken: 7 }],
      [M.MemoryHubReleaseInput, { ...leaseKey, fencingToken: 7 }],
      [
        M.MemoryHubApplyResolutionInput,
        {
          ...hub,
          holderEnvironmentId: "env",
          attemptId: id(4),
          operation: {
            ...operation,
            kind: "resolve",
            expectedHeads: [id(5), id(6)],
            revision: { ...revision, parents: [id(5), id(6)] },
            resolution,
            resolutionPayload: { resolutionId: id(7), judgment: "Decision" },
            conflictId: id(8),
            fencingToken: 7,
          },
        },
      ],
      [M.MemoryHubSourceReadRequestInput, source],
      [M.MemoryHubSourceReadCollectInput, { ...hub, limit: 32 }],
      [
        M.MemoryHubSourceReadRespondInput,
        {
          ...hub,
          requestId: id(11),
          outcome: { kind: "denied", requiredPermission: "orchestration:read" },
        },
      ],
      [M.MemoryHubSourceReadResultInput, { ...hub, requestId: id(11) }],
    ];
    for (const [schema, value] of requests) round(schema, value);
    expect(Object.values(M.MEMORY_HUB_PATHS)).toHaveLength(11);
    round(M.MemoryHubReceipt, receipt);
  });
  it("preserves resolve push envelopes admission errors and accepted replay receipts", () => {
    // Push retains the resolve envelope so the stateful hub can replay an existing receipt; new admission is exclusively apply-resolution.
    const value = {
      ...operation,
      kind: "resolve",
      expectedHeads: [id(5), id(6)],
      revision: { ...revision, parents: [id(5), id(6)] },
      resolution,
      resolutionPayload: { resolutionId: id(7), judgment: "Decision" },
      conflictId: id(8),
      fencingToken: 7,
    };
    round(M.MemoryHubPushInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      environmentId: "env",
      operations: [value],
    });
    round(M.MemoryRpcError, { _tag: "MemoryRpcError", code: "lease_required" });
    round(M.MemoryHubPushResult, { receipts: [receipt] });
  });
  it("unions bounded tombstone fragments preserving original deletion audit", () => {
    const keys = Array.from({ length: 101 }, (_, i) => ({
      environmentId: "env",
      sourceId: id(10),
      sourceItemKey: `key-${i}`,
    }));
    const fragments = [
      round(M.MemoryTombstone, { ...tombstone, suppressedSourceKeys: keys.slice(0, 100) }),
      round(M.MemoryTombstone, { ...tombstone, suppressedSourceKeys: keys.slice(100) }),
    ];
    expect(
      new Set(fragments.flatMap((t) => t.suppressedSourceKeys.map((k) => k.sourceItemKey))).size,
    ).toBe(101);
    expect(fragments.every((t) => t.deleteOperationId === id(4) && t.deletedAtUtc === now)).toBe(
      true,
    );
    rejects(M.MemoryTombstone, { ...tombstone, suppressedSourceKeys: keys });
  });
  it("enforces page batch and payload limits at equality and overflow", () => {
    const v = { ...operation };
    round(M.MemoryHubPushInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      environmentId: "env",
      operations: Array.from({ length: 100 }, () => ({ ...v })),
    });
    rejects(M.MemoryHubPushInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      environmentId: "env",
      operations: Array.from({ length: 101 }, () => ({ ...v })),
    });
    round(M.MemorySourcePage, {
      sourceThread: thread,
      watermark,
      messages: Array.from({ length: 100 }, (_, i) => ({ messageId: `m${i}`, text: "x" })),
      nextCursor: null,
    });
    rejects(M.MemorySourcePage, {
      sourceThread: thread,
      watermark,
      messages: [{ messageId: "m", text: "x".repeat(65536) }],
      nextCursor: null,
    });
  });
  it("round-trips all import actions outcomes and partial receipts", () => {
    for (const action of [
      { action: "discover", format: "codex" },
      { action: "preview", sourceId: id(10) },
      { action: "status", operationId: id(4) },
      {
        action: "apply",
        sourceId: id(10),
        sessionId: "session",
        operationId: id(4),
        items: [
          { sourceItemKey: "item", sourceFingerprint: "a".repeat(64), scope: { kind: "user" } },
        ],
      },
    ])
      round(M.MemoryImportProviderInput, { memorySpaceId: id(), ...action });
    for (const outcome of M.MemoryImportOutcome.literals)
      round(M.MemoryImportItemResult, {
        sourceItemKey: "item",
        outcome,
        memoryId: null,
        revisionId: null,
        ...(outcome === "rejected" ? { issue: "secret_detected" } : {}),
      });
    round(M.MemoryImportReceipt, {
      operationId: id(4),
      sourceId: id(10),
      sessionId: "session",
      sessionNewItems: 1,
      sessionBodyBytes: 10,
      state: "partial",
      items: [],
      remaining: 1,
    });
  });
  it("rejects start cancel paths bodies missing import fingerprints and project selectors without ScopedProjectRef", () => {
    for (const action of ["start", "cancel"])
      rejects(M.MemoryImportProviderInput, { memorySpaceId: id(), action });
    rejects(M.MemoryImportProviderInput, {
      memorySpaceId: id(),
      action: "preview",
      sourceId: id(10),
      path: "/private",
    });
    rejects(M.MemoryImportProviderInput, {
      memorySpaceId: id(),
      action: "apply",
      sourceId: id(10),
      sessionId: "session",
      operationId: id(4),
      items: [
        {
          sourceItemKey: "item",
          sourceFingerprint: "a".repeat(64),
          scope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "shared" } },
        },
      ],
    });
  });
  it("round-trips hub admin actions without leaking credential to settings", () => {
    const base = { requestId: id(4), expectedVersion: 0 };
    for (const action of [
      { action: "configure", settings: { mode: "disabled" } },
      { action: "provisionMember", environmentId: "env" },
      { action: "rotateMemberCredential", environmentId: "env" },
      { action: "revokeMember", environmentId: "env" },
      {
        action: "installCredential",
        hubEnvironmentId: "env",
        endpoint: "https://hub.invalid",
        memorySpaceId: id(),
        credential: "a".repeat(43),
      },
      { action: "acknowledgeCredential", credentialRequestId: id(4) },
    ])
      round(M.MemoryHubSettingsUpdateInput, { ...base, ...action });
    rejects(M.MemoryHubSettings, { mode: "disabled", credential: "synthetic" });
  });
  it("round-trips held visible-unindexed and forgotten cleanup status", () => {
    for (const exposure of ["visible", "held", "forgotten"])
      round(M.MemoryLocalAvailability, { ...visible, exposure, cleanupPending: true });
    round(M.MemoryIndexCoverage, {
      status: "partial",
      eligibleItems: 2,
      indexedItems: 1,
      unindexedItems: 1,
      projectionWatermark: 1,
    });
    rejects(M.MemoryIndexCoverage, {
      status: "available",
      eligibleItems: 2,
      indexedItems: 1,
      unindexedItems: 1,
      projectionWatermark: 1,
    });
    rejects(M.MemoryHistoryPage, {
      ...history,
      localAvailability: held,
      revisions: [{ revision, payload }],
    });
  });
});

describe("memory additional boundary fixtures", () => {
  it("rejects excess error fields on make and constructor paths", () => {
    for (const [ErrorClass, props] of [
      [M.MemoryRpcError, { code: "invalid_output" }],
      [M.MemoryHubError, { code: "invalid_output" }],
      [M.MemoryImportRpcError, { issue: "storage_failed" }],
    ] as const) {
      const made = ErrorClass.make(props as never);
      const constructed = new ErrorClass(props as never);
      expect(made).toBeInstanceOf(ErrorClass);
      expect(constructed).toBeInstanceOf(ErrorClass);
      expect(made).toMatchObject({ ...props, _tag: ErrorClass.identifier });
      expect(constructed).toMatchObject({ ...props, _tag: ErrorClass.identifier });
      expect(ErrorClass.make(made as never)).toBe(made);
      for (const options of [
        undefined,
        { parseOptions: { onExcessProperty: "ignore" as const } },
        { disableChecks: true, parseOptions: { disableChecks: true } },
      ]) {
        const raw = { ...props, cause: "private" };
        expect(() => ErrorClass.make(raw as never, options)).toThrow();
        expect(() => new ErrorClass(raw as never, options)).toThrow();
      }
    }
  });
  it("validates capacity categories on safe errors", () => {
    const capacity = {
      code: "capacity_exceeded",
      dimension: "body",
      current: 16385,
      limit: 16384,
      reclaimable: 0,
    };
    round(M.MemoryRpcError, { _tag: "MemoryRpcError", code: "capacity_exceeded", capacity });
    rejects(M.MemoryRpcError, { _tag: "MemoryRpcError", code: "capacity_exceeded" });
    rejects(M.MemoryHubError, { _tag: "MemoryHubError", code: "invalid_output", capacity });
    rejects(M.MemoryRpcError, { _tag: "MemoryRpcError", code: "invalid_output", cause: "private" });
    rejects(M.MemoryImportRpcError, { _tag: "MemoryImportRpcError", issue: "capacity_exceeded" });
  });
  it("preserves accepted compensation with local exposure hold", () => {
    const base = {
      operationId: id(4),
      memoryId: id(2),
      resolutionId: id(7),
      revertDeadlineUtc: resolution.revertDeadlineUtc,
    };
    round(M.MemoryRevertResult, { ...base, status: "pending" });
    round(M.MemoryRevertResult, {
      ...base,
      status: "accepted",
      receipt: {
        operationId: id(4),
        memoryId: id(2),
        outcome: "accepted",
        revisionId: id(3),
        pendingSync: false,
      },
      localAvailability: held,
    });
    rejects(M.MemoryRevertResult, {
      ...base,
      status: "accepted",
      receipt: {
        operationId: id(4),
        memoryId: id(2),
        outcome: "accepted",
        revisionId: null,
        pendingSync: true,
      },
      localAvailability: held,
    });
    rejects(M.MemoryRevertResult, { ...base, status: "forgotten", receipt: {} });
  });
  it("round-trips all deferred kinds and rejects duplicate or inconsistent states", () => {
    for (const kind of ["index", "scanner", "parent", "projection", "cleanup", "report"]) {
      const deferred = {
        kind,
        state: "held",
        reason: "scanner_pending",
        revisionId: id(3),
        generation: 1,
        sinceAtUtc: now,
      };
      round(M.MemoryDeferredStatus, deferred);
      rejects(M.MemoryDeferredStatus, { ...deferred, sinceAtUtc: null });
      rejects(M.MemoryLocalAvailability, { ...held, deferred: [deferred, deferred] });
    }
    for (const reason of M.MemoryDeferredReason.literals)
      round(M.MemoryLocalAvailability, { ...held, reasons: [reason] });
    rejects(M.MemoryLocalAvailability, { ...held, reasons: ["unknown"] });
  });
  it("round-trips processing counters and rejects inconsistent oldest timestamps", () => {
    const coverage = {
      status: "partial",
      eligibleItems: 2,
      indexedItems: 1,
      unindexedItems: 1,
      projectionWatermark: 3,
    };
    const status = {
      lastReceivedHubSequence: 4,
      receiveLag: 2,
      deferred: 1,
      oldestDeferredAtUtc: now,
      unindexedItems: 1,
      scannerHeldItems: 1,
      scannerPendingItems: 1,
      missingParentItems: 1,
      pendingCleanupItems: 1,
      reportBacklog: 1,
      reportFailed: 1,
      hubAdmissionFailures: 1,
      indexCoverage: coverage,
    };
    round(M.MemoryProcessingStatus, status);
    rejects(M.MemoryProcessingStatus, { ...status, oldestDeferredAtUtc: null });
    round(M.MemoryProcessingStatus, { ...status, deferred: 0, oldestDeferredAtUtc: null });
  });
  it("enforces encoded payload and source page UTF8 equality and overflow", () => {
    const page = {
      sourceThread: thread,
      watermark,
      messages: [{ messageId: "m1", text: "" }],
      nextCursor: null,
    };
    const overhead = new TextEncoder().encode(JSON.stringify(page)).length;
    round(M.MemorySourcePage, {
      ...page,
      messages: [{ messageId: "m1", text: "x".repeat(65536 - overhead) }],
    });
    rejects(M.MemorySourcePage, {
      ...page,
      messages: [{ messageId: "m1", text: "x".repeat(65537 - overhead) }],
    });
  });
  it("rejects forged admission mode on public input", () => {
    rejects(M.MemoryUpsertInput, {
      memorySpaceId: id(),
      operationId: id(4),
      memoryId: id(2),
      expectedHeads: [],
      scope: { kind: "user" },
      assertionKind: "fact",
      payload,
      baseBoundary: null,
      mode: "approvedReplica",
    });
  });
  it("retains canonical checkpoint body while local display is held", () => {
    const item = {
      status: "blocked",
      memorySpaceId: id(),
      memoryId: id(2),
      scope: { kind: "user" },
      failureCode: "scanner_pending",
      pendingSync: false,
      localAvailability: held,
    };
    const p = round(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      items: [item],
      revisions: [{ revision, payload }],
    });
    expect(p.revisions[0]?.payload?.text).toBe(payload.text);
    expect(M.validateMemoryCheckpointRecords([p])).toBe(true);
  });
});
describe("checkpoint byte and retry metadata bounds", () => {
  it("enforces checkpoint serialized UTF8 bytes at equality and overflow", () => {
    const revisions = Array.from({ length: 16 }, (_, i) => ({
      revision: { ...revision, revisionId: id(i + 20), payloadRef: id(i + 20) },
      payload: { ...payload, text: i === 15 ? "x" : "x".repeat(16384) },
    }));
    const page = { ...checkpoint, revisions };
    const size = new TextEncoder().encode(JSON.stringify(page)).length;
    const remaining = 262144 - size;
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThan(16384);
    const last = revisions[15]!;
    const equal = {
      ...page,
      revisions: [
        ...revisions.slice(0, 15),
        { ...last, payload: { ...payload, text: "x".repeat(1 + remaining) } },
      ],
    };
    expect(new TextEncoder().encode(JSON.stringify(equal)).length).toBe(262144);
    round(M.MemoryHubCheckpointPage, equal);
    rejects(M.MemoryHubCheckpointPage, {
      ...equal,
      revisions: [
        ...equal.revisions.slice(0, 15),
        { ...last, payload: { ...payload, text: "x".repeat(2 + remaining) } },
      ],
    });
  });
  it("preserves requested aliases and strict nested selections in checkpoint provenance", () => {
    const provenance = {
      environmentId: "env",
      providerInstanceId: "codex",
      provider: "codex",
      requestedModelSelection: selection,
      effectiveModel: "effective",
    };
    const p = round(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      revisions: [{ revision: { ...revision, provenance }, payload: null }],
    });
    expect(p.revisions[0]?.revision.provenance.requestedModelSelection).toEqual(selection);
    rejects(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      revisions: [
        {
          revision: {
            ...revision,
            provenance: {
              ...provenance,
              requestedModelSelection: { ...selection, options: { effort: 123 } },
            },
          },
          payload: null,
        },
      ],
    });
  });
});

it("preserves well-formed report guard digests after detail purge for server verification", () => {
  const resolveReceipt = {
    ...compact,
    operationKind: "resolve",
    receipt: { ...receipt, operationId: id(12), hubSequence: 2 },
    revisionId: id(3),
    resolutionId: id(7),
    attemptId: id(13),
    fencingToken: 7,
    reportGuard: {
      reportId: "1de81be9ef4203181b25b4fc4996a81492602dc4b6e61205546257fbb04e8e90",
      resolvingEnvironmentId: "env",
      resolutionId: id(7),
      outcome: "resolved",
    },
  };
  const page = {
    ...checkpoint,
    checkpointSequence: 2,
    causalBoundary: { checkpointSequence: 2, boundaryId: "boundary" },
    compactReceipts: [compact, resolveReceipt],
  };
  expect(M.validateMemoryCheckpointRecords([decode(M.MemoryHubCheckpointPage, page)])).toBe(true);
  expect(
    M.validateMemoryCheckpointRecords([
      decode(M.MemoryHubCheckpointPage, {
        ...page,
        compactReceipts: [
          compact,
          {
            ...resolveReceipt,
            reportGuard: { ...resolveReceipt.reportGuard, reportId: "b".repeat(64) },
          },
        ],
      }),
    ]),
  ).toBe(true);
  rejects(M.MemoryCheckpointReportGuard, {
    ...resolveReceipt.reportGuard,
    reportId: "not-a-digest",
  });
});
describe("memory binding and relay contracts", () => {
  const project = { environmentId: "env", projectId: "project" };
  const request = {
    requestId: id(11),
    memorySpaceId: id(),
    requesterEnvironmentId: "env",
    memoryId: id(2),
    sourceThread: thread,
    sourceWatermark: watermark,
    messageIds: ["m1"],
    limit: 20,
    authorizedScopes: ["memory:read", "orchestration:read"],
    expiresAtHubTime: now,
  };
  const page = {
    sourceThread: thread,
    watermark,
    messages: [{ messageId: "m1", text: "Synthetic source" }],
    nextCursor: null,
  };
  it("round trips binding actions and rejects foreign-shaped keys and extra fields", () => {
    for (const action of [
      { action: "setExplicit", sharedProjectId: "shared" },
      { action: "useRepository" },
    ])
      round(M.MemoryProjectBindingUpdateInput, {
        memorySpaceId: id(),
        project,
        requestId: id(4),
        expectedVersion: 0,
        ...action,
      });
    rejects(M.MemoryProjectBindingUpdateInput, {
      memorySpaceId: id(),
      project,
      requestId: id(4),
      expectedVersion: 0,
      action: "useRepository",
      repositoryKey: { kind: "repository", groupingKey: "forged" },
    });
    round(M.MemoryProjectBinding, {
      memorySpaceId: id(),
      project,
      projectKey: null,
      repositoryKey: null,
      version: 0,
    });
  });
  it("round trips body free reset forget and invalidation signals", () => {
    for (const kind of ["reset", "upsert", "forget", "invalidate"])
      round(M.MemoryChangeSignal, {
        kind,
        memorySpaceId: id(),
        projectionWatermark: 2,
        ...(kind === "reset" ? {} : { memoryId: id(2) }),
      });
  });
  it("rejects signal bodies and wrong watermarks", () => {
    rejects(M.MemoryChangeSignal, {
      kind: "reset",
      memorySpaceId: id(),
      projectionWatermark: 2,
      text: "private",
    });
    rejects(M.MemoryChangeSignal, {
      kind: "forget",
      memorySpaceId: id(),
      memoryId: id(2),
      projectionWatermark: -1,
    });
  });
  it("round trips all four relay requests outcomes and expired result", () => {
    round(M.MemoryHubSourceReadRequestInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      requestId: id(11),
      memoryId: id(2),
      sourceThread: thread,
      sourceWatermark: watermark,
      messageIds: ["m1"],
      limit: 20,
      authorizedScopes: ["memory:read", "orchestration:read"],
    });
    round(M.MemoryHubSourceReadCollectInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      limit: 32,
    });
    round(M.MemoryHubSourceReadRespondInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      requestId: id(11),
      outcome: { kind: "available", page },
    });
    round(M.MemoryHubSourceReadResultInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      requestId: id(11),
    });
    for (const outcome of [
      { kind: "available", page },
      { kind: "unavailable", code: "source_unavailable" },
      { kind: "denied", requiredPermission: "orchestration:read" },
    ])
      round(M.MemorySourceReadOutcome, outcome);
    round(M.MemoryHubSourceReadResultResult, { state: "expired", code: "source_unavailable" });
  });
  it("rejects wrong page thread message ids oversized outcome and noncanonical deadline", () => {
    const req = decode(M.MemorySourceReadRequest, request);
    const available = decode(M.MemorySourceReadOutcome, { kind: "available", page });
    expect(M.validateMemorySourceReadOutcome(req, available)).toBe(true);
    for (const bad of [
      { ...page, sourceThread: { ...thread, threadId: "wrong" } },
      { ...page, messages: [{ messageId: "unknown", text: "Synthetic" }] },
    ])
      expect(
        M.validateMemorySourceReadOutcome(
          req,
          decode(M.MemorySourceReadOutcome, { kind: "available", page: bad }),
        ),
      ).toBe(false);
    rejects(M.MemorySourceReadOutcome, {
      kind: "available",
      page: { ...page, messages: [{ messageId: "m1", text: "x".repeat(65536) }] },
    });
    rejects(M.MemorySourceReadRequest, { ...request, expiresAtHubTime: "2026-10-14T00:00:00Z" });
  });
  it("round-trips transient source request ids", () => {
    const source = M.MemorySourceReadRequestId.make(id(11));
    round(M.MemorySourceReadRequestId, source);
  });
});
