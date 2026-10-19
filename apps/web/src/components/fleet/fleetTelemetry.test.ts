import type { FleetMachine } from "@goat/client-runtime/state/fleet";
import {
  EnvironmentId,
  type HostStatusEntry,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FleetConnection } from "./fleetConnection";
import {
  asLastKnown,
  fleetAlerts,
  fleetThroughput,
  hostSourceKey,
  hottestHost,
  matchHostRows,
  pushBounded,
  quotaRows,
  recordHostSamples,
  sparklinePath,
  type FleetHostRead,
  type ThroughputShell,
} from "./fleetTelemetry";

const studio = EnvironmentId.make("studio");
const mini = EnvironmentId.make("mini");
const NOW = Date.parse("2026-10-20T12:00:00.000Z");

function entry(
  host: string | null,
  options: {
    readonly cpu?: number | null;
    readonly cores?: number;
    readonly load?: number;
    readonly at?: number;
    readonly reachability?: HostStatusEntry["reachability"];
    readonly lastKnown?: true;
    readonly versionMismatch?: true;
    readonly quotas?: NonNullable<HostStatusEntry["metrics"]>["quotas"];
    readonly noMetrics?: boolean;
  } = {},
): HostStatusEntry {
  return {
    host,
    reachability: options.reachability ?? "ok",
    ...(options.lastKnown ? { lastKnown: true as const } : {}),
    ...(options.versionMismatch ? { versionMismatch: true as const, serverVersion: "0.1.0" } : {}),
    ...(options.noMetrics
      ? {}
      : {
          metrics: {
            sampledAt: options.at ?? NOW,
            cpuUtilization: options.cpu === undefined ? 0.2 : options.cpu,
            cpuCount: options.cores ?? 8,
            availableMemoryBytes: 4,
            totalMemoryBytes: 16,
            loadAvg: { oneMinute: options.load ?? 1, fiveMinutes: 1, fifteenMinutes: 1 },
            disk: null,
            threads: { running: 0, waiting: 0, queued: 0 },
            quotas: options.quotas ?? [],
          },
        }),
  };
}

function machine(id: string, overrides: Partial<FleetMachine> = {}): FleetMachine {
  return {
    id,
    label: id,
    subtitle: null,
    kind: "environment",
    os: null,
    machineKind: null,
    environmentId: null,
    reachedVia: null,
    cloudState: null,
    running: 0,
    attention: 0,
    reported: 0,
    agents: [],
    ...overrides,
  };
}

describe("pushBounded", () => {
  it("keeps only the newest items up to capacity", () => {
    let list: ReadonlyArray<number> = [];
    for (let value = 1; value <= 5; value++) list = pushBounded(list, value, 3);
    expect(list).toEqual([3, 4, 5]);
    expect(pushBounded([1], 2, 0)).toEqual([]);
  });
});

describe("recordHostSamples", () => {
  const read = (at: number, cpu = 0.5): FleetHostRead => ({
    environmentId: studio,
    hosts: [entry(null, { at, cpu })],
  });

  it("appends a new sample once and ignores a repeated sampledAt", () => {
    const first = recordHostSamples(new Map(), [read(NOW)], NOW);
    expect(first.get(hostSourceKey(studio, null))).toEqual([
      { at: NOW, seenAt: NOW, cpu: 50, memory: 75, load: 1 },
    ]);
    expect(recordHostSamples(first, [read(NOW)], NOW)).toBe(first);
    const second = recordHostSamples(first, [read(NOW + 15_000, 0.9)], NOW + 15_000);
    expect(second.get(hostSourceKey(studio, null))!.map((sample) => sample.cpu)).toEqual([50, 90]);
  });

  it("stays bounded and expires samples older than ten minutes", () => {
    let history = recordHostSamples(new Map(), [read(NOW)], NOW, 3);
    for (let step = 1; step <= 4; step++) {
      history = recordHostSamples(history, [read(NOW + step * 15_000)], NOW + step * 15_000, 3);
    }
    expect(history.get(hostSourceKey(studio, null))).toHaveLength(3);
    const later = NOW + 12 * 60_000;
    expect(recordHostSamples(history, [], later).size).toBe(0);
  });
});

