import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  testHttpClient,
  testNetService,
  ARCHIVE,
  uploadTarget,
  installArchivePsDouble,
  makeSuccessfulProcess,
} from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    it.live.each(["busy", "unknown", "idle", "failure"] as const)(
      "manager consumes settled startup decisions and retries pending ones: %s",
      (mode) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          const before = yield* f.snapshot;
          yield* f.fs.writeFileString(
            `${f.test}/activity`,
            mode === "busy" || mode === "unknown" ? mode : "idle",
          );
          let failUpload = mode === "failure";
          const transport = ChildProcessSpawner.make((command) => {
            if (failUpload && command._tag === "StandardCommand" && command.args.includes("-c")) {
              failUpload = false;
              return Effect.succeed({
                ...makeSuccessfulProcess("remote upload failed"),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
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
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({
                ...f.runner,
                refreshOwnedRuntimeOnFirstConnection: true,
              }),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            if (mode === "failure") {
              // Missing/unusable archives now permit compatible fallback; upload
              // failures must still fail and preserve the first-connection retry.
              const failed = yield* Effect.result(manager.ensureEnvironment(uploadTarget));
              assert.isTrue(Result.isFailure(failed));
              if (Result.isFailure(failed))
                assert.include(failed.failure.message, "Uploading the runtime archive failed");
              assert.deepEqual(yield* f.snapshot, before);
            }
            yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
            if (mode === "idle" || mode === "failure") {
              yield* installArchivePsDouble(
                f.home,
                Number((yield* f.fs.readFileString(`${f.state}/pid`)).trim()),
                Number((yield* f.fs.readFileString(`${f.state}/port`)).trim()),
                ARCHIVE.archiveVersion,
              );
            }
            const count = yield* f.fs.readFileString(`${f.test}/activity-requests`);
            // Unknown activity returns 404, so each probe also tries the legacy endpoint.
            assert.equal(count, mode === "busy" ? "1" : "2");
            yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
            yield* manager.disconnectEnvironment(uploadTarget);
            yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
            assert.equal(
              yield* f.fs.readFileString(`${f.test}/activity-requests`),
              mode === "unknown" ? "4" : mode === "busy" ? "3" : count,
            );
            const events = (yield* f.fs.readFileString(`${f.test}/events`))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            assert.equal(events.filter((event) => event.type === "self-stop").length, 1);
            assert.equal(events.filter((event) => event.type === "drain").length, 1);
            assert.equal(
              events.filter((event) => event.type === "supervise" && event.status === "replaced")
                .length,
              1,
            );
            assert.isFalse(events.some((event) => event.type === "stop"));
          }).pipe(Effect.provide(layer), Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("pairing recovery reuses the deferred attachment until an explicit refresh", () =>
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
        yield* f.fs.writeFileString(`${f.test}/pairing-fail`, "fail");
        const before = yield* f.snapshot;
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
          Layer.succeed(FileSystem.FileSystem, f.observedFs),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed({
              ...f.runner,
              refreshOwnedRuntimeOnFirstConnection: true,
            }),
            leaveRemoteServerRunning: true,
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          assert.isTrue(
            Result.isFailure(
              yield* Effect.result(
                manager.ensureEnvironment(uploadTarget, { issuePairingToken: true }),
              ),
            ),
          );
          assert.deepEqual(yield* f.snapshot, before);
          yield* Effect.sync(() => process.kill(f.pid, 0));
          assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "1");
          yield* f.fs.remove(`${f.test}/pairing-fail`);
          yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
          const paired = yield* manager.ensureEnvironment(uploadTarget, {
            issuePairingToken: true,
          });
          assert.notProperty(paired, "type");
          if ("type" in paired) throw new Error("Expected the retained attachment");
          assert.equal(paired.pairingToken, "1.2.2");
          assert.equal(paired.pendingReplacement?.reason, "busy");
          assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "1");
          assert.deepEqual(yield* f.snapshot, before);
          const beforeRefresh = yield* f.fs.readFileString(`${f.test}/events`);
          for (const type of ["self-stop", "drain", "stop"])
            assert.notInclude(beforeRefresh, `"type":"${type}"`);
          yield* manager.ensureEnvironment(uploadTarget, {
            issuePairingToken: true,
            refreshRuntime: true,
          });
          assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "3");
          assert.notEqual((yield* f.snapshot).pid, before.pid);
          assert.include(
            (yield* f.snapshot).identity!,
            `/versions/${ARCHIVE.archiveVersion}/goat serve`,
          );
          yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
          assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "3");
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.equal(events.split('"type":"self-stop"').length - 1, 1);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
