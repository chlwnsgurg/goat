import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PreviewAutomationWaitForInput } from "./previewAutomation.ts";

describe("PreviewAutomationWaitForInput", () => {
  const decode = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);

  it("accepts a load milestone without a locator", () => {
    expect(decode({ loadState: "domContentLoaded" })).toEqual({ loadState: "domContentLoaded" });
  });

  it.each(["attached", "visible", "hidden", "detached"])("accepts locator state %s", (state) => {
    expect(decode({ locator: "#dialog", state })).toEqual({ locator: "#dialog", state });
  });

  it("keeps existing conjunctions and rejects incomplete or contradictory targets", () => {
    const legacy = { selector: "#done", text: "Done", urlIncludes: "#done" };
    expect(decode(legacy)).toEqual(legacy);
    for (const input of [
      {},
      { state: "hidden", text: "Done" },
      { selector: "#one", locator: "#two" },
      { locator: "#one", state: "missing" },
      { loadState: "commit" },
      { loadState: "load", timeoutMs: 0 },
      { loadState: "networkIdle", timeoutMs: 60_001 },
    ])
      expect(() => decode(input)).toThrow();
    expect(decode({ loadState: "networkIdle", timeoutMs: 60_000 }).timeoutMs).toBe(60_000);
  });
});
