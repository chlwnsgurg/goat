import { describe, expect, it } from "@effect/vitest";

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";

import {
  matchRemoteProject,
  readRemoteToolResult,
  resolveSshCliRunner,
} from "./SshRemoteDispatch.ts";

describe("matchRemoteProject", () => {
  const project = { id: "project-1", workspaceRoot: "/home/agent/repo/" };

  it("matches paths with different trailing slash counts", () => {
    expect(
      matchRemoteProject([project], {
        path: "/home/agent/repo///",
        realPath: "/elsewhere",
        os: "Linux",
      }),
    ).toBe(project);
  });

  it("matches the physical path of a browsed symlink", () => {
    expect(
      matchRemoteProject([project], {
        path: "/home/agent/repo-link",
        realPath: "/home/agent/repo",
        os: "Linux",
      }),
    ).toBe(project);
  });

  it("matches different casing on Darwin", () => {
    expect(
      matchRemoteProject([project], {
        path: "/HOME/AGENT/REPO",
        realPath: "/elsewhere",
        os: "Darwin",
      }),
    ).toBe(project);
  });

  it("also folds the physical path on Darwin", () => {
    expect(
      matchRemoteProject([project], {
        path: "/alias",
        realPath: "/HOME/AGENT/REPO/",
        os: "Darwin",
      }),
    ).toBe(project);
  });

  it.each(["Linux", "Windows_NT", "darwin", null])("keeps case-sensitive matching on %s", (os) => {
    expect(
      matchRemoteProject([project], {
        path: "/HOME/AGENT/REPO",
        realPath: "/HOME/AGENT/REPO",
        os,
      }),
    ).toBeUndefined();
  });

  it("prefers an exact match over an earlier case-folded match on Darwin", () => {
    const folded = { id: "folded", workspaceRoot: "/HOME/AGENT/REPO" };
    expect(
      matchRemoteProject([folded, project], {
        path: "/home/agent/repo",
        realPath: "/home/agent/repo",
        os: "Darwin",
      }),
    ).toBe(project);
  });

  it("does not confuse a child folder or path prefix with the registered project", () => {
    expect(
      matchRemoteProject([project], {
        path: "/home/agent/repo/sub",
        realPath: "/home/agent/repo-other",
        os: "Linux",
      }),
    ).toBeUndefined();
  });

  it("preserves the root path and handles an empty project list", () => {
    const root = { id: "root", workspaceRoot: "/" };
    const folder = { path: "/", realPath: "/", os: "Linux" };
    expect(matchRemoteProject([root], folder)).toBe(root);
    expect(matchRemoteProject([], folder)).toBeUndefined();
  });
});

describe("readRemoteToolResult", () => {
  it("returns structured content ahead of a conflicting text payload", () => {
    const payload = { projects: [{ id: "project-1" }] };
    expect(
      readRemoteToolResult("projects_list", {
        structuredContent: payload,
        content: [{ type: "text", text: '{"projects":[]}' }],
      }),
    ).toEqual({ ok: true, value: payload });
  });

  it("decodes pretty JSON text when structured content is absent", () => {
    const payload = { threadId: "thread-1", created: true };
    expect(
      readRemoteToolResult("thread_create", {
        content: [{ type: "image" }, { type: "text", text: JSON.stringify(payload, null, 2) }],
      }),
    ).toEqual({ ok: true, value: payload });
  });

  it("preserves an explicit null structured payload", () => {
    expect(
      readRemoteToolResult("tool", {
        structuredContent: null,
        content: [{ type: "text", text: '{"fallback":true}' }],
      }),
    ).toEqual({ ok: true, value: null });
  });

  it("reports a refusal message from structured content", () => {
    expect(
      readRemoteToolResult("thread_create", {
        isError: true,
        structuredContent: { message: "permission denied" },
        content: [{ type: "text", text: "less specific" }],
      }),
    ).toEqual({ ok: false, message: "The remote thread_create refused: permission denied" });
  });

  it("reports a refusal message from JSON text", () => {
    expect(
      readRemoteToolResult("projects_list", {
        isError: true,
        content: [{ type: "text", text: '{"message":"session expired"}' }],
      }),
    ).toEqual({ ok: false, message: "The remote projects_list refused: session expired" });
  });

  it("keeps a non-JSON refusal's text", () => {
    expect(
      readRemoteToolResult("thread_create", {
        isError: true,
        content: [{ type: "text", text: "operation scope required" }],
      }),
    ).toEqual({ ok: false, message: "The remote thread_create refused: operation scope required" });
  });

  it("gives a useful refusal when the remote returns no details", () => {
    expect(readRemoteToolResult("tool", { isError: true })).toEqual({
      ok: false,
      message: "The remote tool refused: no details",
    });
  });
});

describe("SSH dispatch release mirror", () => {
  it.effect("server runner downloads from the configured mirror", () =>
    Effect.gen(function* () {
      const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            T3CODE_RELEASE_BASE_URL: "  https://mirror.example/goat/  ",
          }),
        ),
      );
      const script = buildRemoteT3RunnerScript(runner);
      expect(script).toContain("T3_RELEASE_BASE_URL='https://mirror.example/goat'");
      expect(script).not.toContain("github.com/goat-si/goat/releases/download");
      expect(runner.archiveDirectory).toBe("/fixture/home/runtime/archives");
      expect(runner.keepExistingRunner).toBe(true);
    }),
  );

  it.effect.each([undefined, "", "  "])(
    "empty mirror %s keeps the authenticated default",
    (value) =>
      Effect.gen(function* () {
        const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord(
              { T3CODE_RELEASE_BASE_URL: value },
              { preserveEmptyStrings: true },
            ),
          ),
        );
        expect("releaseBaseUrl" in runner).toBe(false);
        expect(buildRemoteT3RunnerScript(runner)).toContain(
          "T3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'",
        );
        // The library's blank-mirror behavior test separately proves gh acquisition,
        // since running the generated shell directly is outside the guarded path.
      }),
  );
});
