import { useAtomValue } from "@effect/atom-react";
import { connectionRoutes } from "@goat/client-runtime/connection";
import {
  buildFleet,
  createFleetSummaryAtom,
  type FleetEnvironment,
  type FleetRemoteSource,
  type FleetSnapshot,
  type FleetSummary,
} from "@goat/client-runtime/state/fleet";
import { resolveProviderInstanceDisplayName } from "@goat/client-runtime/state/provider-instance-display";
import type { CloudMachine, EnvironmentId, RemoteLaunch } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

const EMPTY: ReadonlyArray<never> = Object.freeze([]);

function sameEnvironments(
  left: ReadonlyArray<FleetEnvironment>,
  right: ReadonlyArray<FleetEnvironment>,
): boolean {
  return (
    left.length === right.length &&
    left.every((environment, index) => {
      const other = right[index]!;
      return (
        environment.environmentId === other.environmentId &&
        environment.label === other.label &&
        environment.sshAliases.join("\n") === other.sshAliases.join("\n")
      );
    })
  );
}

/** Connected environments with their labels and the SSH aliases this client uses for them. */
export const fleetEnvironmentsAtom = Atom.make((get): ReadonlyArray<FleetEnvironment> => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const next: FleetEnvironment[] = [];
  for (const environmentId of get(environmentSummaries.connectedEnvironmentIdsAtom)) {
    const entry = catalog.entries.get(environmentId);
    if (entry === undefined) continue;
    const sshAliases: string[] = [];
    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (profile?._tag === "SshConnectionProfile") sshAliases.push(profile.target.alias);
    }
    next.push({ environmentId, label: entry.target.label, sshAliases });
  }
  const previous = Option.getOrNull(get.self<ReadonlyArray<FleetEnvironment>>());
  return previous !== null && sameEnvironments(previous, next) ? previous : next;
}).pipe(Atom.withLabel("fleet-environments"));

export const fleetSummaryAtom = createFleetSummaryAtom({
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  environmentsAtom: fleetEnvironmentsAtom,
});

export function useFleetSummary(): FleetSummary {
  return useAtomValue(fleetSummaryAtom);
}

/**
 * What each connected environment last reported about SSH launches and cloud
 * machines. Only the Fleet page reads it, so the queries mount, and revalidate,
 * when the page opens.
 */
const fleetRemoteAtom = Atom.make((get) => {
  const sources: FleetRemoteSource[] = [];
  let loading = false;
  for (const { environmentId } of get(fleetEnvironmentsAtom)) {
    const launches = get(serverEnvironment.remoteLaunches({ environmentId, input: {} }));
    const cloud = get(serverEnvironment.cloudMachines({ environmentId, input: {} }));
    loading ||= AsyncResult.isInitial(launches) || AsyncResult.isInitial(cloud);
    const launchList: ReadonlyArray<RemoteLaunch> =
      Option.getOrNull(AsyncResult.value(launches))?.launches ?? EMPTY;
    const machines: ReadonlyArray<CloudMachine> =
      Option.getOrNull(AsyncResult.value(cloud))?.machines ?? EMPTY;
    if (launchList.length > 0 || machines.length > 0) {
      sources.push({
        dispatcherEnvironmentId: environmentId,
        launches: launchList,
        cloudMachines: machines,
      });
    }
  }
  return { sources, loading };
}).pipe(Atom.withLabel("fleet-remote"));

/** What the page draws, so streamed thread updates that change none of it keep one snapshot. */
function snapshotKey(snapshot: FleetSnapshot): string {
  return JSON.stringify([
    snapshot.machines.map((machine) => [
      machine.id,
      machine.label,
      machine.subtitle,
      machine.cloudState,
      machine.running,
      machine.attention,
      machine.reported,
      machine.agents.map((agent) => [
        agent.key,
        agent.label,
        agent.running,
        agent.attention,
        agent.reported,
      ]),
    ]),
    snapshot.threads.map((thread) => [thread.key, thread.title, thread.state, thread.agentKey]),
  ]);
}

interface FleetPageState {
  readonly snapshot: FleetSnapshot;
  readonly loading: boolean;
  readonly key: string;
}

const fleetPageAtom = Atom.make((get): FleetPageState => {
  const serverConfigs = get(environmentServerConfigsAtom);
  const remote = get(fleetRemoteAtom);
  const providerName = (environmentId: EnvironmentId, instanceId: string) => {
    const provider = serverConfigs
      .get(environmentId)
      ?.providers.find((candidate) => candidate.instanceId === instanceId);
    return provider === undefined ? null : resolveProviderInstanceDisplayName(provider);
  };
  const snapshot = buildFleet({
    environments: get(fleetEnvironmentsAtom),
    primaryEnvironmentId: get(primaryEnvironmentIdAtom),
    shells: get(environmentThreadShells.threadShellsAtom),
    remote: remote.sources,
    providerName,
  });
  const key = snapshotKey(snapshot);
  const previous = Option.getOrNull(get.self<FleetPageState>());
  return previous !== null && previous.key === key && previous.loading === remote.loading
    ? previous
    : { snapshot, loading: remote.loading, key };
}).pipe(Atom.withLabel("fleet-page"));

export function useFleetSnapshot(): Pick<FleetPageState, "snapshot" | "loading"> {
  return useAtomValue(fleetPageAtom);
}
