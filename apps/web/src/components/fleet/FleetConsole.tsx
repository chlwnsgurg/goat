import { useAtomValue } from "@effect/atom-react";
import type { FleetSnapshot } from "@goat/client-runtime/state/fleet";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { memo, useEffect, useRef } from "react";

import { ChevronDownIcon } from "~/components/solar";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { fleetEnvironmentsAtom, fleetPageEnvironmentsAtom } from "~/state/fleet";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentThreadShells } from "~/state/threads";
import { useUiStateStore } from "~/uiStateStore";

import { formatElapsedDurationLabel } from "~/timestampFormat";

import { platformLabel } from "../settings/hostStatusView";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { FleetConnection } from "./fleetConnection";
import { fleetConsoleFrameClassName } from "./fleetConsoleFrame";
import { FleetHostStatusRefresh, useFleetHostStatus } from "./fleetHostStatus";
import {
  fleetAlerts,
  fleetThroughput,
  hottestHost,
  matchHostRows,
  quotaRows,
  sparklinePath,
  throughputEqual,
  THROUGHPUT_BUCKETS,
  type FleetAlertTone,
  type FleetHostRow,
  type FleetThroughput,
  type HostSample,
} from "./fleetTelemetry";

/**
 * Runs in the last hour. Shell updates stream constantly, so the atom keeps its previous value
 * until a count changes and the console renders only then. The window is anchored when shells
 * change; a quiet fleet keeps the counts it last showed.
 */
const fleetThroughputAtom = Atom.make((get): FleetThroughput => {
  const connected = new Set(get(fleetEnvironmentsAtom).map((env) => env.environmentId));
  const next = fleetThroughput(
    get(environmentThreadShells.threadShellsAtom),
    connected,
    Date.now(),
  );
  const previous = Option.getOrNull(get.self<FleetThroughput>());
  return previous !== null && throughputEqual(previous, next) ? previous : next;
}).pipe(Atom.withLabel("fleet-throughput"));

const Label = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span
    className={cn("font-mono text-3xs uppercase tracking-widest text-muted-foreground", className)}
  >
    {children}
  </span>
);

const usageTone = (value: number | null) =>
  value === null ? "muted" : value >= 90 ? "destructive" : value >= 70 ? "warning" : "normal";

