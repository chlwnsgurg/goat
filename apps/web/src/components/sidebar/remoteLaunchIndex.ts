import { useAtomValue } from "@effect/atom-react";
import {
  buildSidebarRemoteLaunchIndex,
  scheduleRemoteLaunchRefresh,
  type DispatcherRemoteLaunches,
  type SidebarRemoteLaunchIndex,
} from "@goat/client-runtime/state/remote-launch-index";
import { resolveProviderInstanceDisplayName } from "@goat/client-runtime/state/provider-instance-display";
import type { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";

// The same query input as Remote launches settings, so both share one cache entry.
const QUERY_INPUT = {};

const remoteLaunchesQuery = (environmentId: EnvironmentId) =>
  serverEnvironment.remoteLaunches({ environmentId, input: QUERY_INPUT });

/** Connected environments whose latest remote launch listing succeeded. */
const listedDispatchersAtom = Atom.make((get): ReadonlyArray<DispatcherRemoteLaunches> => {
  const listed: Array<DispatcherRemoteLaunches> = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (presentation.connection.phase !== "connected") continue;
    const result = Option.getOrNull(AsyncResult.value(get(remoteLaunchesQuery(environmentId))));
    if (result !== null) listed.push({ environmentId, result });
  }
  return listed;
}).pipe(Atom.withLabel("web-sidebar-remote-launches"));

// Unchanged groups keep their identity across polls and shell updates, so
// launcher rows re-render only when their remote launches read differently.
const remoteLaunchIndexAtom = (() => {
  let previous: SidebarRemoteLaunchIndex | undefined;
  return Atom.make((get) => {
    const configs = get(environmentServerConfigsAtom);
    previous = buildSidebarRemoteLaunchIndex(
      {
        dispatchers: get(listedDispatchersAtom),
        shells: get(environmentThreadShells.threadShellsAtom),
        providerName: (environmentId, instanceId) => {
          const provider = configs
            .get(environmentId)
            ?.providers.find((candidate) => candidate.instanceId === instanceId);
          return provider === undefined ? null : resolveProviderInstanceDisplayName(provider);
        },
      },
      previous,
    );
    return previous;
  }).pipe(Atom.withLabel("web-sidebar-remote-launch-index"));
})();

/** Recent work each launcher thread sent to other machines, keyed by scoped thread key. */
export function useSidebarRemoteLaunchIndex(): SidebarRemoteLaunchIndex {
  return useAtomValue(remoteLaunchIndexAtom);
}

/**
 * Keeps the listing fresh while a sidebar is mounted: quickly while a launch is
 * starting or running, slowly otherwise so launches from other clients appear.
 * Call once per sidebar.
 */
export function useSidebarRemoteLaunchRefresh(): void {
  const plan = useSidebarRemoteLaunchIndex().refreshMsByDispatcher;
  useEffect(
    () =>
      scheduleRemoteLaunchRefresh(plan, (environmentId) =>
        appAtomRegistry.refresh(remoteLaunchesQuery(environmentId)),
      ),
    [plan],
  );
}
