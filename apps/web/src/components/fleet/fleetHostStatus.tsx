import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, HostStatusEntry } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { fleetEnvironmentsAtom } from "~/state/fleet";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { serverEnvironment } from "~/state/server";

import { HOST_STATUS_REFRESH_MS } from "../settings/hostStatusView";
import {
  asLastKnown,
  recordHostSamples,
  type FleetHostRead,
  type HostHistory,
} from "./fleetTelemetry";

/*
 * The Fleet console's one source of host metrics: the same host-status query and 15 s cadence
 * as Settings > Hosts. Swap this file for a shared Fleet metrics hook when one lands.
 */

export interface FleetHostStatus {
  readonly reads: ReadonlyArray<FleetHostRead>;
  /** Environments being read, for their refreshers. */
  readonly sources: ReadonlyArray<EnvironmentId>;
  readonly history: HostHistory;
  readonly loading: boolean;
  /** Environments whose read failed with no earlier answer to fall back on. */
  readonly failed: ReadonlyArray<EnvironmentId>;
  /** Newest sample time the hosts reported; 0 before the first answer. */
  readonly sampledAt: number;
  /** When this client last received an answer, for ages that must not trust host clocks. */
  readonly observedAt: number;
}

const hostStatusAtom = (environmentId: EnvironmentId) =>
  serverEnvironment.hostStatus({ environmentId, input: {} });

/*
 * Sparkline history outlives the query atoms, which are disposed as soon as the console
 * collapses or the page closes. Recording is idempotent (a repeated sample adds nothing) and
 * bounded in length and age, so recomputing the atom cannot grow it.
 */
let hostHistory: HostHistory = new Map();

export const fleetHostStatusAtom = Atom.make((get): FleetHostStatus => {
  const environments = get(fleetEnvironmentsAtom);
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  const reads: FleetHostRead[] = [];
  const sources: EnvironmentId[] = [];
  const failed: EnvironmentId[] = [];
  let loading = false;
  let observedAt = 0;
  /** Null while the first answer is still on its way; an empty list once it failed. */
  const read = (environmentId: EnvironmentId): ReadonlyArray<HostStatusEntry> | null => {
    sources.push(environmentId);
    const result = get(hostStatusAtom(environmentId));
    const hosts = Option.getOrNull(AsyncResult.value(result))?.hosts ?? null;
    if (AsyncResult.isFailure(result)) {
      // A failed refresh keeps its last answer; show it as last known, and let it vouch for
      // nothing so other environments are asked directly.
      failed.push(environmentId);
      // A failure carries no timestamp. The atom recomputes once per settled refresh, so now
      // is when this client learned of it.
      observedAt = Math.max(observedAt, Date.now());
      if (hosts !== null) reads.push({ environmentId, hosts: asLastKnown(hosts) });
      return [];
    }
    if (hosts === null) {
      loading = true;
      return null;
    }
    reads.push({ environmentId, hosts });
    if (AsyncResult.isSuccess(result)) observedAt = Math.max(observedAt, result.timestamp);
    return hosts;
  };

  // The primary environment answers for itself and every SSH host it holds open. Another
  // environment is asked only when that answer cannot vouch for it, because each read samples
  // CPU and fans out to that machine's own SSH hosts.
  const hasPrimary = environments.some((env) => env.environmentId === primaryEnvironmentId);
  const primaryHosts =
    hasPrimary && primaryEnvironmentId !== null ? read(primaryEnvironmentId) : null;
  for (const environment of environments) {
    if (environment.environmentId === primaryEnvironmentId) continue;
    if (hasPrimary && primaryHosts === null) continue;
    const covered = primaryHosts?.some(
      (entry) =>
        entry.reachability === "ok" &&
        entry.host !== null &&
        environment.sshAliases.includes(entry.host),
    );
    if (covered !== true) read(environment.environmentId);
  }

  hostHistory = recordHostSamples(hostHistory, reads, Date.now());
  const sampledAt = reads.reduce(
    (newest, { hosts }) =>
      hosts.reduce((latest, entry) => Math.max(latest, entry.metrics?.sampledAt ?? 0), newest),
    0,
  );
  const previous = Option.getOrNull(get.self<FleetHostStatus>());
  // A refresh passes through a waiting state with the same answer; keep one object for it.
  if (
    previous !== null &&
    previous.loading === loading &&
    previous.observedAt === observedAt &&
    previous.failed.join("\n") === failed.join("\n") &&
    previous.history === hostHistory &&
    previous.sources.join("\n") === sources.join("\n") &&
    previous.reads.length === reads.length &&
    previous.reads.every((entry, index) => entry.hosts === reads[index]!.hosts)
  ) {
    return previous;
  }
  return { reads, sources, history: hostHistory, loading, failed, sampledAt, observedAt };
}).pipe(Atom.withLabel("fleet-host-status"));

export function useFleetHostStatus(): FleetHostStatus {
  return useAtomValue(fleetHostStatusAtom);
}

/**
 * Keeps one environment's host status fresh on the Settings > Hosts schedule. It shares that
 * view's key, so opening one right after the other does not read twice.
 */
export function FleetHostStatusRefresh({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const registry = useContext(RegistryContext);
  useLiveRefresh(() => registry.refresh(hostStatusAtom(environmentId)), {
    key: `host-status:${environmentId}`,
    intervalMs: HOST_STATUS_REFRESH_MS,
  });
  return null;
}