const TONE_TEXT = {
  normal: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const;

const TONE_BAR = {
  normal: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
} as const;

const ALERT_DOT: Record<FleetAlertTone, string> = {
  destructive: "bg-destructive",
  warning: "bg-warning",
  muted: "border border-muted-foreground",
};

/** One series as one path. Re-renders only when a host gets a new sample. */
const Sparkline = memo(function Sparkline(props: {
  readonly samples: ReadonlyArray<HostSample>;
  readonly field: "cpu" | "memory" | "load";
  readonly max: number;
  readonly tone: keyof typeof TONE_TEXT;
}) {
  const path = sparklinePath(
    props.samples.map((sample) => sample[props.field]),
    100,
    16,
    props.max,
  );
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 16"
      preserveAspectRatio="none"
      className={cn(
        "h-4 min-w-0 flex-1 overflow-visible",
        props.tone === "normal" ? "text-primary" : TONE_TEXT[props.tone],
      )}
    >
      <line x1="0" x2="100" y1="15.5" y2="15.5" className="fleet-console-baseline" />
      <path d={path} className="fleet-console-spark" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});

const NO_SAMPLES: ReadonlyArray<HostSample> = [];

function formatPercent(value: number | null) {
  return value === null ? "–" : Math.round(value) + "%";
}

/** "macmini · macOS · 10 cores", with how old the numbers are when the host stopped answering. */
function hostDetail(row: FleetHostRow, now: number): string {
  const metrics = row.entry?.metrics;
  const parts = [row.label, platformLabel(metrics?.platform)];
  if (metrics !== undefined)
    parts.push(metrics.cpuCount + (metrics.cpuCount === 1 ? " core" : " cores"));
  if (row.tone === "stale" && metrics !== undefined) {
    const age = formatElapsedDurationLabel(new Date(metrics.sampledAt).toISOString(), now);
    parts.push(age === "just now" ? "last known just now" : "last known " + age + " ago");
  }
  if (row.tone === "none") parts.push("no host status describes this machine");
  return parts.filter((part) => part !== null).join(" · ");
}

function HostRow({
  row,
  samples,
  sampledAt,
}: {
  readonly row: FleetHostRow;
  readonly samples: ReadonlyArray<HostSample>;
  readonly sampledAt: number;
}) {
  const metrics = row.entry?.metrics;
  const stale = row.tone === "stale";
  const statusText =
    row.tone === "none"
      ? "No metrics"
      : row.tone === "unsupported"
        ? "Update GOAT to report"
        : metrics === undefined
          ? "Unreachable"
          : null;
  const cpu = metrics?.cpuUtilization == null ? null : metrics.cpuUtilization * 100;
  const memory =
    metrics === undefined || metrics.totalMemoryBytes <= 0
      ? null
      : (1 - metrics.availableMemoryBytes / metrics.totalMemoryBytes) * 100;
  const load = metrics?.loadAvg?.oneMinute ?? null;
  const cores = metrics?.cpuCount ?? 1;
  const loadMax = Math.max(cores, ...samples.map((sample) => sample.load ?? 0));
  const loadTone = load === null ? "muted" : usageTone((load / cores) * 100);
  return (
    <li className="grid h-7 grid-cols-[minmax(0,6.5rem)_repeat(3,minmax(0,1fr))] items-center gap-3">
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            row.tone === "ok"
              ? "bg-success"
              : row.tone === "stale" || row.tone === "unreachable"
                ? "bg-warning"
                : "border border-muted-foreground",
          )}
        />
        <Tooltip>
          <TooltipTrigger
            render={<span className="truncate font-medium outline-hidden" tabIndex={0} />}
          >
            {row.label}
          </TooltipTrigger>
          <TooltipPopup side="top">{hostDetail(row, sampledAt)}</TooltipPopup>
        </Tooltip>
      </span>
      {statusText !== null ? (
        <span className="col-span-3 font-mono text-2xs text-muted-foreground">{statusText}</span>
      ) : (
        <>
          <MetricCell
            value={formatPercent(cpu)}
            tone={usageTone(cpu)}
            stale={stale}
            samples={samples}
            field="cpu"
            max={100}
          />
          <MetricCell
            value={formatPercent(memory)}
            tone={usageTone(memory)}
            stale={stale}
            samples={samples}
            field="memory"
            max={100}
          />
          <MetricCell
            value={load === null ? "–" : load.toFixed(load >= 10 ? 0 : 1)}
            tone={loadTone}
            stale={stale}
            samples={samples}
            field="load"
            max={loadMax}
          />
        </>
      )}
    </li>
  );
}

function MetricCell(props: {
  readonly value: string;
  readonly tone: keyof typeof TONE_TEXT;
  readonly stale: boolean;
  readonly samples: ReadonlyArray<HostSample>;
  readonly field: "cpu" | "memory" | "load";
  readonly max: number;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", props.stale && "opacity-55")}>
      <Sparkline samples={props.samples} field={props.field} max={props.max} tone={props.tone} />
      <span
        className={cn(
          "w-9 shrink-0 text-right font-mono text-xs tabular-nums",
          TONE_TEXT[props.tone === "muted" ? "muted" : props.tone],
        )}
      >
        {props.value}
      </span>
    </span>
  );
}

/** Started runs rise above the line, finished ones hang below: one path each. */
const ThroughputBars = memo(function ThroughputBars({
  throughput,
}: {
  readonly throughput: FleetThroughput;
}) {
  const width = 120;
  const half = 14;
  const slot = width / THROUGHPUT_BUCKETS;
  const peak = Math.max(1, ...throughput.startedBuckets, ...throughput.finishedBuckets);
  const bars = (counts: ReadonlyArray<number>, direction: 1 | -1) =>
    counts
      .map((count, index) => {
        if (count === 0) return "";
        const height = Math.max(1.5, (count / peak) * (half - 1));
        const x = (index * slot + 1).toFixed(2);
        const y = direction === 1 ? half - height : half + 1;
        return (
          "M" +
          x +
          " " +
          y.toFixed(2) +
          "h" +
          (slot - 2).toFixed(2) +
          "v" +
          height.toFixed(2) +
          "h-" +
          (slot - 2).toFixed(2) +
          "Z"
        );
      })
      .join("");
  return (
    <svg
      aria-hidden
      viewBox={"0 0 " + width + " " + (half * 2 + 1)}
      preserveAspectRatio="none"
      className="h-7 w-full"
    >
      <line x1="0" x2={width} y1={half + 0.5} y2={half + 0.5} className="fleet-console-baseline" />
      <path d={bars(throughput.startedBuckets, 1)} className="fill-info" />
      <path d={bars(throughput.finishedBuckets, -1)} className="fill-success" />
    </svg>
  );
});

