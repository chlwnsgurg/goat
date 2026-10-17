import { EnvironmentId, ThreadId, type RemoteLaunch } from "@goat/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import {
  REMOTE_LAUNCH_ACTIVE_REFRESH_MS,
  REMOTE_LAUNCH_IDLE_REFRESH_MS,
  buildSidebarRemoteLaunchIndex,
  chooseRemoteLaunchRefreshMs,
  remoteLaunchStatus,
  scheduleRemoteLaunchRefresh,
  type DispatcherRemoteLaunches,
} from "./remoteLaunchIndex.ts";
import type { RemoteLaunchShell } from "./remoteLaunches.ts";

const dispatcher = EnvironmentId.make("dispatcher");
const other = EnvironmentId.make("other-dispatcher");
const builder = EnvironmentId.make("builder-env");
const launcher = ThreadId.make("launcher");

const launch = (overrides: Partial<RemoteLaunch> = {}): RemoteLaunch => ({
  host: "builder",
  threadId: ThreadId.make("remote-thread"),
  title: null,
  launcherThreadId: launcher,
  source: "thread",
  state: "running",
  latest: null,
  hostUnavailableSince: null,
  updatedAt: "2026-10-17T10:00:00.000Z",
  ...overrides,
});

const listed = (
  launches: ReadonlyArray<RemoteLaunch>,
  environmentId = dispatcher,
  truncated = false,
): DispatcherRemoteLaunches => ({ environmentId, result: { launches, truncated } });

const keyOf = (environmentId: EnvironmentId) =>
  scopedThreadKey(scopeThreadRef(environmentId, launcher));

