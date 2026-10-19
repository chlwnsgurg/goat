import type { FleetRescheduleAction } from "@goat/contracts";

import type { StallReason } from "./threadStallModel.ts";

/**
 * What to do for a self-healing worker, as one table. docs/internals/self-healing.md carries the
 * same table with the reasons behind each row. Pure; the Rescheduler performs the action.
 *
 * Rules every row keeps:
 * - Work never moves while its host still answers, unless the thread itself failed, the host
 *   is being drained, or a full-access caller asked for the move.
 * - Restarts and moves spend one retry budget; steering is free but happens once per episode.
 * - Every action after the first in an episode waits for an exponential backoff with full jitter.
 */
export type RescheduleReason =
  | StallReason
  | { readonly type: "host_unreachable" }
  | { readonly type: "host_draining"; readonly force: boolean }
  | { readonly type: "manual"; readonly targetHost: string | null };

export interface RescheduleContext {
  readonly now: number;
  /** The worker's host answered its last status read. */
  readonly hostAnswers: boolean;
  /** The host has been unreachable long enough to move work off it. */
  readonly hostEvictable: boolean;
  /** The worker's current run has ended. */
  readonly threadTerminal: boolean;
  /** Restarts and moves spent so far. */
  readonly attempts: number;
  readonly budget: number;
  /** Steers and restarts since the worker last made progress. */
  readonly steersThisEpisode: number;
  readonly restartsThisEpisode: number;
  readonly nextAttemptAt: number | null;
}

export interface RescheduleDecision {
  readonly action: FleetRescheduleAction;
  readonly note: string;
}

export const RESCHEDULE_BUDGET = 3;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;

const decision = (action: FleetRescheduleAction, note: string): RescheduleDecision => ({
  action,
  note,
});

export function decide(reason: RescheduleReason, ctx: RescheduleContext): RescheduleDecision {
  // A person asking to move always gets a move, budget and backoff permitting.
  const costly = (action: "restart" | "move", note: string) =>
    ctx.attempts >= ctx.budget
      ? decision("give_up", "Retry budget (" + ctx.budget + ") is spent; " + note)
      : ctx.nextAttemptAt !== null && ctx.now < ctx.nextAttemptAt && reason.type !== "manual"
        ? decision("wait", "Backing off before the next attempt; " + note)
        : decision(action, note);

  switch (reason.type) {
    case "manual":
      return costly("move", "moved by request.");
    case "host_draining":
      return reason.force || ctx.threadTerminal
        ? costly("move", "its host is draining.")
        : decision("wait", "Its host is draining; it moves when the current turn ends.");
    case "host_unreachable":
      if (ctx.hostAnswers) return decision("wait", "The host answers again.");
      return ctx.hostEvictable
        ? costly("move", "its host has been unreachable past the eviction bound.")
        : decision("wait", "Its host is unreachable; waiting out the eviction bound.");
    case "retryable_failure":
      if (!ctx.hostAnswers && !ctx.hostEvictable) {
        return decision("wait", "It failed and its host is not answering yet.");
      }
      // One retry where it ran; a second failure moves it, since the thread itself failed.
      return ctx.hostAnswers && ctx.restartsThisEpisode === 0
        ? costly("restart", "it failed with a " + reason.failureClass + ".")
        : costly("move", "it failed with a " + reason.failureClass + " again.");
    case "no_progress":
      if (!ctx.hostAnswers) return decision("wait", "Its host is not answering.");
      if (ctx.steersThisEpisode === 0)
        return decision("steer", "No activity; asking it what blocks it.");
      if (ctx.restartsThisEpisode === 0) {
        return costly("restart", "still no activity after a nudge.");
      }
      // The host answers and the thread has not failed: moving would not help.
      return decision("give_up", "Still no activity after a nudge and a restart; needs a person.");
    case "unanswered_request":
      // Never answered on anyone's behalf; the launch watch already told the launcher.
      return decision(
        "wait",
        "Waiting on a " + (reason.kind ?? "request") + " that only its owner can answer.",
      );
  }
}

/** Full jitter: uniform in [0, min(max, base * 2^attempt)). random is injected for tests. */
export function backoffDelayMs(attempt: number, random: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(Math.max(0, Math.min(1, random)) * ceiling);
}

/** Deterministic: a restart, a double tick, or a retry all name the same worker. */
export const workerIdFor = (host: string, threadId: string) =>
  "heal:" + encodeURIComponent(host) + ":" + encodeURIComponent(threadId);

/** Every generation branches from the original name, so names never stack. */
export const resumeBranchFor = (rootBranch: string, generation: number) =>
  rootBranch + "-r" + generation;

export const selfHealLaunchNote = (branch: string) =>
  [
    "",
    "Self-healing is on for this thread: at the end of every turn, commit your work and run " +
      "git push origin HEAD:" +
      branch +
      ", so another machine can resume it if this one goes away.",
  ].join("\n");

export const steerText = (idleMs: number) =>
  "You seem stuck: GOAT has seen no activity in this thread for " +
  Math.round(idleMs / 60_000) +
  " minutes. If a command is hanging, stop it. Then either continue the task or say plainly what blocks you.";

export const restartText =
  "GOAT restarted this thread after it stopped making progress or failed. Check git status and git log, then continue the task from where it stopped.";

export const pushRequestText = (branch: string) =>
  "GOAT is moving this work to another machine. Commit all your changes now and run git push origin HEAD:" +
  branch +
  ". Then stop and reply only with the pushed commit sha.";

export const fenceText = (input: {
  readonly host: string;
  readonly threadId: string;
  readonly branch: string;
  readonly generation: number;
}) =>
  "This work moved to " +
  input.host +
  " (thread " +
  input.threadId +
  ", branch " +
  input.branch +
  ", generation " +
  input.generation +
  "). Stop working here and do not push again. Reply only with: stopped.";

export function resumePrompt(input: {
  readonly original: string | null;
  readonly fromBranch: string;
  readonly fromHost: string;
  readonly commit: string | null;
  readonly newBranch: string;
  readonly generation: number;
  readonly reason: string;
}): string {
  return [
    "GOAT moved this work from " + input.fromHost + " (" + input.reason + ").",
    "Resume from branch " +
      input.fromBranch +
      (input.commit === null ? " as last pushed to origin" : " at commit " + input.commit) +
      "; you are on the new branch " +
      input.newBranch +
      " (generation " +
      input.generation +
      ").",
    "Check git log and git status first: work after the last push was lost, so redo it if needed.",
    selfHealLaunchNote(input.newBranch).trim(),
    "",
    "The original task:",
    input.original ?? "(no message was given at launch; continue the work the branch shows)",
  ].join("\n");
}
