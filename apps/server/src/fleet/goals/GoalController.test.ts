import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { FleetGoalId, OrchestratorMcpFailure, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as FleetDefaults from "../defaults.ts";
import { Health } from "../health/Health.ts";
import { GoalController, layer as controllerLayer } from "./GoalController.ts";
import type { PullRequestObservation } from "./goalPlan.ts";
import { GoalStore, layer as goalStoreLayer } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import {
  GoalWorkerRuntime,
  type LaunchRequest,
  type OwnerAccess,
  type WorkerReading,
} from "./GoalWorkerRuntime.ts";

interface Fake {
  readonly launches: Array<LaunchRequest>;
  readonly followUps: Array<{ readonly actionId: string; readonly message: string }>;
  readonly threads: Map<string, ThreadId>;
  /** The next launch creates its thread and then dies, as a server killed mid-launch would. */
  crashAfterStart: boolean;
  /** The next launch creates its thread and then reports an error. */
  failAfterStart: boolean;
  reading: WorkerReading;
  owner: OwnerAccess | { readonly unavailable: string };
}

const access: OwnerAccess = {
  scope: {} as OwnerAccess["scope"],
  runtimeMode: "full-access",
  canReachHosts: true,
};

const makeFake = (): Fake => ({
  launches: [],
  followUps: [],
  threads: new Map(),
  crashAfterStart: false,
  failAfterStart: false,
  reading: {
    kind: "seen",
    terminal: false,
    runId: RunId.make("run:1"),
    runStatus: "running",
    lastActivityAt: null,
    result: null,
  },
  owner: access,
});

const runtimeFor = (fake: Fake) =>
  Layer.succeed(GoalWorkerRuntime, {
    owner: () => Effect.sync(() => fake.owner),
    observeWorker: () => Effect.sync(() => fake.reading),
    observePullRequest: () =>
      Effect.succeed<PullRequestObservation>({ kind: "seen", state: "open", checks: "pending" }),
    observeIssue: () => Effect.succeed("open" as const),
    findLaunched: (_access, _goal, actionId) =>
      Effect.sync(() => {
        const threadId = fake.threads.get(actionId);
        return threadId === undefined ? null : { host: null, threadId, runId: null };
      }),
    launch: (_access, request) =>
      Effect.suspend(() => {
        fake.launches.push(request);
        const threadId = ThreadId.make("thread:worker-" + fake.launches.length);
        fake.threads.set(request.actionId, threadId);
        if (fake.crashAfterStart) {
          fake.crashAfterStart = false;
          return Effect.die("server stopped mid-launch");
        }
        if (fake.failAfterStart) {
          fake.failAfterStart = false;
          return Effect.fail(
            new OrchestratorMcpFailure({ code: "orchestration_error", message: "lost reply" }),
          );
        }
        return Effect.succeed({ host: null, threadId, runId: RunId.make("run:1") });
      }),
    followUp: (_access, _worker, message, actionId) =>
      Effect.sync(() => {
        fake.followUps.push({ actionId, message });
      }),
    interrupt: () => Effect.void,
  });

const healthy = Layer.succeed(Health, {
  hostCondition: (host) => Effect.succeed({ host, conditions: [], observedAt: "" }),
  threadHealth: () => Effect.succeed({ _tag: "healthy" as const }),
});

const persistence = (path: string | undefined) =>
  path === undefined
    ? SqlitePersistence.layerMemory
    : SqlitePersistence.layerFromPath(path).pipe(Layer.provide(NodeServices.layer));

const layerFor = (
  fake: Fake,
  options: { readonly enabled?: boolean; readonly path?: string } = {},
) =>
  controllerLayer.pipe(
    Layer.provideMerge(goalStoreLayer),
    Layer.provideMerge(persistence(options.path)),
    Layer.provide(runtimeFor(fake)),
    Layer.provide(
      Layer.mergeAll(
        FleetDefaults.layerPlacement,
        FleetDefaults.layerRescheduler,
        FleetDefaults.layerFallback,
        healthy,
      ),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        fleet: { controllerEnabled: options.enabled ?? true },
      }),
    ),
  );

const twoWorkers = (id: string) =>
  testGoal(id, { spec: testSpec({ workers: { ...testSpec().workers, count: 2 } }) });

const insert = (goal: ReturnType<typeof testGoal>) =>
  GoalStore.pipe(Effect.flatMap((store) => store.create(goal, "thread:thread:owner", null)));

const record = (id: string) =>
  GoalStore.pipe(
    Effect.flatMap((store) => store.get(FleetGoalId.make(id))),
    Effect.map((found) => found!),
  );

