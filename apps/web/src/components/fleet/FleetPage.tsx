import type { FleetMachine, FleetThread } from "@goat/client-runtime/state/fleet";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useFleetSnapshot } from "../../state/fleet";
import { buildThreadRouteParams } from "../../threadRoutes";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsIcon } from "~/components/solar";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ConnectionCatalogUnreadableAlert } from "../desktop/ConnectionCatalogUnreadableNotice";
import { ConnectionEnvironmentsSection } from "../settings/ConnectionEnvironmentsSection";
import { FleetGraph } from "./FleetGraph";
import { describeMachine } from "./describeMachine";
import { fleetConnectionLegend, UNKNOWN_FLEET_CONNECTION } from "./fleetConnection";
import { FleetConnectionIcon } from "./FleetConnectionGlyph";

const STATE_LABEL: Record<FleetThread["state"], string> = {
  running: "Running",
  attention: "Needs you",
  reported: "Reported",
};

const STATE_DOT: Record<FleetThread["state"], string> = {
  running: "bg-info",
  attention: "bg-warning",
  reported: "border border-muted-foreground bg-transparent",
};

const plural = (count: number, one: string, many = one + "s") =>
  count + " " + (count === 1 ? one : many);

function machineWork(machine: FleetMachine): string {
  const parts = [
    machine.running > 0 ? machine.running + " running" : null,
    machine.attention > 0 ? machine.attention + " need you" : null,
    machine.reported > 0 ? machine.reported + " reported" : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Idle" : parts.join(" · ");
}

const isBusy = (machine: FleetMachine) =>
  machine.running + machine.attention + machine.reported > 0;

const machineSubtitle = (machine: FleetMachine) =>
  [describeMachine(machine.os, machine.machineKind), machine.subtitle]
    .filter((part) => part !== null)
    .join(" · ");

function groupThreadsByMachine(threads: ReadonlyArray<FleetThread>) {
  const grouped = new Map<string, FleetThread[]>();
  for (const thread of threads) {
    const list = grouped.get(thread.machineId) ?? [];
    list.push(thread);
    grouped.set(thread.machineId, list);
  }
  return grouped;
}

/** Everything running across connected machines, as a graph and a list grouped by machine. */
export function FleetPage() {
  const { snapshot, connections, currentMachineId, loading } = useFleetSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  const selectedMachine = snapshot.machines.find((machine) => machine.id === selected) ?? null;
  const toggleMachine = (machineId: string) =>
    setSelected((current) => (current === machineId ? null : machineId));
  const threadsByMachine = groupThreadsByMachine(snapshot.threads);
  const listed = (selectedMachine ? [selectedMachine] : snapshot.machines).filter(isBusy);
  // A host that is away or blocked is not idle; its row in Connections says why.
  const reachable = (machine: FleetMachine) => {
    const { state } = connections.get(machine.id) ?? UNKNOWN_FLEET_CONNECTION;
    return state === "connected" || state === "unknown";
  };
  const idle = selectedMachine
    ? []
    : snapshot.machines.filter((machine) => !isBusy(machine) && reachable(machine));
  const connectionLegend = fleetConnectionLegend(connections.values());
  const { totals } = snapshot;

  return (
    <SidebarInset>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
        <WorkspacePageHeader electron={isElectron}>
          <h1>Fleet</h1>
        </WorkspacePageHeader>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded">
            <p className="text-sm text-muted-foreground" role="status">
              {totals.running + totals.attention === 0
                ? "Nothing running on " + plural(totals.machines, "machine") + "."
                : plural(totals.running, "thread") +
                  " running, " +
                  totals.attention +
                  " need you, on " +
                  plural(totals.machines, "machine") +
                  "."}
              {totals.reported > 0
                ? " " +
                  plural(totals.reported, "launch", "launches") +
                  " on SSH hosts as last reported."
                : null}
              {loading ? " Checking SSH hosts and cloud machines…" : null}
            </p>
            <section aria-label="Fleet graph" className="overflow-hidden rounded-xl border bg-card">
              <FleetGraph
                snapshot={snapshot}
                connections={connections}
                currentMachineId={currentMachineId}
                selectedMachineId={selected}
                onSelectMachine={toggleMachine}
              />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
                {(["running", "attention", "reported"] as const).map((state) => (
                  <span key={state} className="inline-flex items-center gap-1.5">
                    <span aria-hidden className={cn("size-2 rounded-full", STATE_DOT[state])} />
                    {STATE_LABEL[state]}
                  </span>
                ))}
                {connectionLegend.length > 0 ? (
                  <span aria-hidden className="hidden h-3 w-px bg-border sm:block" />
                ) : null}
                {connectionLegend.map((entry) => (
                  <span key={entry.label} className="inline-flex items-center gap-1.5">
                    <FleetConnectionIcon state={entry.state} />
                    {entry.label}
                  </span>
                ))}
                <span className="sm:ml-auto">Select a machine to show only its threads.</span>
              </div>
            </section>

            {selectedMachine ? (
              <div className="flex items-center gap-2 text-sm">
                <span>
                  Showing <span className="font-medium">{selectedMachine.label}</span>
                </span>
                <Button size="compact" variant="ghost" onClick={() => setSelected(null)}>
                  Show all
                </Button>
              </div>
            ) : null}

            {listed.map((machine) => (
              <section key={machine.id} aria-label={machine.label} className="flex flex-col gap-1">
                <button
                  type="button"
                  aria-pressed={selected === machine.id}
                  onClick={() => toggleMachine(machine.id)}
                  className="flex items-baseline gap-2 rounded-md text-left outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="text-sm font-medium">{machine.label}</span>
                  {machineSubtitle(machine) ? (
                    <span className="text-xs text-muted-foreground">
                      {machineSubtitle(machine)}
                    </span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {machineWork(machine)}
                  </span>
                </button>
                <ul className="flex flex-col">
                  {(threadsByMachine.get(machine.id) ?? []).map((thread) => (
                    <li key={thread.key}>
                      <FleetThreadRow thread={thread} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            {idle.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Idle: {idle.map((machine) => machine.label).join(", ")}
              </p>
            ) : null}
            {selectedMachine && listed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing running on this machine.</p>
            ) : null}

            <ConnectionCatalogUnreadableAlert />
            <ConnectionEnvironmentsSection
              title="Connections"
              searchable={false}
              headerAction={
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Connection settings"
                        render={<Link to="/settings/connections" />}
                      />
                    }
                  >
                    <SettingsIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Connection settings</TooltipPopup>
                </Tooltip>
              }
            />
          </WorkspacePageContainer>
        </main>
      </div>
    </SidebarInset>
  );
}

function FleetThreadRow({ thread }: { readonly thread: FleetThread }) {
  const content = (
    <>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATE_DOT[thread.state])} />
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {thread.agentDriver ? (
          <ProviderInstanceIcon
            driverKind={thread.agentDriver}
            displayName={thread.agentLabel}
            iconClassName="size-3.5"
          />
        ) : null}
        {thread.ref === null && thread.reportedBy !== null
          ? "Last reported by " + thread.reportedBy
          : thread.agentLabel}
      </span>
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
        {STATE_LABEL[thread.state]}
      </span>
    </>
  );
  const rowClass = "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm";
  if (thread.ref === null) return <div className={rowClass}>{content}</div>;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(thread.ref)}
      className={cn(
        rowClass,
        "outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      {content}
    </Link>
  );
}
