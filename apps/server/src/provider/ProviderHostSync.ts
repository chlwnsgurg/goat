import {
  EnvironmentAuthorizationError,
  type AuthSessionId,
  type Handoff,
  HandoffError,
  type HandoffRespondInput,
  ProviderDriverKind,
  ProviderHostSyncError,
  type ProviderHostMatrixInput,
  ProviderHostMatrixResult,
  type ProviderHostProviderState,
  type ProviderHostRow,
  type ProviderHostSyncDriver,
  type ProviderInstanceId,
  type ProviderSyncCancelInput,
  type ProviderSyncHostState,
  type ProviderSyncInput,
  type ProviderSyncLogin,
  ProviderSyncResultJson,
  type ProviderSyncResult,
  ProviderSyncState,
  type ProviderSyncStatusInput,
  type ProviderAuthState,
  type RuntimeMode,
  type ServerProvider,
} from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@goat/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import * as SessionStore from "../auth/SessionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { clientRuntimeModeCeiling } from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { authorizeSshHost, type SshHostCaller } from "../sshRemote/SshHostAuthorization.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ProviderAuth from "./ProviderAuthService.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import {
  hostPlatform,
  installCommand,
  installMethod,
  PROVIDER_HOST_SYNC_DRIVERS,
  parseDeviceLogin,
  recipeFor,
  relayableBrowserUrl,
} from "./ProviderHostSyncRecipes.ts";

export const HOST_SYNC_PATH = "provider.host_sync";
const MATRIX_TOOL = "goat_provider_host_matrix" as const;
const SYNC_TOOL = "goat_provider_sync";
const STATUS_TOOL = "goat_provider_sync_status";
const CANCEL_TOOL = "goat_provider_sync_cancel";
const MATRIX_DEADLINE_MS = 20_000;
const CALL_DEADLINE_MS = 60_000;
const INSTALL_DEADLINE = Duration.minutes(10);
const LOGIN_DEADLINE = Duration.minutes(15);
const REMOTE_POLL = Duration.seconds(3);
const REMOTE_DEADLINE_MS = 30 * 60_000;
const SYNC_RETENTION_MS = 2 * 60 * 60_000;
const OUTPUT_LIMIT = 16_384;

const decodeMatrix = Schema.decodeUnknownEffect(ProviderHostMatrixResult);
const decodeSyncResult = Schema.decodeUnknownEffect(ProviderSyncResultJson);
const decodeSyncState = Schema.decodeUnknownEffect(ProviderSyncState);
const isSyncDriver = (driver: string): driver is ProviderHostSyncDriver =>
  (PROVIDER_HOST_SYNC_DRIVERS as ReadonlyArray<string>).includes(driver);

type Failure = ProviderHostSyncError | EnvironmentAuthorizationError;
const fail = (code: ProviderHostSyncError["code"], detail: string) =>
  new ProviderHostSyncError({ code, detail });

/** How a remote call failed, in the words a person acts on. */
type RemoteFailure = {
  readonly status: "update_runtime" | "not_ready" | "unreachable" | "refused";
  readonly message: string;
};
const classify = (error: Dispatch.SshRemoteDispatchError | Failure): RemoteFailure => {
  const message = error.message;
  if (error._tag !== "SshRemoteDispatchError") return { status: "refused", message };
  if (error.reason === "remote_refused" && message.includes(" does not have "))
    return { status: "update_runtime", message };
  if (error.reason === "host_unavailable" && message.includes("goat_ssh_host_prepare"))
    return { status: "not_ready", message };
  if (error.reason === "remote_refused" || error.reason === "caller_changed")
    return { status: "refused", message };
  return { status: "unreachable", message };
};

/** Safe summary of a failed installer; the raw output never leaves this process. */
export function describeInstallFailure(exitCode: number | null, output: string): string {
  if (exitCode === null) return "The installer did not finish within 10 minutes.";
  if (/EACCES|permission denied/iu.test(output))
    return "The installer could not write its install folder for this user. Fix npm's global prefix or install it once by hand.";
  if (/ETARGET|notarget|No matching version/iu.test(output))
    return "That version is not published. Pick another version or latest.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|Could not resolve host/iu.test(output))
    return "The installer could not reach the network from this machine.";
  return `The installer exited with code ${exitCode}.`;
}

