import type {
  DesktopSshEnvironmentTarget,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { discoverSshHosts } from "@t3tools/ssh/config";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { callAcpMcpTool } from "../mcp/AcpMcpStdioBridge.ts";
import {
  buildRemoteBrowseScript,
  parseRemoteBrowseOutput,
  type RemoteDirectoryEntry,
  type RemoteWorktree,
} from "./remoteBrowse.ts";

/**
 * Lets an agent in this environment reach another machine over SSH: list the
 * hosts this machine's SSH config knows, browse folders on one, and start a
 * thread in that machine's own T3 environment. The remote keeps owning its
 * projects, worktrees and threads; this process only launches or reuses the
 * remote server through the shared SSH manager and then calls the remote's
 * own `/mcp` tools as an outside agent with a short-lived session.
 */

export class SshRemoteDispatchError extends Data.TaggedError("SshRemoteDispatchError")<{
  readonly reason: "invalid_request" | "host_unknown" | "ssh_failed" | "remote_refused";
  readonly message: string;
}> {}

export interface SshDispatchHost {
  readonly alias: string;
  readonly source: "ssh-config" | "known-hosts";
  readonly reachable?: boolean;
  readonly probeError?: string;
}

export interface SshBrowseResult {
  readonly host: string;
  readonly os: string | null;
  readonly home: string | null;
  readonly path: string;
  readonly realPath: string;
  readonly gitRoot: string | null;
  readonly branch: string | null;
  readonly worktrees: ReadonlyArray<RemoteWorktree>;
  readonly entries: ReadonlyArray<RemoteDirectoryEntry>;
  readonly truncated: boolean;
}

export type SshLaunchWorkspace =
  | { readonly type: "cwd" }
  | {
      readonly type: "worktree";
      readonly branch: string;
      readonly baseRef?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    };

export interface SshLaunchInput {
  readonly host: string;
  readonly cwd: string;
  readonly workspace: SshLaunchWorkspace;
  readonly title: string;
  readonly message?: string | undefined;
  readonly projectTitle?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode;
  /**
   * The most the caller may grant. The remote session carries this ceiling so
   * it can register projects; the thread itself starts with runtimeMode.
   */
  readonly callerRuntimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}

export interface SshLaunchResult {
  readonly host: string;
  readonly cwd: string;
  readonly projectId: string;
  readonly projectCreated: boolean;
  readonly threadId: string;
  readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  readonly runtimeMode: RuntimeMode;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly notes: ReadonlyArray<string>;
}

export class SshRemoteDispatch extends Context.Service<
  SshRemoteDispatch,
  {
    readonly listHosts: (input: {
      readonly probe: boolean;
    }) => Effect.Effect<ReadonlyArray<SshDispatchHost>, SshRemoteDispatchError>;
    readonly browse: (input: {
      readonly host: string;
      readonly path?: string | undefined;
      readonly showHidden?: boolean | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<SshBrowseResult, SshRemoteDispatchError>;
    /** `beforeLaunch` re-checks the caller right before the remote thread starts. */
    readonly launchThread: <E, R>(
      input: SshLaunchInput,
      beforeLaunch: Effect.Effect<void, E, R>,
    ) => Effect.Effect<SshLaunchResult, SshRemoteDispatchError | E, R>;
  }
>()("t3/sshRemote/SshRemoteDispatch") {}

type RuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

const SESSION_TTL = "12h";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_REFRESH_MARGIN_MS = 10 * 60 * 1000;
const BROWSE_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_BROWSE_LIMIT = 200;
const MAX_BROWSE_LIMIT = 1000;
const MAX_PROJECT_PAGES = 20;

/** An alias the SSH config or known_hosts names, with nothing ssh could read as an option. */
const SAFE_HOST_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.@:%+\-[\]]*$/u;

const failure = (reason: SshRemoteDispatchError["reason"], message: string) =>
  new SshRemoteDispatchError({ reason, message });

const describe = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { readonly message: unknown }).message).trim();
    if (message.length > 0) return message;
  }
  return String(error);
};

