import { describe, expect, it } from "vite-plus/test";

import { resolveActiveDestination } from "./destinationRail.logic";

const notBot = { isBotRoute: false } as const;

describe("resolveActiveDestination", () => {
  it.each([
    ["/", "home"],
    ["/env-1/thread-1", "home"],
    ["/draft/draft-1", "home"],
    ["/new", "home"],
    ["/decisions", "decisions"],
    ["/usage", "usage"],
    ["/pull-requests", "pullRequests"],
    ["/settings/memory", "memory"],
    ["/settings/scheduled-tasks", "scheduled"],
    ["/settings", "settings"],
    ["/settings/appearance", "settings"],
    ["/settings/memory-import", "settings"],
    ["/projects/goat", "settings"],
  ] as const)("maps %s to %s", (pathname, expected) => {
    expect(resolveActiveDestination(pathname, notBot)).toBe(expected);
  });

  it("keeps Bot selected after /bot redirects to the bot thread", () => {
    expect(resolveActiveDestination("/bot", { isBotRoute: true })).toBe("bot");
    expect(resolveActiveDestination("/env-1/bot-thread", { isBotRoute: true })).toBe("bot");
  });
});
