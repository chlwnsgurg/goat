import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  fleetMachineHeat,
  fleetMachineHeatEqual,
  matchFleetHostEntries,
  type FleetMachineHeat,
} from "@goat/client-runtime/state/fleet-heat";
import type { EnvironmentId, HostStatusEntry } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { fleetEnvironmentsAtom, fleetPageAtom, fleetPageEnvironmentsAtom } from "./fleet";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { HOST_STATUS_REFRESH_MS, hostStatusAtom, refreshHostStatus } from "./hostStatus";

/** A failed refresh keeps its last answer; show it as last known, never as live. */
const asLastKnown = (hosts: ReadonlyArray<HostStatusEntry>): ReadonlyArray<HostStatusEntry> =>
  hosts.map((entry) =>
    entry.metrics === undefined
      ? { ...entry, reachability: "unreachable" }
      : { ...entry, reachability: "unreachable", lastKnown: true },
  );

/**
 * Each connected environment's host-status answer, by environment. The primary
 * answers for itself and every SSH host it holds open; another environment is
 * read only when that answer does not cover it, since each read samples CPU and
 * fans out to that machine's own SSH hosts. Sources lists every environment
 * read, answered or not, for refreshing. Mounting this starts the reads.
 */
export const fleetHostReportsAtom = Atom.make((get) => {
  const environments = get(fleetEnvironmentsAtom);
  const primary = get(primaryEnvironmentIdAtom);
  const reports = new Map<EnvironmentId, ReadonlyArray<HostStatusEntry>>();
  const sources: EnvironmentId[] = [];
  /** Null while the first answer is on its way. */
  const read = (environmentId: EnvironmentId): ReadonlyArray<HostStatusEntry> | null => {
    sources.push(environmentId);
    const result = get(hostStatusAtom(environmentId));
    const hosts = Option.getOrNull(AsyncResult.value(result))?.hosts ?? null;
    if (hosts === null) return AsyncResult.isFailure(result) ? [] : null;
    const answer = AsyncResult.isFailure(result) ? asLastKnown(hosts) : hosts;
    reports.set(environmentId, answer);
    return answer;
  };
  const hasPrimary = environments.some((environment) => environment.environmentId === primary);
  const primaryHosts = hasPrimary && primary !== null ? read(primary) : null;
  for (const environment of environments) {
    if (environment.environmentId === primary) continue;
    // Wait for the primary before asking anyone it may already cover.
    if (hasPrimary && primaryHosts === null) continue;
    const covered = primaryHosts?.some(
      (entry) =>
        entry.reachability === "ok" &&
        entry.host !== null &&
        environment.sshAliases.includes(entry.host),
    );
    if (covered !== true) read(environment.environmentId);
  }
  return { reports, sources } as const;
}).pipe(Atom.withLabel("fleet-host-reports"));

/**
 * Each Fleet machine's heat by machine id. A tier change keeps its previous
 * value for hysteresis, and an unchanged picture keeps the previous map so the
 * graph does not re-render on an idle poll.
 */
const fleetHeatAtom = Atom.make((get): ReadonlyMap<string, FleetMachineHeat> => {
  const { snapshot } = get(fleetPageAtom);
  const entries = matchFleetHostEntries({
    machines: snapshot.machines,
    sshAliases: new Map(
      get(fleetPageEnvironmentsAtom).map((environment) => [
        environment.environmentId,
        environment.sshAliases,
      ]),
    ),
    reports: get(fleetHostReportsAtom).reports,
    primaryEnvironmentId: get(primaryEnvironmentIdAtom),
  });
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, FleetMachineHeat>>());
  const next = new Map<string, FleetMachineHeat>();
  let changed = previous === null || previous.size !== snapshot.machines.length;
  for (const machine of snapshot.machines) {
    const before = previous?.get(machine.id);
    const heat = fleetMachineHeat(entries.get(machine.id), before?.tier);
    const kept = before !== undefined && fleetMachineHeatEqual(before, heat) ? before : heat;
    changed ||= kept !== before;
    next.set(machine.id, kept);
  }
  return changed || previous === null ? next : previous;
}).pipe(Atom.withLabel("fleet-heat"));

/**
 * How hard each Fleet machine is working, by machine id, from the same
 * host-status reads Settings shows. Reads start when a component mounts this and
 * stop when the last one unmounts; they refresh every 15s only while the
 * document is visible and someone has interacted recently.
 */
export function useFleetHostMetrics(): ReadonlyMap<string, FleetMachineHeat> {
  const registry = useContext(RegistryContext);
  const heat = useAtomValue(fleetHeatAtom);
  useLiveRefresh(
    () => {
      for (const environmentId of registry.get(fleetHostReportsAtom).sources) {
        refreshHostStatus(registry, hostStatusAtom(environmentId));
      }
    },
    { key: "fleet-host-status", intervalMs: HOST_STATUS_REFRESH_MS },
  );
  return heat;
}
