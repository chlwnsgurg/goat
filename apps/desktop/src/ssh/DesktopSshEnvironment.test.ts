import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import {
  Connectivity,
  ConnectionDriver,
  EnvironmentSupervisor,
  SshConnectionTarget,
  Wakeups,
  connectionRouteId,
  type SupervisorConnectionState,
} from "@goat/client-runtime/connection";
import type { WsRpcProtocolClient } from "@goat/client-runtime/rpc";
import { SshHostAnswered } from "@goat/ssh/command";
import * as NetService from "@goat/shared/Net";
import * as SshTunnel from "@goat/ssh/tunnel";
import { SshLaunchError, SshPasswordPromptError } from "@goat/ssh/errors";
import * as SshAuth from "@goat/ssh/auth";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-env-test-" });
  });
}

const runtimeTarget = {
  alias: "devbox",
  hostname: "box.example.test",
  username: "maintainer",
  port: 2207,
};
const pendingRuntime = {
  type: "ssh-runtime-pending",
  target: runtimeTarget,
  pending: {
    reason: "busy",
    replacement: "older",
    requestedVersion: "1.2.3",
    liveVersion: "1.2.2",
  },
} as const;
const waitingStatus = {
  kind: "ok",
  status: {
    host: runtimeTarget.alias,
    state: "update_waiting",
    requestedVersion: "1.2.3",
    runtimeVersion: "1.2.2",
  },
} as const;

const unusedManager = {
  status: () => Effect.die("unexpected status"),
  ensureEnvironment: () => Effect.die("unexpected ensure"),
  readyEnvironment: () => Effect.die("Unexpected ready environment"),
  beginSetupOperation: () => Effect.die("Unexpected setup operation"),
  publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
  publishSetupOutcome: () => Effect.die("Unexpected setup outcome"),
  forgetEnvironment: () => Effect.die("Unexpected forget"),
  disconnectEnvironment: () => Effect.void,
  revalidateTunnels: () => Effect.void,
  issueMcpClientSession: () => Effect.die("unexpected session"),
  runRemoteScript: () => Effect.die("unexpected remote script"),
} satisfies SshTunnel.SshEnvironmentManagerShape;

const desktopRuntimeLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerUndici,
  NetService.layer,
  Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
    request: () => Effect.die("unexpected desktop password prompt"),
    resolve: () => Effect.die("unexpected password resolution"),
  }),
);

const withManager = (manager: SshTunnel.SshEnvironmentManagerShape) =>
  Layer.mergeAll(desktopRuntimeLayer, Layer.succeed(SshTunnel.SshEnvironmentManager, manager));

const successfulProcess = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

