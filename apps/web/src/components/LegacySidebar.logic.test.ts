import { describe, expect, it } from "vite-plus/test";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { ThreadId } from "@t3tools/contracts";
import {
  isProjectsViewPinnedThread,
  resolveProjectConnectionStatus,
  resolveProjectsViewThreadOrder,
} from "./LegacySidebar.logic";

const pinned = {
  pinnedAt: "2026-10-12T00:00:00Z",
  archivedAt: null,
  deletedAt: null,
  lineage: {
    parentThreadId: null,
    rootThreadId: ThreadId.make("root"),
    relationshipToParent: null,
  },
};

describe("Projects view pins", () => {
  it("keeps standalone pins, including forks", () => {
    expect(isProjectsViewPinnedThread(pinned)).toBe(true);
    expect(
      isProjectsViewPinnedThread({
        ...pinned,
        lineage: {
          ...pinned.lineage,
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "fork",
        },
      }),
    ).toBe(true);
  });
  it("excludes unpinned, archived, deleted and child agent threads", () => {
    expect(isProjectsViewPinnedThread({ ...pinned, pinnedAt: null })).toBe(false);
    expect(isProjectsViewPinnedThread({ ...pinned, archivedAt: pinned.pinnedAt })).toBe(false);
    expect(isProjectsViewPinnedThread({ ...pinned, deletedAt: pinned.pinnedAt })).toBe(false);
    expect(
      isProjectsViewPinnedThread({
        ...pinned,
        lineage: {
          ...pinned.lineage,
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
      }),
    ).toBe(false);
  });
  it("jumps to pins first and keeps project order without duplicates across hosts", () => {
    const orderedPins = sortPinnedThreadsByOrderKey([
      { id: "same", environmentId: "remote", createdAt: "2026-10-12T00:00:00Z", pinOrderKey: "b" },
      { id: "same", environmentId: "local", createdAt: "2026-10-11T00:00:00Z", pinOrderKey: "a" },
    ]).map((thread) => `${thread.environmentId}:${thread.id}`);
    expect(
      resolveProjectsViewThreadOrder(orderedPins, [
        "remote:other",
        "local:same",
        "remote:same",
        "local:last",
        "remote:other",
      ]),
    ).toEqual(["local:same", "remote:same", "remote:other", "local:last"]);
    expect(resolveProjectsViewThreadOrder([], ["local:first", "remote:last"])).toEqual([
      "local:first",
      "remote:last",
    ]);
    expect(resolveProjectsViewThreadOrder(orderedPins, [])).toEqual(orderedPins);
  });
});

describe("remote project connection dot", () => {
  it("is green only when all remote members are connected", () => {
    expect(resolveProjectConnectionStatus(["connected", "connected"])).toBe("connected");
  });
  it.each(["connecting", "reconnecting"] as const)("is gray while %s", (phase) => {
    expect(resolveProjectConnectionStatus(["connected", phase])).toBe("connecting");
  });
  it.each(["offline", "error", "available", "unsupported"] as const)(
    "is red when a remote member is %s",
    (phase) => {
      expect(resolveProjectConnectionStatus(["connected", phase, "connecting"])).toBe(
        "disconnected",
      );
    },
  );
  it("is red when the connection is not known", () => {
    expect(resolveProjectConnectionStatus([])).toBe("disconnected");
  });
});
