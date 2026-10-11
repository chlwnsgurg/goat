import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";

const launcher = ThreadId.make("launcher");
const target = ThreadId.make("target");
const projectId = ProjectId.make("project");
const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");

type Dispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type WaitAnswer = Effect.Effect<
  ThreadManagementService.ThreadManagementWaitResult,
  ThreadManagementService.ThreadManagementError
>;

/** Everything the service sees of the world, under the test's control. */
interface World {
  readonly shells: Map<string, Partial<OrchestrationV2ThreadShell>>;
  /** Answers to local waits, taken one per wait. */
  readonly waits: Queue.Queue<WaitAnswer>;
  readonly waitCalls: Array<ThreadManagementService.ThreadManagementWaitInput>;
  /** One entry per wait that started. */
  readonly waitStarted: Queue.Queue<RunId | undefined>;
  /** One entry per read of the launcher's shell. */
  readonly launcherReads: Queue.Queue<void>;
  readonly assistantMessages: Array<{ runId: RunId; text: string }>;
  requests: Array<{ id: string; status: string; kind: string }>;
  /** Failures for the next dispatches, used up in order. */
  readonly dispatchFailures: Array<"transient" | "refused">;
  /**
   * Command ids the orchestrator recorded as rejected. Like the real receipt
   * store, a dispatch that fails is recorded, and its id is refused again.
   */
  readonly rejected: Set<string>;
  readonly attempts: Array<Dispatch>;
  readonly delivered: Queue.Queue<Dispatch>;
  readonly deliveredLog: Array<Dispatch>;
  hostCall: (
    call: SshRemoteDispatch.SshHostToolCall,
  ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  readonly hostCalls: Array<{
    call: SshRemoteDispatch.SshHostToolCall;
    ceiling: string;
    at: number;
  }>;
}

const makeWorld = Effect.gen(function* () {
  const world: World = {
    shells: new Map([
      [launcher, { id: launcher, runtimeMode: "full-access", archivedAt: null, deletedAt: null }],
      [
        target,
        {
          id: target,
          projectId,
          title: "Fix the flake",
          branch: "goat/fix",
          worktreePath: "/work/fix",
          archivedAt: null,
          deletedAt: null,
        },
      ],
    ]),
    waits: yield* Queue.unbounded<WaitAnswer>(),
    waitCalls: [],
    waitStarted: yield* Queue.unbounded<RunId | undefined>(),
    launcherReads: yield* Queue.unbounded<void>(),
    assistantMessages: [],
    requests: [],
    dispatchFailures: [],
    rejected: new Set(),
    attempts: [],
    delivered: yield* Queue.unbounded<Dispatch>(),
    deliveredLog: [],
    hostCall: (call) => Effect.die(new Error("unexpected host call " + call.tool)),
    hostCalls: [],
  };
  return world;
});

const dispatchIn = (world: World, command: OrchestrationV2ServerCommand) =>
  Effect.suspend(() => {
    const dispatch = command as Dispatch;
    world.attempts.push(dispatch);
    const commandId = CommandId.make(dispatch.commandId);
    if (world.rejected.has(commandId)) {
      return Effect.fail(
        new OrchestratorCommandPreviouslyRejectedError({
          commandId,
          commandType: dispatch.type,
          detail: "rejected before",
        }),
      );
    }
    const failure = world.dispatchFailures.shift();
    if (failure !== undefined) {
      world.rejected.add(commandId);
      return Effect.fail(
        failure === "transient"
          ? new OrchestratorDispatchError({ commandId, commandType: dispatch.type })
          : new OrchestratorCommandPreviouslyRejectedError({
              commandId,
              commandType: dispatch.type,
              detail: "refused",
            }),
      );
    }
    world.deliveredLog.push(dispatch);
    return Queue.offer(world.delivered, dispatch).pipe(Effect.as({} as never));
  });

const layerFor = (world: World, baseDir: string) =>
  LaunchWatchService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            (threadId === launcher
              ? Queue.offer(world.launcherReads, undefined)
              : Effect.void
            ).pipe(
              Effect.as((world.shells.get(threadId) ?? null) as OrchestrationV2ThreadShell | null),
            ),
          waitForThread: (input) =>
            Effect.suspend(() => {
              world.waitCalls.push(input);
              return Queue.offer(world.waitStarted, input.runId).pipe(
                Effect.andThen(Queue.take(world.waits)),
                Effect.flatten,
              );
            }),
          getThreadRecords: (_threadId, _fields, filter) =>
            Effect.sync(
              () =>
                ({
                  thread: {},
                  messages: world.assistantMessages
                    .filter((message) => filter?.messageRunIds?.includes(message.runId) ?? true)
                    .map((message) => ({ ...message, role: "assistant" })),
                  runtimeRequests: world.requests,
                }) as never,
            ),
          dispatch: (command) => dispatchIn(world, command),
        }),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          callHostTool: (call, authorize) =>
            authorize.pipe(
              Effect.flatMap((ceiling) =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((at) => {
                    world.hostCalls.push({ call, ceiling, at });
                    return world.hostCall(call);
                  }),
                ),
              ),
            ),
        }),
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
        NodeCrypto.layer,
        NodeServices.layer,
      ),
    ),
  );

