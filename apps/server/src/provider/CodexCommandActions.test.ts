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

  it("keeps commands plain when any action field cannot fit the wire", () => {
    expect(
      codexCommandActions([
        { type: "search", command: "rg", query: "x".repeat(1_025), path: "src" },
      ]),
    ).toEqual([]);
    expect(codexCommandActions([{ type: "read", command: "cat", name: "", path: "  " }])).toEqual(
      [],
    );
    expect(
      codexCommandActions([
        { type: "read", command: "cat", name: "file", path: "x".repeat(4_097) },
      ]),
    ).toEqual([]);
    expect(
      codexCommandActions([{ type: "listFiles", command: "ls", path: "x".repeat(4_097) }]),
    ).toEqual([]);
    expect(
      codexCommandActions([
        { type: "search", command: "rg", query: "foo", path: "x".repeat(4_097) },
      ]),
    ).toEqual([]);
    expect(codexCommandActions([{ type: "listFiles", command: "ls ''", path: "" }])).toEqual([]);
    expect(
      codexCommandActions(
        Array.from({ length: 17 }, () => ({ type: "listFiles", command: "ls", path: null })),
      ),
    ).toEqual([]);
  });

  it("keeps values at the wire limits and omits absent optional fields", () => {
    expect(
      codexCommandActions([
        { type: "search", command: "rg", query: "x".repeat(1_024), path: "p".repeat(4_096) },
        { type: "search", command: "rg -f patterns", query: null, path: null },
      ]),
    ).toEqual([
      { type: "search", query: "x".repeat(1_024), path: "p".repeat(4_096) },
      { type: "search" },
    ]);
  });
});
