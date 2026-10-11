import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProjectId,
  ProjectCreatePayload,
  OrchestratorMcpFailure,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as SshConfig from "@t3tools/ssh/config";
import { SshCommandError } from "@t3tools/ssh/errors";
import { RuntimeMode } from "@t3tools/contracts";
import * as SshTunnel from "@t3tools/ssh/tunnel";

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";

import * as ServerConfig from "../config.ts";
import { hostFailure } from "../mcp/HostThreadsMcpService.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import {
  broadWorkspaceRoot,
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

describe("broadWorkspaceRoot", () => {
  const folder = (path: string, home: string | null = "/Users/jun", realPath = path) => ({
    path,
    realPath,
    home,
  });

  it("refuses the root, home, folders above home, and other top-level folders", () => {
    expect(broadWorkspaceRoot(folder("/"))).toBe("the filesystem root");
    expect(broadWorkspaceRoot(folder("/Users/jun/"))).toBe("the home directory");
    expect(broadWorkspaceRoot(folder("/users/JUN"))).toBe("the home directory");
    expect(broadWorkspaceRoot(folder("/Users"))).toBe("a folder that contains the home directory");
    expect(broadWorkspaceRoot(folder("/tmp"))).toBe("a top-level folder");
    expect(broadWorkspaceRoot(folder("/srv", null))).toBe("a top-level folder");
    expect(broadWorkspaceRoot(folder("C:\\", "C:\\Users\\jun"))).toBe("the filesystem root");
    expect(broadWorkspaceRoot(folder("C:\\Users\\jun", "C:\\Users\\jun"))).toBe(
      "the home directory",
    );
  });

  it("refuses a link whose physical path is the home directory", () => {
    expect(broadWorkspaceRoot(folder("/work/me", "/home/me", "/home/me"))).toBe(
      "the home directory",
    );
  });

  it("accepts a project folder below home or elsewhere", () => {
    expect(broadWorkspaceRoot(folder("/Users/jun/Developer/goat"))).toBeNull();
    expect(broadWorkspaceRoot(folder("/Users/jun/scratch"))).toBeNull();
    expect(broadWorkspaceRoot(folder("/srv/app", null))).toBeNull();
    expect(broadWorkspaceRoot(folder("/home/agent/repo", "/home/agent"))).toBeNull();
  });
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

describe("SSH dispatch packaged runtime", () => {
  it.effect("resolves bundle separately from writable user cache", () =>
    Effect.gen(function* () {
      const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR:
              "  /Applications/GOAT.app/Contents/Resources/ssh-runtime/archives  ",
            T3CODE_SSH_RUNTIME_ARCHIVE_DIR: "/fixture/user-cache",
          }),
        ),
      );
      expect(runner.bundledArchiveDirectory).toBe(
        "/Applications/GOAT.app/Contents/Resources/ssh-runtime/archives",
      );
      expect(runner.archiveDirectory).toBe("/fixture/user-cache");
      expect(runner.keepExistingRunner).toBe(true);
    }),
  );
  it.effect.each([undefined, "", "  "])("omits empty bundle %s", (value) =>
    Effect.gen(function* () {
      const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(
            {
              T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR: value,
            },
            { preserveEmptyStrings: true },
          ),
        ),
      );
      expect("bundledArchiveDirectory" in runner).toBe(false);
      expect(runner.archiveDirectory).toBe("/fixture/home/runtime/archives");
    }),
  );
});

