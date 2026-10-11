import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import {
  describeReadinessCause,
  waitForHttpReady as waitForHttpReadyShared,
} from "@t3tools/shared/httpReadiness";
import {
  CLI_RELEASE_REPOSITORY,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
} from "@t3tools/shared/cliRelease";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NetService from "@t3tools/shared/Net";
import { extractJsonObject, fromLenientJson } from "@t3tools/shared/schemaJson";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { readLocalRuntimeArchive } from "./runtimeArchive.ts";
import { downloadRuntimeArchiveWithGh } from "./runtimeArchiveGh.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  collectProcessOutput,
  getLastNonEmptyOutputLine,
  remoteStateKey,
  resolveSshCommand,
  resolveSshTarget,
  runSshCommand,
  targetConnectionKey,
} from "./command.ts";
import {
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const SSH_READY_TIMEOUT_MS = 20_000;
const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const REMOTE_READY_TIMEOUT_MS = 60_000;
const REMOTE_LAUNCH_TIMEOUT_MS = 90_000;
// A cold archive launch also downloads and unpacks a ~70 MB release archive
// and may wait on another installer's lock. The budgets nest: the checksum
// file is tiny and the archive download is bounded; a waiter outlasts both
// downloads plus extraction so it can reuse the result; and the SSH command
// outlasts an install (own or waited-for) plus readiness, with slack for
// verification and extraction, which have no timeout of their own.
const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;
const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;
const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;
const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;
const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;

export interface RemoteT3RunnerOptions {
  /**
   * Dev mode: run `node <path>` on the remote instead of a release archive.
   * The only mode that needs Node on the remote.
   */
  readonly nodeScriptPath?: string | null;
  readonly nodeEngineRange?: string | null;
  /**
   * Exact version whose self-contained release archive the remote installs
   * and runs. Required unless `nodeScriptPath` is set; the remote then needs
   * neither Node nor npm.
   */
  readonly archiveVersion?: string | null;
  readonly releaseBaseUrl?: string | null;
  /** Writable user cache; only this directory may receive gh downloads. */
  readonly archiveDirectory?: string | null;
  /** Read-only packaged archives. Never create, repair, or download into this directory. */
  readonly bundledArchiveDirectory?: string | null;
  /** Local gh executable used for authenticated acquisition; defaults to PATH lookup. */
  readonly ghCommand?: string | undefined;
  /**
   * Reuse the remote's existing `run-t3.sh` for this target instead of
   * replacing it. A second client of the same host (the server's own SSH
   * dispatch, next to a desktop that already launched the remote) must not
   * swap the runner: a changed runner restarts a managed remote server, which
   * would cut off the client that started it. Reusing it also runs remote CLI
   * commands with the binary that matches the running server.
   */
  readonly keepExistingRunner?: boolean | null;
}

export interface SshEnvironmentManagerOptions {
  readonly resolveCliRunner?: Effect.Effect<RemoteT3RunnerOptions>;
  /**
   * Close only the local forward when a tunnel ends. A second client of a
   * host (the server's own SSH dispatch) shares the remote server with the
   * client that started it, so it must never stop that server.
   */
  readonly leaveRemoteServerRunning?: boolean;
}

interface SshTunnelEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
}

type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshAuth.SshPasswordPrompt;

type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function isNodeScriptRunner(runner: RemoteT3RunnerOptions | undefined): boolean {
  return Boolean(runner?.nodeScriptPath?.trim());
}

function sshRunnerLogFields(runner: RemoteT3RunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }
  if (runner?.archiveVersion?.trim()) {
    return { runner: "archive", archiveVersion: runner.archiveVersion.trim() };
  }
  return { runner: "archive" };
}

interface SshAuthOperationInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuth.SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export interface SshEnvironmentManagerShape {
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  /**
   * Issues a short-lived `mcp-client` session on the remote environment so
   * this process can call the remote's `/mcp` like an outside agent.
   */
  readonly issueMcpClientSession: (
    target: DesktopSshEnvironmentTarget,
    options: RemoteMcpClientSessionOptions,
  ) => Effect.Effect<
    RemoteMcpClientSession,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  /** Runs a POSIX `sh` script on the remote host with this manager's SSH auth. */
  readonly runRemoteScript: (
    target: DesktopSshEnvironmentTarget,
    input: { readonly script: string; readonly timeoutMs?: number },
  ) => Effect.Effect<
    { readonly stdout: string; readonly stderr: string },
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
}

export interface RemoteMcpClientSessionOptions {
  readonly label: string;
  /** A duration the remote CLI accepts, such as `12h`. */
  readonly ttl: string;
  /** Most a thread started through this session may run with; null keeps the remote default. */
  readonly runtimeModeCeiling: string | null;
}

export interface RemoteMcpClientSession {
  readonly token: string;
  readonly expiresAt: string | null;
  /** False when the remote CLI predates `--runtime-mode-ceiling` and kept its default. */
  readonly runtimeModeCeilingApplied: boolean;
}

const RemoteLaunchResult = Schema.Struct({
  remotePort: Schema.Number,
  serverKind: Schema.optional(Schema.Literals(["external", "managed"])),
});

const RemotePairingResult = Schema.Struct({
  credential: Schema.String,
});

const RemoteMcpSessionResult = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));
const decodeRemotePairingResult = Schema.decodeEffect(fromLenientJson(RemotePairingResult));
const decodeRemoteMcpSessionResult = Schema.decodeEffect(fromLenientJson(RemoteMcpSessionResult));

const decodeRemoteJsonOutput = <A, E>(
  stdout: string,
  decode: (input: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  decode(stdout).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const jsonObject = extractJsonObject(stdout);
        if (jsonObject === stdout.trim()) {
          return yield* Effect.fail(error);
        }
        const exit = yield* Effect.exit(decode(jsonObject));
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        return yield* Effect.fail(error);
      }),
    ),
  );

const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

const decodeRemotePairingOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemotePairingResult);

const remoteNodeEngineCheckMain = function remoteNodeEngineCheckMain() {
  const range = process.argv[2] || "";
  const rawVersion =
    process.versions && process.versions.node ? process.versions.node : process.version;

  if (!satisfiesSemverRange(rawVersion, range)) {
    process.stderr.write(
      "Remote node " + rawVersion + " does not satisfy required range " + range + ".\n",
    );
    process.exit(1);
  }
};

function buildRemoteNodeEngineCheckScript(): string {
  return `${satisfiesSemverRange.toString()}
(${remoteNodeEngineCheckMain.toString()})();`;
}

function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function applyScriptPlaceholders(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(`@@${token}@@`, () => value);
  }
  return result;
}

// Re-exported from the shared HTTP readiness module so existing importers
// (notably tunnel.test.ts) keep resolving it from here.
export { describeReadinessCause };

export const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2] ?? "";
const defaultPort = Number.parseInt(process.argv[3] ?? "", 10);
const scanWindow = Number.parseInt(process.argv[4] ?? "", 10);
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : defaultPort;
const end = start + scanWindow;

function tryPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error ? false : port));
    });
  });
}

