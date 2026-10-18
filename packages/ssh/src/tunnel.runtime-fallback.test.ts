import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshLaunchError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  ARCHIVE,
  makeSuccessfulProcess,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

afterEach(() => vi.unstubAllGlobals());

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime archive fallback",
  () => {
    it.live.each(["compatible", "incompatible", "stopped"] as const)(
      "missing HTTPS release and failed gh acquisition with a %s runtime",
      (state) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: state !== "stopped",
            kind: "managed",
            oldVersion: "1.2.2",
            drain: true,
            ssh: state === "compatible" ? SSH_RUNTIME_PROTOCOL_VERSION : 99,
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
            if (state === "compatible") {
              assert.isTrue(Result.isSuccess(result));
              if (Result.isSuccess(result)) {
                assert.notProperty(result.success, "type");
                if (!("type" in result.success)) {
                  assert.equal(result.success.remotePort, f.port);
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
                  assert.equal(
                    result.failure.acquisition?.requestedVersion,
                    ARCHIVE.archiveVersion,
                  );
                }
              }
            }
            // A fresh read on the incompatible live host reports its protocol mismatch.
            if (state === "incompatible") return;
            const status = (yield* manager.status(uploadTarget)).status;
            assert.equal(status?.failure?.reason, "archive_unavailable");
            assert.deepEqual(status?.failure?.archive, {
              requestedVersion: ARCHIVE.archiveVersion,
              platformKey: `${HostProcess.Platform.defaultValue()}-${HostProcess.Architecture.defaultValue()}`,
              sourcesTried: ["cache", "https", "gh"],
            });
            assert.include(status?.failure?.fix.instruction ?? "", ARCHIVE.archiveVersion);
            if (state === "compatible") {
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
          assert.deepEqual(yield* f.snapshot, before);
          assert.equal(f.counters().uploads, 0);
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          for (const type of ["drain", "drain-request", "self-stop", "stop", "supervise"])
            assert.notInclude(events, `"type":"${type}"`);
          assert.equal(events.includes('"type":"auth"'), state === "compatible");
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
