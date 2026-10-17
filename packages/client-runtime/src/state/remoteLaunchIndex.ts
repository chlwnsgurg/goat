// @effect-diagnostics globalTimers:off - Sidebar refresh cadence for React clients, outside an Effect runtime.
import type { EnvironmentId, RemoteLaunch, RemoteLaunchesListResult } from "@goat/contracts";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import {
  presentRemoteLaunches,
  type PresentedRemoteLaunch,
  type RemoteLaunchShell,
} from "./remoteLaunches.ts";

/** Children shown beneath a launcher row; the rest are in Remote launches settings. */
export const SIDEBAR_REMOTE_LAUNCH_LIMIT = 3;
export const REMOTE_LAUNCH_ACTIVE_REFRESH_MS = 5_000;
export const REMOTE_LAUNCH_IDLE_REFRESH_MS = 60_000;

export interface DispatcherRemoteLaunches {
  readonly environmentId: EnvironmentId;
  readonly result: RemoteLaunchesListResult;
}

export interface SidebarRemoteLaunchGroup {
  /** Newest first, at most `SIDEBAR_REMOTE_LAUNCH_LIMIT`. */
  readonly visible: ReadonlyArray<PresentedRemoteLaunch>;
  /** Launches for this launcher in the listed page that did not fit. */
  readonly hiddenInPage: number;
  /** The dispatcher listed only its most recent launches, so the hidden count is a floor. */
  readonly truncated: boolean;
}

export interface SidebarRemoteLaunchIndex {
  /** Keyed by the launcher's scoped thread key in its dispatching environment. */
  readonly byLauncherKey: ReadonlyMap<string, SidebarRemoteLaunchGroup>;
  /** How often to re-list each dispatcher that answered. */
  readonly refreshMsByDispatcher: ReadonlyMap<EnvironmentId, number>;
}

/** Still starting or working, so its row is worth refreshing quickly. */
export function isActiveRemoteLaunch(launch: RemoteLaunch): boolean {
  return (
    launch.state === "launching" ||
    launch.state === "running" ||
    (launch.state === null && launch.threadId === null)
  );
}

export function remoteLaunchStatus(launch: RemoteLaunch): string {
  if (launch.hostUnavailableSince !== null) return "Host unreachable";
  switch (launch.state) {
    case "launching":
      return "Launching";
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    case "settled":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "lost":
      return "Outcome unknown";
    case null:
      return "Watched";
  }
}

export function chooseRemoteLaunchRefreshMs(launches: ReadonlyArray<RemoteLaunch>): number {
  return launches.some(isActiveRemoteLaunch)
    ? REMOTE_LAUNCH_ACTIVE_REFRESH_MS
    : REMOTE_LAUNCH_IDLE_REFRESH_MS;
}

function sameEntry(left: PresentedRemoteLaunch, right: PresentedRemoteLaunch): boolean {
  const a = left.launch;
  const b = right.launch;
  return (
    a.host === b.host &&
    a.threadId === b.threadId &&
    a.state === b.state &&
    a.hostUnavailableSince === b.hostUnavailableSince &&
    a.updatedAt === b.updatedAt &&
    left.title === right.title &&
    left.providerLabel === right.providerLabel &&
    (left.ref === null ? null : scopedThreadKey(left.ref)) ===
      (right.ref === null ? null : scopedThreadKey(right.ref))
  );
}

function sameGroup(left: SidebarRemoteLaunchGroup, right: SidebarRemoteLaunchGroup): boolean {
  return (
    left.hiddenInPage === right.hiddenInPage &&
    left.truncated === right.truncated &&
    left.visible.length === right.visible.length &&
    left.visible.every((entry, index) => sameEntry(entry, right.visible[index]!))
  );
}

/**
 * Groups every connected dispatcher's remote launches under the launcher thread
 * that started them. Pass the previous index: groups whose rows read the same
 * keep their identity, and an unchanged index is returned as is, so a poll or
 * an unrelated shell update does not re-render launcher rows.
 */