describe("recordHostSamples with host clocks that disagree", () => {
  it("keeps and expires samples by this client's clock, and skips last-known metrics", () => {
    const behind = NOW - 30 * 60_000;
    const history = recordHostSamples(
      new Map(),
      [
        {
          environmentId: studio,
          hosts: [
            entry(null, { at: behind }),
            entry("gone", { at: behind, reachability: "unreachable", lastKnown: true }),
          ],
        },
      ],
      NOW,
    );
    expect(history.get(hostSourceKey(studio, null))).toHaveLength(1);
    expect(history.has(hostSourceKey(studio, "gone"))).toBe(false);
    expect(recordHostSamples(history, [], NOW + 11 * 60_000).size).toBe(0);
  });

  it("times a lost host from when this client last saw it answer", () => {
    const ahead = NOW + 60 * 60_000;
    const seen = recordHostSamples(
      new Map(),
      [{ environmentId: studio, hosts: [entry("box", { at: ahead })] }],
      NOW,
    );
    const rows = matchHostRows({
      machines: [],
      aliasesByEnvironment: new Map(),
      reads: [
        {
          environmentId: studio,
          hosts: [entry("box", { at: ahead, reachability: "unreachable", lastKnown: true })],
        },
      ],
      primaryEnvironmentId: studio,
    });
    expect(
      fleetAlerts(rows, new Map(), NOW + 5 * 60_000, { history: seen }).map(
        (alert) => alert.detail,
      ),
    ).toEqual(["Unreachable, last known 5m ago"]);
  });
});

describe("asLastKnown", () => {
  it("turns a failed refresh's cached answer into last-known hosts, once per answer", () => {
    const cached = [
      entry(null),
      entry("ancient", { reachability: "unsupported", noMetrics: true }),
    ];
    const stale = asLastKnown(cached);
    expect(stale.map((host) => [host.reachability, host.lastKnown])).toEqual([
      ["unreachable", true],
      ["unsupported", undefined],
    ]);
    expect(asLastKnown(cached)).toBe(stale);
  });
});

describe("matchHostRows", () => {
  const aliases = new Map([[mini, ["macmini"]]]);

  it("prefers an environment's own answer and does not list its alias entry again", () => {
    const rows = matchHostRows({
      machines: [
        machine("studio", { environmentId: studio }),
        machine("mini", { environmentId: mini }),
      ],
      aliasesByEnvironment: aliases,
      reads: [
        { environmentId: studio, hosts: [entry(null), entry("macmini", { cpu: 0.1 })] },
        { environmentId: mini, hosts: [entry(null, { cpu: 0.9 })] },
      ],
      primaryEnvironmentId: studio,
    });
    expect(rows.map((row) => [row.label, row.sourceKey])).toEqual([
      ["studio", hostSourceKey(studio, null)],
      ["mini", hostSourceKey(mini, null)],
    ]);
  });

  it("falls back to the alias entry, matches SSH hosts by dispatcher, and never guesses", () => {
    const rows = matchHostRows({
      machines: [
        machine("mini", { environmentId: mini }),
        machine("box", {
          kind: "ssh",
          reachedVia: { dispatcherEnvironmentId: studio, alias: "box" },
        }),
        // Same alias, reported by a dispatcher with no read: no metrics, not studio's box.
        machine("other-box", {
          label: "box",
          kind: "ssh",
          reachedVia: { dispatcherEnvironmentId: mini, alias: "box" },
        }),
        machine("cloud", { kind: "cloud", label: "Cloud dev" }),
      ],
      aliasesByEnvironment: aliases,
      reads: [
        {
          environmentId: studio,
          hosts: [entry(null), entry("macmini"), entry("box"), entry("lidge-ai")],
        },
      ],
      primaryEnvironmentId: studio,
    });
    expect(rows.map((row) => [row.key, row.sourceKey, row.tone])).toEqual([
      ["mini", hostSourceKey(studio, "macmini"), "ok"],
      ["box", hostSourceKey(studio, "box"), "ok"],
      ["other-box", null, "none"],
      ["cloud", null, "none"],
      [hostSourceKey(studio, "lidge-ai"), hostSourceKey(studio, "lidge-ai"), "ok"],
    ]);
  });

  it("prefers an alias that answers over one that does not", () => {
    const rows = matchHostRows({
      machines: [machine("mini", { environmentId: mini })],
      aliasesByEnvironment: new Map([[mini, ["old-mini", "macmini"]]]),
      reads: [
        {
          environmentId: studio,
          hosts: [
            entry("old-mini", { reachability: "unreachable", lastKnown: true }),
            entry("macmini"),
          ],
        },
      ],
      primaryEnvironmentId: studio,
    });
    expect(rows.map((row) => [row.sourceKey, row.tone])).toEqual([
      [hostSourceKey(studio, "macmini"), "ok"],
    ]);
  });

  it("keeps another dispatcher's host that shares an alias with a connected environment", () => {
    const other = EnvironmentId.make("other");
    const rows = matchHostRows({
      machines: [machine("mini", { environmentId: mini })],
      aliasesByEnvironment: aliases,
      reads: [
        { environmentId: studio, hosts: [entry("macmini")] },
        { environmentId: other, hosts: [entry(null), entry("macmini", { cpu: 0.7 })] },
      ],
      primaryEnvironmentId: studio,
    });
    expect(rows.map((row) => row.sourceKey)).toEqual([
      hostSourceKey(studio, "macmini"),
      hostSourceKey(other, "macmini"),
    ]);
  });
});

