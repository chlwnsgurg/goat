import type { EnvironmentId } from "@goat/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import { serverEnvironment } from "./server";

/** Each read samples CPU for 200ms and asks every SSH host; quota refresh is capped server-side. */
export const HOST_STATUS_REFRESH_MS = 15_000;

/**
 * The host-status read for an environment. The primary fans out to its SSH hosts,
 * the same atom Settings' Hosts section reads; any other environment reports
 * only itself, since its SSH hosts are not this client's.
 */
export function hostStatusAtom(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
) {
  return serverEnvironment.hostStatus({
    environmentId,
    input: environmentId === primaryEnvironmentId ? {} : { local: true },
  });
}

const lastRefreshedAt = new WeakMap<Atom.Atom<unknown>, number>();

/**
 * Refreshes a host-status read unless another view already did this period, so
 * Settings and Fleet open together still read each environment once per period.
 */
export function refreshHostStatus(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<unknown>,
  now = Date.now(),
): void {
  const last = lastRefreshedAt.get(atom);
  // A second short of the period lets a view whose timer fires just early still lead.
  if (last !== undefined && now - last < HOST_STATUS_REFRESH_MS - 1_000) return;
  lastRefreshedAt.set(atom, now);
  registry.refresh(atom);
}
