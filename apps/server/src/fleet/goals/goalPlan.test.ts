import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@goat/contracts";

import {
  type GoalObservation,
  LAUNCH_GRACE_MS,
  MAX_ACTIONS_PER_GOAL,
  newWorker,
  planGoal,
  type SlotObservation,
} from "./goalPlan.ts";
import type { WorkerRecord } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";

const NOW = Date.parse("2026-10-20T01:00:00.000Z");

const observe = (overrides: Partial<GoalObservation> = {}): GoalObservation => ({
  now: NOW,
  owner: { available: true },
  workers: new Map(),
  launchClaims: new Map(),
  pullRequests: new Map(),
  issues: new Map(),
  turns: 0,
  ...overrides,
});

const running = (
  goal: ReturnType<typeof testGoal>,
  slot: number,
  extra: Partial<WorkerRecord> = {},
): WorkerRecord => ({
  ...newWorker(goal, slot, null),
  threadId: ThreadId.make("thread:w" + slot),
  branch: "goal/test/s" + slot + "-a1",
  state: "running",
  ...extra,
});

const seen = (
  overrides: Partial<Extract<SlotObservation, { kind: "seen" }>> = {},
): SlotObservation => ({
  kind: "seen",
  health: { _tag: "healthy" },
  terminal: true,
  runId: RunId.make("run:1"),
  runStatus: "completed",
  lastActivityAt: "2026-10-20T00:59:00.000Z",
  result: { reported: false, pullRequest: null },
  ...overrides,
});

