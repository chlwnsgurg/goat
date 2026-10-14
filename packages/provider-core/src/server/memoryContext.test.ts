import { describe, expect, it } from "vite-plus/test";
import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  memoryContextFits,
  memoryContextText,
  packMemoryContext,
  renderMemoryContext,
  validateMemoryContext,
} from "./memoryContext.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n: number, text: string): M.MemoryContextCandidate =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      memoryId: M.MemoryId,
      revisionId: M.MemoryRevisionId,
      scope: M.MemoryScope,
      provenance: M.MemoryProvenance,
      assertionKind: M.MemoryAssertionKind,
      text: Schema.String,
    }),
  )({
    memoryId: id(n),
    revisionId: id(n + 1000),
    scope: { kind: "user" },
    provenance: { environmentId: "fixture" },
    assertionKind: "fact",
    text,
  });
const input = (items: ReadonlyArray<M.MemoryContextCandidate>) => ({
  memorySpaceId: M.MemorySpaceId.make(id(999)),
  projectionWatermark: 1,
  items,
});

describe("memory native data framing", () => {
  it("escapes data and locators while preserving original fact text", () => {
    const original = `& <instructions> 'quoted' "text" 😀 é`;
    const snapshot = packMemoryContext(input([item(1, original)]))!;
    expect(snapshot.items[0]?.text).toBe(original);
    expect(snapshot.renderedText).toContain("&amp; &lt;instructions&gt;");
    expect(snapshot.renderedText).toContain("&apos;quoted&apos;");
    expect(validateMemoryContext(snapshot)).toEqual(snapshot);
    expect(memoryContextText(snapshot)).toBe(
      `<external_goat_memory>${snapshot.renderedText}</external_goat_memory>`,
    );
    expect(() =>
      validateMemoryContext({
        ...snapshot,
        renderedText: snapshot.renderedText.replace("quoted", "tampered"),
      }),
    ).toThrow();
    expect(() => validateMemoryContext({ ...snapshot, permission: "write" })).toThrow();
  });
  it("counts complete frame, Unicode code points, bytes and escaping", () => {
    const outerCost = Array.from(M.MEMORY_CONTEXT_OUTER_FRAME).length;
    expect(memoryContextFits("x".repeat(M.MEMORY_CONTEXT_MAX_CHARS - outerCost))).toBe(true);
    expect(memoryContextFits("x".repeat(M.MEMORY_CONTEXT_MAX_CHARS - outerCost + 1))).toBe(false);
    expect(memoryContextFits("😀".repeat(M.MEMORY_CONTEXT_MAX_CHARS - outerCost))).toBe(true);
    const prefix = renderMemoryContext([item(1, "")]);
    const maxFact = M.MEMORY_CONTEXT_MAX_CHARS - outerCost - Array.from(prefix).length;
    const exact = packMemoryContext(input([item(1, "x".repeat(maxFact))]))!;
    expect(Array.from(memoryContextText(exact))).toHaveLength(M.MEMORY_CONTEXT_MAX_CHARS);
    expect(packMemoryContext(input([item(1, "x".repeat(maxFact + 1))]))).toBeUndefined();
    expect(packMemoryContext(input([item(1, "&".repeat(2000))]))).toBeUndefined();
    expect(new TextEncoder().encode(memoryContextText(exact)).length).toBeLessThanOrEqual(
      M.MEMORY_CONTEXT_MAX_UTF8_BYTES,
    );
  });
  it("drops whole oversize facts and preserves deterministic survivor order", () => {
    const snapshot = packMemoryContext(
      input([item(1, "x".repeat(7000)), item(2, "kept"), item(3, "next")]),
    )!;
    expect(snapshot.items.map((v) => v.memoryId)).toEqual([id(2), id(3)]);
    expect(snapshot.renderedText).toBe(renderMemoryContext(snapshot.items));
    expect(packMemoryContext(input([]))).toBeUndefined();
    expect(() => packMemoryContext(input([item(2, "first"), item(2, "again")]))).toThrow();
  });
});
