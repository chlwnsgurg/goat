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
  return Schema.decodeUnknownSync(schema as S & Schema.ConstraintDecoder<unknown>, {
    onExcessProperty: "error",
  })(value);
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