/** Runs body against a fresh service over baseDir; leaving it stops the service like a shutdown. */
const withService = <A, E>(
  world: World,
  baseDir: string,
  body: (service: LaunchWatchService.LaunchWatchServiceShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* LaunchWatchService.LaunchWatchService;
    return yield* body(service);
  }).pipe(Effect.provide(layerFor(world, baseDir)));

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-watch-" });
}).pipe(Effect.provide(NodeServices.layer));

/**
 * Advances the test clock until milestone arrives, for followers sleeping
 * through backoff or a retry pause.
 */
const advanceUntil = <A, E>(milestone: Effect.Effect<A, E>) =>
  Effect.raceFirst(
    milestone,
    Effect.forever(TestClock.adjust("10 seconds").pipe(Effect.andThen(Effect.yieldNow))),
  );

const finished = (runId: RunId, status: "completed" | "failed" = "completed"): WaitAnswer =>
  Effect.succeed({ threadId: target, run: { id: runId, status } as never, timedOut: false });

const stillRunning = (runId: RunId): WaitAnswer =>
  Effect.succeed({
    threadId: target,
    run: { id: runId, status: "running" } as never,
    timedOut: true,
  });

const local = { launcherThreadId: launcher, host: null, threadId: target } as const;

const watchLocal = (service: LaunchWatchService.LaunchWatchServiceShape, runId: RunId | null) =>
  service.register({ ...local, projectId, title: "Fix the flake", runId });

const watchRemote = (service: LaunchWatchService.LaunchWatchServiceShape, runId: RunId) =>
  service.register({
    launcherThreadId: launcher,
    host: " box ",
    threadId: target,
    projectId: null,
    title: null,
    runId,
  });

const pendingRuns = (service: LaunchWatchService.LaunchWatchServiceShape) =>
  service.list(launcher).pipe(Effect.map(([watch]) => watch?.pendingRuns ?? null));

