import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
  readonly assistantMessages: Array<{ runId: RunId; text: string }>;
  requests: Array<{ id: string; status: string; kind: string }>;
  /** Failures for the next dispatches, used up in order. */
  readonly dispatchFailures: Array<unknown>;
  readonly attempts: Array<Dispatch>;
  readonly delivered: Queue.Queue<Dispatch>;
  readonly deliveredLog: Array<Dispatch>;
  hostCall: (
    call: SshRemoteDispatch.SshHostToolCall,
  ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  readonly hostCalls: Array<{ call: SshRemoteDispatch.SshHostToolCall; ceiling: string }>;
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
    assistantMessages: [],
    requests: [],
    dispatchFailures: [],
    attempts: [],
    delivered: yield* Queue.unbounded<Dispatch>(),
    deliveredLog: [],
    hostCall: (call) => Effect.die(new Error("unexpected host call " + call.tool)),
    hostCalls: [],
  };
  return world;
});

const layerFor = (world: World, baseDir: string) =>
  LaunchWatchService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              (world.shells.get(threadId) ?? null) as OrchestrationV2ThreadShell | null,
            ),
          waitForThread: (input) =>
            Effect.suspend(() => {
              world.waitCalls.push(input);
              return Queue.take(world.waits).pipe(Effect.flatten);
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
          dispatch: (command) =>
            Effect.suspend(() => {
              const dispatch = command as Dispatch;
              world.attempts.push(dispatch);
              const failure = world.dispatchFailures.shift();
              if (failure !== undefined) return Effect.fail(failure as never);
              world.deliveredLog.push(dispatch);
              return Queue.offer(world.delivered, dispatch).pipe(Effect.as({} as never));
            }),
        }),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          callHostTool: (call, authorize) =>
            authorize.pipe(
              Effect.flatMap((ceiling) => {
                world.hostCalls.push({ call, ceiling });
                return world.hostCall(call);
              }),
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

/** Lets forked followers run until check holds. */
const eventually = (check: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5_000; attempt++) {
      if (check()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("never happened: " + what));
  });

/** Advances time until check holds, for followers sleeping through backoff. */
const eventuallyWithTime = (check: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let round = 0; round < 60; round++) {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (check()) return;
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("16 minutes");
    }
    return yield* Effect.die(new Error("never happened: " + what));
  });

const finished = (runId: RunId, status: "completed" | "failed" = "completed"): WaitAnswer =>
  Effect.succeed({ threadId: target, run: { id: runId, status } as never, timedOut: false });

const stillRunning = (runId: RunId): WaitAnswer =>
  Effect.succeed({
    threadId: target,
    run: { id: runId, status: "running" } as never,
    timedOut: true,
  });

