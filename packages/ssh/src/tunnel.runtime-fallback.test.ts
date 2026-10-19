import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { REMOTE_RUNTIME_STATE_KEY, runSshCommand } from "./command.ts";
import { SshLaunchError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  ARCHIVE,
  makeSuccessfulProcess,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";
import { makeProtocolFixture, protocolExecutable } from "./tunnel.protocol.fixture.ts";

afterEach(() => vi.unstubAllGlobals());

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime archive fallback",
  () => {
    it.live.each([
      ["no-record", "1.2.2"],
      ["mismatch", "1.2.2"],
      ["verified", "1.2.4"],
      ["verified-start", "1.2.4"],
      ["unordered", "1.2.2"],
      ["incompatible", "1.2.2"],
      ["exact-available", ARCHIVE.archiveVersion],
      ["live", "1.2.2"],
    ] as const)("recovers only verified ordered compatible installations: %s", ([kind, expected]) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: kind === "live",
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const candidateVersion = kind === "unordered" ? "1.2.3-dev.abcdef0" : "1.2.4";
        const dir = `${f.home}/.goat/runtime/goat/versions/${candidateVersion}`;
        yield* f.fs.makeDirectory(dir);
        const executable = protocolExecutable(
          candidateVersion,
          {
            ssh: kind === "incompatible" ? 99 : SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
            commitTime: 1_792_000_200,
          },
          f.state,
        );
        // Every invocation leaves evidence, including --version and protocol probes.
        yield* f.fs.writeFileString(
          `${dir}/goat`,
          executable.replace(
            "(async () => {",
            `(async () => { require("node:fs").appendFileSync(${JSON.stringify(`${f.test}/candidate-executed`)}, "called\\n");`,
          ),
        );
        yield* f.fs.chmod(`${dir}/goat`, 0o700);
        yield* f.fs.writeFileString(`${dir}/.install-complete`, candidateVersion + "\n");
        if (kind !== "no-record") {
          const crypto = yield* Crypto.Crypto;
          const digest = Hex.encode(
            yield* crypto.digest("SHA-256", yield* f.fs.readFile(`${dir}/goat`)),
          );
          yield* f.fs.writeFileString(
            `${dir}/.install-record`,
            `${candidateVersion} ${"a".repeat(64)} ${kind === "mismatch" ? "b".repeat(64) : digest} cache\n`,
          );
        }
        const selected = yield* SshTunnel.prepareRemoteRuntime(
          uploadTarget,
          {},
          {
            ...f.runner,
            archiveDirectory: kind === "exact-available" ? f.runner.archiveDirectory : "",
          },
          REMOTE_RUNTIME_STATE_KEY,
          true,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
        assert.equal(selected.version, expected);
        if (kind === "no-record" || kind === "mismatch")
          assert.isFalse(yield* f.fs.exists(`${f.test}/candidate-executed`));
        if (kind === "verified") {
          assert.equal(selected.source, "installed");
          assert.isFalse(selected.mayUpgradeOwnedServer);
          assert.match(selected.installedExecutableSha256 ?? "", /^[0-9a-f]{64}$/);
          // A changed executable must fail before its first instruction on launch.
          yield* f.fs.remove(`${f.test}/candidate-executed`);
          yield* f.fs.writeFileString(
            `${dir}/goat`,
            executable.replace(
              "(async () => {",
              `(async () => { require("node:fs").writeFileSync(${JSON.stringify(`${f.test}/tampered-executed`)}, "bad");`,
            ),
          );
          const script = SshTunnel.buildRemoteLaunchScript(selected.runner, selected);
          const result = yield* runSshCommand(uploadTarget, {
            remoteCommandArgs: ["sh", "-s", "--", REMOTE_RUNTIME_STATE_KEY],
            stdin: script,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            Effect.result,
          );
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result))
            assert.include(result.failure.message, "Recorded GOAT executable changed since probe");
          assert.isFalse(yield* f.fs.exists(`${f.test}/tampered-executed`));
        }
        if (kind === "verified-start") {
          const launched = yield* SshTunnel.launchOrReuseRemoteServer(
            uploadTarget,
            {},
            {
              ...f.runner,
              archiveDirectory: "",
            },
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
          assert.equal(launched.status, "ready");
          if (launched.status === "ready")
            assert.equal(launched.selectedRuntime.version, candidateVersion);
          assert.include(yield* f.fs.readFileString(`${f.state}/run-t3.sh`), candidateVersion);
        }
        if (kind === "exact-available") {
          assert.equal(selected.source, "requested");
          const record = yield* f.fs.readFileString(
            `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-record`,
          );
          const crypto = yield* Crypto.Crypto;
          const digest = Hex.encode(
            yield* crypto.digest(
              "SHA-256",
              yield* f.fs.readFile(
                `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/goat`,
              ),
            ),
          );
          const archiveName = (yield* f.fs.readDirectory(f.runner.archiveDirectory)).find((name) =>
            name.endsWith(".sha256"),
          );
          assert.isDefined(archiveName);
          const archiveDigest = (yield* f.fs.readFileString(
            `${f.runner.archiveDirectory}/${archiveName}`,
          )).split(" ")[0];
          assert.deepEqual(record.trim().split(" "), [
            ARCHIVE.archiveVersion,
            archiveDigest,
            digest,
            "cache",
          ]);
          assert.isUndefined(selected.upgradeFailure);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("bounds discovery to eight records and selects by build order rather than mtime", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const crypto = yield* Crypto.Crypto;
        const calls = `${f.test}/candidate-calls`;
        yield* f.fs.makeDirectory(calls);
        // The newest build has the oldest record; all ten are newer than retained/client.
        for (let patch = 10; patch >= 1; patch--) {
          const version = `1.3.${patch}`;
          const dir = `${f.home}/.goat/runtime/goat/versions/${version}`;
          yield* f.fs.makeDirectory(dir);
          const executable = protocolExecutable(
            version,
            {
              ssh: SSH_RUNTIME_PROTOCOL_VERSION,
              orchestration: ORCHESTRATION_PROTOCOL_VERSION,
            },
            f.state,
          ).replace(
            "(async () => {",
            `(async () => { require("node:fs").writeFileSync(${JSON.stringify(`${calls}/${version}`)}, "called");`,
          );
          yield* f.fs.writeFileString(`${dir}/goat`, executable);
          yield* f.fs.chmod(`${dir}/goat`, 0o700);
          yield* f.fs.writeFileString(`${dir}/.install-complete`, version + "\n");
          const digest = Hex.encode(
            yield* crypto.digest("SHA-256", yield* f.fs.readFile(`${dir}/goat`)),
          );
          yield* f.fs.writeFileString(
            `${dir}/.install-record`,
            `${version} ${"a".repeat(64)} ${digest} bundle\n`,
          );
        }
        const selected = yield* SshTunnel.prepareRemoteRuntime(
          uploadTarget,
          {},
          {
            ...f.runner,
            archiveDirectory: "",
          },
          REMOTE_RUNTIME_STATE_KEY,
          true,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
        const invoked = yield* f.fs.readDirectory(calls);
        assert.lengthOf(invoked, 8);
        const newestInvoked = Math.max(...invoked.map((version) => Number(version.split(".")[2])));
        assert.equal(selected.version, `1.3.${newestInvoked}`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("fails an upload instead of starting a compatible retained runtime", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const before = yield* f.snapshot;
        let uploads = 0;
        const transport = ChildProcessSpawner.make((command) => {
          if (
            command._tag === "StandardCommand" &&
            command.args.some((arg) => arg.includes("GOAT_SSH_UPLOADED_ARCHIVE"))
          ) {
            uploads++;
            return Effect.succeed({
              ...makeSuccessfulProcess(""),
              stderr: Stream.make(new TextEncoder().encode("No space left on device")),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            });
          }
          return f.transport.spawn(command);
        });
        const result = yield* SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, f.runner).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, transport),
          Effect.result,
        );
        assert.equal(uploads, 1);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshLaunchError);
          assert.include(result.failure.message, "Uploading the runtime archive failed (exit 1)");
          assert.include(result.failure.message, "No space left on device");
        }
        assert.deepEqual(yield* f.snapshot, before);
        assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"start"');
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([true, false])("disables replacement for fallback; live=%s", (live) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live,
          kind: "managed",
          oldVersion: "1.2.2",
          drain: true,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const selected = yield* SshTunnel.prepareRemoteRuntime(
          uploadTarget,
          {},
          { ...f.runner, archiveDirectory: "", refreshOwnedRuntimeOnFirstConnection: true },
          REMOTE_RUNTIME_STATE_KEY,
          true,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
        assert.equal(selected.version, "1.2.2");
        assert.isFalse(selected.mayUpgradeOwnedServer);
        assert.isFalse(selected.refreshIfIdle);
        assert.isUndefined(selected.expectedLiveVersion);
        assert.isUndefined(selected.expectedLiveRunnerSha256);
        assert.equal(selected.upgradeFailure?.archive?.requestedVersion, ARCHIVE.archiveVersion);
        assert.include(
          selected.upgradeFailure?.fix.instruction ?? "",
          "Using compatible GOAT 1.2.2.",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "attaches to a same-core 0.1.0-dev.<sha> runtime when unpublished v0.1.0 cannot be acquired",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "0.1.0-dev.637a98351",
            commitTime: 1_792_000_000,
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          const before = yield* f.snapshot;
          let httpsRequests = 0;
          let ghRequests = 0;
          vi.stubGlobal("fetch", async () => {
            httpsRequests++;
            return new Response(null, { status: 404 });
          });
          const transport = ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.command === "gh") {
              ghRequests++;
              return Effect.succeed({
                ...makeSuccessfulProcess("release not found"),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              });
            }
            return f.transport.spawn(command);
          });
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({
                ...f.runner,
                archiveVersion: "0.1.0",
                archiveCommitTime: 1_792_000_100,
                archiveDirectory: `${f.home}/missing-archives`,
                refreshOwnedRuntimeOnFirstConnection: true,
              }),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            const ensured = yield* manager.ensureEnvironment(uploadTarget, {
              issuePairingToken: true,
              keyOnly: true,
            });
            assert.equal(httpsRequests, 1);
            assert.equal(ghRequests, 1);
            assert.notProperty(ensured, "type");
            if (!("type" in ensured)) {
              assert.equal(ensured.remotePort, f.port);
              assert.equal(ensured.remoteServerVersion, "0.1.0-dev.637a98351");
            }
            const status = (yield* manager.status(uploadTarget)).status;
            assert.equal(status?.requestedVersion, "0.1.0");
            assert.equal(status?.runtimeVersion, "0.1.0-dev.637a98351");
            assert.equal(status?.failure?.reason, "archive_unavailable");
            assert.equal(status?.failure?.archive?.requestedVersion, "0.1.0");
            assert.include(
              status?.failure?.fix.instruction ?? "",
              "Using compatible GOAT 0.1.0-dev.637a98351. GOAT 0.1.0 runtime archive is unavailable.",
            );
          }).pipe(Effect.provide(layer), Effect.scoped);
          assert.deepEqual(yield* f.snapshot, before);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      "live-compatible",
      "live-incompatible",
      "live-legacy",
      "stopped-compatible",
      "stopped-uninstalled",
      "stopped-incompatible",
    ] as const)("missing HTTPS release and failed gh acquisition with a %s runtime", (state) =>
      Effect.gen(function* () {
        const live = state.startsWith("live-");
        const installed = state !== "stopped-uninstalled";
        const fallback = state === "live-compatible" || state === "stopped-compatible";
        const f = yield* makeProtocolFixture({
          live,
          kind: "managed",
          oldVersion: "1.2.2",
          drain: true,
          ssh: state.endsWith("incompatible") ? 99 : SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        if (state === "live-legacy") yield* f.fs.remove(`${f.state}/identity`);
        if (!installed) {
          yield* f.fs.remove(f.old, { recursive: true });
          yield* f.fs.remove(`${f.state}/run-t3.sh`);
        }
        const before = installed ? yield* f.snapshot : undefined;
        let httpsRequests = 0;
        let ghRequests = 0;
        vi.stubGlobal("fetch", async () => {
          httpsRequests++;
          return new Response(null, { status: 404 });
        });
        const transport = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand" && command.command === "gh") {
            ghRequests++;
            return Effect.succeed({
              ...makeSuccessfulProcess("release not found"),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            });
          }
          return f.transport.spawn(command);
        });
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed({
              ...f.runner,
              archiveDirectory: `${f.home}/missing-archives`,
              refreshOwnedRuntimeOnFirstConnection: true,
            }),
            leaveRemoteServerRunning: true,
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const result = yield* Effect.result(
            manager.ensureEnvironment(uploadTarget, { issuePairingToken: true, keyOnly: true }),
          );
          assert.equal(httpsRequests, 1);
          assert.equal(ghRequests, 1);
          if (fallback) {
            assert.isTrue(Result.isSuccess(result));
            if (Result.isSuccess(result)) {
              assert.notProperty(result.success, "type");
              if (!("type" in result.success)) {
                if (live) assert.equal(result.success.remotePort, f.port);
                else assert.isAbove(result.success.remotePort ?? 0, 0);
                assert.equal(result.success.remoteServerVersion, "1.2.2");
              }
            }
          } else {
            assert.isTrue(Result.isFailure(result));
            if (Result.isFailure(result)) {
              assert.instanceOf(result.failure, SshLaunchError);
              assert.include(
                result.failure.message,
                `Cannot prepare GOAT ${ARCHIVE.archiveVersion}`,
              );
              assert.include(result.failure.message, "Public HTTPS release is not published");
              if (result.failure instanceof SshLaunchError) {
                assert.equal(result.failure.reason, "archive-unavailable");
                assert.equal(result.failure.acquisition?.requestedVersion, ARCHIVE.archiveVersion);
              }
            }
          }
          // A fresh read on the incompatible live host reports its protocol mismatch.
          if (state === "live-incompatible") return;
          const status = (yield* manager.status(uploadTarget)).status;
          assert.equal(status?.failure?.reason, "archive_unavailable");
          assert.deepEqual(status?.failure?.archive, {
            requestedVersion: ARCHIVE.archiveVersion,
            platformKey: `${HostProcess.Platform.defaultValue()}-${HostProcess.Architecture.defaultValue()}`,
            sourcesTried: ["cache", "https", "gh"],
          });
          assert.include(status?.failure?.fix.instruction ?? "", ARCHIVE.archiveVersion);
          if (fallback) {
            assert.equal(status?.runtimeVersion, "1.2.2");
            assert.include(status?.failure?.fix.instruction ?? "", "compatible GOAT 1.2.2");
            // Cached reuse must preserve the visible acquisition warning as well.
            yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
            assert.deepEqual(
              (yield* manager.status(uploadTarget)).status?.failure,
              status?.failure,
            );
            assert.equal(ghRequests, 1);
          }
        }).pipe(Effect.provide(layer), Effect.scoped);
        if (state === "stopped-compatible") {
          const after = yield* f.snapshot;
          for (const file of ["run-t3.sh", "oldExecutable", "oldMarker"])
            assert.equal(after[file], before?.[file]);
          assert.isNotNull(after.runtime);
        } else if (installed) assert.deepEqual(yield* f.snapshot, before);
        else {
          assert.isFalse(yield* f.fs.exists(f.old));
          assert.isFalse(yield* f.fs.exists(`${f.state}/run-t3.sh`));
          assert.isFalse(yield* f.fs.exists(`${f.home}/.goat/userdata/server-runtime.json`));
        }
        assert.equal(f.counters().uploads, 0);
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["drain", "drain-request", "self-stop", "stop", "supervise"])
          assert.notInclude(events, `"type":"${type}"`);
        assert.equal(events.includes('"type":"start"'), live || fallback);
        assert.equal(events.includes('"type":"auth"'), fallback);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
