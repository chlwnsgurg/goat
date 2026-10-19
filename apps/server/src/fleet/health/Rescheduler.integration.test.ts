import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type GoatHostStatusResult, ThreadId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import * as FleetHealthStore from "./FleetHealthStore.ts";
import * as HostHealthMonitor from "./HostHealthMonitor.ts";
import * as Rescheduler from "./Rescheduler.ts";

interface RemoteThread {
  readonly host: string;
  readonly threadId: ThreadId;
  readonly title: string;
}

interface World {
  readonly reachable: Record<string, boolean>;
  readonly threads: Array<RemoteThread>;
  readonly launches: Array<SshRemoteDispatch.SshLaunchInput>;
  readonly calls: Array<{
    readonly host: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
  }>;
  /** The next launch creates its thread, then the answer is lost (SSH dropped mid-call). */
  loseNextLaunchResponse: boolean;
}

const newWorld = (): World => ({
  reachable: { A: true, B: true },
  threads: [{ host: "A", threadId: ThreadId.make("thread:a1"), title: "Worker" }],
  launches: [],
  calls: [],
  loseNextLaunchResponse: false,
});

const unavailable = (host: string) =>
  new SshRemoteDispatch.SshRemoteDispatchError({
    reason: "host_unavailable",
    message: host + " did not answer",
  });

const fakeDispatch = (world: World) =>
  ({
    connectedHosts: Effect.succeed(Object.keys(world.reachable)),
    callHostTool: (
      call: SshRemoteDispatch.SshHostToolCall,
      authorize: Effect.Effect<unknown, unknown>,
    ) =>
      Effect.gen(function* () {
        yield* Effect.orDie(authorize);
        world.calls.push({ host: call.host, tool: call.tool, args: { ...call.arguments } });
        if (world.reachable[call.host] !== true) return yield* unavailable(call.host);
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        switch (call.tool) {
          case "goat_thread_status": {
            const thread = world.threads.find(
              (candidate) =>
                candidate.host === call.host && candidate.threadId === call.arguments.threadId,
            );
            return {
              structuredContent: {
                threadId: call.arguments.threadId,
                title: thread?.title ?? "gone",
                phase: "running",
                terminal: false,
                run: {
                  runId: "run:1",
                  status: "running",
                  requestedAt: now,
                  startedAt: now,
                  completedAt: null,
                },
                queuedRunId: null,
                pendingRequest: null,
                lastActivityAt: now,
                lastMessage: null,
                lastError: null,
                watch: null,
              },
            };
          }
          case "goat_thread_list":
            return {
              structuredContent: {
                threads: world.threads
                  .filter(
                    (thread) =>
                      thread.host === call.host &&
                      thread.title.includes(String(call.arguments.titleContains)),
                  )
                  .map((thread) => ({ threadId: thread.threadId, title: thread.title })),
              },
            };
          case "goat_project_list":
            return { structuredContent: { projects: [{ id: "project", workspaceRoot: "/repo" }] } };
          default:
            return { structuredContent: {} };
        }
      }),
    launchThread: (
      input: SshRemoteDispatch.SshLaunchInput,
      beforeLaunch: Effect.Effect<void, unknown>,
    ) =>
      Effect.gen(function* () {
        yield* Effect.orDie(beforeLaunch);
        if (world.reachable[input.host] !== true) return yield* unavailable(input.host);
        world.launches.push(input);
        const threadId = ThreadId.make("thread:" + input.host + world.launches.length);
        world.threads.push({ host: input.host, threadId, title: input.title });
        if (world.loseNextLaunchResponse) {
          world.loseNextLaunchResponse = false;
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "the connection dropped before the answer",
            launchMayHaveStarted: true,
          });
        }
        return {
          host: input.host,
          cwd: input.cwd,
          projectId: "project",
          projectCreated: false,
          threadId,
          reportsSupported: false,
          runId: null,
          workspaceStrategy: { type: "worktree" },
          runtimeMode: input.runtimeMode,
          remoteServerKind: null,
          notes: [],
        };
      }),
  }) as unknown as SshRemoteDispatch.SshRemoteDispatch["Service"];

const sampleOf = (world: World) =>
  Effect.sync((): GoatHostStatusResult => ({
    hosts: Object.entries(world.reachable).map(([host, up]) =>
      up
        ? { host, reachability: "ok" as const, serverVersion: "1" }
        : { host, reachability: "unreachable" as const, message: host + " timed out" },
    ),
  }));

const layerFor = (world: World, baseDir: string) =>
  Rescheduler.layerWithoutScheduler.pipe(
    Layer.provideMerge(
      Layer.effect(HostHealthMonitor.Health, HostHealthMonitor.make({ sample: sampleOf(world) })),
    ),
    Layer.provideMerge(FleetHealthStore.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SshRemoteDispatch.SshRemoteDispatch, fakeDispatch(world)),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
      ),
    ),
  );

/** A fresh server over baseDir: in-memory host contacts start empty, the store reloads. */
const withServer = <A, E>(
  world: World,
  baseDir: string,
  body: Effect.Effect<A, E, Rescheduler.Rescheduler | FleetHealthStore.FleetHealthStore>,
) => body.pipe(Effect.provide(layerFor(world, baseDir)));

/** Scheduler ticks, 30 s apart: short enough that no tick gap looks like sleep. */
const runFor = (minutes: number) =>
  Effect.gen(function* () {
    const rescheduler = yield* Rescheduler.Rescheduler;
    for (let step = 0; step < minutes * 2; step += 1) {
      yield* TestClock.adjust(Duration.seconds(30));
      yield* rescheduler.tick;
    }
  });