(async () => {
  for (let port = start; port < end; port += 1) {
    const available = await tryPort(port);
    if (available) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

const REMOTE_WAIT_READY_SCRIPT = `const http = require("node:http");
const port = Number.parseInt(process.argv[2] ?? "", 10);
const timeoutMs = Number.parseInt(process.argv[3] ?? "", 10);
const probeTimeoutMs = Number.parseInt(process.argv[4] ?? "", 10);
if (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {
  process.exit(1);
}
const deadline = Date.now() + timeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        timeout: probeTimeoutMs,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode >= 200 && response.statusCode < 300);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

(async () => {
  while (Date.now() < deadline) {
    if (await probe()) {
      process.exit(0);
    }
    await sleep(100);
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

const REMOTE_NODE_ENV_SCRIPT = `prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

remote_node_satisfies_engine() {
  T3_NODE_ENGINE_RANGE=@@T3_NODE_ENGINE_RANGE@@
  if [ -z "$T3_NODE_ENGINE_RANGE" ]; then
    return 0
  fi
  node - "$T3_NODE_ENGINE_RANGE" <<'NODE'
@@T3_NODE_ENGINE_CHECK_SCRIPT@@
NODE
}

ensure_remote_node_path() {
  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then
    return 0
  fi

  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/home/linuxbrew/.linuxbrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"

  if [ -z "\${VOLTA_HOME:-}" ]; then
    VOLTA_HOME="$HOME/.volta"
  fi
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ ! -x "$HOME/.asdf/shims/node" ] && [ -s "$HOME/.asdf/asdf.sh" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.asdf/asdf.sh"
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${FNM_DIR:-}" ]; then
    FNM_DIR="$HOME/.local/share/fnm"
  fi
  export FNM_DIR
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${NVM_DIR:-}" ]; then
    NVM_DIR="$HOME/.nvm"
  fi
  export NVM_DIR

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
    fi
  fi

  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      if [ -x "$T3_NODE_BIN/node" ]; then
        PATH="$T3_NODE_BIN:$PATH"
        export PATH
      fi
    done
  fi

  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine
}
`;

const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
@@T3_NODE_ENV_SCRIPT@@
T3_NODE_SCRIPT_PATH=@@T3_NODE_SCRIPT_PATH@@
if [ -n "$T3_NODE_SCRIPT_PATH" ]; then
  # Dev mode: a source checkout on the remote. This is the only path that
  # needs Node, so Node discovery runs here and nowhere else.
  ensure_remote_node_path || true
  if ! command -v node >/dev/null 2>&1; then
    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
    exit 1
  fi
  exec node "$T3_NODE_SCRIPT_PATH" "$@"
fi
T3_ARCHIVE_VERSION=@@T3_ARCHIVE_VERSION@@
if [ -z "$T3_ARCHIVE_VERSION" ]; then
  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2
  exit 1
fi
# Self-contained release archive: no Node, npm, or compiler on the remote.
# Unpacked into the pinned-runtime layout so \`goat service install\` reuses it.
T3_RELEASE_BASE_URL=@@T3_RELEASE_BASE_URL@@
T3_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION"
t3_runtime_ready() {
  [ -x "$T3_RUNTIME_DIR/goat" ] && [ "$(cat "$T3_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$T3_ARCHIVE_VERSION" ]
}
if ! t3_runtime_ready; then
  mkdir -p "$HOME/.goat/runtime/goat/versions"
  # Concurrent launches (two clients, a retry racing a slow first run) must
  # not both install: mkdir is the atomic lock and the ready check repeats
  # under it.
  T3_LOCK="$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock"
  # mkdir is the only portable atomic exclusive create (mv would silently
  # nest a candidate inside an existing lock). The owner publishes its pid
  # right after, so a lock with a live owner is never reclaimed however
  # slow its download is, and a lock whose owner is dead is reclaimed at
  # once. A lock with no pid at all is a crash between mkdir and the pid
  # write; it is reclaimed after a short grace so a live owner has time to
  # publish.
  T3_LOCK_WAITED=0
  T3_LOCK_UNOWNED=0
  while ! mkdir "$T3_LOCK" 2>/dev/null; do
    T3_LOCK_OWNER="$(cat "$T3_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$T3_LOCK_OWNER" ]; then
      T3_LOCK_UNOWNED=0
      if ! kill -0 "$T3_LOCK_OWNER" 2>/dev/null; then
        rm -rf "$T3_LOCK"
        continue
      fi
    else
      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))
      if [ "$T3_LOCK_UNOWNED" -ge 5 ]; then
        rm -rf "$T3_LOCK"
        continue
      fi
    fi
    if [ "$T3_LOCK_WAITED" -ge @@T3_ARCHIVE_LOCK_WAIT_SECONDS@@ ]; then
      printf 'Another GOAT %s installation has held %s for too long.\\n' "$T3_ARCHIVE_VERSION" "$T3_LOCK" >&2
      exit 1
    fi
    sleep 1
    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))
  done
  printf '%s\\n' "$$" > "$T3_LOCK/pid.tmp" && mv "$T3_LOCK/pid.tmp" "$T3_LOCK/pid"
  trap 'rm -rf "$T3_LOCK"' EXIT
fi
if ! t3_runtime_ready; then
  case "$(uname -s)" in
    Darwin) T3_PLATFORM="darwin" ;;
    Linux) T3_PLATFORM="linux" ;;
    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) T3_ARCH="arm64" ;;
    x86_64 | amd64) T3_ARCH="x64" ;;
    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  T3_ARCHIVE="goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"
  T3_STAGING="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.staging-XXXXXX")"
  trap 'rm -rf "$T3_STAGING" "$T3_LOCK"' EXIT
  t3_fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 "$1" -O "$2"
    else printf 'Remote host needs curl or wget to download %s.\\n' "$T3_ARCHIVE" >&2; exit 1
    fi
  }
  t3_fetch "$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS" "$T3_STAGING/SHA256SUMS" @@T3_ARCHIVE_CHECKSUMS_SECONDS@@
  t3_fetch "$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE" "$T3_STAGING/$T3_ARCHIVE" @@T3_ARCHIVE_DOWNLOAD_SECONDS@@
  T3_EXPECTED="$(grep " \\*\\{0,1\\}$T3_ARCHIVE$" "$T3_STAGING/SHA256SUMS" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then
    T3_ACTUAL="$(sha256sum "$T3_STAGING/$T3_ARCHIVE" | cut -d' ' -f1)"
  else
    T3_ACTUAL="$(shasum -a 256 "$T3_STAGING/$T3_ARCHIVE" | cut -d' ' -f1)"
  fi
  if [ -z "$T3_EXPECTED" ] || [ "$T3_ACTUAL" != "$T3_EXPECTED" ]; then
    printf 'Checksum mismatch for %s.\\n' "$T3_ARCHIVE" >&2; exit 1
  fi
  tar -xzf "$T3_STAGING/$T3_ARCHIVE" -C "$T3_STAGING" --strip-components=1
  rm -f "$T3_STAGING/$T3_ARCHIVE" "$T3_STAGING/SHA256SUMS"
  # Verify the executable and exact version before replacing a runtime,
  # including a same-version directory whose completion marker is broken.
  if ! T3_STAGED_VERSION_OUTPUT="$("$T3_STAGING/goat" --version)"; then
    printf 'The goat %s executable does not run on this host.\\n' "$T3_ARCHIVE_VERSION" >&2; exit 1
  fi
  if [ "$T3_STAGED_VERSION_OUTPUT" != "goat v$T3_ARCHIVE_VERSION" ]; then
    printf 'Cannot install goat %s: expected goat v%s, but the archive executable reported "%s". The existing runtime directory and completion marker have been left unchanged. Supply the correct requested archive in the local SSH runtime archive directory or release mirror, then retry.\\n' "$T3_ARCHIVE_VERSION" "$T3_ARCHIVE_VERSION" "$T3_STAGED_VERSION_OUTPUT" >&2
    exit 1
  fi
  printf '%s\\n' "$T3_ARCHIVE_VERSION" > "$T3_STAGING/.install-complete"
  rm -rf "$T3_RUNTIME_DIR"
  mv "$T3_STAGING" "$T3_RUNTIME_DIR"
fi
if [ -n "\${T3_LOCK:-}" ]; then
  rm -rf "$T3_LOCK"
  trap - EXIT
fi
exec "$T3_RUNTIME_DIR/goat" "$@"
`;

// Publishing a runner is the switch boundary. Execute the candidate first;
// auth commands keep an existing runner so they match its running server.
const REMOTE_RUNNER_SETUP_SCRIPT = `RUNNER_FILE="$STATE_DIR/run-t3.sh"
RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
REQUESTED_RUNNER=@@T3_REQUESTED_RUNNER@@
EXPECTED_ARCHIVE_VERSION=@@T3_EXPECTED_ARCHIVE_VERSION@@
mkdir -p "$STATE_DIR"
cleanup_runner_next() {
  rm -f "$RUNNER_NEXT"
}
trap cleanup_runner_next EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cat >"$RUNNER_NEXT" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
verify_runner_next() {
  chmod 700 "$RUNNER_NEXT"
  if ! RUNNER_VERSION_OUTPUT="$("$RUNNER_NEXT" --version)"; then
    printf 'Cannot prepare %s on this host. The existing runner and server have been left unchanged. Supply a valid archive for the requested version in the local SSH runtime archive directory, or configure a release mirror containing that version, then retry.\\n' "$REQUESTED_RUNNER" >&2
    exit 1
  fi
  if [ -n "$EXPECTED_ARCHIVE_VERSION" ] && [ "$RUNNER_VERSION_OUTPUT" != "goat v$EXPECTED_ARCHIVE_VERSION" ]; then
    printf 'Cannot prepare %s: expected goat v%s, but the candidate reported "%s". The existing runner and server have been left unchanged. Supply the correct requested archive in the local SSH runtime archive directory or release mirror, and have the owning client clear the rejected version cache at %s before retrying.\\n' "$REQUESTED_RUNNER" "$EXPECTED_ARCHIVE_VERSION" "$RUNNER_VERSION_OUTPUT" "$HOME/.goat/runtime/goat/versions/$EXPECTED_ARCHIVE_VERSION" >&2
    exit 1
  fi
}
RUNNER_CHANGED=0
@@T3_RUNNER_INSTALL@@
`;

const REMOTE_LAUNCH_SCRIPT = `set -eu
@@T3_NODE_ENV_SCRIPT@@
STATE_KEY="$1"
STATE_DIR="$HOME/.goat/ssh-launch/$STATE_KEY"
DEFAULT_SERVER_HOME="$HOME/.goat"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
LOG_FILE="$STATE_DIR/server.log"
@@T3_RUNNER_SETUP@@
T3_ARCHIVE_MODE=@@T3_ARCHIVE_MODE@@
if [ "$T3_ARCHIVE_MODE" = "1" ]; then
  # The archive ships the helpers below inside the executable; the remote
  # needs no Node at all. Resolving the runner once here also downloads the
  # archive before the port and readiness probes rely on it.
  "$RUNNER_FILE" --version >/dev/null
elif ! ensure_remote_node_path; then
  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
  exit 1
fi
pick_port() {
  if [ "$T3_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE" "@@T3_DEFAULT_REMOTE_PORT@@" "@@T3_REMOTE_PORT_SCAN_WINDOW@@"
    return
  fi
  node - "$PORT_FILE" "@@T3_DEFAULT_REMOTE_PORT@@" "@@T3_REMOTE_PORT_SCAN_WINDOW@@" <<'NODE'
@@T3_PICK_PORT_SCRIPT@@
NODE
}
wait_ready() {
  if [ "$T3_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT" "$1" "@@T3_READY_PROBE_TIMEOUT_MS@@"
    return
  fi
  node - "$REMOTE_PORT" "$1" "@@T3_READY_PROBE_TIMEOUT_MS@@" <<'NODE'
@@T3_WAIT_READY_SCRIPT@@
NODE
}
wait_for_pid_exit() {
  PID_TO_WAIT="$1"
  WAIT_COUNT=0
  while kill -0 "$PID_TO_WAIT" 2>/dev/null && [ "$WAIT_COUNT" -lt 20 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
}
resolve_default_runtime_port() {
  if [ "$T3_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"
    return
  fi
  node - "$DEFAULT_RUNTIME_FILE" <<'NODE'
const fs = require("node:fs");
const runtimePath = process.argv[2] ?? "";
try {
	  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
	  const pid = Number(runtime.pid);
	  const port = Number(runtime.port);
	  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {
	    process.exit(1);
	  }
  const origin = new URL(String(runtime.origin ?? ""));
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    process.exit(1);
  }
  process.kill(pid, 0);
  process.stdout.write(\`\${pid} \${port}\`);
} catch {
  process.exit(1);
}
NODE
}
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port 2>/dev/null || true)"
DEFAULT_RUNTIME_PID=""
DEFAULT_REMOTE_PORT=""
if [ -n "$DEFAULT_RUNTIME_INFO" ]; then
  DEFAULT_RUNTIME_PID="\${DEFAULT_RUNTIME_INFO%% *}"
  DEFAULT_REMOTE_PORT="\${DEFAULT_RUNTIME_INFO#* }"
fi
if [ -n "$DEFAULT_REMOTE_PORT" ]; then
  REMOTE_PORT="$DEFAULT_REMOTE_PORT"
  if wait_ready "@@T3_REUSE_READY_TIMEOUT_MS@@"; then
    @@T3_OWN_RUNTIME_CHECK@@if [ "$REMOTE_MANAGED" = "managed" ]; then
      PID_TO_STOP="\${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"
      if [ -n "$PID_TO_STOP" ] && kill -0 "$PID_TO_STOP" 2>/dev/null; then
        kill "$PID_TO_STOP" 2>/dev/null || true
        wait_for_pid_exit "$PID_TO_STOP"
      fi
      REMOTE_PID=""
      REMOTE_PORT="$DEFAULT_REMOTE_PORT"
      REMOTE_MANAGED="external"
      rm -f "$PID_FILE"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
    else
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
      REMOTE_PID=""
      REMOTE_MANAGED="external"
    fi
  else
    REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
    REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
  fi
fi
if [ "$REMOTE_MANAGED" = "external" ]; then
  if [ -z "$REMOTE_PORT" ] || ! wait_ready "@@T3_REUSE_READY_TIMEOUT_MS@@"; then
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  fi
elif [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  if [ "$RUNNER_CHANGED" -eq 1 ]; then
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  elif ! wait_ready "@@T3_REUSE_READY_TIMEOUT_MS@@"; then
    @@T3_BUSY_SERVER_GUARD@@kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  fi
else
  REMOTE_PID=""
  REMOTE_PORT=""
  REMOTE_MANAGED=""
fi
if [ -z "$REMOTE_PORT" ]; then
  REMOTE_PORT="$(pick_port)" || true
  if [ -z "$REMOTE_PORT" ]; then
    if [ "$T3_ARCHIVE_MODE" = "1" ]; then
      printf 'Failed to find an available port on the remote host.\\n' >&2
    else
      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2
    fi
    exit 1
  fi
  nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  REMOTE_PID="$!"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
  printf 'managed\\n' >"$MANAGED_FILE"
  if ! wait_ready "@@T3_READY_TIMEOUT_MS@@"; then
    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' "$REMOTE_PORT" >&2
    if [ -s "$LOG_FILE" ]; then
      tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    else
      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' "$LOG_FILE" >&2
    fi
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
    exit 1
  fi
fi
printf '{"remotePort":%s,"serverKind":"%s"}\\n' "$REMOTE_PORT" "\${REMOTE_MANAGED:-managed}"
`;

const REMOTE_PAIRING_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@T3_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.goat"
@@T3_RUNNER_SETUP@@
PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"
"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
`;

// Matching bytes preserve the installed file and do not restart a server.
const REPLACE_RUNNER_INSTALL = `if [ -f "$RUNNER_FILE" ] && cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  rm -f "$RUNNER_NEXT"
else
  verify_runner_next
  mv "$RUNNER_NEXT" "$RUNNER_FILE"
  RUNNER_CHANGED=1
fi`;
// A second client of the host keeps whatever runner is already there, so it
// never restarts a server another client launched.
const KEEP_EXISTING_RUNNER_INSTALL = `if [ -f "$RUNNER_FILE" ]; then
  rm -f "$RUNNER_NEXT"
else
  verify_runner_next
  mv "$RUNNER_NEXT" "$RUNNER_FILE"
fi`;

// A managed server also writes the default runtime descriptor. Keep its
// ownership here; the later RUNNER_CHANGED branch alone decides replacement.
const REPLACE_OWN_RUNTIME_CHECK = `if [ "$REMOTE_MANAGED" = "managed" ] && [ -n "$REMOTE_PID" ] && [ "$REMOTE_PID" = "$DEFAULT_RUNTIME_PID" ]; then
      REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
    el`;

// A managed server started with the default base dir records itself as the
// default runtime, so a later launch would read its own server as a separate
// default one, stop it and start another. That cuts off every client already
// connected. The second-client path never takes the stopping branch: it keeps
// a live managed server, or else uses the answering default one as it is
// without touching the state files. The "el" prefix turns the stopping "if"
// into an unreachable "elif".
const KEEP_OWN_RUNTIME_CHECK = `if [ "$REMOTE_MANAGED" = "managed" ]; then
      if [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
        REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
      else
        REMOTE_PID=""
        REMOTE_MANAGED="external"
      fi
    el`;
// The second-client path never stops a server another client may be using:
// an unresponsive one fails this launch instead.
const KEEP_BUSY_SERVER_GUARD = `echo "The T3 server on this host did not answer in time; leaving it running for its clients." >&2
    exit 1
    `;

// Issues an `mcp-client` bearer session, the only kind the remote's `/mcp`
// admits from outside a thread. `--runtime-mode-ceiling` is newer than some
// remotes, so an older CLI is retried without it and reports the default.
const REMOTE_MCP_SESSION_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@T3_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.goat"
@@T3_RUNNER_SETUP@@
set -- auth session issue --base-dir "$DEFAULT_SERVER_HOME" --subject mcp-client --scope orchestration:read --scope orchestration:operate --ttl @@T3_TTL@@ --label @@T3_LABEL@@ --json
CEILING=@@T3_CEILING@@
if [ -n "$CEILING" ] && OUTPUT="$("$RUNNER_FILE" "$@" --runtime-mode-ceiling "$CEILING" 2>/dev/null)"; then
  printf 'T3_CEILING=applied\\n%s\\n' "$OUTPUT"
else
  OUTPUT="$("$RUNNER_FILE" "$@")"
  printf 'T3_CEILING=default\\n%s\\n' "$OUTPUT"
fi
`;

const REMOTE_STOP_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@T3_STATE_KEY@@"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
MANAGED_FILE="$STATE_DIR/managed"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  kill "$REMOTE_PID" 2>/dev/null || true
  WAIT_COUNT=0
  while kill -0 "$REMOTE_PID" 2>/dev/null && [ "$WAIT_COUNT" -lt 20 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
  if kill -0 "$REMOTE_PID" 2>/dev/null; then
    printf 'Remote T3 server with PID %s did not stop within 2 seconds. Its ownership files were kept.\\n' "$REMOTE_PID" >&2
    exit 1
  fi
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
printf '{"stopped":true}\\n'
`;

const REMOTE_LOG_TAIL_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@T3_STATE_KEY@@"
LOG_FILE="$STATE_DIR/server.log"
if [ -f "$LOG_FILE" ]; then
  tail -n 80 "$LOG_FILE" 2>/dev/null || true
fi
`;

export class SshInvalidArchiveVersionError extends Schema.TaggedError<SshInvalidArchiveVersionError>()(
  "SshInvalidArchiveVersionError",
  { archiveVersion: Schema.String },
) {
  override get message(): string {
    return `'${this.archiveVersion}' is not an exact GOAT version and cannot name a runtime directory.`;
  }
}

// The version becomes a directory name the runner removes and recreates, so
// it must be one exact SemVer segment: no separators, no `..`, no shell
// metacharacters beyond what SemVer allows.
const EXACT_ARCHIVE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class SshMissingRunnerError extends Schema.TaggedError<SshMissingRunnerError>()(
  "SshMissingRunnerError",
  {},
) {
  override get message(): string {
    return "A remote goat runner needs an archive version or a node script path.";
  }
}

export function buildRemoteT3RunnerScript(input?: RemoteT3RunnerOptions): string {
  const nodeScriptPath = input?.nodeScriptPath?.trim() || "";
  const archiveVersion = input?.archiveVersion?.trim() || "";
  if (nodeScriptPath === "" && archiveVersion === "") {
    throw new SshMissingRunnerError();
  }
  if (archiveVersion !== "" && !EXACT_ARCHIVE_VERSION.test(archiveVersion)) {
    throw new SshInvalidArchiveVersionError({ archiveVersion });
  }
  // Strip the `/v<version>` the helper appends: the script builds URLs itself.
  const releaseBaseUrl = cliReleaseDownloadBaseUrl("", input?.releaseBaseUrl ?? undefined).replace(
    /\/v$/u,
    "",
  );
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_RUNNER_SCRIPT, {
      T3_NODE_SCRIPT_PATH: shellSingleQuote(nodeScriptPath),
      T3_ARCHIVE_VERSION: shellSingleQuote(archiveVersion),
      T3_RELEASE_BASE_URL: shellSingleQuote(releaseBaseUrl),
      T3_ARCHIVE_LOCK_WAIT_SECONDS: String(REMOTE_ARCHIVE_LOCK_WAIT_SECONDS),
      T3_ARCHIVE_DOWNLOAD_SECONDS: String(REMOTE_ARCHIVE_DOWNLOAD_SECONDS),
      T3_ARCHIVE_CHECKSUMS_SECONDS: String(REMOTE_ARCHIVE_CHECKSUMS_SECONDS),
      T3_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    }),
  );
}

export function buildRemoteNodeEnvScript(input?: RemoteT3RunnerOptions): string {
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_NODE_ENV_SCRIPT, {
      T3_NODE_ENGINE_RANGE: shellSingleQuote(input?.nodeEngineRange?.trim() || ""),
      T3_NODE_ENGINE_CHECK_SCRIPT: stripTrailingNewlines(buildRemoteNodeEngineCheckScript()),
    }),
  );
}

function buildRemoteRunnerSetupScript(
  input: RemoteT3RunnerOptions | undefined,
  keepExistingRunner: boolean,
): string {
  const requestedRunner = isNodeScriptRunner(input)
    ? `Node script ${input?.nodeScriptPath?.trim()}`
    : `GOAT ${input?.archiveVersion?.trim()}`;
  return applyScriptPlaceholders(REMOTE_RUNNER_SETUP_SCRIPT, {
    T3_REQUESTED_RUNNER: shellSingleQuote(requestedRunner),
    T3_EXPECTED_ARCHIVE_VERSION: shellSingleQuote(
      isNodeScriptRunner(input) ? "" : input?.archiveVersion?.trim() || "",
    ),
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
    T3_RUNNER_INSTALL: keepExistingRunner ? KEEP_EXISTING_RUNNER_INSTALL : REPLACE_RUNNER_INSTALL,
  });
}

export function buildRemoteLaunchScript(input?: RemoteT3RunnerOptions): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    T3_ARCHIVE_MODE: isNodeScriptRunner(input) ? "0" : "1",
    T3_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, input?.keepExistingRunner === true),
    T3_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    T3_WAIT_READY_SCRIPT: stripTrailingNewlines(REMOTE_WAIT_READY_SCRIPT),
    T3_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    T3_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
    T3_READY_TIMEOUT_MS: String(REMOTE_READY_TIMEOUT_MS),
    T3_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    T3_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
    T3_OWN_RUNTIME_CHECK: input?.keepExistingRunner
      ? KEEP_OWN_RUNTIME_CHECK
      : REPLACE_OWN_RUNTIME_CHECK,
    T3_BUSY_SERVER_GUARD: input?.keepExistingRunner ? KEEP_BUSY_SERVER_GUARD : "",
  });
}