describe("planGoal", () => {
  it("launches each missing slot once per pass, capped per goal, under the design's ids", () => {
    const goal = testGoal("goal_a", {
      spec: testSpec({
        workers: { ...testSpec().workers, count: 5 },
        limits: { ...testSpec().limits, maxWorkers: 5 },
      }),
    });
    const plan = planGoal(goal, [], observe());
    expect(plan.actions).toHaveLength(MAX_ACTIONS_PER_GOAL);
    expect(plan.actions[0]).toEqual({
      type: "launch",
      slot: 0,
      attempt: 1,
      actionId: "goal:goal_a:s0:a1:launch",
    });
    expect(plan.truncated).toBe(true);
    expect(planGoal(goal, [], observe()).actions).toEqual(plan.actions);
  });

  it("never resends a claimed launch: it looks it up, then moves to the next attempt after the grace", () => {
    const goal = testGoal("goal_b");
    const worker = newWorker(goal, 0, null);
    const fresh = planGoal(
      goal,
      [worker],
      observe({
        launchClaims: new Map([
          [worker.launchClientRequestId, { claimedAt: NOW - 1000, settled: false }],
        ]),
      }),
    );
    expect(fresh.actions).toEqual([
      {
        type: "resolve_launch",
        slot: 0,
        attempt: 1,
        actionId: "goal:goal_b:s0:a1:launch",
        expired: false,
      },
    ]);
    expect(fresh.workers[0]!.state).toBe("launch_unknown");
    const late = planGoal(
      goal,
      [worker],
      observe({
        launchClaims: new Map([
          [worker.launchClientRequestId, { claimedAt: NOW - LAUNCH_GRACE_MS - 1, settled: false }],
        ]),
      }),
    );
    expect(late.actions[0]).toMatchObject({ type: "resolve_launch", expired: true });
  });

  it("follows up once per run when CI fails on the worker's PR, using only numbers in the text", () => {
    const goal = testGoal("goal_c", { spec: testSpec({ doneWhen: [{ type: "checks_green" }] }) });
    const worker = running(goal, 0);
    const observation = observe({
      workers: new Map([[0, seen({ result: { reported: true, pullRequest: 41 } })]]),
      pullRequests: new Map([[41, { kind: "seen", state: "open", checks: "failing" }]]),
    });
    const plan = planGoal(goal, [worker], observation);
    expect(plan.actions).toEqual([
      {
        type: "followup",
        slot: 0,
        attempt: 1,
        runId: RunId.make("run:1"),
        actionId: "goal:goal_c:s0:a1:run:1:followup",
        message:
          "CI failed on PR #41. Read the failing checks on the pull request, fix them, push, and report again.",
      },
    ]);
    const nudged = { ...plan.workers[0]!, followUps: 1, followedUpRunId: RunId.make("run:1") };
    expect(planGoal(goal, [nudged], observation).actions).toEqual([]);
  });

  it("recovers a failed run, waits on people, and leaves a run a person stopped alone", () => {
    const goal = testGoal("goal_d", {
      spec: testSpec({ workers: { ...testSpec().workers, count: 3 } }),
    });
    const plan = planGoal(
      goal,
      [running(goal, 0), running(goal, 1), running(goal, 2)],
      observe({
        workers: new Map([
          [
            0,
            seen({
              runStatus: "failed",
              health: { _tag: "failed", failureClass: "usage_limit", runId: RunId.make("run:1") },
            }),
          ],
          [1, seen({ terminal: false, runStatus: "running", health: { _tag: "waiting" } })],
          [2, seen({ runStatus: "interrupted" })],
        ]),
      }),
    );
    expect(plan.actions).toEqual([
      {
        type: "recover",
        slot: 0,
        attempt: 1,
        runId: RunId.make("run:1"),
        reason: "failed",
        failureClass: "usage_limit",
      },
    ]);
    expect(plan.workers.map((worker) => worker.state)).toEqual([
      "running",
      "needs_human",
      "needs_human",
    ]);
  });

  it("steers a stall once, then asks for a reschedule", () => {
    const goal = testGoal("goal_e");
    const stalled = seen({
      terminal: false,
      runStatus: "running",
      health: { _tag: "stalled", idleMs: 1_500_000 },
    });
    const first = planGoal(goal, [running(goal, 0)], observe({ workers: new Map([[0, stalled]]) }));
    expect(first.actions[0]).toMatchObject({ type: "followup" });
    const steered = {
      ...first.workers[0]!,
      steeredRunId: RunId.make("run:1"),
      followedUpRunId: RunId.make("run:1"),
    };
    const second = planGoal(goal, [steered], observe({ workers: new Map([[0, stalled]]) }));
    expect(second.actions).toEqual([
      {
        type: "recover",
        slot: 0,
        attempt: 1,
        runId: RunId.make("run:1"),
        reason: "stalled",
        failureClass: "unknown",
      },
    ]);
  });

  it("succeeds when every doneWhen holds and stops acting", () => {
    const goal = testGoal("goal_f", {
      spec: testSpec({
        doneWhen: [{ type: "pull_requests_merged" }, { type: "thread_reported_result" }],
      }),
    });
    const plan = planGoal(
      goal,
      [running(goal, 0)],
      observe({
        workers: new Map([[0, seen({ result: { reported: true, pullRequest: 7 } })]]),
        pullRequests: new Map([[7, { kind: "seen", state: "merged", checks: "passing" }]]),
      }),
    );
    expect(plan.status.phase).toBe("succeeded");
    expect(plan.status.conditions.find((condition) => condition.type === "Done")).toMatchObject({
      status: "True",
      observedGeneration: 1,
    });
    expect(plan.actions).toEqual([]);
  });

  it("blocks without acting on a spent budget, a paused spec, or lost owner authority", () => {
    const goal = testGoal("goal_g");
    expect(planGoal(goal, [], observe({ turns: 40 })).status).toMatchObject({ phase: "blocked" });
    expect(planGoal(goal, [], observe({ turns: 40 })).actions).toEqual([]);
    const paused = testGoal("goal_g", { spec: testSpec({ paused: true }) });
    expect(planGoal(paused, [], observe())).toMatchObject({
      actions: [],
      status: { phase: "paused" },
    });
    const orphan = planGoal(
      goal,
      [],
      observe({ owner: { available: false, reason: "The owner thread was deleted." } }),
    );
    expect(orphan).toMatchObject({ actions: [], status: { phase: "blocked" } });
    expect(orphan.status.conditions.find((c) => c.type === "Blocked")).toMatchObject({
      status: "True",
      reason: "OwnerAuthorityLost",
    });
  });

  it("interrupts slots the spec dropped and, when deleting, every live slot before removing the row", () => {
    const goal = testGoal("goal_h", {
      spec: testSpec({ workers: { ...testSpec().workers, count: 1 } }),
    });
    const live = seen({ terminal: false, runStatus: "running" });
    const shrink = planGoal(
      goal,
      [running(goal, 0), running(goal, 1)],
      observe({
        workers: new Map([
          [0, live],
          [1, live],
        ]),
      }),
    );
    expect(shrink.actions).toEqual([
      { type: "interrupt", slot: 1, attempt: 1, actionId: "goal:goal_h:s1:a1:interrupt" },
    ]);
    expect(shrink.workers[1]!.state).toBe("superseded");
    const deleting = testGoal("goal_h", { deletionRequestedAt: "2026-10-20T00:30:00.000Z" });
    expect(
      planGoal(deleting, [running(deleting, 0)], observe({ workers: new Map([[0, live]]) }))
        .actions,
    ).toEqual([
      { type: "interrupt", slot: 0, attempt: 1, actionId: "goal:goal_h:s0:a1:interrupt" },
    ]);
    expect(
      planGoal(deleting, [running(deleting, 0)], observe({ workers: new Map([[0, seen()]]) }))
        .actions,
    ).toEqual([{ type: "delete_row" }]);
  });
});
