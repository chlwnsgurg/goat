import type { PresentedRemoteLaunch } from "@goat/client-runtime/state/remote-launches";
import {
  isActiveRemoteLaunch,
  remoteLaunchStatus,
  type SidebarRemoteLaunchGroup,
} from "@goat/client-runtime/state/remote-launch-index";
import type { ScopedThreadRef } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo, useCallback } from "react";

import { GlobeIcon } from "~/components/solar";
import { cn } from "~/lib/utils";

interface SidebarRemoteLaunchRowsProps {
  readonly group: SidebarRemoteLaunchGroup;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  /** A friendlier machine name for an SSH host alias, when one is known. */
  readonly hostLabel?: ((hostAlias: string) => string | null) | undefined;
}

function statusDotClassName(entry: PresentedRemoteLaunch): string {
  const { launch } = entry;
  if (launch.hostUnavailableSince !== null || launch.state === "lost") return "bg-warning";
  return isActiveRemoteLaunch(launch) ? "bg-sidebar-foreground" : "bg-sidebar-muted-foreground/50";
}

const RemoteLaunchRow = memo(function RemoteLaunchRow(props: {
  readonly entry: PresentedRemoteLaunch;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  readonly hostLabel: SidebarRemoteLaunchRowsProps["hostLabel"];
}) {
  const { entry, onOpen } = props;
  const { launch, ref } = entry;
  const host = props.hostLabel?.(launch.host) ?? launch.host;
  const machine = host === launch.host ? host : `${host} (${launch.host})`;
  const status = remoteLaunchStatus(launch);
  // Dispatch records carry no title until the thread is loaded or watched, so
  // an untitled launch leads with its machine instead of a placeholder.
  const title = entry.title;
  const primary = title ?? host;
  const detail = [title === null ? null : host, entry.providerLabel]
    .filter((part) => part !== null)
    .join(" · ");
  const label = `${title ?? (launch.threadId === null ? "Not started" : "Untitled thread")}, on ${machine}${
    entry.providerLabel === null ? "" : `, ${entry.providerLabel}`
  }, ${status}`;
  const open = useCallback(() => {
    if (ref !== null) onOpen(ref);
  }, [onOpen, ref]);
  const content = (
    <>
      <GlobeIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-12 flex-1 truncate">{primary}</span>
      {detail.length > 0 ? (
        <span className="min-w-0 max-w-[40%] truncate text-sidebar-muted-foreground">{detail}</span>
      ) : null}
      <span className="inline-flex shrink-0 items-center gap-1 text-sidebar-muted-foreground">
        <span aria-hidden className={cn("size-1 rounded-full", statusDotClassName(entry))} />
        {status}
      </span>
    </>
  );
  return (
    <li className="flex h-7 items-center rounded-md pl-6 pr-2 text-xs text-sidebar-foreground">
      {ref === null ? (
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5">
          <span className="sr-only">{label}</span>
          <span aria-hidden className="contents">
            {content}
          </span>
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Open ${label}`}
          onClick={open}
          className="-mx-1 flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {content}
        </button>
      )}
    </li>
  );
});

/**
 * Recent threads a launcher started on other machines, beneath its sidebar row.
 * A child opens when this client has loaded that thread; otherwise it only
 * reports status. The rest live in Remote launches settings.
 */
export const SidebarRemoteLaunchRows = memo(function SidebarRemoteLaunchRows(
  props: SidebarRemoteLaunchRowsProps,
) {
  const { group, onOpen, hostLabel } = props;
  const navigate = useNavigate();
  const showAll = useCallback(() => {
    void navigate({ to: "/settings/connections", hash: "remote-launches" });
  }, [navigate]);
  // Keep pointer and activation keys away from the launcher row's drag handling.
  const stopPointerPropagation = useCallback(
    (event: React.PointerEvent) => event.stopPropagation(),
    [],
  );
  const stopActivationKeys = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }, []);
  return (
    <ul
      role="group"
      aria-label="Work on other machines"
      onPointerDown={stopPointerPropagation}
      onKeyDown={stopActivationKeys}
    >
      {group.visible.map((entry, index) => (
        <RemoteLaunchRow
          // A launch with no thread yet has no other stable identity.
          key={`${entry.launch.host}:${entry.launch.threadId ?? `pending-${index}`}`}
          entry={entry}
          onOpen={onOpen}
          hostLabel={hostLabel}
        />
      ))}
      {group.hiddenInPage > 0 ? (
        <li className="flex h-7 items-center pl-6 pr-2 text-xs">
          <button
            type="button"
            onClick={showAll}
            className="cursor-pointer rounded-md px-1 text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {group.truncated ? "More in Remote launches" : `+${group.hiddenInPage} more`}
          </button>
        </li>
      ) : null}
    </ul>
  );
});
