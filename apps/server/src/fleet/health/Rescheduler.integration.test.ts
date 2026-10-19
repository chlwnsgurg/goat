import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type HostStatusEntry, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import Migration0085 from "../../persistence/Migrations/085_FleetHealth.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import * as FleetHostStates from "./FleetHostStates.ts";
import * as Health from "./Health.ts";
import * as HostHealthMonitor from "./HostHealthMonitor.ts";
import * as Rescheduler from "./Rescheduler.ts";

interface RemoteThread {
  readonly host: string;
  readonly threadId: ThreadId;
  readonly title: string;
  phase: string;
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
  /** Interrupts the remote applied, by clientRequestId, as a GOAT server dedupes them. */
  readonly appliedInterrupts: Set<string>;
  /** The next launch creates its thread, then the answer is lost (SSH dropped mid-call). */
  loseNextLaunchResponse: boolean;
}

const newWorld = (): World => ({
  reachable: { A: true, B: true },
  threads: [{ host: "A", threadId: ThreadId.make("thread:a1"), title: "Worker", phase: "running" }],
  launches: [],
  calls: [],
  appliedInterrupts: new Set(),
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
    callHostTool: (call: SshRemoteDispatch.SshHostToolCall) =>
      Effect.gen(function* () {
        world.calls.push({ host: call.host, tool: call.tool, args: { ...call.arguments } });
        if (world.reachable[call.host] !== true) return yield* unavailable(call.host);
        const thread = world.threads.find(
          (candidate) =>
            candidate.host === call.host && candidate.threadId === call.arguments.threadId,
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        switch (call.tool) {
          case "goat_thread_status":
            return {
              structuredContent: {
                threadId: call.arguments.threadId,
                title: thread?.title ?? "gone",
                phase: thread?.phase ?? "completed",
                terminal: thread?.phase !== "running",
                run: {
                  runId: "run:1",
                  status: thread?.phase ?? "completed",
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
          case "goat_thread_interrupt": {
            const id = String(call.arguments.clientRequestId);
            if (!world.appliedInterrupts.has(id) && thread !== undefined)
              thread.phase = "interrupted";
            world.appliedInterrupts.add(id);
            return {
              structuredContent: {
                threadId: call.arguments.threadId,
                runId: null,
                status: "interrupt_requested",
              },
            };
          }
          case "goat_thread_list":
            return {
              structuredContent: {
                threads: world.threads
                  .filter(
                    (entry) =>
                      entry.host === call.host &&
                      entry.title.includes(String(call.arguments.titleContains)),
                  )
                  .map((entry) => ({ threadId: entry.threadId, title: entry.title })),
              },
            };
          default:
            return { structuredContent: {} };
        }
      }),
    launchThread: (input: SshRemoteDispatch.SshLaunchInput) =>
      Effect.gen(function* () {
        const host = input.host ?? "local";
        if (world.reachable[host] !== true) return yield* unavailable(host);
        world.launches.push(input);
        const threadId = ThreadId.make("thread:" + host + world.launches.length);
        world.threads.push({ host, threadId, title: input.title, phase: "running" });
        if (world.loseNextLaunchResponse) {
          world.loseNextLaunchResponse = false;
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "the connection dropped before the answer",
            launchMayHaveStarted: true,
          });
        }
        return {
          host,
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

const probeOf = (world: World) => (host: string) =>
  Effect.sync((): HostStatusEntry =>
    world.reachable[host] === true
      ? { host, reachability: "ok", serverVersion: "1" }
      : { host, reachability: "unreachable", message: host + " timed out" },
  );

/** A fresh server over one database file: host contacts start empty, cordons persist. */
const layerFor = (world: World, filename: string) =>
  Layer.mergeAll(Health.layer, Rescheduler.layer).pipe(
    Layer.provideMerge(
      Layer.effect(
        HostHealthMonitor.HostHealthMonitor,
        HostHealthMonitor.make({ probe: probeOf(world) }),
      ),
    ),
    Layer.provideMerge(FleetHostStates.layer),
    Layer.provideMerge(
      // A restart reopens the same file; the tables already exist then.
      Layer.effectDiscard(Effect.ignore(Migration0085)).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename })),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(SshRemoteDispatch.SshRemoteDispatch, fakeDispatch(world)),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      ),
    ),
  );

type Services = Layer.Success<ReturnType<typeof layerFor>>;
const withServer = <A, E>(world: World, filename: string, body: Effect.Effect<A, E, Services>) =>
  body.pipe(Effect.provide(layerFor(world, filename)));

const databaseFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "goat-fleet-health-" }),
    "state.sqlite",
  );
}).pipe(Effect.provide(NodeServices.layer));