/**
 * Agents cannot answer an SSH password prompt. Saying the prompt is available
 * makes the manager run ssh with BatchMode=yes, and failing the prompt turns a
 * password-only host into a clear error instead of a hung command.
 */
const keyOnlyPasswordPrompt = SshAuth.SshPasswordPrompt.of({
  isAvailable: true,
  request: (request) =>
    Effect.fail(
      new SshPasswordPromptError({
        message: `${request.destination} asked for a password. T3 agents connect only with SSH keys or a running ssh-agent; set up key authentication for this host first.`,
      }),
    ),
});

const normalizeRemotePath = (value: string) =>
  value.length > 1 ? value.replace(/\/+$/u, "") : value;

interface RemoteProject {
  readonly id: string;
  readonly workspaceRoot: string;
}

/** Finds the project registered at the browsed folder, by either form of its path. */
export function matchRemoteProject(
  projects: ReadonlyArray<RemoteProject>,
  folder: { readonly path: string; readonly realPath: string; readonly os: string | null },
): RemoteProject | undefined {
  const candidates = new Set([
    normalizeRemotePath(folder.path),
    normalizeRemotePath(folder.realPath),
  ]);
  const exact = projects.find((project) =>
    candidates.has(normalizeRemotePath(project.workspaceRoot)),
  );
  if (exact !== undefined || folder.os !== "Darwin") return exact;
  // macOS volumes are usually case-insensitive, so a project can be saved with other casing.
  const folded = new Set([...candidates].map((candidate) => candidate.toLowerCase()));
  return projects.find((project) =>
    folded.has(normalizeRemotePath(project.workspaceRoot).toLowerCase()),
  );
}

interface CallToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
}

/** Reads a remote `tools/call` result: its structured payload, or the refusal it returned. */
export function readRemoteToolResult(
  tool: string,
  raw: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  const result = (typeof raw === "object" && raw !== null ? raw : {}) as CallToolResult;
  const text = result.content?.find((item) => item.type === "text")?.text;
  let payload: unknown = result.structuredContent;
  if (payload === undefined && text !== undefined) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (result.isError === true) {
    const message =
      typeof payload === "object" && payload !== null && "message" in payload
        ? String((payload as { readonly message: unknown }).message)
        : (text ?? "no details");
    return { ok: false, message: `The remote ${tool} refused: ${message}` };
  }
  return { ok: true, value: payload };
}