describe("LaunchWatchService", () => {
  it.effect("wakes the launcher once when the followed run ends, with its answer and branch", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.assistantMessages.push(
        { runId: run1, text: "Looking into it." },
        { runId: run1, text: "Fixed the flake; tests pass." },
      );
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          const wake = yield* Queue.take(world.delivered);
          expect(wake).toMatchObject({
            threadId: launcher,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
            notification: { source: { kind: "background_task" }, outcome: "completed" },
          });
          expect(wake.text).toContain("finished run run-1 with status completed");
          expect(wake.text).toContain("branch goat/fix");
          expect(wake.text).toContain("Fixed the flake; tests pass.");
          expect(wake.text).not.toContain("Looking into it.");
          expect(world.waitCalls[0]).toMatchObject({ projectId, threadId: target, runId: run1 });
        }),
      );
      // A restarted service has nothing left to follow for that run.
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          const [watch] = yield* service.list(launcher);
          expect(watch?.pendingRuns).toEqual([]);
          expect(watch?.reportedRuns).toEqual([run1]);
        }),
      );
      expect(world.deliveredLog).toHaveLength(1);
      expect(world.waitCalls).toHaveLength(1);
    }),
  );

  it.effect("reports queued runs in order, each once, including one added as the last ends", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          // Resending to a run already followed changes nothing.
          yield* service.rearm({ ...local, runId: run1 });
          yield* Queue.offer(world.waits, finished(run1));
          const first = yield* Queue.take(world.delivered);
          expect(first.text).toContain("finished run run-1 with status completed");
          // The follower may be exiting right now; the next send must still be followed.
          yield* service.rearm({ ...local, runId: run2 });
          yield* Queue.offer(world.waits, finished(run2, "failed"));
          const second = yield* Queue.take(world.delivered);
          expect(second.text).toContain("finished run run-2 with status failed");
          expect(second.notification?.outcome).toBe("failed");
          expect(world.waitCalls.map((call) => call.runId)).toEqual([run1, run2]);
          // A reported run is not followed again.
          yield* service.rearm({ ...local, runId: run2 });
          expect(yield* pendingRuns(service)).toEqual([]);
        }),
      );
      expect(world.waitCalls).toHaveLength(2);
      expect(world.deliveredLog).toHaveLength(2);
    }),
  );

  it.effect("resumes a pending run after a restart without a wake from the shutdown", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
        }),
      );
      // Stopping the server mid-wait reports nothing and leaves the run owed.
      expect(world.deliveredLog).toEqual([]);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          expect(yield* pendingRuns(service)).toEqual([run1]);
          yield* Queue.offer(world.waits, finished(run1));
          const wake = yield* Queue.take(world.delivered);
          expect(wake.commandId).toContain("run:run-1");
        }),
      );
      expect(world.deliveredLog).toHaveLength(1);
    }),
  );

  it.effect("reports each pending question once while the run keeps going", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          world.requests = [{ id: "question-1", status: "pending", kind: "user_input" }];
          yield* Queue.offer(world.waits, stillRunning(run1));
          const first = yield* Queue.take(world.delivered);
          expect(first.text).toContain("waiting on a user input request (question-1)");
          expect(first.text).toContain("goat_pending_request_read");
          expect(first.notification?.outcome).toBe("updated");

          // The same question at the next tick is not news; an approval is, and it says
          // where it can be given.
          yield* Queue.take(world.waitStarted);
          yield* Queue.offer(world.waits, stillRunning(run1));
          yield* Queue.take(world.waitStarted);
          world.requests = [
            { id: "question-1", status: "pending", kind: "user_input" },
            { id: "approval-1", status: "pending", kind: "command" },
            { id: "tool-call", status: "pending", kind: "dynamic_tool_call" },
          ];
          yield* Queue.offer(world.waits, stillRunning(run1));
          const second = yield* Queue.take(world.delivered);
          expect(second.text).toContain("approval-1");
          expect(second.text).not.toContain("goat_pending_request_respond");

          world.requests = [];
          yield* Queue.offer(world.waits, finished(run1));
          const last = yield* Queue.take(world.delivered);
          expect(last.text).toContain("finished run run-1");
        }),
      );
      expect(world.deliveredLog).toHaveLength(3);
    }),
  );

  it.effect("tells the launcher once when a host stays unreachable, then reports the run", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      let failures = 4;
      const readArgs: Array<Record<string, unknown>> = [];
      world.hostCall = (call) => {
        switch (call.tool) {
          case "goat_thread_wait":
            if (failures > 0) {
              failures -= 1;
              // The launcher's mode drops during the outage; later calls carry the new ceiling.
              if (failures === 1) {
                world.shells.set(launcher, {
                  ...world.shells.get(launcher),
                  runtimeMode: "approval-required",
                });
              }
              return Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "host_unavailable",
                  message: "box is unavailable: connection refused",
                }),
              );
            }
            return Effect.succeed({
              threadId: target,
              runId: run1,
              status: "completed",
              timedOut: false,
            });
          case "goat_thread_read":
            readArgs.push(call.arguments);
            if (call.arguments.limit === 1) return Effect.succeed(remoteRead({ itemCount: 100 }));
            return Effect.succeed(
              call.arguments.afterPosition === 59
                ? remoteRead({
                    itemCount: 100,
                    items: [
                      remoteItem(70, run1, "First pass done."),
                      remoteItem(79, run2, "An answer from another run."),
                    ],
                    nextPosition: 79,
                  })
                : remoteRead({
                    itemCount: 100,
                    items: [remoteItem(95, run1, "Remote fix pushed.")],
                  }),
            );
          default:
            return Effect.die(new Error("unexpected " + call.tool));
        }
      };
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          const outage = yield* advanceUntil(Queue.take(world.delivered));
          const done = yield* advanceUntil(Queue.take(world.delivered));
          expect(outage.text).toMatch(/^host_unavailable: GOAT cannot reach host box/);
          expect(outage.notification?.outcome).toBe("unknown");
          expect(done.text).toContain("(threadId target, host box) finished run run-1");
          expect(done.text).toContain("Remote fix pushed.");
          expect(done.text).not.toContain("another run");
          // The wake and its state are saved under the lock list waits for.
          const [watch] = yield* service.list(launcher);
          expect(watch?.outage).toBeNull();
        }),
      );
      // Reads only, at the launcher's runtime mode as it is at each call.
      expect(
        world.hostCalls.every(({ call }) => call.writes === false && call.host === "box"),
      ).toBe(true);
      expect(world.hostCalls[0]?.ceiling).toBe("full-access");
      expect(world.hostCalls.at(-1)?.ceiling).toBe("approval-required");
      // The transcript tail starts a fixed window before its end and follows its pages.
      expect(readArgs.map((args) => args.afterPosition)).toEqual([undefined, 59, 79]);
    }),
  );

  it.effect("reads a short remote transcript from its start", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const readArgs: Array<Record<string, unknown>> = [];
      world.hostCall = (call) => {
        if (call.tool === "goat_thread_wait") {
          return Effect.succeed({
            threadId: target,
            runId: run1,
            status: "completed",
            timedOut: false,
          });
        }
        readArgs.push(call.arguments);
        return Effect.succeed(
          remoteRead({ itemCount: 6, items: [remoteItem(5, run1, "Short answer.")] }),
        );
      };
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          const wake = yield* Queue.take(world.delivered);
          expect(wake.text).toContain("Short answer.");
        }),
      );
      expect(readArgs[1]).not.toHaveProperty("afterPosition");
    }),
  );

  it.effect("keeps backing off after a restart in an outage, without a second notice", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      let reachable = false;
      let retryDueAt = 0;
      world.hostCall = (call) => {
        if (!reachable) {
          return Effect.fail(
            new SshRemoteDispatch.SshRemoteDispatchError({
              reason: "ssh_failed",
              message: "SSH to box failed",
            }),
          );
        }
        return call.tool === "goat_thread_wait"
          ? Effect.succeed({ threadId: target, runId: run1, status: "completed", timedOut: false })
          : Effect.succeed(remoteRead({ itemCount: 0 }));
      };
      retryDueAt = yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          yield* advanceUntil(Queue.take(world.delivered));
          const [watch] = yield* service.list(launcher);
          expect(watch?.outage?.notified).toBe(true);
          return watch?.outage?.nextRetryAt ?? 0;
        }),
      );
      const contactsBefore = world.hostCalls.length;
      reachable = true;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* advanceUntil(Queue.take(world.delivered));
          expect(yield* pendingRuns(service)).toEqual([]);
        }),
      );
      // The restarted follower kept the persisted backoff instead of calling at once.
      expect(world.hostCalls[contactsBefore]?.at).toBeGreaterThanOrEqual(retryDueAt);
      expect(world.deliveredLog[0]?.text).toMatch(/^host_unavailable/);
      expect(world.deliveredLog[1]?.text).toContain("finished run run-1");
    }),
  );

  it.effect("stops an unwatched follower, and a new watch reports its own run", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          expect(yield* service.unwatch(local)).toBe(true);
          expect(yield* service.unwatch(local)).toBe(false);
          yield* watchLocal(service, run2);
          expect(yield* Queue.take(world.waitStarted)).toBe(run2);
          yield* Queue.offer(world.waits, finished(run2));
          const wake = yield* Queue.take(world.delivered);
          expect(wake.commandId).toContain("run:run-2");
        }),
      );
      expect(world.deliveredLog).toHaveLength(1);
    }),
  );

  it.effect("drops the watch without a wake when the launcher is archived while it waits", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          // The follower read the launcher once before it started waiting.
          yield* Queue.take(world.launcherReads);
          world.shells.set(launcher, {
            ...world.shells.get(launcher),
            archivedAt: DateTime.makeUnsafe(0) as never,
          });
          yield* Queue.offer(world.waits, finished(run1));
          // It reads the launcher again under the lock before it would wake it; list waits
          // for that lock.
          yield* Queue.take(world.launcherReads);
          expect(yield* service.list(launcher)).toEqual([]);
        }),
      );
      expect(world.attempts).toEqual([]);
    }),
  );

  it.effect("retries a wake the orchestrator failed to store under a fresh id, once", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      world.dispatchFailures.push("transient");
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.offer(world.waits, finished(run1));
          const delivered = yield* advanceUntil(Queue.take(world.delivered));
          const [first] = world.attempts;
          expect(delivered.commandId).toBe(first?.commandId + ":attempt-1");
          expect(delivered.messageId).toBe(first?.messageId + ":attempt-1");
          expect(yield* pendingRuns(service)).toEqual([]);
        }),
      );
      expect(world.attempts).toHaveLength(2);
    }),
  );

  it.effect("settles a wake the orchestrator refuses for good", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      world.dispatchFailures.push("refused");
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.offer(world.waits, finished(run1));
          // A previously rejected id is retried once under a fresh id; that one goes through.
          yield* advanceUntil(Queue.take(world.delivered));
          expect(yield* pendingRuns(service)).toEqual([]);
        }),
      );
      expect(world.attempts).toHaveLength(2);
    }),
  );

  it.effect("keeps the gone notice owed until it can be queued", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.shells.set(target, {
        ...world.shells.get(target),
        deletedAt: DateTime.makeUnsafe(0) as never,
      });
      world.dispatchFailures.push("transient");
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          const gone = yield* advanceUntil(Queue.take(world.delivered));
          expect(gone.text).toContain("can no longer be followed: the thread was deleted.");
          expect(yield* service.list(launcher)).toEqual([]);
        }),
      );
      expect(world.waitCalls).toEqual([]);
    }),
  );

  it.effect("moves an unreadable state file aside and starts empty", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, LaunchWatchService.LAUNCH_WATCH_FILE), "{oops");
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          expect(yield* service.list(launcher)).toEqual([]);
        }),
      );
      const files = yield* fs.readDirectory(stateDir);
      expect(
        files.some((file) => file.startsWith(LaunchWatchService.LAUNCH_WATCH_FILE + ".corrupt-")),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses changes while the state file cannot be read, leaving it intact", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* withService(world, baseDir, (service) => watchLocal(service, run1));
      const file = path.join(baseDir, "userdata", LaunchWatchService.LAUNCH_WATCH_FILE);
      const before = yield* fs.readFileString(file);
      yield* fs.chmod(file, 0o000);
      const refused = yield* withService(world, baseDir, (service) =>
        Effect.result(service.register({ ...local, projectId, title: null, runId: run2 })),
      );
      yield* fs.chmod(file, 0o600);
      expect(refused._tag).toBe("Failure");
      expect(yield* fs.readFileString(file)).toBe(before);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const remoteItem = (position: number, runId: RunId, text: string) => ({
  position,
  visibility: "local",
  sourceThreadId: target,
  itemId: "item-" + position,
  runId,
  messageId: null,
  createdBy: null,
  creationSource: null,
  type: "assistant_message",
  status: "completed",
  title: null,
  text,
  textTruncated: false,
  updatedAt: "2026-10-12T00:00:00.000Z",
});

const remoteRead = (input: {
  readonly itemCount: number;
  readonly items?: ReadonlyArray<unknown>;
  readonly nextPosition?: number;
}) => ({
  thread: {
    threadId: target,
    projectId: "remote-project",
    title: "Remote fix",
    createdBy: "agent",
    creationSource: "mcp",
    status: "completed",
    latestRunId: run1,
    activeRunId: null,
    providerInstanceId: "codex",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: "goat/remote",
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 1,
    itemCount: input.itemCount,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  },
  recentRuns: [],
  items: input.items ?? [],
  nextPosition: input.nextPosition ?? null,
  hasMore: input.nextPosition !== undefined,
});
