import { useAtomValue } from "@effect/atom-react";
import type { FleetMachineSummary } from "@goat/client-runtime/state/fleet";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { createContext, memo, useContext, type ReactElement } from "react";

import {
  ActivityIcon,
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  HomeIcon,
  ListChecksIcon,
  SettingsIcon,
} from "~/components/solar";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "~/components/pullRequest/pullRequestListPreferences";

import { isElectron } from "../../env";
import { isGoatBotRoute } from "../../globalAgentRoute";
import { useGlobalAgentStore } from "../../globalAgentStore";
import { cn } from "../../lib/utils";
import { decisionInbox } from "../../state/decisionInbox";
import { useEnvironments, usePullRequestsSupported } from "../../state/environments";
import { useFleetSummary } from "../../state/fleet";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useGoatBotWaitingCount } from "../goatBot/useGoatBotWaitingCount";
import { useGoatBotReadMenu } from "../goatBot/useGoatBotReadMenu";
import {
  isMemoryEnvironmentAvailable,
  validateMemorySettingsSearch,
} from "../settings/MemorySettings.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveActiveDestination, type DestinationId } from "./destinationRail.logic";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

/** True while the desktop destination rail is on screen; the sidebar footer drops its duplicates. */
export const DestinationRailVisibleContext = createContext(false);

export function useDestinationRailVisible(): boolean {
  return useContext(DestinationRailVisibleContext);
}

// The rail owns aria-current; Link's own fuzzy matching would also mark /settings on its
// subpages.
const EXACT_MATCH = { exact: true } as const;

function railItemClassName(active: boolean, shape = "size-10 justify-center") {
  return cn(
    "relative flex shrink-0 items-center rounded-lg outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-5",
    shape,
    // The rail sits on the window background, where the sidebar's row fills (tuned for the
    // sidebar surface) barely show; the accent pair keeps both states visible in every theme.
    active
      ? "bg-accent text-accent-foreground"
      : "text-sidebar-muted-foreground hover:bg-accent hover:text-accent-foreground",
  );
}

