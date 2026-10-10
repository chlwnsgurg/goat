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
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
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
  const stem = `t3-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
  const stage = `${root}/stage/${stem}`;
  const directory = `${root}/mirror/v${ARCHIVE.archiveVersion}`;
  yield* fs.makeDirectory(stage, { recursive: true });
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(`${stage}/t3`, `#!/bin/sh\necho t3 v${ARCHIVE.archiveVersion}\n`);
  yield* fs.chmod(`${stage}/t3`, 0o700);
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

// Vite reformats Function.toString(); persistent script bytes use native Node.
const nativeScripts = Effect.fn("test.nativeScripts")(function* (
  input: SshTunnel.RemoteT3RunnerOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const moduleUrl = new URL("./tunnel.ts", import.meta.url).href;
  const script = `import * as t from ${JSON.stringify(moduleUrl)};
const input = ${JSON.stringify(input)};
console.log(JSON.stringify({ runner: t.buildRemoteT3RunnerScript(input), launch: t.buildRemoteLaunchScript(input), pairing: t.buildRemotePairingScript("711bc738002d72fd", input), upload: input.nodeScriptPath ? null : t.buildRemoteT3UploadInstallerScript(input, "A".repeat(64)) }));`;
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
  return JSON.parse(result.stdout) as {
    runner: string;
    launch: string;
    pairing: string;
    upload: string | null;
  };
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
  it("installs and runs the release archive without Node, npm, or npx", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);

    assert.include(script, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "T3_RELEASE_BASE_URL='https://github.com/pingdotgg/t3code/releases/download'",
    );
    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION"');
    assert.include(script, 'T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
    assert.include(script, "SHA256SUMS");
    assert.include(script, 'exec "$T3_RUNTIME_DIR/t3" "$@"');
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "t3@latest");
    assert.notInclude(script, 'exec t3 "$@"');
    // Concurrent launches serialize on a per-version mkdir lock and recheck
    // the completion marker after acquiring it.
    assert.include(
      script,
      'T3_LOCK="$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"',
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
      script.indexOf('"$T3_STAGING/t3" --version'),
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
      releaseBaseUrl: "https://mirror.example/t3/",
    });
    assert.include(launch, "T3_ARCHIVE_MODE=1");
    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/t3'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"');
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

    assert.include(
      launch,
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    assert.include(launch, "RUNNER_CHANGED=1");
    assert.include(launch, "ensure_remote_node_path()");
    assert.include(launch, "if ! ensure_remote_node_path; then");
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
      'if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ]',
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
    assert.include(launch, "resolve_default_runtime_port()");
    assert.include(launch, 'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port');
    assert.include(launch, "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))");
    assert.include(launch, 'PID_TO_STOP="${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"');
    assert.include(launch, 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(launch, 'rm -f "$PID_FILE"');
    assert.include(launch, "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(launch, 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      launch.indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      launch.indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      launch.indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      launch.indexOf('elif [ -n "$REMOTE_PID" ]'),
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
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
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
    const spawner = ChildProcessSpawner.make(() =>
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
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 800_000)),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE),
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
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
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
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.each(["successful stop", "failed stop"] as const)(
    "closes the tunnel scope and starts fresh after a %s",
    (mode) => {
      const spawnedCommands: Array<ReadonlyArray<string>> = [];
      let tunnelKillCount = 0;
      let stopCommandCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
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
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
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
        const spawner = ChildProcessSpawner.make((command) =>
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
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
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
  it.live("does not restart an existing managed server after runtime preparation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-preparation-" });
      const runtime = `${root}/.t3/runtime/versions/${ARCHIVE.archiveVersion}`;
      const state = `${root}/.t3/ssh-launch/711bc738002d72fd`;
      yield* fs.makeDirectory(runtime, { recursive: true });
      yield* fs.makeDirectory(state, { recursive: true });
      const cli = `${runtime}/t3`;
      yield* fs.writeFileString(
        cli,
        `#!${process.execPath}
import * as fs from "node:fs";
import * as net from "node:net";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("t3 v${ARCHIVE.archiveVersion}"); }
else if (args[0] === "__ssh-helper") {
  if (args[1] === "runtime-port") process.exit(1);
  if (args[1] === "pick-port") console.log(3773);
  if (args[1] === "wait-ready") {
    const socket = net.connect(Number(args[2]), "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); process.exit(0); });
    socket.on("error", () => process.exit(1));
  }
} else if (args[0] === "auth") { console.log(JSON.stringify({ credential: "fixture-pairing" })); }
else {
  fs.appendFileSync("${root}/starts", "start\\n");
  const server = net.createServer(socket => socket.end());
  process.on("SIGTERM", () => { fs.appendFileSync("${root}/stops", "stop\\n"); server.close(); });
  server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
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
      // Use the persisted heredoc bytes, including existing placeholder escaping.
      const persistedRunner =
        baseline.archive.launch.split("<<'SH'\n")[1]!.split("\nSH\n")[0]! + "\n";
      yield* fs.writeFileString(`${state}/run-t3.sh`, persistedRunner);
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
          ChildProcess.make("sh", remoteArgs, { env: { HOME: root }, stdin }),
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
      assert.isFalse(yield* fs.exists(`${root}/.t3/userdata/server-runtime.json`));
      assert.isTrue(yield* child.isRunning);
      yield* child.kill({ killSignal: "SIGTERM" });
      assert.equal(yield* child.exitCode, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.each([
    "uploads the local archive to a cold remote",
    "downloads when no local archive exists",
    "skips upload when the remote runtime is ready",
    "passes the same auth options to probe, upload and launch",
  ] as const)("%s", (name) =>
    Effect.gen(function* () {
      const fixture = yield* makeUploadFixture();
      const { root, directory, bytes, fs, spawner: realSpawner } = fixture;
      const ready = name === "skips upload when the remote runtime is ready";
      const missing = name === "downloads when no local archive exists";
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
            `${root}/.t3/runtime/versions/${ARCHIVE.archiveVersion}/.install-complete`,
          )).trim(),
          ARCHIVE.archiveVersion,
        );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("surfaces local archive preparation errors during pairing", () =>
    Effect.gen(function* () {
      const { directory, fs } = yield* makeUploadFixture();
      yield* fs.truncate(
        `${directory}/t3-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`,
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
      if (Result.isFailure(result)) assert.instanceOf(result.failure, SshLaunchError);
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
        ["probe", "upload", "probe", "upload", "launch", "probe", "pairing"],
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

  // A fake "executable" that answers --version, packed the way the release
  // workflow packs the real archive: one top-level directory named after the
  // stem, checksummed in SHA256SUMS.
  const makeMirror = Effect.fn("makeMirror")(function* (root: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = hostPlatform === "darwin" ? "darwin" : "linux";
    const arch = hostArch === "arm64" ? "arm64" : "x64";
    const stem = `t3-${archiveVersion}-${platform}-${arch}`;
    const stage = `${root}/stage/${stem}`;
    const release = `${root}/mirror/v${archiveVersion}`;
    const script = [
      "set -eu",
      `mkdir -p '${stage}' '${release}'`,
      `printf '#!/bin/sh\\necho t3 v${archiveVersion}\\n' > '${stage}/t3'`,
      `chmod +x '${stage}/t3'`,
      `tar -czf '${release}/${stem}.tar.gz' -C '${root}/stage' '${stem}'`,
      `cd '${release}' && (sha256sum '${stem}.tar.gz' 2>/dev/null || shasum -a 256 '${stem}.tar.gz') > SHA256SUMS`,
    ].join("\n");
    const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script]));
    assert.equal(Number(yield* child.exitCode), 0);
    return `file://${root}/mirror`;
  });

  it.effect.skipIf(windowsHost)("fails on an uploaded archive checksum mismatch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-upload-bad-" });
      yield* makeMirror(root);
      const platform = hostPlatform === "darwin" ? "darwin" : "linux";
      const arch = hostArch === "arm64" ? "arm64" : "x64";
      const bytes = yield* fs.readFile(
        `${root}/mirror/v${archiveVersion}/t3-${archiveVersion}-${platform}-${arch}.tar.gz`,
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
        yield* fs.exists(`${root}/.t3/runtime/versions/${archiveVersion}/.install-complete`),
      );
      assert.deepEqual(yield* fs.readDirectory(`${root}/.t3/runtime/versions`), []);
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
      const file = `${root}/mirror/v${archiveVersion}/t3-${archiveVersion}-${platform}-${arch}.tar.gz`;
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
        assert.include(result.stdout, `t3 v${archiveVersion}`);
      }
      const versions = `${root}/.t3/runtime/versions`;
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
          assert.include(result.stdout, `t3 v${archiveVersion}`);
        }
        const versionsDir = `${home}/.t3/runtime/versions`;
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