const at = (minute: number) => `2026-10-17T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("buildSidebarRemoteLaunchIndex", () => {
  it("keeps launchers from different dispatchers apart even when their ids match", () => {
    const index = buildSidebarRemoteLaunchIndex({
      dispatchers: [
        listed([launch({ host: "a" })]),
        listed([launch({ host: "b" }), launch({ host: "c", threadId: null })], other),
      ],
      shells: [],
    });
    expect(index.byLauncherKey.get(keyOf(dispatcher))?.visible.map((e) => e.launch.host)).toEqual([
      "a",
    ]);
    expect(index.byLauncherKey.get(keyOf(other))?.visible.map((e) => e.launch.host)).toEqual([
      "b",
      "c",
    ]);
  });

  it("shows the three newest across hosts and counts the rest", () => {
    // The presenter groups by host, so the index restores time order; equal times keep server order.
    const index = buildSidebarRemoteLaunchIndex({
      dispatchers: [
        listed([
          launch({ host: "a", threadId: ThreadId.make("a1"), updatedAt: at(5) }),
          launch({ host: "b", threadId: ThreadId.make("b1"), updatedAt: at(5) }),
          launch({ host: "a", threadId: ThreadId.make("a2"), updatedAt: at(1) }),
          launch({ host: "b", threadId: ThreadId.make("b2"), updatedAt: at(9) }),
        ]),
      ],
      shells: [],
    });
    const group = index.byLauncherKey.get(keyOf(dispatcher));
    expect(group?.visible.map((e) => e.launch.threadId)).toEqual(["b2", "a1", "b1"]);
    expect(group?.hiddenInPage).toBe(1);
    expect(group?.truncated).toBe(false);
  });

  it("marks a truncated page without inventing a total", () => {
    const index = buildSidebarRemoteLaunchIndex({
      dispatchers: [listed([launch()], dispatcher, true)],
      shells: [],
    });
    expect(index.byLauncherKey.get(keyOf(dispatcher))).toMatchObject({
      hiddenInPage: 0,
      truncated: true,
    });
  });

  it("refreshes each dispatcher at its own cadence", () => {
    const index = buildSidebarRemoteLaunchIndex({
      dispatchers: [listed([launch({ state: "launching", threadId: null })]), listed([], other)],
      shells: [],
    });
    expect([...index.refreshMsByDispatcher]).toEqual([
      [dispatcher, REMOTE_LAUNCH_ACTIVE_REFRESH_MS],
      [other, REMOTE_LAUNCH_IDLE_REFRESH_MS],
    ]);
  });

  it("keeps group and index identity across an equal poll and unrelated shells", () => {
    const shells: Array<RemoteLaunchShell> = [
      { environmentId: builder, id: ThreadId.make("remote-thread"), title: "Live", source: {} },
    ];
    const first = buildSidebarRemoteLaunchIndex({ dispatchers: [listed([launch()])], shells });
    const unrelated: RemoteLaunchShell = {
      environmentId: builder,
      id: ThreadId.make("unrelated"),
      title: "Other",
      source: {},
    };
    // A fresh response with equal values, as every poll returns.
    const second = buildSidebarRemoteLaunchIndex(
      { dispatchers: [listed([launch()])], shells: [...shells, unrelated] },
      first,
    );
    expect(second).toBe(first);

    const settled = buildSidebarRemoteLaunchIndex(
      { dispatchers: [listed([launch({ state: "settled" })]), listed([], other)], shells },
      first,
    );
    expect(settled).not.toBe(first);
    expect(settled.byLauncherKey.get(keyOf(dispatcher))?.visible[0]?.launch.state).toBe("settled");
  });
});

describe("remote launch status and cadence", () => {
  it.each([
    ["launching", "remote-thread", true, "Launching"],
    ["running", "remote-thread", true, "Running"],
    ["idle", "remote-thread", false, "Idle"],
    ["settled", "remote-thread", false, "Done"],
    ["cancelled", "remote-thread", false, "Cancelled"],
    ["lost", "remote-thread", false, "Outcome unknown"],
    [null, "remote-thread", false, "Watched"],
    [null, null, true, "Watched"],
  ] as const)("classifies %s (thread %s)", (state, threadId, active, label) => {
    const item = launch({ state, threadId: threadId === null ? null : ThreadId.make(threadId) });
    expect(chooseRemoteLaunchRefreshMs([item])).toBe(
      active ? REMOTE_LAUNCH_ACTIVE_REFRESH_MS : REMOTE_LAUNCH_IDLE_REFRESH_MS,
    );
    expect(remoteLaunchStatus(item)).toBe(label);
  });

  it("reports an unreachable host over its run state", () => {
    const item = launch({ hostUnavailableSince: at(0) });
    expect(remoteLaunchStatus(item)).toBe("Host unreachable");
    expect(chooseRemoteLaunchRefreshMs([item])).toBe(REMOTE_LAUNCH_ACTIVE_REFRESH_MS);
  });
});

describe("scheduleRemoteLaunchRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-lists active dispatchers quickly, idle ones slowly, and stops when cancelled", () => {
    vi.useFakeTimers();
    const calls: Array<EnvironmentId> = [];
    const refresh = (environmentId: EnvironmentId) => calls.push(environmentId);
    let cancel = scheduleRemoteLaunchRefresh(
      new Map([
        [dispatcher, REMOTE_LAUNCH_ACTIVE_REFRESH_MS],
        [other, REMOTE_LAUNCH_IDLE_REFRESH_MS],
      ]),
      refresh,
    );
    vi.advanceTimersByTime(REMOTE_LAUNCH_IDLE_REFRESH_MS);
    expect(calls.filter((id) => id === dispatcher)).toHaveLength(12);
    expect(calls.filter((id) => id === other)).toHaveLength(1);

    // The launch settled and the other dispatcher disconnected.
    cancel();
    calls.length = 0;
    cancel = scheduleRemoteLaunchRefresh(
      new Map([[dispatcher, REMOTE_LAUNCH_IDLE_REFRESH_MS]]),
      refresh,
    );
    vi.advanceTimersByTime(REMOTE_LAUNCH_IDLE_REFRESH_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([dispatcher]);

    cancel();
    vi.advanceTimersByTime(REMOTE_LAUNCH_IDLE_REFRESH_MS * 2);
    expect(calls).toEqual([dispatcher]);
  });
});
