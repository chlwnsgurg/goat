import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import { sshPreparationFailure } from "../../client-runtime/src/connection/sshFailure.ts";
import * as SshTunnel from "./tunnel.ts";
import * as SshAuth from "./auth.ts";
import * as NetService from "@goat/shared/Net";
import { HttpClient } from "effect/http";
import { testNetService, hangingHttpClient } from "./tunnel.fixture.ts";
import { SshCommandError } from "./errors.ts";
import {
  ARCHIVE,
  platform,
  arch,
  NODE_SCRIPT,
  makeSuccessfulProcess,
  makeUploadFixture,
  uploadTarget,
} from "./tunnel.fixture.ts";
import {
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  prepareRemoteRuntime,
} from "./tunnel.ts";

describe("SSH operation deadlines", () => {
  it.effect.each(["launch", "pairing", "install"] as const)(
    "names the real %s operation after login",
    (stage) =>
      Effect.gen(function* () {
        const fixture = stage === "install" ? yield* makeUploadFixture() : undefined;
        const started = yield* Deferred.make<void>();
        const spawner = ChildProcessSpawner.make((command) => {
          // Installation probes first, then uploads the locally cached archive.
          if (
            stage === "install" &&
            command._tag === "StandardCommand" &&
            !command.args.includes("-c")
          ) {
            return Effect.succeed(
              makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: false })),
            );
          }
          return Effect.succeed({
            ...makeSuccessfulProcess(""),
            stderr: Stream.fromIterable([
              new TextEncoder().encode('Authenticated to fixture using "publickey".\n'),
            ]),
            exitCode: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          });
        });
        const operation =
          stage === "launch"
            ? launchOrReuseRemoteServer(uploadTarget, {}, NODE_SCRIPT).pipe(Effect.asVoid)
            : stage === "pairing"
              ? issueRemotePairingToken(uploadTarget, {}, NODE_SCRIPT).pipe(Effect.asVoid)
              : prepareRemoteRuntime(
                  uploadTarget,
                  {},
                  { ...ARCHIVE, archiveDirectory: fixture!.directory },
                ).pipe(Effect.asVoid);
        const fiber = yield* operation.pipe(
          Effect.flip,
          Effect.onExit(() => Deferred.succeed(started, undefined)),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust(Duration.minutes(15));
        const error = yield* Fiber.join(fiber);
        assert.instanceOf(error, SshCommandError);
        assert.include(
          error.message,
          stage === "install"
            ? "GOAT runtime install/download"
            : stage === "launch"
              ? "GOAT runtime launch"
              : "GOAT pairing",
        );
        assert.equal(sshPreparationFailure(error).reason, "remote-unavailable");
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer()))),
  );
});

it.effect("retains a stopped local Tailscale proxy in tunnel diagnostics", () =>
  Effect.gen(function* () {
    const manager = yield* SshTunnel.SshEnvironmentManager;
    const error = yield* manager.ensureEnvironment(uploadTarget).pipe(Effect.flip);
    assert.equal(sshPreparationFailure(error)._tag, "ConnectionBlockedError");
    assert.include(sshPreparationFailure(error).detail ?? "", "Start Tailscale");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(NODE_SCRIPT),
          leaveRemoteServerRunning: true,
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const args = command._tag === "StandardCommand" ? command.args : [];
            if (args.includes("-G"))
              return Effect.succeed(
                makeSuccessfulProcess("hostname fixture\nuser fixture\nport 22\n"),
              );
            if (args.includes("-N"))
              return Effect.succeed({
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(
                  new TextEncoder().encode(
                    `${args.includes("-v") ? "debug1: kex_exchange_identification: banner line 0: Tailscale is stopped.\n" : ""}Connection closed by UNKNOWN port 65535\n`,
                  ),
                ),
              });
            return Effect.succeed(
              makeSuccessfulProcess(
                '{"status":"ready","remotePort":3773,"selectedVersion":"0.1.0"}',
              ),
            );
          }),
        ),
      ),
    ),
  ),
);
