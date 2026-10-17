import { providerInstanceInitials } from "@goat/client-runtime/state/provider-instance-display";
import type { FleetMachine, FleetSnapshot, FleetThread } from "@goat/client-runtime/state/fleet";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { layoutFleet, type FleetLayoutMachine } from "./fleetLayout";

/** Animated particles are capped; further running work still shows in the counts. */
const MAX_PARTICLES = 24;
const PARTICLE_SECONDS = 2.6;

function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    return observeResize(element, (entries) => {
      setWidth(Math.round(entries.at(-1)!.contentRect.width));
    });
  }, []);
  return [ref, width] as const;
}

/** Pauses SMIL and CSS animation while the tab is hidden, without re-rendering. */
function usePauseWhileHidden(svg: React.RefObject<SVGSVGElement | null>) {
  useEffect(() => {
    const sync = () => {
      const element = svg.current;
      if (element === null) return;
      if (document.hidden) element.pauseAnimations();
      else element.unpauseAnimations();
      element.toggleAttribute("data-paused", document.hidden);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [svg]);
}

const truncate = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1) + "…" : text;

function workSummary(work: { running: number; attention: number; reported: number }): string {
  const parts = [
    work.running > 0 ? work.running + " running" : null,
    work.attention > 0 ? work.attention + " need you" : null,
    work.reported > 0 ? work.reported + " reported" : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "idle" : parts.join(", ");
}

export const FleetGraph = memo(function FleetGraph(props: {
  readonly snapshot: FleetSnapshot;
  readonly selectedMachineId: string | null;
  readonly onSelectMachine: (machineId: string) => void;
}) {
  const { snapshot, selectedMachineId, onSelectMachine } = props;
  const [wrapperRef, width] = useElementWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  usePauseWhileHidden(svgRef);
  const height = width < 640 ? 480 : Math.max(420, Math.min(560, Math.round(width * 0.5)));
  const layout = useMemo(
    () => (width > 0 ? layoutFleet(snapshot.machines, width, height) : null),
    [snapshot.machines, width, height],
  );
  const machinesById = useMemo(
    () => new Map(snapshot.machines.map((machine) => [machine.id, machine])),
    [snapshot.machines],
  );
  const nodesById = useMemo(
    () =>
      new Map(
        (layout?.machines ?? []).flatMap((node) =>
          node.id === null ? [] : [[node.id, node] as const],
        ),
      ),
    [layout],
  );
  const live = snapshot.totals.running + snapshot.totals.attention;

  return (
    <div ref={wrapperRef} className="fleet-graph w-full" style={{ minHeight: height }}>
      {layout === null ? null : (
        <svg
          ref={svgRef}
          viewBox={"0 0 " + width + " " + height}
          width={width}
          height={height}
          className="block select-none"
          role="group"
          aria-label={
            snapshot.totals.machines +
            " machines, " +
            snapshot.totals.running +
            " running, " +
            snapshot.totals.attention +
            " need you"
          }
        >
          <ellipse
            cx={layout.center.x}
            cy={layout.center.y}
            rx={layout.inner.rx}
            ry={layout.inner.ry}
            fill="none"
            className={cn("stroke-border", !reduced && "fleet-orbit")}
            strokeDasharray="2 6"
          />
          <ellipse
            cx={layout.center.x}
            cy={layout.center.y}
            rx={layout.outer.rx}
            ry={layout.outer.ry}
            fill="none"
            className={cn("stroke-border/60", !reduced && "fleet-orbit fleet-orbit-reverse")}
            strokeDasharray="1 9"
          />

          {layout.machines.map((node) => {
            const machine = node.id === null ? null : machinesById.get(node.id)!;
            const work = machine ?? node.aggregate!;
            const busy = work.running + work.attention > 0;
            return (
              <g key={"edge:" + (node.id ?? "more")}>
                <path
                  d={node.edge}
                  fill="none"
                  className={busy ? "stroke-info/40" : "stroke-border"}
                  strokeWidth={busy ? 1.6 : 1.2}
                  strokeDasharray={machine?.kind === "environment" || busy ? undefined : "3 5"}
                />
                {busy && !reduced ? (
                  <path
                    d={node.edge}
                    fill="none"
                    className="fleet-flow stroke-info"
                    strokeWidth={1.6}
                    strokeDasharray="2 12"
                  />
                ) : null}
                {node.agents.map((agentNode) => {
                  const agent = machine?.agents.find((entry) => entry.key === agentNode.key);
                  const agentWork = agent ?? agentNode.aggregate!;
                  const agentBusy = agentWork.running + agentWork.attention > 0;
                  return (
                    <line
                      key={"link:" + agentNode.key}
                      x1={node.x}
                      y1={node.y}
                      x2={agentNode.x}
                      y2={agentNode.y}
                      className={agentBusy ? "stroke-info/60" : "stroke-border"}
                      strokeDasharray={agentBusy ? undefined : "2 4"}
                    />
                  );
                })}
              </g>
            );
          })}

          {reduced
            ? null
            : snapshot.threads
                .filter((thread) => thread.state === "running")
                .slice(0, MAX_PARTICLES)
                .map((thread, index) => (
                  <Particle
                    key={thread.key}
                    thread={thread}
                    index={index}
                    node={nodesById.get(thread.machineId)}
                  />
                ))}

          {layout.machines.flatMap((node) =>
            node.agents.map((agentNode) => {
              const machine = node.id === null ? undefined : machinesById.get(node.id);
              const agent = machine?.agents.find((entry) => entry.key === agentNode.key);
              const work = agent ?? agentNode.aggregate!;
              const label = agent ? agent.label : agentNode.aggregate!.count + " more";
              const glyph = agent
                ? providerInstanceInitials(agent.label) || "?"
                : "+" + agentNode.aggregate!.count;
              const labelY = agentNode.labelBelow ? 28 : -22;
              return (
                <g
                  key={"agent:" + agentNode.key}
                  transform={"translate(" + agentNode.x + " " + agentNode.y + ")"}
                >
                  <title>{label + " · " + workSummary(work)}</title>
                  {work.attention > 0 ? (
                    <circle
                      r={20}
                      fill="none"
                      className={cn("stroke-warning", !reduced && "fleet-ring")}
                      strokeWidth={1.5}
                    />
                  ) : null}
                  <circle
                    r={13}
                    className={cn(
                      "fill-background",
                      work.attention > 0
                        ? "stroke-warning"
                        : work.running > 0
                          ? "stroke-info"
                          : "stroke-muted-foreground",
                    )}
                    strokeWidth={1.4}
                    strokeDasharray={
                      work.reported > 0 && work.running + work.attention === 0 ? "2 3" : undefined
                    }
                  />
                  <text
                    y={4}
                    textAnchor="middle"
                    className="fill-foreground text-3xs font-semibold"
                  >
                    {glyph}
                  </text>
                  <text y={labelY} textAnchor="middle" className="fill-muted-foreground text-3xs">
                    {truncate(label, 18)}
                  </text>
                </g>
              );
            }),
          )}

          {layout.machines.map((node) =>
            node.id === null ? (
              <AggregateNode key="machine:more" node={node} />
            ) : (
              <MachineNode
                key={"machine:" + node.id}
                node={node}
                machine={machinesById.get(node.id)!}
                selected={selectedMachineId === node.id}
                reduced={reduced}
                onSelect={onSelectMachine}
              />
            ),
          )}

          <g transform={"translate(" + layout.center.x + " " + layout.center.y + ")"}>
            {live > 0 && !reduced ? (
              <circle r={44} className="fleet-breathe fill-primary/10" />
            ) : null}
            <circle
              r={36}
              fill="none"
              className={cn("stroke-primary/50", !reduced && "fleet-spin")}
              strokeDasharray="3 7"
            />
            <circle r={27} className="fill-primary" />
            <text
              y={4}
              textAnchor="middle"
              className="fill-primary-foreground text-xs font-semibold"
            >
              GOAT
            </text>
          </g>
        </svg>
      )}
    </div>
  );
});

function Particle(props: {
  readonly thread: FleetThread;
  readonly index: number;
  readonly node: FleetLayoutMachine | undefined;
}) {
  const { node, index, thread } = props;
  if (node === undefined) return null;
  const agent = node.agents.find((entry) => entry.key === thread.agentKey);
  const path = node.edge + (agent ? " L" + agent.x + " " + agent.y : "");
  return (
    <g>
      {[0, 1, 2].map((step) => (
        <circle
          key={step}
          r={step === 0 ? 4 : 2.5}
          className="fill-info"
          opacity={step === 0 ? 1 : 0.5}
        >
          <animateMotion
            dur={PARTICLE_SECONDS + "s"}
            begin={-((index * 0.37 + step * (PARTICLE_SECONDS / 3)) % PARTICLE_SECONDS) + "s"}
            repeatCount="indefinite"
            path={path}
            keyPoints="0;1"
            keyTimes="0;1"
            calcMode="spline"
            keySplines="0.45 0 0.35 1"
          />
        </circle>
      ))}
    </g>
  );
}

function MachineNode(props: {
  readonly node: FleetLayoutMachine;
  readonly machine: FleetMachine;
  readonly selected: boolean;
  readonly reduced: boolean;
  readonly onSelect: (machineId: string) => void;
}) {
  const { node, machine, selected, reduced, onSelect } = props;
  const busy = machine.running + machine.attention;
  const select = () => onSelect(machine.id);
  const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    select();
  };
  const sub =
    machine.subtitle ??
    (machine.kind === "environment" ? null : machine.kind === "cloud" ? "cloud" : "ssh");
  return (
    <g
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={machine.label + ", " + workSummary(machine)}
      className="fleet-node cursor-pointer outline-none"
      onClick={select}
      onKeyDown={onKeyDown}
      transform={"translate(" + node.x + " " + node.y + ")"}
    >
      <title>{machine.label + " · " + workSummary(machine)}</title>
      {busy > 0 && !reduced ? <circle r={30} className="fleet-breathe fill-info/10" /> : null}
      <circle
        r={21}
        className={cn(
          "fleet-node-ring fill-background",
          selected
            ? "stroke-primary"
            : machine.attention > 0
              ? "stroke-warning"
              : busy > 0
                ? "stroke-info"
                : "stroke-muted-foreground/60",
        )}
        strokeWidth={selected ? 2.4 : 1.6}
      />
      <g
        transform="translate(-8 -8)"
        fill="none"
        className="stroke-foreground"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {machine.kind === "cloud" || machine.cloudState !== null ? (
          <path d="M4.5 12.5h7.2a3 3 0 0 0 .4-6 4.2 4.2 0 0 0-8.1 1.2A2.4 2.4 0 0 0 4.5 12.5z" />
        ) : (
          <>
            <rect x={1.5} y={2.5} width={13} height={8.5} rx={1.5} />
            <path d="M5.5 14h5M8 11v3" />
          </>
        )}
      </g>
      {busy > 0 ? (
        <g transform="translate(15 -15)">
          <circle r={8} className={machine.attention > 0 ? "fill-warning" : "fill-info"} />
          <text y={3.2} textAnchor="middle" className="fill-background text-4xs font-bold">
            {busy > 99 ? "99+" : busy}
          </text>
        </g>
      ) : null}
      <text y={36} textAnchor="middle" className="fill-foreground text-2xs font-medium">
        {truncate(machine.label, 18)}
      </text>
      {sub === null ? null : (
        <text y={48} textAnchor="middle" className="fill-muted-foreground text-4xs">
          {truncate(sub, 22)}
        </text>
      )}
    </g>
  );
}

function AggregateNode(props: { readonly node: FleetLayoutMachine }) {
  const { node } = props;
  const work = node.aggregate!;
  return (
    <g transform={"translate(" + node.x + " " + node.y + ")"}>
      <title>{work.count + " more machines · " + workSummary(work)}</title>
      <circle
        r={21}
        className="fill-background stroke-muted-foreground/60"
        strokeWidth={1.6}
        strokeDasharray="3 3"
      />
      <text y={4} textAnchor="middle" className="fill-foreground text-2xs font-semibold">
        {"+" + work.count}
      </text>
      <text y={36} textAnchor="middle" className="fill-muted-foreground text-3xs">
        {workSummary(work)}
      </text>
    </g>
  );
}