const ref = { host: "A", threadId: ThreadId.make("thread:a1"), watchId: null };

const request = (
  overrides: Partial<Rescheduler.RescheduleRequest> = {},
): Rescheduler.RescheduleRequest => ({
  ref,
  owner: "goal:g1",
  attempt: 1,
  reason: "host_unreachable",
  modelSelection: { instanceId: "codex" as never, model: "gpt-6.1-sol" },
  workspace: { baseRef: "dev", branch: "goal-g1-s0-a2", startFromOrigin: true },
  previousBranch: "goal-g1-s0-a1",
  replica: null,
  prompt: "Ship the thing.",
  runtimeMode: "full-access",
  clientRequestId: "goal:g1:s0:a2:launch",
  project: { cwd: "/repo", canonicalKey: null },
  ...overrides,
});

/** Thread health reads, a minute apart, as the controller makes them; each is a host contact. */
const observe = (minutes: number) =>
  Effect.gen(function* () {
    const health = yield* Health.Health;
    let last = yield* health.threadHealth(ref);
    for (let minute = 0; minute < minutes; minute += 1) {
      yield* TestClock.adjust(Duration.minutes(1));
      last = yield* health.threadHealth(ref);
    }
    return last;
  });

describe("Rescheduler", () => {
  it.effect(
    "resumes work from a Lost host on another host exactly once, across a lost answer and a restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const filename = yield* databaseFile;

          yield* withServer(
            world,
            filename,
            Effect.gen(function* () {
              const rescheduler = yield* Rescheduler.Rescheduler;
              expect((yield* observe(0))._tag).toBe("healthy");
              world.reachable.A = false;
              expect((yield* observe(3))._tag).toBe("unknown");
              // Unreachable but not Lost: nothing moves yet.
              expect(yield* rescheduler.reschedule(request())).toMatchObject({
                _tag: "Refused",
                reason: "host_still_answers",
              });
              expect((yield* observe(5))._tag).toBe("host_lost");
              world.loseNextLaunchResponse = true;
              expect(yield* rescheduler.reschedule(request())).toMatchObject({
                _tag: "Refused",
                reason: "no_capacity",
              });
              expect(world.launches).toHaveLength(1);
            }),
          );

          // After a restart the retry finds the launched thread instead of starting a second one.
          yield* withServer(
            world,
            filename,
            Effect.gen(function* () {
              const rescheduler = yield* Rescheduler.Rescheduler;
              const first = yield* rescheduler.reschedule(request());
              const again = yield* rescheduler.reschedule(request());
              expect(first).toEqual({
                _tag: "Rescheduled",
                host: "B",
                threadId: "thread:B1",
                branch: "goal-g1-s0-a2",
                resumedFrom: "branch",
              });
              expect(again).toEqual(first);
              expect(world.launches).toHaveLength(1);
            }),
          );

          const launch = world.launches[0]!;
          expect(launch).toMatchObject({
            host: "B",
            cwd: "/repo",
            title: "Resume goal-g1-s0-a2",
            runtimeMode: "full-access",
            workspace: {
              type: "worktree",
              branch: "goal-g1-s0-a2",
              baseRef: "goal-g1-s0-a1",
              startFromOrigin: true,
            },
          });
          expect(launch.message).toContain("Ship the thing.");
          expect(launch.message).toContain("GOAT moved this work from thread thread:a1 on A");
        }),
      ),
  );

  it.effect(
    "never moves work off a host that answers before its attempt is interrupted, and respects cordons",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const filename = yield* databaseFile;
          yield* withServer(
            world,
            filename,
            Effect.gen(function* () {
              const rescheduler = yield* Rescheduler.Rescheduler;
              const monitor = yield* HostHealthMonitor.HostHealthMonitor;
              const states = yield* FleetHostStates.FleetHostStates;
              yield* monitor.annotate({
                hosts: [{ host: "B", reachability: "ok", serverVersion: "1" }],
              });

              expect(
                yield* rescheduler.reschedule(request({ reason: "host_unreachable" })),
              ).toMatchObject({
                reason: "host_still_answers",
              });
              const stalled = request({ reason: "stalled" });
              expect(yield* rescheduler.reschedule(stalled)).toMatchObject({
                reason: "host_still_answers",
              });
              expect(world.launches).toHaveLength(0);
              expect(
                world.calls.filter((call) => call.tool === "goat_thread_interrupt"),
              ).toHaveLength(1);

              yield* states.cordon({
                host: "B",
                draining: false,
                reason: "maintenance",
                changedBy: "test",
              });
              expect(yield* rescheduler.reschedule(stalled)).toMatchObject({
                reason: "no_capacity",
              });
              yield* states.uncordon("B");

              expect(yield* rescheduler.reschedule(stalled)).toMatchObject({
                _tag: "Rescheduled",
                host: "B",
              });
              expect(world.launches).toHaveLength(1);
            }),
          );
        }),
      ),
  );

  it.effect("does not count a host as Lost when this machine wakes from an hour of sleep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        const filename = yield* databaseFile;
        yield* withServer(
          world,
          filename,
          Effect.gen(function* () {
            const monitor = yield* HostHealthMonitor.HostHealthMonitor;
            const rescheduler = yield* Rescheduler.Rescheduler;
            yield* monitor.tick;
            world.reachable.A = false;
            // The lid closes: two contacts fail, then the machine sleeps for an hour.
            yield* observe(2);
            yield* TestClock.adjust(Duration.minutes(60));
            yield* monitor.tick;
            // Tunnels take a few minutes to come back after waking.
            for (let minute = 0; minute < 4; minute += 1) {
              yield* TestClock.adjust(Duration.minutes(1));
              yield* monitor.tick;
              expect((yield* (yield* Health.Health).threadHealth(ref))._tag).toBe("unknown");
            }
            expect(yield* rescheduler.reschedule(request())).toMatchObject({
              reason: "host_still_answers",
            });
            world.reachable.A = true;
            expect((yield* observe(1))._tag).toBe("healthy");
            expect(world.launches).toHaveLength(0);
          }),
        );
      }),
    ),
  );

  it.effect("stops a superseded attempt once when its host returns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        const filename = yield* databaseFile;
        yield* withServer(
          world,
          filename,
          Effect.gen(function* () {
            const fence = Rescheduler.fenceStaleAttempt({
              ref,
              successorHost: "B",
              successorBranch: "goal-g1-s0-a2",
              clientRequestId: "goal:g1:s0:a1:interrupt",
              ceiling: "full-access",
            });
            world.reachable.A = false;
            expect((yield* Effect.result(fence))._tag).toBe("Failure");
            world.reachable.A = true;
            yield* fence;
            yield* fence;
            const interrupts = world.calls.filter(
              (call) => call.host === "A" && call.tool === "goat_thread_interrupt",
            );
            expect(interrupts.map((call) => call.args.clientRequestId)).toEqual([
              "goal:g1:s0:a1:interrupt",
              "goal:g1:s0:a1:interrupt",
              "goal:g1:s0:a1:interrupt",
            ]);
            expect(String(interrupts[1]!.args.reason)).toContain(
              "continues on B on branch goal-g1-s0-a2",
            );
            expect(world.appliedInterrupts.size).toBe(1);
            expect(
              world.calls.some((call) => call.host === "A" && call.tool === "goat_thread_send"),
            ).toBe(false);
          }),
        );
      }),
    ),
  );
});
