import type { FleetHostCondition, HostStatusEntry } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { isExhausted } from "../../channels/channelPlacement.ts";
import { OUTAGE_NOTICE_FAILURES, type LaunchWatchOutage } from "../../mcp/launchWatch.ts";

/**
 * Host conditions from goat_host_status samples and launch-watch outages, free of I/O.
 *
 * A host turns Unreachable only after OUTAGE_NOTICE_FAILURES failed contacts spread over at
 * least unreachableAfterMs, and its work moves only once the outage is evictAfterMs old.
 * Kubernetes uses the same two steps (node-monitor-grace-period, then a 300 s unreachable
 * toleration); the longer bounds here leave room for an SSH reconnect after a laptop lid.
 *
 * Sleep on this machine is not evidence about other hosts: every failure recorded across a
 * gap in our own ticks, while suspended, or within wakeGraceMs after waking is discarded, so a
 * Mac waking from sleep never evicts anything (ssh-reconnect.md has the reconnect side).
 */
export const HOST_HEALTH_THRESHOLDS = {
  sampleIntervalMs: 60_000,
  unreachableFailures: OUTAGE_NOTICE_FAILURES,
  unreachableAfterMs: 5 * 60_000,
  evictAfterMs: 15 * 60_000,
  sleepGapMs: 2 * 60_000,
  wakeGraceMs: 5 * 60_000,
} as const;
export type HostHealthThresholds = typeof HOST_HEALTH_THRESHOLDS;

export interface HostContact {
  readonly lastOkAt: number | null;
  readonly failures: number;
  readonly firstFailureAt: number | null;
  readonly lastError: string | null;
  /** The last answer from the host, for versions and quotas. */
  readonly sample: HostStatusEntry | null;
}

export const emptyContact: HostContact = {
  lastOkAt: null,
  failures: 0,
  firstFailureAt: null,
  lastError: null,
  sample: null,
};

export interface MonitorClock {
  readonly lastTickAt: number | null;
  /** Failures before this instant are not counted: this machine was asleep. */
  readonly quietUntil: number;
  readonly wokeAt: number | null;
}

export const initialClock: MonitorClock = { lastTickAt: null, quietUntil: 0, wokeAt: null };

/** Advances the monitor clock; woke means outage windows straddling the gap must be dropped. */
export function observeTick(
  clock: MonitorClock,
  now: number,
  suspended: boolean,
  thresholds: HostHealthThresholds = HOST_HEALTH_THRESHOLDS,
): { readonly clock: MonitorClock; readonly woke: boolean } {
  const gap = clock.lastTickAt === null ? 0 : now - clock.lastTickAt;
  const woke = suspended || gap >= thresholds.sleepGapMs;
  return {
    woke,
    clock: woke
      ? { lastTickAt: now, quietUntil: now + thresholds.wakeGraceMs, wokeAt: now }
      : { ...clock, lastTickAt: now },
  };
}

/** After waking, earlier failures say nothing about the host. */
export const forgetFailures = (contact: HostContact): HostContact =>
  contact.failures === 0 ? contact : { ...contact, failures: 0, firstFailureAt: null };

/** One goat_host_status answer for the host. "unsupported" still answered, so it is contact. */
export function recordSample(
  contact: HostContact,
  entry: HostStatusEntry,
  now: number,
  clock: MonitorClock,
): HostContact {
  if (entry.reachability !== "unreachable") {
    return { lastOkAt: now, failures: 0, firstFailureAt: null, lastError: null, sample: entry };
  }
  if (now < clock.quietUntil) return contact;
  return {
    ...contact,
    failures: contact.failures + 1,
    firstFailureAt: contact.firstFailureAt ?? now,
    lastError: entry.message ?? "unreachable",
  };
}

/**
 * A launch watch's outage is the same evidence from another follower. It counts only when it
 * began after this machine last woke and after the host last answered.
 */