export function buildRemoteMcpSessionScript(
  stateKey: string,
  options: RemoteMcpClientSessionOptions,
  input?: RemoteT3RunnerOptions,
): string {
  return applyScriptPlaceholders(REMOTE_MCP_SESSION_SCRIPT, {
    T3_STATE_KEY: stateKey,
    T3_TTL: shellSingleQuote(options.ttl),
    T3_LABEL: shellSingleQuote(options.label),
    T3_CEILING: shellSingleQuote(options.runtimeModeCeiling ?? ""),
    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, true),
  });
}

/** Reads the remote session script's output: a ceiling marker line, then the CLI's JSON. */
export const decodeRemoteMcpSessionOutput = Effect.fn("ssh/tunnel.decodeRemoteMcpSessionOutput")(
  function* (stdout: string) {
    const marker = /^T3_CEILING=(applied|default)$/mu.exec(stdout);
    const session = yield* decodeRemoteJsonOutput(
      marker === null ? stdout : stdout.slice(marker.index + marker[0].length),
      decodeRemoteMcpSessionResult,
    );
    return {
      token: session.token,
      expiresAt: session.expiresAt ?? null,
      runtimeModeCeilingApplied: marker?.[1] === "applied",
    } satisfies RemoteMcpClientSession;
  },
);

