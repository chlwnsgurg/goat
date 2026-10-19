import { describe, expect, it } from "@effect/vitest";

import {
  backoffDelayMs,
  BACKOFF_MAX_MS,
  decide,
  resumeBranchFor,
  type RescheduleContext,
  type RescheduleReason,
} from "./reschedulePolicy.ts";
import { detectStall, failureClassOf } from "./threadStallModel.ts";

const base: RescheduleContext = {
  now: 1_000_000,
  hostAnswers: true,
  hostEvictable: false,
  threadTerminal: false,
  attempts: 0,
  budget: 3,
  steersThisEpisode: 0,
  restartsThisEpisode: 0,
  nextAttemptAt: null,
};

const transport: RescheduleReason = { type: "retryable_failure", failureClass: "transport_error" };

describe("reschedule decision table", () => {
  it.each<[string, RescheduleReason, Partial<RescheduleContext>, string]>([
    [
      "stalled with an answering host is nudged first",
      { type: "no_progress", idleMs: 1 },
      {},
      "steer",
    ],
    [
      "then restarted where it runs",
      { type: "no_progress", idleMs: 1 },
      { steersThisEpisode: 1 },
      "restart",
    ],
    [
      "and never moved while its host answers",
      { type: "no_progress", idleMs: 1 },
      { steersThisEpisode: 1, restartsThisEpisode: 1 },
      "give_up",
    ],
    [
      "a stall on a silent host waits for the host verdict",
      { type: "no_progress", idleMs: 1 },
      { hostAnswers: false },
      "wait",
    ],
    [
      "an unanswered request is never answered for its owner",
      { type: "unanswered_request", waitingMs: 1, kind: "approval" },
      {},
      "wait",
    ],
    ["a transport failure is retried once where it ran", transport, {}, "restart"],
    [
      "a second failure moves, because the thread itself failed",
      transport,
      { restartsThisEpisode: 1 },
      "move",
    ],
    ["a failure on a silent host waits for eviction", transport, { hostAnswers: false }, "wait"],
    [
      "a failure on an evictable host moves",
      transport,
      { hostAnswers: false, hostEvictable: true },
      "move",
    ],
    [
      "an unreachable host inside the eviction bound waits",
      { type: "host_unreachable" },
      { hostAnswers: false },
      "wait",
    ],
    [
      "an unreachable host past the bound moves its work",
      { type: "host_unreachable" },
      { hostAnswers: false, hostEvictable: true },
      "move",
    ],
    [
      "a host that answers again keeps its work",
      { type: "host_unreachable" },
      { hostEvictable: true },
      "wait",
    ],
    ["drain waits for the current turn", { type: "host_draining", force: false }, {}, "wait"],
    [
      "drain moves a finished turn",
      { type: "host_draining", force: false },
      { threadTerminal: true },
      "move",
    ],
    ["forced drain moves now", { type: "host_draining", force: true }, {}, "move"],
    [
      "a manual move ignores backoff",
      { type: "manual", targetHost: "macmini" },
      { nextAttemptAt: 2_000_000 },
      "move",
    ],
    [
      "backoff holds automatic moves",
      { type: "host_unreachable" },
      { hostAnswers: false, hostEvictable: true, nextAttemptAt: 2_000_000 },
      "wait",
    ],
    [
      "a spent budget gives up instead of moving",
      { type: "host_unreachable" },
      { hostAnswers: false, hostEvictable: true, attempts: 3 },
      "give_up",
    ],
    [
      "a spent budget refuses even a manual move",
      { type: "manual", targetHost: null },
      { attempts: 3 },
      "give_up",
    ],
  ])("%s", (_name, reason, context, action) => {
    expect(decide(reason, { ...base, ...context }).action).toBe(action);
  });

  it("backs off with full jitter under a growing, capped ceiling", () => {
    expect(backoffDelayMs(0, 0)).toBe(0);
    expect(backoffDelayMs(0, 0.999)).toBeLessThan(60_000);
    expect(backoffDelayMs(3, 0.999)).toBeLessThan(8 * 60_000);
    expect(backoffDelayMs(3, 0.999)).toBeGreaterThan(7 * 60_000);
    expect(backoffDelayMs(20, 0.999)).toBeLessThan(BACKOFF_MAX_MS);
  });

  it("names every generation from the original branch", () => {
    expect(resumeBranchFor("feat/x", 1)).toBe("feat/x-r1");
    expect(resumeBranchFor("feat/x", 2)).toBe("feat/x-r2");
  });
});

describe("stall detection", () => {
  const now = Date.parse("2026-10-20T01:00:00.000Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const status = (overrides: Partial<Parameters<typeof detectStall>[0]>) =>
    ({
      phase: "running" as const,
      run: {
        runId: "run:1",
        status: "running" as const,
        requestedAt: at(60),
        startedAt: at(60),
        completedAt: null,
      },
      pendingRequest: null,
      lastActivityAt: at(1),
      lastMessage: null,
      lastError: null,
      ...overrides,
    }) as Parameters<typeof detectStall>[0];

  it("flags a running thread only after twenty quiet minutes", () => {
    expect(detectStall(status({ lastActivityAt: at(19) }), now)).toBeNull();
    expect(
      detectStall(
        status({
          lastActivityAt: at(21),
          run: {
            runId: "run:1" as never,
            status: "running",
            requestedAt: at(30),
            startedAt: at(30),
            completedAt: null,
          },
        }),
        now,
      ),
    ).toMatchObject({ type: "no_progress" });
  });

  it("treats an hour-old question as unanswered and a queued run as not stalled", () => {
    expect(
      detectStall(
        status({
          phase: "waiting_input",
          pendingRequest: { requestId: null, kind: "user_input", since: at(61) },
        }),
        now,
      ),
    ).toMatchObject({ type: "unanswered_request", kind: "user_input" });
    expect(detectStall(status({ phase: "queued", lastActivityAt: at(600) }), now)).toBeNull();
  });

  it("retries transport and provider failures but leaves usage limits to limit recovery", () => {
    expect(
      detectStall(status({ phase: "failed", lastErrorClass: "transport_error" }), now),
    ).toMatchObject({ failureClass: "transport_error" });
    expect(
      detectStall(
        status({ phase: "failed", lastErrorClass: "usage_limit", lastError: "socket hang up" }),
        now,
      ),
    ).toBeNull();
    expect(
      detectStall(status({ phase: "failed", lastErrorClass: "validation_error" }), now),
    ).toBeNull();
    // An older host sends only the text.
    expect(failureClassOf({ lastError: "read ECONNRESET" })).toBe("transport_error");
    expect(failureClassOf({ lastError: "529 overloaded_error" })).toBe("provider_error");
    expect(failureClassOf({ lastError: "You've hit your usage limit" })).toBeNull();
  });
});