describe("desktop SSH runtime status", () => {
  it.effect("uses the existing desktop manager for status when_idle and now", () => {
    let confirmed = false;
    const manager = {
      ...unusedManager,
      status: () =>
        Effect.sync(() => ({
          ...waitingStatus,
          status: confirmed
            ? { ...waitingStatus.status, state: "ready" as const, runtimeVersion: "1.2.3" }
            : waitingStatus.status,
        })),
      ensureEnvironment: (target, options) =>
        Effect.sync(() => {
          assert.deepEqual(target, runtimeTarget);
          if (options?.refreshRuntime && options.keyOnly && options.issuePairingToken === false)
            confirmed = options.confirmReplacement === true;
          return confirmed
            ? {
                target,
                httpBaseUrl: "http://127.0.0.1:41773/",
                wsBaseUrl: "ws://127.0.0.1:41773/",
                pairingToken: null,
              }
            : pendingRuntime;
        }),
    } satisfies SshTunnel.SshEnvironmentManagerShape;
    return Effect.gen(function* () {
      const service = yield* DesktopSshEnvironment.make;
      assert.deepEqual(yield* service.status(runtimeTarget), waitingStatus);
      assert.deepEqual(yield* service.update(runtimeTarget), waitingStatus);
      assert.deepEqual(yield* service.update(runtimeTarget, "when_idle"), waitingStatus);
      const updated = yield* service.update(runtimeTarget, "now");
      assert.equal(updated.status?.state, "ready");
      assert.equal(updated.status?.runtimeVersion, "1.2.3");
      assert.deepEqual(yield* service.status(runtimeTarget), updated);
    }).pipe(Effect.provide(withManager(manager)));
  });

  it.effect("status does not prompt for a password", () =>
    Effect.gen(function* () {
      const service = yield* DesktopSshEnvironment.make;
      assert.deepEqual(yield* service.status(runtimeTarget), waitingStatus);
    }).pipe(
      Effect.provide(
        withManager({
          ...unusedManager,
          status: () =>
            Effect.gen(function* () {
              const prompt = yield* SshAuth.SshPasswordPrompt;
              assert.equal(prompt.isAvailable, false);
              const exit = yield* prompt
                .request({
                  destination: "maintainer@box.example.test",
                  username: "maintainer",
                  prompt: "Password:",
                  attempt: 1,
                })
                .pipe(Effect.exit);
              assert(Exit.isFailure(exit));
              const failure = Cause.findErrorOption(exit.cause);
              assert(Option.isSome(failure));
              assert.instanceOf(failure.value, SshPasswordPromptError);
              return waitingStatus;
            }),
        }),
      ),
    ),
  );

  it.effect("returns the manager's structured failure when acquisition fails", () => {
    const failed = {
      kind: "ok",
      status: {
        ...waitingStatus.status,
        state: "failed",
        failure: {
          reason: "archive_unavailable",
          archive: { requestedVersion: "1.2.3", platformKey: "linux-x64", sourcesTried: ["https"] },
          fix: { actor: "human", instruction: "Install a published GOAT release." },
        },
      },
    } as const;
    return Effect.gen(function* () {
      const service = yield* DesktopSshEnvironment.make;
      assert.deepEqual(yield* service.update(runtimeTarget), failed);
    }).pipe(
      Effect.provide(
        withManager({
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.fail(
              new SshLaunchError({
                reason: "archive-unavailable",
                message: "Requested GOAT archive is unavailable.",
                stdout: "",
                acquisition: failed.status.failure.archive,
              }),
            ),
          status: () => Effect.succeed(failed),
        }),
      ),
    );
  });

  it.effect("ignores late results after disconnect", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let statusReads = 0;
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return pendingRuntime;
            }),
          status: () =>
            Effect.sync(() => {
              statusReads++;
              return waitingStatus;
            }),
        }),
      );
      const update = yield* service.update(runtimeTarget, "now").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.disconnectEnvironment(runtimeTarget);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(update);
      assert.equal(result.kind, "error");
      if (result.kind === "error") assert.equal(result.code, "cancelled");
      assert.equal(statusReads, 0);
    }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect("ignores a status probe that finishes after disconnect", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          status: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return waitingStatus;
            }),
        }),
      );
      const read = yield* service.status(runtimeTarget).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.disconnectEnvironment(runtimeTarget);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(read);
      assert.equal(result.kind, "error");
      if (result.kind === "error") assert.equal(result.code, "cancelled");
    }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect("keeps desktop and dispatch caches separate while sharing the remote lock", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let held = false;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected command");
          if (command.args.includes("-G"))
            return successfulProcess("hostname box.example.test\nuser maintainer\nport 2207\n");
          const input = command.options.stdin;
          const script =
            input !== undefined &&
            typeof input === "object" &&
            "stream" in input &&
            Stream.isStream(input.stream)
              ? yield* input.stream.pipe(Stream.decodeText(), Stream.mkString)
              : "";
          if (script.includes("ready=false"))
            return successfulProcess(
              JSON.stringify({ platform: "linux", arch: "x64", ready: true, liveStatus: "none" }),
            );
          const contended = held;
          if (!contended) {
            held = true;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            held = false;
          }
          return successfulProcess(
            JSON.stringify({
              status: "pending",
              pending: {
                ...pendingRuntime.pending,
                requestedVersion: contended ? "1.2.4" : "1.2.3",
                reason: contended ? "contended" : "busy",
              },
            }),
          );
        }),
      );
      yield* Effect.gen(function* () {
        const desktopContext = yield* Layer.build(
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed({
              archiveVersion: "1.2.3",
              refreshOwnedRuntimeOnFirstConnection: true,
            }),
            leaveRemoteServerRunning: true,
          }),
        );
        const desktop = yield* DesktopSshEnvironment.make.pipe(
          Effect.provideService(
            SshTunnel.SshEnvironmentManager,
            Context.get(desktopContext, SshTunnel.SshEnvironmentManager),
          ),
        );
        const dispatchContext = yield* Layer.build(
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed({
              archiveVersion: "1.2.4",
              refreshOwnedRuntimeOnFirstConnection: true,
            }),
          }),
        );
        const dispatch = Context.get(dispatchContext, SshTunnel.SshEnvironmentManager);
        const desktopUpdate = yield* desktop.update(runtimeTarget).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* dispatch.ensureEnvironment(runtimeTarget, {
          keyOnly: true,
          issuePairingToken: false,
        });
        const dispatchStatus = yield* dispatch.status(runtimeTarget);
        assert.equal(dispatchStatus.status?.state, "update_waiting");
        assert.equal(dispatchStatus.status?.requestedVersion, "1.2.4");
        assert.include(dispatchStatus.status?.detail ?? "", "Another computer");
        const desktopStatus = yield* desktop.status(runtimeTarget);
        assert.equal(desktopStatus.status?.state, "preparing");
        assert.equal(desktopStatus.status?.requestedVersion, "1.2.3");
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(desktopUpdate)).status?.state, "update_waiting");
        yield* desktop.disconnectEnvironment(runtimeTarget);
        assert.equal((yield* dispatch.status(runtimeTarget)).status?.state, "update_waiting");
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    }).pipe(
      Effect.provideService(SshAuth.SshPasswordPrompt, {
        isAvailable: false,
        request: () => Effect.die("unexpected password"),
      }),
      Effect.provide(desktopRuntimeLayer),
      Effect.scoped,
    ),
  );
});