export function buildRemotePairingScript(stateKey: string, input?: RemoteT3RunnerOptions): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    T3_STATE_KEY: stateKey,
    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, true),
  });
}

export function buildRemoteT3UploadInstallerScript(
  input: RemoteT3RunnerOptions,
  sha256: string,
): string {
  if (
    isNodeScriptRunner(input) ||
    !input.archiveVersion?.trim() ||
    !/^[0-9a-f]{64}$/iu.test(sha256)
  ) {
    throw new SshLaunchError({
      message: "Upload requires an archive version and SHA256 digest.",
      stdout: "",
    });
  }
  const script = buildRemoteT3RunnerScript(input);
  const startAnchor = '  t3_fetch "$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS"';
  const endAnchor = "  if command -v sha256sum >/dev/null 2>&1; then";
  const start = script.indexOf(startAnchor);
  const end = script.indexOf(endAnchor);
  if (
    start < 0 ||
    end <= start ||
    script.indexOf(startAnchor, start + 1) !== -1 ||
    script.indexOf(endAnchor, end + 1) !== -1
  ) {
    throw new SshLaunchError({ message: "acquisition block no longer matches", stdout: "" });
  }
  // Patch a transient copy so preparation never changes the managed runner.
  return (
    script.slice(0, start) +
    '  cp "$T3_SSH_UPLOADED_ARCHIVE" "$T3_STAGING/$T3_ARCHIVE"\n' +
    `  T3_EXPECTED='${sha256.toLowerCase()}'\n` +
    script.slice(end)
  );
}