type StatePatch = Partial<Omit<ProviderSyncHostState, "login" | "message">> & {
  readonly message?: string;
  readonly login?: ProviderSyncLogin | undefined;
};
interface HostTask {
  state: ProviderSyncHostState;
  finished: boolean;
  remoteSyncId?: string;
}
interface SyncOperation {
  readonly syncId: string;
  readonly driver: ProviderHostSyncDriver;
  readonly version: string | null;
  readonly login: boolean;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly hosts: Array<HostTask>;
  fibers: Array<Fiber.Fiber<unknown, unknown>>;
}
interface PendingApproval {
  readonly input: ProviderSyncInput;
  readonly expiresAtMs: number;
}

export class ProviderHostSync extends Context.Service<
  ProviderHostSync,
  {
    readonly matrix: (
      input: ProviderHostMatrixInput,
      caller: SshHostCaller,
    ) => Effect.Effect<ProviderHostMatrixResult, Failure>;
    readonly sync: (
      input: ProviderSyncInput,
      caller: SshHostCaller,
    ) => Effect.Effect<ProviderSyncResult, Failure>;
    readonly status: (
      input: ProviderSyncStatusInput,
      caller: SshHostCaller,
    ) => Effect.Effect<ProviderSyncState, Failure>;
    readonly cancel: (
      input: ProviderSyncCancelInput,
      caller: SshHostCaller,
    ) => Effect.Effect<ProviderSyncState, Failure>;
    /** Approving the handoff starts the sync under the approver's own session. */
    readonly respondHandoff: (
      input: HandoffRespondInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<Handoff, HandoffError | EnvironmentAuthorizationError>;
    /** Waits until every host of a sync has finished, without polling. */
    readonly awaitDone: (syncId: string) => Effect.Effect<ProviderSyncState, ProviderHostSyncError>;
  }
>()("goat/provider/ProviderHostSync") {}

export const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const auth = yield* ProviderAuth.ProviderAuthService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const handoffs = yield* Handoffs.Handoffs;
  const threads = yield* Threads.ThreadManagementService;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const crypto = yield* Crypto.Crypto;
  const hostname = yield* HostProcess.Hostname;
  const platform = hostPlatform(process.platform);
  const operations = new Map<string, SyncOperation>();
  const approvals = new Map<string, PendingApproval>();

  // ---- authority -------------------------------------------------------

  const readCeiling = (caller: SshHostCaller) =>
    authorizeSshHost(sessions, caller, "orchestration:read").pipe(
      Effect.as("approval-required" as RuntimeMode),
    );

  /**
   * Installing software on a machine is a full-access act. A person needs a
   * live providers:manage grant; an outside MCP client needs that grant or a
   * full-access ceiling, which is what another machine's approved sync sends.
   * Thread agents never pass: they get an approval handoff instead.
   */
  const writeCeiling = (caller: SshHostCaller): Effect.Effect<RuntimeMode, Failure> => {
    if (caller.kind === "client")
      return authorizeSshHost(sessions, caller, "providers:manage").pipe(
        Effect.as("full-access" as RuntimeMode),
      );
    const { scope: mcp } = caller;
    if (mcp.thread !== undefined || mcp.client === undefined)
      return Effect.fail(
        new EnvironmentAuthorizationError({
          requiredScope: "providers:manage",
          message: "Installing a provider needs a person's approval.",
        }),
      );
    const ceiling = clientRuntimeModeCeiling(mcp.client);
    const grant = mcp.grantedScopes?.includes("providers:manage")
      ? ("providers:manage" as const)
      : ("orchestration:operate" as const);
    if (grant === "orchestration:operate" && ceiling !== "full-access")
      return Effect.fail(
        new EnvironmentAuthorizationError({
          requiredScope: "providers:manage",
          message: "Installing a provider needs providers:manage or a full-access client.",
        }),
      );
    return authorizeSshHost(sessions, caller, grant).pipe(Effect.as("full-access" as RuntimeMode));
  };

  const ownerSession = (caller: SshHostCaller): string =>
    caller.kind === "client" ? caller.sessionId : (caller.scope.client?.sessionId ?? "mcp");

  // ---- this machine ----------------------------------------------------

  const snapshotFor = (all: ReadonlyArray<ServerProvider>, driver: ProviderHostSyncDriver) => {
    const own = all.filter(
      (provider) => provider.driver === driver && provider.executionLocation !== "cloud",
    );
    return own.find((provider) => provider.instanceId === driver) ?? own[0];
  };

  const localProviders = Effect.gen(function* () {
    const all = yield* providers.getProviders;
    return yield* Effect.forEach(PROVIDER_HOST_SYNC_DRIVERS, (driver) =>
      Effect.gen(function* () {
        const recipe = recipeFor(driver);
        const snapshot = snapshotFor(all, driver);
        const onPath =
          snapshot?.installed === true
            ? true
            : (yield* resolveCommandPath(recipe.binary).pipe(Effect.orElseSucceed(() => null))) !==
              null;
        const authStatus = snapshot?.auth.status;
        return {
          driver: ProviderDriverKind.make(driver),
          displayName: snapshot?.displayName ?? recipe.displayName,
          installed: onPath,
          version: snapshot?.installed ? snapshot.version : null,
          auth:
            authStatus === "authenticated"
              ? "signed_in"
              : authStatus === "unauthenticated"
                ? "signed_out"
                : "unknown",
          installMethod: installMethod(driver, platform),
          loginMethod:
            snapshot?.setup?.canAuthenticate === true
              ? "goat"
              : recipe.deviceLogin !== undefined
                ? "device_code"
                : "terminal",
        } satisfies ProviderHostProviderState;
      }),
    );
  });

  const localRow = Effect.gen(function* () {
    return {
      host: null,
      status: "ok",
      platform: process.platform,
      arch: process.arch,
      goatVersion: packageJson.version,
      providers: yield* localProviders,
    } satisfies ProviderHostRow;
  });

  // ---- remote calls ----------------------------------------------------

  const callRemote = (
    caller: SshHostCaller,
    call: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly writes: boolean;
      readonly timeoutMs: number;
    },
  ) =>
    dispatch
      .callHostTool(
        { ...call, approvals: false, requireReady: true },
        call.writes ? writeCeiling(caller) : readCeiling(caller),
      )
      .pipe(Effect.mapError(classify));

  const remoteRow = (caller: SshHostCaller, host: string) =>
    callRemote(caller, {
      host,
      tool: MATRIX_TOOL,
      arguments: { localOnly: true },
      writes: false,
      timeoutMs: MATRIX_DEADLINE_MS,
    }).pipe(
      Effect.flatMap((raw) =>
        decodeMatrix(raw).pipe(
          Effect.mapError((): RemoteFailure => ({
            status: "update_runtime",
            message: `Update GOAT on ${host}: it returned an unreadable provider list.`,
          })),
        ),
      ),
      Effect.map((result): ProviderHostRow => {
        const row = result.rows[0];
        if (row === undefined) return { host, status: "unreachable", providers: [] };
        const mismatch = row.goatVersion !== packageJson.version;
        return {
          ...row,
          host,
          ...(mismatch
            ? {
                versionMismatch: true,
                message: `${host} runs ${row.goatVersion ? `GOAT ${row.goatVersion}` : "an older GOAT"}; this machine runs GOAT ${packageJson.version}. Update GOAT on the older machine.`,
              }
            : {}),
        };
      }),
      Effect.catch((failure: RemoteFailure) =>
        Effect.succeed<ProviderHostRow>({
          host,
          status: failure.status === "refused" ? "unreachable" : failure.status,
          message: failure.message,
          providers: [],
        }),
      ),
    );

  const matrix = Effect.fn("ProviderHostSync.matrix")(function* (
    input: ProviderHostMatrixInput,
    caller: SshHostCaller,
  ) {
    yield* readCeiling(caller);
    const local = yield* localRow;
    if (input.localOnly === true) return { rows: [local] };
    const hosts = input.hosts ?? (yield* dispatch.connectedHosts);
    const rows = yield* Effect.forEach([...new Set(hosts)], (host) => remoteRow(caller, host), {
      concurrency: 6,
    });
    return { rows: [local, ...rows] };
  });

  // ---- operations ------------------------------------------------------

  const view = (operation: SyncOperation): ProviderSyncState => ({
    syncId: operation.syncId,
    driver: operation.driver,
    version: operation.version,
    login: operation.login,
    startedAt: operation.startedAt,
    done: operation.hosts.every((task) => task.finished),
    hosts: operation.hosts.map((task) => task.state),
  });

  const update = (task: HostTask, next: StatePatch, finished = false) =>
    Effect.sync(() => {
      const { login, message, ...rest } = next;
      const base = { ...task.state, ...rest };
      const withMessage =
        message === undefined ? (({ message: _m, ...state }) => state)(base) : { ...base, message };
      task.state =
        "login" in next
          ? login === undefined
            ? (({ login: _l, ...state }) => state)(withMessage)
            : { ...withMessage, login }
          : withMessage;
      if (finished) task.finished = true;
    });

  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cutoff = now - SYNC_RETENTION_MS;
    for (const [id, operation] of operations)
      if (operation.startedAtMs < cutoff) operations.delete(id);
    for (const [id, approval] of approvals) if (approval.expiresAtMs < now) approvals.delete(id);
  });

  const newOperation = (
    driver: ProviderHostSyncDriver,
    version: string | null,
    login: boolean,
    hosts: ReadonlyArray<string | null>,
  ) =>
    Effect.gen(function* () {
      yield* prune;
      const now = yield* DateTime.now;
      const operation: SyncOperation = {
        syncId: `sync_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
        driver,
        version,
        login,
        startedAt: DateTime.formatIso(now),
        startedAtMs: DateTime.toEpochMillis(now),
        hosts: hosts.map((host) => ({
          state: { host, phase: "queued", version: null },
          finished: false,
        })),
        fibers: [],
      };
      operations.set(operation.syncId, operation);
      return operation;
    });

  const fork = (
    operation: SyncOperation,
    effect: Effect.Effect<unknown, never, FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkIn(effect.pipe(Effect.provideContext(context)), scope);
      operation.fibers.push(fiber);
    });

  /** Runs a fixed installer argv. Output is kept only to classify a failure. */
  const runInstaller = (command: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(command, args);
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          shell: resolved.shell,
          env: { CI: "1", npm_config_yes: "true" },
          extendEnv: true,
          stdin: "ignore",
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      let tail = "";
      const decoder = new TextDecoder();
      const keep = (chunk: Uint8Array) =>
        Effect.sync(() => {
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-OUTPUT_LIMIT);
        });
      const [, , exitCode] = yield* Effect.all(
        [
          Stream.runForEach(child.stdout, keep),
          Stream.runForEach(child.stderr, keep),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), output: tail };
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(INSTALL_DEADLINE),
      Effect.map((result) =>
        Option.getOrElse(result, () => ({ exitCode: null as number | null, output: "" })),
      ),
    );

  const instanceFor = (driver: ProviderHostSyncDriver) =>
    Effect.gen(function* () {
      const all = yield* instances.listInstances;
      const own = all.filter((instance) => instance.driverKind === driver);
      return own.find((instance) => instance.instanceId === driver) ?? own[0];
    });

  const refreshDriver = (driver: ProviderHostSyncDriver) =>
    Effect.gen(function* () {
      const all = yield* instances.listInstances;
      yield* Effect.forEach(
        all.filter((instance) => instance.driverKind === driver),
        (instance) => providers.refreshInstance(instance.instanceId).pipe(Effect.ignore),
        { discard: true },
      );
      return snapshotFor(yield* providers.getProviders, driver);
    });

  const goatLogin = (
    task: HostTask,
    driver: ProviderHostSyncDriver,
    instanceId: ProviderInstanceId,
    owner: string,
  ) =>
    Effect.gen(function* () {
      const name = recipeFor(driver).displayName;
      const openHost = {
        type: "open_host",
        instruction: `Finish ${name} sign-in in GOAT on ${hostname}: Settings, Providers, ${name}.`,
      } satisfies ProviderSyncLogin;
      const loginFrom = (state: ProviderAuthState): ProviderSyncLogin => {
        const interaction = state.interaction;
        if (interaction?.type === "deviceCode")
          return { type: "device_code", url: interaction.url, userCode: interaction.userCode };
        if (interaction?.type === "browser") {
          const url = relayableBrowserUrl(interaction.url, interaction.acceptsCallback);
          if (url !== null && !interaction.requiresConsent) return { type: "browser", url };
        }
        return openHost;
      };
      const started = yield* auth.start({ instanceId }, owner);
      yield* update(task, { phase: "signing_in", login: loginFrom(started) });
      yield* auth.subscribe({ instanceId }, owner).pipe(
        Stream.takeUntil((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
        Stream.runForEach((state) =>
          state.phase === "succeeded"
            ? update(task, { phase: "signed_in", login: undefined }, true)
            : state.phase === "failed" || state.phase === "cancelled"
              ? update(
                  task,
                  {
                    phase: state.phase === "failed" ? "failed" : "cancelled",
                    login: undefined,
                    message:
                      "Sign-in did not finish. Start it again from this host's provider settings.",
                  },
                  true,
                )
              : update(task, { login: loginFrom(state) }),
        ),
        Effect.timeoutOption(LOGIN_DEADLINE),
      );
    });

  /** The CLI's own device login; only the parsed page and code leave this process. */
  const deviceLogin = (
    task: HostTask,
    driver: ProviderHostSyncDriver,
    instanceId: ProviderInstanceId | undefined,
  ) =>
    Effect.gen(function* () {
      const recipe = recipeFor(driver);
      const device = recipe.deviceLogin!;
      const entries = deriveProviderInstanceConfigMap(yield* settings.getSettings);
      const env = yield* mergeProviderInstanceEnvironment(
        instanceId === undefined ? undefined : entries[instanceId]?.environment,
      );
      const resolved = yield* resolveSpawnCommand(recipe.binary, device.args, { env });
      yield* update(task, { phase: "signing_in" });
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          shell: resolved.shell,
          env,
          stdin: "ignore",
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      let seen = "";
      let relayed = false;
      const decoder = new TextDecoder();
      const read = (chunk: Uint8Array) =>
        Effect.gen(function* () {
          if (relayed) return;
          seen = (seen + decoder.decode(chunk, { stream: true })).slice(-OUTPUT_LIMIT);
          const login = parseDeviceLogin(driver, seen);
          if (login === null) return;
          relayed = true;
          seen = "";
          yield* update(task, { login });
        });
      const [, , exitCode] = yield* Effect.all(
        [
          Stream.runForEach(child.stdout, read),
          Stream.runForEach(child.stderr, read),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0)
        return yield* update(
          task,
          {
            phase: "failed",
            login: { type: "terminal", command: recipe.terminalLogin },
            message: "Sign-in did not finish. Run the sign-in command on that machine.",
          },
          true,
        );
      yield* refreshDriver(driver);
      yield* update(task, { phase: "signed_in", login: undefined }, true);
    }).pipe(Effect.scoped, Effect.timeoutOption(LOGIN_DEADLINE));

  const runLocal = (operation: SyncOperation, task: HostTask, owner: string) =>
    Effect.gen(function* () {
      const driver = operation.driver;
      const recipe = recipeFor(driver);
      const before = (yield* localProviders).find((provider) => provider.driver === driver);
      const sameVersion =
        before?.installed === true &&
        (operation.version === null || before.version === null
          ? operation.version === null
          : before.version.includes(operation.version));
      if (!sameVersion) {
        const command = installCommand(driver, platform, operation.version);
        if (command === null)
          return yield* update(
            task,
            {
              phase: "failed",
              message: `GOAT cannot install ${recipe.displayName} on ${process.platform}. Install it with the vendor's instructions.`,
            },
            true,
          );
        const tool = yield* resolveCommandPath(command.command).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (tool === null)
          return yield* update(
            task,
            {
              phase: "failed",
              message:
                command.method === "npm"
                  ? `Install Node.js and npm on this machine first; ${recipe.displayName} installs with npm.`
                  : `${command.command} is missing on this machine; the ${recipe.displayName} installer needs it.`,
            },
            true,
          );
        yield* update(task, {
          phase: "installing",
          ...(command.latestOnly && operation.version !== null
            ? { message: `${recipe.displayName}'s installer always installs the latest release.` }
            : {}),
        });
        const result = yield* runInstaller(command.command, command.args);
        if (result.exitCode !== 0)
          return yield* update(
            task,
            { phase: "failed", message: describeInstallFailure(result.exitCode, result.output) },
            true,
          );
      }
      const snapshot = yield* refreshDriver(driver);
      const after = (yield* localProviders).find((provider) => provider.driver === driver);
      if (after?.installed !== true)
        return yield* update(
          task,
          {
            phase: "failed",
            message: `The installer finished, but GOAT cannot find ${recipe.binary} on its PATH here. Add the install folder to PATH and restart GOAT.`,
          },
          true,
        );
      yield* update(task, {
        phase: "installed",
        version: after.version,
        ...(sameVersion ? { message: "Already installed." } : {}),
      });
      if (!operation.login || after.auth === "signed_in")
        return yield* update(task, after.auth === "signed_in" ? { phase: "signed_in" } : {}, true);
      const instance = yield* instanceFor(driver);
      if (snapshot?.setup?.canAuthenticate === true && instance !== undefined)
        return yield* goatLogin(task, driver, instance.instanceId, owner);
      if (recipe.deviceLogin !== undefined)
        return yield* deviceLogin(task, driver, instance?.instanceId);
      yield* update(task, { login: { type: "terminal", command: recipe.terminalLogin } }, true);
    }).pipe(
      Effect.catchCause(() =>
        task.finished
          ? Effect.void
          : update(
              task,
              {
                phase: "failed",
                message: "Setup stopped unexpectedly. Check the provider in Settings.",
              },
              true,
            ),
      ),
      Effect.ensuring(Effect.suspend(() => (task.finished ? Effect.void : update(task, {}, true)))),
    );

  const runRemote = (
    operation: SyncOperation,
    task: HostTask,
    host: string,
    caller: SshHostCaller,
  ) =>
    Effect.gen(function* () {
      yield* update(task, { phase: "installing" });
      const started = yield* callRemote(caller, {
        host,
        tool: SYNC_TOOL,
        arguments: {
          driver: operation.driver,
          version: operation.version ?? "latest",
          login: operation.login,
        },
        writes: true,
        timeoutMs: CALL_DEADLINE_MS,
      }).pipe(
        Effect.flatMap((raw) => decodeSyncResult(raw).pipe(Effect.mapError(unreadable(host)))),
      );
      if (started.kind !== "started")
        return yield* update(
          task,
          {
            phase: "failed",
            message: `GOAT on ${host} asked for a person's approval there instead.`,
          },
          true,
        );
      task.remoteSyncId = started.sync.syncId;
      let current = started.sync;
      const deadline = (yield* Clock.currentTimeMillis) + REMOTE_DEADLINE_MS;
      while (true) {
        const remote = current.hosts[0];
        if (remote !== undefined) yield* update(task, { ...remote, host });
        if (current.done) return yield* update(task, {}, true);
        if ((yield* Clock.currentTimeMillis) > deadline)
          return yield* update(
            task,
            { phase: "failed", message: `${host} did not finish within 30 minutes.` },
            true,
          );
        yield* Effect.sleep(REMOTE_POLL);
        current = yield* callRemote(caller, {
          host,
          tool: STATUS_TOOL,
          arguments: { syncId: started.sync.syncId },
          writes: false,
          timeoutMs: MATRIX_DEADLINE_MS,
        }).pipe(
          Effect.flatMap((raw) => decodeSyncState(raw).pipe(Effect.mapError(unreadable(host)))),
        );
      }
    }).pipe(
      Effect.catch((failure: RemoteFailure) =>
        update(
          task,
          {
            phase: failure.status === "update_runtime" ? "update_runtime" : "failed",
            message:
              failure.status === "update_runtime"
                ? `Update GOAT on ${host} to sync providers there. ${failure.message}`
                : failure.message,
          },
          true,
        ),
      ),
      Effect.catchCause(() =>
        task.finished
          ? Effect.void
          : update(task, { phase: "failed", message: `Lost track of ${host}.` }, true),
      ),
    );

  const unreadable = (host: string) => (): RemoteFailure => ({
    status: "update_runtime",
    message: `GOAT on ${host} returned an unreadable sync state.`,
  });

  const start = (input: ProviderSyncInput, caller: SshHostCaller) =>
    Effect.gen(function* () {
      const login = input.login ?? true;
      const localVersion = (yield* localProviders).find(
        (provider) => provider.driver === input.driver,
      )?.version;
      const requested = input.version ?? (localVersion ? versionCore(localVersion) : "latest");
      const version = requested === "latest" || requested === null ? null : requested;
      const hosts = input.hosts === undefined ? [null] : [...new Set(input.hosts)];
      const operation = yield* newOperation(input.driver, version, login, hosts);
      const owner = ownerSession(caller);
      yield* Effect.forEach(
        operation.hosts,
        (task) =>
          fork(
            operation,
            task.state.host === null
              ? runLocal(operation, task, owner)
              : runRemote(operation, task, task.state.host, caller),
          ),
        { discard: true },
      );
      return { kind: "started" as const, sync: view(operation) };
    });

  // ---- approvals -------------------------------------------------------

  const requestApproval = (
    input: ProviderSyncInput,
    caller: Extract<SshHostCaller, { kind: "mcp" }>,
  ) =>
    Effect.gen(function* () {
      const thread = caller.scope.thread;
      if (thread === undefined || caller.scope.readOnly)
        return yield* new EnvironmentAuthorizationError({
          requiredScope: "providers:manage",
          message: "Installing a provider needs providers:manage.",
        });
      const environmentId = yield* environment.getEnvironmentId;
      if (caller.scope.environmentId !== environmentId)
        return yield* fail("invalid_request", "Ask again in a thread on this environment.");
      yield* authorizeSshHost(sessions, caller, "orchestration:operate");
      const run = (yield* threads
        .getThreadSnapshot(thread.threadId)
        .pipe(
          Effect.mapError(() => fail("unavailable", "Could not read the requesting thread.")),
        )).projection.runs.at(-1);
      if (!run || run.rootNodeId === null)
        return yield* fail("invalid_request", "Ask again while this thread is running.");
      const name = recipeFor(input.driver).displayName;
      const where = input.hosts?.join(", ") ?? hostname;
      const handoff = yield* handoffs
        .create({
          kind: "approval",
          title: `Install ${name} on ${where}?`,
          reason: `An agent asked to install ${name}${input.version && input.version !== "latest" ? ` ${input.version}` : ""} with its official installer${input.login === false ? "" : " and start its sign-in"}.`,
          requestedBy: {
            threadId: thread.threadId,
            providerInstanceId: thread.providerInstanceId,
            path: HOST_SYNC_PATH,
          },
          target: { environmentId, path: HOST_SYNC_PATH },
          runId: run.id,
          nodeId: run.rootNodeId,
          human: {
            location: `Each machine runs ${name}'s own installer and sign-in. Sign in with your own account; GOAT never copies credentials between machines.`,
          },
          args: { driver: input.driver, hosts: input.hosts ?? [] },
          expiresAt: DateTime.add(yield* DateTime.now, { minutes: 15 }),
        })
        .pipe(Effect.mapError(() => fail("unavailable", "Could not ask for approval. Try again.")));
      approvals.set(handoff.handoffId, {
        input,
        expiresAtMs: (yield* Clock.currentTimeMillis) + 15 * 60_000,
      });
      return {
        kind: "needs_human" as const,
        handoff,
        next: { after: "approval" as const, call: MATRIX_TOOL },
      };
    });

  const sync = Effect.fn("ProviderHostSync.sync")(function* (
    input: ProviderSyncInput,
    caller: SshHostCaller,
  ) {
    if (caller.kind === "mcp" && caller.scope.thread !== undefined)
      return yield* requestApproval(input, caller);
    yield* writeCeiling(caller);
    return yield* start(input, caller);
  });

  const find = (syncId: string) =>
    Effect.suspend(() => {
      const operation = operations.get(syncId);
      return operation === undefined
        ? Effect.fail(
            fail("not_found", "No such sync. It may have finished more than two hours ago."),
          )
        : Effect.succeed(operation);
    });

  const status = Effect.fn("ProviderHostSync.status")(function* (
    input: ProviderSyncStatusInput,
    caller: SshHostCaller,
  ) {
    yield* readCeiling(caller);
    return view(yield* find(input.syncId));
  });

  const cancel = Effect.fn("ProviderHostSync.cancel")(function* (
    input: ProviderSyncCancelInput,
    caller: SshHostCaller,
  ) {
    // Stopping is always safe, so an agent may stop what it started.
    yield* authorizeSshHost(sessions, caller, "orchestration:operate");
    const operation = yield* find(input.syncId);
    yield* Effect.forEach(operation.fibers, Fiber.interrupt, { discard: true });
    yield* Effect.forEach(
      operation.hosts.filter((task) => !task.finished),
      (task) =>
        Effect.gen(function* () {
          if (task.state.host !== null && task.remoteSyncId !== undefined)
            yield* callRemote(caller, {
              host: task.state.host,
              tool: CANCEL_TOOL,
              arguments: { syncId: task.remoteSyncId },
              writes: true,
              timeoutMs: MATRIX_DEADLINE_MS,
            }).pipe(Effect.ignore);
          yield* update(task, { phase: "cancelled", login: undefined }, true);
        }),
      { discard: true },
    );
    return view(operation);
  });

  const respondHandoff = Effect.fn("ProviderHostSync.respondHandoff")(function* (
    input: HandoffRespondInput,
    sessionId: AuthSessionId,
  ) {
    const pending = approvals.get(input.handoffId);
    if (
      input.action === "completed" &&
      (pending === undefined || pending.expiresAtMs < (yield* Clock.currentTimeMillis))
    )
      return yield* new HandoffError({ reason: "expired" });
    if (input.action === "completed")
      yield* authorizeSshHost(sessions, { kind: "client", sessionId }, "providers:manage");
    const handoff = yield* handoffs.respond(input, sessionId);
    if (handoff.state === "opened") return handoff;
    approvals.delete(input.handoffId);
    if (handoff.state === "completed" && pending !== undefined)
      yield* start(pending.input, { kind: "client", sessionId }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Approved provider sync did not start.", cause),
        ),
      );
    return handoff;
  });

  const provided =
    <A extends ReadonlyArray<unknown>, B, E>(
      method: (...args: A) => Effect.Effect<B, E, FileSystem.FileSystem | Path.Path>,
    ) =>
    (...args: A) =>
      method(...args).pipe(Effect.provideContext(context));
  return ProviderHostSync.of({
    matrix: provided(matrix),
    sync: provided(sync),
    status: provided(status),
    cancel: provided(cancel),
    respondHandoff: provided(respondHandoff),
    awaitDone: (syncId) =>
      find(syncId).pipe(
        Effect.tap((operation) => Fiber.awaitAll(operation.fibers)),
        Effect.map(view),
      ),
  });
});

/** `codex-cli 0.42.0` and `0.42.0 (Claude Code)` both pin to 0.42.0. */
export function versionCore(version: string): string | null {
  return (
    /\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,4})?/u.exec(
      version,
    )?.[0] ?? null
  );
}

export const layer = Layer.effect(ProviderHostSync, make);
