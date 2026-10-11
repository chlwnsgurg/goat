import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { remoteStateKey } from "./command.ts";
import { SshCommandError, SshLaunchError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";
import baseline from "./fixtures/remote-runner-baseline.json" with { type: "json" };

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
// Protocol-only cases explicitly select the mirror compatibility path.
const PROTOCOL_ARCHIVE = { ...ARCHIVE, releaseBaseUrl: "https://example.invalid/mirror" };
const NODE_SCRIPT = {
  nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
} as const;

const uploadTarget = {
  alias: "devbox",
  hostname: "devbox.example.com",
  username: "julius",
  port: 2222,
} as const;
const platform = HostProcess.Platform.defaultValue() === "darwin" ? "darwin" : "linux";
const arch = HostProcess.Architecture.defaultValue() === "arm64" ? "arm64" : "x64";
const encoder = new TextEncoder();

const makeUploadFixture = Effect.fn("test.makeUploadFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preparation-" });
  const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
  const stage = `${root}/stage/${stem}`;
  const directory = `${root}/mirror/v${ARCHIVE.archiveVersion}`;
  yield* fs.makeDirectory(stage, { recursive: true });
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(
    `${stage}/goat`,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo goat v${ARCHIVE.archiveVersion}; else exit 2; fi\n`,
  );
  yield* fs.chmod(`${stage}/goat`, 0o700);
  const child = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", `${directory}/${stem}.tar.gz`, "-C", `${root}/stage`, stem]),
  );
  assert.equal(yield* child.exitCode, 0);
  const bytes = yield* fs.readFile(`${directory}/${stem}.tar.gz`);
  const crypto = yield* Crypto.Crypto;
  const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes));
  yield* fs.writeFileString(`${directory}/SHA256SUMS`, `${sha256}  ${stem}.tar.gz\n`);
  return { root, directory, bytes, sha256, spawner, fs };
});

const recordSpans = (spans: Tracer.Span[]) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });

// These transport-only tests model an installed exact requested archive.
const makeProtocolTestSpawner = (spawn: Parameters<typeof ChildProcessSpawner.make>[0]) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
      if (
        stdin !== undefined &&
        typeof stdin === "object" &&
        "stream" in stdin &&
        Stream.isStream(stdin.stream)
      ) {
        const bytes = yield* stdin.stream.pipe(Stream.runCollect);
        const script = new TextDecoder().decode(
          new Uint8Array(bytes.flatMap((chunk) => Array.from(chunk))),
        );
        if (script.includes("ready=false"))
          return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: true }));
        if (command._tag === "StandardCommand")
          return yield* spawn({
            ...command,
            options: {
              ...command.options,
              stdin: { ...stdin, stream: Stream.fromIterable(bytes) },
            },
          });
      }
      return yield* spawn(command);
    }),
  );

// Vite reformats Function.toString(); persistent script bytes use native Node.
const nativeScripts = Effect.fn("test.nativeScripts")(function* (
  input: SshTunnel.RemoteT3RunnerOptions,
  selection?: SshTunnel.PreparedRemoteRuntime,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const moduleUrl = new URL("./tunnel.ts", import.meta.url).href;
  const script = `import * as t from ${JSON.stringify(moduleUrl)};
const input = ${JSON.stringify(input)};
const selection = ${JSON.stringify(selection)};
console.log(JSON.stringify({ runner: t.buildRemoteT3RunnerScript(input), launch: t.buildRemoteLaunchScript(input, selection), pairing: t.buildRemotePairingScript("711bc738002d72fd", input, selection), mcp: t.buildRemoteMcpSessionScript("711bc738002d72fd", { label: "fixture", ttl: "1h", runtimeModeCeiling: null }, input, selection), probe: t.buildRemoteRuntimeProbeScript(input.archiveVersion ?? "", "711bc738002d72fd", true), upload: input.nodeScriptPath ? null : t.buildRemoteT3UploadInstallerScript(input, "A".repeat(64)) }));`;
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["--input-type=module", "-e", script]),
  );
  const result = yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      code: child.exitCode,
    },
    { concurrency: "unbounded" },
  );
  assert.equal(result.code, 0, result.stderr);
  const scripts = JSON.parse(result.stdout) as {
    runner: string;
    launch: string;
    pairing: string;
    mcp: string;
    upload: string | null;
    probe: string;
  };
  for (const entry of ["launch", "pairing", "mcp", "probe"] as const)
    assert.notMatch(scripts[entry], /@@T3_[A-Z_]+@@/);
  return scripts;
});

// Archive doubles are Node scripts; emulate archive ps output only for the captured seed child.
const installArchivePsDouble = Effect.fn("test.installArchivePsDouble")(function* (
  home: string,
  pid: number,
  port: number,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bin = `${home}/.test/identity-bin`;
  yield* fs.makeDirectory(bin, { recursive: true });
  yield* fs.writeFileString(
    `${bin}/ps`,
    `#!/bin/sh
if [ "$1 $2 $3 $4" = '-o command= -p ${pid}' ]; then
  printf '%s\\n' "$HOME/.goat/runtime/goat/versions/${version}/goat serve --host 127.0.0.1 --port ${port} --base-dir $HOME/.goat"
else
  exec /bin/ps "$@"
fi
`,
  );
  yield* fs.chmod(`${bin}/ps`, 0o700);
});

describe("ssh tunnel scripts", () => {
  it.effect("preserves ordinary runner, launch and pairing script bytes", () =>
    Effect.gen(function* () {
      const inputs = {
        archive: ARCHIVE,
        mirror: { ...ARCHIVE, releaseBaseUrl: "https://example.invalid/mirror/" },
        node: { nodeScriptPath: "/fixture/cli entry.mjs", nodeEngineRange: TEST_NODE_ENGINE_RANGE },
      };
      for (const key of ["archive", "mirror", "node"] as const) {
        for (const input of [
          inputs[key],
          { ...inputs[key], archiveDirectory: "/fixture/archives" },
          { ...inputs[key], bundledArchiveDirectory: "/fixture/bundle" },
          {
            ...inputs[key],
            archiveDirectory: "/fixture/archives",
            bundledArchiveDirectory: "/fixture/bundle",
          },
        ]) {
          const actual = yield* nativeScripts(input);
          assert.equal(actual.runner, baseline[key].runner);
          assert.equal(actual.launch, baseline[key].launch);
          assert.equal(actual.pairing, baseline[key].pairing);
        }
        if (key === "node") continue;
        const ordinary = baseline[key].runner;
        const start = ordinary.indexOf(
          '  t3_fetch "$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS"',
        );
        const end = ordinary.indexOf("  if command -v sha256sum >/dev/null 2>&1; then");
        const upload = (yield* nativeScripts(inputs[key])).upload!;
        assert.equal(upload.slice(0, start), ordinary.slice(0, start));
        assert.equal(
          upload.slice(upload.indexOf("  if command -v sha256sum >/dev/null 2>&1; then")),
          ordinary.slice(end),
        );
        assert.include(upload, `T3_EXPECTED='${"a".repeat(64)}'`);
        assert.equal((yield* nativeScripts(inputs[key])).runner, ordinary);
      }
      assert.throws(
        () => SshTunnel.buildRemoteT3UploadInstallerScript(inputs.node, "a".repeat(64)),
        SshLaunchError,
      );
      assert.throws(
        () => SshTunnel.buildRemoteT3UploadInstallerScript({}, "a".repeat(64)),
        SshLaunchError,
      );
      assert.throws(
        () => SshTunnel.buildRemoteT3UploadInstallerScript(ARCHIVE, "no"),
        SshLaunchError,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("preserves literal shell PIDs through every nested script builder", () =>
    Effect.gen(function* () {
      const lockOwner = `printf '%s\\n' "$$" > "$T3_LOCK/pid.tmp"`;
      for (const input of [
        ARCHIVE,
        { ...ARCHIVE, releaseBaseUrl: "https://example.invalid/mirror/" },
        { nodeScriptPath: "/fixture/cli entry.mjs", nodeEngineRange: TEST_NODE_ENGINE_RANGE },
      ]) {
        const generated = yield* nativeScripts(input);
        for (const field of ["runner", "launch", "pairing", "mcp"] as const) {
          assert.include(generated[field], lockOwner, field);
          assert.notInclude(generated[field], `printf '%s\\n' "$" > "$T3_LOCK/pid.tmp"`, field);
        }
        for (const field of ["launch", "pairing", "mcp"] as const) {
          assert.include(generated[field], 'RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"', field);
          const nested = generated[field].split("<<'SH'\n")[1]!.split("\nSH\n")[0]!;
          assert.equal(nested, generated.runner, field);
        }
        if (generated.upload !== null) assert.include(generated.upload, lockOwner);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("inserts dollar metacharacters literally in nested quoted runner paths", () =>
    Effect.gen(function* () {
      const generated = yield* nativeScripts({ nodeScriptPath: "/fixture/dollar $$ $& entry.mjs" });
      for (const field of ["runner", "launch", "pairing", "mcp"] as const) {
        assert.include(generated[field], "T3_NODE_SCRIPT_PATH='/fixture/dollar $$ $& entry.mjs'");
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("installs and runs the release archive without Node, npm, or npx", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);

    assert.include(script, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "T3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'",
    );
    assert.include(
      script,
      'T3_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION"',
    );
    assert.include(script, 'T3_ARCHIVE="goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
    assert.include(script, "SHA256SUMS");
    assert.include(script, 'exec "$T3_RUNTIME_DIR/goat" "$@"');
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "t3@latest");
    assert.notInclude(script, 'exec t3 "$@"');
    // Concurrent launches serialize on a per-version mkdir lock and recheck
    // the completion marker after acquiring it.
    assert.include(
      script,
      'T3_LOCK="$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock"',
    );
    // mkdir is the exclusive create; the pid follows atomically. A dead owner
    // is reclaimed at once, a never-published owner after a short grace.
    assert.include(script, 'while ! mkdir "$T3_LOCK" 2>/dev/null; do');
    assert.include(script, 'mv "$T3_LOCK/pid.tmp" "$T3_LOCK/pid"');
    assert.include(script, 'if ! kill -0 "$T3_LOCK_OWNER" 2>/dev/null; then');
    assert.include(script, 'if [ "$T3_LOCK_UNOWNED" -ge 5 ]; then');
    assert.include(script, 'if [ "$T3_LOCK_WAITED" -ge 360 ]; then');
    assert.include(script, '"$T3_STAGING/SHA256SUMS" 30');
    assert.include(script, '"$T3_STAGING/$T3_ARCHIVE" 240');
    assert.notInclude(script, "T3_LOCK_CANDIDATE");
    assert.notInclude(script, "-mmin");
    assert.equal(script.split("if ! t3_runtime_ready; then").length - 1, 2);
    assert.isBelow(
      script.indexOf('"$T3_STAGING/goat" --version'),
      script.indexOf('> "$T3_STAGING/.install-complete"'),
    );
    // Node discovery is defined for the dev path but only ever invoked inside
    // the node-script branch, which the archive path skips entirely.
    assert.equal(script.split("ensure_remote_node_path || true").length - 1, 1);
    assert.isBelow(
      script.indexOf("ensure_remote_node_path || true"),
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
    );
    assert.isBelow(
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
      script.indexOf("T3_ARCHIVE_VERSION="),
    );

    const launch = SshTunnel.buildRemoteLaunchScript({
      ...ARCHIVE,
      releaseBaseUrl: "https://mirror.example/goat/",
    });
    assert.include(launch, "T3_ARCHIVE_MODE=1");
    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/goat'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    assert.include(launch, "__ssh-helper protocol --runtime-file");
    assert.include(SshTunnel.buildRemoteLaunchScript(NODE_SCRIPT), "T3_ARCHIVE_MODE=0");
  });

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it("refuses to build a runner with neither an archive version nor a node script", () => {
    for (const input of [undefined, {}, { archiveVersion: "  " }, { nodeScriptPath: null }]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript(input),
        SshTunnel.SshMissingRunnerError,
      );
    }
    assert.throws(() => SshTunnel.buildRemoteLaunchScript(), SshTunnel.SshMissingRunnerError);
  });

  it("does not hard-code a remote node engine range", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(NODE_SCRIPT);

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
    assert.include(script, "T3_ARCHIVE_VERSION=''");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "/home/linuxbrew/.linuxbrew/bin"');
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
    assert.notInclude(script, "npx");
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const stateKey = "711bc738002d72fd";
    const launch = SshTunnel.buildRemoteLaunchScript(ARCHIVE);
    const devLaunch = SshTunnel.buildRemoteLaunchScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(launch, '[ "$LIVE_STATUS" = live ] && valid_positive "$LIVE_PID"');
    assert.include(launch, "RUNNER_CHANGED=1");
    assert.include(launch, "ensure_remote_node_path()");
    assert.include(launch, "ensure_remote_node_path || true");
    assert.include(devLaunch, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(devLaunch, "does not satisfy required range ");
    assert.include(launch, 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(launch, "wait_ready");
    assert.include(launch, '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(launch, '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(launch, "server-home");
    assert.include(launch, "Remote T3 server did not become ready");
    assert.include(launch, 'wait_ready "60000"');
    assert.include(launch, 'if [ -s "$LOG_FILE" ]; then');
    assert.include(launch, "It wrote nothing to %s");
    assert.include(launch, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"',
    );
    assert.notInclude(SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE), "server-home");
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'if [ "$REMOTE_MANAGED" = managed ] && [ -n "$REMOTE_PID" ]; then',
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'kill "$REMOTE_PID" 2>/dev/null || true',
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"',
    );
    assert.include(
      launch,
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(launch, "check_live_protocol()");
    assert.include(launch, 'PID_TO_STOP="$LIVE_PID"');
    assert.include(launch, 'REMOTE_PORT="$LIVE_PORT"');
    assert.include(launch, 'rm -f "$PID_FILE"');
    assert.include(launch, "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(launch, 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      launch.indexOf("check_live_protocol\n"),
      launch.indexOf('mv "$RUNNER_NEXT" "$RUNNER_FILE"'),
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = makeProtocolTestSpawner((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(
        target,
        undefined,
        PROTOCOL_ARCHIVE,
      );
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = makeProtocolTestSpawner(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        SshTunnel.launchOrReuseRemoteServer(target, undefined, NODE_SCRIPT),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("gives cold archive launches a larger budget than node-script launches", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = makeProtocolTestSpawner(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 800_000)),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        SshTunnel.launchOrReuseRemoteServer(target, undefined, PROTOCOL_ARCHIVE),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(800));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(SshTunnel.REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          SshTunnel.waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      SshTunnel.describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = makeProtocolTestSpawner((command) =>
      Effect.gen(function* () {
        const input = command._tag === "StandardCommand" ? command.options.stdin : undefined;
        const bytes =
          input !== undefined &&
          typeof input === "object" &&
          "stream" in input &&
          Stream.isStream(input.stream)
            ? yield* input.stream.pipe(Stream.runCollect)
            : [];
        const script = new TextDecoder().decode(
          new Uint8Array(bytes.flatMap((chunk) => Array.from(chunk))),
        );
        if (script.includes("ready=false")) {
          return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: true }));
        }
        return makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`);
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, PROTOCOL_ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = makeProtocolTestSpawner((command) =>
      Effect.gen(function* () {
        const input = command._tag === "StandardCommand" ? command.options.stdin : undefined;
        const bytes =
          input !== undefined &&
          typeof input === "object" &&
          "stream" in input &&
          Stream.isStream(input.stream)
            ? yield* input.stream.pipe(Stream.runCollect)
            : [];
        const script = new TextDecoder().decode(
          new Uint8Array(bytes.flatMap((chunk) => Array.from(chunk))),
        );
        if (script.includes("ready=false")) {
          return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: true }));
        }
        return makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`);
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, PROTOCOL_ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.each(["successful reconnect", "failed reconnect"] as const)(
    "stale local forward never stops the remote during %s",
    (mode) =>
      Effect.gen(function* () {
        let forwards = 0;
        let kills = 0;
        let launches = 0;
        let stops = 0;
        let remoteRunning = true;
        let stale = false;
        const probeStarted = yield* Deferred.make<void>();
        const spawner = makeProtocolTestSpawner((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G"))
              return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
            if (args.includes("-N")) {
              forwards++;
              return makeRunningProcess(() => {
                kills++;
              });
            }
            if (args.includes("--")) {
              launches++;
              if (launches === 2 && mode === "failed reconnect")
                return {
                  ...makeSuccessfulProcess(""),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                  stderr: Stream.make(encoder.encode("Cannot prepare requested GOAT version")),
                };
              stale = false;
              return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}');
            }
            if (args.includes("sh")) {
              stops++;
              remoteRunning = false;
              return makeSuccessfulProcess('{"stopped":true}');
            }
            return makeSuccessfulProcess("");
          }),
        );
        const client = HttpClient.make((request) =>
          stale
            ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("", { status: 200 })),
              ),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          stale = true;
          const reconnect = yield* Effect.forkChild(
            Effect.result(manager.ensureEnvironment(uploadTarget)),
          );
          yield* Deferred.await(probeStarted);
          yield* TestClock.adjust(Duration.seconds(2));
          const result = yield* Fiber.join(reconnect);
          assert.equal(kills, 1);
          assert.equal(stops, 0);
          assert.isTrue(remoteRunning);
          assert.equal(forwards, mode === "successful reconnect" ? 2 : 1);
          assert.equal(launches, 2);
          assert.equal(Result.isSuccess(result), mode === "successful reconnect");
          // Disconnect remains an explicit remote-stop operation, including
          // when reconnection failed and no map entry remains.
          yield* manager.disconnectEnvironment(uploadTarget);
          assert.equal(stops, 1);
        }).pipe(Effect.provide(layer), Effect.scoped);
        assert.equal(stops, 1);
      }),
  );

  it.effect.each(["successful stop", "failed stop"] as const)(
    "closes the tunnel scope and starts fresh after a %s",
    (mode) => {
      const spawnedCommands: Array<ReadonlyArray<string>> = [];
      let tunnelKillCount = 0;
      let stopCommandCount = 0;
      const spawner = makeProtocolTestSpawner((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          spawnedCommands.push(args);
          if (args.includes("-N")) {
            return makeRunningProcess(() => {
              tunnelKillCount += 1;
            });
          }
          if (args.includes("sh") && args.includes("--")) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("sh")) {
            stopCommandCount += 1;
            if (mode === "failed stop" && stopCommandCount === 1) {
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(
                  new TextEncoder().encode("Remote T3 server did not stop within 2 seconds.\n"),
                ),
              };
            }
            return makeSuccessfulProcess('{"stopped":true}\n');
          }
          return makeSuccessfulProcess("\n");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
        }),
      );
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;

      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;

        const first = yield* manager.ensureEnvironment(target);
        assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
        const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
        assert.isDefined(firstTunnelArgs);
        assert.include(firstTunnelArgs, "ControlMaster=no");
        assert.include(firstTunnelArgs, "ControlPath=none");
        assert.include(firstTunnelArgs, "ControlPersist=no");

        const disconnected = yield* Effect.result(manager.disconnectEnvironment(target));
        if (mode === "failed stop") {
          assert.isTrue(Result.isFailure(disconnected));
          if (Result.isFailure(disconnected)) {
            assert.instanceOf(disconnected.failure, SshCommandError);
            assert.equal(
              disconnected.failure.message,
              "Remote T3 server did not stop within 2 seconds.",
            );
          }
        } else {
          assert.isTrue(Result.isSuccess(disconnected));
        }
        assert.equal(tunnelKillCount, 1);
        assert.equal(stopCommandCount, 1);

        if (mode === "failed stop") {
          yield* manager.disconnectEnvironment(target);
          assert.equal(tunnelKillCount, 1);
          assert.equal(stopCommandCount, 2);
        }

        yield* manager.ensureEnvironment(target);

        assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
        assert.equal(tunnelKillCount, 1);
      }).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.andThen(
          Effect.sync(() => {
            assert.equal(tunnelKillCount, 2);
            assert.equal(stopCommandCount, mode === "failed stop" ? 3 : 2);
          }),
        ),
      );
    },
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = makeProtocolTestSpawner((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.includes("--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

describe("runtime preparation", () => {
  it.live.each([
    { entry: "launch", mode: "ready" },
    { entry: "mcp", mode: "ready" },
    { entry: "launch", mode: "missing" },
    { entry: "mcp", mode: "missing" },
    { entry: "launch", mode: "dev" },
    { entry: "mcp", mode: "dev" },
    { entry: "launch", mode: "none" },
    { entry: "mcp", mode: "none" },
    { entry: "launch", mode: "invalid" },
    { entry: "mcp", mode: "invalid" },
    { entry: "pairing", mode: "ready" },
    { entry: "pairing", mode: "missing" },
    { entry: "pairing", mode: "dev" },
    { entry: "pairing", mode: "none" },
    { entry: "pairing", mode: "invalid" },
    { entry: "pairing", mode: "upstream-only" },
    { entry: "pairing", mode: "marker-only" },
    { entry: "pairing", mode: "non-executable" },
    { entry: "pairing", mode: "wrong-marker" },
    { entry: "launch", mode: "upstream-only" },
    { entry: "mcp", mode: "upstream-only" },
    { entry: "launch", mode: "marker-only" },
    { entry: "mcp", mode: "marker-only" },
    { entry: "launch", mode: "non-executable" },
    { entry: "mcp", mode: "non-executable" },
    { entry: "launch", mode: "wrong-marker" },
    { entry: "mcp", mode: "wrong-marker" },
  ] as const)("$entry preparation with retained runtime=$mode", ({ entry, mode }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-retained-preparation-" });
      const stateKey = yield* remoteStateKey(uploadTarget);
      const state = `${root}/.goat/ssh-launch/${stateKey}`;
      const retainedVersion = mode === "invalid" ? "01.2.3" : "1.2.2-preview.20260910.1";
      const retainedScript =
        mode === "dev"
          ? "#!/bin/sh\nT3_NODE_SCRIPT_PATH='/fixture/dev entry.mjs'\n"
          : `#!/bin/sh\nT3_NODE_SCRIPT_PATH=''\nT3_ARCHIVE_VERSION='${retainedVersion}'\n`;
      if (mode !== "none") {
        yield* fs.makeDirectory(state, { recursive: true });
        yield* fs.writeFileString(`${state}/run-t3.sh`, retainedScript);
        yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
      }
      const upstream = `${root}/.t3/runtime/versions/${retainedVersion}`;
      if (mode === "upstream-only") {
        yield* fs.makeDirectory(upstream, { recursive: true });
        yield* fs.writeFileString(`${upstream}/t3`, "#!/bin/sh\nexit 97\n");
        yield* fs.chmod(`${upstream}/t3`, 0o700);
        yield* fs.writeFileString(`${upstream}/.install-complete`, retainedVersion);
      }
      if (
        mode === "ready" ||
        mode === "marker-only" ||
        mode === "non-executable" ||
        mode === "wrong-marker"
      ) {
        const runtime = `${root}/.goat/runtime/goat/versions/${retainedVersion}`;
        yield* fs.makeDirectory(runtime, { recursive: true });
        if (mode !== "marker-only") {
          yield* fs.writeFileString(
            `${runtime}/goat`,
            `#!/bin/sh
if [ "$1" = --version ]; then printf 'goat v${retainedVersion}\\n';
elif [ "$2" = protocol ]; then
  case " $* " in *" --runtime-file "*) printf 'none unknown unknown unknown 0 0\\n';; *) printf '${retainedVersion} 1 2 0 0\\n';; esac
else exit 2; fi
`,
          );
          yield* fs.chmod(`${runtime}/goat`, mode === "non-executable" ? 0o600 : 0o700);
        }
        yield* fs.writeFileString(
          `${runtime}/.install-complete`,
          mode === "wrong-marker" ? ARCHIVE.archiveVersion : retainedVersion,
        );
      }
      const archiveDirectory = `${root}/missing-cache`;
      const calls: string[] = [];
      const spans: Tracer.Span[] = [];
      let cacheReads = 0;
      const checkedFs = FileSystem.FileSystem.of({
        ...fs,
        exists: (file) => {
          if (file.startsWith(archiveDirectory)) cacheReads++;
          return fs.exists(file);
        },
        readFile: (file) => {
          if (file.startsWith(archiveDirectory)) cacheReads++;
          return fs.readFile(file);
        },
      });
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          assert.equal(command._tag, "StandardCommand");
          if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
          if (command.command === "gh") {
            calls.push("gh");
            return {
              ...makeSuccessfulProcess(""),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            };
          }
          const input = command.options.stdin;
          const chunks =
            input !== undefined &&
            typeof input === "object" &&
            "stream" in input &&
            Stream.isStream(input.stream)
              ? yield* input.stream.pipe(Stream.runCollect)
              : [];
          const data = new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk)));
          if (command.args.includes("-c")) {
            calls.push("upload");
            assert.include(command.args.join(" "), ARCHIVE.archiveVersion);
            return makeSuccessfulProcess("");
          }
          if (new TextDecoder().decode(data).includes("ready=false")) {
            calls.push("probe");
            // Execute the real probe against the isolated remote HOME.
            return yield* realSpawner.spawn(
              ChildProcess.make("sh", ["-s"], {
                env: { HOME: root },
                stdin: Stream.make(data),
              }),
            );
          }
          calls.push(entry);
          return makeSuccessfulProcess(
            entry === "launch"
              ? '{"remotePort":3773,"serverKind":"managed"}'
              : entry === "pairing"
                ? '{"credential":"fixture-pairing"}'
                : 'T3_CEILING=default\n{"token":"fixture-session","expiresAt":null}',
          );
        }),
      );
      const runner = {
        ...ARCHIVE,
        archiveDirectory,
        keepExistingRunner: true,
        ...(mode !== "ready" ? { releaseBaseUrl: "https://mirror.example/goat" } : {}),
      };
      const invocation =
        entry === "launch"
          ? SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner).pipe(Effect.asVoid)
          : entry === "pairing"
            ? SshTunnel.issueRemotePairingToken(uploadTarget, {}, runner).pipe(Effect.asVoid)
            : SshTunnel.issueRemoteMcpClientSession(
                uploadTarget,
                {
                  ttl: "1h",
                  label: "fixture",
                  runtimeModeCeiling: null,
                },
                {},
                runner,
              ).pipe(Effect.asVoid);
      const result = yield* Effect.result(
        invocation.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, checkedFs),
          Effect.withTracer(recordSpans(spans)),
        ),
      );
      assert.isTrue(Result.isSuccess(result));
      assert.deepEqual(calls, ["probe", entry]);
      assert.equal(
        spans
          .find((span) => span.name === "ssh.prepareRemoteRuntime")
          ?.attributes.get("t3.runtime.source"),
        mode === "ready" ? "retained-runner" : "download",
      );
      assert.equal(yield* fs.exists(archiveDirectory), false);
      if (mode === "ready") assert.equal(cacheReads, 0);
      else assert.isAbove(cacheReads, 0);
      if (mode !== "none")
        assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), retainedScript);
      if (mode === "upstream-only")
        assert.equal(yield* fs.readFileString(`${upstream}/t3`), "#!/bin/sh\nexit 97\n");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("does not restart an existing managed server after runtime preparation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-preparation-" });
      const runtime = `${root}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}`;
      const state = `${root}/.goat/ssh-launch/711bc738002d72fd`;
      yield* fs.makeDirectory(runtime, { recursive: true });
      yield* fs.makeDirectory(state, { recursive: true });
      const cli = `${runtime}/goat`;
      yield* fs.writeFileString(
        cli,
        `#!${process.execPath}
import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("goat v${ARCHIVE.archiveVersion}"); }
else if (args[0] === "__ssh-helper") {
  if (args[1] === "protocol") {
    if (!args.includes("--runtime-file")) console.log("${ARCHIVE.archiveVersion} 1 2 0 0");
    else {
            const at = args.indexOf("--runtime-file");
      const value = await (await import(${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)})).readLiveSshRuntimeProtocol(args[at+1]);
      console.log((value.status+" ") + [value.serverVersion ?? "unknown",value.sshRuntimeProtocolVersion ?? "unknown",value.orchestrationProtocolVersion ?? "unknown",value.pid ?? 0,value.port ?? 0].join(" "));
    }
  }
  if (args[1] === "runtime-port") process.exit(1);
  if (args[1] === "pick-port") console.log(3773);
  if (args[1] === "wait-ready") {
    const request = http.get("http://127.0.0.1:"+args[2]+"/",response=>{response.resume();response.on("end",()=>process.exit(0));});
    request.on("error",()=>process.exit(1));
  }
} else if (args[0] === "auth") { console.log(JSON.stringify({ credential: "fixture-pairing" })); }
else {
  fs.appendFileSync("${root}/starts", "start\\n");
  const fields = {serverVersion:"${ARCHIVE.archiveVersion}",sshRuntimeProtocolVersion:1,orchestrationProtocolVersion:2};
  const server = http.createServer((request,response) => response.end(request.url === "/.well-known/t3/environment" ? JSON.stringify({environmentId:"fixture",label:"Fixture",platform:{os:"linux",arch:"x64"},capabilities:{},...fields}) : "ok"));
  process.on("SIGTERM", () => { fs.appendFileSync("${root}/stops", "stop\\n"); server.close(); });
  server.listen(0, "127.0.0.1", () => {
    const record = {version:1,startedAt:"2026-10-11T00:00:00.000Z",...fields,pid:process.pid,port:server.address().port,origin:"http://127.0.0.1:"+server.address().port};
    fs.mkdirSync("${root}/.goat/userdata",{recursive:true});fs.writeFileSync("${root}/.goat/userdata/server-runtime.json",JSON.stringify(record));
    console.log(JSON.stringify(record));
  });
}
`,
      );
      yield* fs.chmod(cli, 0o700);
      yield* fs.writeFileString(`${runtime}/.install-complete`, ARCHIVE.archiveVersion);
      const child = yield* realSpawner.spawn(
        ChildProcess.make(cli, ["serve"], { detached: false }),
      );
      yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore));
      const started = JSON.parse(
        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(1),
          Stream.mkString,
        ),
      ) as { pid: number; port: number };
      assert.equal(started.pid, child.pid);
      yield* fs.writeFileString(`${state}/pid`, `${started.pid}\n`);
      yield* fs.writeFileString(`${state}/port`, `${started.port}\n`);
      yield* fs.writeFileString(`${state}/managed`, "managed\n");
      yield* fs.writeFileString(
        `${state}/identity`,
        `${cli} serve --host 127.0.0.1 --port ${started.port} --base-dir ${root}/.goat\n`,
      );
      yield* installArchivePsDouble(root, started.pid, started.port, ARCHIVE.archiveVersion);
      // Use the persisted heredoc bytes, including existing placeholder escaping.
      const persistedRunner =
        baseline.archive.launch.split("<<'SH'\n")[1]!.split("\nSH\n")[0]! + "\n";
      yield* fs.writeFileString(`${state}/run-t3.sh`, persistedRunner);
      yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
      const scripts = yield* nativeScripts(ARCHIVE);
      let uploads = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return Effect.succeed(makeSuccessfulProcess(""));
        const args = command.args;
        if (args.includes("-c")) uploads++;
        const remoteArgs = args.slice(args.indexOf("sh") + 1).filter((arg) => arg !== "-l");
        const stdin = args.includes("--")
          ? Stream.make(encoder.encode(scripts.launch))
          : args.includes("-l")
            ? command.options.stdin
            : Stream.make(encoder.encode(scripts.pairing));
        return realSpawner.spawn(
          ChildProcess.make("sh", remoteArgs, {
            env: { HOME: root, PATH: `${root}/.test/identity-bin:${process.env.PATH ?? ""}` },
            stdin,
          }),
        );
      });
      const runner = { ...ARCHIVE, archiveDirectory: `${root}/missing` };
      yield* Effect.gen(function* () {
        const first = yield* SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner);
        assert.equal(first.remotePort, started.port);
        assert.equal(first.remoteServerKind, "managed");
        const pairing = yield* SshTunnel.issueRemotePairingToken(uploadTarget, {}, runner);
        assert.equal(pairing.credential, "fixture-pairing");
        assert.equal(
          (yield* SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner)).remotePort,
          started.port,
        );
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.equal(uploads, 0);
      assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), persistedRunner);
      assert.equal((yield* fs.readFileString(`${state}/pid`)).trim(), String(started.pid));
      assert.equal((yield* fs.readFileString(`${state}/port`)).trim(), String(started.port));
      assert.equal(yield* fs.readFileString(`${root}/starts`), "start\n");
      assert.isFalse(yield* fs.exists(`${root}/stops`));
      assert.isTrue(yield* fs.exists(`${root}/.goat/userdata/server-runtime.json`));
      assert.isTrue(yield* child.isRunning);
      yield* child.kill({ killSignal: "SIGTERM" });
      assert.equal(yield* child.exitCode, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.each([
    "uploads the local archive to a cold remote",
    "downloads from an explicit mirror when no local archive exists",
    "skips upload when the remote runtime is ready",
    "passes the same auth options to probe, upload and launch",
  ] as const)("%s", (name) =>
    Effect.gen(function* () {
      const fixture = yield* makeUploadFixture();
      const { root, directory, bytes, fs, spawner: realSpawner } = fixture;
      const ready = name === "skips upload when the remote runtime is ready";
      const missing = name === "downloads from an explicit mirror when no local archive exists";
      const archiveDirectory = missing || ready ? `${root}/missing` : directory;
      const runner = {
        ...ARCHIVE,
        archiveDirectory,
        releaseBaseUrl: missing ? `file://${root}/mirror` : "file:///unavailable",
      };
      const calls: string[] = [];
      const auth: Array<{
        secret: string | undefined;
        batch: string | undefined;
        askpass: string | undefined;
      }> = [];
      const spans: Tracer.Span[] = [];
      let reads = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          assert.equal(command._tag, "StandardCommand");
          if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
          const args = command.args;
          const kind = args.includes("-c") ? "upload" : args.includes("--") ? "launch" : "probe";
          calls.push(kind);
          auth.push({
            secret: command.options.env?.T3_SSH_AUTH_SECRET,
            batch: args.find((arg) => arg.startsWith("BatchMode=")),
            askpass: command.options.env?.SSH_ASKPASS_REQUIRE,
          });
          if (kind === "probe")
            return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready }));
          if (kind === "upload") {
            const input = command.options.stdin;
            assert.isDefined(input);
            if (
              input !== undefined &&
              typeof input === "object" &&
              "stream" in input &&
              Stream.isStream(input.stream)
            ) {
              const chunks = yield* input.stream.pipe(Stream.runCollect);
              assert.deepEqual(new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk))), bytes);
            }
            const remoteArgs = args.slice(args.indexOf("sh"));
            return yield* realSpawner.spawn(
              ChildProcess.make("sh", ["-c", remoteArgs.join(" ")], {
                env: { HOME: root },
                stdin: command.options.stdin,
              }),
            );
          }
          if (missing) {
            const installer = yield* realSpawner.spawn(
              ChildProcess.make(
                "sh",
                ["-c", SshTunnel.buildRemoteT3RunnerScript(runner), "--", "--version"],
                { env: { HOME: root } },
              ),
            );
            assert.equal(yield* installer.exitCode, 0);
          }
          return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}');
        }),
      );
      const checkedFs = FileSystem.FileSystem.of({
        ...fs,
        readFile: (file) => {
          if (file.startsWith(archiveDirectory)) reads++;
          return fs.readFile(file);
        },
      });
      yield* SshTunnel.launchOrReuseRemoteServer(
        uploadTarget,
        { authSecret: "fixture-password", batchMode: "no", interactiveAuth: true },
        runner,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, checkedFs),
        Effect.withTracer(recordSpans(spans)),
      );
      assert.deepEqual(
        calls,
        ready || missing ? ["probe", "launch"] : ["probe", "upload", "launch"],
      );
      assert.equal(reads, ready || missing ? 0 : 1);
      for (const options of auth)
        assert.deepEqual(options, {
          secret: "fixture-password",
          batch: "BatchMode=no",
          askpass: "force",
        });
      const span = spans.find((span) => span.name === "ssh.prepareRemoteRuntime");
      assert.equal(span?.attributes.get("ssh.target"), "devbox");
      assert.equal(
        span?.attributes.get("t3.runtime.source"),
        ready ? "ready" : missing ? "download" : "upload",
      );
      if (!ready && !missing) {
        assert.equal(span?.attributes.get("t3.runtime.upload.installComplete"), true);
        assert.equal(span?.attributes.get("t3.runtime.upload.sha256"), fixture.sha256);
        assert.equal(span?.attributes.get("t3.runtime.upload.bytes"), bytes.byteLength);
      }
      if (!ready)
        assert.equal(
          (yield* fs.readFileString(
            `${root}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-complete`,
          )).trim(),
          ARCHIVE.archiveVersion,
        );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("surfaces local archive preparation errors during pairing", () =>
    Effect.gen(function* () {
      const { directory, fs } = yield* makeUploadFixture();
      yield* fs.truncate(
        `${directory}/goat-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`,
        268435457,
      );
      let calls = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          calls++;
          return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: false }));
        }),
      );
      const result = yield* Effect.result(
        SshTunnel.issueRemotePairingToken(
          uploadTarget,
          {},
          { ...ARCHIVE, archiveDirectory: directory },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshLaunchError);
        assert.include(result.failure.message, ARCHIVE.archiveVersion);
        assert.include(result.failure.message, "local SSH runtime archive directory");
      }
      assert.equal(calls, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("retries upload authentication through SshEnvironmentManager", () =>
    Effect.gen(function* () {
      const { directory } = yield* makeUploadFixture();
      let uploads = 0;
      let prompts = 0;
      const calls: Array<{
        kind: string;
        batch: string | undefined;
        secret: string | undefined;
        askpass: string | undefined;
      }> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-G"))
            return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
          if (args.includes("-N")) return makeRunningProcess(() => undefined);
          if (
            args.includes("-s") &&
            !args.includes("-l") &&
            calls.some((call) => call.kind === "pairing")
          )
            return makeSuccessfulProcess('{"stopped":true}');
          const kind = args.includes("-c")
            ? "upload"
            : args.includes("--")
              ? "launch"
              : args.includes("-l")
                ? "probe"
                : "pairing";
          if (command._tag === "StandardCommand")
            calls.push({
              kind,
              batch: args.find((arg) => arg.startsWith("BatchMode=")),
              secret: command.options.env?.T3_SSH_AUTH_SECRET,
              askpass: command.options.env?.SSH_ASKPASS_REQUIRE,
            });
          if (kind === "probe")
            return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: uploads > 1 }));
          if (kind === "upload" && ++uploads === 1)
            return {
              ...makeSuccessfulProcess(""),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
              stderr: Stream.make(encoder.encode("Permission denied (publickey,password).")),
            };
          return makeSuccessfulProcess(
            kind === "launch" ? '{"remotePort":3773}' : '{"credential":"fixture-pairing"}',
          );
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshAuth.SshPasswordPrompt,
          SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: () =>
              Effect.sync(() => {
                prompts++;
                return "fixture-password";
              }),
          }),
        ),
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed({ ...ARCHIVE, archiveDirectory: directory }),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
        assert.equal(result.pairingToken, "fixture-pairing");
      }).pipe(Effect.provide(layer), Effect.scoped);
      assert.equal(prompts, 1);
      assert.equal(uploads, 2);
      assert.deepEqual(
        calls.map((call) => call.kind),
        ["probe", "upload", "probe", "upload", "launch", "pairing"],
      );
      for (const call of calls.slice(0, 2))
        assert.deepEqual(
          { batch: call.batch, secret: call.secret, askpass: call.askpass },
          { batch: "BatchMode=yes", secret: undefined, askpass: undefined },
        );
      for (const call of calls.slice(2))
        assert.deepEqual(
          { batch: call.batch, secret: call.secret, askpass: call.askpass },
          { batch: "BatchMode=no", secret: "fixture-password", askpass: "force" },
        );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

