import { describe, expect, it } from "vite-plus/test";

import { codexCommandActions } from "./CodexCommandActions.ts";

describe("codexCommandActions", () => {
  it("keeps Codex's read, list, and search steps", () => {
    expect(
      codexCommandActions([
        { type: "search", command: "rg -n foo src", query: "foo", path: "src" },
        { type: "read", command: "sed -n 1,80p src/a.ts", name: "a.ts", path: "/repo/src/a.ts" },
        { type: "listFiles", command: "ls", path: null },
      ]),
    ).toEqual([
      { type: "search", query: "foo", path: "src" },
      { type: "read", path: "/repo/src/a.ts" },
      { type: "list" },
    ]);
  });

  it("marks a command with any unknown step as a plain command", () => {
    expect(
      codexCommandActions([
        { type: "read", command: "cat a.ts", name: "a.ts", path: "a.ts" },
        { type: "unknown", command: "vp test run" },
      ]),
    ).toEqual([]);
    expect(codexCommandActions([])).toEqual([]);
  });

  it("drops values the wire cannot carry", () => {
    expect(
      codexCommandActions([{ type: "search", command: "rg", query: "x".repeat(2_000), path: " " }]),
    ).toEqual([{ type: "search" }]);
    expect(codexCommandActions([{ type: "read", command: "cat", name: "", path: "  " }])).toEqual(
      [],
    );
  });
});