export function buildSidebarRemoteLaunchIndex(
  input: {
    readonly dispatchers: ReadonlyArray<DispatcherRemoteLaunches>;
    readonly shells: ReadonlyArray<RemoteLaunchShell>;
    readonly providerName?: (environmentId: EnvironmentId, instanceId: string) => string | null;
  },
  previous?: SidebarRemoteLaunchIndex,
): SidebarRemoteLaunchIndex {
  const entriesByLauncher = new Map<
    string,
    { entries: Array<{ entry: PresentedRemoteLaunch; order: number }>; truncated: boolean }
  >();
  const refreshMsByDispatcher = new Map<EnvironmentId, number>();
  for (const { environmentId, result } of input.dispatchers) {
    refreshMsByDispatcher.set(environmentId, chooseRemoteLaunchRefreshMs(result.launches));
    const order = new Map(result.launches.map((launch, index) => [launch, index] as const));
    const hostGroups = presentRemoteLaunches({
      dispatcherEnvironmentId: environmentId,
      launches: result.launches,
      shells: input.shells,
      ...(input.providerName ? { providerName: input.providerName } : {}),
    });
    for (const entry of hostGroups.flatMap((group) => group.launches)) {
      const key = scopedThreadKey(scopeThreadRef(environmentId, entry.launch.launcherThreadId));
      const group = entriesByLauncher.get(key) ?? { entries: [], truncated: false };
      group.entries.push({ entry, order: order.get(entry.launch) ?? 0 });
      group.truncated ||= result.truncated;
      entriesByLauncher.set(key, group);
    }
  }

  // An equal plan keeps its identity so refresh timers are not re-armed.
  const samePlan =
    previous !== undefined &&
    previous.refreshMsByDispatcher.size === refreshMsByDispatcher.size &&
    [...refreshMsByDispatcher].every(
      ([environmentId, ms]) => previous.refreshMsByDispatcher.get(environmentId) === ms,
    );
  let unchanged = samePlan && previous.byLauncherKey.size === entriesByLauncher.size;
  const byLauncherKey = new Map<string, SidebarRemoteLaunchGroup>();
  for (const [key, { entries, truncated }] of entriesByLauncher) {
    const ordered = [...entries]
      .sort(
        (left, right) =>
          Date.parse(right.entry.launch.updatedAt) - Date.parse(left.entry.launch.updatedAt) ||
          left.order - right.order,
      )
      .map(({ entry }) => entry);
    const group: SidebarRemoteLaunchGroup = {
      visible: ordered.slice(0, SIDEBAR_REMOTE_LAUNCH_LIMIT),
      hiddenInPage: Math.max(0, ordered.length - SIDEBAR_REMOTE_LAUNCH_LIMIT),
      truncated,
    };
    const prior = previous?.byLauncherKey.get(key);
    if (prior !== undefined && sameGroup(prior, group)) {
      byLauncherKey.set(key, prior);
    } else {
      unchanged = false;
      byLauncherKey.set(key, group);
    }
  }
  return unchanged && previous !== undefined
    ? previous
    : {
        byLauncherKey,
        refreshMsByDispatcher:
          samePlan && previous !== undefined
            ? previous.refreshMsByDispatcher
            : refreshMsByDispatcher,
      };
}

/**
 * Re-lists each dispatcher at its own cadence until cancelled. Callers
 * reschedule when the plan changes, such as when a launch settles.
 */
export function scheduleRemoteLaunchRefresh(
  refreshMsByDispatcher: ReadonlyMap<EnvironmentId, number>,
  refresh: (environmentId: EnvironmentId) => void,
): () => void {
  const handles = [...refreshMsByDispatcher].map(([environmentId, ms]) =>
    setInterval(() => refresh(environmentId), ms),
  );
  return () => {
    for (const handle of handles) clearInterval(handle);
  };
}