describe("sshEnvironment", () => {
  it.effect("isolates a throwing authentication listener from other pending requests", () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<() => void>();
      const finish = yield* Deferred.make<void>();
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.gen(function* () {
              const answer = yield* SshHostAnswered;
              yield* Queue.offer(entered, () => answer?.());
              yield* Deferred.await(finish);
              return pendingRuntime;
            }),
        }),
      );
      let liveAnswers = 0;
      const dead = yield* service.ensureEnvironment(runtimeTarget).pipe(
        Effect.provideService(SshHostAnswered, () => {
          throw new Error("Object has been destroyed");
        }),
        Effect.forkChild,
      );
      const authenticate = yield* Queue.take(entered);
      const live = yield* service.ensureEnvironment(runtimeTarget).pipe(
        Effect.provideService(SshHostAnswered, () => {
          liveAnswers++;
        }),
        Effect.forkChild,
      );
      yield* Queue.take(entered);
      assert.doesNotThrow(authenticate);
      assert.equal(liveAnswers, 1);
      yield* Deferred.succeed(finish, undefined);
      assert.deepEqual(yield* Fiber.join(dead), pendingRuntime);
      assert.deepEqual(yield* Fiber.join(live), pendingRuntime);
    }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect("clears authentication state after a replay listener throws", () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<() => void>();
      const replayed = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.gen(function* () {
              const answer = yield* SshHostAnswered;
              yield* Queue.offer(entered, () => answer?.());
              yield* Deferred.await(finish);
              return pendingRuntime;
            }),
        }),
      );
      const original = yield* service.ensureEnvironment(runtimeTarget).pipe(Effect.forkChild);
      (yield* Queue.take(entered))();
      let replayAnswers = 0;
      const replay = yield* service.ensureEnvironment(runtimeTarget).pipe(
        Effect.provideService(SshHostAnswered, () => {
          replayAnswers++;
          Deferred.doneUnsafe(replayed, Effect.void);
          throw new Error("Object has been destroyed");
        }),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(replayed);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(original);
      const replayResult = yield* Fiber.join(replay);
      let freshAnswers = 0;
      yield* service.ensureEnvironment(runtimeTarget).pipe(
        Effect.provideService(SshHostAnswered, () => {
          freshAnswers++;
        }),
      );
      assert.equal(freshAnswers, 0);
      assert.equal(replayAnswers, 1);
      assert(Exit.isSuccess(replayResult));
      assert.deepEqual(replayResult.value, pendingRuntime);
    }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect(
    "limits authentication replay to pending requests for the same target and generation",
    () =>
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<() => void>();
        const finish = yield* Deferred.make<void>();
        const answers: string[] = [];
        const service = yield* DesktopSshEnvironment.make.pipe(
          Effect.provideService(SshTunnel.SshEnvironmentManager, {
            ...unusedManager,
            ensureEnvironment: () =>
              Effect.gen(function* () {
                const answer = yield* SshHostAnswered;
                yield* Queue.offer(entered, () => answer?.());
                yield* Deferred.await(finish);
                return pendingRuntime;
              }),
          }),
        );
        const start = Effect.fnUntraced(function* (id: string, target = runtimeTarget) {
          const fiber = yield* service.ensureEnvironment(target).pipe(
            Effect.provideService(SshHostAnswered, () => {
              answers.push(id);
            }),
            Effect.forkChild,
          );
          return { fiber, answer: yield* Queue.take(entered) };
        });
        const original = yield* start("original");
        const early = yield* start("early");
        original.answer();
        original.answer();
        assert.deepEqual(answers, ["original", "early"]);
        const retry = yield* start("retry");
        const other = yield* start("other", { ...runtimeTarget, hostname: "other.example.test" });
        assert.deepEqual(answers, ["original", "early", "retry"]);
        yield* service.disconnectEnvironment(runtimeTarget);
        const replacement = yield* start("replacement");
        original.answer();
        assert.deepEqual(answers, ["original", "early", "retry"]);
        replacement.answer();
        yield* Fiber.interrupt(original.fiber);
        yield* Fiber.interrupt(early.fiber);
        yield* Fiber.interrupt(retry.fiber);
        const replacementRetry = yield* start("replacement-retry");
        assert.deepEqual(answers, [
          "original",
          "early",
          "retry",
          "replacement",
          "replacement-retry",
        ]);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(replacement.fiber);
        yield* Fiber.join(replacementRetry.fiber);
        yield* Fiber.join(other.fiber);
        yield* start("fresh");
        assert.deepEqual(answers, [
          "original",
          "early",
          "retry",
          "replacement",
          "replacement-retry",
        ]);
      }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect("learns 42 seconds when only the original SSH request authenticates", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const finishSetup = yield* Deferred.make<void>();
      const lock = yield* Semaphore.make(1);
      let requests = 0;
      let authentications = 0;
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.gen(function* () {
              const request = ++requests;
              return yield* lock.withPermit(
                Effect.gen(function* () {
                  // IPC retries wait behind the original target lock without authenticating again.
                  if (request === 1 || request === 4) {
                    authentications++;
                    (yield* SshHostAnswered)?.();
                  }
                  if (request <= 3) yield* Deferred.await(finishSetup);
                  else return yield* Effect.never;
                  return {
                    target: runtimeTarget,
                    httpBaseUrl: "http://127.0.0.1:41773/",
                    wsBaseUrl: "ws://127.0.0.1:41773/",
                    pairingToken: null,
                  };
                }),
              );
            }),
        }),
      );
      const target = new SshConnectionTarget({
        environmentId: EnvironmentId.make("ssh-test"),
        label: "SSH test",
        connectionId: "ssh:devbox",
      });
      const prepared = {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: "http://127.0.0.1:41773/",
        socketUrl: "ws://127.0.0.1:41773/ws",
        httpAuthorization: null,
        target,
      };
      const supervisor = yield* EnvironmentSupervisor.make(
        { target, profile: Option.none(), enabled: true },
        { initiallyDesired: true },
      ).pipe(
        Effect.provideService(Connectivity.Connectivity, {
          status: Effect.succeed("online" as const),
          changes: Stream.never,
        }),
        Effect.provideService(Wakeups.ConnectionWakeups, { changes: Stream.never }),
        Effect.provideService(ConnectionDriver, {
          checkRoute: () => Effect.succeed("unchecked"),
          preflight: () => Effect.succeed(false),
          connect: (_entry, progress) =>
            Effect.gen(function* () {
              yield* progress({ stage: "preparing", routeId: connectionRouteId(target) });
              const answered = yield* Deferred.make<void>();
              const request = yield* service.ensureEnvironment(runtimeTarget).pipe(
                Effect.provideService(SshHostAnswered, () => {
                  Deferred.doneUnsafe(answered, Effect.void);
                }),
                // Renderer cancellation does not cancel the desktop IPC request.
                Effect.forkIn(scope),
              );
              yield* Deferred.await(answered).pipe(
                Effect.andThen(progress({ stage: "preparing", hostAnswered: true })),
                Effect.forkChild,
              );
              yield* Fiber.join(request).pipe(Effect.orDie);
              yield* progress({ stage: "synchronizing", prepared });
              return {
                prepared,
                session: {
                  client: {} as WsRpcProtocolClient,
                  initialConfig: Effect.die("unused config"),
                  subscribeServerConfig: () => Stream.never,
                  ready: Effect.void,
                  probe: Effect.void,
                  closed: Effect.never,
                },
              };
            }),
        }),
      );
      const awaitPhase = (phase: SupervisorConnectionState["phase"]) =>
        SubscriptionRef.changes(supervisor.state).pipe(
          Stream.filter((state) => state.phase === phase),
          Stream.runHead,
        );
      yield* TestClock.adjust(0);
      assert.equal(requests, 1);
      yield* TestClock.adjust("15 seconds");
      assert.equal(requests, 2);
      yield* TestClock.adjust("15 seconds");
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "backoff");
      yield* TestClock.adjust("2 seconds");
      assert.equal(requests, 3);
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.succeed(finishSetup, undefined);
      yield* awaitPhase("connected");
      assert.equal(authentications, 1);
      yield* supervisor.disconnect;
      yield* awaitPhase("available");
      yield* supervisor.connect;
      yield* TestClock.adjust(0);
      yield* TestClock.adjust("44 seconds");
      assert.equal(requests, 4);
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "connecting");
      yield* TestClock.adjust("1 second");
      assert.equal(requests, 5);
    }).pipe(Effect.provide(Layer.mergeAll(desktopRuntimeLayer, TestClock.layer()))),
  );

  it.effect("passes key-only provisioning to the SSH manager without requesting a password", () => {
    const target = { alias: "devbox", hostname: "box.example.test", username: null, port: null };
    return Effect.gen(function* () {
      const environment = yield* DesktopSshEnvironment.make;
      const result = yield* environment.ensureEnvironment(target, {
        keyOnly: true,
        issuePairingToken: true,
      });
      if ("type" in result) throw new Error("unexpected pending runtime replacement");
      assert.equal(result.pairingToken, "fixture-token");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerUndici,
          NetService.layer,
          Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
            request: () => Effect.die("unexpected password prompt"),
            resolve: () => Effect.die("unused"),
          }),
          Layer.succeed(SshTunnel.SshEnvironmentManager, {
            status: () => Effect.die("unused"),
            ensureEnvironment: (receivedTarget, options) =>
              Effect.sync(() => {
                assert.deepEqual(receivedTarget, target);
                assert.deepEqual(options, { keyOnly: true, issuePairingToken: true });
                return {
                  target,
                  httpBaseUrl: "http://127.0.0.1:41773/",
                  wsBaseUrl: "ws://127.0.0.1:41773/",
                  pairingToken: "fixture-token",
                };
              }),
            readyEnvironment: () => Effect.die("Unexpected ready environment"),
            beginSetupOperation: () => Effect.die("Unexpected setup operation"),
            publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
            publishSetupOutcome: () => Effect.die("Unexpected setup outcome"),
            forgetEnvironment: () => Effect.die("Unexpected forget"),
            disconnectEnvironment: () => Effect.die("unused"),
            revalidateTunnels: () => Effect.die("unused"),
            issueMcpClientSession: () => Effect.die("unused"),
            runRemoteScript: () => Effect.die("unused"),
          }),
        ),
      ),
    );
  });
  it("keeps prompt presentation diagnostics distinct from the legacy wrapper message", () => {
    const cause = new DesktopSshPasswordPrompts.DesktopSshPromptPresentationError({
      requestId: "prompt-1",
      destination: "devbox",
      operation: "send-prompt-request",
      cause: new Error("renderer send failed"),
    });

    assert.equal(cause.message, "Failed to present SSH password prompt for devbox.");
    assert.equal(
      DesktopSshEnvironment.toSshPasswordPromptError(cause).message,
      "GOAT window is not available for SSH authentication.",
    );
  });

  it("treats password prompt timeouts as cancellable authentication prompts", () => {
    assert.equal(
      DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: "SSH authentication timed out for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        }),
      ),
      true,
    );
  });

  it.effect("wires desktop host discovery through the ssh package runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(path.join(sshDir, "config.d"), { recursive: true });
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        ["Host devbox", "  HostName devbox.example.com", "Include config.d/*.conf", ""].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", "team.conf"),
        [
          "Host staging",
          "  HostName staging.example.com",
          "Host *",
          "  ServerAliveInterval 30",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "known.example.com ssh-ed25519 AAAA",
          "|1|hashed|entry ssh-ed25519 AAAA",
          "[bastion.example.com]:2222 ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );

      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const hosts = yield* sshEnvironment.discoverHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "bastion.example.com",
          hostname: "bastion.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "devbox",
          hostname: "devbox",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "known.example.com",
          hostname: "known.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "staging",
          hostname: "staging",
          username: null,
          port: null,
          source: "ssh-config",
        },
      ]);
    }).pipe(
      Effect.provide(
        DesktopSshEnvironment.layer().pipe(
          Layer.provideMerge(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die("unexpected password prompt request"),
              resolve: () => Effect.die("unexpected password prompt resolution"),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeHttpClient.layerUndici),
          Layer.provideMerge(NetService.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});