export function recordOutage(
  contact: HostContact,
  outage: LaunchWatchOutage,
  clock: MonitorClock,
): HostContact {
  if (clock.wokeAt !== null && outage.since < clock.quietUntil) return contact;
  if (contact.lastOkAt !== null && outage.since <= contact.lastOkAt) return contact;
  if (outage.failures <= contact.failures) return contact;
  return {
    ...contact,
    failures: outage.failures,
    firstFailureAt: Math.min(contact.firstFailureAt ?? outage.since, outage.since),
    lastError: outage.lastError,
  };
}

export function isUnreachable(
  contact: HostContact,
  now: number,
  thresholds: HostHealthThresholds = HOST_HEALTH_THRESHOLDS,
): boolean {
  return (
    contact.failures >= thresholds.unreachableFailures &&
    contact.firstFailureAt !== null &&
    now - contact.firstFailureAt >= thresholds.unreachableAfterMs
  );
}

/** Work may leave the host: Unreachable, and the outage is old enough. */
export function isEvictable(
  contact: HostContact,
  now: number,
  thresholds: HostHealthThresholds = HOST_HEALTH_THRESHOLDS,
): boolean {
  return (
    isUnreachable(contact, now, thresholds) &&
    now - contact.firstFailureAt! >= thresholds.evictAfterMs
  );
}

export interface HostSchedulingState {
  readonly cordonedAt: number | null;
  readonly cordonReason: string | null;
  readonly drainingAt: number | null;
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export function deriveConditions(input: {
  readonly contact: HostContact;
  readonly scheduling: HostSchedulingState | undefined;
  readonly now: number;
  readonly thresholds?: HostHealthThresholds;
}): Array<FleetHostCondition> {
  const { contact, scheduling, now } = input;
  const thresholds = input.thresholds ?? HOST_HEALTH_THRESHOLDS;
  const conditions: Array<FleetHostCondition> = [];
  if (isUnreachable(contact, now, thresholds)) {
    conditions.push({
      type: "Unreachable",
      since: iso(contact.firstFailureAt!),
      message: contact.failures + " failed contacts in a row; last: " + (contact.lastError ?? ""),
    });
  } else if (contact.lastOkAt !== null) {
    conditions.push({
      type: "Ready",
      since: iso(contact.lastOkAt),
      message:
        contact.failures === 0
          ? "Answered goat_host_status."
          : "Answered before; " + contact.failures + " recent contacts failed.",
    });
  }
  if (scheduling?.cordonedAt != null) {
    conditions.push({
      type: "Cordoned",
      since: iso(scheduling.cordonedAt),
      message: scheduling.cordonReason ?? "No new self-healing or goal placements.",
    });
  }
  if (scheduling?.drainingAt != null) {
    conditions.push({
      type: "Draining",
      since: iso(scheduling.drainingAt),
      message: "Self-healing workers move off this host after their current turn.",
    });
  }
  const sample = contact.sample;
  if (sample?.versionMismatch === true) {
    conditions.push({
      type: "VersionMismatch",
      since: iso(contact.lastOkAt ?? now),
      message: sample.message ?? "Runs a different GOAT version.",
    });
  }
  for (const quota of sample?.metrics?.quotas ?? []) {
    const windows = quota.limits.windows.map((window) => ({
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
    }));
    const candidate = {
      value: null,
      host: sample?.host ?? null,
      providerLabel: quota.instanceId,
      preferred: false,
      windows,
      activeTasks: 0,
    };
    if (!isExhausted(candidate, now)) continue;
    conditions.push({
      type: "QuotaExhausted",
      since: iso(contact.lastOkAt ?? now),
      instanceId: quota.instanceId,
      message: quota.instanceId + " is at its usage limit.",
    });
  }
  return conditions;
}

/** New or moved work may be placed here. VersionMismatch and quotas are warnings only. */
export const isSchedulable = (conditions: ReadonlyArray<FleetHostCondition>) =>
  conditions.some((condition) => condition.type === "Ready") &&
  !conditions.some(
    (condition) =>
      condition.type === "Unreachable" ||
      condition.type === "Cordoned" ||
      condition.type === "Draining",
  );