export function buildRemoteUploadScript(input: RemoteT3RunnerOptions, sha256: string): string {
  const installer = buildRemoteT3UploadInstallerScript(input, sha256);
  return `set -eu
umask 077
mkdir -p "$HOME/.goat/runtime/goat/versions"
upload_dir="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.upload-XXXXXX")"
trap 'rm -rf "$upload_dir"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$upload_dir/archive.tar.gz"
export T3_SSH_UPLOADED_ARCHIVE="$upload_dir/archive.tar.gz"
sh -c ${shellSingleQuote(installer)} -- --version
`;
}

export function buildRemoteRuntimeProbeScript(
  version: string,
  stateKey?: string,
  keepExistingRunner = false,
): string {
  return `set -eu
V=${shellSingleQuote(version)}
state_key=${shellSingleQuote(stateKey ?? "")}
retained_fields=
runner="$HOME/.goat/ssh-launch/$state_key/run-t3.sh"
if [ "${keepExistingRunner ? "1" : "0"}" = 1 ] && [ -n "$state_key" ] && [ -f "$runner" ]; then
  node_script_path="$(sed -n "s/^T3_NODE_SCRIPT_PATH='\\(.*\\)'$/\\1/p" "$runner")"
  retained_version=
  retained=ready
  if [ -z "$node_script_path" ]; then
    retained_version="$(sed -n "s/^T3_ARCHIVE_VERSION='\\([^']*\\)'$/\\1/p" "$runner")"
    case "$retained_version" in
      ''|*[!0-9A-Za-z.-]*) printf 'The retained runner has an invalid exact archive version.\\n' >&2; exit 1 ;;
    esac
    if ! printf '%s\\n' "$retained_version" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'; then
      printf 'The retained runner has an invalid exact archive version.\\n' >&2; exit 1
    fi
    retained_runtime="$HOME/.goat/runtime/goat/versions/$retained_version"
    if [ ! -x "$retained_runtime/goat" ] || [ "$(cat "$retained_runtime/.install-complete" 2>/dev/null)" != "$retained_version" ]; then
      retained=missing
    fi
  fi
  retained_fields="$(printf ',\"retained\":\"%s\",\"retainedVersion\":\"%s\"' "$retained" "$retained_version")"
fi
case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) printf 'Unsupported SSH runtime OS.\\n' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) printf 'Unsupported SSH runtime architecture.\\n' >&2; exit 1 ;;
esac
runtime="$HOME/.goat/runtime/goat/versions/$V"
ready=false
if [ -x "$runtime/goat" ] && [ "$(cat "$runtime/.install-complete" 2>/dev/null)" = "$V" ]; then
  ready=true
fi
printf '{"platform":"%s","arch":"%s","ready":%s%s}\\n' "$platform" "$arch" "$ready" "$retained_fields"
`;
}

const decodeRemoteRuntimeProbe = Schema.decodeEffect(
  fromLenientJson(
    Schema.Struct({
      platform: Schema.Literals(["darwin", "linux"]),
      arch: Schema.Literals(["arm64", "x64"]),
      ready: Schema.Boolean,
      retained: Schema.optionalKey(Schema.Literals(["ready", "missing"])),
      retainedVersion: Schema.optionalKey(Schema.String),
    }),
  ),
);

const runtimePreparationError = (cause: unknown) =>
  cause instanceof SshLaunchError
    ? cause
    : new SshLaunchError({
        message: "Failed to prepare the SSH runtime archive.",
        stdout: "",
        cause,
      });

