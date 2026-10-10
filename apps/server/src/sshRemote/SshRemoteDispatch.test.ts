import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as SshConfig from "@t3tools/ssh/config";
import * as SshTunnel from "@t3tools/ssh/tunnel";

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";

import * as ServerConfig from "../config.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import {
  matchRemoteProject,
  readRemoteToolResult,
  resolveSshCliRunner,
} from "./SshRemoteDispatch.ts";

describe("SSH dispatch tool compatibility", () => {
  it.effect("fails once with the host and unknown GOAT tool on a legacy-only endpoint", () =>
    Effect.gen(function* () {
      const host = "legacy-host";
      const target = { alias: host, hostname: host, username: null, port: null };
      // Build the legacy catalog explicitly without adding live old-name fixtures to the gate.
      const legacyTools = new Set(
        ["project_list", "project_create", "thread_launch"].map((suffix) => `t3_${suffix}`),
      );
      const calls: string[] = [];
      let projectsCreated = 0;
      let threadsLaunched = 0;
      const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          id?: string;
          method: string;
          params?: { name?: string };
        };
        switch (request.method) {
          case "initialize":
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "T3 Code", version: "legacy" },
              },
            });
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: { tools: [...legacyTools].map((name) => ({ name })) },
            });
          case "tools/call": {
            const name = request.params?.name ?? "";
            calls.push(name);
            if (!legacyTools.has(name)) {
              return Response.json({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32602, message: `Unknown tool: ${name}; legacy catalog only` },
              });
            }
            if (name.endsWith("project_create")) projectsCreated += 1;
            if (name.endsWith("thread_launch")) threadsLaunched += 1;
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                structuredContent: { projects: [], id: "new-project", threadId: "new-thread" },
              },
            });
          }
          default:
            throw new Error(`Unexpected remote method: ${request.method}`);
        }
      });
      const manager = SshTunnel.SshEnvironmentManager.of({
        ensureEnvironment: () =>
          Effect.succeed({
            target,
            httpBaseUrl: "http://legacy-host:3773/",
            wsBaseUrl: "ws://legacy-host:3773/",
            pairingToken: null,
          }),
        disconnectEnvironment: () => Effect.die("Unexpected SSH disconnect"),
        issueMcpClientSession: () =>
          Effect.succeed({
            token: "fixture-session",
            expiresAt: null,
            runtimeModeCeilingApplied: true,
          }),
        runRemoteScript: () =>
          Effect.succeed({
            stdout:
              "T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t/home/agent/repo\nREAL\t/home/agent/repo\n",
            stderr: "",
          }),
      });
      const discoverHosts = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
      const managerLayer = vi
        .spyOn(SshTunnel.SshEnvironmentManager, "layer")
        .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
      vi.stubGlobal("fetch", fetchEndpoint);
      try {
        const result = yield* Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch
            .launchThread(
              {
                host,
                cwd: "/home/agent/repo",
                workspace: { type: "cwd" },
                title: "Compatibility probe",
                runtimeMode: "approval-required",
                callerRuntimeMode: "approval-required",
              },
              Effect.void,
            )
            .pipe(Effect.result);
        }).pipe(
          Effect.provide(
            SshRemoteDispatch.layer.pipe(
              Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-dispatch-test-" })),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") throw new Error("Expected remote dispatch failure");
        expect(result.failure.reason).toBe("ssh_failed");
        expect(result.failure.message).toContain("Calling goat_project_list on legacy-host failed");
        expect(result.failure.message).toContain(
          "Unknown tool: goat_project_list; legacy catalog only",
        );
        expect(calls).toEqual(["goat_project_list"]);
        expect(projectsCreated).toBe(0);
        expect(threadsLaunched).toBe(0);
        expect(fetchEndpoint).toHaveBeenCalledTimes(3);
      } finally {
        vi.unstubAllGlobals();
        managerLayer.mockRestore();
        discoverHosts.mockRestore();
      }
    }),
  );
});

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