const watchLocal = (service: LaunchWatchService.LaunchWatchServiceShape, runId: RunId | null) =>
  service.register({
    launcherThreadId: launcher,
    host: null,
    threadId: target,
    projectId,
    title: "Fix the flake",
    runId,
  });

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
          yield* eventually(
            () => world.waitCalls.length === 1,
            "the follower stops after the last run",
          );
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

  it.effect("reports queued runs in order, each once", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          // A send while run 1 is still going queues run 2; resending run 1 changes nothing.
          yield* service.rearm({
            launcherThreadId: launcher,
            host: null,
            threadId: target,
            runId: run2,
          });
          yield* service.rearm({
            launcherThreadId: launcher,
            host: null,
            threadId: target,
            runId: run1,
          });
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.offer(world.waits, finished(run2, "failed"));
          const first = yield* Queue.take(world.delivered);
          const second = yield* Queue.take(world.delivered);
          expect(first.text).toContain("finished run run-1 with status completed");
          expect(second.text).toContain("finished run run-2 with status failed");
          expect(second.notification?.outcome).toBe("failed");
          expect(world.waitCalls.map((call) => call.runId)).toEqual([run1, run2]);
          // A reported run is not followed again.
          yield* service.rearm({
            launcherThreadId: launcher,
            host: null,
            threadId: target,
            runId: run2,
          });
          const [watch] = yield* service.list(launcher);
          expect(watch?.pendingRuns).toEqual([]);
        }),
      );
      expect(world.waitCalls).toHaveLength(2);
    }),
  );

  it.effect("resumes a pending run after a restart without a wake from the shutdown", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* eventually(() => world.waitCalls.length === 1, "the follower waits on run 1");
        }),
      );
      // Stopping the server mid-wait reports nothing and leaves the run owed.
      expect(world.deliveredLog).toEqual([]);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          const [watch] = yield* service.list(launcher);
          expect(watch?.pendingRuns).toEqual([run1]);
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
          world.requests = [{ id: "question-1", status: "pending", kind: "user_input" }];
          yield* Queue.offer(world.waits, stillRunning(run1));
          const first = yield* Queue.take(world.delivered);
          expect(first.text).toContain("waiting on a user input request (question-1)");
          expect(first.text).toContain("goat_pending_request_read");
          expect(first.notification?.outcome).toBe("updated");

          // The same question at the next tick is not news; a second one is.
          yield* Queue.offer(world.waits, stillRunning(run1));
          yield* eventually(() => world.waitCalls.length === 3, "the next tick");
          world.requests = [
            { id: "question-1", status: "pending", kind: "user_input" },
            { id: "question-2", status: "pending", kind: "command" },
            { id: "tool-call", status: "pending", kind: "dynamic_tool_call" },
          ];
          yield* Queue.offer(world.waits, stillRunning(run1));
          const second = yield* Queue.take(world.delivered);
          expect(second.text).toContain("question-2");

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
            return Effect.succeed(
              call.arguments.limit === 1
                ? remoteRead({ itemCount: 100, items: [] })
                : remoteRead({
                    itemCount: 100,
                    items: [
                      remoteItem(70, run1, "First pass done."),
                      remoteItem(80, run2, "An answer from another run."),
                      remoteItem(95, run1, "Remote fix pushed."),
                    ],
                  }),
            );
          default:
            return Effect.die(new Error("unexpected " + call.tool));
        }
      };
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            launcherThreadId: launcher,
            host: " box ",
            threadId: target,
            projectId: null,
            title: null,
            runId: run1,
          });
          yield* eventuallyWithTime(() => world.deliveredLog.length === 2, "outage then finish");
          const [outage, done] = world.deliveredLog;
          expect(outage?.text).toMatch(/^host_unavailable: T3 Code cannot reach host box/);
          expect(outage?.notification?.outcome).toBe("unknown");
          expect(done?.text).toContain("(threadId target, host box) finished run run-1");
          expect(done?.text).toContain("Remote fix pushed.");
          expect(done?.text).not.toContain("another run");
          yield* eventuallyEffect(
            service.list(launcher).pipe(Effect.map(([watch]) => watch?.outage === null)),
            "contact ends the outage",
          );
        }),
      );
      // Reads only, capped at the launcher's runtime mode.
      expect(
        world.hostCalls.every(({ call }) => call.writes === false && call.host === "box"),
      ).toBe(true);
      expect(world.hostCalls.every(({ ceiling }) => ceiling === "full-access")).toBe(true);
      // The transcript tail starts a fixed window before its end.
      expect(readArgs[1]).toMatchObject({ view: "messages", afterPosition: 59 });
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
          yield* service.register({
            launcherThreadId: launcher,
            host: "box",
            threadId: target,
            projectId: null,
            title: null,
            runId: run1,
          });
          const wake = yield* Queue.take(world.delivered);
          expect(wake.text).toContain("Short answer.");
        }),
      );
      expect(readArgs[1]).not.toHaveProperty("afterPosition");
    }),
  );

  it.effect("stops an unwatched follower, and a new watch reports its own run", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* eventually(() => world.waitCalls.length === 1, "the follower waits on run 1");
          const target_ = { launcherThreadId: launcher, host: null, threadId: target };
          expect(yield* service.unwatch(target_)).toBe(true);
          expect(yield* service.unwatch(target_)).toBe(false);
          yield* watchLocal(service, run2);
          yield* eventually(() => world.waitCalls.length === 2, "a new follower waits on run 2");
          expect(world.waitCalls[1]?.runId).toBe(run2);
          yield* Queue.offer(world.waits, finished(run2));
          const wake = yield* Queue.take(world.delivered);
          expect(wake.commandId).toContain("run:run-2");
        }),
      );
      expect(world.deliveredLog).toHaveLength(1);
    }),
  );

  it.effect("drops the watch without a wake when the launcher is archived", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.shells.set(launcher, {
        ...world.shells.get(launcher),
        archivedAt: DateTime.makeUnsafe(0) as never,
      });
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* eventuallyEffect(
            service.list(launcher).pipe(Effect.map((watches) => watches.length === 0)),
            "the watch is dropped",
          );
        }),
      );
      expect(world.waitCalls).toEqual([]);
      expect(world.deliveredLog).toEqual([]);
    }),
  );

  it.effect("retries a wake the orchestrator could not store, and drops one it refused", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      world.dispatchFailures.push(
        new OrchestratorDispatchError({ commandId: "x" as never, commandType: "message.dispatch" }),
      );
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.offer(world.waits, finished(run1));
          yield* eventuallyWithTime(() => world.deliveredLog.length === 1, "the retried wake");
          expect(world.attempts.map((attempt) => attempt.commandId)).toEqual([
            world.deliveredLog[0]!.commandId,
            world.deliveredLog[0]!.commandId,
          ]);

          world.dispatchFailures.push(
            new OrchestratorCommandPreviouslyRejectedError({
              commandId: "y" as never,
              commandType: "message.dispatch",
              detail: "rejected",
            }),
          );
          yield* service.rearm({
            launcherThreadId: launcher,
            host: null,
            threadId: target,
            runId: run2,
          });
          yield* Queue.offer(world.waits, finished(run2));
          yield* eventuallyEffect(
            service.list(launcher).pipe(Effect.map(([watch]) => watch?.pendingRuns.length === 0)),
            "the refused run is settled",
          );
          yield* TestClock.adjust("16 minutes");
          expect(world.attempts).toHaveLength(3);
        }),
      );
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
});

/** Polls an effectful check while followers run. */
const eventuallyEffect = (check: Effect.Effect<boolean>, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5_000; attempt++) {
      if (yield* check) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("never happened: " + what));
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
  readonly items: ReadonlyArray<unknown>;
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
  items: input.items,
  nextPosition: null,
  hasMore: false,
});