describe("hottestHost", () => {
  it("picks the busiest reachable host, using load per core when CPU is unknown", () => {
    const rows = matchHostRows({
      machines: [],
      aliasesByEnvironment: new Map(),
      reads: [
        {
          environmentId: studio,
          hosts: [
            entry("a", { cpu: 0.4 }),
            entry("b", { cpu: null, load: 7.6, cores: 8 }),
            entry("c", { cpu: 0.99, reachability: "unreachable", lastKnown: true }),
          ],
        },
      ],
      primaryEnvironmentId: studio,
    });
    const hottest = hottestHost(rows);
    expect(hottest?.row.label).toBe("b");
    expect(hottest?.loadPerCore).toBeCloseTo(0.95);
    expect(hottestHost([])).toBeNull();
  });
});

describe("fleetAlerts", () => {
  it("reports down connections, stale hosts and version drift, most severe first", () => {
    const rows = matchHostRows({
      machines: [
        machine("studio", { environmentId: studio }),
        machine("mini", { environmentId: mini }),
      ],
      aliasesByEnvironment: new Map([[mini, ["macmini"]]]),
      reads: [
        {
          environmentId: studio,
          hosts: [
            entry(null),
            entry("macmini", {
              reachability: "unreachable",
              lastKnown: true,
              at: NOW - 4 * 60_000,
            }),
            entry("box", { reachability: "unreachable", lastKnown: true, at: NOW - 4 * 60_000 }),
            entry("old", { versionMismatch: true }),
            entry("ancient", { reachability: "unsupported", noMetrics: true }),
          ],
        },
      ],
      primaryEnvironmentId: studio,
    });
    const connections = new Map<string, FleetConnection>([
      ["studio", { state: "connected", label: "Connected", reason: null }],
      ["mini", { state: "attention", label: "Needs attention", reason: "Tailscale is off" }],
    ]);
    expect(
      fleetAlerts(rows, connections, NOW, { unreadable: [{ key: "remote", label: "remote" }] }).map(
        (alert) => [alert.label, alert.tone, alert.detail],
      ),
    ).toEqual([
      ["mini", "destructive", "Tailscale is off"],
      ["remote", "warning", "Could not read host status"],
      ["box", "warning", "Unreachable, last known 4m ago"],
      ["old", "warning", "Runs GOAT 0.1.0"],
      ["ancient", "muted", "Update GOAT to report status"],
    ]);
  });
});

