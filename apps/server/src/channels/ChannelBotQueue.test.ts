import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionInput, ChannelReceptionReadResult } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import { stopIdsFor, workerLaunchIdsFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { WORKERS_PER_REQUESTER } from "./ChannelDispatcher.ts";
import {
  defaultScript,
  environmentId,
  goatInput,
  makeHarness,
  modelSelection,
  ownerId,
  projectId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

/**
 * "do:" starts work, "also:" joins the running task named in the message, "pending?" reads the
 * queue, "stop" stops everything, and every read's results are kept for the test.
 */
const queueHarness = () => {
  const harness = makeHarness();
  const reads: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
  harness.script.current = (input: ChannelReceptionInput) => {
    const text = input.inputText ?? "";
    if (input.mode === "input" && text.startsWith("pending?")) {
      if (input.readsAllowed === true) {
        return Effect.succeed({
          replyText: "",
          action: { type: "read" as const, reads: [{ kind: "pending" as const, query: "all" }] },
        });
      }
      reads.push(input.readResults ?? []);
      return Effect.succeed({ replyText: "Here it is.", action: { type: "report_only" as const } });
    }
    if (input.mode === "input" && text.startsWith("also:")) {
      const title = text.slice(5).split(":")[0]!.trim();
      const task = input.tasks.find((candidate) => candidate.title === title);
      return Effect.succeed({
        replyText: "Passing that on.",
        action: { type: "follow_up" as const, taskId: task!.taskId },
      });
    }
    if (input.mode === "input" && text === "stop") {
      return Effect.succeed({ replyText: "Stopping.", action: { type: "stop_work" as const } });
    }
    return defaultScript(input);
  };
  return { harness, reads };
};

const pending = (reads: Array<ReadonlyArray<ChannelReceptionReadResult>>) => reads.at(-1)![0]!.text;

describe("GOAT Bot work items and worker runs", () => {
  it.effect("keeps an item open after its run finished until its result was delivered", () => {
    const { harness, reads } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: fix the build", "q1"), rpcContext);
      yield* runtime.drain;
      // Recorded on arrival, dispatched, and its worker run recorded as its own record.
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      yield* reports.reconcile(runtime.ownerToken);
      let runs = yield* ledger.listWorkerRuns([task!.taskId]);
      assert.deepStrictEqual(
        runs.map((run) => run.status),
        ["running"],
      );

      yield* gateway.ingest(goatInput("pending? one", "q2"), rpcContext);
      yield* runtime.drain;
      assert.include(pending(reads), "fix the build [in progress]");
      assert.include(pending(reads), "run 1: running");

      // The run finishes: the run record says so at once, the item stays open until delivery.
      harness.world.setStatus(task!.worker!.threadId, 1, "completed", "The build is green.");
      yield* reports.reconcile(runtime.ownerToken);
      runs = yield* ledger.listWorkerRuns([task!.taskId]);
      assert.strictEqual(runs[0]!.status, "finished");
      assert.isDefined(runs[0]!.endedAt);
      const settled = (yield* ledger.getTask(task!.taskId))!.task;
      assert.strictEqual(settled.status, "completed");
      const before = yield* ledger.outcomeDeliveries([task!.taskId]);
      assert.notStrictEqual(before.get(task!.taskId), "delivered");

      yield* runtime.drain;
      yield* gateway.ingest(goatInput("pending? two", "q3"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(
        (yield* ledger.outcomeDeliveries([task!.taskId])).get(task!.taskId),
        "delivered",
      );
      assert.strictEqual(pending(reads), "Nothing is pending.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("routes a follow-up to its workstream's worker and a new topic to a new one", () => {
    const { harness } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: fix the build", "r1"), rpcContext);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      yield* gateway.ingest(goatInput("also: fix the build: and the lint step", "r2"), rpcContext);
      yield* runtime.drain;
      assert.lengthOf((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks, 1);
      assert.lengthOf(harness.world.launches, 1);
      assert.isTrue(harness.world.sends.some((send) => send.text.includes("lint step")));

      yield* gateway.ingest(goatInput("do: write the release notes", "r3"), rpcContext);
      yield* runtime.drain;
      assert.lengthOf((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks, 2);
      assert.lengthOf(harness.world.launches, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("runs at most four of a person's items at once and starts the next as one ends", () => {
    const { harness, reads } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      for (let index = 0; index <= WORKERS_PER_REQUESTER; index += 1) {
        yield* gateway.ingest(goatInput("do: job " + index, "c" + index), rpcContext);
        yield* runtime.drain;
      }
      assert.lengthOf(harness.world.launches, WORKERS_PER_REQUESTER);
      const tasks = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      const waiting = tasks.find((task) => task.status === "received");
      assert.strictEqual(waiting?.title, "job " + WORKERS_PER_REQUESTER);
      yield* gateway.ingest(goatInput("pending? cap", "c-ask"), rpcContext);
      yield* runtime.drain;
      assert.include(pending(reads), "job 4 [queued]");
      assert.include(pending(reads), "waiting for one of the 4 running");

      // One ends; the queued one starts on the next pass.
      const first = tasks.find((task) => task.title === "job 0")!;
      yield* reports.reconcile(runtime.ownerToken);
      harness.world.setStatus(first.worker!.threadId, 1, "completed", "Done.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.lengthOf(harness.world.launches, WORKERS_PER_REQUESTER + 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stops every open item of the person, its worker and its subagents, once", () => {
    const { harness, reads } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: job a", "s1"), rpcContext);
      yield* gateway.ingest(goatInput("do: job b", "s2"), rpcContext);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      yield* gateway.ingest(goatInput("stop", "s3"), rpcContext);
      yield* runtime.drain;
      yield* runtime.drain;

      const tasks = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      assert.deepStrictEqual(
        tasks.map((task) => task.status),
        ["cancelled", "cancelled"],
      );
      const threads = tasks.map((task) => task.worker!.threadId).toSorted();
      assert.deepStrictEqual(harness.world.interrupts.toSorted(), threads);
      assert.deepStrictEqual(harness.world.subagentStops.toSorted(), threads);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      // The runs record their own end, though the items had already ended.
      yield* reports.reconcile(runtime.ownerToken);
      const runs = yield* ledger.listWorkerRuns(tasks.map((task) => task.taskId));
      assert.deepStrictEqual(
        runs.map((run) => run.status),
        ["stopped", "stopped"],
      );
      // The stop was told to the person, so the items are closed, and nothing is pending.
      yield* gateway.ingest(goatInput("pending? after stop", "s4"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(pending(reads), "Nothing is pending.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stops a worker whose launch was still in flight when the stop came", () => {
    const { harness } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      // Claims the worker ownership the direct calls below write under.
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("do: long job", "l1"), rpcContext);
      const [input] = yield* ledger.listPendingInputs(10);
      yield* reception.receive(input!, runtime.ownerToken);
      // The dispatcher claimed it for a launch that has not landed yet.
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      const stored = (yield* ledger.getTask(task!.taskId))!;
      yield* commitTransition(
        ledger,
        stored,
        {
          type: "task.dispatch.claimed",
          payload: {
            generation: 1,
            target: {
              environmentId,
              projectId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
            },
            leaseExpiresAt: "2026-10-12T00:00:00.000Z",
          },
        },
        { owner: runtime.ownerToken },
      );
      yield* gateway.ingest(goatInput("stop", "l2"), rpcContext);
      const [stopInput] = yield* ledger.listPendingInputs(10);
      yield* reception.receive(stopInput!, runtime.ownerToken);
      const [stop] = yield* ledger.listPendingForwards(10);
      yield* dispatcher.forward(stop!, runtime.ownerToken);
      // No thread yet: the stop waits for it.
      assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
      const threadId = workerLaunchIdsFor(task!.taskId, 1).threadId;
      harness.world.addRun(threadId, workerLaunchIdsFor(task!.taskId, 1).messageId);
      yield* dispatcher.forward(stop!, runtime.ownerToken);
      assert.deepStrictEqual(harness.world.interrupts, [threadId]);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a stop pending while the worker's thread refuses it", () => {
    const { harness } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: job a", "f1"), rpcContext);
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      harness.world.dispatchFailures.add(task!.worker!.threadId);
      yield* gateway.ingest(goatInput("stop", "f2"), rpcContext);
      yield* runtime.drain;
      assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
      assert.lengthOf(harness.world.subagentStops, 0);
      harness.world.dispatchFailures.clear();
      yield* runtime.drain;
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      assert.deepStrictEqual(harness.world.subagentStops, [task!.worker!.threadId]);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("GOAT Bot worker slots", () => {
  it.effect("does not count questions asked before any worker exists", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      for (let index = 0; index < WORKERS_PER_REQUESTER; index += 1) {
        yield* gateway.ingest(goatInput("do: which one " + index, "w" + index), rpcContext);
        yield* runtime.drain;
      }
      const tasks = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      assert.isTrue(tasks.every((task) => task.status === "waiting_input" && !task.worker));
      assert.strictEqual(
        yield* ledger.countBusyTasks({ ownerId, principalId: tasks[0]!.requester.principalId }),
        0,
      );
      assert.lengthOf(harness.world.launches, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tries a refused stop again under a new id while its run still runs", () => {
    const { harness } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: job a", "j1"), rpcContext);
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      yield* gateway.ingest(goatInput("stop", "j2"), rpcContext);
      // The first stop id was refused for good before (a persisted rejection).
      const [input] = yield* ledger.listPendingInputs(10);
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      yield* reception.receive(input!, runtime.ownerToken);
      const [stop] = yield* ledger.listPendingForwards(10);
      harness.world.rejectedCommands.add(stopIdsFor(stop!.event.eventId).interrupt);
      yield* runtime.drain;
      assert.deepStrictEqual(harness.world.interrupts, [task!.worker!.threadId]);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a stopped item's slot until its stop went through", () => {
    const { harness } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      for (let index = 0; index < WORKERS_PER_REQUESTER; index += 1) {
        yield* gateway.ingest(goatInput("do: job " + index, "k" + index), rpcContext);
        yield* runtime.drain;
      }
      const tasks = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      // The workers' threads cannot be reached, so the stops stay pending.
      for (const task of tasks) harness.world.dispatchFailures.add(task.worker!.threadId);
      yield* gateway.ingest(goatInput("stop", "k-stop"), rpcContext);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("do: next job", "k-next"), rpcContext);
      yield* runtime.drain;
      assert.lengthOf(harness.world.launches, WORKERS_PER_REQUESTER);
      harness.world.dispatchFailures.clear();
      yield* runtime.drain;
      yield* runtime.drain;
      assert.lengthOf(harness.world.launches, WORKERS_PER_REQUESTER + 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("records how the runs of stopped work ended", () => {
    const { harness } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: job a", "h1"), rpcContext);
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      yield* gateway.ingest(goatInput("stop", "h2"), rpcContext);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      const runs = yield* ledger.listWorkerRuns([task!.taskId]);
      assert.deepStrictEqual(
        runs.map((run) => run.status),
        ["stopped"],
      );
      assert.deepStrictEqual(harness.world.interrupts, [task!.worker!.threadId]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps finished work open until its outcome reached the person", () => {
    const { harness } = queueHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: job a", "u1"), rpcContext);
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      harness.world.setStatus(task!.worker!.threadId, 1, "completed", "Done.");
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual(
        (yield* ledger.listUndeliveredOutcomes(ownerId)).map((open) => open.taskId),
        [task!.taskId],
      );
      yield* runtime.drain;
      assert.lengthOf(yield* ledger.listUndeliveredOutcomes(ownerId), 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