describe("GoalController", () => {
  it.effect("does nothing while fleet.controllerEnabled is off", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      yield* insert(twoWorkers("goal_off"));
      yield* (yield* GoalController).runDue;
      expect(fake.launches).toEqual([]);
      expect((yield* record("goal_off")).goal.status.lastReconcileAt).toBeNull();
    }).pipe(Effect.provide(layerFor(fake, { enabled: false })));
  });

  it.effect(
    "launches each slot once, claimed first, and a second tick launches nothing new",
    () => {
      const fake = makeFake();
      return Effect.gen(function* () {
        const controller = yield* GoalController;
        const store = yield* GoalStore;
        yield* insert(twoWorkers("goal_two"));
        yield* controller.runDue;
        yield* controller.reconcile(yield* record("goal_two"), 10);
        expect(fake.launches.map((launch) => launch.actionId)).toEqual([
          "goal:goal_two:s0:a1:launch",
          "goal:goal_two:s1:a1:launch",
        ]);
        expect(fake.launches[0]).toMatchObject({ branch: "goal/test/s0-a1", host: null });
        expect(fake.launches[0]!.title).toMatch(/\[goal:goal_two:s0:a1:launch\]$/);
        expect(yield* store.claimOf("goal:goal_two:s0:a1:launch")).toMatchObject({
          outcome: "launched",
        });
        const { goal, workers } = yield* record("goal_two");
        expect(workers.map((worker) => worker.threadId)).toEqual([
          "thread:worker-1",
          "thread:worker-2",
        ]);
        expect(goal.status).toMatchObject({ phase: "progressing", observedGeneration: 1 });
        expect(
          (yield* store.events(goal.id, 20)).filter((event) => event.reason === "WorkerLaunched"),
        ).toHaveLength(2);
      }).pipe(Effect.provide(layerFor(fake)));
    },
  );

  it.effect(
    "after a crash mid-launch, adopts the started thread instead of launching again, across a restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = (yield* fs.makeTempDirectoryScoped()) + "/state.sqlite";
        const fake = makeFake();
        fake.crashAfterStart = true;
        yield* Effect.gen(function* () {
          yield* insert(testGoal("goal_crash"));
          yield* (yield* GoalController).runDue.pipe(Effect.exit);
        }).pipe(Effect.provide(layerFor(fake, { path })));
        const recovered = yield* Effect.gen(function* () {
          yield* (yield* GoalController).runDue;
          return yield* record("goal_crash");
        }).pipe(Effect.provide(layerFor(fake, { path })));
        expect(fake.launches).toHaveLength(1);
        expect(recovered.workers[0]).toMatchObject({
          threadId: "thread:worker-1",
          state: "running",
          attempt: 1,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a thread whose launch reported an error after creating it", () => {
    const fake = makeFake();
    fake.failAfterStart = true;
    return Effect.gen(function* () {
      yield* insert(testGoal("goal_late"));
      yield* (yield* GoalController).runDue;
      expect(fake.launches).toHaveLength(1);
      expect((yield* record("goal_late")).workers[0]).toMatchObject({
        threadId: "thread:worker-1",
        state: "running",
      });
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect("refuses SSH hosts with the default placement and reports why", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      yield* insert(
        testGoal("goal_remote", {
          spec: testSpec({
            workers: { ...testSpec().workers, hostSelector: { hosts: ["mac-studio"] } },
          }),
        }),
      );
      yield* (yield* GoalController).runDue;
      const { goal } = yield* record("goal_remote");
      expect(fake.launches).toEqual([]);
      expect(goal.status.phase).toBe("blocked");
      expect(
        goal.status.conditions.find((condition) => condition.type === "Blocked"),
      ).toMatchObject({
        status: "True",
        reason: "PlacementRefused",
        message: "mac-studio: placement_unavailable",
      });
      expect(goal.status.failures).toBe(1);
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect("sends one follow-up per finished run that did not report", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const controller = yield* GoalController;
      yield* insert(testGoal("goal_follow"));
      yield* controller.runDue;
      fake.reading = {
        kind: "seen",
        terminal: true,
        runId: RunId.make("run:9"),
        runStatus: "completed",
        lastActivityAt: null,
        result: { reported: false, pullRequest: null },
      };
      yield* controller.reconcile(yield* record("goal_follow"), 10);
      yield* controller.reconcile(yield* record("goal_follow"), 10);
      expect(fake.followUps).toEqual([
        {
          actionId: "goal:goal_follow:s0:a1:run:9:followup",
          message:
            "Report your result with goat_thread_report_result: outcome, summary, and any pull request.",
        },
      ]);
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect("stops acting when the owner loses authority and when the turn budget is spent", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const controller = yield* GoalController;
      fake.owner = { unavailable: "The owner thread was deleted." };
      yield* insert(testGoal("goal_orphan"));
      yield* controller.runDue;
      expect(fake.launches).toEqual([]);
      expect((yield* record("goal_orphan")).goal.status.phase).toBe("blocked");
      fake.owner = access;
      yield* insert(
        testGoal("goal_budget", {
          spec: testSpec({
            limits: { ...testSpec().limits, maxTurns: 1 },
            workers: { ...testSpec().workers, count: 2 },
          }),
        }),
      );
      yield* controller.reconcile(yield* record("goal_budget"), 10);
      expect(fake.launches.map((launch) => launch.actionId)).toEqual([
        "goal:goal_budget:s0:a1:launch",
      ]);
      const { goal } = yield* record("goal_budget");
      expect(
        goal.status.conditions.find((condition) => condition.type === "Blocked"),
      ).toMatchObject({ reason: "BudgetExhausted" });
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect("drops a status computed for an older spec", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const store = yield* GoalStore;
      yield* insert(testGoal("goal_race"));
      const stale = yield* record("goal_race");
      const { goal } = stale;
      yield* store.updateSpec({ ...goal, title: "Renamed", generation: 2 }, 1);
      yield* (yield* GoalController).reconcile(stale, 10);
      const now = yield* record("goal_race");
      expect(now.goal).toMatchObject({ generation: 2, title: "Renamed" });
      expect(now.goal.status.observedGeneration).toBe(0);
      // The claim still refused the stale launch.
      expect(fake.launches).toEqual([]);
    }).pipe(Effect.provide(layerFor(fake)));
  });
});