export const prepareRemoteRuntime = (
  target: DesktopSshEnvironmentTarget,
  authOptions: SshAuth.SshAuthOptions,
  runner?: RemoteT3RunnerOptions,
  stateKey?: string,
) =>
  Effect.gen(function* () {
    const mayRetainRunner = runner?.keepExistingRunner && stateKey !== undefined;
    if (isNodeScriptRunner(runner) && !mayRetainRunner) return;
    const directory = runner?.archiveDirectory?.trim() ?? "";
    const bundleDirectory = runner?.bundledArchiveDirectory?.trim() ?? "";
    const mirror = runner?.releaseBaseUrl?.trim() ?? "";
    // Explicit mirrors retain the existing path without a local cache.
    if (directory === "" && bundleDirectory === "" && mirror !== "" && !mayRetainRunner) return;
    const version = runner?.archiveVersion?.trim() ?? "";
    yield* Effect.annotateCurrentSpan({
      "ssh.target": target.alias,
      "t3.runtime.version": version,
    });
    yield* Effect.try({
      try: () => buildRemoteT3RunnerScript(runner),
      catch: runtimePreparationError,
    });
    const result = yield* runSshCommand(target, {
      ...authOptions,
      remoteCommandArgs: ["sh", "-l", "-s"],
      stdin: buildRemoteRuntimeProbeScript(version, stateKey, runner?.keepExistingRunner ?? false),
    }).pipe(Effect.mapError(runtimePreparationError));
    const probe = yield* decodeRemoteJsonOutput(result.stdout, decodeRemoteRuntimeProbe).pipe(
      Effect.mapError(runtimePreparationError),
    );
    if (probe.retained === "ready") {
      yield* Effect.annotateCurrentSpan("t3.runtime.source", "retained-runner");
      return;
    }
    if (probe.retained === "missing") {
      return yield* new SshLaunchError({
        message: `The retained runner ~/.goat/ssh-launch/${stateKey}/run-t3.sh selects goat ${probe.retainedVersion}, which is not installed on ${target.alias}. This client reuses that runner and will not replace it; reconnect from the client that owns it, or remove the runner to let this client install its own runtime.`,
        stdout: "",
      });
    }
    if (isNodeScriptRunner(runner)) return;
    if (probe.ready) {
      yield* Effect.annotateCurrentSpan("t3.runtime.source", "ready");
      return;
    }
    const platformKey = cliArchivePlatformKey(probe.platform, probe.arch);
    if (platformKey === undefined) {
      if (mirror !== "") {
        yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
        return;
      }
      const asset =
        platformKey === undefined
          ? `unsupported-${probe.platform}-${probe.arch}`
          : cliArchiveFileName(version, platformKey);
      return yield* new SshLaunchError({
        message: `Cannot acquire the SSH runtime archive (repo=${CLI_RELEASE_REPOSITORY}, tag=v${version}, asset=${asset}, archive directory=${directory || "<not configured>"}). Configure a local archive directory and use a supported SSH platform, or an explicit release mirror.`,
        stdout: "",
      });
    }
    const bundledArchive =
      bundleDirectory === ""
        ? null
        : yield* readLocalRuntimeArchive(bundleDirectory, version, platformKey, true).pipe(
            Effect.mapError(runtimePreparationError),
          );
    const localArchive =
      bundledArchive !== null || directory === ""
        ? null
        : yield* readLocalRuntimeArchive(directory, version, platformKey).pipe(
            Effect.mapError(runtimePreparationError),
          );
    if (bundledArchive === null && localArchive === null && mirror !== "") {
      yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
      return;
    }
    if (bundledArchive === null && localArchive === null) {
      const path = yield* Path.Path;
      if (
        directory === "" ||
        (bundleDirectory !== "" && path.resolve(directory) === path.resolve(bundleDirectory))
      ) {
        return yield* new SshLaunchError({
          message: `Cannot acquire ${cliArchiveFileName(version, platformKey)} for ${target.alias}: no writable user archive cache distinct from the bundle (${directory || "<not configured>"}). Configure archiveDirectory for goat-si/goat release v${version} or rebuild the packaged archives.`,
          stdout: "",
        });
      }
    }
    const archive =
      bundledArchive ??
      localArchive ??
      (yield* downloadRuntimeArchiveWithGh(directory, version, platformKey, runner?.ghCommand));
    yield* Effect.annotateCurrentSpan(
      "t3.runtime.acquisition",
      bundledArchive !== null ? "bundle" : localArchive !== null ? "cache" : "gh",
    );
    yield* Effect.annotateCurrentSpan({
      "t3.runtime.source": "upload",
      "t3.runtime.upload.bytes": archive.bytes.byteLength,
      "t3.runtime.upload.sha256": archive.sha256,
      "t3.runtime.upload.installComplete": false,
    });
    const script = yield* Effect.try({
      try: () => buildRemoteUploadScript({ ...runner, archiveVersion: version }, archive.sha256),
      catch: runtimePreparationError,
    });
    yield* runSshCommand(target, {
      ...authOptions,
      remoteCommandArgs: ["sh", "-c", shellSingleQuote(script)],
      stdin: archive.bytes,
      timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
    });
    yield* Effect.annotateCurrentSpan("t3.runtime.upload.installComplete", true);
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SshLaunchError
        ? new SshLaunchError({
            message: `Cannot prepare GOAT ${runner?.archiveVersion?.trim() || "(node-script runner)"} on ${target.alias}: ${error.message} The existing runner and server have been left unchanged. Supply the requested runtime archive in the local SSH runtime archive directory or a release mirror, then retry.`,
            stdout: error.stdout,
            cause: error,
          })
        : error,
    ),
    Effect.withSpan("ssh.prepareRemoteRuntime"),
  );

export function buildRemoteStopScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_STOP_SCRIPT, {
    T3_STATE_KEY: stateKey,
  });
}

function buildRemoteLogTailScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_LOG_TAIL_SCRIPT, {
    T3_STATE_KEY: stateKey,
  });
}

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuth.SshAuthOptions,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<
    { readonly remotePort: number; readonly remoteServerKind: "external" | "managed" | null },
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    const stateKey = yield* remoteStateKey(target);
    yield* Effect.logInfo("ssh.remoteServer.launch.start", {
      ...sshTargetLogFields(target),
      ...sshRunnerLogFields(runner),
      stateKey,
    });
    yield* prepareRemoteRuntime(target, input ?? {}, runner, stateKey);
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-l", "-s", "--", stateKey],
      stdin: buildRemoteLaunchScript(runner),
      timeoutMs: isNodeScriptRunner(runner)
        ? REMOTE_LAUNCH_TIMEOUT_MS
        : REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    });
    if (!getLastNonEmptyOutputLine(result.stdout)) {
      return yield* new SshLaunchError({
        message: "SSH launch did not return a remote port.",
        stdout: result.stdout,
      });
    }
    const parsed = yield* decodeRemoteLaunchOutput(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: "SSH launch returned unparseable output.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (!Number.isInteger(parsed.remotePort)) {
      return yield* new SshLaunchError({
        message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
        stdout: result.stdout,
      });
    }
    yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
      ...sshTargetLogFields(target),
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      stateKey,
    });
    return {
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
    };
  },
);

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
  runner?: RemoteT3RunnerOptions,
): Effect.fn.Return<
  {
    readonly credential: string;
  },
  SshCommandError | SshInvalidTargetError | SshPairingError | SshLaunchError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const stateKey = yield* remoteStateKey(target);
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.start", {
    ...sshTargetLogFields(target),
    stateKey,
  });
  yield* prepareRemoteRuntime(
    target,
    input ?? {},
    { ...runner, keepExistingRunner: true },
    stateKey,
  );
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemotePairingScript(stateKey, runner),
    // Pairing may be the first command on a cold remote, so it can install
    // the archive on the way.
    ...(isNodeScriptRunner(runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingOutput(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "SSH pairing returned unparseable output.",
          stdout: result.stdout,
          cause,
        }),
    ),
  );
  if (parsed.credential.trim().length === 0) {
    return yield* new SshPairingError({
      message: "SSH pairing command returned an invalid credential.",
      stdout: result.stdout,
    });
  }
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.created", {
    ...sshTargetLogFields(target),
    stateKey,
  });
  return {
    credential: parsed.credential,
  };
});

export const issueRemoteMcpClientSession = Effect.fn("ssh/tunnel.issueRemoteMcpClientSession")(
  function* (
    target: DesktopSshEnvironmentTarget,
    sessionOptions: RemoteMcpClientSessionOptions,
    input?: SshAuth.SshAuthOptions,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<
    RemoteMcpClientSession,
    SshCommandError | SshInvalidTargetError | SshPairingError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    const stateKey = yield* remoteStateKey(target);
    yield* prepareRemoteRuntime(
      target,
      input ?? {},
      { ...runner, keepExistingRunner: true },
      stateKey,
    );
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-s"],
      stdin: buildRemoteMcpSessionScript(stateKey, sessionOptions, runner),
      // Like pairing, this may be the first command on a cold remote.
      ...(isNodeScriptRunner(runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    });
    const session = yield* decodeRemoteMcpSessionOutput(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshPairingError({
            message: "The remote T3 CLI did not return an MCP session.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (session.token.trim().length === 0) {
      return yield* new SshPairingError({
        message: "The remote T3 CLI returned an empty MCP session token.",
        stdout: result.stdout,
      });
    }
    yield* Effect.logInfo("ssh.remoteServer.mcpSession.issued", {
      ...sshTargetLogFields(target),
      stateKey,
      runtimeModeCeilingApplied: session.runtimeModeCeilingApplied,
    });
    return session;
  },
);

const stopRemoteServer = Effect.fn("ssh/tunnel.stopRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
): Effect.fn.Return<
  void,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const stateKey = yield* remoteStateKey(target);
  yield* Effect.logInfo("ssh.remoteServer.stop.start", {
    ...sshTargetLogFields(target),
    stateKey,
  });
  yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteStopScript(stateKey),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  yield* Effect.logInfo("ssh.remoteServer.stop.succeeded", {
    ...sshTargetLogFields(target),
    stateKey,
  });
});

