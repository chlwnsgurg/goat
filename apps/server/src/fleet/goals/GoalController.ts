/**
 * Drives fleet goals toward their spec (docs/internals/agentic-k8s.md, "Controller"). One
 * Scheduler source, level-triggered: each tick reconciles due goals, at most 20 goals and 10
 * actions per tick and 3 per goal. Every action is claimed in the store before it runs; a launch
 * that never confirmed is looked up by its title marker and never resent under the same attempt.
 * Placement, health, rescheduling and fallback come from the fleet service tags.
 */
import { type FleetGoal, type FleetGoalEvent, FleetOwnerKey } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { Health } from "../health/Health.ts";
import { Rescheduler } from "../health/Rescheduler.ts";
import { Fallback } from "../resources/Fallback.ts";
import { Placement } from "../resources/Placement.ts";
import {
  type ActionIssue,
  applyIssues,
  branchFor,
  desiredSlots,
  fallbackActionId,
  type GoalAction,
  type GoalObservation,
  launchActionId,
  MAX_ACTIONS_PER_TICK,
  MAX_GOALS_PER_TICK,
  nextAttempt,
  nextDelayMs,
  planGoal,
  type PullRequestObservation,
  type SlotObservation,
  targetKey,
} from "./goalPlan.ts";
import { type GoalRecord, GoalStore, publicWorker, type WorkerRecord } from "./GoalStore.ts";
import { GoalWorkerRuntime, workerTitle } from "./GoalWorkerRuntime.ts";

const SOON_MS = 5_000;
const PULL_REQUESTS_PER_PASS = 60;

const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export class GoalController extends Context.Service<
  GoalController,
  {
    /** One tick: reconciles due goals within the tick's action budget, when enabled. */
    readonly runDue: Effect.Effect<void>;
    /** One pass over one goal, due or not; returns how many actions it took. */
    readonly reconcile: (record: GoalRecord, budget: number) => Effect.Effect<number>;
  }
>()("goat/fleet/goals/GoalController") {}

export const renderPrompt = (goal: FleetGoal, worker: WorkerRecord, branch: string) => {
  const target = goal.spec.workers.perTarget ? goal.spec.targets[worker.slot] : undefined;
  const targetText =
    target === undefined
      ? goal.spec.targets.map(targetKey).join(", ")
      : target.type === "prompt"
        ? target.text
        : target.type === "issue"
          ? "issue #" + target.number
          : target.type === "pull_request"
            ? "pull request #" + target.number
            : "branch " + target.name;
  const body = goal.spec.workers.promptTemplate
    .replaceAll("{{target}}", targetText)
    .replaceAll("{{branch}}", branch)
    .replaceAll("{{attempt}}", String(worker.attempt))
    .replaceAll(
      "{{previousAttempt}}",
      worker.attempt > 1 ? branchFor(goal, worker.slot, worker.attempt - 1) : "",
    );
  return (
    body +
    "\n\nYou are slot " +
    worker.slot +
    " (attempt " +
    worker.attempt +
    ") of GOAT goal " +
    goal.id +
    ". When you finish, report with goat_thread_report_result, including any pull request you opened."
  );
};