const onlyWorker = FleetHealthStore.FleetHealthStore.pipe(
  Effect.flatMap((store) => store.read),
  Effect.map((document) => {
    expect(document.workers).toHaveLength(1);
    return document.workers[0]!;
  }),
);

const register = Effect.gen(function* () {
  const rescheduler = yield* Rescheduler.Rescheduler;
  yield* rescheduler.register({
    launcherThreadId: null,
    ceiling: "full-access",
    host: "A",
    threadId: ThreadId.make("thread:a1"),
    branch: "feat/x",
    cwd: "/repo",
    title: "Worker",
    message: "Build the thing.",
    modelSelection: null,
    runtimeMode: "full-access",
  });
});

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "goat-fleet-health-" });
}).pipe(Effect.provide(NodeServices.layer));

describe("Rescheduler", () => {
  it.effect(
    "relaunches a worker from an unreachable host on another host exactly once, across ticks and a restart, and fences the old thread when it returns",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const baseDir = yield* tempDir;

          yield* withServer(
            world,
            baseDir,
            Effect.gen(function* () {
              yield* register;
              yield* runFor(1);
              world.reachable.A = false;
              world.loseNextLaunchResponse = true;
              // Inside the eviction bound nothing moves.
              yield* runFor(10);
              expect(world.launches).toHaveLength(0);
              // Tick until the launch goes out, then "crash" before any later tick runs.
              const rescheduler = yield* Rescheduler.Rescheduler;
              for (let step = 0; step < 20 && world.launches.length === 0; step += 1) {
                yield* TestClock.adjust(Duration.seconds(30));
                yield* rescheduler.tick;
              }
              expect(world.launches).toHaveLength(1);
              expect(yield* onlyWorker).toMatchObject({ phase: "launching", host: "A" });
            }),
          );

          // Restart: the lost launch is found on B by its title, never launched again.
          yield* withServer(
            world,
            baseDir,
            Effect.gen(function* () {
              yield* runFor(5);
              yield* runFor(2);
              expect(world.launches).toHaveLength(1);
              const worker = yield* onlyWorker;
              expect(worker).toMatchObject({
                phase: "watching",
                host: "B",
                threadId: "thread:B1",
                branch: "feat/x-r1",
                generation: 1,
                fenced: [{ host: "A", threadId: "thread:a1", generation: 0, stoppedAt: null }],
              });
              const launch = world.launches[0]!;
              expect(launch).toMatchObject({
                host: "B",
                cwd: "/repo",
                title: "Worker · r1",
                workspace: {
                  type: "worktree",
                  branch: "feat/x-r1",
                  baseRef: "feat/x",
                  startFromOrigin: true,
                },
              });
              expect(launch.message).toContain("Resume from branch feat/x");
              expect(launch.message).toContain("Build the thing.");

              // A comes back: its thread is interrupted and told to stop, once.
              world.reachable.A = true;
              yield* runFor(2);
              const toA = world.calls.filter(
                (call) => call.host === "A" && call.args.threadId === "thread:a1",
              );
              expect(
                toA.filter((call) => call.tool === "goat_thread_interrupt").length,
              ).toBeGreaterThan(0);
              const fenceNotes = toA.filter((call) => call.tool === "goat_thread_send");
              expect(fenceNotes).toHaveLength(1);
              expect(String(fenceNotes[0]!.args.message)).toContain("moved to B");
              expect((yield* onlyWorker).fenced[0]!.stoppedAt).not.toBeNull();
              yield* runFor(3);
              expect(
                world.calls.filter((call) => call.host === "A" && call.tool === "goat_thread_send"),
              ).toHaveLength(1);
              expect(world.launches).toHaveLength(1);
            }),
          );
        }),
      ),
  );

  it.effect("does not move work when this machine wakes from an hour of sleep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        const baseDir = yield* tempDir;
        yield* withServer(
          world,
          baseDir,
          Effect.gen(function* () {
            const rescheduler = yield* Rescheduler.Rescheduler;
            yield* register;
            yield* runFor(1);
            // SSH drops as the lid closes; then the machine sleeps for an hour.
            world.reachable.A = false;
            yield* runFor(3);
            yield* TestClock.adjust(Duration.minutes(60));
            yield* rescheduler.tick;
            // Tunnels take a few minutes to come back after waking.
            yield* runFor(6);
            world.reachable.A = true;
            yield* runFor(5);
            expect(world.launches).toHaveLength(0);
            expect(yield* onlyWorker).toMatchObject({ host: "A", phase: "watching", attempts: 0 });
          }),
        );
      }),
    ),
  );

  it.effect("moves by hand only to a host that can take work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        const baseDir = yield* tempDir;
        yield* withServer(
          world,
          baseDir,
          Effect.gen(function* () {
            const rescheduler = yield* Rescheduler.Rescheduler;
            yield* register;
            const unknown = yield* rescheduler
              .reschedule({
                host: "A",
                threadId: ThreadId.make("thread:a1"),
                targetHost: "B",
                reason: "test",
              })
              .pipe(Effect.flip);
            // B has not answered goat_host_status yet, so it is not Ready.
            expect(unknown.code).toBe("invalid_request");
            yield* runFor(1);
            const moved = yield* rescheduler.reschedule({
              host: "A",
              threadId: ThreadId.make("thread:a1"),
              targetHost: "B",
              reason: "rebalance",
            });
            // A answers, so its thread is asked to push before anything launches.
            expect(moved.action).toBe("move");
            expect(moved.worker.phase).toBe("push_requested");
            expect(world.launches).toHaveLength(0);
            const push = world.calls.find(
              (call) => call.host === "A" && call.tool === "goat_thread_send",
            );
            expect(String(push?.args.message)).toContain("git push origin HEAD:feat/x");
          }),
        );
      }),
    ),
  );
});
