import { describe, expect, it } from "@effect/vitest";
import type { HostStatusEntry } from "@goat/contracts";

import {
  deriveConditions,
  emptyContact,
  forgetFailures,
  initialClock,
  isEvictable,
  isSchedulable,
  isUnreachable,
  observeTick,
  recordOutage,
  recordSample,
  type HostContact,
  type MonitorClock,
} from "./hostHealthModel.ts";

const MIN = 60_000;
const ok: HostStatusEntry = { host: "macmini", reachability: "ok", serverVersion: "1" };
const down: HostStatusEntry = {
  host: "macmini",
  reachability: "unreachable",
  message: "ssh timed out",
};

/** Samples once per interval from start, ticking the clock the way the monitor does. */
function run(
  samples: ReadonlyArray<{
    readonly at: number;
    readonly entry: HostStatusEntry;
    readonly suspended?: boolean;
  }>,
) {
  let contact: HostContact = emptyContact;
  let clock: MonitorClock = initialClock;
  for (const { at, entry, suspended } of samples) {
    const ticked = observeTick(clock, at, suspended ?? false);
    clock = ticked.clock;
    if (ticked.woke) contact = forgetFailures(contact);
    if (suspended === true) continue;
    contact = recordSample(contact, entry, at, clock);
  }
  return { contact, clock };
}

const every = (fromMin: number, toMin: number, entry: HostStatusEntry) =>
  Array.from({ length: toMin - fromMin + 1 }, (_, index) => ({
    at: (fromMin + index) * MIN,
    entry,
  }));

describe("host health", () => {
  it("needs three failures spread over five minutes before a host is Unreachable", () => {
    const quick = run([...every(0, 0, ok), ...every(1, 3, down)]);
    expect(quick.contact.failures).toBe(3);
    expect(isUnreachable(quick.contact, 3 * MIN)).toBe(false);

    const sustained = run([...every(0, 0, ok), ...every(1, 6, down)]);
    expect(isUnreachable(sustained.contact, 6 * MIN)).toBe(true);
    expect(isEvictable(sustained.contact, 6 * MIN)).toBe(false);
    expect(isEvictable(sustained.contact, 16 * MIN)).toBe(true);
    expect(
      deriveConditions({ contact: sustained.contact, scheduling: undefined, now: 6 * MIN }).map(
        (c) => c.type,
      ),
    ).toEqual(["Unreachable"]);
  });

  it("one answer ends the outage", () => {
    const back = run([...every(0, 10, down), ...every(11, 11, ok)]);
    expect(back.contact.failures).toBe(0);
    expect(
      isSchedulable(
        deriveConditions({ contact: back.contact, scheduling: undefined, now: 11 * MIN }),
      ),
    ).toBe(true);
  });

  it("never evicts across this machine's sleep: a Mac waking after an hour starts counting afresh", () => {
    // Asleep from minute 2 to 62: the gap in ticks marks a wake, and the failed contacts right
    // after it (SSH tunnels still reconnecting) fall in the grace window.
    const woke = run([...every(0, 2, down), ...every(62, 66, down), ...every(67, 67, ok)]);
    expect(woke.clock.wokeAt).toBe(62 * MIN);
    expect(woke.contact.failures).toBe(0);

    const stillDown = run([...every(0, 2, down), ...every(62, 66, down)]);
    expect(stillDown.contact.failures).toBe(0);
    expect(isUnreachable(stillDown.contact, 66 * MIN)).toBe(false);
    expect(isEvictable(stillDown.contact, 66 * MIN)).toBe(false);
  });

  it("ignores failures while the power monitor reports suspension", () => {
    const samples = [
      ...every(0, 0, ok),
      ...every(1, 20, down).map((sample) => ({ ...sample, suspended: true })),
    ];
    const { contact } = run(samples);
    expect(contact.failures).toBe(0);
    expect(isEvictable(contact, 20 * MIN)).toBe(false);
  });

  it("counts launch-watch outages only when they began after the wake grace and the last answer", () => {
    const clock: MonitorClock = { lastTickAt: 70 * MIN, quietUntil: 67 * MIN, wokeAt: 62 * MIN };
    const outage = (since: number, failures: number) => ({
      since,
      episode: 1,
      failures,
      notified: true,
      nextRetryAt: since,
      lastError: "unreachable",
    });
    expect(recordOutage(emptyContact, outage(30 * MIN, 5), clock).failures).toBe(0);
    const counted = recordOutage(emptyContact, outage(68 * MIN, 4), clock);
    expect(counted).toMatchObject({ failures: 4, firstFailureAt: 68 * MIN });
    const answered = { ...emptyContact, lastOkAt: 69 * MIN };
    expect(recordOutage(answered, outage(68 * MIN, 4), clock).failures).toBe(0);
  });

  it("derives cordon, drain, version and quota conditions; only some block placement", () => {
    const sample: HostStatusEntry = {
      ...ok,
      versionMismatch: true,
      message: "macmini runs GOAT 0",
      metrics: {
        quotas: [
          {
            instanceId: "codex",
            driver: "codex",
            fromCache: false,
            limits: {
              checkedAt: "2026-10-20T00:00:00.000Z",
              windows: [
                {
                  id: "primary",
                  kind: "session",
                  label: "5h",
                  usedPercent: 100,
                  resetsAt: "2099-01-01T00:00:00.000Z",
                },
              ],
            },
          },
        ],
      } as unknown as NonNullable<HostStatusEntry["metrics"]>,
    };
    const contact = { ...emptyContact, lastOkAt: 0, sample };
    const warnings = deriveConditions({ contact, scheduling: undefined, now: MIN });
    expect(warnings.map((c) => [c.type, c.instanceId])).toEqual([
      ["Ready", undefined],
      ["VersionMismatch", undefined],
      ["QuotaExhausted", "codex"],
    ]);
    expect(isSchedulable(warnings)).toBe(true);
    const drained = deriveConditions({
      contact,
      scheduling: { cordonedAt: 0, cordonReason: null, drainingAt: 0 },
      now: MIN,
    });
    expect(drained.map((c) => c.type)).toContain("Draining");
    expect(isSchedulable(drained)).toBe(false);
  });
});
