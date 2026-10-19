// @effect-diagnostics nodeBuiltinImport:off - host identity is fixture data for POSIX lock owners.
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NetService from "@goat/shared/Net";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  ARCHIVE,
  uploadTarget,
  testHttpClient,
  testNetService,
  makeRunningProcess,
  installArchivePsDouble,
} from "./tunnel.fixture.ts";
import { makeProtocolFixture, protocolExecutable } from "./tunnel.protocol.fixture.ts";
import { SshReconnectCost } from "./command.ts";
import * as SshAuth from "./auth.ts";
import {
  launchOrReuseRemoteServer,
  SshEnvironmentManager,
  type PreparedRemoteRuntime,
} from "./tunnel.ts";

const fixture = makeProtocolFixture({
  live: true,
  kind: "managed",
  oldVersion: ARCHIVE.archiveVersion,
  commitTime: 1_700_000_000,
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
  candidateSignals: {
    ssh: SSH_RUNTIME_PROTOCOL_VERSION,
    orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    commitTime: 1_700_000_000,
    drain: true,
  },
});
type Fixture = Effect.Success<typeof fixture>;
const launch = (f: Fixture, previous?: PreparedRemoteRuntime, refresh = false) =>
  launchOrReuseRemoteServer(
    uploadTarget,
    {},
    { ...f.runner, cleanupTimeoutMs: 60_000, refreshOwnedRuntimeOnFirstConnection: refresh },
    undefined,
    previous,
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
    Effect.provideService(FileSystem.FileSystem, f.observedFs),
  );

