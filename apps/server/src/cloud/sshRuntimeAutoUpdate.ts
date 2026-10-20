// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ServerSelfUpdateError } from "@goat/contracts";
import { CLI_RELEASE_BASE_URL_ENV } from "@goat/shared/cliRelease";
import { REMOTE_RUNTIME_STATE_KEY } from "@goat/ssh/command";
import {
  buildRemoteHostDownloadScript,
  buildRemoteLaunchScript,
  type PreparedRemoteRuntime,
  type RemoteGoatRunnerOptions,
} from "@goat/ssh/tunnel";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };
import { readSshReplacementRecord, SSH_REPLACEMENT_RECORD_FILE } from "../cli/sshHelper.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as RuntimeDrain from "../runtimeDrain.ts";
import { SSH_REPLACEMENT_ID_ENV } from "../serverOwnerLock.ts";
import { automaticUpdateChannel, arbitrateAutomaticTargets } from "./autoUpdatePolicy.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 30_000;

export interface SshRuntimeProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The host commands an SSH runtime runs to replace itself. `runDetached` starts its own
 * session, so the drain that stops this server cannot take the replacement down with it.
 */
export class SshRuntimeHost extends Context.Service<
  SshRuntimeHost,
  {
    readonly run: (input: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
      readonly env: NodeJS.ProcessEnv;
      readonly timeoutMs: number;
    }) => Effect.Effect<SshRuntimeProcessResult>;
    readonly runDetached: (input: {
      readonly script: string;
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv;
      readonly cwd: string;
    }) => Effect.Effect<SshRuntimeProcessResult>;
    readonly sha256: (file: string) => Effect.Effect<string | undefined>;
    readonly readText: (file: string) => Effect.Effect<string | undefined>;
  }
>()("goat/cloud/sshRuntimeAutoUpdate/SshRuntimeHost") {}

const collect = (child: NodeChildProcess.ChildProcess) =>
  new Promise<SshRuntimeProcessResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", () => resolve({ code: null, stdout: "", stderr: "" }));
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });

export const layerHost = Layer.succeed(SshRuntimeHost, {
  run: (input) =>
    Effect.promise(() => {
      const child = NodeChildProcess.spawn(input.command, [...input.args], {
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: input.timeoutMs,
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input.stdin ?? "");
      return collect(child);
    }),
  runDetached: (input) =>
    Effect.promise(async () => {
      const dir = await NodeFS.promises.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "goat-runtime-update-"),
      );
      const scriptFile = NodePath.join(dir, "launch.sh");
      const stdoutFile = NodePath.join(dir, "stdout");
      const stderrFile = NodePath.join(dir, "stderr");
      await NodeFS.promises.writeFile(scriptFile, input.script, { mode: 0o600 });
      // Files, never pipes: the drain stops this server mid-script, and a write to a closed pipe
      // would kill the script before it releases the replacement lock and drain fence.
      const stdout = NodeFS.openSync(stdoutFile, "w", 0o600);
      const stderr = NodeFS.openSync(stderrFile, "w", 0o600);
      // Never killed from here: once it drains this server, the script and the supervisor it
      // starts own the host until the replacement answers or the previous version is restored.
      const child = NodeChildProcess.spawn("/bin/sh", [scriptFile, ...input.args], {
        cwd: input.cwd,
        detached: true,
        env: input.env,
        stdio: ["ignore", stdout, stderr],
      });
      NodeFS.closeSync(stdout);
      NodeFS.closeSync(stderr);
      const code = await new Promise<number | null>((resolve) => {
        child.once("error", () => resolve(null));
        child.once("close", resolve);
      });
      const read = (file: string) => NodeFS.promises.readFile(file, "utf8").catch(() => "");
      const result = { code, stdout: await read(stdoutFile), stderr: await read(stderrFile) };
      await NodeFS.promises.rm(dir, { recursive: true, force: true });
      return result;
    }),
  sha256: (file) =>
    Effect.promise(() =>
      NodeFS.promises
        .readFile(file)
        .then((bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex"))
        .catch(() => undefined),
    ),
  readText: (file) =>
    Effect.promise(() => NodeFS.promises.readFile(file, "utf8").catch(() => undefined)),
});

export class SshRuntimeAutoUpdate extends Context.Service<
  SshRuntimeAutoUpdate,
  {
    /** This server runs in the user's default home outside the desktop app and Windows. */
    readonly supported: boolean;
    /** The shared SSH runtime's launch records name this process as their managed server. */
    readonly owned: Effect.Effect<boolean>;
    readonly isUpdating: Effect.Effect<boolean>;
    readonly failedTarget: Effect.Effect<string | undefined>;
    readonly prepare: (targetVersion: string) => Effect.Effect<void, ServerSelfUpdateError>;
    readonly activate: (
      targetVersion: string,
    ) => Effect.Effect<"requested" | "busy", ServerSelfUpdateError>;
    readonly clearPending: Effect.Effect<void>;
    /**
     * Arbitrates a client's automatic idle refresh against this runtime's own prepared target.
     * Requests that are not automatic (older clients, confirmed or manual updates, incompatible
     * replacements) always pass, exactly as before.
     */
    readonly admitDrain: (request: {
      readonly targetVersion: string;
      readonly automatic?: boolean | undefined;
    }) => Effect.Effect<boolean>;
  }
>()("goat/cloud/sshRuntimeAutoUpdate") {}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeLaunchResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String })),
);