describe("fleetThroughput", () => {
  const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  function shell(
    options: {
      readonly started?: number | null;
      readonly completed?: number | null;
      readonly environmentId?: EnvironmentId;
      readonly subagent?: boolean;
      readonly noRun?: boolean;
    } = {},
  ): ThroughputShell {
    const id = ThreadId.make("t");
    return {
      environmentId: options.environmentId ?? studio,
      archivedAt: null,
      deletedAt: null,
      sideChatOf: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: options.subagent ? "subagent" : null,
        rootThreadId: id,
      },
      latestRun: options.noRun
        ? null
        : {
            runId: RunId.make("r"),
            status:
              options.completed === undefined || options.completed === null
                ? "running"
                : "completed",
            requestedAt: null,
            startedAt:
              options.started === null || options.started === undefined
                ? null
                : minutesAgo(options.started),
            completedAt:
              options.completed === null || options.completed === undefined
                ? null
                : minutesAgo(options.completed),
            assistantMessageId: null,
          },
    };
  }

  it("counts latest runs that started and finished in the last hour, in five-minute buckets", () => {
    const result = fleetThroughput(
      [
        shell({ started: 2 }),
        shell({ started: 40, completed: 3 }),
        shell({ started: 90, completed: 70 }),
        shell({ started: 1, subagent: true }),
        shell({ started: 1, environmentId: mini }),
        shell({ noRun: true }),
      ],
      new Set([studio]),
      NOW,
    );
    expect(result.started).toBe(2);
    expect(result.finished).toBe(1);
    expect(result.startedBuckets).toHaveLength(12);
    expect(result.startedBuckets[11]).toBe(1);
    expect(result.startedBuckets[4]).toBe(1);
    expect(result.finishedBuckets[11]).toBe(1);
  });

  it("lets runs age out of the window with no new shell updates", () => {
    const shells = [shell({ started: 40, completed: 3 })];
    expect(fleetThroughput(shells, new Set([studio]), NOW).finished).toBe(1);
    const later = fleetThroughput(shells, new Set([studio]), NOW + 58 * 60_000);
    expect([later.started, later.finished]).toEqual([0, 0]);
  });
});

describe("quotaRows", () => {
  const quota = (
    instanceId: string,
    used: ReadonlyArray<number>,
    options: { readonly fingerprint?: string; readonly checkedAt?: string } = {},
  ) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    fromCache: false,
    limits: {
      checkedAt: options.checkedAt ?? "2026-10-20T11:00:00.000Z",
      windows: used.map((usedPercent, index) => ({
        id: "w" + index,
        kind: "weekly" as const,
        label: "Window " + index,
        usedPercent,
      })),
      ...(options.fingerprint ? { credentialFingerprint: options.fingerprint } : {}),
    },
  });

  it("merges accounts only by fingerprint and sorts by the fullest window", () => {
    const rows = matchHostRows({
      machines: [],
      aliasesByEnvironment: new Map(),
      reads: [
        {
          environmentId: studio,
          hosts: [
            entry("a", { quotas: [quota("codex", [10, 30, 5], { fingerprint: "acct" })] }),
            entry("b", {
              quotas: [
                quota("codex", [12, 40], {
                  fingerprint: "acct",
                  checkedAt: "2026-10-20T11:30:00.000Z",
                }),
              ],
            }),
            entry("c", { quotas: [quota("codex", [80])] }),
          ],
        },
      ],
      primaryEnvironmentId: studio,
    });
    expect(quotaRows(rows).map((row) => [row.host, row.windows.map((w) => w.usedPercent)])).toEqual(
      [
        ["c", [80]],
        [null, [40, 12]],
      ],
    );
  });
});

describe("sparklinePath", () => {
  it("draws one path, breaks on gaps, and right-aligns a short series", () => {
    expect(sparklinePath([0, 100], 100, 10, 100, 3)).toBe("M50 10L100 0");
    expect(sparklinePath([50, null, 50], 100, 10, 100, 3)).toBe("M0 5M100 5");
    expect(sparklinePath([50], 100, 10, 100, 3)).toBe("M50 5L100 5");
    expect(sparklinePath([], 100, 10, 100)).toBe("");
  });
});