function Stat(props: { readonly label: string; readonly value: number; readonly dot: string }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", props.dot)} />
      <Label>{props.label}</Label>
      <span aria-hidden className="fleet-console-leader" />
      <span className="font-mono text-lg leading-none tabular-nums">{props.value}</span>
    </div>
  );
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function FleetConsoleExpanded(props: {
  readonly snapshot: FleetSnapshot;
  readonly connections: ReadonlyMap<string, FleetConnection>;
  readonly reduced: boolean;
  readonly onCollapse: () => void;
}) {
  const { snapshot, connections, reduced } = props;
  const status = useFleetHostStatus();
  const environments = useAtomValue(fleetPageEnvironmentsAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const throughput = useAtomValue(fleetThroughputAtom);
  const rows = matchHostRows({
    machines: snapshot.machines,
    aliasesByEnvironment: new Map(
      environments.map((env) => [env.environmentId, env.sshAliases] as const),
    ),
    reads: status.reads,
    primaryEnvironmentId,
  });
  const alerts = fleetAlerts(rows, connections, status.sampledAt);
  const hottest = hottestHost(rows);
  const quotas = quotaRows(rows).slice(0, 3);
  const { totals } = snapshot;
  const reporting = rows.filter((row) => row.tone === "ok").length;

  return (
    <>
      <ConsoleHeader collapsed={false} onToggle={props.onCollapse}>
        {hottest === null ? null : (
          <span className="hidden min-w-0 items-baseline gap-1.5 sm:flex">
            <Label>Hottest</Label>
            <span className="truncate text-xs font-medium">{hottest.row.label}</span>
            <span
              className={cn("font-mono text-xs tabular-nums", TONE_TEXT[usageTone(hottest.cpu)])}
            >
              {hottest.cpu === null
                ? hottest.loadPerCore!.toFixed(1) + "/core"
                : Math.round(hottest.cpu) + "%"}
            </span>
          </span>
        )}
        {status.sampledAt > 0 ? (
          <span className="hidden items-baseline gap-1.5 md:flex">
            <Label>Sampled</Label>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {clock.format(status.sampledAt)}
            </span>
          </span>
        ) : null}
      </ConsoleHeader>
      <div className="grid h-[calc(100%-2.5rem)] auto-rows-max grid-cols-1 overflow-y-auto md:auto-rows-[minmax(0,1fr)] md:grid-cols-[12.5rem_minmax(0,1fr)_16rem] md:overflow-hidden">
        {status.sources.map((environmentId) => (
          <FleetHostStatusRefresh key={environmentId} environmentId={environmentId} />
        ))}
        {reduced || status.sampledAt === 0 ? null : (
          // Restarts once per new sample; nothing runs between samples.
          <span key={status.sampledAt} aria-hidden className="fleet-console-sweep" />
        )}

        <section
          aria-label="Threads"
          className="flex flex-col gap-3 border-b p-3 md:border-r md:border-b-0"
        >
          <div className="flex flex-col gap-2">
            <Stat label="Running" value={totals.running} dot="bg-info" />
            <Stat label="Need you" value={totals.attention} dot="bg-warning" />
            <Stat label="Reported" value={totals.reported} dot="border border-muted-foreground" />
          </div>
          <div className="mt-auto flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 whitespace-nowrap">
              <Label>1h</Label>
              <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                <span className="text-info">{throughput.started}</span> started ·{" "}
                <span className="text-success">{throughput.finished}</span> done
              </span>
            </div>
            <ThroughputBars throughput={throughput} />
          </div>
        </section>

        <section
          aria-label="Hosts"
          className="flex min-h-0 flex-col border-b p-3 md:border-r md:border-b-0"
        >
          <div className="mb-1 grid grid-cols-[minmax(0,6.5rem)_repeat(3,minmax(0,1fr))] gap-3">
            <Label>
              Hosts {reporting}/{rows.length}
            </Label>
            <Label>CPU</Label>
            <Label>Mem</Label>
            <Label>Load 1m</Label>
          </div>
          {rows.length === 0 && status.loading ? (
            <p className="font-mono text-2xs text-muted-foreground">Reading hosts…</p>
          ) : (
            <ul className="flex min-h-0 flex-col md:overflow-y-auto">
              {rows.map((row) => (
                <HostRow
                  key={row.key}
                  row={row}
                  sampledAt={status.sampledAt}
                  samples={
                    (row.sourceKey === null ? undefined : status.history.get(row.sourceKey)) ??
                    NO_SAMPLES
                  }
                />
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Status" className="flex min-h-0 flex-col gap-3 p-3 md:overflow-y-auto">
          {quotas.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label>Quota</Label>
              {quotas.map((quota) => (
                <div key={quota.key} className="flex flex-col gap-0.5">
                  <span className="flex items-baseline gap-2 text-xs">
                    <span className="truncate">
                      {quota.label}
                      {quota.host === null ? null : (
                        <span className="text-muted-foreground"> · {quota.host}</span>
                      )}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
                      {quota.windows
                        .map((window) => window.label + " " + Math.round(window.usedPercent) + "%")
                        .join(" · ")}
                    </span>
                  </span>
                  <span
                    className="h-1 overflow-hidden rounded-full bg-muted"
                    role="meter"
                    aria-label={quota.label + " quota used"}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(quota.peak)}
                  >
                    <span
                      className={cn("block h-full rounded-full", TONE_BAR[usageTone(quota.peak)])}
                      style={{ width: Math.max(2, quota.peak) + "%" }}
                    />
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label>Alerts {alerts.length > 0 ? alerts.length : null}</Label>
            {alerts.length === 0 ? (
              <span className="font-mono text-2xs text-muted-foreground">All clear</span>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {alerts.slice(0, 3).map((alert) => (
                  <li key={alert.key} className="flex min-w-0 items-center gap-1.5 text-xs">
                    <span
                      aria-hidden
                      className={cn("size-1.5 shrink-0 rounded-full", ALERT_DOT[alert.tone])}
                    />
                    <span className="shrink-0 font-medium">{alert.label}</span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            className="truncate text-muted-foreground outline-hidden"
                            tabIndex={0}
                          />
                        }
                      >
                        {alert.detail}
                      </TooltipTrigger>
                      <TooltipPopup side="top">{alert.detail}</TooltipPopup>
                    </Tooltip>
                  </li>
                ))}
                {alerts.length > 3 ? (
                  <li className="font-mono text-2xs text-muted-foreground">
                    +{alerts.length - 3} more
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function ConsoleHeader(props: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly children?: React.ReactNode;
}) {
  return (
    <header className={cn("flex h-10 items-center gap-4 px-3", !props.collapsed && "border-b")}>
      <span className="flex shrink-0 items-center gap-2">
        <span aria-hidden className="fleet-console-mark" />
        <h2 className="font-mono text-2xs uppercase tracking-widest text-muted-foreground">
          Fleet telemetry
        </h2>
      </span>
      {props.children}
      <Button
        size="icon-xs"
        variant="ghost-muted"
        className="ml-auto shrink-0"
        aria-expanded={!props.collapsed}
        aria-label={props.collapsed ? "Expand fleet telemetry" : "Collapse fleet telemetry"}
        onClick={props.onToggle}
      >
        <ChevronDownIcon className={cn("size-3.5", !props.collapsed && "rotate-180")} />
      </Button>
    </header>
  );
}

/**
 * Live fleet analytics above the graph. Collapsing unmounts the body, which stops its host
 * reads and its sweep; the frame keeps the same height as the placeholder that preceded it.
 */
export default function FleetConsole(props: {
  readonly snapshot: FleetSnapshot;
  readonly connections: ReadonlyMap<string, FleetConnection>;
}) {
  const collapsed = useUiStateStore((state) => state.fleetConsoleCollapsed);
  const setCollapsed = useUiStateStore((state) => state.setFleetConsoleCollapsed);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const frameRef = useRef<HTMLElement>(null);
  useEffect(() => observeVisibleAnimation(frameRef.current), []);
  const { totals } = props.snapshot;

  return (
    <section
      ref={frameRef}
      aria-label="Fleet telemetry"
      data-collapsed={collapsed || undefined}
      className={fleetConsoleFrameClassName(collapsed)}
    >
      <span aria-hidden className="fleet-console-corners" />
      {collapsed ? (
        <ConsoleHeader collapsed onToggle={() => setCollapsed(false)}>
          <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">
            <span className="text-foreground">{totals.running}</span> running ·{" "}
            <span className="text-foreground">{totals.attention}</span> need you ·{" "}
            <span className="text-foreground">{totals.reported}</span> reported
          </span>
        </ConsoleHeader>
      ) : (
        <FleetConsoleExpanded
          snapshot={props.snapshot}
          connections={props.connections}
          reduced={reduced}
          onCollapse={() => setCollapsed(true)}
        />
      )}
    </section>
  );
}
