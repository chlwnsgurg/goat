import type { FleetThread } from "@goat/client-runtime/state/fleet";
import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

export const STATE_LABEL: Record<FleetThread["state"], string> = {
  running: "Running",
  attention: "Needs you",
  reported: "Reported",
};

export const STATE_DOT: Record<FleetThread["state"], string> = {
  running: "bg-info",
  attention: "bg-warning",
  reported: "border border-muted-foreground bg-transparent",
};

/** One machine's threads, in the order buildFleet gives: oldest first, so rows hold still. */
export function FleetThreadList({ threads }: { readonly threads: ReadonlyArray<FleetThread> }) {
  return (
    <ul className="flex flex-col">
      {threads.map((thread) => (
        <li key={thread.key}>
          <FleetThreadRow thread={thread} />
        </li>
      ))}
    </ul>
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