const lastLine = (stdout: string) =>
  stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? "";

export const make = Effect.fn("server.ssh_runtime_auto_update.make")(function* (options?: {
  readonly ownVersion?: string;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const host = yield* SshRuntimeHost;
  const admission = yield* RuntimeAdmission.RuntimeAdmission;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const ownVersion = options?.ownVersion ?? packageJson.version;
  const homeDir = options?.homeDir ?? NodeOS.homedir();
  const pid = options?.pid ?? process.pid;
  const defaultHome = NodePath.join(homeDir, ".goat");
  const stateDir = NodePath.join(defaultHome, "ssh-launch", REMOTE_RUNTIME_STATE_KEY);
  const versionsDir = NodePath.join(defaultHome, "runtime", "goat", "versions");
  // Launch scripts only manage the server in the user's default home, and the Windows
  // supervisor needs a native detached spawn this POSIX path does not provide.
  const supported =
    config.mode !== "desktop" &&
    (options?.platform ?? process.platform) !== "win32" &&
    NodePath.resolve(config.baseDir) === NodePath.resolve(defaultHome);
  const inFlight = yield* Ref.make(false);
  const pending = yield* Ref.make<string | undefined>(undefined);
  const fail = (reason: string) => new ServerSelfUpdateError({ reason });
  const { [SSH_REPLACEMENT_ID_ENV]: _replacementId, ...inherited } = process.env;
  const env: NodeJS.ProcessEnv = { ...inherited, HOME: homeDir };
  const runner = (targetVersion: string): RemoteGoatRunnerOptions => ({
    archiveVersion: targetVersion,
    hostDownload: true,
    refreshOwnedRuntimeOnFirstConnection: true,
    ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),
  });

  const owned = Effect.gen(function* () {
    if (!supported) return false;
    const [pidFile, managed] = yield* Effect.all([
      host.readText(NodePath.join(stateDir, "pid")),
      host.readText(NodePath.join(stateDir, "managed")),
    ]);
    return pidFile?.trim() === String(pid) && managed?.trim() === "managed";
  });
  const failedTarget = host.readText(NodePath.join(stateDir, SSH_REPLACEMENT_RECORD_FILE)).pipe(
    Effect.map((text) => {
      const record = text === undefined ? undefined : readSshReplacementRecord(text);
      return record !== undefined && record.status !== "replaced"
        ? record.targetVersion
        : undefined;
    }),
  );
  // The executable must still be the one the verified install recorded.
  const verifiedExecutableSha256 = (targetVersion: string) =>
    Effect.gen(function* () {
      const dir = NodePath.join(versionsDir, targetVersion);
      const [complete, record, actual] = yield* Effect.all([
        host.readText(NodePath.join(dir, ".install-complete")),
        host.readText(NodePath.join(dir, ".install-record")),
        host.sha256(NodePath.join(dir, "goat")),
      ]);
      const fields = record?.trim().split(" ") ?? [];
      if (
        complete?.trim() !== targetVersion ||
        fields[0] !== targetVersion ||
        actual === undefined ||
        fields[2] !== actual
      )
        return yield* fail(`goat@${targetVersion} has no verified install record.`);
      return actual;
    });

  const prepare = (targetVersion: string) =>
    Effect.gen(function* () {
      // Verified against the release's SHA256SUMS exactly as a host download for a client is.
      const install = yield* host.run({
        command: "/bin/sh",
        args: ["-s"],
        stdin: buildRemoteHostDownloadScript(runner(targetVersion)),
        env,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      if (install.code !== 0 || lastLine(install.stdout) !== `goat v${targetVersion}`)
        return yield* fail(`Could not install goat@${targetVersion}.`);
      yield* verifiedExecutableSha256(targetVersion);
      const preflight = yield* host.run({
        command: NodePath.join(versionsDir, targetVersion, "goat"),
        args: [
          "__service-preflight",
          "--database-path",
          config.dbPath,
          "--launcher-protocol",
          String(SERVICE_LAUNCHER_PROTOCOL),
        ],
        env,
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
      });
      const result =
        preflight.code === 0
          ? decodeServicePreflightResult(Option.getOrUndefined(decodeJson(preflight.stdout.trim())))
          : undefined;
      if (result === undefined || result.version !== targetVersion)
        return yield* fail(`goat@${targetVersion} failed its preflight.`);
      if (result.status === "blocked") return yield* fail(result.reason);
      yield* Ref.set(pending, targetVersion);
    });

  const idle = Effect.gen(function* () {
    const activity = yield* projections
      .getServerActivity()
      .pipe(Effect.orElseSucceed(() => "busy" as const));
    return (yield* admission.inFlight) === 0 && activity === "idle";
  });

  const activate = (targetVersion: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(inFlight, true)) return "busy" as const;
        return yield* restore(
          Effect.gen(function* () {
            if (!(yield* owned)) return yield* fail("This server no longer owns the SSH runtime.");
            // First idle check; the launch script checks again under the host replacement lock,
            // and its drain closes admission before a third wait for idle.
            if (!(yield* idle)) return "busy" as const;
            const liveRunnerSha256 = yield* host.sha256(NodePath.join(stateDir, "run-t3.sh"));
            if (liveRunnerSha256 === undefined)
              return yield* fail("The SSH runtime's run-t3.sh is missing.");
            const installedExecutableSha256 = yield* verifiedExecutableSha256(targetVersion);
            const options = runner(targetVersion);
            const selection: PreparedRemoteRuntime = {
              runner: options,
              version: targetVersion,
              requestedVersion: targetVersion,
              source: "requested",
              requireInstalled: true,
              retainedRunnerSha256: null,
              mayUpgradeOwnedServer: true,
              refreshIfIdle: true,
              expectedLiveVersion: ownVersion,
              expectedLiveRunnerSha256: liveRunnerSha256,
              installedExecutableSha256,
            };
            const result = yield* host.runDetached({
              script: buildRemoteLaunchScript(options, selection),
              args: [REMOTE_RUNTIME_STATE_KEY],
              env,
              cwd: homeDir,
            });
            const status = Option.getOrUndefined(
              decodeLaunchResult(lastLine(result.stdout)),
            )?.status;
            if (status === "pending") return "busy" as const;
            if (result.code === 0 && status === "ready") return "requested" as const;
            return yield* fail(
              `The SSH runtime replacement for goat@${targetVersion} failed (exit ${result.code ?? "signal"}).`,
            );
          }),
        ).pipe(Effect.ensuring(Ref.set(inFlight, false)));
      }),
    );

  const admitDrain = (request: {
    readonly targetVersion: string;
    readonly automatic?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      if (request.automatic !== true || automaticUpdateChannel(ownVersion) === undefined)
        return true;
      const own = yield* Ref.get(pending);
      const chosen = arbitrateAutomaticTargets({
        ownVersion,
        failedTarget: yield* failedTarget,
        candidates: own === undefined ? [request.targetVersion] : [request.targetVersion, own],
      });
      if (chosen === request.targetVersion) return true;
      yield* Effect.logInfo("server.auto_update.request-dropped", {
        targetVersion: request.targetVersion,
        chosen,
      });
      return false;
    });

  return SshRuntimeAutoUpdate.of({
    supported,
    owned,
    isUpdating: Ref.get(inFlight),
    failedTarget,
    prepare,
    activate,
    clearPending: Ref.set(pending, undefined),
    admitDrain,
  });
});

export const layer = Layer.effect(SshRuntimeAutoUpdate, make()).pipe(Layer.provide(layerHost));

export const layerArbiter = Layer.effect(
  RuntimeDrain.RuntimeUpdateArbiter,
  Effect.map(SshRuntimeAutoUpdate, (runtime) => ({ admit: runtime.admitDrain })),
);