const readRemoteServerLogTail = Effect.fn("ssh/tunnel.readRemoteServerLogTail")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteLogTailScript(yield* remoteStateKey(target)),
    timeoutMs: 10_000,
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  return result.stdout.trim();
});

export const waitForHttpReady = (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly path?: string;
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_READY_PROBE_TIMEOUT_MS,
    makeError: ({ requestUrl, probeTimeoutMs, cause }) => {
      if (typeof cause === "object" && cause !== null && "kind" in cause) {
        const kind = (cause as { readonly kind?: unknown }).kind;
        if (kind === "probe-timeout") {
          return new SshReadinessError({
            message: `Backend readiness probe exceeded ${probeTimeoutMs}ms at ${requestUrl}.`,
            cause,
          });
        }
        if (kind === "overall-timeout") {
          const overall = cause as unknown as {
            readonly baseUrl: string;
            readonly timeoutMs: number;
            readonly lastFailure: unknown;
          };
          return new SshReadinessError({
            message: `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}.`,
            cause: overall.lastFailure,
          });
        }
      }
      return new SshReadinessError({
        message: `Backend readiness probe failed at ${requestUrl}.`,
        cause,
      });
    },
  });

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export const resolveLoopbackSshHttpBaseUrl = Effect.fn("ssh/tunnel.resolveLoopbackSshHttpBaseUrl")(
  function* (rawHttpBaseUrl: unknown): Effect.fn.Return<string, SshHttpBridgeError> {
    return yield* Effect.try({
      try: () => {
        if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
          throw new Error("Invalid SSH forwarded http base URL.");
        }
        const baseUrl = new URL(rawHttpBaseUrl);
        if (!isLoopbackHostname(baseUrl.hostname)) {
          throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
        }
        return baseUrl.toString();
      },
      catch: (cause) =>
        new SshHttpBridgeError({
          message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
          cause,
        }),
    });
  },
);

const reserveLocalTunnelPort = Effect.fn("ssh/tunnel.reserveLocalTunnelPort")(function* () {
  const net = yield* NetService.NetService;
  return yield* net.reserveLoopbackPort();
});

