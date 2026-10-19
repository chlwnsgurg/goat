import type { DesktopSystemWakeEvent } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  DESKTOP_SLEEP_RECONNECT_AFTER_MS,
  FOCUS_PROBE_MIN_INTERVAL_MS,
  desktopSystemWakeup,
  desktopWakeups,
  type DesktopWakeup,
} from "./desktopWakeups.ts";

function makeDesktopShell() {
  let listener: ((event: DesktopSystemWakeEvent) => void) | null = null;
  let nowMs = 1_000_000;
  const window = new EventTarget();
  return {
    sources: {
      onSystemWake: (next: (event: DesktopSystemWakeEvent) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      window,
      nowMs: () => nowMs,
    },
    isSubscribed: () => listener !== null,
    wake: (event: DesktopSystemWakeEvent) => listener?.(event),
    dispatch: (type: "focus" | "online") => window.dispatchEvent(new Event(type)),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const settle = Effect.gen(function* () {
  for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
});

describe("desktop wakeups", () => {
  it("replaces sessions after a long sleep and only probes after a short one or an unlock", () => {
    expect(
      desktopSystemWakeup({ reason: "resume", asleepMs: DESKTOP_SLEEP_RECONNECT_AFTER_MS }),
    ).toBe("application-active-reconnect");
    expect(desktopSystemWakeup({ reason: "resume", asleepMs: 10 * 60_000 })).toBe(
      "application-active-reconnect",
    );
    // A resume whose suspend the desktop missed still slept for an unknown time.
    expect(desktopSystemWakeup({ reason: "resume", asleepMs: null })).toBe(
      "application-active-reconnect",
    );
    expect(
      desktopSystemWakeup({ reason: "resume", asleepMs: DESKTOP_SLEEP_RECONNECT_AFTER_MS - 1 }),
    ).toBe("application-active-probe");
    expect(desktopSystemWakeup({ reason: "unlock-screen", asleepMs: null })).toBe(
      "application-active-probe",
    );
  });

  it.effect("probes on focus and online, skipping a focus right after another wakeup", () =>
    Effect.gen(function* () {
      const shell = makeDesktopShell();
      const seen: Array<DesktopWakeup> = [];
      const fiber = yield* desktopWakeups(shell.sources).pipe(
        Stream.runForEach((wakeup) => Effect.sync(() => seen.push(wakeup))),
        Effect.forkChild,
      );
      yield* settle;
      expect(shell.isSubscribed()).toBe(true);

      shell.wake({ reason: "resume", asleepMs: 5 * 60_000 });
      // Opening the lid focuses the window; the resume already covers it.
      shell.dispatch("focus");
      shell.dispatch("online");
      yield* settle;
      expect(seen).toEqual(["application-active-reconnect", "application-active-probe"]);

      shell.advance(FOCUS_PROBE_MIN_INTERVAL_MS);
      shell.dispatch("focus");
      shell.dispatch("focus");
      yield* settle;
      expect(seen).toEqual([
        "application-active-reconnect",
        "application-active-probe",
        "application-active-probe",
      ]);

      yield* Fiber.interrupt(fiber);
      expect(shell.isSubscribed()).toBe(false);
      shell.dispatch("online");
      expect(seen).toHaveLength(3);
    }),
  );

  it.effect(
    "deduplicates repeated macOS system wake events while allowing a short probe to upgrade to a reconnect",
    () =>
      Effect.gen(function* () {
        const shell = makeDesktopShell();
        const seen: Array<DesktopWakeup> = [];
        const fiber = yield* desktopWakeups(shell.sources).pipe(
          Stream.runForEach((wakeup) => Effect.sync(() => seen.push(wakeup))),
          Effect.forkChild,
        );
        yield* settle;

        // macOS emits duplicate resume events and unlock-screen within seconds of lid open.
        shell.wake({ reason: "resume", asleepMs: 5 * 60_000 });
        shell.advance(200);
        shell.wake({ reason: "resume", asleepMs: null });
        shell.advance(300);
        shell.wake({ reason: "unlock-screen", asleepMs: null });
        shell.dispatch("focus");
        yield* settle;
        expect(seen).toEqual(["application-active-reconnect"]);

        // After the sleep window, an early unlock probe still upgrades when a long resume arrives.
        shell.advance(DESKTOP_SLEEP_RECONNECT_AFTER_MS);
        shell.wake({ reason: "unlock-screen", asleepMs: null });
        shell.advance(100);
        shell.wake({ reason: "unlock-screen", asleepMs: null });
        shell.advance(100);
        shell.wake({ reason: "resume", asleepMs: DESKTOP_SLEEP_RECONNECT_AFTER_MS });
        shell.advance(100);
        shell.wake({ reason: "resume", asleepMs: DESKTOP_SLEEP_RECONNECT_AFTER_MS });
        yield* settle;
        expect(seen).toEqual([
          "application-active-reconnect",
          "application-active-probe",
          "application-active-reconnect",
        ]);

        yield* Fiber.interrupt(fiber);
      }),
  );
});