describe("SshRemoteDispatch.callHostTool", () => {
  const host = "build-box";
  const target = { alias: host, hostname: host, username: null, port: null };

  type ToolAnswer =
    | { readonly status: number }
    | { readonly result: unknown }
    | { readonly rpcError: string }
    | { readonly throws: string };

  /**
   * Runs body against a dispatch whose SSH manager and remote /mcp are fakes.
   * `answer` decides each HTTP request; the record says what reached the remote.
   */
  const withRemote = <A, E>(
    options: {
      readonly answer: (request: { readonly method: string; readonly tool?: string }) => ToolAnswer;
      readonly ensureFails?: boolean;
      readonly ceilingApplied?: boolean;
    },
    body: Effect.Effect<A, E, SshRemoteDispatch.SshRemoteDispatch>,
  ) =>
    Effect.gen(function* () {
      const record = { toolCalls: [] as string[], sessionsIssued: 0, requests: 0 };
      const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
        record.requests += 1;
        const request = JSON.parse(String(init?.body)) as {
          id?: string;
          method: string;
          params?: { name?: string };
        };
        if (request.method === "tools/call") record.toolCalls.push(request.params?.name ?? "");
        const answer = options.answer({
          method: request.method,
          ...(request.params?.name === undefined ? {} : { tool: request.params.name }),
        });
        if ("throws" in answer) throw new TypeError(answer.throws);
        if ("status" in answer) return new Response(null, { status: answer.status });
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if ("rpcError" in answer) {
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32602, message: answer.rpcError },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: request.id, result: answer.result });
      });
      const manager = SshTunnel.SshEnvironmentManager.of({
        ensureEnvironment: () =>
          options.ensureFails === true
            ? Effect.fail(
                new SshCommandError({
                  message: "ssh: connect to host build-box port 22: Operation timed out",
                  command: ["ssh", host],
                  exitCode: 255,
                  stderr: "",
                }),
              )
            : Effect.succeed({
                target,
                httpBaseUrl: "http://127.0.0.1:41000/",
                wsBaseUrl: "ws://127.0.0.1:41000/",
                pairingToken: null,
              }),
        disconnectEnvironment: () => Effect.die("Unexpected SSH disconnect"),
        issueMcpClientSession: () =>
          Effect.sync(() => {
            record.sessionsIssued += 1;
            return {
              token: `session-${record.sessionsIssued}`,
              expiresAt: null,
              runtimeModeCeilingApplied: options.ceilingApplied ?? true,
            };
          }),
        runRemoteScript: () => Effect.die("Unexpected remote script"),
      });
      const discoverHosts = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
      const managerLayer = vi
        .spyOn(SshTunnel.SshEnvironmentManager, "layer")
        .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
      vi.stubGlobal("fetch", fetchEndpoint);
      try {
        const result = yield* body.pipe(
          Effect.result,
          Effect.provide(
            SshRemoteDispatch.layer.pipe(
              Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-host-call-test-" })),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        return { result, record };
      } finally {
        vi.unstubAllGlobals();
        managerLayer.mockRestore();
        discoverHosts.mockRestore();
      }
    });

  const initialize = (request: { readonly method: string }): ToolAnswer | undefined =>
    request.method === "initialize"
      ? {
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "GOAT", version: "test" },
          },
        }
      : request.method === "notifications/initialized"
        ? { result: null }
        : undefined;

  const readCall = (authorize: Effect.Effect<RuntimeMode> = Effect.succeed("full-access")) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const value = yield* dispatch.callHostTool(
        {
          host,
          tool: "goat_thread_read",
          arguments: { threadId: "thread-1" },
          timeoutMs: 5_000,
          writes: false,
        },
        authorize,
      );
      return { value, connected: yield* dispatch.connectedHosts };
    });

  it.effect("returns the remote result and remembers the host as connected", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withRemote(
        {
          answer: (request) =>
            initialize(request) ?? { result: { structuredContent: { threadId: "thread-1" } } },
        },
        readCall(),
      );
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(result.success.value).toEqual({ threadId: "thread-1" });
      expect(result.success.connected).toEqual([host]);
      expect(record.toolCalls).toEqual(["goat_thread_read"]);
    }),
  );

  it.effect("reports a tunnel that cannot be opened as host_unavailable", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withRemote(
        { ensureFails: true, answer: () => ({ result: null }) },
        readCall(),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("host_unavailable");
      expect(record.requests).toBe(0);
    }),
  );

  it.effect("reports a remote server that does not answer HTTP as host_unavailable", () =>
    Effect.gen(function* () {
      const { result } = yield* withRemote(
        { answer: () => ({ throws: "fetch failed" }) },
        readCall(),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("host_unavailable");
    }),
  );

  it.effect("keeps the remote's own failure code, distinct from an unreachable host", () =>
    Effect.gen(function* () {
      const { result } = yield* withRemote(
        {
          answer: (request) =>
            initialize(request) ?? {
              result: {
                isError: true,
                structuredContent: {
                  _tag: "OrchestratorMcpFailure",
                  code: "thread_not_found",
                  message: "The thread was not found.",
                },
              },
            },
        },
        readCall(),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure.reason).toBe("remote_refused");
      expect(result.failure.remoteCode).toBe("thread_not_found");
      expect(hostFailure(result.failure).code).toBe("thread_not_found");
    }),
  );

  it.effect("treats a JSON-RPC refusal as a refusal, not an unreachable host", () =>
    Effect.gen(function* () {
      const { result } = yield* withRemote(
        { answer: (request) => initialize(request) ?? { rpcError: "Unknown tool" } },
        readCall(),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("remote_refused");
    }),
  );

  it.effect("signs in anew once when the remote rejects the cached session", () =>
    Effect.gen(function* () {
      let rejected = false;
      const { result, record } = yield* withRemote(
        {
          answer: (request) => {
            if (!rejected) {
              rejected = true;
              return { status: 401 };
            }
            return initialize(request) ?? { result: { structuredContent: { ok: true } } };
          },
        },
        readCall(),
      );
      expect(result._tag).toBe("Success");
      expect(record.sessionsIssued).toBe(2);
    }),
  );

  it.effect("sends nothing when the caller's runtime mode drops during the handshake", () =>
    Effect.gen(function* () {
      let checks = 0;
      const authorize = Effect.sync((): RuntimeMode => {
        checks += 1;
        return checks === 1 ? "full-access" : "approval-required";
      });
      const { result, record } = yield* withRemote(
        { answer: (request) => initialize(request) ?? { result: { structuredContent: {} } } },
        readCall(authorize),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("caller_changed");
      expect(record.toolCalls).toEqual([]);
      expect(result._tag === "Failure" && hostFailure(result.failure).code).toBe(
        "runtime_mode_escalation_denied",
      );
    }),
  );

  it.effect("refuses writes on a remote that cannot apply the caller's ceiling", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withRemote(
        { ceilingApplied: false, answer: () => ({ result: null }) },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.callHostTool(
            {
              host,
              tool: "goat_thread_send",
              arguments: { threadId: "thread-1", message: "status?" },
              timeoutMs: 5_000,
              writes: true,
            },
            Effect.succeed("full-access"),
          );
        }),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("remote_refused");
      expect(record.requests).toBe(0);
    }),
  );
});