const startSshTunnel = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuth.SshAuthOptions;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly scope: Scope.Closeable;
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
> {
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget);
  const childEnvironment = yield* SshAuth.buildSshChildEnvironment({
    ...(input.authOptions.authSecret === undefined
      ? {}
      : { authSecret: input.authOptions.authSecret }),
    ...(input.authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: input.authOptions.interactiveAuth }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? "no",
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-n",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    hostSpec,
  ];
  const sshCommand = yield* resolveSshCommand;
  const tunnelCommand = [sshCommand, ...args];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { scope } = input;
  yield* Effect.logDebug("ssh.tunnel.spawn.start", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    localPort: input.localPort,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    httpBaseUrl: input.httpBaseUrl,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: childEnvironment,
        extendEnv: true,
        stdin: {
          stream: Stream.empty,
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: tunnelCommand,
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH tunnel for ${input.resolvedTarget.alias}.`,
            cause,
          }),
      ),
    );
  yield* Effect.logDebug("ssh.tunnel.spawn.succeeded", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const tunnelEntry: SshTunnelEntry = {
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
    scope,
  };
  const exitFailure = Effect.all(
    [collectProcessOutput(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: tunnelCommand,
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([stderr, exitCode]) => {
      const error = new SshCommandError({
        command: tunnelCommand,
        exitCode,
        stderr,
        message: normalizeSshErrorMessage(
          stderr,
          `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
        ),
      });
      return Effect.logWarning("ssh.tunnel.process.exited", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
        exitCode,
        stderr,
      }).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );
  yield* Effect.raceFirst(
    waitForHttpReady({
      baseUrl: input.httpBaseUrl,
      timeoutMs: SSH_READY_TIMEOUT_MS,
    }),
    exitFailure,
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("ssh.tunnel.ready", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const processRunningExit = yield* Effect.exit(child.isRunning);
        const localPortAvailableExit = yield* Effect.exit(
          net.canListenOnHost(input.localPort, "127.0.0.1"),
        );
        const remoteLogTailExit = yield* Effect.exit(
          readRemoteServerLogTail(input.resolvedTarget, input.authOptions),
        );
        const processRunning = Exit.isSuccess(processRunningExit) ? processRunningExit.value : null;
        const localPortAvailable = Exit.isSuccess(localPortAvailableExit)
          ? localPortAvailableExit.value
          : null;
        const remoteLogTail = Exit.isSuccess(remoteLogTailExit)
          ? remoteLogTailExit.value || null
          : null;
        yield* Effect.logWarning("ssh.tunnel.ready.failed", {
          ...sshTargetLogFields(input.resolvedTarget),
          command: tunnelCommand,
          pid: child.pid,
          processRunning,
          ...(Exit.isSuccess(processRunningExit)
            ? {}
            : { processRunningError: processRunningExit.cause }),
          localPort: input.localPort,
          localPortListening: localPortAvailable === null ? null : !localPortAvailable,
          remotePort: input.remotePort,
          httpBaseUrl: input.httpBaseUrl,
          ...(Exit.isSuccess(localPortAvailableExit)
            ? {}
            : { localPortProbeError: localPortAvailableExit.cause }),
          ...(remoteLogTail === null ? {} : { remoteLogTail }),
          ...(Exit.isSuccess(remoteLogTailExit)
            ? {}
            : { remoteLogTailError: remoteLogTailExit.cause }),
          cause,
        });
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : child
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore),
    ),
  );
  return tunnelEntry;
});

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const tunnels = new Map<string, SshTunnelEntry>();
  const targetLocks = yield* KeyedLock.make<string>();
  const authSecrets = new Map<string, string>();

  // Keep one lock per target so reconnect cannot reuse a server while stop is pending.
  const withTargetLock = Effect.fn("ssh/tunnel.withTargetLock")(function* <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    return yield* targetLocks.withLock(key, effect);
  });

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    yield* Effect.logDebug("ssh.tunnel.close.start", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("ssh.tunnel.close.succeeded", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.sync(() => [...tunnels.values()]).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, closeTunnelEntry, { concurrency: "unbounded" }),
      ),
      Effect.ignore,
    ),
  );

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<
    string,
    SshInvalidTargetError | SshPasswordPromptError,
    SshAuth.SshPasswordPrompt
  > {
    const promptService = yield* SshAuth.SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);
    if (!promptService.isAvailable) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.unavailable", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.request", {
      ...sshTargetLogFields(target),
      attempt,
    });
    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${hostSpec}.`,
    });
    if (password === null) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.cancelled", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }
    yield* Effect.logInfo("ssh.auth.passwordPrompt.received", {
      ...sshTargetLogFields(target),
      attempt,
    });
    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/tunnel.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError;
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
      if (!SshAuth.isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      yield* Effect.logWarning("ssh.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshAuth.SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/tunnel.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const promptService = yield* SshAuth.SshPasswordPrompt;
    const authOptions =
      input.authSecret === null
        ? {
            batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
            interactiveAuth: !promptService.isAvailable,
          }
        : {
            authSecret: input.authSecret,
            batchMode: "no" as const,
            interactiveAuth: true,
          };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/tunnel.runWithSshAuth")(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: authSecrets.get(input.key) ?? null,
    });
  });

  const createTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly runner?: RemoteT3RunnerOptions;
  }): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logDebug("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });
    const remoteLaunch = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        launchOrReuseRemoteServer(input.resolvedTarget, authOptions, input.runner),
    });
    const remotePort = remoteLaunch.remotePort;
    yield* Effect.logDebug("ssh.environment.remotePort.ready", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      remotePort,
      remoteServerKind: remoteLaunch.remoteServerKind,
    });
    const localPort = yield* reserveLocalTunnelPort();
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    yield* Effect.logDebug("ssh.environment.localPort.reserved", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    const entryScope = yield* Scope.make("sequential");
    const tunnelEntry = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        startSshTunnel({
          key: input.key,
          resolvedTarget: input.resolvedTarget,
          remotePort,
          localPort,
          httpBaseUrl,
          wsBaseUrl,
          authOptions,
          remoteServerKind: remoteLaunch.remoteServerKind,
          scope: entryScope,
        }),
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );
    tunnels.set(input.key, tunnelEntry);
    const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cryptoService = yield* Crypto.Crypto;
    const fileSystemService = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* Scope.addFinalizer(
      entryScope,
      Effect.gen(function* () {
        const stopRemote = tunnels.get(tunnelEntry.key) === tunnelEntry;
        if (stopRemote) {
          tunnels.delete(tunnelEntry.key);
        }
        yield* tunnelEntry.process
          .kill({
            killSignal: "SIGTERM",
            forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
          })
          .pipe(Effect.ignore);
        if (!stopRemote || options.leaveRemoteServerRunning === true) {
          return;
        }
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.start", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
        const authSecret = authSecrets.get(tunnelEntry.key) ?? null;
        yield* stopRemoteServer(
          tunnelEntry.target,
          authSecret === null
            ? {
                batchMode: "yes",
                interactiveAuth: false,
              }
            : {
                authSecret,
                batchMode: "no",
                interactiveAuth: true,
              },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerService),
          Effect.provideService(Crypto.Crypto, cryptoService),
          Effect.provideService(FileSystem.FileSystem, fileSystemService),
          Effect.provideService(Path.Path, pathService),
        );
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.succeeded", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
      }).pipe(Effect.ignore),
    );
    yield* Effect.logDebug("ssh.environment.tunnel.create.succeeded", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    return tunnelEntry;
  });

  const ensureTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry")(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const entry = tunnels.get(key) ?? null;

    if (entry !== null) {
      yield* Effect.logDebug("ssh.environment.tunnel.existing.check", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
      });
      const readinessExit = yield* Effect.exit(
        waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: 2_000 }),
      );
      if (Exit.isSuccess(readinessExit)) {
        yield* Effect.logDebug("ssh.environment.tunnel.reused", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
        });
        return entry;
      }
      yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
        cause: readinessExit.cause,
      });
      // A failed local forward is not authority to stop its remote server.
      // Remove ownership before closing so the scope finalizer stays local.
      yield* Effect.gen(function* () {
        if (tunnels.get(key) === entry) {
          tunnels.delete(key);
        }
        yield* closeTunnelEntry(entry);
      }).pipe(Effect.uninterruptible);
    }

    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      ...(runner === undefined ? {} : { runner }),
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("ssh.environment.tunnel.create.failed", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          cause,
        }),
      ),
    );
  });

  const ensureEnvironment = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: { readonly issuePairingToken?: boolean },
  ): Effect.fn.Return<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    yield* Effect.logInfo("ssh.environment.ensure.start", {
      ...sshTargetLogFields(target),
      issuePairingToken: requestOptions?.issuePairingToken === true,
    });
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    yield* Effect.logDebug("ssh.environment.target.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    yield* Effect.logDebug("ssh.environment.runner.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      ...sshRunnerLogFields(runner),
      key,
    });
    return yield* withTargetLock(
      key,
      Effect.gen(function* () {
        const entry = yield* ensureTunnelEntry(key, resolvedTarget, runner);

        const pairingResult = requestOptions?.issuePairingToken
          ? yield* runWithSshAuth({
              key,
              target: entry.target,
              operation: (authOptions) =>
                issueRemotePairingToken(entry.target, authOptions, runner),
            })
          : null;
        const pairingToken = pairingResult?.credential ?? null;

        yield* Effect.logInfo("ssh.environment.ensure.succeeded", {
          ...sshTargetLogFields(entry.target),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
          remoteServerKind: entry.remoteServerKind,
          issuedPairingToken: pairingToken !== null,
        });
        return {
          target: entry.target,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
        };
      }),
    );
  });

  const disconnectEnvironment = Effect.fn("ssh/tunnel.disconnectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logInfo("ssh.environment.disconnect.start", sshTargetLogFields(target));
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    yield* withTargetLock(
      key,
      Effect.gen(function* () {
        const entry = tunnels.get(key) ?? null;
        yield* Effect.logDebug("ssh.environment.disconnect.targetResolved", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          hasTunnel: entry !== null,
        });
        if (entry !== null) {
          // Remove this entry before closure; an owner stops explicitly below.
          yield* Effect.gen(function* () {
            tunnels.delete(key);
            yield* closeTunnelEntry(entry);
          }).pipe(Effect.uninterruptible);
        }
        if (options.leaveRemoteServerRunning !== true) {
          yield* runWithSshAuth({
            key,
            target: resolvedTarget,
            operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
          });
        }
        yield* Effect.logInfo("ssh.environment.disconnect.succeeded", {
          ...sshTargetLogFields(resolvedTarget),
          key,
        });
      }),
    );
  });

  const resolveManagedTarget = Effect.fn("ssh/tunnel.resolveManagedTarget")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    return { resolvedTarget, key: targetConnectionKey(resolvedTarget) };
  });

  const issueMcpClientSession = Effect.fn("ssh/tunnel.issueMcpClientSession")(function* (
    target: DesktopSshEnvironmentTarget,
    sessionOptions: RemoteMcpClientSessionOptions,
  ): Effect.fn.Return<
    RemoteMcpClientSession,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const { resolvedTarget, key } = yield* resolveManagedTarget(target);
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    // The session script may write the runner, so it waits for a launch in flight.
    return yield* withTargetLock(
      key,
      runWithSshAuth({
        key,
        target: resolvedTarget,
        operation: (authOptions) =>
          issueRemoteMcpClientSession(resolvedTarget, sessionOptions, authOptions, runner),
      }),
    );
  });

  const runRemoteScript = Effect.fn("ssh/tunnel.runRemoteScript")(function* (
    target: DesktopSshEnvironmentTarget,
    input: { readonly script: string; readonly timeoutMs?: number },
  ): Effect.fn.Return<
    { readonly stdout: string; readonly stderr: string },
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const { resolvedTarget, key } = yield* resolveManagedTarget(target);
    return yield* runWithSshAuth({
      key,
      target: resolvedTarget,
      operation: (authOptions) =>
        runSshCommand(resolvedTarget, {
          remoteCommandArgs: ["sh", "-s"],
          stdin: input.script,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(authOptions.authSecret === undefined ? {} : { authSecret: authOptions.authSecret }),
          ...(authOptions.batchMode === undefined ? {} : { batchMode: authOptions.batchMode }),
          ...(authOptions.interactiveAuth === undefined
            ? {}
            : { interactiveAuth: authOptions.interactiveAuth }),
        }),
    });
  });

  return SshEnvironmentManager.of({
    ensureEnvironment,
    disconnectEnvironment,
    issueMcpClientSession,
    runRemoteScript,
  });
});

/**
 * @effect-expect-leaking ChildProcessSpawner | Crypto | FileSystem | HttpClient | NetService | Path | SshPasswordPrompt
 */
export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@t3tools/ssh/tunnel/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}
