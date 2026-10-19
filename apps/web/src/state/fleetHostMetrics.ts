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

/** Every connected environment's read, by environment. Mounting this starts the reads. */
const fleetHostStatusAtoms = Atom.make((get) => {
  const primary = get(primaryEnvironmentIdAtom);
  return get(fleetEnvironmentsAtom).map(({ environmentId }) => ({
    environmentId,
    atom: hostStatusAtom(environmentId, primary),
  }));
}).pipe(Atom.withLabel("fleet-host-status-atoms"));

const fleetHostReportsAtom = Atom.make((get) => {
  const reports = new Map<EnvironmentId, ReadonlyArray<HostStatusEntry>>();
  for (const { environmentId, atom } of get(fleetHostStatusAtoms)) {
    const value = Option.getOrNull(AsyncResult.value(get(atom)));
    if (value !== null) reports.set(environmentId, value.hosts);
  }
  return reports;
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
    reports: get(fleetHostReportsAtom),
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
      for (const { atom } of registry.get(fleetHostStatusAtoms)) refreshHostStatus(registry, atom);
    },
    { key: "fleet-host-status", intervalMs: HOST_STATUS_REFRESH_MS },
  );
  return heat;
}