function RailCount({ count }: { count: number | undefined }) {
  if (count === undefined || count <= 0) return null;
  return (
    <span
      aria-hidden
      className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-center text-3xs leading-4 font-medium text-primary-foreground tabular-nums"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function RailTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function countLabel(label: string, count: number | undefined) {
  return count !== undefined && count > 0 ? `${label}, ${count} waiting` : label;
}

const FLEET_TOOLTIP_ROWS = 8;

const machineBusy = (machine: FleetMachineSummary) => machine.running + machine.attention > 0;

function machineWork(machine: FleetMachineSummary) {
  const parts = [
    machine.running > 0 ? `${machine.running} running` : null,
    machine.attention > 0 ? `${machine.attention} need you` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "idle" : parts.join(", ");
}

/**
 * Live glance at everything running on connected machines: the rail shows one total count,
 * and the tooltip names each machine, busy machines first. Subscribes to the fleet summary
 * alone, which keeps its object while counts hold, so streamed thread updates do not repaint
 * the rail.
 */
const FleetRailItem = memo(function FleetRailItem({ active }: { active: boolean }) {
  const summary = useFleetSummary();
  const live = summary.running + summary.attention;
  const ranked = [
    ...summary.machines.filter(machineBusy),
    ...summary.machines.filter((machine) => !machineBusy(machine)),
  ];
  const tooltipRows = ranked.slice(0, FLEET_TOOLTIP_ROWS);
  const label =
    live === 0 ? "Fleet" : `Fleet, ${summary.running} running, ${summary.attention} need you`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/fleet"
            aria-label={label}
            activeOptions={EXACT_MATCH}
            aria-current={active ? "page" : undefined}
            className={railItemClassName(active)}
          >
            <ActivityIcon aria-hidden />
            <RailCount count={live} />
          </Link>
        }
      />
      <TooltipPopup side="right">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">
            {live === 0
              ? "Fleet: nothing running"
              : `Fleet: ${summary.running} running, ${summary.attention} need you`}
          </span>
          {summary.machines.length > 0
            ? tooltipRows.map((machine) => (
                <span key={machine.environmentId}>
                  {machine.label}: {machineWork(machine)}
                </span>
              ))
            : null}
          {summary.machines.length > FLEET_TOOLTIP_ROWS ? (
            <span>and {summary.machines.length - FLEET_TOOLTIP_ROWS} more</span>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
});

/** The desktop app-wide destination rail beside the thread sidebar. */
export const DestinationRail = memo(function DestinationRail() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const botRef = useGlobalAgentStore((state) => state.botRef);
  // Bot stays selected in thread mode too: /bot redirects to the bot thread either way.
  const isBotRoute = isGoatBotRoute(pathname, resolveThreadRouteTarget(params), botRef);
  const active = resolveActiveDestination(pathname, { isBotRoute });
  const botWaiting = useGoatBotWaitingCount();
  const botReadMenu = useGoatBotReadMenu(botWaiting);
  const { count: decisionsWaiting } = useAtomValue(decisionInbox.summaryAtom);
  const pullRequestsSupported = usePullRequestsSupported();
  const { environments } = useEnvironments();
  const memoryAvailable = environments.some((environment) =>
    isMemoryEnvironmentAvailable(environment.serverConfig?.environment.capabilities),
  );
  const current = (id: DestinationId) => (active === id ? ("page" as const) : undefined);

  return (
    <nav
      aria-label="App"
      className="sticky top-0 z-20 hidden h-svh w-(--destination-rail-width) shrink-0 flex-col items-center bg-background md:flex"
      data-destination-rail=""
    >
      {/* The titlebar strip above the rail belongs to the window frame. */}
      <div
        aria-hidden
        className={cn("h-(--workspace-topbar-height) w-full shrink-0", isElectron && "drag-region")}
      />
      {/* Scrolls on short windows so the bottom controls stay reachable. */}
      <div className="flex min-h-0 w-full flex-1 scrollbar-gutter-both flex-col items-center gap-1 overflow-y-auto pt-2 pb-3">
        <RailTooltip label="Home">
          <Link
            to="/"
            aria-label="Home"
            activeOptions={EXACT_MATCH}
            aria-current={current("home")}
            className={railItemClassName(active === "home")}
          >
            <HomeIcon aria-hidden />
          </Link>
        </RailTooltip>
        <FleetRailItem active={active === "fleet"} />
        <RailTooltip label="GOAT Bot">
          <Link
            to="/bot"
            aria-label={countLabel("GOAT Bot", botWaiting)}
            activeOptions={EXACT_MATCH}
            aria-current={current("bot")}
            className={railItemClassName(active === "bot")}
            {...botReadMenu}
          >
            <BotIcon aria-hidden />
            <RailCount count={botWaiting} />
          </Link>
        </RailTooltip>
        <RailTooltip label="Decisions">
          <Link
            to="/decisions"
            aria-label={countLabel("Decisions", decisionsWaiting)}
            activeOptions={EXACT_MATCH}
            aria-current={current("decisions")}
            className={railItemClassName(active === "decisions")}
          >
            <ListChecksIcon aria-hidden />
            <RailCount count={decisionsWaiting} />
          </Link>
        </RailTooltip>
        <RailTooltip label="Usage">
          <Link
            to="/usage"
            aria-label="Usage"
            activeOptions={EXACT_MATCH}
            aria-current={current("usage")}
            className={railItemClassName(active === "usage")}
          >
            <ChartNoAxesColumnIcon aria-hidden />
          </Link>
        </RailTooltip>
        <div aria-hidden className="my-1.5 h-px w-6 shrink-0 bg-border" />
        {pullRequestsSupported ? (
          <RailTooltip label="Pull requests">
            <Link
              to="/pull-requests"
              search={readPullRequestListPreferences()}
              aria-label="Pull requests"
              activeOptions={EXACT_MATCH}
              aria-current={current("pullRequests")}
              className={railItemClassName(active === "pullRequests")}
            >
              <PullRequestGlyph.pullRequest aria-hidden />
            </Link>
          </RailTooltip>
        ) : null}
        {memoryAvailable ? (
          <RailTooltip label="Memory">
            <Link
              to="/settings/memory"
              search={validateMemorySettingsSearch({})}
              aria-label="Memory"
              activeOptions={EXACT_MATCH}
              aria-current={current("memory")}
              className={railItemClassName(active === "memory")}
            >
              <BrainIcon aria-hidden />
            </Link>
          </RailTooltip>
        ) : null}
        <RailTooltip label="Scheduled tasks">
          <Link
            to="/settings/scheduled-tasks"
            aria-label="Scheduled tasks"
            activeOptions={EXACT_MATCH}
            aria-current={current("scheduled")}
            className={railItemClassName(active === "scheduled")}
          >
            <CalendarClockIcon aria-hidden />
          </Link>
        </RailTooltip>
        <div className="flex-1" />
        <SidebarUpdatePill placement="rail" />
        <RailTooltip label="Settings">
          <Link
            to="/settings"
            aria-label="Settings"
            activeOptions={EXACT_MATCH}
            aria-current={current("settings")}
            className={railItemClassName(active === "settings")}
          >
            <SettingsIcon aria-hidden />
          </Link>
        </RailTooltip>
      </div>
    </nav>
  );
});