// Exercise the real project-create authorization declaration at the fake remote HTTP boundary.
const RegistrationToolkit = Toolkit.make(
  Tool.make("goat_project_create", {
    parameters: ProjectCreatePayload,
    success: Schema.Struct({ id: ProjectId }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  }),
);
const registrationLayer = McpHttpServer.toolkitRegistration(
  RegistrationToolkit,
  McpToolAccess.toLayer(RegistrationToolkit, {
    goat_project_create: McpToolAccess.writesEnvironment(() =>
      Effect.succeed({ id: ProjectId.make("rp") }),
    ),
  }),
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
);
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const checkRegistration = (args: Record<string, unknown>, ceiling: RuntimeMode) =>
  Effect.scoped(
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name: "goat_project_create", arguments: args })),
      Effect.provide(registrationLayer),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("remote"),
        requestNamespace: "client:session",
        thread: undefined,
        client: { sessionId: "session", label: "GOAT", access: ceiling },
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 0,
      }),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
    ),
  );
const capabilityFixture = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [
    {
      providerInstanceId: "codex",
      driverKind: "codex",
      displayName: null,
      models: [{ id: "model", label: null }],
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 10,
  },
};
const savedTarget = { alias: "unlisted", hostname: "host.test", username: "runner", port: 2222 };
const launchInput: SshRemoteDispatch.SshLaunchInput = {
  target: savedTarget,
  cwd: "/home/agent/.goat/repos/repo-12345678",
  workspace: {
    type: "worktree",
    baseRef: "refs/heads/goat/ssh-base/12345678",
    branch: "goat/ssh/12345678",
  },
  title: "Work",
  message: "Implement",
  runtimeMode: "approval-required",
  callerRuntimeMode: "full-access",
  interactionMode: "default",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
};
const withLaunchRemote = <A, E>(
  options: {
    existing?: boolean;
    ceilingApplied?: boolean;
    identity?: unknown;
    capabilities?: unknown;
    launchReply?: unknown;
    transportFailure?: boolean;
    refusal?: boolean;
    projectReply?: unknown;
    broad?: boolean;
    registrationAccess?: boolean;
  },
  body: (record: {
    tools: { name: string; args: Record<string, unknown>; authorization: string | null }[];
    targets: DesktopSshEnvironmentTarget[];
    sessions: { target: DesktopSshEnvironmentTarget; ceiling: RuntimeMode }[];
  }) => Effect.Effect<A, E, SshRemoteDispatch.SshRemoteDispatch>,
) =>
  Effect.gen(function* () {
    const record = {
      tools: [] as { name: string; args: Record<string, unknown>; authorization: string | null }[],
      targets: [] as DesktopSshEnvironmentTarget[],
      sessions: [] as { target: DesktopSshEnvironmentTarget; ceiling: RuntimeMode }[],
    };
    const manager = SshTunnel.SshEnvironmentManager.of({
      ensureEnvironment: (target) =>
        Effect.sync(() => {
          record.targets.push(target);
          return {
            target,
            httpBaseUrl: "http://fixture.invalid/",
            wsBaseUrl: "ws://fixture.invalid/",
            pairingToken: null,
          };
        }),
      disconnectEnvironment: () => Effect.void,
      issueMcpClientSession: (target, opts) =>
        Effect.sync(() => {
          record.sessions.push({ target, ceiling: opts.runtimeModeCeiling as RuntimeMode });
          return {
            token: `token-${record.sessions.length}`,
            expiresAt: null,
            runtimeModeCeilingApplied: options.ceilingApplied ?? true,
          };
        }),
      runRemoteScript: (target) =>
        Effect.sync(() => {
          record.targets.push(target);
          const path = options.broad ? "/home/agent" : launchInput.cwd;
          return {
            stdout: `T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t${path}\nREAL\t${path}\nGITROOT\t${path}\n`,
            stderr: "",
          };
        }),
    });
    const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(Effect.succeed([]));
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    const registrationRequests = yield* Queue.unbounded<{
      args: Record<string, unknown>;
      ceiling: RuntimeMode;
      resolve: (value: Effect.Success<ReturnType<typeof checkRegistration>>) => void;
      reject: (error: Error) => void;
    }>();
    yield* Stream.fromQueue(registrationRequests).pipe(
      Stream.runForEach((request) =>
        checkRegistration(request.args, request.ceiling).pipe(
          Effect.matchCause({
            onFailure: () => request.reject(new Error("Fake registration failed")),
            onSuccess: request.resolve,
          }),
        ),
      ),
      Effect.forkChild,
    );
    const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as {
        id?: string;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (req.method === "initialize")
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "GOAT", version: "test" },
        };
      else if (req.method === "tools/list")
        result = {
          tools: [
            "goat_project_list",
            "goat_project_create",
            "goat_thread_launch",
            "goat_environment_read",
            "orchestrator_capabilities",
          ].map((name) => ({ name })),
        };
      else {
        const name = req.params?.name ?? "";
        const args = req.params?.arguments ?? {};
        const auth = new Headers(init?.headers).get("authorization");
        record.tools.push({ name, args, authorization: auth });
        if (name === "goat_thread_launch" && options.transportFailure)
          throw new TypeError("lost response");
        if (name === "goat_project_create" && options.registrationAccess) {
          const session = record.sessions[Number(auth?.split("-").at(-1)) - 1]!;
          result = await new Promise<Effect.Success<ReturnType<typeof checkRegistration>>>(
            (resolve, reject) => {
              Queue.offerUnsafe(registrationRequests, {
                args,
                ceiling: session.ceiling,
                resolve,
                reject,
              });
            },
          );
        } else {
          const value =
            name === "goat_project_list"
              ? {
                  projects: options.existing
                    ? [{ id: "existing", workspaceRoot: launchInput.cwd }]
                    : [],
                  nextCursor: null,
                }
              : name === "goat_project_create"
                ? (options.projectReply ?? { id: "rp" })
                : name === "goat_environment_read"
                  ? (options.identity ?? { environmentId: "remote" })
                  : name === "orchestrator_capabilities"
                    ? (options.capabilities ?? capabilityFixture)
                    : (options.launchReply ?? { threadId: "rt", runId: "run" });
          result = {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
            ...(name === "goat_thread_launch" && options.refusal ? { isError: true } : {}),
          };
        }
      }
      return Response.json({ jsonrpc: "2.0", id: req.id, result });
    });
    vi.stubGlobal("fetch", fetchEndpoint);
    try {
      return yield* body(record).pipe(
        Effect.provide(
          SshRemoteDispatch.layer.pipe(
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-saved-target-" })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    } finally {
      vi.unstubAllGlobals();
      managerLayer.mockRestore();
      discover.mockRestore();
    }
  });

it.effect("launch accepts saved full target without rediscovering its alias", () =>
  withLaunchRemote({}, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const result = yield* dispatch.launchThread(launchInput, Effect.void);
      expect(result.threadId).toBe("rt");
      expect(result.runId).toBe("run");
      expect(record.targets.every((target) => target === savedTarget)).toBe(true);
      expect(record.sessions[0]?.ceiling).toBe("full-access");
    }),
  ),
);
it.effect("alias launch remains compatible", () =>
  withLaunchRemote({}, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const { target: _target, ...input } = launchInput;
      const error = yield* dispatch
        .launchThread({ ...input, host: "unknown" }, Effect.void)
        .pipe(Effect.flip);
      expect(error.reason).toBe("host_unknown");
      expect(record.targets).toHaveLength(0);
    }),
  ),
);
it.effect("same alias different user or port gets a separate session", () =>
  withLaunchRemote({}, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      for (const target of [
        savedTarget,
        { ...savedTarget, username: "other" },
        { ...savedTarget, port: 2223 },
        { ...savedTarget, hostname: "other.test" },
        savedTarget,
      ])
        yield* dispatch.launchThread({ ...launchInput, target }, Effect.void);
      expect(record.sessions).toHaveLength(4);
      expect(
        record.tools
          .filter((call) => call.name === "goat_thread_launch")
          .map((call) => call.authorization),
      ).toEqual([
        "Bearer token-1",
        "Bearer token-2",
        "Bearer token-3",
        "Bearer token-4",
        "Bearer token-1",
      ]);
    }),
  ),
);
it.effect("scripts reach new remote project creation", () =>
  withLaunchRemote({}, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const scripts = [
        {
          id: "setup",
          name: "Setup",
          command: "echo setup",
          icon: "play" as const,
          async: true,
          runOnWorktreeCreate: true,
        },
      ];
      yield* dispatch.launchThread({ ...launchInput, scripts }, Effect.void);
      const args = record.tools.find((call) => call.name === "goat_project_create")!.args;
      expect((yield* Schema.decodeUnknownEffect(ProjectCreatePayload)(args)).scripts).toEqual(
        scripts,
      );
      expect(args).not.toHaveProperty("allowBroadWorkspaceRoot");
    }),
  ),
);
it.effect("existing remote project retains scripts", () =>
  withLaunchRemote({ existing: true }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      yield* dispatch.launchThread({ ...launchInput, scripts: [] }, Effect.void);
      expect(record.tools.map((call) => call.name)).toEqual([
        "goat_project_list",
        "goat_thread_launch",
      ]);
    }),
  ),
);
it.effect.each(
  [{ ceilingApplied: false }, { identity: { environmentId: " " } }, { capabilities: {} }].map(
    (opts) =>
      [
        `preflight reads actual environment identity and refuses old remote ${JSON.stringify(opts)}`,
        opts,
      ] as const,
  ),
)("%s", ([_name, opts]) =>
  withLaunchRemote(opts, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const result = yield* dispatch
        .preflightTarget({
          target: savedTarget,
          runtimeMode: "full-access",
          modelSelection: launchInput.modelSelection!,
        })
        .pipe(Effect.flip);
      expect(result.reason).toBe("remote_refused");
      expect(record.tools.some((call) => call.name === "goat_thread_launch")).toBe(false);
    }),
  ),
);
it.effect("preflight reads actual environment identity and selected model", () =>
  withLaunchRemote({}, () =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      expect(
        yield* dispatch.preflightTarget({
          target: savedTarget,
          runtimeMode: "full-access",
          modelSelection: launchInput.modelSelection!,
        }),
      ).toEqual({ environmentId: "remote" });
      for (const selection of [
        { instanceId: ProviderInstanceId.make("missing"), model: "model" },
        { instanceId: ProviderInstanceId.make("codex"), model: "missing" },
      ])
        expect(
          (yield* dispatch
            .preflightTarget({
              target: savedTarget,
              runtimeMode: "full-access",
              modelSelection: selection,
            })
            .pipe(Effect.flip)).remoteCode,
        ).toBe("model_unavailable");
    }),
  ),
);
it.effect.each(
  [{ transportFailure: true }, { launchReply: {} }, { launchReply: { threadId: " " } }].map(
    (opts) =>
      [
        `launch missing acknowledgement is uncertain and not retried ${JSON.stringify(opts)}`,
        opts,
      ] as const,
  ),
)("%s", ([_name, opts]) =>
  withLaunchRemote(opts, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      expect(
        (yield* dispatch.launchThread(launchInput, Effect.void).pipe(Effect.flip))
          .launchMayHaveStarted,
      ).toBe(true);
      expect(record.tools.filter((call) => call.name === "goat_thread_launch")).toHaveLength(1);
    }),
  ),
);
it.effect("structured remote refusal is definite", () =>
  withLaunchRemote(
    { refusal: true, launchReply: { code: "invalid_request", message: "refused" } },
    (record) =>
      Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        const error = yield* dispatch.launchThread(launchInput, Effect.void).pipe(Effect.flip);
        expect(error.reason).toBe("remote_refused");
        expect(error.launchMayHaveStarted).toBeUndefined();
        expect(record.tools.filter((call) => call.name === "goat_thread_launch")).toHaveLength(1);
      }),
  ),
);
it.effect("first registration permits an approval-required thread under full-access ceiling", () =>
  withLaunchRemote({ registrationAccess: true }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      yield* dispatch.launchThread(launchInput, Effect.void);
      expect(record.sessions[0]?.ceiling).toBe("full-access");
      expect(
        record.tools.find((call) => call.name === "goat_thread_launch")?.args.runtimeMode,
      ).toBe("approval-required");
      const refused = yield* dispatch
        .launchThread({ ...launchInput, callerRuntimeMode: "approval-required" }, Effect.void)
        .pipe(Effect.flip);
      expect(refused.reason).toBe("remote_refused");
      expect(record.tools.filter((call) => call.name === "goat_thread_launch")).toHaveLength(1);
    }),
  ),
);
it.effect("full target keeps broad-root guard and explicit override", () =>
  withLaunchRemote({ broad: true }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      expect(
        (yield* dispatch.launchThread(launchInput, Effect.void).pipe(Effect.flip)).reason,
      ).toBe("invalid_request");
      expect(record.tools).toHaveLength(0);
      yield* dispatch.launchThread({ ...launchInput, allowBroadWorkspaceRoot: true }, Effect.void);
      expect(
        record.tools.find((call) => call.name === "goat_project_create")?.args,
      ).not.toHaveProperty("allowBroadWorkspaceRoot");
    }),
  ),
);
it.effect("invalid project acknowledgement refuses before launch", () =>
  withLaunchRemote({ projectReply: { id: " " } }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      expect(
        (yield* dispatch.launchThread(launchInput, Effect.void).pipe(Effect.flip))
          .launchMayHaveStarted,
      ).toBeUndefined();
      expect(record.tools.some((call) => call.name === "goat_thread_launch")).toBe(false);
    }),
  ),
);