// The archive runner is generated shell; string assertions cannot prove the
// lock excludes concurrent installers. Run the real script against a tiny
// fake archive served from a file:// mirror.
describe("archive runner script", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const hostArch = HostProcess.Architecture.defaultValue();
  const windowsHost = hostPlatform === "win32";
  const archiveVersion = "1.2.3-preview.20260911.4";

  const runShell = (home: string, args: string[], bytes?: Uint8Array) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", args, {
          env: { PATH: process.env.PATH ?? "", HOME: home },
          extendEnv: false,
          ...(bytes === undefined
            ? {}
            : { stdin: { stream: Stream.make(bytes), endOnDone: true } }),
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    });

  const runRunner = (home: string, runner: string) => runShell(home, [runner, "--version"]);
  const runUpload = (home: string, script: string, bytes: Uint8Array) =>
    runShell(home, ["-c", script], bytes);

  it.effect.skipIf(windowsHost)(
    "keeps a retained GOAT runner off upstream data despite an ambient T3 home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-identity-shell-" });
        const old = path.join(home, ".t3", "userdata");
        yield* fs.makeDirectory(old, { recursive: true });
        const sentinel = path.join(old, "settings.json");
        yield* fs.writeFileString(sentinel, "upstream remains intact");
        const runtime = path.join(home, ".goat", "runtime", "goat", "versions", archiveVersion);
        yield* fs.makeDirectory(runtime, { recursive: true });
        yield* fs.writeFileString(
          path.join(runtime, "goat"),
          "#!/bin/sh\nprintf 'goat-ready\\n'\n",
        );
        yield* fs.chmod(path.join(runtime, "goat"), 0o700);
        yield* fs.writeFileString(path.join(runtime, ".install-complete"), archiveVersion);
        const scripts = yield* nativeScripts({ archiveVersion });
        const runner = path.join(home, "runner.sh");
        yield* fs.writeFileString(runner, scripts.runner);
        const result = yield* runShell(home, [
          "-c",
          'export T3CODE_HOME="$HOME/.t3"; exec sh "$1" --version',
          "identity",
          runner,
        ]);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, "goat-ready\n");
        assert.equal(yield* fs.readFileString(sentinel), "upstream remains intact");
        assert.isFalse(yield* fs.exists(path.join(home, ".t3", "runtime")));
        assert.isFalse(yield* fs.exists(path.join(home, ".t3", "ssh-launch")));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  // A fake "executable" that answers --version, packed the way the release
  // workflow packs the real archive: one top-level directory named after the
  // stem, checksummed in SHA256SUMS.
  const makeMirror = Effect.fn("makeMirror")(function* (root: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = hostPlatform === "darwin" ? "darwin" : "linux";
    const arch = hostArch === "arm64" ? "arm64" : "x64";
    const stem = `goat-${archiveVersion}-${platform}-${arch}`;
    const stage = `${root}/stage/${stem}`;
    const release = `${root}/mirror/v${archiveVersion}`;
    const script = [
      "set -eu",
      `mkdir -p '${stage}' '${release}'`,
      `printf '#!/bin/sh\\nif [ "$1" = --version ]; then echo goat v${archiveVersion}; else exit 2; fi\\n' > '${stage}/goat'`,
      `chmod +x '${stage}/goat'`,
      `tar -czf '${release}/${stem}.tar.gz' -C '${root}/stage' '${stem}'`,
      `cd '${release}' && (sha256sum '${stem}.tar.gz' 2>/dev/null || shasum -a 256 '${stem}.tar.gz') > SHA256SUMS`,
    ].join("\n");
    const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script]));
    assert.equal(Number(yield* child.exitCode), 0);
    return `file://${root}/mirror`;
  });

  it.effect.skipIf(windowsHost)(
    "uploads GOAT beside same-version upstream and repairs a marker-only cache",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const markerOnly of [false, true]) {
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-runtime-collision-" });
          yield* makeMirror(root);
          const platform = hostPlatform === "darwin" ? "darwin" : "linux";
          const arch = hostArch === "arm64" ? "arm64" : "x64";
          const bytes = yield* fs.readFile(
            `${root}/mirror/v${archiveVersion}/goat-${archiveVersion}-${platform}-${arch}.tar.gz`,
          );
          const checksum = (yield* fs.readFileString(
            `${root}/mirror/v${archiveVersion}/SHA256SUMS`,
          )).slice(0, 64);
          const upstream = `${root}/.t3/runtime/versions/${archiveVersion}`;
          yield* fs.makeDirectory(upstream, { recursive: true });
          yield* fs.writeFileString(`${upstream}/t3`, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
          yield* fs.writeFileString(`${upstream}/.install-complete`, archiveVersion);
          const runtime = `${root}/.goat/runtime/goat/versions/${archiveVersion}`;
          if (markerOnly) {
            yield* fs.makeDirectory(runtime, { recursive: true });
            yield* fs.writeFileString(`${runtime}/.install-complete`, archiveVersion);
          }
          const probe = yield* runShell(root, [
            "-c",
            SshTunnel.buildRemoteRuntimeProbeScript(archiveVersion),
          ]);
          assert.equal(probe.exitCode, 0, probe.stderr);
          assert.equal(JSON.parse(probe.stdout).ready, false);
          const result = yield* runUpload(
            root,
            SshTunnel.buildRemoteUploadScript(ARCHIVE, checksum),
            bytes,
          );
          assert.equal(result.exitCode, 0, result.stderr);
          assert.isTrue(yield* fs.exists(`${runtime}/goat`));
          assert.equal(
            (yield* fs.readFileString(`${runtime}/.install-complete`)).trim(),
            archiveVersion,
          );
          assert.equal(yield* fs.readFileString(`${upstream}/t3`), "#!/bin/sh\nexit 97\n");
          assert.equal(yield* fs.readFileString(`${upstream}/.install-complete`), archiveVersion);
          const after = yield* runShell(root, [
            "-c",
            SshTunnel.buildRemoteRuntimeProbeScript(archiveVersion),
          ]);
          assert.equal(after.exitCode, 0, after.stderr);
          assert.equal(JSON.parse(after.stdout).ready, true);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("fails on an uploaded archive checksum mismatch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-upload-bad-" });
      yield* makeMirror(root);
      const platform = hostPlatform === "darwin" ? "darwin" : "linux";
      const arch = hostArch === "arm64" ? "arm64" : "x64";
      const bytes = yield* fs.readFile(
        `${root}/mirror/v${archiveVersion}/goat-${archiveVersion}-${platform}-${arch}.tar.gz`,
      );
      const result = yield* runUpload(
        root,
        SshTunnel.buildRemoteUploadScript(
          { ...ARCHIVE, releaseBaseUrl: "file:///unavailable" },
          "0".repeat(64),
        ),
        bytes,
      );
      assert.equal(result.exitCode, 1);
      assert.include(result.stderr, "Checksum mismatch");
      assert.isFalse(
        yield* fs.exists(`${root}/.goat/runtime/goat/versions/${archiveVersion}/.install-complete`),
      );
      assert.deepEqual(yield* fs.readDirectory(`${root}/.goat/runtime/goat/versions`), []);
      assert.notInclude(result.stderr, "curl");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("installs once when two uploads race", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-upload-race-" });
      yield* makeMirror(root);
      const platform = hostPlatform === "darwin" ? "darwin" : "linux";
      const arch = hostArch === "arm64" ? "arm64" : "x64";
      const file = `${root}/mirror/v${archiveVersion}/goat-${archiveVersion}-${platform}-${arch}.tar.gz`;
      const bytes = yield* fs.readFile(file);
      const checksums = yield* fs.readFileString(`${root}/mirror/v${archiveVersion}/SHA256SUMS`);
      const script = SshTunnel.buildRemoteUploadScript(
        { ...ARCHIVE, releaseBaseUrl: "file:///unavailable" },
        checksums.slice(0, 64),
      );
      const results = yield* Effect.all(
        [runUpload(root, script, bytes), runUpload(root, script, bytes)],
        { concurrency: "unbounded" },
      );
      for (const result of results) {
        assert.equal(result.exitCode, 0, result.stderr);
        assert.include(result.stdout, `goat v${archiveVersion}`);
      }
      const versions = `${root}/.goat/runtime/goat/versions`;
      assert.deepEqual(yield* fs.readDirectory(versions), [archiveVersion]);
      assert.equal(
        (yield* fs.readFileString(`${versions}/${archiveVersion}/.install-complete`)).trim(),
        archiveVersion,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "installs once when several launches race, and reclaims stale locks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-archive-runner-" });
        const releaseBaseUrl = yield* makeMirror(root);
        const runner = `${root}/run-t3.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteT3RunnerScript({ archiveVersion, releaseBaseUrl }),
        );
        const home = `${root}/home`;
        yield* fs.makeDirectory(home, { recursive: true });

        const results = yield* Effect.all(
          [runRunner(home, runner), runRunner(home, runner), runRunner(home, runner)],
          { concurrency: "unbounded" },
        );
        for (const result of results) {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.include(result.stdout, `goat v${archiveVersion}`);
        }
        const versionsDir = `${home}/.goat/runtime/goat/versions`;
        assert.deepEqual(yield* fs.readDirectory(versionsDir), [archiveVersion]);
        assert.equal(
          (yield* fs.readFileString(`${versionsDir}/${archiveVersion}/.install-complete`)).trim(),
          archiveVersion,
        );

        // A lock left by a crashed installer (dead pid) must not block the
        // next launch, and neither must one that never published a pid.
        const lock = `${versionsDir}/.${archiveVersion}.install.lock`;
        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.makeDirectory(lock);
        yield* fs.writeFileString(`${lock}/pid`, "999999\n");
        const afterDead = yield* runRunner(home, runner);
        assert.equal(afterDead.exitCode, 0, afterDead.stderr);

        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.makeDirectory(lock);
        const afterUnowned = yield* runRunner(home, runner);
        assert.equal(afterUnowned.exitCode, 0, afterUnowned.stderr);
        assert.isFalse(yield* fs.exists(lock));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "install before runner switch",
  () => {
    const stateKey = "711bc738002d72fd";
    const oldVersion = "1.2.2-preview.20260910.1";
    const nextVersion = ARCHIVE.archiveVersion;

    const shell = Effect.fn("test.runnerSwitch.shell")(function* (
      home: string,
      script: string,
      args: string[] = [],
      pathValue: string = `${home}/.test/identity-bin:${process.env.PATH ?? ""}`,
    ) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", ["-s", "--", ...args], {
          env: { HOME: home, PATH: pathValue, LC_ALL: "C" },
          extendEnv: false,
          stdin: { stream: Stream.make(encoder.encode(script)), endOnDone: true },
        }),
      );
      return yield* Effect.all(
        {
          stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          code: child.exitCode.pipe(Effect.map(Number)),
        },
        { concurrency: "unbounded" },
      );
    });

    // Written into the old runtime and the tiny release archive. This is a
    // behavioral double for the executable, not a duplicate of the installer.
    const executable = (version: string) => `#!${process.execPath}
(async () => {
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const home = process.env.HOME;
const fixture = path.join(home, ".test");
const version = ${JSON.stringify(version)};
const config = JSON.parse(fs.readFileSync(path.join(fixture, "config.json"), "utf8"));
const state = path.join(home, ".goat/ssh-launch/${stateKey}");
const runtimeFile = path.join(home, ".goat/userdata/server-runtime.json");
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function event(type, extra = {}) {
  fs.appendFileSync(path.join(fixture, "events"), JSON.stringify({ type, version, ...extra }) + "\\n");
}
function runtime() { try { return JSON.parse(fs.readFileSync(runtimeFile, "utf8")); } catch { return null; } }
const args = process.argv.slice(2);
if (args[0] === "--version") {
  let runner = "";
  try { runner = fs.readFileSync(path.join(state, "run-t3.sh"), "utf8"); } catch {}
  const old = runtime();
  event("version", { runner, oldAlive: Boolean(old && alive(old.pid)) });
  console.log("goat v" + version);
} else if (args[0] === "__ssh-helper") {
  if (args[1] === "protocol") {
    const flag = name => {const at = args.indexOf(name); return at < 0 ? undefined : args[at+1];};
    const value = args.includes("--runtime-file") ? await (await import(${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)})).readLiveSshRuntimeProtocol(flag("--runtime-file"), flag("--port-file"), flag("--pid-file")) : {serverVersion:version,sshRuntimeProtocolVersion: version === ${JSON.stringify(nextVersion)} || config.compatible ? 1 : 99,orchestrationProtocolVersion:2};
    console.log((value.status ? value.status+" " : "") + [value.serverVersion ?? "unknown",value.sshRuntimeProtocolVersion ?? "unknown",value.orchestrationProtocolVersion ?? "unknown",value.pid ?? 0,value.port ?? 0].join(" "));
  } else if (args[1] === "runtime-port") {
    const current = runtime();
    if (!config.publishDefault || !current || !alive(current.pid)) process.exit(1);
    console.log(current.pid + " " + current.port);
  } else if (args[1] === "pick-port") {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => console.log(port));
    });
  } else if (args[1] === "wait-ready") {
    let current = runtime();
    const accepted = current && (current.pid === config.seedPid ||
      fs.existsSync(path.join(fixture, "accepted-ready-" + current.pid)));
    if (!current || !alive(current.pid) || !accepted) {
      // The new serve command writes only after listening; no test sleeps.
      const fd = fs.openSync(path.join(fixture, "ready.fifo"), "r");
      fs.readSync(fd, Buffer.alloc(32), 0, 32, null);
      fs.closeSync(fd);
      current = runtime();
      if (current) fs.writeFileSync(path.join(fixture, "accepted-ready-" + current.pid), "ready");
    }
    if (!current || Number(args[2]) !== current.port) process.exit(1);
    const request = http.get("http://127.0.0.1:" + current.port + "/", response => {
      response.resume();
      response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
    });
    request.on("error", () => process.exit(1));
  } else process.exit(2);
} else if (args[0] === "auth") {
  event("auth", { args });
  if (args[1] === "pairing") console.log(JSON.stringify({ credential: "fixture-pairing" }));
  else console.log(JSON.stringify({ token: "fixture-session", expiresAt: null }));
} else if (args[0] === "serve") {
  const requested = args.indexOf("--port");
  const port = requested < 0 ? 0 : Number(args[requested + 1]);
  const fields = {serverVersion:version,sshRuntimeProtocolVersion:version === ${JSON.stringify(nextVersion)} || config.compatible ? 1 : 99,orchestrationProtocolVersion:2};
  const server = http.createServer((request, response) => response.end(request.url === "/.well-known/t3/environment" ? JSON.stringify({environmentId:"fixture",label:"Fixture",platform:{os:"linux",arch:"x64"},capabilities:{},...fields}) : "ok"));
  process.on("SIGTERM", () => {
    event("stop");
    if (runtime()?.pid === process.pid) fs.unlinkSync(runtimeFile);
    server.close(() => process.exit(0));
  });
  server.listen(port, "127.0.0.1", () => {
    const record = { version:1, startedAt:"2026-10-11T00:00:00.000Z", ...fields, pid: process.pid, port: server.address().port,
      origin: "http://127.0.0.1:" + server.address().port };
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    fs.writeFileSync(runtimeFile, JSON.stringify(record));
    fs.appendFileSync(path.join(fixture, "pids"), process.pid + "\\n");
    const installed = fs.existsSync(path.join(state, "run-t3.sh"))
      ? fs.readFileSync(path.join(state, "run-t3.sh"), "utf8") : "";
    const marker = path.join(home, ".goat/runtime/goat/versions", version, ".install-complete");
    event("start", { installed, complete: fs.readFileSync(marker, "utf8").trim() });
    if (args.includes("--test-seed")) console.log(JSON.stringify(record));
    else {
      const fd = fs.openSync(path.join(fixture, "ready.fifo"), "w");
      fs.writeSync(fd, "ready\\n");
      fs.closeSync(fd);
    }
  });
} else process.exit(2);
})().catch(error => {console.error(error);process.exitCode=1;});
`;

    const fixture = Effect.fn("test.runnerSwitch.fixture")(function* (
      failure: "none" | "missing-release" | "bad-checksum" | "broken-executable" | "wrong-version",
      options: {
        seed?: boolean;
        identical?: boolean;
        publishDefault?: boolean;
        compatible?: boolean;
      } = {},
    ) {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-switch-" });
      const state = `${home}/.goat/ssh-launch/${stateKey}`;
      const previous = options.identical ? nextVersion : oldVersion;
      const oldRuntime = `${home}/.goat/runtime/goat/versions/${previous}`;
      const test = `${home}/.test`;
      yield* fs.makeDirectory(state, { recursive: true });
      yield* fs.makeDirectory(test, { recursive: true });
      yield* fs.writeFileString(`${test}/events`, "");
      yield* fs.writeFileString(`${test}/pids`, "");
      const upstream = `${home}/.t3/runtime/versions/${previous}`;
      yield* fs.makeDirectory(upstream, { recursive: true });
      yield* fs.writeFileString(`${upstream}/t3`, "upstream executable sentinel\n");
      yield* fs.writeFileString(`${upstream}/.install-complete`, `${previous}\n`);
      yield* fs.writeFileString(
        `${test}/config.json`,
        JSON.stringify({
          publishDefault: options.publishDefault !== false,
          compatible: options.compatible === true,
        }),
      );
      const fifo = yield* spawner.spawn(ChildProcess.make("mkfifo", [`${test}/ready.fifo`]));
      assert.equal(Number(yield* fifo.exitCode), 0);
      // Register last-created server cleanup before any server is started.
      // Every PID below is emitted by this fixture's executable, not searched.
      yield* Effect.addFinalizer(() =>
        fs.readFileString(`${test}/pids`).pipe(
          Effect.flatMap((data) =>
            Effect.sync(() => {
              for (const pid of data.trim().split("\n").filter(Boolean).map(Number)) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {
                  /* already exited */
                }
              }
            }),
          ),
          Effect.ignore,
        ),
      );
      const mirror = `file://${home}/mirror`;
      const runner = { ...ARCHIVE, releaseBaseUrl: mirror };
      let scripts = yield* nativeScripts(runner);
      const oldScripts = yield* nativeScripts({ archiveVersion: previous, releaseBaseUrl: mirror });
      let oldProcess: ChildProcessSpawner.ChildProcessHandle | null = null;
      if (options.seed !== false) {
        yield* fs.makeDirectory(oldRuntime, { recursive: true });
        yield* fs.writeFileString(`${oldRuntime}/goat`, executable(previous));
        yield* fs.chmod(`${oldRuntime}/goat`, 0o700);
        yield* fs.writeFileString(`${oldRuntime}/.install-complete`, `${previous}\n`);
        yield* fs.writeFileString(`${state}/run-t3.sh`, oldScripts.runner + "\n");
        yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
        oldProcess = yield* spawner.spawn(
          ChildProcess.make(`${oldRuntime}/goat`, ["serve", "--test-seed"], {
            env: { HOME: home, PATH: process.env.PATH ?? "" },
            extendEnv: false,
          }),
        );
        const ready = JSON.parse(
          yield* oldProcess.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.take(1),
            Stream.mkString,
          ),
        ) as { pid: number; port: number };
        assert.equal(ready.pid, oldProcess.pid);
        yield* installArchivePsDouble(home, ready.pid, ready.port, previous);
        yield* fs.writeFileString(
          `${test}/config.json`,
          JSON.stringify({
            publishDefault: options.publishDefault !== false,
            compatible: options.compatible === true,
            seedPid: ready.pid,
          }),
        );
        yield* fs.writeFileString(`${state}/pid`, `${ready.pid}\n`);
        yield* fs.writeFileString(`${state}/port`, `${ready.port}\n`);
        yield* fs.writeFileString(`${state}/managed`, "managed\n");
        yield* fs.writeFileString(
          `${state}/identity`,
          `${oldRuntime}/goat serve --host 127.0.0.1 --port ${ready.port} --base-dir ${home}/.goat\n`,
        );
      }
      const stem = `goat-${nextVersion}-${platform}-${arch}`;
      const release = `${home}/mirror/v${nextVersion}`;
      const stage = `${home}/stage/${stem}`;
      yield* fs.makeDirectory(stage, { recursive: true });
      yield* fs.makeDirectory(release, { recursive: true });
      yield* fs.writeFileString(
        `${stage}/goat`,
        failure === "broken-executable"
          ? "#!/bin/sh\nprintf 'wrong architecture\\n' >&2\nexit 95\n"
          : executable(failure === "wrong-version" ? oldVersion : nextVersion),
      );
      yield* fs.chmod(`${stage}/goat`, 0o700);
      const packed = yield* spawner.spawn(
        ChildProcess.make("tar", [
          "-czf",
          `${release}/${stem}.tar.gz`,
          "-C",
          `${home}/stage`,
          stem,
        ]),
      );
      assert.equal(Number(yield* packed.exitCode), 0);
      const crypto = yield* Crypto.Crypto;
      const sum = Hex.encode(
        yield* crypto.digest("SHA-256", yield* fs.readFile(`${release}/${stem}.tar.gz`)),
      );
      yield* fs.writeFileString(
        `${release}/SHA256SUMS`,
        `${failure === "bad-checksum" ? "0".repeat(64) : sum}  ${stem}.tar.gz\n`,
      );
      if (failure === "missing-release") yield* fs.remove(release, { recursive: true });
      const snapshot = Effect.gen(function* () {
        const files = ["run-t3.sh", "pid", "port", "managed", "identity"];
        const values: Record<string, unknown> = {};
        for (const file of files)
          if (yield* fs.exists(`${state}/${file}`)) {
            values[file] = yield* fs.readFileString(`${state}/${file}`);
          }
        if (yield* fs.exists(`${state}/run-t3.sh`)) {
          const info = yield* fs.stat(`${state}/run-t3.sh`);
          values.runnerMetadata = { ino: info.ino, mode: info.mode, mtime: info.mtime };
        }
        if (yield* fs.exists(oldRuntime)) {
          values.oldExecutable = yield* fs.readFileString(`${oldRuntime}/goat`);
          values.oldMarker = yield* fs.readFileString(`${oldRuntime}/.install-complete`);
          for (const file of ["goat", ".install-complete"]) {
            const info = yield* fs.stat(`${oldRuntime}/${file}`);
            values[`oldMetadata:${file}`] = { ino: info.ino, mode: info.mode, mtime: info.mtime };
          }
        }
        const descriptor = `${home}/.goat/userdata/server-runtime.json`;
        if (yield* fs.exists(descriptor)) values.descriptor = yield* fs.readFileString(descriptor);
        values.upstreamExecutable = yield* fs.readFileString(`${upstream}/t3`);
        values.upstreamMarker = yield* fs.readFileString(`${upstream}/.install-complete`);
        return values;
      });
      const events = fs.readFileString(`${test}/events`).pipe(
        Effect.map((data) =>
          data
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  type: string;
                  version: string;
                  runner?: string;
                  oldAlive?: boolean;
                  installed?: string;
                  complete?: string;
                },
            ),
        ),
      );
      const cleanCandidates = Effect.gen(function* () {
        assert.deepEqual(
          (yield* fs.readDirectory(state)).filter((name) => name.startsWith("run-t3.next.")),
          [],
        );
      });
      if (options.compatible) {
        const probe = yield* shell(home, scripts.probe);
        assert.equal(probe.code, 0, probe.stderr);
        const observed = JSON.parse(probe.stdout);
        assert.equal(observed.retainedSignals.sshRuntimeProtocolVersion, 1);
        const selectedRunner = { ...runner, archiveVersion: previous };
        scripts = yield* nativeScripts(selectedRunner, {
          runner: selectedRunner,
          version: previous,
          requestedVersion: nextVersion,
          source: "retained",
          requireInstalled: true,
          mayUpgradeOwnedServer: false,
          retainedRunnerSha256: observed.retainedRunnerSha256,
        });
      }
      return { home, state, runner, scripts, oldProcess, snapshot, events, cleanCandidates, fs };
    });

    it.live.each([
      "launch",
      "mcp",
      "corrupt-bundle",
      "candidate-version",
      "upload-failure",
      "cache-write-failure",
      "retained-bundle-bypass",
    ] as const)("public bundle %s preserves the install-before-switch boundary", (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture("none", {
          seed: mode !== "mcp",
          compatible: mode === "retained-bundle-bypass",
        });
        const before = yield* f.snapshot;
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const bundle = `${f.home}/packaged resources/ssh-runtime/archives`;
        const asset = `goat-${nextVersion}-${platform}-${arch}.tar.gz`;
        const source = `${f.home}/mirror/v${nextVersion}/${asset}`;
        if (mode === "candidate-version") {
          const binary = `${f.home}/stage/${asset.slice(0, -7)}/goat`;
          const script = (yield* f.fs.readFileString(binary)).replace(
            'console.log("goat v" + version);',
            `
const counter = path.join(fixture, "candidate-versions");
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(count + 1));
console.log("goat v" + (count === 0 ? version : "9.9.9"));`,
          );
          yield* f.fs.writeFileString(binary, script);
          const tar = yield* realSpawner.spawn(
            ChildProcess.make("tar", ["-czf", source, "-C", `${f.home}/stage`, asset.slice(0, -7)]),
          );
          assert.equal(Number(yield* tar.exitCode), 0);
        }
        const bytes = yield* f.fs.readFile(source);
        const crypto = yield* Crypto.Crypto;
        const hash = Hex.encode(yield* crypto.digest("SHA-256", bytes));
        yield* f.fs.makeDirectory(bundle, { recursive: true });
        yield* f.fs.writeFile(`${bundle}/${asset}`, bytes);
        const checksum = `${mode === "corrupt-bundle" || mode === "retained-bundle-bypass" ? "0".repeat(64) : hash}  ${asset}
`;
        yield* f.fs.writeFileString(`${bundle}/${asset}.sha256`, checksum);
        let downloads = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
            if (command.command === "gh") {
              downloads++;
              return makeSuccessfulProcess("");
            }
            if (
              mode === "upload-failure" &&
              command.args.some((arg) => arg.includes("T3_SSH_UPLOADED_ARCHIVE"))
            )
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(43)),
              };
            const index = command.args.indexOf("sh");
            assert.isAtLeast(index, 0);
            const args = command.args.slice(index);
            return yield* realSpawner.spawn(
              ChildProcess.make(
                "sh",
                command.args.includes("-c")
                  ? ["-c", args.join(" ")]
                  : args.slice(1).filter((arg) => arg !== "-l"),
                {
                  env: {
                    HOME: f.home,
                    PATH: `${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`,
                  },
                  extendEnv: false,
                  stdin: command.options.stdin,
                },
              ),
            );
          }),
        );
        const runner = {
          ...ARCHIVE,
          bundledArchiveDirectory: bundle,
          ...(mode === "cache-write-failure"
            ? { archiveDirectory: `${f.home}/cache-parent-file/cache` }
            : {}),
          keepExistingRunner: mode === "retained-bundle-bypass",
        };
        if (mode === "cache-write-failure") {
          yield* f.fs.remove(`${bundle}/${asset}`);
          yield* f.fs.writeFileString(
            `${f.home}/cache-parent-file`,
            "cannot create a cache below a file",
          );
        }
        const invocation =
          mode === "mcp" || mode === "retained-bundle-bypass"
            ? SshTunnel.issueRemoteMcpClientSession(
                uploadTarget,
                { label: "fixture", ttl: "1h", runtimeModeCeiling: null },
                {},
                runner,
              ).pipe(Effect.map((session) => ({ token: session.token, remotePort: 0 })))
            : SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner).pipe(
                Effect.map((server) => ({ token: "", remotePort: server.remotePort })),
              );
        const result = yield* Effect.result(
          invocation.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        );
        const failure =
          mode === "corrupt-bundle" ||
          mode === "candidate-version" ||
          mode === "upload-failure" ||
          mode === "cache-write-failure";
        assert.equal(Result.isFailure(result), failure);
        if (failure || mode === "retained-bundle-bypass") {
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
        } else if (Result.isSuccess(result)) {
          if (mode === "mcp") assert.equal(result.success.token, "fixture-session");
          else {
            assert.isAbove(result.success.remotePort, 0);
            assert.equal(Number(yield* f.oldProcess!.exitCode), 0);
          }
          assert.equal(
            (yield* f.fs.readFileString(
              `${f.home}/.goat/runtime/goat/versions/${nextVersion}/.install-complete`,
            )).trim(),
            nextVersion,
          );
        }
        yield* f.cleanCandidates;
        assert.equal(downloads, 0);
        assert.equal(yield* f.fs.readFileString(`${bundle}/${asset}.sha256`), checksum);
        if (mode !== "cache-write-failure")
          assert.deepEqual(yield* f.fs.readFile(`${bundle}/${asset}`), bytes);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a nested auth runner publishes the real shell PID as install-lock owner", () =>
      Effect.gen(function* () {
        const f = yield* fixture("none", { seed: false });
        const bin = `${f.home}/.test/bin`;
        const observed = `${f.home}/.test/lock-owners.jsonl`;
        yield* f.fs.makeDirectory(bin, { recursive: true });
        yield* f.fs.writeFileString(observed, "");
        yield* f.fs.writeFileString(
          `${bin}/curl`,
          `#!${process.execPath}
const fs = require("node:fs");
const { fileURLToPath } = require("node:url");
const home = process.env.HOME;
const lock = home + "/.goat/runtime/goat/versions/.${nextVersion}.install.lock";
const owner = fs.readFileSync(lock + "/pid", "utf8").trim();
let alive = false;
try { process.kill(Number(owner), 0); alive = true; } catch {}
fs.appendFileSync(home + "/.test/lock-owners.jsonl",
  JSON.stringify({ owner, shellPid: process.ppid, alive }) + "\\n");
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith("file://"));
const output = args[args.indexOf("-o") + 1];
fs.copyFileSync(fileURLToPath(url), output);
`,
        );
        yield* f.fs.chmod(`${bin}/curl`, 0o700);
        const result = yield* shell(
          f.home,
          f.scripts.pairing,
          [],
          `${bin}:${process.env.PATH ?? ""}`,
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).credential, "fixture-pairing");
        const records = (yield* f.fs.readFileString(observed))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { owner: string; shellPid: number; alive: boolean });
        assert.equal(records.length, 2); // checksum and archive downloads
        for (const record of records) {
          assert.match(record.owner, /^[1-9][0-9]*$/);
          assert.equal(Number(record.owner), record.shellPid);
          assert.isTrue(record.alive);
        }
        assert.equal(records[0]!.owner, records[1]!.owner);
        assert.isFalse(
          yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/.${nextVersion}.install.lock`),
        );
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a Node dev runner succeeds without matching an archive version", () =>
      Effect.gen(function* () {
        const f = yield* fixture("missing-release", { seed: false });
        const devScript = `${f.home}/.test/dev.mjs`;
        yield* f.fs.writeFileString(
          devScript,
          `
if (process.argv[2] === "--version") console.log("dev build without archive version");
else if (process.argv[2] === "__ssh-helper" && process.argv[3] === "protocol") console.log(process.argv.includes("--runtime-file") ? "none unknown unknown unknown 0 0" : "1.2.3 1 2 0 0");
else if (process.argv[2] === "auth") console.log(JSON.stringify({ credential: "dev-pairing" }));
else process.exit(2);
`,
        );
        // Even if the input carries an archive version, nodeScriptPath selects dev mode.
        const generated = yield* nativeScripts({ ...ARCHIVE, nodeScriptPath: devScript });
        const result = yield* shell(f.home, generated.pairing);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).credential, "dev-pairing");
        assert.include(yield* f.fs.readFileString(`${f.state}/run-t3.sh`), devScript);
        assert.isFalse(yield* f.fs.exists(`${f.state}/pid`));
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { leaveRemoteServerRunning: true, action: "disconnect" },
      { leaveRemoteServerRunning: false, action: "disconnect" },
      { leaveRemoteServerRunning: true, action: "shutdown" },
      { leaveRemoteServerRunning: false, action: "shutdown" },
    ] as const)(
      "$action follows leaveRemoteServerRunning=$leaveRemoteServerRunning",
      ({ leaveRemoteServerRunning, action }) =>
        Effect.gen(function* () {
          const f = yield* fixture("none");
          const before = yield* f.snapshot;
          const remote = f.oldProcess!;
          let forwardKills = 0;
          let remoteStops = 0;
          const spawner = makeProtocolTestSpawner((command) =>
            Effect.gen(function* () {
              const args = commandArgs(command);
              if (args.includes("-G")) {
                return makeSuccessfulProcess(
                  "hostname devbox.example.com\nuser julius\nport 2222\n",
                );
              }
              if (args.includes("-N"))
                return makeRunningProcess(() => {
                  forwardKills++;
                });
              if (args.includes("--")) {
                return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}');
              }
              if (args.includes("sh")) {
                remoteStops++;
                assert.equal(forwardKills, 1); // local forward closes before remote stop
                yield* remote.kill({ killSignal: "SIGTERM" });
                assert.equal(Number(yield* remote.exitCode), 0);
                return makeSuccessfulProcess('{"stopped":true}');
              }
              return makeSuccessfulProcess("");
            }),
          );
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
              ...(leaveRemoteServerRunning ? { leaveRemoteServerRunning: true } : {}),
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            assert.isTrue(yield* remote.isRunning);
            if (action === "disconnect") {
              yield* manager.disconnectEnvironment(uploadTarget);
              assert.equal(forwardKills, 1);
              assert.equal(remoteStops, leaveRemoteServerRunning ? 0 : 1);
              assert.equal(yield* remote.isRunning, leaveRemoteServerRunning);
              if (leaveRemoteServerRunning) {
                assert.deepEqual(yield* f.snapshot, before);
                // No cached tunnel remains: a second disconnect still cannot stop it.
                yield* manager.disconnectEnvironment(uploadTarget);
                assert.equal(remoteStops, 0);
                assert.equal(forwardKills, 1);
                assert.isTrue(yield* remote.isRunning);
              }
            }
          }).pipe(Effect.provide(layer), Effect.scoped);
          // In shutdown rows the manager finalizer performed the tested action.
          // In disconnect rows it must not perform a duplicate close/remote stop.
          assert.equal(forwardKills, 1);
          assert.equal(remoteStops, leaveRemoteServerRunning ? 0 : 1);
          assert.equal(yield* remote.isRunning, leaveRemoteServerRunning);
          if (leaveRemoteServerRunning) {
            assert.deepEqual(yield* f.snapshot, before);
            assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
          } else {
            assert.equal((yield* f.events).filter((event) => event.type === "stop").length, 1);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { failure: "missing-release", publishDefault: true },
      { failure: "missing-release", publishDefault: false },
      { failure: "bad-checksum", publishDefault: true },
      { failure: "bad-checksum", publishDefault: false },
      { failure: "broken-executable", publishDefault: true },
      { failure: "broken-executable", publishDefault: false },
      { failure: "wrong-version", publishDefault: true },
      { failure: "wrong-version", publishDefault: false },
    ] as const)(
      "$failure preserves the live server (default descriptor=$publishDefault)",
      ({ failure, publishDefault }) =>
        Effect.gen(function* () {
          const f = yield* fixture(failure, { publishDefault });
          const before = yield* f.snapshot;
          const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
          assert.notEqual(result.code, 0);
          assert.include(result.stderr, nextVersion);
          assert.include(result.stderr, "existing runner and server");
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
          yield* f.cleanCandidates;
          if (failure === "wrong-version") {
            assert.include(result.stderr, `expected goat v${nextVersion}`);
            assert.include(result.stderr, `reported "goat v${oldVersion}"`);
            assert.isTrue(
              (yield* f.events).some(
                (event) =>
                  event.type === "version" && event.version === oldVersion && event.oldAlive,
              ),
            );
          } else {
            assert.isFalse(
              yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/${nextVersion}`),
            );
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "rejects a same-version wrong archive without replacing the broken-marker runtime",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-same-version-rejected-" });
          const requestedVersion = "1.2.3";
          const reportedVersion = "9.9.9";
          const state = `${home}/.goat/ssh-launch/${stateKey}`;
          const versions = `${home}/.goat/runtime/goat/versions`;
          const runtime = `${versions}/${requestedVersion}`;
          const stem = `goat-${requestedVersion}-${platform}-${arch}`;
          const stage = `${home}/stage/${stem}`;
          const release = `${home}/mirror/v${requestedVersion}`;
          for (const directory of [state, runtime, stage, release]) {
            yield* fs.makeDirectory(directory, { recursive: true });
          }
          yield* fs.writeFileString(`${runtime}/goat`, "#!/bin/sh\nprintf 'goat v1.2.3\\n'\n");
          yield* fs.chmod(`${runtime}/goat`, 0o700);
          yield* fs.writeFileString(`${runtime}/.install-complete`, "broken-marker\n");
          yield* fs.writeFileString(`${runtime}/preserved`, "existing runtime sentinel\n");
          const installed = yield* nativeScripts({ archiveVersion: requestedVersion });
          yield* fs.writeFileString(`${state}/run-t3.sh`, installed.runner + "\n");
          yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
          yield* fs.writeFileString(
            `${stage}/goat`,
            `#!/bin/sh\nprintf 'goat v${reportedVersion}\\n'\n`,
          );
          yield* fs.chmod(`${stage}/goat`, 0o700);
          const packed = yield* spawner.spawn(
            ChildProcess.make("tar", [
              "-czf",
              `${release}/${stem}.tar.gz`,
              "-C",
              `${home}/stage`,
              stem,
            ]),
          );
          assert.equal(Number(yield* packed.exitCode), 0);
          const crypto = yield* Crypto.Crypto;
          const sha256 = Hex.encode(
            yield* crypto.digest("SHA-256", yield* fs.readFile(`${release}/${stem}.tar.gz`)),
          );
          yield* fs.writeFileString(`${release}/SHA256SUMS`, `${sha256}  ${stem}.tar.gz\n`);
          const snapshot = Effect.gen(function* () {
            const values: Record<string, unknown> = {};
            for (const file of [
              `${state}/run-t3.sh`,
              `${runtime}/goat`,
              `${runtime}/.install-complete`,
              `${runtime}/preserved`,
            ]) {
              const info = yield* fs.stat(file);
              values[file] = {
                bytes: yield* fs.readFile(file),
                ino: info.ino,
                mode: info.mode,
                mtime: info.mtime,
              };
            }
            return values;
          });
          const before = yield* snapshot;
          const generated = yield* nativeScripts({
            archiveVersion: requestedVersion,
            releaseBaseUrl: `file://${home}/mirror`,
          });
          const result = yield* shell(home, generated.launch, [stateKey]);
          assert.notEqual(result.code, 0);
          assert.equal(result.stdout, "");
          assert.include(result.stderr, `expected goat v${requestedVersion}`);
          assert.include(result.stderr, `reported "goat v${reportedVersion}"`);
          assert.deepEqual(yield* snapshot, before);
          assert.deepEqual(yield* fs.readDirectory(versions), [requestedVersion]);
          assert.deepEqual(yield* fs.readDirectory(state), ["run-t3.sh"]);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("verifies, publishes, stops, then starts on a successful upgrade", () =>
      Effect.gen(function* () {
        const f = yield* fixture("none");
        const before = yield* f.snapshot;
        const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
        assert.equal(result.code, 0, result.stderr);
        const events = yield* f.events;
        const verified = events.findIndex(
          (event) => event.type === "version" && event.version === nextVersion,
        );
        const stopped = events.findIndex(
          (event) => event.type === "stop" && event.version === oldVersion,
        );
        const started = events.findIndex(
          (event) => event.type === "start" && event.version === nextVersion,
        );
        const published = events.findIndex(
          (event) =>
            event.type === "version" &&
            event.version === nextVersion &&
            event.runner?.includes(`T3_ARCHIVE_VERSION='${nextVersion}'`),
        );
        assert.isAtLeast(verified, 0);
        assert.include(events[verified]!.runner!, `T3_ARCHIVE_VERSION='${oldVersion}'`);
        assert.isTrue(events[verified]!.oldAlive);
        assert.isTrue(events[published]!.oldAlive);
        assert.isBelow(verified, published);
        assert.isBelow(published, stopped);
        assert.isBelow(verified, stopped);
        assert.isBelow(stopped, started);
        assert.include(events[started]!.installed!, `T3_ARCHIVE_VERSION='${nextVersion}'`);
        assert.equal(events[started]!.complete, nextVersion);
        assert.equal(Number(yield* f.oldProcess!.exitCode), 0);
        const resultJson = JSON.parse(result.stdout.trim()) as { serverKind: string };
        assert.equal(resultJson.serverKind, "managed");
        const after = yield* f.snapshot;
        for (const key of [
          "oldExecutable",
          "oldMarker",
          "oldMetadata:goat",
          "oldMetadata:.install-complete",
          "upstreamExecutable",
          "upstreamMarker",
        ])
          assert.deepEqual(after[key], before[key]);
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("identical runner retains managed PID even with its default descriptor", () =>
      Effect.gen(function* () {
        const f = yield* fixture("none", { identical: true });
        const before = yield* f.snapshot;
        const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(yield* f.snapshot, before);
        assert.isTrue(yield* f.oldProcess!.isRunning);
        assert.deepEqual(
          (yield* f.events)
            .filter((event) => event.type === "start" || event.type === "stop")
            .map((event) => event.type),
          ["start"],
        );
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "keep-existing ignores a newer unavailable release and leaves the older runtime untouched",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture("missing-release", { compatible: true });
          const before = yield* f.snapshot;
          const scripts = f.scripts;
          const result = yield* shell(f.home, scripts.launch, [stateKey]);
          assert.equal(result.code, 0, result.stderr);
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.version === nextVersion));
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["pairing", "mcp"] as const)(
      "warm %s uses the retained runner even without a keep flag",
      (entry) =>
        Effect.gen(function* () {
          const f = yield* fixture("missing-release", { compatible: true });
          const before = yield* f.snapshot;
          const result = yield* shell(f.home, f.scripts[entry]);
          assert.equal(result.code, 0, result.stderr);
          if (entry === "pairing") {
            assert.equal(JSON.parse(result.stdout).credential, "fixture-pairing");
          } else {
            assert.deepEqual(yield* SshTunnel.decodeRemoteMcpSessionOutput(result.stdout), {
              token: "fixture-session",
              expiresAt: null,
              runtimeModeCeilingApplied: false,
            });
          }
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.deepEqual(
            (yield* f.events)
              .filter((event) => event.type === "auth")
              .map((event) => event.version),
            [oldVersion],
          );
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["pairing", "mcp"] as const)(
      "cold %s verifies and publishes before issuing credentials",
      (entry) =>
        Effect.gen(function* () {
          const f = yield* fixture("none", { seed: false });
          const result = yield* shell(f.home, f.scripts[entry]);
          assert.equal(result.code, 0, result.stderr);
          if (entry === "pairing") {
            assert.equal(JSON.parse(result.stdout).credential, "fixture-pairing");
          } else {
            assert.deepEqual(yield* SshTunnel.decodeRemoteMcpSessionOutput(result.stdout), {
              token: "fixture-session",
              expiresAt: null,
              runtimeModeCeilingApplied: false,
            });
          }
          const events = yield* f.events;
          const verified = events.findIndex((event) => event.type === "version");
          const issued = events.findIndex((event) => event.type === "auth");
          assert.isAtLeast(verified, 0);
          assert.isBelow(verified, issued);
          assert.include(
            yield* f.fs.readFileString(`${f.state}/run-t3.sh`),
            `T3_ARCHIVE_VERSION='${nextVersion}'`,
          );
          assert.equal(
            (yield* f.fs.readFileString(
              `${f.home}/.goat/runtime/goat/versions/${nextVersion}/.install-complete`,
            )).trim(),
            nextVersion,
          );
          assert.isFalse(yield* f.fs.exists(`${f.state}/pid`));
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { entry: "pairing", failure: "missing-release" },
      { entry: "pairing", failure: "bad-checksum" },
      { entry: "pairing", failure: "broken-executable" },
      { entry: "pairing", failure: "wrong-version" },
      { entry: "mcp", failure: "missing-release" },
      { entry: "mcp", failure: "bad-checksum" },
      { entry: "mcp", failure: "broken-executable" },
      { entry: "mcp", failure: "wrong-version" },
    ] as const)(
      "cold $entry refuses $failure without publishing or issuing credentials",
      ({ entry, failure }) =>
        Effect.gen(function* () {
          const f = yield* fixture(failure, { seed: false });
          const before = yield* f.snapshot;
          const result = yield* shell(f.home, f.scripts[entry]);
          assert.notEqual(result.code, 0);
          assert.include(result.stderr, nextVersion);
          assert.include(result.stderr, "existing runner and server");
          assert.deepEqual(yield* f.snapshot, before);
          for (const file of ["run-t3.sh", "pid", "port", "managed"]) {
            assert.isFalse(yield* f.fs.exists(`${f.state}/${file}`));
          }
          assert.isFalse(
            (yield* f.events).some((event) => event.type === "auth" || event.type === "start"),
          );
          if (failure === "wrong-version") {
            assert.include(result.stderr, `expected goat v${nextVersion}`);
            assert.include(result.stderr, `reported "goat v${oldVersion}"`);
          } else {
            assert.isFalse(
              yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/${nextVersion}`),
            );
          }
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "TERM during candidate validation removes the candidate and preserves the old server",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture("none");
          const before = yield* f.snapshot;
          const candidateRuntime = `${f.home}/.goat/runtime/goat/versions/${nextVersion}`;
          yield* f.fs.makeDirectory(candidateRuntime, { recursive: true });
          yield* f.fs.writeFileString(`${candidateRuntime}/.install-complete`, `${nextVersion}\n`);
          yield* f.fs.writeFileString(
            `${candidateRuntime}/goat`,
            `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.HOME + "/.test/events", JSON.stringify({ type: "interrupted-validation", version: ${JSON.stringify(nextVersion)} }) + "\\n");
process.kill(process.ppid, "SIGTERM");
process.exit(95);
`,
          );
          yield* f.fs.chmod(`${candidateRuntime}/goat`, 0o700);
          const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
          assert.notEqual(result.code, 0);
          assert.isTrue((yield* f.events).some((event) => event.type === "interrupted-validation"));
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe("bundled runtime acquisition", () => {
  it.live.each([
    "bundle",
    "cache",
    "gh",
    "ready",
    "retained",
    "corrupt",
    "missing-sidecar",
    "wrong-executable",
    "bundle-only",
    "wrong-bundle-version",
    "wrong-bundle-platform",
    "no-cache",
    "same-cache",
    "blank-bundle",
  ] as const)(
    "%s installs or preserves the selected runtime without writing bundle bytes",
    (mode) =>
      Effect.gen(function* () {
        if (HostProcess.Platform.defaultValue() === "win32") return;
        const fs = yield* FileSystem.FileSystem;
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-bundle-behavior-" });
        const home = `${root}/remote-home`;
        const bundle = `${root}/packaged resources/ssh-runtime/archives`;
        const cache = `${root}/cache`;
        const asset = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`;
        const executable = (version: string, origin: string) =>
          `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf 'goat v${version}\\n'\nelif [ "$1" = "__ssh-helper" ] && [ "$2" = "protocol" ]; then\n  case " $* " in *" --runtime-file "*) printf 'none unknown unknown unknown 0 0\\n';; *) printf '${version} 1 2 0 0\\n';; esac\nelif [ "$1" = "auth" ] && [ "$2" = "pairing" ]; then\n  printf '{"credential":"${origin}-pairing"}\\n'\nelse\n  exit 64\nfi\n`;
        const makeArchive = (directory: string, origin: string) =>
          Effect.gen(function* () {
            const stem = asset.slice(0, -7);
            const content = `${root}/${origin}-content/${stem}`;
            yield* fs.makeDirectory(content, { recursive: true });
            yield* fs.makeDirectory(directory, { recursive: true });
            const executableVersion =
              mode === "wrong-executable" && origin === "bundle" ? "1.2.2" : ARCHIVE.archiveVersion;
            yield* fs.writeFileString(`${content}/goat`, executable(executableVersion, origin));
            yield* fs.chmod(`${content}/goat`, 0o700);
            yield* fs.writeFileString(`${content}/origin`, origin);
            const tar = yield* realSpawner.spawn(
              ChildProcess.make("tar", [
                "-czf",
                `${directory}/${asset}`,
                "-C",
                `${root}/${origin}-content`,
                stem,
              ]),
            );
            assert.equal(Number(yield* tar.exitCode), 0);
            const bytes = yield* fs.readFile(`${directory}/${asset}`);
            const hash = Hex.encode(yield* crypto.digest("SHA-256", bytes));
            yield* fs.writeFileString(`${directory}/${asset}.sha256`, `${hash}  ${asset}\n`);
            return { bytes, hash };
          });
        yield* fs.makeDirectory(home, { recursive: true });
        const fromBundle = yield* makeArchive(bundle, "bundle");
        const fromCache = yield* makeArchive(cache, "cache");
        const fromGh = yield* makeArchive(`${root}/gh-source`, "gh");
        if (mode === "corrupt" || mode === "ready" || mode === "retained")
          yield* fs.writeFileString(`${bundle}/${asset}.sha256`, `${"0".repeat(64)}  ${asset}\n`);
        if (mode === "missing-sidecar") yield* fs.remove(`${bundle}/${asset}.sha256`);
        if (mode === "wrong-bundle-version" || mode === "wrong-bundle-platform") {
          yield* fs.rename(
            `${bundle}/${asset}`,
            `${bundle}/${mode === "wrong-bundle-version" ? "goat-9.9.9-" + platform + "-" + arch : "goat-" + ARCHIVE.archiveVersion + "-other-platform"}.tar.gz`,
          );
        }
        if (mode === "cache" || mode === "gh" || mode === "no-cache" || mode === "same-cache")
          yield* fs.remove(`${bundle}/${asset}`);
        if (mode === "gh") yield* fs.remove(`${cache}/${asset}`);
        const bundleBefore = yield* fs.readDirectory(bundle);
        const bundleArchiveBefore = (yield* fs.exists(`${bundle}/${asset}`))
          ? yield* fs.readFile(`${bundle}/${asset}`)
          : null;
        const stateKey = yield* remoteStateKey(uploadTarget);
        const retainedVersion = "1.2.2-preview.20260910.1";
        const installedVersion = mode === "retained" ? retainedVersion : ARCHIVE.archiveVersion;
        const runtime = `${home}/.goat/runtime/goat/versions/${installedVersion}`;
        if (mode === "ready" || mode === "retained") {
          yield* fs.makeDirectory(runtime, { recursive: true });
          yield* fs.writeFileString(`${runtime}/goat`, executable(installedVersion, mode));
          yield* fs.chmod(`${runtime}/goat`, 0o700);
          yield* fs.writeFileString(`${runtime}/.install-complete`, installedVersion);
          yield* fs.writeFileString(`${runtime}/origin`, mode);
          if (mode === "retained") {
            const state = `${home}/.goat/ssh-launch/${stateKey}`;
            yield* fs.makeDirectory(state, { recursive: true });
            yield* fs.writeFileString(
              `${state}/run-t3.sh`,
              SshTunnel.buildRemoteT3RunnerScript({ archiveVersion: retainedVersion }),
            );
            yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
          }
        }
        const mutations: string[] = [];
        const guard = (file: string) => {
          if (file === bundle || file.startsWith(bundle + "/")) mutations.push(file);
        };
        const checkedFs = FileSystem.FileSystem.of({
          ...fs,
          writeFile: (file, bytes, options) => {
            guard(file);
            return fs.writeFile(file, bytes, options);
          },
          writeFileString: (file, text, options) => {
            guard(file);
            return fs.writeFileString(file, text, options);
          },
          makeDirectory: (file, options) => {
            guard(file);
            return fs.makeDirectory(file, options);
          },
          remove: (file, options) => {
            guard(file);
            return fs.remove(file, options);
          },
          rename: (from, to) => {
            guard(from);
            guard(to);
            return fs.rename(from, to);
          },
          chmod: (file, mode) => {
            guard(file);
            return fs.chmod(file, mode);
          },
        });
        let downloads = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            assert.equal(command._tag, "StandardCommand");
            if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
            if (command.command === "gh") {
              downloads++;
              const destination = command.args[command.args.indexOf("--dir") + 1]!;
              assert.isFalse(destination.startsWith(bundle));
              yield* fs.writeFile(`${destination}/${asset}`, fromGh.bytes);
              yield* fs.writeFileString(`${destination}/SHA256SUMS`, `${fromGh.hash}  ${asset}\n`);
              return makeSuccessfulProcess("");
            }
            const index = command.args.indexOf("sh");
            assert.isAtLeast(index, 0);
            const remoteArgs = command.args.slice(index);
            return yield* realSpawner.spawn(
              ChildProcess.make(
                "sh",
                command.args.includes("-c") ? ["-c", remoteArgs.join(" ")] : ["-s"],
                {
                  env: { HOME: home, PATH: process.env.PATH ?? "" },
                  extendEnv: false,
                  stdin: command.options.stdin,
                },
              ),
            );
          }),
        );
        const runner = {
          ...ARCHIVE,
          bundledArchiveDirectory: mode === "blank-bundle" ? "  " : bundle,
          ...(mode === "bundle-only" || mode === "no-cache"
            ? {}
            : { archiveDirectory: mode === "same-cache" ? bundle + "/../archives" : cache }),
          // Bundle must also win over an explicit unusable mirror.
          ...(mode === "bundle" ? { releaseBaseUrl: "file:///unavailable" } : {}),
          keepExistingRunner: mode === "retained",
        };
        const result = yield* Effect.result(
          SshTunnel.prepareRemoteRuntime(uploadTarget, {}, runner, stateKey).pipe(
            Effect.provideService(FileSystem.FileSystem, checkedFs),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        );
        const failure =
          mode === "corrupt" ||
          mode === "missing-sidecar" ||
          mode === "wrong-executable" ||
          mode === "no-cache" ||
          mode === "same-cache";
        assert.equal(Result.isFailure(result), failure);
        if (failure) {
          assert.isFalse(yield* fs.exists(`${runtime}/.install-complete`));
          assert.isFalse(yield* fs.exists(`${home}/.goat/ssh-launch/${stateKey}/run-t3.sh`));
        } else {
          const expected =
            mode === "bundle-only"
              ? "bundle"
              : mode === "wrong-bundle-version" ||
                  mode === "wrong-bundle-platform" ||
                  mode === "blank-bundle"
                ? "cache"
                : mode;
          assert.equal(yield* fs.readFileString(`${runtime}/origin`), expected);
          assert.equal(
            (yield* fs.readFileString(`${runtime}/.install-complete`)).trim(),
            installedVersion,
          );
          const runnerFile = `${home}/.goat/ssh-launch/${stateKey}/run-t3.sh`;
          const retainedBefore = mode === "retained" ? yield* fs.readFileString(runnerFile) : null;
          if (mode !== "retained") assert.isFalse(yield* fs.exists(runnerFile));
          // Public pairing runs prepare again, then verifies/publishes its candidate.
          const pairing = yield* SshTunnel.issueRemotePairingToken(uploadTarget, {}, runner).pipe(
            Effect.provideService(FileSystem.FileSystem, checkedFs),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          assert.equal(pairing.credential, `${expected}-pairing`);
          assert.isTrue(yield* fs.exists(runnerFile));
          if (retainedBefore !== null)
            assert.equal(yield* fs.readFileString(runnerFile), retainedBefore);
          assert.deepEqual(
            (yield* fs.readDirectory(`${home}/.goat/ssh-launch/${stateKey}`)).filter((name) =>
              name.startsWith("run-t3.next."),
            ),
            [],
          );
        }
        assert.equal(downloads, mode === "gh" ? 1 : 0);
        assert.deepEqual(mutations, []);
        assert.deepEqual(yield* fs.readDirectory(bundle), bundleBefore);
        if (bundleArchiveBefore !== null)
          assert.deepEqual(yield* fs.readFile(`${bundle}/${asset}`), bundleArchiveBefore);
        if (mode !== "gh")
          assert.deepEqual(yield* fs.readFile(`${cache}/${asset}`), fromCache.bytes);
        // Distinct tar origins prove which executable tree actually got installed.
        assert.notDeepEqual(fromBundle.bytes, fromCache.bytes);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote stop invocation ownership",
  () => {
    it.live.each([
      "archive",
      "node",
      "absolute node",
      "node path with spaces",
      "quoted entry",
      "archive other base dir",
      "node other base dir",
      "archive extra args",
      "node extra args",
      "tail node suffix",
      "runner code",
      "tail",
      "find",
      "different port",
      "port prefix",
      "missing identity",
      "missing marker",
      "empty marker",
      "external",
      "dead PID",
      "dead unmarked PID",
      "invalid port",
      "different entry",
      "invalid version",
      "version newline",
      "leading command",
      "different identity with spaced argv0",
      "different identity with multiline argv0",
    ] as const)("handles %s without signaling unrelated processes", (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-stop-" });
        // These characters must stay literal in the generated shell's case patterns.
        const home = `${root}/remote home[*?]`;
        const state = `${home}/.goat/ssh-launch/stop-fixture`;
        const bin = `${home}/.test/bin`;
        yield* fs.makeDirectory(state, { recursive: true });
        yield* fs.makeDirectory(bin, { recursive: true });
        const pid = "424242";
        const port = "3773";
        const entry =
          mode === "quoted entry" ? "/repo/dev's entry.mjs" : `${home}/source entry[*?].mjs`;
        const nodeBin = `${home}/opt/node installation/bin`;
        const node = mode === "node path with spaces" ? `${nodeBin}/node` : `${bin}/node`;
        yield* fs.makeDirectory(nodeBin, { recursive: true });
        const runner = `${state}/run-t3.sh`;
        const runtime = `${home}/.goat/runtime/goat/versions/1.2.3/goat`;
        const argumentsText = `serve --host 127.0.0.1 --port ${port} --base-dir ${home}/.goat`;
        const commands: Partial<Record<typeof mode, string>> = {
          node: `node ${entry} ${argumentsText}`,
          "absolute node": `${node} ${entry} ${argumentsText}`,
          "node path with spaces": `${process.execPath} ${entry} ${argumentsText}`,
          "quoted entry": `node ${entry} ${argumentsText}`,
          tail: `tail -f ${runner}`,
          find: `find ${home}/.goat/runtime/goat/versions/1.2.3`,
          "different port": `${runtime} serve --host 127.0.0.1 --port 4773 --base-dir ${home}/.goat`,
          "port prefix": `${runtime} serve --host 127.0.0.1 --port ${port}0 --base-dir ${home}/.goat`,
          "archive other base dir": `${runtime} serve --host 127.0.0.1 --port ${port} --base-dir /other/userdata`,
          "node other base dir": `node ${entry} serve --host 127.0.0.1 --port ${port} --base-dir /other/userdata`,
          "archive extra args": `${runtime} ${argumentsText} --extra`,
          "node extra args": `node ${entry} ${argumentsText} --extra`,
          "tail node suffix": `/bin/tail -f /x/node ${entry} ${argumentsText}`,
          "runner code": `node ${entry} ${argumentsText}`,
          "different entry": `node ${entry}.backup ${argumentsText}`,
          "invalid version": `${home}/.goat/runtime/goat/versions/1.2.3 bad/goat ${argumentsText}`,
          "version newline": `${home}/.goat/runtime/goat/versions/1.2.3\nextra/goat ${argumentsText}`,
          "leading command": `tail -f ${runtime} ${argumentsText}`,
          "different identity with spaced argv0": `/opt/node path/node ${entry} ${argumentsText}`,
          "different identity with multiline argv0": `/opt/node\npath/node ${entry} ${argumentsText}`,
        };
        const command = commands[mode] ?? `${runtime} ${argumentsText}`;
        yield* fs.writeFileString(
          runner,
          mode === "runner code"
            ? "T3_NODE_SCRIPT_PATH='$(touch \"$HOME/.test/evaluated\")'\n"
            : SshTunnel.buildRemoteT3RunnerScript({ nodeScriptPath: entry }),
        );
        const nodeIdentity = [
          "node",
          "absolute node",
          "node path with spaces",
          "quoted entry",
          "node other base dir",
          "node extra args",
          "different entry",
        ].includes(mode);
        if (mode !== "missing identity")
          yield* fs.writeFileString(
            `${state}/identity`,
            `${nodeIdentity ? entry : runtime} ${argumentsText}\n`,
          );
        yield* fs.writeFileString(`${state}/pid`, pid + "\n");
        yield* fs.writeFileString(`${state}/port`, (mode === "invalid port" ? "0" : port) + "\n");
        if (mode !== "missing marker" && mode !== "dead unmarked PID")
          yield* fs.writeFileString(
            `${state}/managed`,
            mode === "empty marker" ? "" : mode === "external" ? "external\n" : "managed\n",
          );
        yield* fs.writeFileString(`${home}/.test/command`, command + "\n");
        if (mode !== "dead PID" && mode !== "dead unmarked PID")
          yield* fs.writeFileString(`${home}/.test/alive`, pid);
        yield* fs.writeFileString(
          `${bin}/ps`,
          `#!/bin/sh
[ "$1 $2 $3 $4" = '-o command= -p ${pid}' ] || exit 1
cat "$HOME/.test/command"
`,
        );
        yield* fs.chmod(`${bin}/ps`, 0o700);
        const snapshot = Effect.forEach(
          ["pid", "port", "managed", "identity", "run-t3.sh"],
          (file) =>
            Effect.gen(function* () {
              return (yield* fs.exists(`${state}/${file}`))
                ? yield* fs.readFileString(`${state}/${file}`)
                : null;
            }),
        );
        const before = yield* snapshot;
        // Override sh's kill builtin; this test never sends an OS signal.
        const killShim = `kill() {
  if [ "$1" = -0 ]; then
    [ "$2" = ${pid} ] && [ -f "$HOME/.test/alive" ]
  else
    [ "$#" = 1 ] && [ "$1" = ${pid} ] || return 1
    printf '%s\\n' "$1" >> "$HOME/.test/killed"
    rm -f "$HOME/.test/alive"
  fi
}
`;
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s"], {
            env: { HOME: home, PATH: `${bin}:${nodeBin}:${process.env.PATH ?? ""}`, LC_ALL: "C" },
            extendEnv: false,
            stdin: {
              stream: Stream.make(
                encoder.encode(killShim + SshTunnel.buildRemoteStopScript("stop-fixture")),
              ),
              endOnDone: true,
            },
          }),
        );
        const result = yield* Effect.all(
          {
            code: child.exitCode.pipe(Effect.map(Number)),
            stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          },
          { concurrency: "unbounded" },
        );
        const owned = [
          "archive",
          "node",
          "absolute node",
          "node path with spaces",
          "quoted entry",
        ].includes(mode);
        assert.isFalse(yield* fs.exists(`${home}/.test/evaluated`));
        const cleanup =
          owned || mode === "external" || mode === "dead PID" || mode === "dead unmarked PID";
        assert.equal(result.code === 0, cleanup, result.stderr);
        assert.equal(yield* fs.exists(`${home}/.test/killed`), owned);
        if (owned) assert.equal(yield* fs.readFileString(`${home}/.test/killed`), pid + "\n");
        if (cleanup) {
          assert.deepEqual((yield* snapshot).slice(0, 4), [null, null, null, null]);
          assert.include(result.stdout, '{"stopped":true}');
          if (mode === "external") assert.isTrue(yield* fs.exists(`${home}/.test/alive`));
        } else {
          assert.include(result.stderr, "ownership could not be verified");
          assert.deepEqual(yield* snapshot, before);
          assert.isTrue(yield* fs.exists(`${home}/.test/alive`));
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["stale PID", "missing identity", "identity changes after publication"] as const)(
      "refuses an owned upgrade with %s despite matching protocol metadata",
      (mode) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-upgrade-identity-" });
          const key = "stale-upgrade";
          const state = `${home}/.goat/ssh-launch/${key}`;
          const runtime = `${home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}`;
          const bin = `${home}/.test/bin`;
          const record = `${home}/.goat/userdata/server-runtime.json`;
          for (const directory of [state, runtime, bin, `${home}/.goat/userdata`])
            yield* fs.makeDirectory(directory, { recursive: true });
          const pid = "424242";
          const port = "1234";
          yield* fs.writeFileString(`${state}/pid`, pid + "\n");
          yield* fs.writeFileString(`${state}/port`, port + "\n");
          yield* fs.writeFileString(`${state}/managed`, "managed\n");
          yield* fs.writeFileString(
            `${state}/run-t3.sh`,
            SshTunnel.buildRemoteT3RunnerScript({ archiveVersion: "1.2.2" }),
          );
          if (mode !== "missing identity")
            yield* fs.writeFileString(
              `${state}/identity`,
              `${home}/.goat/runtime/goat/versions/1.2.2/goat serve --host 127.0.0.1 --port ${port} --base-dir ${home}/.goat\n`,
            );
          const originalRunner = yield* fs.readFileString(`${state}/run-t3.sh`);
          const metadata = JSON.stringify({
            version: 1,
            startedAt: "2026-10-11T00:00:00.000Z",
            serverVersion: "1.2.2",
            sshRuntimeProtocolVersion: 99,
            orchestrationProtocolVersion: 2,
            pid: Number(pid),
            port: Number(port),
            origin: `http://127.0.0.1:${port}`,
          });
          yield* fs.writeFileString(record, metadata);
          // Reproduce the helper's stale-but-matching live report. Its report must never authorize a signal.
          yield* fs.writeFileString(
            `${runtime}/goat`,
            `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' 'goat v${ARCHIVE.archiveVersion}'; exit 0; fi
if [ "$1 $2" = '__ssh-helper protocol' ]; then
  case " $* " in
    *' --runtime-file '*) printf '%s\\n' 'live 1.2.2 99 2 ${pid} ${port}' ;;
    *) printf '%s\\n' '${ARCHIVE.archiveVersion} 1 2 0 0' ;;
  esac
  exit 0
fi
exit 2
`,
          );
          yield* fs.chmod(`${runtime}/goat`, 0o700);
          yield* fs.writeFileString(`${runtime}/.install-complete`, ARCHIVE.archiveVersion + "\n");
          yield* fs.writeFileString(
            `${bin}/ps`,
            `#!/bin/sh
[ "$1 $2 $3 $4" = '-o command= -p ${pid}' ] || exit 1
printf 'inspected\\n' >> "$HOME/.test/inspected"
if [ '${mode}' = 'identity changes after publication' ] && grep -F "T3_ARCHIVE_VERSION='1.2.2'" "$HOME/.goat/ssh-launch/${key}/run-t3.sh" >/dev/null; then
  cat "$HOME/.goat/ssh-launch/${key}/identity"
else
  printf '%s\\n' '/bin/tail -f /unrelated/log'
fi
`,
          );
          yield* fs.chmod(`${bin}/ps`, 0o700);
          const killShim = `kill() {
  if [ "$1" = -0 ]; then [ "$2" = ${pid} ]; else
    printf '%s\\n' "$*" >> "$HOME/.test/signals"
    return 1
  fi
}
`;
          const child = yield* spawner.spawn(
            ChildProcess.make("sh", ["-s", "--", key], {
              env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, LC_ALL: "C" },
              extendEnv: false,
              stdin: {
                stream: Stream.make(
                  encoder.encode(killShim + SshTunnel.buildRemoteLaunchScript(ARCHIVE)),
                ),
                endOnDone: true,
              },
            }),
          );
          const result = yield* Effect.all(
            {
              code: child.exitCode.pipe(Effect.map(Number)),
              stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            },
            { concurrency: "unbounded" },
          );
          assert.notEqual(result.code, 0);
          assert.include(result.stderr, "ownership could not be verified");
          assert.equal(result.stdout, "");
          if (mode === "missing identity")
            assert.isFalse(yield* fs.exists(`${home}/.test/inspected`));
          else
            assert.equal(
              yield* fs.readFileString(`${home}/.test/inspected`),
              mode === "stale PID" ? "inspected\n" : "inspected\ninspected\n",
            );
          assert.isFalse(yield* fs.exists(`${home}/.test/signals`));
          if (mode === "identity changes after publication")
            assert.include(
              yield* fs.readFileString(`${state}/run-t3.sh`),
              `T3_ARCHIVE_VERSION='${ARCHIVE.archiveVersion}'`,
            );
          else assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), originalRunner);
          assert.equal(yield* fs.readFileString(record), metadata);
          assert.equal(yield* fs.readFileString(`${state}/pid`), pid + "\n");
          assert.equal(yield* fs.readFileString(`${state}/port`), port + "\n");
          assert.equal(yield* fs.readFileString(`${state}/managed`), "managed\n");
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    const protocolExecutable = (
      version: string,
      signals: {
        ssh?: number;
        orchestration?: number;
        missingCommand?: boolean;
        ownTokens?: string;
        liveTokens?: string;
        descriptor404?: boolean;
        nodeReadiness?: boolean;
      },
      state: string,
    ) => {
      const helperUrl = new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href;
      // From packages/ssh/src, ../../../apps resolves the repository apps directory.
      return `#!${process.execPath}
(async () => {
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const version = ${JSON.stringify(version)};
const fields = { serverVersion: version,
  ...${JSON.stringify(signals.ssh === undefined ? {} : { sshRuntimeProtocolVersion: signals.ssh })},
  ...${JSON.stringify(signals.orchestration === undefined ? {} : { orchestrationProtocolVersion: signals.orchestration })} };
const home = process.env.HOME;
const state = ${JSON.stringify(state)};
const test = path.join(home, ".test");
const runtimeFile = path.join(home, ".goat/userdata/server-runtime.json");
const args = process.argv.slice(2);
function event(type, extra = {}) { fs.appendFileSync(path.join(test, "events"), JSON.stringify({type, version, ...extra}) + "\\n"); }
if (args[0] === "--version") {
  event("version", { published: fs.existsSync(path.join(state, "run-t3.sh")) ? fs.readFileSync(path.join(state, "run-t3.sh"), "utf8") : "" });
  console.log("goat v" + version);
} else if (args[0] === "__ssh-helper" && args[1] === "protocol") {
  if (${JSON.stringify(signals.missingCommand ?? false)}) process.exit(2);
  const at = args.indexOf("--runtime-file");
  const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
  const value = at < 0 ? fields : await (await import(${JSON.stringify(helperUrl)})).readLiveSshRuntimeProtocol(args[at+1], flag("--port-file"), flag("--pid-file"));
  event("protocol", { live: at >= 0, status: value.status });
  if (args.includes("--shell")) {
    const injected = at < 0 ? ${JSON.stringify(signals.ownTokens ?? null)} : ${JSON.stringify(signals.liveTokens ?? null)};
    if (injected !== null) { console.log(injected); return; }
    console.log((value.status ? value.status + " " : "") + [value.serverVersion ?? "unknown",
      value.sshRuntimeProtocolVersion ?? "unknown", value.orchestrationProtocolVersion ?? "unknown",
      value.pid ?? 0, value.port ?? 0].join(" "));
  } else console.log(JSON.stringify(value));
} else if (args[0] === "__ssh-helper" && args[1] === "pick-port") {
  const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
    const port = socket.address().port; socket.close(() => console.log(port));
  });
} else if (args[0] === "__ssh-helper" && args[1] === "wait-ready") {
  // Fixture readiness uses an event, not polling or a delay.
  let record = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, "utf8")) : null;
  if (!record || !fs.existsSync(path.join(test, "accepted-ready-" + record.pid))) {
    const fd = fs.openSync(path.join(test, "ready.fifo"), "r");
    fs.readSync(fd, Buffer.alloc(32), 0, 32, null); fs.closeSync(fd);
    record = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    fs.writeFileSync(path.join(test, "accepted-ready-" + record.pid), "ready");
  }
  const req = http.get("http://127.0.0.1:" + args[2] + "/", res => {
    res.resume(); res.on("end", () => process.exit(res.statusCode === 200 ? 0 : 1));
  }); req.on("error", () => process.exit(1));
} else if (args[0] === "auth") {
  event("auth", { args });
  if (args.includes("--runtime-mode-ceiling") && fs.existsSync(path.join(test, "reject-ceiling"))) process.exit(2);
  console.log(JSON.stringify(args[1] === "pairing" ? {credential: version} : {token: version, expiresAt: null}));
} else if (args[0] === "serve") {
  const at = args.indexOf("--port"); const requested = at < 0 ? 0 : Number(args[at+1]);
  const descriptor = {environmentId: "fixture", label: "Fixture", platform: {os: "linux", arch: "x64"}, capabilities: {}, ...fields};
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/t3/environment" && (${JSON.stringify(signals.descriptor404 ?? false)} || fs.existsSync(path.join(test, "descriptor404")))) {
      res.statusCode = 404; res.end("{}"); return;
    }
    res.end(req.url === "/.well-known/t3/environment" ? JSON.stringify(descriptor) : "ok");
  });
  process.on("SIGTERM", () => {
    event("stop");
    if (fs.existsSync(runtimeFile) && JSON.parse(fs.readFileSync(runtimeFile, "utf8")).pid === process.pid) fs.unlinkSync(runtimeFile);
    server.close(() => process.exit(0));
  });
  server.listen(requested, "127.0.0.1", () => {
    const record = {version: 1, pid: process.pid, port: server.address().port,
      origin: "http://127.0.0.1:" + server.address().port, startedAt: new Date().toISOString(), ...fields};
    fs.mkdirSync(path.dirname(runtimeFile), {recursive: true}); fs.writeFileSync(runtimeFile, JSON.stringify(record));
    fs.appendFileSync(path.join(test, "pids"), process.pid + "\\n");
    event("start", { runner: fs.readFileSync(path.join(state, "run-t3.sh"), "utf8") });
    if (args.includes("--test-seed")) {
      fs.writeFileSync(path.join(test, "accepted-ready-" + process.pid), "ready");
      console.log(JSON.stringify(record));
    }
    else if (!${JSON.stringify(signals.nodeReadiness ?? false)}) { const fd = fs.openSync(path.join(test, "ready.fifo"), "w"); fs.writeSync(fd, "ready\\n"); fs.closeSync(fd); }
  });
} else process.exit(97);
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
    };

    const makeProtocolFixture = Effect.fn("test.protocol.fixture")(function* (input: {
      live: boolean;
      kind: "managed" | "external";
      oldVersion: string;
      ssh?: number;
      orchestration?: number;
      missingCommand?: boolean;
      ownTokens?: string;
      liveTokens?: string;
      descriptor404?: boolean;
    }) {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-protocol-" });
      const key = yield* remoteStateKey(uploadTarget);
      const state = `${home}/.goat/ssh-launch/${key}`;
      const test = `${home}/.test`;
      const old = `${home}/.goat/runtime/goat/versions/${input.oldVersion}`;
      const cache = `${home}/cache`;
      for (const dir of [state, test, old, cache])
        yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(`${test}/events`, "");
      yield* fs.writeFileString(`${test}/pids`, "");
      const fifo = yield* realSpawner.spawn(ChildProcess.make("mkfifo", [`${test}/ready.fifo`]));
      assert.equal(Number(yield* fifo.exitCode), 0);
      yield* fs.writeFileString(`${old}/goat`, protocolExecutable(input.oldVersion, input, state));
      yield* fs.chmod(`${old}/goat`, 0o700);
      yield* fs.writeFileString(`${old}/.install-complete`, input.oldVersion + "\n");
      const oldRunner = (yield* nativeScripts({ archiveVersion: input.oldVersion })).runner + "\n";
      yield* fs.writeFileString(`${state}/run-t3.sh`, oldRunner);
      yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
      yield* Effect.addFinalizer(() =>
        fs.readFileString(`${test}/pids`).pipe(
          Effect.flatMap((data) =>
            Effect.sync(() => {
              for (const pid of data.trim().split("\n").filter(Boolean).map(Number)) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {
                  /* captured fixture child already exited */
                }
              }
            }),
          ),
          Effect.ignore,
        ),
      );
      let pid = 0;
      let port = 0;
      if (input.live) {
        const child = yield* realSpawner.spawn(
          ChildProcess.make(`${old}/goat`, ["serve", "--test-seed"], {
            env: { HOME: home, PATH: process.env.PATH ?? "" },
            extendEnv: false,
          }),
        );
        const ready = JSON.parse(
          yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.take(1),
            Stream.mkString,
          ),
        ) as { pid: number; port: number };
        assert.equal(ready.pid, Number(child.pid));
        pid = ready.pid;
        port = ready.port;
        yield* installArchivePsDouble(home, pid, port, input.oldVersion);
        yield* fs.writeFileString(`${state}/pid`, `${pid}\n`);
        yield* fs.writeFileString(`${state}/port`, `${port}\n`);
        yield* fs.writeFileString(`${state}/managed`, input.kind + "\n");
        if (input.kind === "managed")
          yield* fs.writeFileString(
            `${state}/identity`,
            `${old}/goat serve --host 127.0.0.1 --port ${port} --base-dir ${home}/.goat\n`,
          );
      }
      const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
      const stage = `${home}/stage/${stem}`;
      yield* fs.makeDirectory(stage, { recursive: true });
      yield* fs.writeFileString(
        `${stage}/goat`,
        protocolExecutable(ARCHIVE.archiveVersion, { ssh: 1, orchestration: 2 }, state),
      );
      yield* fs.chmod(`${stage}/goat`, 0o700);
      const packed = yield* realSpawner.spawn(
        ChildProcess.make("tar", ["-czf", `${cache}/${stem}.tar.gz`, "-C", `${home}/stage`, stem]),
      );
      assert.equal(Number(yield* packed.exitCode), 0);
      const crypto = yield* Crypto.Crypto;
      const sha = Hex.encode(
        yield* crypto.digest("SHA-256", yield* fs.readFile(`${cache}/${stem}.tar.gz`)),
      );
      yield* fs.writeFileString(`${cache}/${stem}.tar.gz.sha256`, `${sha}  ${stem}.tar.gz\n`);
      const runner = { ...ARCHIVE, archiveDirectory: cache };
      const remoteCommands: ChildProcess.Command[] = [];
      let uploads = 0;
      let gh = 0;
      let cacheReads = 0;
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        exists: (file) => {
          if (file.startsWith(cache)) cacheReads++;
          return fs.exists(file);
        },
        readFile: (file) => {
          if (file.startsWith(cache)) cacheReads++;
          return fs.readFile(file);
        },
        readFileString: (file) => {
          if (file.startsWith(cache)) cacheReads++;
          return fs.readFileString(file);
        },
      });
      let remotePath = `${home}/.test/identity-bin:${process.env.PATH ?? ""}`;
      const setRemotePath = (value: string) => {
        remotePath = value;
      };
      let beforeCommand: ((script: string) => ReturnType<typeof fs.writeFileString>) | undefined;
      const setBeforeCommand = (callback: typeof beforeCommand) => {
        beforeCommand = callback;
      };
      const fixtureScope = yield* Scope.Scope;
      const remoteSpawn = (command: ChildProcess.Command) =>
        realSpawner.spawn(command).pipe(Effect.provideService(Scope.Scope, fixtureScope));
      const transport = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return remoteSpawn(command);
        if (command.command === "gh") {
          gh++;
          return Effect.die("unexpected gh acquisition");
        }
        const at = command.args.indexOf("sh");
        if (at < 0) {
          if (command.args.includes("-G"))
            return Effect.succeed(
              makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n"),
            );
          if (command.args.includes("-N"))
            return Effect.succeed(makeRunningProcess(() => undefined));
          return Effect.die("Unexpected test transport command; real SSH is prohibited");
        }
        remoteCommands.push(command);
        const args = command.args.slice(at + 1).filter((arg) => arg !== "-l");
        if (args.includes("-c")) uploads++;
        // Capture actual submitted bytes; inject races only at an observed command boundary.
        return Effect.gen(function* () {
          const stdin = command.options.stdin;
          if (
            args.includes("-c") ||
            stdin === undefined ||
            typeof stdin !== "object" ||
            !("stream" in stdin) ||
            !Stream.isStream(stdin.stream)
          ) {
            return yield* remoteSpawn(
              ChildProcess.make("sh", ["-c", ["sh", ...args].join(" ")], {
                env: { HOME: home, PATH: remotePath, LC_ALL: "C" },
                extendEnv: false,
                ...(stdin === undefined ? {} : { stdin }),
              }),
            );
          }
          const script = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString);
          if (beforeCommand !== undefined) yield* beforeCommand(script);
          return yield* remoteSpawn(
            ChildProcess.make("sh", ["-c", ["sh", ...args].join(" ")], {
              env: { HOME: home, PATH: remotePath, LC_ALL: "C" },
              extendEnv: false,
              stdin: { ...stdin, stream: Stream.make(new TextEncoder().encode(script)) },
            }),
          );
        });
      });
      const run = (entry: "launch" | "pairing" | "mcp", secondary = false) => {
        const inputRunner = { ...runner, keepExistingRunner: secondary };
        const action =
          entry === "launch"
            ? SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, inputRunner).pipe(
                Effect.map((result) => ({
                  version: result.selectedRuntime.version,
                  port: result.remotePort,
                })),
              )
            : entry === "pairing"
              ? SshTunnel.issueRemotePairingToken(uploadTarget, {}, inputRunner).pipe(
                  Effect.map((result) => ({ version: result.credential, port: 0 })),
                )
              : SshTunnel.issueRemoteMcpClientSession(
                  uploadTarget,
                  { label: "fixture", ttl: "1h", runtimeModeCeiling: null },
                  {},
                  inputRunner,
                ).pipe(Effect.map((result) => ({ version: result.token, port: 0 })));
        return action.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, transport),
          Effect.provideService(FileSystem.FileSystem, observedFs),
          Effect.result,
        );
      };
      const snapshot = Effect.gen(function* () {
        const files = ["run-t3.sh", "pid", "port", "managed", "identity"];
        const values: Record<string, string | null> = {};
        for (const file of files)
          values[file] = (yield* fs.exists(`${state}/${file}`))
            ? yield* fs.readFileString(`${state}/${file}`)
            : null;
        const runtime = `${home}/.goat/userdata/server-runtime.json`;
        values.runtime = (yield* fs.exists(runtime)) ? yield* fs.readFileString(runtime) : null;
        values.oldExecutable = yield* fs.readFileString(`${old}/goat`);
        values.oldMarker = yield* fs.readFileString(`${old}/.install-complete`);
        return values;
      });
      return {
        home,
        state,
        test,
        old,
        pid,
        port,
        run,
        snapshot,
        fs,
        realSpawner,
        setBeforeCommand,
        setRemotePath,
        counters: () => ({ uploads, gh, cacheReads }),
        remoteCommands,
        transport,
        runner,
        observedFs,
      };
    });

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        [false, true].map((live) => ({ entry, live })),
      ),
    )("reuses older compatible $entry; live=$live", ({ entry, live }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live,
          kind: "external",
          oldVersion: "1.2.2",
          ssh: 1,
          orchestration: 2,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.version, "1.2.2");
          if (live && entry === "launch") assert.equal(result.success.port, f.port);
        }
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const after = yield* f.snapshot;
        assert.equal(after.oldExecutable, before.oldExecutable);
        assert.equal(after.oldMarker, before.oldMarker);
        if (live) assert.equal(after.runtime, before.runtime);
        const events = (yield* f.fs.readFileString(`${f.test}/events`))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.isFalse(events.some((event) => event.type === "stop"));
        if (entry !== "launch")
          assert.equal(events.findLast((event) => event.type === "auth")?.version, "1.2.2");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "preserves incompatible shared server for $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 99,
            orchestration: 2,
          });
          const before = yield* f.snapshot;
          const result = yield* f.run(entry, true);
          assert.isTrue(Result.isFailure(result));
          assert.deepEqual(yield* f.snapshot, before);
          const response = yield* Effect.promise(() =>
            // @effect-diagnostics-next-line globalFetchInEffect:off - real fixture loopback observation.
            fetch(`http://127.0.0.1:${f.port}/.well-known/t3/environment`),
          );
          assert.equal(response.status, 200);
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.notInclude(events, '"type":"stop"');
          assert.notInclude(events, '"type":"auth"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["stale metadata", "descriptor 404"] as const).map((failure) => ({ failure })))(
      "owning launch preserves an unknown server: $failure",
      ({ failure }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 99,
            orchestration: 2,
            descriptor404: failure === "descriptor 404",
          });
          if (failure === "stale metadata") {
            const file = `${f.home}/.goat/userdata/server-runtime.json`;
            const record = JSON.parse(yield* f.fs.readFileString(file));
            yield* f.fs.writeFileString(
              file,
              JSON.stringify({ ...record, serverVersion: "1.2.1" }),
            );
          }
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result))
            assert.include(String(result.failure), "Cannot verify live GOAT");
          assert.deepEqual(yield* f.snapshot, before); // Includes runner publication/ownership/runtime bytes.
          yield* Effect.sync(() => process.kill(f.pid, 0)); // Captured fixture PID still alive.
          // @effect-diagnostics-next-line globalFetchInEffect:off - real fixture loopback observation.
          const root = yield* Effect.promise(() => fetch(`http://127.0.0.1:${f.port}/`));
          assert.equal(root.status, 200);
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.notInclude(events, '"type":"stop"');
          assert.notInclude(events, '"type":"auth"');
          assert.equal(events.split('"type":"start"').length - 1, 1); // Only the seeded process.
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "refuses same-version retained runner replacement before $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 1,
            orchestration: 2,
          });
          let replaced = false;
          f.setBeforeCommand((script) => {
            if (replaced || !script.includes('RUNNER_FILE="$STATE_DIR/run-t3.sh"'))
              return Effect.void;
            replaced = true;
            return Effect.gen(function* () {
              const file = `${f.state}/run-t3.sh`;
              const original = yield* f.fs.readFileString(file);
              // Keep exactly the same archive version; if executed, log a distinct side effect.
              const replacement = original.replace(
                "#!/bin/sh\n",
                `#!/bin/sh\nprintf 'replacement-executed\\n' >> '${f.test}/events'\n`,
              );
              assert.notEqual(replacement, original);
              yield* f.fs.writeFileString(file, replacement);
            });
          });
          const before = yield* f.snapshot;
          const result = yield* f.run(entry);
          assert.isTrue(replaced);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result))
            assert.include(String(result.failure), "changed since probe");
          const after = yield* f.snapshot;
          assert.notEqual(after["run-t3.sh"], before["run-t3.sh"]); // Only our injected replacement persists.
          assert.deepEqual({ ...after, "run-t3.sh": before["run-t3.sh"] ?? null }, before);
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.notInclude(events, "replacement-executed");
          assert.notInclude(events, '"type":"stop"');
          assert.notInclude(events, '"type":"auth"');
          assert.equal(events.split('"type":"start"').length - 1, 1);
          yield* Effect.sync(() => process.kill(f.pid, 0));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        (
          [
            "unknown 1 2 0 0",
            "1.2.3 1 2 garbage garbage",
            "1.2.3 0 2 0 0",
            "1.2.3 1 -2 0 0",
            "1.2.3 01 2 0 0",
            "1.2.3-01 1 2 0 0",
            "1.2.3 1 2 0 1234",
          ] as const
        ).map((tokens) => ({ entry, tokens })),
      ),
    )("rejects malformed own tokens before $entry: $tokens", ({ entry, tokens }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: 1,
          orchestration: 2,
          ownTokens: tokens,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.include(String(result.failure), "Malformed candidate protocol output");
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["auth", "serve", "start", "stop"])
          assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "accepts own not-running tokens and exact legacy fallback for $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          for (const missingCommand of [false, true]) {
            const f = yield* makeProtocolFixture({
              live: false,
              kind: "managed",
              oldVersion: ARCHIVE.archiveVersion,
              ssh: 1,
              orchestration: 2,
              missingCommand,
            });
            // A legacy helper cannot inspect remembered state; test cold absence with no runtime/identity files.
            const result = yield* f.run(entry);
            assert.isTrue(Result.isSuccess(result));
            assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        [
          { ownTokens: "unknown 1 2 0 0" },
          { ownTokens: "1.2.3 1 2 garbage garbage" },
          { liveTokens: "live unknown 1 2 0 1234" },
          { liveTokens: "live 1.2.3 1 2 garbage garbage" },
        ].map((injected) => ({ entry, injected })),
      ),
    )("rejects malformed Node $entry tokens: $injected", ({ entry, injected }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: 1,
          orchestration: 2,
        });
        const cli = `${f.home}/fixture-cli.cjs`;
        yield* f.fs.writeFileString(
          cli,
          protocolExecutable(
            "1.2.3",
            {
              ssh: 1,
              orchestration: 2,
              ...injected,
            },
            f.state,
          ),
        );
        const scripts = yield* nativeScripts({ nodeScriptPath: cli });
        const key = f.state.slice(f.state.lastIndexOf("/") + 1);
        // nativeScripts' default key is an existing fixture constant; preserve all other script bytes.
        const script = scripts[entry].split("711bc738002d72fd").join(key);
        const before = yield* f.snapshot;
        const child = yield* f.realSpawner.spawn(
          ChildProcess.make("sh", ["-s", "--", key], {
            env: { HOME: f.home, PATH: process.env.PATH ?? "", LC_ALL: "C" },
            extendEnv: false,
            stdin: { stream: Stream.make(new TextEncoder().encode(script)), endOnDone: true },
          }),
        );
        const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString);
        assert.notEqual(Number(yield* child.exitCode), 0);
        assert.include(stderr, "Malformed");
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["auth", "start", "stop"]) assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        ["live unknown 1 2 0 1234", "live 1.2.3 1 2 garbage garbage"].map((liveTokens) => ({
          entry,
          liveTokens,
        })),
      ),
    )("rejects malformed archive live tokens before $entry: $liveTokens", ({ entry, liveTokens }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: 1,
          orchestration: 2,
          liveTokens,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["auth", "start", "stop"]) assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        ([{ missingCommand: true }, { ssh: 1 }, { ssh: 99, orchestration: 2 }] as const).map(
          (metadata) => ({ entry, metadata }),
        ),
      ),
    )("acquires exact $entry for dormant incompatible metadata $metadata", ({ entry, metadata }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ...metadata,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) assert.equal(result.success.version, ARCHIVE.archiveVersion);
        assert.equal(f.counters().uploads, 1);
        assert.equal(f.counters().gh, 0);
        assert.isAbove(f.counters().cacheReads, 0);
        const after = yield* f.snapshot;
        assert.equal(after.oldExecutable, before.oldExecutable);
        assert.equal(after.oldMarker, before.oldMarker);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "rejects explicit protocol mismatch at the exact requested $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: ARCHIVE.archiveVersion,
            ssh: 99,
            orchestration: 2,
          });
          const before = yield* f.snapshot;
          assert.isTrue(Result.isFailure(yield* f.run(entry)));
          assert.deepEqual(yield* f.snapshot, before);
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        (["goat", ".install-complete"] as const).map((remove) => ({ entry, remove })),
      ),
    )("rejects selected $remove disappearance before $entry", ({ entry, remove }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: 1,
          orchestration: 2,
        });
        const before = yield* f.snapshot;
        let removed = false;
        f.setBeforeCommand((script) => {
          if (removed || !script.includes('RUNNER_FILE="$STATE_DIR/run-t3.sh"')) return Effect.void;
          removed = true;
          return f.fs.remove(`${f.old}/${remove}`);
        });
        assert.isTrue(Result.isFailure(yield* f.run(entry)));
        assert.isTrue(removed);
        for (const file of ["run-t3.sh", "pid", "port", "managed"])
          assert.equal(yield* f.fs.readFileString(`${f.state}/${file}`), before[file]);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        assert.notInclude(events, '"type":"auth"');
        assert.notInclude(events, '"type":"stop"');
        const files = yield* f.fs.readDirectory(f.state);
        assert.isFalse(files.some((file) => file.includes(".next.") || file.endsWith(".pin")));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live(
      "validates and publishes the requested runtime before stopping its verified owned PID",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 99,
            orchestration: 2,
          });
          const before = yield* f.snapshot;
          const result = yield* f.run("launch");
          assert.isTrue(Result.isSuccess(result));
          if (Result.isSuccess(result))
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
          const after = yield* f.snapshot;
          assert.notEqual(after.pid, before.pid);
          assert.equal(after.oldExecutable, before.oldExecutable);
          assert.equal(after.oldMarker, before.oldMarker);
          const events = (yield* f.fs.readFileString(`${f.test}/events`))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const validation = events.findIndex(
            (event) => event.type === "version" && event.version === ARCHIVE.archiveVersion,
          );
          const stop = events.findIndex((event) => event.type === "stop");
          const start = events.findLastIndex((event) => event.type === "start");
          assert.isBelow(validation, stop);
          assert.isBelow(stop, start);
          assert.include(events[start].runner, `T3_ARCHIVE_VERSION='${ARCHIVE.archiveVersion}'`);
          assert.equal(f.counters().uploads, 1);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live(
      "cached manager auth pins its compatible release across resolver changes and rechecks both MCP attempts",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 1,
            orchestration: 2,
          });
          let current = { ...f.runner, archiveVersion: String(f.runner.archiveVersion) };
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.sync(() => current),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            current = { ...f.runner, archiveVersion: "9.9.9" };
            assert.equal(
              (yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true }))
                .pairingToken,
              "1.2.2",
            );
            yield* f.fs.writeFileString(`${f.test}/reject-ceiling`, "1");
            const session = yield* manager.issueMcpClientSession(uploadTarget, {
              label: "fixture",
              ttl: "1h",
              runtimeModeCeiling: "approval-required",
            });
            assert.equal(session.token, "1.2.2");
            assert.isFalse(session.runtimeModeCeilingApplied);
            const events = (yield* f.fs.readFileString(`${f.test}/events`))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            const auth = events
              .map((event, i) => ({ event, i }))
              .filter(({ event }) => event.type === "auth");
            assert.equal(auth.length, 3);
            for (const { event } of auth) assert.equal(event.version, "1.2.2");
            assert.isTrue(
              events
                .slice(auth[1]!.i + 1, auth[2]!.i)
                .some((event) => event.type === "protocol" && event.live),
            );
            yield* f.fs.remove(`${f.old}/goat`);
            assert.isTrue(
              Result.isFailure(
                yield* Effect.result(
                  manager.issueMcpClientSession(uploadTarget, {
                    label: "fixture",
                    ttl: "1h",
                    runtimeModeCeiling: null,
                  }),
                ),
              ),
            );
          }).pipe(Effect.provide(layer), Effect.scoped);
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["goat", ".install-complete"] as const)(
      "cold-mirror manager pins the installed archive before cached auth when %s disappears",
      (missing) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 9,
            orchestration: 9,
          });
          yield* f.fs.remove(`${f.state}/run-t3.sh`);
          const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
          const mirror = `${f.home}/mirror/v${ARCHIVE.archiveVersion}`;
          yield* f.fs.makeDirectory(mirror, { recursive: true });
          yield* f.fs.writeFile(
            `${mirror}/${stem}.tar.gz`,
            yield* f.fs.readFile(`${f.home}/cache/${stem}.tar.gz`),
          );
          yield* f.fs.writeFileString(
            `${mirror}/SHA256SUMS`,
            yield* f.fs.readFileString(`${f.home}/cache/${stem}.tar.gz.sha256`),
          );
          const bin = `${f.test}/bin`;
          yield* f.fs.makeDirectory(bin);
          const curl = yield* f.realSpawner.spawn(
            ChildProcess.make("sh", ["-c", "command -v curl"]),
          );
          const curlPath = (yield* curl.stdout.pipe(Stream.decodeText(), Stream.mkString)).trim();
          assert.equal(Number(yield* curl.exitCode), 0);
          yield* f.fs.writeFileString(
            `${bin}/curl`,
            `#!/bin/sh\nprintf 'download\\n' >> "$HOME/.test/downloads"\nexec ${JSON.stringify(curlPath)} "$@"\n`,
          );
          yield* f.fs.chmod(`${bin}/curl`, 0o700);
          f.setRemotePath(`${bin}:${process.env.PATH ?? ""}`);
          let current = {
            archiveVersion: String(ARCHIVE.archiveVersion),
            releaseBaseUrl: `file://${f.home}/mirror`,
          };
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.sync(() => current),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            const downloads = yield* f.fs.readFileString(`${f.test}/downloads`);
            assert.equal(downloads.trim().split("\n").length, 2);
            current = { ...current, archiveVersion: "9.9.9" };
            yield* f.fs.remove(
              `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/${missing}`,
            );
            const before = yield* f.snapshot;
            assert.isTrue(
              Result.isFailure(
                yield* Effect.result(
                  manager.ensureEnvironment(uploadTarget, { issuePairingToken: true }),
                ),
              ),
            );
            assert.isTrue(
              Result.isFailure(
                yield* Effect.result(
                  manager.issueMcpClientSession(uploadTarget, {
                    label: "fixture",
                    ttl: "1h",
                    runtimeModeCeiling: null,
                  }),
                ),
              ),
            );
            assert.deepEqual(yield* f.snapshot, before);
            assert.equal(yield* f.fs.readFileString(`${f.test}/downloads`), downloads);
            assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"auth"');
            assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
            assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
            assert.isFalse(yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/9.9.9`));
          }).pipe(Effect.provide(layer), Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (
        [
          "runtime command",
          "descriptor without PID identity",
          "unrelated PID",
          "unknown descriptor",
        ] as const
      ).flatMap((mode) =>
        (["disconnect", "shutdown"] as const).map((action) => ({ mode, action })),
      ),
    )("$action verifies ownership through $mode before stopping", ({ mode, action }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: 1,
          orchestration: 2,
        });
        const unrelated =
          mode === "unrelated PID"
            ? yield* f.realSpawner.spawn(
                ChildProcess.make(process.execPath, [
                  "-e",
                  'require("net").createServer().listen(0, "127.0.0.1", () => console.log("ready"))',
                ]),
              )
            : undefined;
        if (unrelated !== undefined)
          assert.equal(
            yield* unrelated.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.take(1),
              Stream.mkString,
            ),
            "ready",
          );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
          Layer.succeed(FileSystem.FileSystem, f.observedFs),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(f.runner),
            leaveRemoteServerRunning: false,
          }),
        );
        let before: Effect.Success<typeof f.snapshot> | undefined;
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            if (mode !== "unrelated PID") {
              const bin = `${f.test}/bin`;
              yield* f.fs.makeDirectory(bin);
              yield* f.fs.writeFileString(
                `${bin}/ps`,
                mode === "runtime command"
                  ? `#!/bin/sh\nprintf '%s\\n' "$HOME/.goat/runtime/goat/versions/1.2.2/goat serve --host 127.0.0.1 --port ${f.port} --base-dir $HOME/.goat"\n`
                  : "#!/bin/sh\nprintf 'unavailable command identity\\n'\n",
              );
              yield* f.fs.chmod(`${bin}/ps`, 0o700);
              f.setRemotePath(`${bin}:${process.env.PATH ?? ""}`);
            }
            if (mode === "unknown descriptor")
              yield* f.fs.writeFileString(`${f.test}/descriptor404`, "1");
            if (unrelated !== undefined)
              yield* f.fs.writeFileString(`${f.state}/pid`, `${unrelated.pid}\n`);
            before = yield* f.snapshot;
            if (action === "disconnect") yield* manager.disconnectEnvironment(uploadTarget);
          }).pipe(Effect.provide(layer), Effect.scoped),
        );
        const verified = mode === "runtime command";
        assert.equal(Result.isSuccess(result), verified || action === "shutdown");
        if (verified) {
          assert.notExists((yield* f.snapshot).pid);
          assert.include(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        } else {
          if (Result.isFailure(result))
            assert.include(result.failure.message, "ownership could not be verified");
          assert.deepEqual(yield* f.snapshot, before);
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
          if (unrelated !== undefined) assert.isTrue(yield* unrelated.isRunning);
          yield* Effect.sync(() => process.kill(f.pid, 0));
        }
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["disconnect", "shutdown"] as const).flatMap((action) =>
        [false, true].map((shim) => ({ action, shim })),
      ),
    )(
      "$action stops an old-entry Node server after reconnecting with a new entry; shim=$shim",
      ({ action, shim }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 1,
            orchestration: 2,
          });
          const entry = `${f.home}/dev's old entry.cjs`;
          const nextEntry = `${f.home}/new entry.cjs`;
          for (const file of [entry, nextEntry])
            yield* f.fs.writeFileString(
              file,
              protocolExecutable(
                "1.2.3",
                { ssh: 1, orchestration: 2, nodeReadiness: true },
                f.state,
              ),
            );
          if (shim) {
            const nodeBin = `${f.home}/.nvm/versions/node/v${process.versions.node} installation/bin`;
            yield* f.fs.makeDirectory(nodeBin, { recursive: true });
            yield* f.fs.writeFileString(
              `${nodeBin}/node`,
              `#!/bin/sh
if [ "$1" = - ] && [ "\${2:-}" = '${f.state}/port' ]; then printf 'pick-port\\n' >> "$HOME/.test/discovered-helpers"; fi
exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"
`,
            );
            yield* f.fs.chmod(`${nodeBin}/node`, 0o700);
            // This glob runs in both the runner and the launch parent's discovery.
            yield* f.fs.writeFileString(
              `${f.home}/.nvm/nvm.sh`,
              `for node_bin in "$HOME"/.nvm/versions/node/*/bin; do
PATH="$node_bin:$PATH"
done
export PATH
`,
            );
            f.setRemotePath("/usr/bin:/bin");
          }
          const layer = (nodeScriptPath: string, leaveRemoteServerRunning: boolean) =>
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
              Layer.succeed(FileSystem.FileSystem, f.observedFs),
              Layer.succeed(HttpClient.HttpClient, testHttpClient),
              Layer.succeed(NetService.NetService, testNetService),
              SshAuth.SshPasswordPrompt.disabledLayer,
              SshTunnel.SshEnvironmentManager.layer({
                resolveCliRunner: Effect.succeed({
                  nodeScriptPath,
                  nodeEngineRange: TEST_NODE_ENGINE_RANGE,
                }),
                leaveRemoteServerRunning,
              }),
            );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
          }).pipe(Effect.provide(layer(entry, true)), Effect.scoped);
          const pid = (yield* f.fs.readFileString(`${f.state}/pid`)).trim();
          const port = (yield* f.fs.readFileString(`${f.state}/port`)).trim();
          const identity = `${entry} serve --host 127.0.0.1 --port ${port} --base-dir ${f.home}/.goat\n`;
          assert.equal(yield* f.fs.readFileString(`${f.state}/identity`), identity);
          // Read real ps: the shim execs the native binary, not its own pathname.
          const ps = yield* f.realSpawner.spawn(
            ChildProcess.make("/bin/ps", ["-o", "command=", "-p", pid]),
          );
          const command = (yield* ps.stdout.pipe(Stream.decodeText(), Stream.mkString)).trim();
          assert.equal(Number(yield* ps.exitCode), 0);
          assert.equal(command, `${shim ? process.execPath : "node"} ${identity.trim()}`);
          if (shim)
            assert.equal(yield* f.fs.readFileString(`${f.test}/discovered-helpers`), "pick-port\n");
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            assert.equal(yield* f.fs.readFileString(`${f.state}/pid`), pid + "\n");
            assert.equal(yield* f.fs.readFileString(`${f.state}/identity`), identity);
            assert.include(yield* f.fs.readFileString(`${f.state}/run-t3.sh`), nextEntry);
            if (action === "disconnect") yield* manager.disconnectEnvironment(uploadTarget);
          }).pipe(Effect.provide(layer(nextEntry, false)), Effect.scoped);
          for (const file of ["pid", "port", "managed", "identity"])
            assert.isFalse(yield* f.fs.exists(`${f.state}/${file}`));
          assert.include(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([false, true])(
      "checks an old Node entry before publishing an upgrade; missing identity=%s",
      (missingIdentity) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 1,
            orchestration: 2,
          });
          const entry = `${f.home}/old entry.cjs`;
          const nextEntry = `${f.home}/new entry.cjs`;
          const executable = protocolExecutable(
            "1.2.3",
            { ssh: 1, orchestration: 2, nodeReadiness: true },
            f.state,
          );
          yield* f.fs.writeFileString(
            entry,
            executable.replace(
              "JSON.stringify(descriptor)",
              'JSON.stringify({...descriptor, sshRuntimeProtocolVersion: fs.existsSync(path.join(test, "incompatible-live")) ? 99 : 1})',
            ),
          );
          yield* f.fs.writeFileString(nextEntry, executable);
          const layer = (nodeScriptPath: string, leaveRemoteServerRunning: boolean) =>
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
              Layer.succeed(FileSystem.FileSystem, f.observedFs),
              Layer.succeed(HttpClient.HttpClient, testHttpClient),
              Layer.succeed(NetService.NetService, testNetService),
              SshAuth.SshPasswordPrompt.disabledLayer,
              SshTunnel.SshEnvironmentManager.layer({
                resolveCliRunner: Effect.succeed({
                  nodeScriptPath,
                  nodeEngineRange: TEST_NODE_ENGINE_RANGE,
                }),
                leaveRemoteServerRunning,
              }),
            );
          yield* Effect.gen(function* () {
            yield* (yield* SshTunnel.SshEnvironmentManager).ensureEnvironment(uploadTarget);
          }).pipe(Effect.provide(layer(entry, true)), Effect.scoped);
          const pid = (yield* f.fs.readFileString(`${f.state}/pid`)).trim();
          const record = `${f.home}/.goat/userdata/server-runtime.json`;
          const metadata = JSON.parse(yield* f.fs.readFileString(record));
          metadata.sshRuntimeProtocolVersion = 99;
          yield* f.fs.writeFileString(record, JSON.stringify(metadata));
          yield* f.fs.writeFileString(`${f.test}/incompatible-live`, "1");
          if (missingIdentity) yield* f.fs.remove(`${f.state}/identity`);
          const before = yield* f.snapshot;
          const bin = `${f.test}/real-ps-bin`;
          yield* f.fs.makeDirectory(bin);
          yield* f.fs.writeFileString(
            `${bin}/ps`,
            `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[3] === ${JSON.stringify(pid)}) fs.appendFileSync(${JSON.stringify(`${f.test}/inspections`)}, JSON.stringify({ runner: fs.readFileSync(${JSON.stringify(`${f.state}/run-t3.sh`)}, 'utf8'), identity: fs.readFileSync(${JSON.stringify(`${f.state}/identity`)}, 'utf8'), command: cp.execFileSync('/bin/ps', args, {encoding:'utf8'}).trim() }) + '\\n');
process.stdout.write(cp.execFileSync('/bin/ps', args));
`,
          );
          yield* f.fs.chmod(`${bin}/ps`, 0o700);
          f.setRemotePath(`${bin}:${process.env.PATH ?? ""}`);
          const result = yield* Effect.result(
            Effect.gen(function* () {
              yield* (yield* SshTunnel.SshEnvironmentManager).ensureEnvironment(uploadTarget);
            }).pipe(Effect.provide(layer(nextEntry, missingIdentity)), Effect.scoped),
          );
          if (missingIdentity) {
            assert.isTrue(Result.isFailure(result));
            if (Result.isFailure(result))
              assert.include(
                result.failure.message,
                "persisted launch identity is missing or mismatched",
              );
            assert.deepEqual(yield* f.snapshot, before);
            assert.isFalse(yield* f.fs.exists(`${f.test}/inspections`));
            assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
            yield* Effect.sync(() => process.kill(Number(pid), 0));
          } else {
            assert.isTrue(Result.isSuccess(result));
            const inspections = (yield* f.fs.readFileString(`${f.test}/inspections`))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            assert.lengthOf(inspections, 2);
            assert.include(inspections[0].runner, entry);
            assert.notInclude(inspections[0].runner, nextEntry);
            assert.include(inspections[1].runner, nextEntry);
            for (const inspection of inspections) {
              assert.equal(inspection.identity, before.identity);
              assert.equal(inspection.command, `node ${before.identity!.trim()}`);
            }
            const events = (yield* f.fs.readFileString(`${f.test}/events`))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            assert.lengthOf(
              events.filter((event) => event.type === "start"),
              2,
            );
            assert.lengthOf(
              events.filter((event) => event.type === "stop"),
              2,
            );
            for (const file of ["pid", "port", "managed", "identity"])
              assert.isFalse(yield* f.fs.exists(`${f.state}/${file}`));
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "reuses an exact live legacy descriptor for $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: ARCHIVE.archiveVersion,
          });
          const before = yield* f.snapshot;
          const result = yield* f.run(entry);
          assert.isTrue(Result.isSuccess(result));
          assert.deepEqual(yield* f.snapshot, before);
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        (
          ["external", "missing record", "broken record", "different PID", "nonloopback"] as const
        ).map((mode) => ({ entry, mode })),
      ),
    )("preserves incompatible $mode identity before $entry", ({ entry, mode }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: mode === "external" ? "external" : "managed",
          oldVersion: "1.2.2",
          ssh: 99,
          orchestration: 2,
        });
        const file = `${f.home}/.goat/userdata/server-runtime.json`;
        if (mode === "missing record") yield* f.fs.remove(file);
        if (mode === "broken record") yield* f.fs.writeFileString(file, "{");
        if (mode === "different PID")
          yield* f.fs.writeFileString(`${f.state}/pid`, `${f.pid + 1}\n`);
        if (mode === "nonloopback") {
          const record = JSON.parse(yield* f.fs.readFileString(file));
          yield* f.fs.writeFileString(
            file,
            JSON.stringify({ ...record, origin: `http://example.invalid:${f.port}` }),
          );
        }
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(yield* f.snapshot, before);
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        assert.notInclude(events, '"type":"stop"');
        assert.notInclude(events, '"type":"auth"');
        yield* Effect.sync(() => process.kill(f.pid, 0));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "runs explicit matching Node $entry with an ambient upstream home",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 1,
            orchestration: 2,
          });
          const upstream = `${f.home}/.t3`;
          yield* f.fs.makeDirectory(upstream, { recursive: true });
          yield* f.fs.writeFileString(`${upstream}/sentinel`, "upstream bytes");
          const cli = `${f.home}/dev.cjs`;
          yield* f.fs.writeFileString(
            cli,
            protocolExecutable("1.2.3", { ssh: 1, orchestration: 2, nodeReadiness: true }, f.state),
          );
          const scripts = yield* nativeScripts({ nodeScriptPath: cli });
          const key = f.state.slice(f.state.lastIndexOf("/") + 1);
          const child = yield* f.realSpawner.spawn(
            ChildProcess.make("sh", ["-s", "--", key], {
              env: {
                HOME: f.home,
                PATH: process.env.PATH ?? "",
                LC_ALL: "C",
                T3CODE_HOME: upstream,
              },
              extendEnv: false,
              stdin: {
                stream: Stream.make(
                  new TextEncoder().encode(scripts[entry].split("711bc738002d72fd").join(key)),
                ),
                endOnDone: true,
              },
            }),
          );
          const output = yield* Effect.all(
            {
              stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              code: child.exitCode,
            },
            { concurrency: "unbounded" },
          );
          assert.equal(Number(output.code), 0, output.stderr);
          assert.equal(yield* f.fs.readFileString(`${upstream}/sentinel`), "upstream bytes");
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
          const events = (yield* f.fs.readFileString(`${f.test}/events`))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          if (entry !== "launch") {
            const auth = events.findLast((event) => event.type === "auth");
            assert.equal(auth.version, "1.2.3");
            assert.equal(auth.args[auth.args.indexOf("--base-dir") + 1], `${f.home}/.goat`);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