const replaceLive = (f: Fixture, compatible: boolean) =>
  Effect.gen(function* () {
    const version = "9.0.0";
    const directory = `${f.home}/.goat/runtime/goat/versions/${version}`;
    yield* f.fs.makeDirectory(directory);
    yield* f.fs.writeFileString(
      `${directory}/goat`,
      protocolExecutable(
        version,
        {
          ssh: compatible ? SSH_RUNTIME_PROTOCOL_VERSION : SSH_RUNTIME_PROTOCOL_VERSION + 1,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        },
        f.state,
      ),
    );
    yield* f.fs.chmod(`${directory}/goat`, 0o700);
    yield* f.fs.writeFileString(`${directory}/.install-complete`, version + "\n");
    const child = yield* f.realSpawner.spawn(
      ChildProcess.make(`${directory}/goat`, ["serve", "--test-seed"], {
        env: { HOME: f.home },
        extendEnv: true,
      }),
    );
    const record = JSON.parse(
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.mkString,
      ),
    ) as { pid: number; port: number };
    assert.equal(record.pid, Number(child.pid));
    yield* installArchivePsDouble(f.home, record.pid, record.port, version);
    yield* f.fs.writeFileString(`${f.state}/pid`, `${record.pid}\n`);
    yield* f.fs.writeFileString(`${f.state}/port`, `${record.port}\n`);
    yield* f.fs.writeFileString(
      `${f.state}/identity`,
      `${directory}/goat serve --host 127.0.0.1 --port ${record.port} --base-dir ${f.home}/.goat\n`,
    );
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH folded reconnect probe",
  () => {
    it.live.each(["same", "unreadable", "different"])(
      "a folded attach fences an uncertain drain for the %s instance",
      (instance) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: ARCHIVE.archiveVersion,
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          assert.equal(f.remoteCommands.length, 2);
          if (first.status !== "ready") return;
          const runtime = JSON.parse(
            yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
          ) as { instanceId: string };
          yield* f.fs.writeFileString(
            `${f.state}/draining`,
            instance === "same"
              ? runtime.instanceId
              : instance === "unreadable"
                ? ""
                : "previous-instance",
          );
          const before = f.remoteCommands.length;
          const result = yield* launch(f, first.selectedRuntime);
          assert.equal(result.status, instance === "different" ? "ready" : "pending");
          assert.equal(f.remoteCommands.length - before, 1);
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"drain"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live.each(["busy", "unknown", "cancelled"])(
      "keeps the one-command attach and deferred intent after %s refresh",
      (reason) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.fs.writeFileString(
            `${f.test}/activity`,
            reason === "cancelled" ? "idle" : reason,
          );
          if (reason === "cancelled") yield* f.fs.writeFileString(`${f.test}/drain`, reason);
          yield* f.shiftHostClock(60);
          const first = yield* launch(f, undefined, true);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          assert.equal(first.pending?.reason, reason === "cancelled" ? "busy" : reason);
          assert.isString(first.selectedRuntime.reconnectProbe);
          // Becoming idle must not turn a transport reconnect into an early replacement.
          yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
          const snapshot = yield* f.snapshot;
          const before = f.remoteCommands.length;
          const second = yield* launch(f, first.selectedRuntime);
          assert.equal(f.remoteCommands.length - before, 1);
          assert.equal(second.status, "ready");
          if (second.status !== "ready") return;
          assert.deepEqual(second.pending, first.pending);
          assert.equal(second.selectedRuntime.version, "1.2.2");
          assert.isString(second.selectedRuntime.reconnectProbe);
          assert.deepEqual(yield* f.snapshot, snapshot);
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"self-stop"');
          const lock = `${f.home}/.goat/ssh-launch/replacement.lock`;
          const owner = "other-host|0|1|old|fixture";
          yield* f.fs.symlink(owner, lock);
          const beforeContended = f.remoteCommands.length;
          const contended = yield* launch(f, second.selectedRuntime);
          assert.equal(contended.status, "pending");
          assert.equal(contended.pending?.reason, "contended");
          assert.equal(f.remoteCommands.length - beforeContended, 1);
          assert.equal(yield* f.fs.readLink(lock), owner);
          assert.deepEqual(yield* f.snapshot, snapshot);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live.each([ARCHIVE.archiveVersion, "1.2.2"])(
      "folds probe and launch into one command and reuses host facts for %s",
      (version) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: version,
            commitTime: 1_700_000_000,
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          assert.isString(first.selectedRuntime.reconnectProbe);
          const commands = f.remoteCommands.length;
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          const readinessEvent =
            JSON.stringify({
              type: "exec",
              version,
              args: ["__ssh-helper", "wait-ready", String(first.remotePort), "60000", "1000"],
            }) + "\n";
          const reconnectEvents = f.fs.readFileString(`${f.test}/events`).pipe(
            Effect.map((current) => {
              assert.equal(current.slice(0, events.length), events);
              return current.slice(events.length);
            }),
          );
          const cost = {
            active: true,
            spawns: 0,
            authentications: 0,
            steps: {} as Record<string, number>,
          };
          const second = yield* launch(f, first.selectedRuntime).pipe(
            Effect.provideService(SshReconnectCost, cost),
          );
          assert.equal(second.status, "ready");
          assert.equal(f.remoteCommands.length - commands, 1);
          assert.equal(yield* reconnectEvents, readinessEvent);
          assert.property(cost.steps, "runtime-probe-folded");
          if (second.status !== "ready") return;
          const beforeThird = f.remoteCommands.length;
          const third = yield* launch(f, second.selectedRuntime);
          assert.equal(third.status, "ready");
          assert.equal(f.remoteCommands.length - beforeThird, 1);
          assert.equal(yield* reconnectEvents, readinessEvent + readinessEvent);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live.each([0, 1, 60])(
      "folds the first reconnect after install using warmed facts (age %s s at cleanup)",
      (age) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: ARCHIVE.archiveVersion,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
            candidateSignals: {
              ssh: SSH_RUNTIME_PROTOCOL_VERSION,
              orchestration: ORCHESTRATION_PROTOCOL_VERSION,
              commitTime: 1_700_000_000,
              drain: true,
            },
          });
          yield* f.fs.remove(f.old, { recursive: true });
          yield* f.fs.remove(`${f.state}/run-t3.sh`);
          yield* f.shiftHostClock(age, true);
          const installed = yield* launch(f);
          assert.equal(installed.status, "ready");
          if (installed.status !== "ready") return;
          assert.isString(installed.selectedRuntime.reconnectProbe);
          assert.equal(f.counters().uploads, 1);
          const runtime = JSON.parse(
            yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
          ) as { pid: number };
          yield* installArchivePsDouble(
            f.home,
            runtime.pid,
            installed.remotePort,
            ARCHIVE.archiveVersion,
          );
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          const before = f.remoteCommands.length;
          yield* f.shiftHostClock(60, true);
          const reconnected = yield* launch(f, installed.selectedRuntime);
          assert.equal(reconnected.status, "ready");
          if (reconnected.status !== "ready") return;
          assert.equal(reconnected.remotePort, installed.remotePort);
          assert.equal(f.remoteCommands.length - before, 1);
          assert.equal(
            (yield* f.fs.readFileString(`${f.test}/events`)).slice(events.length),
            JSON.stringify({
              type: "exec",
              version: ARCHIVE.archiveVersion,
              args: ["__ssh-helper", "wait-ready", String(installed.remotePort), "60000", "1000"],
            }) + "\n",
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live.each(["readiness", "launch"] as const)(
      "propagates an unchanged selection's %s failure without a second launch",
      (failure) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          if (failure === "readiness") {
            yield* f.fs.writeFileString(
              `${f.old}/goat`,
              (yield* f.fs.readFileString(`${f.old}/goat`)).replace(
                "// Fixture readiness uses an event, not polling or a delay.",
                `if (fs.existsSync(path.join(test, "readiness-fail"))) {
  fs.appendFileSync(path.join(test, "readiness-attempts"), "failed\\n");
  process.stderr.write("fixture readiness failed\\n"); process.exit(23);
}`,
              ),
            );
          }
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          assert.isString(first.selectedRuntime.reconnectProbe);
          if (failure === "readiness") {
            yield* f.fs.writeFileString(`${f.test}/readiness-fail`, "");
          } else {
            f.setScriptPrefix(`sh() {
  if [ "\${3:-}" = runtime ]; then
    printf 'fixture launch failed\\n' >&2; return 23
  fi
  command sh "$@"
}
`);
          }
          const before = f.remoteCommands.length;
          const result = yield* Effect.result(launch(f, first.selectedRuntime));
          assert.equal(result._tag, "Failure");
          assert.equal(f.remoteCommands.length - before, 1);
          if (failure === "readiness") {
            assert.equal(yield* f.fs.readFileString(`${f.test}/readiness-attempts`), "failed\n");
          }
          const ordinary = yield* Effect.result(launch(f));
          assert.equal(ordinary._tag, "Failure");
          if (result._tag !== "Failure" || ordinary._tag !== "Failure") return;
          assert.equal(result.failure._tag, "SshCommandError");
          assert.equal(ordinary.failure._tag, "SshCommandError");
          if (
            result.failure._tag !== "SshCommandError" ||
            ordinary.failure._tag !== "SshCommandError"
          )
            return;
          assert.equal(result.failure.exitCode, failure === "readiness" ? 1 : 23);
          assert.equal(result.failure.exitCode, ordinary.failure.exitCode);
          assert.equal(result.failure.stderr, ordinary.failure.stderr);
          assert.equal(result.failure.message, ordinary.failure.message);
          assert.equal(
            result.failure.stderr,
            failure === "readiness"
              ? "fixture readiness failed\nSelected live server did not answer; it was left running.\n"
              : "fixture launch failed\n",
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live.each(["executable", "runner", "runtime record", "identity"] as const)(
      "reprobes a changed %s and preserves ordinary launch behavior",
      (changed) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          assert.isString(first.selectedRuntime.reconnectProbe);
          if (changed === "executable") {
            yield* f.fs.writeFileString(
              `${f.old}/goat`,
              (yield* f.fs.readFileString(`${f.old}/goat`)) + "\n// rebuilt\n",
            );
          } else if (changed === "runner") {
            yield* f.fs.writeFileString(
              `${f.state}/run-t3.sh`,
              (yield* f.fs.readFileString(`${f.state}/run-t3.sh`)) + "\n# changed\n",
            );
          } else if (changed === "runtime record") {
            const file = `${f.home}/.goat/userdata/server-runtime.json`;
            yield* f.fs.writeFileString(
              file,
              (yield* f.fs.readFileString(file)).replace(
                '"startedAt":',
                '"observed":true,"startedAt":',
              ),
            );
          } else {
            yield* f.fs.remove(`${f.state}/identity`);
          }
          const commands = f.remoteCommands.length;
          const result = yield* Effect.result(launch(f, first.selectedRuntime));
          const count = f.remoteCommands.length - commands;
          const ordinary = yield* Effect.result(launch(f));
          assert.equal(count, 2);
          assert.equal(result._tag, ordinary._tag);
          if (result._tag === "Failure" && ordinary._tag === "Failure") {
            assert.equal(result.failure.message, ordinary.failure.message);
          } else if (result._tag === "Success" && ordinary._tag === "Success") {
            assert.equal(result.success.status, ordinary.success.status);
            if (result.success.status === "ready" && ordinary.success.status === "ready") {
              assert.equal(result.success.remotePort, ordinary.success.remotePort);
              assert.equal(
                result.success.selectedRuntime.version,
                ordinary.success.selectedRuntime.version,
              );
            }
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live.each(["none", "foreign", "live"] as const)(
      "a stale manager entry reconnects and creates a forward (replacement lock held=%s)",
      (contended) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          let forwardAlive = true;
          let forwards = 0;
          const transport = ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.args.includes("-N")) {
              forwardAlive = true;
              forwards++;
              return Effect.succeed({
                ...makeRunningProcess(() => undefined),
                isRunning: Effect.sync(() => forwardAlive),
              });
            }
            return f.transport.spawn(command);
          });
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed(f.runner),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            const lock = `${f.home}/.goat/ssh-launch/replacement.lock`;
            const owner =
              contended === "live"
                ? `${NodeOS.hostname()}|${process.getuid!()}|${process.pid}|${NodeChildProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).replace(/\n$/, "")}|fixture`
                : "other-client|0|1|old|fixture";
            if (contended !== "none") yield* f.fs.symlink(owner, lock);
            if (contended === "live") {
              // Account for the production waits without sleeping in the test. An executable
              // double is inherited by both shells, so a repeated nested wait is observable.
              yield* f.fs.writeFileString(
                `${f.test}/identity-bin/sleep`,
                '#!/bin/sh\nprintf "%s\\n" "$1" >> "$HOME/.test/lock-waits"\n',
              );
              yield* f.fs.chmod(`${f.test}/identity-bin/sleep`, 0o700);
            }
            const ordinary = contended !== "none" ? yield* launch(f) : undefined;
            if (ordinary !== undefined) {
              assert.equal(ordinary.status, "ready");
              assert.isUndefined(ordinary.pending);
            }
            const snapshot = yield* f.snapshot;
            const commands = f.remoteCommands.length;
            if (contended === "live") yield* f.fs.writeFileString(`${f.test}/lock-waits`, "");
            forwardAlive = false;
            const cost = {
              active: true,
              spawns: 0,
              authentications: 0,
              steps: {} as Record<string, number>,
            };
            const startedAt = yield* Clock.currentTimeMillis;
            const result = yield* manager
              .ensureEnvironment(uploadTarget)
              .pipe(Effect.provideService(SshReconnectCost, cost));
            assert.isFalse("type" in result);
            if ("type" in result) return;
            assert.equal(result.remotePort, f.port);
            assert.isUndefined(result.pendingReplacement);
            assert.equal(forwards, 2);
            assert.equal(f.remoteCommands.length - commands, 1);
            assert.property(cost.steps, "runtime-probe-folded");
            assert.deepEqual(yield* f.snapshot, snapshot);
            if (contended === "live") {
              const waits = (yield* f.fs.readFileString(`${f.test}/lock-waits`))
                .trim()
                .split("\n")
                .map(Number);
              assert.lengthOf(waits, 50, "the folded command shares one lock wait budget");
              const transportMs = (f.remoteCommands.length - commands) * 2_000;
              const elapsedMs =
                (yield* Clock.currentTimeMillis) -
                startedAt +
                waits.reduce((sum, seconds) => sum + seconds * 1_000, 0) +
                transportMs;
              assert.isAtMost(elapsedMs, 15_000, "fits initial setup with 2 s per command latency");
            }
            if (contended !== "none") {
              assert.equal(yield* f.fs.readLink(lock), owner);
              yield* f.fs.remove(lock);
            }
            for (const options of [{ refreshRuntime: true }, { confirmReplacement: true }]) {
              forwardAlive = false;
              const before = f.remoteCommands.length;
              yield* manager.ensureEnvironment(uploadTarget, options);
              assert.equal(f.remoteCommands.length - before, 2);
            }
          }).pipe(Effect.provide(layer), Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live(
      "a stale manager reconnect folds a deferred refresh without clearing its intent",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
          yield* f.shiftHostClock(60);
          let alive = true;
          let forwards = 0;
          const transport = ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.args.includes("-N")) {
              alive = true;
              forwards++;
              return Effect.succeed({
                ...makeRunningProcess(() => undefined),
                isRunning: Effect.sync(() => alive),
              });
            }
            return f.transport.spawn(command);
          });
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({
                ...f.runner,
                refreshOwnedRuntimeOnFirstConnection: true,
              }),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshEnvironmentManager;
            const first = yield* manager.ensureEnvironment(uploadTarget);
            if ("type" in first) throw new Error("Expected attached deferred refresh");
            assert.equal(first.pendingReplacement?.reason, "busy");
            const before = f.remoteCommands.length;
            alive = false;
            yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
            const second = yield* manager.ensureEnvironment(uploadTarget);
            if ("type" in second) throw new Error("Expected reattached deferred refresh");
            assert.deepEqual(second.pendingReplacement, first.pendingReplacement);
            assert.equal(second.remoteServerVersion, "1.2.2");
            assert.equal(forwards, 2);
            assert.equal(f.remoteCommands.length - before, 1);
          }).pipe(Effect.provide(layer), Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live.each([true, false])(
      "reprobes a newer live runtime (compatible=%s)",
      (compatible) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          yield* replaceLive(f, compatible);
          const before = f.remoteCommands.length;
          const result = yield* Effect.result(launch(f, first.selectedRuntime));
          assert.equal(f.remoteCommands.length - before, compatible ? 2 : 1);
          const ordinary = yield* Effect.result(launch(f));
          assert.equal(result._tag, ordinary._tag);
          if (result._tag === "Failure" && ordinary._tag === "Failure") {
            assert.equal(result.failure._tag, "SshLaunchError");
            assert.equal("reason" in result.failure && result.failure.reason, "runtime-newer");
            assert.equal(result.failure.message, ordinary.failure.message);
          } else if (result._tag === "Success" && ordinary._tag === "Success") {
            assert.equal(result.success.status, "ready");
            if (result.success.status !== "ready" || ordinary.success.status !== "ready") return;
            assert.equal(result.success.selectedRuntime.version, "9.0.0");
            assert.equal(
              result.success.selectedRuntime.updateBlocked,
              ordinary.success.selectedRuntime.updateBlocked,
            );

            assert.isString(result.success.selectedRuntime.updateBlocked);
            assert.isUndefined(result.success.selectedRuntime.reconnectProbe);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live(
      "a host change between folded probe and launch falls back without replacing anything",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          f.setScriptPrefix(`sh() {
      if [ -f "$HOME/.test/probed" ] && [ ! -f "$HOME/.test/raced" ]; then
        printf 'changed identity\\n' > "$HOME/.goat/ssh-launch/runtime/identity"
        touch "$HOME/.test/raced"
      fi
      touch "$HOME/.test/probed"
      command sh "$@"
    }
    `);
          const before = f.remoteCommands.length;
          const result = yield* Effect.result(launch(f, first.selectedRuntime));
          assert.equal(result._tag, "Failure");
          assert.equal(f.remoteCommands.length - before, 3);
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.notInclude(events, '"type":"drain"');
          assert.notInclude(events, '"type":"stop"');
          assert.equal(events.split('"type":"start"').length - 1, 1);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );

    it.live(
      "a vanished selection reinstalls only the requested runtime, then cleans up separately",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          yield* f.fs.remove(`${f.old}/.install-complete`);
          const unverified = `${f.home}/.goat/runtime/goat/versions/8.0.0`;
          yield* f.fs.makeDirectory(unverified);
          yield* f.fs.writeFileString(`${unverified}/.install-complete`, "8.0.0\n");
          yield* f.fs.writeFileString(
            `${unverified}/.install-record`,
            `8.0.0 ${"a".repeat(64)} ${"b".repeat(64)} cache\n`,
          );
          yield* f.fs.writeFileString(
            `${unverified}/goat`,
            '#!/bin/sh\ntouch "$HOME/.test/unverified-executed"\nexit 1\n',
          );
          yield* f.fs.chmod(`${unverified}/goat`, 0o700);
          const before = f.remoteCommands.length;
          const result = yield* launch(f, first.selectedRuntime);
          assert.equal(result.status, "ready");
          if (result.status !== "ready") return;
          assert.equal(result.selectedRuntime.version, ARCHIVE.archiveVersion);
          assert.isString(result.selectedRuntime.reconnectProbe);
          assert.isFalse(yield* f.fs.exists(`${f.test}/unverified-executed`));
          assert.equal(f.counters().uploads, 1);
          assert.equal(f.remoteCommands.length - before, 4);
          const cleanup = f.remoteCommands.at(-1)!;
          assert.equal(cleanup._tag, "StandardCommand");
          if (cleanup._tag === "StandardCommand")
            assert.include(cleanup.args, "goat-runtime-cleanup");
          const reconnected = f.remoteCommands.length;
          yield* launch(f, result.selectedRuntime);
          assert.equal(f.remoteCommands.length - reconnected, 1);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      180_000,
    );
  },
);
