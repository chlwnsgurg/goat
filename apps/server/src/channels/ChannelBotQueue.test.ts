import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionInput, ChannelReceptionReadResult } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { WORKERS_PER_REQUESTER } from "./ChannelDispatcher.ts";
import {
  defaultScript,
  goatInput,
  makeHarness,
  ownerId,
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
      // The stop was told to the person, so the items are closed, and nothing is pending.
      yield* gateway.ingest(goatInput("pending? after stop", "s4"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(pending(reads), "Nothing is pending.");
    }).pipe(Effect.provide(harness.layer));
  });
});