const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const runtime = yield* Effect.context<RuntimeServices>();
  const sessions = new Map<
    string,
    { readonly token: string; readonly expiresAt: number; readonly ceilingApplied: boolean }
  >();

  const withRuntime = <A, E>(
    effect: Effect.Effect<A, E, RuntimeServices | SshAuth.SshPasswordPrompt>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(SshAuth.SshPasswordPrompt, keyOnlyPasswordPrompt),
      Effect.provide(runtime),
    );

  const knownHosts = withRuntime(discoverSshHosts({})).pipe(
    Effect.mapError((error) => failure("ssh_failed", describe(error))),
  );

  const resolveHost = Effect.fn("SshRemoteDispatch.resolveHost")(function* (host: string) {
    const alias = host.trim();
    if (!SAFE_HOST_ALIAS.test(alias)) {
      return yield* failure("invalid_request", `"${host}" is not a usable SSH host alias.`);
    }
    const hosts = yield* knownHosts;
    if (!hosts.some((entry) => entry.alias === alias)) {
      return yield* failure(
        "host_unknown",
        `${alias} is not in this machine's SSH config or known_hosts. Call t3_ssh_host_list for the hosts it can reach.`,
      );
    }
    return {
      alias,
      hostname: alias,
      username: null,
      port: null,
    } satisfies DesktopSshEnvironmentTarget;
  });

  const sshFailed = (alias: string) =>
    Effect.mapError((error: unknown) =>
      error instanceof SshRemoteDispatchError
        ? error
        : failure("ssh_failed", `SSH to ${alias} failed: ${describe(error)}`),
    );

  const browseTarget = Effect.fn("SshRemoteDispatch.browseTarget")(function* (
    target: DesktopSshEnvironmentTarget,
    input: {
      readonly path?: string | undefined;
      readonly showHidden?: boolean | undefined;
      readonly limit?: number | undefined;
    },
  ) {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_BROWSE_LIMIT, 0), MAX_BROWSE_LIMIT);
    const result = yield* withRuntime(
      manager.runRemoteScript(target, {
        script: buildRemoteBrowseScript({
          path: input.path ?? null,
          showHidden: input.showHidden === true,
          maxEntries: limit,
        }),
        timeoutMs: BROWSE_TIMEOUT_MS,
      }),
    ).pipe(sshFailed(target.alias));
    const parsed = parseRemoteBrowseOutput(result.stdout);
    if (parsed === null) {
      return yield* failure(
        "ssh_failed",
        `${target.alias} returned output the folder browser could not read. Its login shell may print text for non-interactive sessions.`,
      );
    }
    if (parsed._tag === "NotADirectory") {
      return yield* failure(
        "invalid_request",
        `${parsed.path || "(empty path)"} is not a directory on ${target.alias}.`,
      );
    }
    return {
      host: target.alias,
      os: parsed.os,
      home: parsed.home,
      path: parsed.path,
      realPath: parsed.realPath,
      gitRoot: parsed.gitRoot,
      branch: parsed.branch,
      worktrees: parsed.worktrees,
      entries: parsed.entries,
      truncated: parsed.truncated,
    } satisfies SshBrowseResult;
  });

  const sessionFor = Effect.fn("SshRemoteDispatch.sessionFor")(function* (
    target: DesktopSshEnvironmentTarget,
    ceiling: RuntimeMode,
  ) {
    const key = `${target.alias}\u0000${ceiling}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = sessions.get(key);
    if (cached !== undefined && cached.expiresAt - SESSION_REFRESH_MARGIN_MS > now) return cached;
    const issued = yield* withRuntime(
      manager.issueMcpClientSession(target, {
        label: `T3 SSH dispatch (${ceiling})`,
        ttl: SESSION_TTL,
        runtimeModeCeiling: ceiling,
      }),
    ).pipe(sshFailed(target.alias));
    const parsedExpiry = issued.expiresAt === null ? Number.NaN : Date.parse(issued.expiresAt);
    const session = {
      token: issued.token,
      expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now + SESSION_TTL_MS,
      ceilingApplied: issued.runtimeModeCeilingApplied,
    };
    sessions.set(key, session);
    return session;
  });

  /**
   * Calls one remote tool with an already issued session. It never issues one
   * itself: issuance happens only right after the caller was re-checked.
   */
  const callRemote = Effect.fn("SshRemoteDispatch.callRemote")(function* (input: {
    readonly target: DesktopSshEnvironmentTarget;
    readonly httpBaseUrl: string;
    readonly ceiling: RuntimeMode;
    readonly token: string;
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }) {
    const raw = yield* callAcpMcpTool({
      endpoint: new URL("mcp", input.httpBaseUrl).toString(),
      authorization: `Bearer ${input.token}`,
      tool: input.tool,
      arguments: input.arguments,
    }).pipe(
      Effect.mapError((error) => {
        if (describe(error).includes("HTTP 401")) {
          // Revoked or expired on the remote: forget it so the next call issues a fresh one.
          sessions.delete(`${input.target.alias}\u0000${input.ceiling}`);
          return failure(
            "remote_refused",
            `${input.target.alias} rejected this machine's T3 session; call the tool again to sign in anew.`,
          );
        }
        return failure(
          "ssh_failed",
          `Calling ${input.tool} on ${input.target.alias} failed: ${describe(error)}`,
        );
      }),
    );
    const result = readRemoteToolResult(input.tool, raw);
    if (!result.ok) return yield* failure("remote_refused", result.message);
    return result.value;
  });

  const findProject = Effect.fn("SshRemoteDispatch.findProject")(function* (
    remote: {
      readonly target: DesktopSshEnvironmentTarget;
      readonly httpBaseUrl: string;
      readonly ceiling: RuntimeMode;
      readonly token: string;
    },
    folder: SshBrowseResult,
  ) {
    let cursor: number | null = 0;
    for (let page = 0; page < MAX_PROJECT_PAGES && cursor !== null; page += 1) {
      const listed = (yield* callRemote({
        ...remote,
        tool: "t3_project_list",
        arguments: { cursor, limit: 100 },
      })) as {
        readonly projects?: ReadonlyArray<RemoteProject>;
        readonly nextCursor?: number | null;
      };
      const match = matchRemoteProject(listed.projects ?? [], folder);
      if (match !== undefined) return match;
      cursor = listed.nextCursor ?? null;
    }
    return undefined;
  });

  const listHosts = Effect.fn("SshRemoteDispatch.listHosts")(function* (input: {
    readonly probe: boolean;
  }) {
    const hosts = (yield* knownHosts).filter((entry) => SAFE_HOST_ALIAS.test(entry.alias));
    if (!input.probe) {
      return hosts.map((entry) => ({ alias: entry.alias, source: entry.source }));
    }
    return yield* Effect.forEach(
      hosts,
      (entry) =>
        withRuntime(
          manager.runRemoteScript(
            { alias: entry.alias, hostname: entry.alias, username: null, port: null },
            { script: "true\n", timeoutMs: PROBE_TIMEOUT_MS },
          ),
        ).pipe(
          Effect.match({
            onSuccess: (): SshDispatchHost => ({
              alias: entry.alias,
              source: entry.source,
              reachable: true,
            }),
            onFailure: (error): SshDispatchHost => ({
              alias: entry.alias,
              source: entry.source,
              reachable: false,
              probeError: describe(error).slice(0, 300),
            }),
          }),
        ),
      { concurrency: 8 },
    );
  });

  const browse = Effect.fn("SshRemoteDispatch.browse")(function* (input: {
    readonly host: string;
    readonly path?: string | undefined;
    readonly showHidden?: boolean | undefined;
    readonly limit?: number | undefined;
  }) {
    const target = yield* resolveHost(input.host);
    return yield* browseTarget(target, input);
  });

  const launchThread = Effect.fn("SshRemoteDispatch.launchThread")(function* <E, R>(
    input: SshLaunchInput,
    beforeLaunch: Effect.Effect<void, E, R>,
  ) {
    const target = yield* resolveHost(input.host);
    const folder = yield* browseTarget(target, { path: input.cwd, limit: 0 });
    // Re-check the caller before each remote change: SSH steps take seconds,
    // during which the caller's run can end or its modes can drop.
    yield* beforeLaunch;
    const notes: string[] = [];

    let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
    switch (input.workspace.type) {
      case "cwd":
        workspaceStrategy = { type: "root" };
        break;
      case "worktree": {
        if (folder.gitRoot === null) {
          return yield* failure(
            "invalid_request",
            `${folder.path} on ${target.alias} is not inside a Git repository, so it cannot get a worktree.`,
          );
        }
        const baseRef = input.workspace.baseRef?.trim() || folder.branch;
        if (!baseRef) {
          return yield* failure(
            "invalid_request",
            `${folder.path} on ${target.alias} has no checked-out branch; pass baseRef.`,
          );
        }
        workspaceStrategy = {
          type: "worktree",
          baseRef,
          branch: input.workspace.branch,
          startFromOrigin: input.workspace.startFromOrigin ?? false,
        };
        break;
      }
      case "existing_worktree":
        workspaceStrategy = {
          type: "existing_worktree",
          worktreePath: input.workspace.worktreePath,
          ...(input.workspace.branch ? { branch: input.workspace.branch } : {}),
        };
        break;
    }

    const bootstrap = yield* withRuntime(manager.ensureEnvironment(target)).pipe(
      sshFailed(target.alias),
    );
    // Bootstrap may have taken a while; the session carries the caller's authority.
    yield* beforeLaunch;
    const session = yield* sessionFor(target, input.callerRuntimeMode);
    const remote = {
      target,
      httpBaseUrl: bootstrap.httpBaseUrl,
      ceiling: input.callerRuntimeMode,
      token: session.token,
    };
    if (!session.ceilingApplied && input.runtimeMode !== "approval-required") {
      return yield* failure(
        "remote_refused",
        `T3 on ${target.alias} is too old to let an outside agent start ${input.runtimeMode} threads. Update T3 there, or pass runtimeMode "approval-required" and approve its actions from a client connected to ${target.alias}.`,
      );
    }

    yield* beforeLaunch;
    let project = yield* findProject(remote, folder);
    let projectCreated = false;
    if (project === undefined) {
      if (!session.ceilingApplied) {
        return yield* failure(
          "remote_refused",
          `${folder.path} is not a project on ${target.alias}, and T3 there is too old to let an outside agent register one. Add it as a project from a client connected to ${target.alias}, or update T3 there.`,
        );
      }
      yield* beforeLaunch;
      const created = (yield* callRemote({
        ...remote,
        tool: "t3_project_create",
        arguments: {
          title:
            input.projectTitle?.trim() ||
            folder.path.split("/").findLast((part) => part.length > 0) ||
            folder.path,
          workspaceRoot: folder.path,
        },
      })) as { readonly id?: string };
      if (typeof created?.id !== "string") {
        return yield* failure(
          "remote_refused",
          "The remote t3_project_create returned no project id.",
        );
      }
      project = { id: created.id, workspaceRoot: folder.path };
      projectCreated = true;
      notes.push(`Registered ${folder.path} as a new project on ${target.alias}.`);
    }

    // The caller's run may have ended, or its modes changed, while SSH ran.
    yield* beforeLaunch;
    const launched = (yield* callRemote({
      ...remote,
      tool: "t3_thread_launch",
      arguments: {
        projectId: project.id,
        title: input.title,
        workspaceStrategy,
        runtimeMode: input.runtimeMode,
        ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.message === undefined ? {} : { message: input.message }),
      },
    })) as { readonly threadId?: string };
    if (typeof launched?.threadId !== "string") {
      return yield* failure("remote_refused", "The remote t3_thread_launch returned no thread id.");
    }
    notes.push(
      `The thread lives in the T3 environment on ${target.alias}. Connect to ${target.alias} (Settings → Connections → SSH) to watch it; t3_thread_read here only sees this environment.`,
    );
    return {
      host: target.alias,
      cwd: folder.path,
      projectId: project.id,
      projectCreated,
      threadId: launched.threadId,
      workspaceStrategy,
      runtimeMode: input.runtimeMode,
      remoteServerKind: bootstrap.remoteServerKind ?? null,
      notes,
    } satisfies SshLaunchResult;
  });

  return SshRemoteDispatch.of({ listHosts, browse, launchThread });
});

const layerManager = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const archiveDirectory = yield* Config.String("T3CODE_SSH_RUNTIME_ARCHIVE_DIR").pipe(
      Config.withDefault(config.baseDir + "/runtime/archives"),
    );
    return SshTunnel.SshEnvironmentManager.layer({
      // Reuse whatever runner a desktop already left for the host, so this
      // never restarts a remote server another client is using. A host with
      // none gets this server's own release, uploaded from a local archive
      // when the build is unpublished, as the desktop does.
      resolveCliRunner: Effect.succeed({
        archiveVersion: packageJson.version,
        archiveDirectory,
        keepExistingRunner: true,
      }),
      leaveRemoteServerRunning: true,
    });
  }),
);

export const layer = Layer.effect(SshRemoteDispatch, make).pipe(
  Layer.provide(layerManager),
  Layer.provide(NetService.layer),
);