export const make = Effect.gen(function* () {
  const store = yield* GoalStore;
  const runtime = yield* GoalWorkerRuntime;
  const placement = yield* Placement;
  const health = yield* Health;
  const rescheduler = yield* Rescheduler;
  const fallback = yield* Fallback;
  const settings = yield* ServerSettings.ServerSettingsService;

  const observe = (record: GoalRecord, now: number) =>
    Effect.gen(function* () {
      const { goal } = record;
      const access = yield* runtime.owner(goal);
      const owner = "unavailable" in access ? null : access;
      const workers = new Map<number, SlotObservation>();
      const reported = new Set<number>();
      if (owner !== null)
        yield* Effect.forEach(
          record.workers.filter((worker) => worker.threadId !== null && worker.state !== "failed"),
          (worker) =>
            Effect.gen(function* () {
              const reading = yield* runtime.observeWorker(owner, goal, worker);
              if (reading.kind !== "seen") return workers.set(worker.slot, reading);
              if (reading.result?.pullRequest != null) reported.add(reading.result.pullRequest);
              const threadHealth = yield* health.threadHealth({
                host: worker.host,
                threadId: worker.threadId!,
                watchId: worker.watchId,
              });
              return workers.set(worker.slot, { ...reading, health: threadHealth });
            }),
          { concurrency: 4, discard: true },
        );
      const launchClaims = new Map<string, { claimedAt: number; settled: boolean } | null>();
      // Slots without a record still get their first launch looked up: a pass that died after
      // claiming it never wrote the slot.
      const stored = new Map(record.workers.map((worker) => [worker.slot, worker]));
      const pending = desiredSlots(goal).flatMap(({ slot }) => {
        const worker = stored.get(slot);
        return worker === undefined
          ? [launchActionId(goal, slot, 1)]
          : worker.threadId === null && worker.state !== "failed"
            ? [worker.launchClientRequestId]
            : [];
      });
      for (const actionId of pending) {
        const claim = yield* store.claimOf(actionId).pipe(Effect.orElseSucceed(() => null));
        launchClaims.set(
          actionId,
          claim === null
            ? null
            : { claimedAt: Date.parse(claim.claimedAt), settled: claim.settledAt !== null },
        );
      }
      const wanted = new Set<number>([
        ...goal.spec.targets.flatMap((target) =>
          target.type === "pull_request" ? [target.number] : [],
        ),
        ...record.workers.flatMap((worker) =>
          worker.pullRequest === null ? [] : [worker.pullRequest.number],
        ),
        ...reported,
      ]);
      const pullRequests = new Map<number, PullRequestObservation>();
      yield* Effect.forEach(
        [...wanted].slice(0, PULL_REQUESTS_PER_PASS),
        (number) =>
          runtime
            .observePullRequest(goal, number)
            .pipe(Effect.map((seen) => pullRequests.set(number, seen))),
        { concurrency: 4, discard: true },
      );
      const issues = new Map<number, "open" | "closed" | "unknown">();
      if (goal.spec.doneWhen.some((entry) => entry.type === "issues_closed"))
        yield* Effect.forEach(
          goal.spec.targets.flatMap((target) => (target.type === "issue" ? [target.number] : [])),
          (number) =>
            runtime
              .observeIssue(goal, number)
              .pipe(Effect.map((state) => issues.set(number, state))),
          { concurrency: 4, discard: true },
        );
      const observation: GoalObservation = {
        now,
        owner:
          owner === null
            ? { available: false, reason: (access as { unavailable: string }).unavailable }
            : { available: true },
        workers,
        launchClaims,
        pullRequests,
        issues,
        turns: yield* store.turns(goal.id),
      };
      return observation;
    });

  const reconcile = (record: GoalRecord, budget: number) =>
    Effect.gen(function* () {
      const { goal } = record;
      const now = yield* Clock.currentTimeMillis;
      const nowIso = isoAt(now);
      const plan = planGoal(goal, record.workers, yield* observe(record, now));
      const workers = new Map(plan.workers.map((worker) => [worker.slot, worker]));
      const events: Array<FleetGoalEvent> = [...plan.events];
      const issues: Array<ActionIssue> = [];
      let failed =
        plan.status.phase === "degraded" &&
        plan.status.conditions.some(
          (c) => c.type === "Degraded" && c.reason === "ObservationFailed",
        );
      let startedAt = goal.status.usage.startedAt;
      let used = 0;
      const owner = FleetOwnerKey.make("goal:" + goal.id);
      const note = (
        type: FleetGoalEvent["type"],
        reason: string,
        message: string,
        worker: WorkerRecord | null,
        actionId: string | null,
      ) =>
        events.push({
          at: nowIso,
          type,
          reason,
          message,
          slot: worker?.slot ?? null,
          attempt: worker?.attempt ?? null,
          actionId,
        });
      const claim = (
        actionId: string,
        kind: "launch" | "followup" | "fallback" | "interrupt",
        worker: WorkerRecord,
        host: string | null,
      ) =>
        store
          .claim({
            goalId: goal.id,
            generation: goal.generation,
            actionId,
            kind,
            host,
            slot: worker.slot,
            nowIso,
          })
          .pipe(
            Effect.tap((refusal) =>
              refusal === null
                ? Effect.logInfo("fleet.goal.action", { goalId: goal.id, actionId, kind })
                : Effect.sync(() => {
                    if (refusal === "budget")
                      issues.push({
                        condition: "Blocked",
                        reason: "BudgetExhausted",
                        message: "The goal spent its budget.",
                      });
                    if (refusal !== "already_claimed")
                      note(
                        "Normal",
                        "ActionRefused",
                        kind + " not taken: " + refusal + ".",
                        worker,
                        actionId,
                      );
                  }),
            ),
          );

      const perform = (action: GoalAction) =>
        Effect.gen(function* () {
          if (action.type === "delete_row") {
            yield* store.remove(goal.id);
            return "deleted" as const;
          }
          const worker = workers.get(action.slot);
          if (worker === undefined) return;
          const access = yield* runtime.owner(goal);
          if ("unavailable" in access) {
            issues.push({
              condition: "Blocked",
              reason: "OwnerAuthorityLost",
              message: access.unavailable,
            });
            return;
          }
          switch (action.type) {
            case "resolve_launch": {
              const found = yield* runtime.findLaunched(access, goal, action.actionId, worker.host);
              if (found !== null) {
                yield* store.settle(action.actionId, "adopted", nowIso);
                workers.set(worker.slot, {
                  ...worker,
                  host: found.host,
                  threadId: found.threadId,
                  lastRunId: found.runId,
                  state: "running",
                });
                note(
                  "Normal",
                  "WorkerRecovered",
                  "Slot " + worker.slot + " found its unconfirmed launch.",
                  worker,
                  action.actionId,
                );
              } else if (action.expired) {
                yield* store.settle(action.actionId, "unknown", nowIso);
                const next = nextAttempt(goal, worker, "Launch was never confirmed.");
                workers.set(worker.slot, next);
                note(
                  "Warning",
                  "LaunchUnknown",
                  "Slot " +
                    worker.slot +
                    " launch was never confirmed; moving to attempt " +
                    next.attempt +
                    ".",
                  worker,
                  action.actionId,
                );
              }
              return;
            }
            case "launch": {
              const placed = yield* placement.place({
                owner,
                modelSelection: worker.modelSelection,
                fallbackChain: goal.spec.workers.fallbackChain,
                hostSelector: goal.spec.workers.hostSelector,
                project: goal.spec.project,
                avoidHosts: [],
              });
              if (placed._tag === "Refused") {
                failed = true;
                const reasons = placed.reasons
                  .map((entry) => (entry.host ?? "this machine") + ": " + entry.reason)
                  .join("; ");
                issues.push({
                  condition: "Blocked",
                  reason: "PlacementRefused",
                  message: reasons || "No host can take this worker.",
                });
                return;
              }
              if ((yield* claim(action.actionId, "launch", worker, placed.host)) !== null) return;
              startedAt ??= nowIso;
              const branch = branchFor(goal, worker.slot, worker.attempt);
              const launched = yield* runtime
                .launch(access, {
                  goal,
                  slot: worker.slot,
                  actionId: action.actionId,
                  host: placed.host,
                  title: workerTitle(goal.title, worker.slot, action.actionId),
                  message: renderPrompt(goal, worker, branch),
                  branch,
                  modelSelection: placed.modelSelection,
                })
                .pipe(Effect.result);
              if (launched._tag === "Success") {
                yield* store.settle(action.actionId, "launched", nowIso);
                workers.set(worker.slot, {
                  ...worker,
                  host: launched.success.host,
                  threadId: launched.success.threadId,
                  lastRunId: launched.success.runId,
                  branch,
                  modelSelection: placed.modelSelection,
                  state: "running",
                  note: placed.reason ?? null,
                });
                note(
                  "Normal",
                  "WorkerLaunched",
                  "Slot " +
                    worker.slot +
                    " attempt " +
                    worker.attempt +
                    " started on " +
                    (launched.success.host ?? "this machine") +
                    ".",
                  worker,
                  action.actionId,
                );
                return;
              }
              // The thread may exist even though the call failed after creating it.
              const created = yield* runtime.findLaunched(
                access,
                goal,
                action.actionId,
                placed.host,
              );
              if (created !== null) {
                yield* store.settle(action.actionId, "adopted", nowIso);
                workers.set(worker.slot, {
                  ...worker,
                  host: created.host,
                  threadId: created.threadId,
                  branch,
                  state: "running",
                });
                note(
                  "Normal",
                  "WorkerRecovered",
                  "Slot " + worker.slot + " launch reported an error, but its thread exists.",
                  worker,
                  action.actionId,
                );
                return;
              }
              failed = true;
              yield* store.settle(action.actionId, "failed", nowIso);
              workers.set(worker.slot, nextAttempt(goal, worker, launched.failure.message));
              note(
                "Warning",
                "LaunchFailed",
                "Slot " + worker.slot + ": " + launched.failure.message,
                worker,
                action.actionId,
              );
              return;
            }
            case "followup": {
              if ((yield* claim(action.actionId, "followup", worker, worker.host)) !== null) return;
              const sent = yield* runtime
                .followUp(access, worker, action.message, action.actionId)
                .pipe(Effect.result);
              yield* store.settle(
                action.actionId,
                sent._tag === "Success" ? "sent" : "failed",
                nowIso,
              );
              if (sent._tag === "Failure") {
                failed = true;
                note(
                  "Warning",
                  "FollowUpFailed",
                  "Slot " + worker.slot + ": " + sent.failure.message,
                  worker,
                  action.actionId,
                );
                return;
              }
              workers.set(worker.slot, {
                ...worker,
                followUps: worker.followUps + 1,
                followedUpRunId: action.runId,
                steeredRunId: worker.state === "stalled" ? action.runId : worker.steeredRunId,
              });
              note(
                "Normal",
                "FollowUpSent",
                "Slot " + worker.slot + ": " + action.message,
                worker,
                action.actionId,
              );
              return;
            }
            case "recover": {
              const handled = {
                ...worker,
                followedUpRunId: action.runId ?? worker.followedUpRunId,
              };
              const step = yield* fallback.next({
                chain: goal.spec.workers.fallbackChain,
                selection: worker.modelSelection,
                failure: action.failureClass,
                tried: worker.tried,
                host: worker.host,
                threadId: worker.threadId,
              });
              if (step._tag === "SwitchInThread" && action.runId !== null) {
                const id = fallbackActionId(
                  goal,
                  worker.slot,
                  worker.attempt,
                  action.runId,
                  step.hop,
                );
                if ((yield* claim(id, "fallback", worker, worker.host)) !== null) return;
                const sent = yield* runtime
                  .followUp(access, worker, "Continue where you left off.", id, step.selection)
                  .pipe(Effect.result);
                yield* store.settle(id, sent._tag === "Success" ? "switched" : "failed", nowIso);
                if (sent._tag === "Success") {
                  workers.set(worker.slot, {
                    ...handled,
                    modelSelection: step.selection,
                    tried: [...worker.tried, worker.modelSelection],
                  });
                  note(
                    "Normal",
                    "FallbackSwitched",
                    "Slot " + worker.slot + " switched to " + step.selection.model + ".",
                    worker,
                    id,
                  );
                } else failed = true;
                return;
              }
              if (
                step._tag === "Exhausted" &&
                action.reason === "failed" &&
                action.failureClass === "usage_limit"
              ) {
                workers.set(worker.slot, { ...handled, note: "Waits for the usage-limit reset." });
                return;
              }
              if (
                worker.attempt >= goal.spec.limits.maxAttemptsPerWorker ||
                worker.threadId === null
              ) {
                workers.set(worker.slot, {
                  ...handled,
                  state: "failed",
                  note: "No attempts left after " + action.reason + ".",
                });
                return;
              }
              const nextId = launchActionId(goal, worker.slot, worker.attempt + 1);
              const selection = step._tag === "Relaunch" ? step.selection : worker.modelSelection;
              // One reschedule per run: the claim names the run; the next attempt's launch id is the
              // receiver's dedupe key.
              const rescheduleId =
                "goal:" +
                goal.id +
                ":s" +
                worker.slot +
                ":a" +
                worker.attempt +
                ":" +
                (action.runId ?? action.reason) +
                ":reschedule";
              if ((yield* claim(rescheduleId, "launch", worker, worker.host)) !== null) return;
              const branch = branchFor(goal, worker.slot, worker.attempt + 1);
              const moved = yield* rescheduler.reschedule({
                ref: { host: worker.host, threadId: worker.threadId, watchId: worker.watchId },
                owner,
                attempt: worker.attempt,
                reason: step._tag === "Relaunch" ? "fallback_relaunch" : action.reason,
                modelSelection: selection,
                workspace: {
                  baseRef: goal.spec.workers.workspace.baseRef,
                  branch,
                  startFromOrigin: goal.spec.workers.workspace.startFromOrigin,
                },
                previousBranch: worker.branch,
                replica: null,
                prompt: renderPrompt(goal, { ...worker, attempt: worker.attempt + 1 }, branch),
                runtimeMode: access.runtimeMode,
                clientRequestId: nextId,
              });
              if (moved._tag === "Rescheduled") {
                yield* store.settle(rescheduleId, "rescheduled", nowIso);
                workers.set(worker.slot, {
                  ...nextAttempt(goal, worker, "Rescheduled after " + action.reason + "."),
                  host: moved.host,
                  threadId: moved.threadId,
                  branch: moved.branch,
                  modelSelection: selection,
                  state: "running",
                });
                note(
                  "Normal",
                  "Rescheduled",
                  "Slot " +
                    worker.slot +
                    " moved to attempt " +
                    (worker.attempt + 1) +
                    " on " +
                    (moved.host ?? "this machine") +
                    ".",
                  worker,
                  rescheduleId,
                );
                return;
              }
              yield* store.settle(rescheduleId, "refused", nowIso);
              workers.set(worker.slot, { ...handled, note: moved.message });
              issues.push({
                condition: "Degraded",
                reason: "RescheduleRefused",
                message: "Slot " + worker.slot + ": " + moved.message,
              });
              note(
                "Warning",
                "RescheduleRefused",
                "Slot " + worker.slot + " (" + action.reason + "): " + moved.message,
                worker,
                rescheduleId,
              );
              return;
            }
            case "interrupt": {
              if ((yield* claim(action.actionId, "interrupt", worker, worker.host)) !== null)
                return;
              const stopped = yield* runtime
                .interrupt(access, worker, action.actionId)
                .pipe(Effect.result);
              yield* store.settle(
                action.actionId,
                stopped._tag === "Success" ? "interrupted" : "failed",
                nowIso,
              );
              if (stopped._tag === "Failure") failed = true;
              note(
                stopped._tag === "Success" ? "Normal" : "Warning",
                stopped._tag === "Success" ? "WorkerInterrupted" : "InterruptFailed",
                "Slot " +
                  worker.slot +
                  (stopped._tag === "Success" ? " interrupted." : ": " + stopped.failure.message),
                worker,
                action.actionId,
              );
              return;
            }
          }
        });

      for (const action of plan.actions.slice(0, budget)) {
        used += 1;
        if ((yield* perform(action)) === "deleted") return used;
      }

      const failures = failed ? goal.status.failures + 1 : 0;
      const finished = plan.status.phase === "succeeded" || plan.status.phase === "failed";
      const delay = plan.truncated && !failed ? SOON_MS : nextDelayMs(failures);
      const status = applyIssues(
        goal,
        {
          ...plan.status,
          workers: [...workers.values()].map(publicWorker),
          usage: { ...plan.status.usage, startedAt, turns: yield* store.turns(goal.id) },
          failures,
          nextReconcileAt: finished ? null : isoAt(now + delay),
        },
        issues,
        nowIso,
      );
      const written = yield* store.writeStatus({
        id: goal.id,
        generation: goal.generation,
        status,
        workers: [...workers.values()],
        events,
        nowIso,
      });
      if (!written)
        yield* Effect.logDebug("fleet goal spec moved during a pass", { goalId: goal.id });
      return used;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("fleet goal pass failed", { goalId: record.goal.id, error }).pipe(
          Effect.as(0),
        ),
      ),
      Effect.withSpan("GoalController.reconcile", { attributes: { goalId: record.goal.id } }),
    );

  const runDue = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    // The kill switch: off stops every goal action on the next tick and touches no thread.
    if (!current.fleet.controllerEnabled) return;
    const now = yield* Clock.currentTimeMillis;
    let budget = MAX_ACTIONS_PER_TICK;
    for (const record of yield* store.due(isoAt(now), MAX_GOALS_PER_TICK)) {
      if (budget <= 0) break;
      budget -= yield* reconcile(record, budget);
    }
  }).pipe(Effect.catch((error) => Effect.logWarning("fleet goals: tick failed", { error })));

  return GoalController.of({ runDue, reconcile });
});

export const layer = Layer.effect(GoalController, make);

/** Registers the controller as the "fleet-goals" source on the shared Scheduler. */
export const layerRunning = Layer.effectDiscard(
  Effect.gen(function* () {
    const controller = yield* GoalController;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("fleet-goals", controller.runDue);
  }),
);
