import { GOAT_CONNECT_COMING_SOON } from "@goat/shared/goatConnect";
import { isGoatConnectUnavailable } from "./EnvironmentRow.logic";
import { sshHostProbeErrorText } from "@goat/client-runtime/state/sshHost";
import * as Schema from "effect/Schema";
import { HandoffReview } from "../chat/HandoffReview";
import { desktopOwnsSshHostConfig } from "~/connection/platform";
import { SshRuntimeSettingsRow } from "./SshRuntimeSettingsRow";
import { sshRuntime } from "~/state/sshRuntime";
import { sshRuntimeStatusText } from "@goat/client-runtime/state/sshRuntime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { SessionPermissions } from "./SessionPermissions";
import {
  ChevronRightIcon,
  ChevronsLeftRightEllipsisIcon,
  CopyIcon,
  EllipsisIcon,
  PlusIcon,
  RouteIcon,
  TerminalIcon,
} from "~/components/solar";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  SshHostAlias,
  SshHostProbeError,
  type SshHostProbeResult,
  type SshHostResult,
  AuthEnvironmentMaintainScope,
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@goat/contracts";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
  connectionRoutes,
  connectionStatusText,
  environmentMcpUrl,
} from "@goat/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useCopyConnectionDiagnostic } from "../../hooks/useCopyConnectionDiagnostic";
import { cn } from "../../lib/utils";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { EnvironmentRoutesList } from "./EnvironmentRoutesList";
import { usePreparedConnection } from "~/state/session";
import {
  EnvironmentRow,
  environmentTransportLabel,
  formatDesktopSshTarget,
} from "./EnvironmentRow";
import { Input } from "../ui/input";
import { CommandShortcut } from "../ui/command";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { AnimatedHeight } from "../AnimatedHeight";
import { getPairingTokenFromUrl } from "../../pairingUrl";
import { readHostedPairingRequest } from "../../hostedPairing";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { RemoveT3ConnectEnvironmentDialog } from "../clerk/RemoveT3ConnectEnvironmentDialog";
import { environmentCatalog } from "~/connection/catalog";
import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from "~/connection/onboarding";
import { readEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { desktopSshHostsStateAtom, filterDiscoveredSshHosts } from "~/state/desktopSshHosts";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
  useRelayEnvironmentDiscovery,
} from "~/state/environments";
import { APP_VERSION } from "~/branding";
import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  environmentUpdateStatesAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "~/state/server";
import { environmentIdsKey } from "~/state/environmentAtomList";
import {
  OutdatedServerUpdateAction,
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "../ServerUpdateAction";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../../keybindings";

const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];
const NO_SSH_RUNTIME_STATUS = Atom.make(null);
function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;
  let port: number | null = null;

  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    hostname = bracketedHostMatch[1]!.trim();
    if (bracketedHostMatch[2]) {
      port = Number.parseInt(bracketedHostMatch[2], 10);
    }
  } else {
    const colonSegments = hostname.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      hostname = colonSegments[0]!.trim();
      port = Number.parseInt(colonSegments[1]!, 10);
    }
  }

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }

  if (hostname.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  };
}

function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, window.location.origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host,
        pairingCode: hostedPairingRequest.token,
      };
    }

    const pairingCode = getPairingTokenFromUrl(url);
    if (!pairingCode) return null;
    return {
      host: url.origin,
      pairingCode,
    };
  } catch {
    return null;
  }
}

function parseRemotePairingFields(input: { readonly host: string; readonly pairingCode: string }): {
  readonly host: string;
  readonly pairingCode: string;
} {
  const parsedPairingUrl = parsePairingUrlFields(input.host);
  if (parsedPairingUrl) return parsedPairingUrl;

  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) {
    throw new Error("Enter a backend host.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }
  return { host, pairingCode };
}

function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "Failed to connect SSH host.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    "",
  );
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, "");
  return withoutTaggedErrorPrefix.trim() || fallback;
}

const isSshHostAlias = Schema.is(SshHostAlias);
const isSshHostProbeError = Schema.is(SshHostProbeError);

function sshSetupError(result: SshHostResult, host: string) {
  return result.kind === "error"
    ? result.code === "host_unreachable"
      ? `Can't reach ${host}. Check that it's running and reachable, then try again.`
      : result.message
    : null;
}

/** Only saved Desktop SSH profiles can address the Desktop runtime owner. */
function savedDesktopSshTarget(environment: EnvironmentPresentation) {
  if (window.desktopBridge === undefined) return null;
  for (const route of connectionRoutes(environment.entry)) {
    if (
      route.target._tag === "SshConnectionTarget" &&
      Option.isSome(route.profile) &&
      route.profile.value._tag === "SshConnectionProfile"
    )
      return route.profile.value.target;
  }
  return null;
}

type SavedBackendListRowProps = {
  environment: EnvironmentPresentation;
  removingEnvironmentId: EnvironmentId | null;
  onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  onRemove: (environment: EnvironmentPresentation) => void;
  onAddRoute: (environment: EnvironmentPresentation) => void;
  onForget: ((environment: EnvironmentPresentation) => void) | undefined;
  onReviewTrust: (environment: EnvironmentPresentation) => void;
};

/**
 * Status word for a row subtitle: "Reconnecting: <reason>" instead of the
 * long-form sentence, since the row has one line and the full text is one
 * hover away.
 */
/** Aliases and addresses of saved SSH machines, so discovery can hide them. */
function savedSshEnvironmentKeys(environments: ReadonlyArray<EnvironmentPresentation>) {
  const keys = new Set<string>();
  for (const environment of environments) {
    const profile = environment.entry.profile;
    if (
      environment.entry.target._tag !== "SshConnectionTarget" ||
      Option.isNone(profile) ||
      profile.value._tag !== "SshConnectionProfile"
    ) {
      continue;
    }
    const target = profile.value.target;
    keys.add(target.alias);
    keys.add(formatDesktopSshTarget(target));
  }
  return keys;
}

function savedBackendStatus(environment: EnvironmentPresentation): {
  readonly text: string;
  readonly tone: "muted" | "error";
} {
  if (isGoatConnectUnavailable(environment.entry)) return { text: "Unavailable", tone: "muted" };
  if (!environment.entry.enabled && environment.connection.phase !== "unsupported")
    return { text: "Off", tone: "muted" };
  const { connection } = environment;
  switch (connection.phase) {
    case "connected":
      return { text: "Connected", tone: "muted" };
    case "connecting":
      return { text: "Connecting", tone: "muted" };
    case "reconnecting":
      // Expected for a laptop that is asleep or away; it retries on its own.
      if (connection.unreachable) return { text: "Unreachable", tone: "muted" };
      return {
        text: connection.error ? `Reconnecting: ${connection.error}` : "Reconnecting",
        tone: "error",
      };
    // Not a failure: the machine is fine, this build just cannot talk to it.
    case "unsupported":
      return { text: "Client not supported", tone: "muted" };
    case "error":
      return {
        text: connection.error ? `Connection failed: ${connection.error}` : "Connection failed",
        tone: "error",
      };
    case "offline":
      return { text: "Offline", tone: "muted" };
    case "available":
      return { text: "Not connected", tone: "muted" };
  }
}

/**
 * One added machine in the Environments list. The switch is the main action;
 * the update icon appears only when that machine can take an update; the
 * row menu holds the icon override, trace ID, and removal.
 */
function SavedBackendListRow({
  environment,
  removingEnvironmentId,
  onSetEnabled,
  onRemove,
  onAddRoute,
  onForget,
  onReviewTrust,
}: SavedBackendListRowProps) {
  const [routesOpen, setRoutesOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const environmentId = environment.environmentId;
  const unsupported = environment.connection.phase === "unsupported";
  const enabled = environment.entry.enabled && !unsupported;
  const isConnected = environment.connection.phase === "connected";
  const isRemoving = removingEnvironmentId === environmentId;
  const savedSshTarget = savedDesktopSshTarget(environment);
  const runtimeAtom =
    savedSshTarget === null
      ? NO_SSH_RUNTIME_STATUS
      : sshRuntime.statusAtom({ environmentId, target: savedSshTarget });
  const runtimeResult = useAtomValue(runtimeAtom);
  const runtimeStatus = runtimeResult?.status;
  const errorTraceId = environment.connection.traceId;
  const copyDiagnostic = useCopyConnectionDiagnostic(environment);
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: "trace ID",
    onCopy: ({ traceId }) => {
      toastManager.add({
        type: "success",
        title: "Trace ID copied",
        description: traceId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy trace ID",
          description: error.message,
        }),
      );
    },
  });
  const copyTraceId = (traceId: string) => {
    copyTraceIdToClipboard(traceId, { traceId });
  };
  const { copyToClipboard: copyMcpUrl } = useCopyToClipboard<{ url: string }>({
    target: "MCP URL",
    onCopy: ({ url }) => {
      toastManager.add({
        type: "success",
        title: "MCP URL copied",
        description: `Add it to an agent, e.g. claude mcp add --transport http t3 ${url}`,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy MCP URL",
          description: error.message,
        }),
      );
    },
  });
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const resumingServerUpdate =
    serverUpdateState.status === "running" && serverUpdateState.stage === "resuming";
  const status = savedBackendStatus(environment);
  const serverVersion = environment.serverConfig?.environment.serverVersion ?? null;
  // A saved T3 Connect machine this device has never reached (unsupported,
  // or not yet connected) still has a descriptor from relay discovery, so
  // it can wear its detected glyph instead of the generic server. Discovery
  // empties its map on every refresh, so hold the last descriptor seen or
  // the glyph would blink back to the generic one each time.
  const relayDiscovery = useRelayEnvironmentDiscovery();
  const discoveredDescriptor = Option.getOrNull(
    relayDiscovery.environments.get(environmentId)?.status ?? Option.none(),
  )?.descriptor;
  const [lastDescriptor, setLastDescriptor] = useState(discoveredDescriptor);
  if (discoveredDescriptor !== undefined && discoveredDescriptor !== lastDescriptor) {
    setLastDescriptor(discoveredDescriptor);
  }
  // Held for the same reason as the descriptor, so Copy MCP URL survives a refresh.
  const discoveredRelayHttpBaseUrl =
    relayDiscovery.environments.get(environmentId)?.environment.endpoint.httpBaseUrl;
  const [lastRelayHttpBaseUrl, setLastRelayHttpBaseUrl] = useState(discoveredRelayHttpBaseUrl);
  if (
    discoveredRelayHttpBaseUrl !== undefined &&
    discoveredRelayHttpBaseUrl !== lastRelayHttpBaseUrl
  ) {
    setLastRelayHttpBaseUrl(discoveredRelayHttpBaseUrl);
  }
  const prepared = usePreparedConnection(environmentId);
  const connectedTarget = isConnected && prepared._tag === "Some" ? prepared.value.target : null;
  const mcpUrl = environmentMcpUrl({
    entry: environment.entry,
    relayHttpBaseUrl: discoveredRelayHttpBaseUrl ?? lastRelayHttpBaseUrl,
    connectedTarget,
  });
  const machineKind = resolveEnvironmentMachineKind(
    environment.serverConfig ??
      (lastDescriptor === undefined ? null : { environment: lastDescriptor }),
  );
  const routeCount = connectionRoutes(environment.entry).length;
  const subtitleText = [
    environmentTransportLabel(environment, connectedTarget),
    resumingServerUpdate ? "Restarting" : status.text,
    enabled && versionMismatch ? serverVersion : null,
    savedSshTarget && runtimeStatus
      ? runtimeStatus.state === "preparing"
        ? "Setting up runtime"
        : sshRuntimeStatusText(runtimeStatus)
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");

  // Only a connected, enabled machine can take a remote update; a switched-off
  // one keeps the version note so the icon is not a surprise later.
  const showUpdateAction =
    enabled &&
    isConnected &&
    versionMismatch !== null &&
    (serverUpdateState.status === "idle" || serverUpdateState.status === "failed");

  const statusTooltip = isGoatConnectUnavailable(environment.entry)
    ? `${GOAT_CONNECT_COMING_SOON.status}. ${GOAT_CONNECT_COMING_SOON.description}`
    : `${
        unsupported
          ? (environment.connection.error ?? connectionStatusText(environment.connection))
          : enabled
            ? connectionStatusText(environment.connection)
            : "Switched off"
      }${
        versionMismatch
          ? `\nUpdate available: ${versionMismatch.serverVersion} → ${versionMismatch.clientVersion}`
          : ""
      }${
        savedSshTarget && runtimeStatus
          ? `\nRuntime ${runtimeStatus.runtimeVersion ?? "unknown"} · This app ${runtimeStatus.requestedVersion}`
          : ""
      }`;

  return (
    <EnvironmentRow
      kind={machineKind}
      label={environment.label}
      dimmed={!enabled}
      subtitle={
        <span className="flex min-w-0 items-center gap-1">
          <Tooltip>
            {/* The status can change while the tooltip is open, and base-ui only
                re-measures the popup when the trigger's payload changes. */}
            <TooltipTrigger
              payload={statusTooltip}
              render={
                <span
                  className={cn(
                    "min-w-0 truncate",
                    enabled &&
                      status.tone === "error" &&
                      !resumingServerUpdate &&
                      "text-destructive",
                  )}
                />
              }
            >
              {subtitleText}
            </TooltipTrigger>
            <TooltipPopup side="top" className="whitespace-pre-wrap">
              {statusTooltip}
            </TooltipPopup>
          </Tooltip>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <button
            type="button"
            aria-expanded={routesOpen}
            onClick={() => setRoutesOpen((open) => !open)}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {routeCount === 1 ? "Routes" : `${routeCount} routes`}
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                routesOpen && "rotate-90",
              )}
            />
          </button>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <button
            type="button"
            aria-expanded={permissionsOpen}
            aria-controls={`remote-permissions-${environmentId}`}
            onClick={() => setPermissionsOpen((open) => !open)}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            Permissions
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                permissionsOpen && "rotate-90",
              )}
            />
          </button>
        </span>
      }
      below={
        savedSshTarget ? (
          <SshRuntimeSettingsRow
            environmentId={environmentId}
            target={savedSshTarget}
            enabled={environment.entry.enabled && !isRemoving}
            onReviewTrust={() => onReviewTrust(environment)}
          />
        ) : serverUpdateState.status !== "idle" ? (
          <div className="mt-1 max-w-md">
            <ServerUpdateProgress state={serverUpdateState} />
          </div>
        ) : null
      }
      detail={
        <>
          {routesOpen && (
            <EnvironmentRoutesList
              environment={environment}
              onAddRoute={() => onAddRoute(environment)}
            />
          )}
          {permissionsOpen && (
            <div
              id={`remote-permissions-${environmentId}`}
              className="mt-2 border-t border-border/50"
            >
              <SessionPermissions
                environmentId={environmentId}
                connected={isConnected}
                routeContext
              />
            </div>
          )}
        </>
      }
    >
      {savedSshTarget === null &&
      unsupported &&
      environment.entry.serverUpdateRequired === true &&
      serverUpdateState.status !== "running" ? (
        <OutdatedServerUpdateAction
          environmentId={environmentId}
          serverLabel={`${environment.label} server`}
          fromVersion={lastDescriptor?.serverVersion}
          targetVersion={APP_VERSION}
          label={serverUpdateState.status === "failed" ? "Retry update" : "Update"}
        />
      ) : null}
      {savedSshTarget === null && showUpdateAction ? (
        <ServerUpdateAction
          environmentId={environmentId}
          serverLabel={`${environment.label} server`}
          selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
          installation={environment.serverConfig?.environment.capabilities.serverInstallation}
          desktopAppUpdate={supportsDesktopAppUpdate(environment.serverConfig)}
          threadContinuation={supportsServerUpdateThreadContinuation(environment.serverConfig)}
          targetVersion={versionMismatch.clientVersion}
          label={serverUpdateState.status === "failed" ? "Retry update" : "Update"}
          appearance="icon"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Switch
              size="sm"
              checked={enabled}
              disabled={isRemoving || unsupported}
              aria-label={`${enabled ? "Switch off" : "Switch on"} ${environment.label}`}
              onCheckedChange={(checked) => onSetEnabled(environmentId, checked)}
            />
          }
        />
        <TooltipPopup side="top">
          {unsupported ? "Client not supported" : enabled ? "Switch off" : "Switch on"}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              disabled={isRemoving}
              aria-label={`More actions for ${environment.label}`}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <EnvironmentIconMenu
            environmentId={environmentId}
            serverConfig={environment.serverConfig}
          />
          <MenuItem onClick={() => setRoutesOpen((open) => !open)}>
            <RouteIcon />
            {routesOpen ? "Hide routes" : "Routes"}
          </MenuItem>
          {mcpUrl ? (
            <MenuItem onClick={() => copyMcpUrl(mcpUrl, { url: mcpUrl })}>
              <CopyIcon />
              Copy MCP URL
            </MenuItem>
          ) : null}
          {errorTraceId ? (
            <MenuItem onClick={() => copyTraceId(errorTraceId)}>
              <CopyIcon />
              Copy trace ID
            </MenuItem>
          ) : null}
          <MenuItem onClick={copyDiagnostic}>
            <CopyIcon />
            Copy diagnostic
          </MenuItem>
          <MenuSeparator />
          {savedSshTarget && isSshHostAlias(savedSshTarget.alias) && onForget ? (
            <MenuItem variant="destructive" onClick={() => onForget(environment)}>
              Forget host…
            </MenuItem>
          ) : null}
          <MenuItem variant="destructive" onClick={() => onRemove(environment)}>
            {isRemoving ? "Removing…" : "Remove from this device…"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </EnvironmentRow>
  );
}

function EmptyRemoteEnvironments({ cloudEnabled = true }: { readonly cloudEnabled?: boolean }) {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No saved remote environments</EmptyTitle>
        <EmptyDescription>
          {cloudEnabled
            ? "Click “Add environment” to pair another environment, or connect one from T3 Connect."
            : "Click “Add environment” to pair another environment."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
}) {
  return hasCloudPublicConfig() ? (
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={primaryEnvironmentId}
      savedEnvironments={savedEnvironments}
      empty={<EmptyRemoteEnvironments />}
    />
  ) : savedEnvironments.length === 0 ? (
    <EmptyRemoteEnvironments cloudEnabled={false} />
  ) : null;
}

/**
 * Saved machines with their health, switches and row actions, plus the Add device
 * dialog (remote pairing and SSH). Settings > Connections and the Fleet page both render it.
 */
export function ConnectionEnvironmentsSection({
  title = "Environments",
  searchable = true,
  headerAction,
}: {
  readonly title?: string;
  /** Registers the section as the settings-search target; only Settings > Connections does. */
  readonly searchable?: boolean;
  readonly headerAction?: ReactNode;
}) {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const probeSshHost = useAtomCommand(serverEnvironment.probeSshHost, { reportFailure: false });
  const trustSshHost = useAtomCommand(serverEnvironment.trustSshHost, { reportFailure: false });
  const forgetSshHost = useAtomCommand(serverEnvironment.forgetSshHost, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const relayDiscoveryState = useRelayEnvironmentDiscovery();
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  // The WSL backend is managed from the WSL row under this machine, so it has
  // no row of its own in the list.
  const listedEnvironments = savedEnvironments.filter(
    (environment) => !isDesktopLocalConnectionTarget(environment.entry.target),
  );
  // Machines "Update all" can reach: switched on, connected, behind the client
  // version, remotely updatable, and not already mid-update. The button only
  // renders when this list is non-empty.
  const savedUpdateStates = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(savedEnvironments.map(({ environmentId }) => environmentId)),
    ),
  );
  const savedServerUpdateStates = savedEnvironments.map((environment, index) => ({
    environment,
    updateStatus: savedUpdateStates[index]!.status,
  }));
  const savedServerUpdateTargets = savedServerUpdateStates.flatMap(
    ({ environment, updateStatus }): ServerUpdateTarget[] => {
      const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
      const selfUpdate = resolveServerSelfUpdateCapability(environment.serverConfig);
      const desktopAppUpdate = supportsDesktopAppUpdate(environment.serverConfig);
      if (
        !mismatch ||
        updateStatus === "running" ||
        !environment.entry.enabled ||
        environment.connection.phase !== "connected" ||
        isDesktopLocalConnectionTarget(environment.entry.target) ||
        // Manual-update machines only offer a copy command on their row.
        selfUpdate === null ||
        (selfUpdate === "desktop-managed" && !desktopAppUpdate)
      ) {
        return [];
      }
      return [
        {
          environmentId: environment.environmentId,
          serverLabel: environment.label,
          selfUpdate,
          installation: environment.serverConfig?.environment.capabilities.serverInstallation,
          desktopAppUpdate,
          threadContinuation: supportsServerUpdateThreadContinuation(environment.serverConfig),
          continueThreadsAfterServerUpdate:
            environment.serverConfig?.settings.continueThreadsAfterServerUpdate ?? false,
          targetVersion: mismatch.clientVersion,
        },
      ];
    },
  );
  const savedDesktopSshEnvironmentKeys = savedSshEnvironmentKeys(savedEnvironments);
  const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false);
  // Set when the dialog adds a route to a saved machine instead of a new one.
  const [routeTarget, setRouteTarget] = useState<EnvironmentPresentation | null>(null);
  const [savedBackendMode, setSavedBackendMode] = useState<"remote" | "ssh">("remote");
  const [savedBackendHost, setSavedBackendHost] = useState("");
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  const [savedBackendSshHost, setSavedBackendSshHost] = useState("");
  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState("");
  const [savedBackendSshPort, setSavedBackendSshPort] = useState("");
  const [sshHostSuggestionsOpen, setSshHostSuggestionsOpen] = useState(false);
  // Tracks the arrow-key/hover highlight so Enter selects it instead of submitting the typed text.
  const highlightedSshHostRef = useRef<DesktopDiscoveredSshHost | undefined>(undefined);
  const [sshProbe, setSshProbe] = useState<SshHostProbeResult | null>(null);
  const [pendingSshTarget, setPendingSshTarget] = useState<DesktopSshEnvironmentTarget | null>(
    null,
  );
  const sshAddInFlight = useRef(false);
  const sshConnectInFlight = useRef(false);
  const sshReviewGeneration = useRef(0);
  const [pendingForget, setPendingForget] = useState<EnvironmentPresentation | null>(null);
  const [removeForgottenConnection, setRemoveForgottenConnection] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const canWriteSsh = useAtomValue(
    serverEnvironment.trustSshHost.permissionAtom(primaryEnvironmentId),
  );
  const primaryHttpBaseUrl =
    primaryEnvironment?.entry.target._tag === "PrimaryConnectionTarget"
      ? primaryEnvironment.entry.target.httpBaseUrl
      : null;
  const ownsSshConfig = desktopOwnsSshHostConfig(desktopBridge, primaryHttpBaseUrl);
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);
  const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const isSshDiscoveryActive =
    desktopBridge !== undefined && addBackendDialogOpen && savedBackendMode === "ssh";
  const desktopSshHosts = useEnvironmentQuery(
    isSshDiscoveryActive ? desktopSshHostsStateAtom : null,
  );
  // The discovery atom is kept alive across dialog opens, so re-read SSH config
  // each time the SSH tab is shown; stale hosts stay visible while it refreshes.
  const refreshDesktopSshHosts = desktopSshHosts.refresh;
  useEffect(() => {
    if (isSshDiscoveryActive) refreshDesktopSshHosts();
  }, [isSshDiscoveryActive, refreshDesktopSshHosts]);
  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS;
  const unsavedDiscoveredSshHosts = discoveredSshHosts.filter((target) => {
    const address = formatDesktopSshTarget(target);
    return (
      !savedDesktopSshEnvironmentKeys.has(target.alias) &&
      !savedDesktopSshEnvironmentKeys.has(address)
    );
  });
  const filteredDiscoveredSshHosts = filterDiscoveredSshHosts(
    unsavedDiscoveredSshHosts,
    savedBackendSshHost,
  );
  const isLoadingDiscoveredSshHosts = desktopSshHosts.isPending && desktopSshHosts.data === null;
  const discoveredSshHostsError = desktopSshHosts.error;
  const hasSshHostSuggestionContent =
    desktopBridge !== undefined &&
    (isLoadingDiscoveredSshHosts || unsavedDiscoveredSshHosts.length > 0);
  // Shared by manual SSH submission and discovered-host selection.
  const connectSavedBackendSshTarget = async (target: DesktopSshEnvironmentTarget) => {
    if (sshConnectInFlight.current) return;
    if (
      target.alias.startsWith("goat-") &&
      (primaryEnvironmentId === null ||
        !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope))
    ) {
      setSavedBackendError(
        "This device can't set up hosts on this environment. Ask its owner for full access.",
      );
      return;
    }
    sshConnectInFlight.current = true;
    setPendingSshTarget(target);
    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    const result = await connectSshEnvironment({
      target,
      label: "",
      ...(target.alias.startsWith("goat-") ? { keyOnly: true } : {}),
      ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const message = formatDesktopSshConnectionError(squashAtomCommandFailure(result));
        const current =
          primaryEnvironmentId === null
            ? null
            : await sshRuntime.refresh.run(appAtomRegistry, {
                environmentId: primaryEnvironmentId,
                target,
              });
        setSavedBackendError(
          current?._tag === "Success" && current.value?.status?.state === "ready"
            ? `GOAT is ready on ${target.alias}, but the connection couldn't be saved. ${message}`
            : message,
        );
      }
      sshConnectInFlight.current = false;
      setIsAddingSavedBackend(false);
      return;
    }

    sshConnectInFlight.current = false;
    setPendingSshTarget(null);
    setSavedBackendHost("");
    setSavedBackendPairingCode("");
    setSavedBackendSshHost("");
    setSavedBackendSshUsername("");
    setSavedBackendSshPort("");
    setAddBackendDialogOpen(false);
    toastManager.add({
      type: "success",
      title: routeTarget ? "Route added" : "Environment connected",
      description: routeTarget
        ? `${routeTarget.label} can now be reached over SSH ${target.alias}.`
        : `${target.alias} is ready over an SSH-managed tunnel.`,
    });
    setIsAddingSavedBackend(false);
  };

  const reviewSavedBackendSshTarget = async (
    target: DesktopSshEnvironmentTarget,
    knownAlias = false,
  ) => {
    if (sshAddInFlight.current || sshProbe !== null) return;
    if (knownAlias) {
      await connectSavedBackendSshTarget(target);
      return;
    }
    if (
      !desktopOwnsSshHostConfig(desktopBridge, primaryHttpBaseUrl) ||
      primaryEnvironmentId === null
    ) {
      setSavedBackendError("Add new SSH hosts from the machine that runs this environment.");
      return;
    }
    if (!canWriteSsh) {
      setSavedBackendError("Manage settings permission is required to add an SSH host.");
      return;
    }
    sshAddInFlight.current = true;
    const generation = ++sshReviewGeneration.current;
    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    setPendingSshTarget(null);
    const probeHost = async () => {
      const result = await probeSshHost({
        environmentId: primaryEnvironmentId,
        input: {
          address: target.hostname,
          ...(target.username ? { user: target.username } : {}),
          ...(target.port !== null ? { port: target.port } : {}),
        },
      });
      if (generation !== sshReviewGeneration.current) return;
      if (result._tag === "Success") setSshProbe(result.value);
      else {
        const error = squashAtomCommandFailure(result);
        setSavedBackendError(
          isSshHostProbeError(error)
            ? sshHostProbeErrorText(error, target.port ?? 22)
            : error instanceof Error
              ? error.message
              : "Could not check this SSH host. Try again.",
        );
      }
    };
    await probeHost().finally(() => {
      sshAddInFlight.current = false;
      setIsAddingSavedBackend(false);
    });
  };

  const answerSshTrust = async (accepted: boolean) => {
    if (sshProbe === null || primaryEnvironmentId === null || sshAddInFlight.current) return;
    if (!desktopOwnsSshHostConfig(desktopBridge, primaryHttpBaseUrl)) {
      setSshProbe(null);
      setSavedBackendError("Add new SSH hosts from the machine that runs this environment.");
      return;
    }
    const probe = sshProbe;
    const generation = sshReviewGeneration.current;
    sshAddInFlight.current = true;
    setIsAddingSavedBackend(true);
    const trustAndConnect = async () => {
      const result = await trustSshHost({
        environmentId: primaryEnvironmentId,
        input: { probeId: probe.probeId, accepted },
      });
      if (generation !== sshReviewGeneration.current) return;
      setSshProbe(null);
      if (!accepted) return;
      if (result._tag === "Failure") {
        setSavedBackendError("Could not approve this host. Try adding it again.");
        return;
      }
      const message = sshSetupError(result.value, probe.host);
      if (message) {
        setSavedBackendError(message);
        return;
      }
      if (!readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)) {
        setSavedBackendError(
          "This device can't set up hosts on this environment. Ask its owner for full access.",
        );
        return;
      }
      const target = await desktopBridge!.resolveSshHost(probe.host);
      if (generation !== sshReviewGeneration.current) return;
      await connectSavedBackendSshTarget(target);
    };
    await trustAndConnect()
      .catch((error: unknown) => {
        setSavedBackendError(formatDesktopSshConnectionError(error));
      })
      .finally(() => {
        sshAddInFlight.current = false;
        setIsAddingSavedBackend(false);
      });
  };

  const handleAddSavedBackend = async () => {
    if (savedBackendMode === "ssh") {
      let target: DesktopSshEnvironmentTarget;
      try {
        target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        });
      } catch (error) {
        setSavedBackendError(formatDesktopSshConnectionError(error));
        return;
      }

      const known = discoveredSshHosts.find((host) => host.alias === savedBackendSshHost.trim());
      if (known && desktopBridge) {
        try {
          target = await desktopBridge.resolveSshHost(known.alias);
        } catch (error) {
          setSavedBackendError(formatDesktopSshConnectionError(error));
          return;
        }
      }
      await reviewSavedBackendSshTarget(target, known !== undefined);
      return;
    }

    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    let remotePairingInput: ReturnType<typeof parseRemotePairingFields>;
    try {
      remotePairingInput = parseRemotePairingFields({
        host: savedBackendHost,
        pairingCode: savedBackendPairingCode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add backend",
          description: message,
        }),
      );
      setIsAddingSavedBackend(false);
      return;
    }

    const result = await connectPairing({
      ...remotePairingInput,
      ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Failed to add backend.";
        setSavedBackendError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add backend",
            description: message,
          }),
        );
      }
      setIsAddingSavedBackend(false);
      return;
    }

    setSavedBackendHost("");
    setSavedBackendPairingCode("");
    setSavedBackendSshHost("");
    setSavedBackendSshUsername("");
    setSavedBackendSshPort("");
    setAddBackendDialogOpen(false);
    toastManager.add(
      routeTarget
        ? {
            type: "success",
            title: "Route added",
            description: `${routeTarget.label} now has another way to connect.`,
          }
        : {
            type: "success",
            title: "Device added",
            description: "This device is saved and will reconnect when GOAT starts.",
          },
    );
    setIsAddingSavedBackend(false);
  };

  const handleSavedBackendSshFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && savedBackendSshHost.trim().length > 0) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  // Resolves a picked alias before connecting it through the manual SSH flow.
  const handleSelectSshHostSuggestion = async (target: DesktopDiscoveredSshHost) => {
    if (isAddingSavedBackend || !desktopBridge) return;

    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    setSavedBackendSshHost(target.alias);
    let resolved: DesktopSshEnvironmentTarget;
    try {
      resolved = await desktopBridge.resolveSshHost(target.alias);
    } catch (error) {
      setSavedBackendError(formatDesktopSshConnectionError(error));
      setIsAddingSavedBackend(false);
      return;
    }
    setSavedBackendSshUsername(resolved.username ?? "");
    setSavedBackendSshPort(resolved.port === null ? "" : String(resolved.port));
    setIsAddingSavedBackend(false);
    await reviewSavedBackendSshTarget(resolved, true);
  };

  const handleSavedBackendSshHostKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    // The popup only renders when there is content, so an "open" flag alone is not enough.
    const isSshHostPopupVisible = sshHostSuggestionsOpen && hasSshHostSuggestionContent;
    if (isSshHostPopupVisible) {
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: { modelPickerOpen: false },
      });
      const index = threadJumpIndexFromCommand(command ?? "");
      // Claim every jump chord while the list is open, including ones past the last host;
      // otherwise the thread sidebar (mounted on Fleet) navigates away under the dialog.
      if (index !== null) {
        event.preventDefault();
        event.stopPropagation();
        const target = filteredDiscoveredSshHosts[index];
        if (target) {
          setSshHostSuggestionsOpen(false);
          void handleSelectSshHostSuggestion(target);
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    // A highlighted row means Enter belongs to the autocomplete, which selects it.
    const hasHighlightedSshHost =
      isSshHostPopupVisible && highlightedSshHostRef.current !== undefined;
    if (
      !event.defaultPrevented &&
      !hasHighlightedSshHost &&
      event.key === "Enter" &&
      savedBackendSshHost.trim().length > 0
    ) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const handleSetSavedBackendEnabled = async (environmentId: EnvironmentId, enabled: boolean) => {
    setSavedBackendError(null);
    const result = await setEnvironmentEnabled({ environmentId, enabled });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? error.message
          : `Failed to switch the backend ${enabled ? "on" : "off"}.`;
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not switch backend ${enabled ? "on" : "off"}`,
          description: message,
        }),
      );
    }
  };

  const removeSavedBackend = async (environment: EnvironmentPresentation) => {
    const environmentId = environment.environmentId;
    setRemovingSavedEnvironmentId(environmentId);
    setSavedBackendError(null);
    const target = savedDesktopSshTarget(environment);
    if (target) sshRuntime.forget(appAtomRegistry, { environmentId, target });
    const result = await removeEnvironment(environmentId);
    setRemovingSavedEnvironmentId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Failed to remove backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove backend",
          description: message,
        }),
      );
    }
  };

  // Removing forgets the pairing, credentials, and cached threads on this
  // device. Switching off is the reversible path, so removal always confirms.
  // T3 Connect environments get their own dialog: removing one here leaves its
  // account registration, so it points to where that can be deregistered.
  const [pendingT3ConnectRemoval, setPendingT3ConnectRemoval] =
    useState<EnvironmentPresentation | null>(null);
  const handleRemoveSavedBackend = async (environment: EnvironmentPresentation) => {
    if (environment.relayManaged && hasCloudPublicConfig()) {
      setPendingT3ConnectRemoval(environment);
      return;
    }
    // Fail closed: no mounted confirm host means no removal.
    const confirmed = await requestConfirmDialog(
      `Remove ${environment.label} from this device?\nThis forgets its pairing, credentials, and cached threads here. Switch it off instead to keep it saved.`,
      { variant: "destructive" },
    );
    if (confirmed === true) await removeSavedBackend(environment);
  };

  const confirmForgetSshHost = async () => {
    const environment = pendingForget;
    const target = environment && savedDesktopSshTarget(environment);
    if (
      !target ||
      primaryEnvironmentId === null ||
      forgetBusy ||
      !desktopOwnsSshHostConfig(desktopBridge, primaryHttpBaseUrl)
    )
      return;
    setForgetBusy(true);
    setForgetError(null);
    const forgetHost = async () => {
      const result = await forgetSshHost({
        environmentId: primaryEnvironmentId,
        input: { host: target.alias, stopRuntime: "if_idle" },
      });
      if (result._tag === "Failure") {
        setForgetError("Could not forget this host. Check your permissions and try again.");
        return;
      }
      const message = sshSetupError(result.value, target.alias);
      if (message) {
        setForgetError(message);
        return;
      }
      sshRuntime.forget(appAtomRegistry, { environmentId: environment.environmentId, target });
      if (removeForgottenConnection) await removeSavedBackend(environment);
      setPendingForget(null);
    };
    await forgetHost().finally(() => {
      setForgetBusy(false);
    });
  };

  const handleSavedBackendHostChange = (value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value);
    if (parsedPairingUrl) {
      setSavedBackendHost(parsedPairingUrl.host);
      setSavedBackendPairingCode(parsedPairingUrl.pairingCode);
      return;
    }
    setSavedBackendHost(value);
  };

  const renderConnectionModeCard = (input: {
    readonly mode: "remote" | "ssh";
    readonly title: string;
    readonly description: string;
    readonly icon?: ReactNode;
  }) => {
    const selected = savedBackendMode === input.mode;
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
          selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
        )}
        disabled={isAddingSavedBackend}
        onClick={() => {
          if (sshProbe !== null) void answerSshTrust(false);
          setPendingSshTarget(null);
          setSavedBackendMode(input.mode);
        }}
      >
        {input.icon ? (
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
              selected
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
            )}
          >
            {input.icon}
          </span>
        ) : null}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    );
  };

  const renderRemoteFields = () => (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">GOAT server</span>
          <Input
            value={savedBackendHost}
            onChange={(event) => handleSavedBackendHostChange(event.target.value)}
            placeholder="hub.tailnet-name.ts.net"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Pairing code</span>
          <Input
            value={savedBackendPairingCode}
            onChange={(event) => setSavedBackendPairingCode(event.target.value)}
            placeholder="PAIRCODE"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
      </div>
      <div>
        <span className="mt-1 block text-2xs text-muted-foreground">
          Paste a pairing link from a GOAT server on your tailnet to fill both fields.
        </span>
      </div>
    </div>
  );
  // T3 Connect is offered as a route when this account can reach the machine
  // through it and it is not one of the machine's routes yet.
  const relayRouteOffer =
    hasCloudPublicConfig() &&
    routeTarget !== null &&
    !routeTarget.relayManaged &&
    relayDiscoveryState.environments.has(routeTarget.environmentId)
      ? relayDiscoveryState.environments.get(routeTarget.environmentId)!.environment
      : null;
  const addRelayRoute = async () => {
    if (relayRouteOffer === null || routeTarget === null) return;
    setIsAddingSavedBackend(true);
    const result = await registerEnvironment(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: relayRouteOffer.environmentId,
          label: routeTarget.label,
        }),
      }),
    );
    setIsAddingSavedBackend(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setSavedBackendError(error instanceof Error ? error.message : "Could not add the route.");
      }
      return;
    }
    setAddBackendDialogOpen(false);
    toastManager.add({
      type: "success",
      title: "Route added",
      description: `${routeTarget.label} falls back to T3 Connect when its other routes are unreachable.`,
    });
  };
  const renderRemoteModeBody = () => (
    <div className="space-y-4">
      {relayRouteOffer !== null ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">
            This machine is on your T3 Connect account. Use it as a fallback route.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={isAddingSavedBackend}
            onClick={() => void addRelayRoute()}
          >
            Add T3 Connect
          </Button>
        </div>
      ) : null}
      {renderRemoteFields()}
      {savedBackendError ? <p className="text-xs text-destructive">{savedBackendError}</p> : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={isAddingSavedBackend}
        onClick={() => void handleAddSavedBackend()}
      >
        <PlusIcon className="size-3.5" />
        {isAddingSavedBackend ? "Adding…" : routeTarget ? "Add route" : "Add device"}
      </Button>
    </div>
  );
  const renderSshFields = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="block">
          <label
            htmlFor="saved-backend-ssh-host"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            SSH host or alias
          </label>
          <Autocomplete
            items={filteredDiscoveredSshHosts}
            itemToStringValue={(target) => target.alias}
            mode="none"
            openOnInputClick
            open={sshHostSuggestionsOpen}
            onOpenChange={setSshHostSuggestionsOpen}
            onItemHighlighted={(target) => {
              highlightedSshHostRef.current = target;
            }}
            value={savedBackendSshHost}
            onValueChange={(value, eventDetails) => {
              setSavedBackendSshHost(value);
              if (eventDetails.reason !== "item-press") return;

              const target = filteredDiscoveredSshHosts.find((host) => host.alias === value);
              if (target) void handleSelectSshHostSuggestion(target);
            }}
          >
            <AutocompleteInput
              id="saved-backend-ssh-host"
              onKeyDown={handleSavedBackendSshHostKeyDown}
              placeholder="Search hosts or type devbox"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
            {hasSshHostSuggestionContent ? (
              <AutocompletePopup>
                {isLoadingDiscoveredSshHosts ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">Loading hosts…</div>
                ) : filteredDiscoveredSshHosts.length > 0 ? (
                  <AutocompleteList className="max-h-72">
                    {filteredDiscoveredSshHosts.map((target, index) => {
                      const address = formatDesktopSshTarget(target);
                      const shortcutCommand = index < 9 ? threadJumpCommandForIndex(index) : null;
                      const shortcutLabel = shortcutCommand
                        ? shortcutLabelForCommand(keybindings, shortcutCommand, navigator.platform)
                        : null;
                      return (
                        <AutocompleteItem
                          key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                          value={target}
                          className="h-8 min-h-8 whitespace-nowrap"
                        >
                          <span className="min-w-0 truncate text-sm font-medium">
                            {target.alias}
                          </span>
                          {address !== target.alias ? (
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {address}
                            </span>
                          ) : (
                            <span className="flex-1" />
                          )}
                          {shortcutLabel ? (
                            <CommandShortcut className="shrink-0">{shortcutLabel}</CommandShortcut>
                          ) : null}
                        </AutocompleteItem>
                      );
                    })}
                  </AutocompleteList>
                ) : (
                  <AutocompleteEmpty className="break-all">
                    No hosts match "{savedBackendSshHost.trim()}".
                  </AutocompleteEmpty>
                )}
              </AutocompletePopup>
            ) : null}
          </Autocomplete>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Username</span>
            <Input
              value={savedBackendSshUsername}
              onChange={(event) => setSavedBackendSshUsername(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="root"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Port</span>
            <Input
              value={savedBackendSshPort}
              onChange={(event) => setSavedBackendSshPort(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="22"
              inputMode="numeric"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
        </div>
        {!ownsSshConfig ? (
          <p className="text-sm text-muted-foreground">
            Add new SSH hosts from the machine that runs this environment.
          </p>
        ) : null}
        {sshProbe ? (
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Trust this SSH host?</h4>
            <HandoffReview
              human={sshProbe.human}
              busy={isAddingSavedBackend}
              allowed={canWriteSsh && ownsSshConfig}
              approveLabel="Approve"
              onApprove={() => void answerSshTrust(true)}
              onDecline={() => void answerSshTrust(false)}
            />
          </div>
        ) : null}
        {pendingSshTarget && primaryEnvironmentId !== null ? (
          <SshRuntimeSettingsRow
            environmentId={primaryEnvironmentId}
            target={pendingSshTarget}
            enabled={addBackendDialogOpen}
            pendingAdd
            connecting={isAddingSavedBackend}
            originLabel={primaryEnvironment?.label ?? "this machine"}
            {...(isAddingSavedBackend
              ? {}
              : { onRetry: () => void connectSavedBackendSshTarget(pendingSshTarget) })}
          />
        ) : null}
        {savedBackendError || discoveredSshHostsError ? (
          <Alert variant="error">
            <AlertDescription>{savedBackendError ?? discoveredSshHostsError}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          variant="outline"
          className="w-full"
          disabled={isAddingSavedBackend || sshProbe !== null}
          onClick={() => void handleAddSavedBackend()}
        >
          <PlusIcon className="size-3.5" />
          {isAddingSavedBackend ? "Adding…" : routeTarget ? "Add route" : "Add device"}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <SettingsSection
        {...(searchable ? { id: searchableSetting("remote-environments").id } : {})}
        title={title}
        headerAction={
          <div className="flex items-center gap-1">
            {headerAction}
            {savedServerUpdateTargets.length > 0 ? (
              <ServerUpdatesAction targets={savedServerUpdateTargets} variant="ghost-muted" />
            ) : null}
            <Dialog
              open={addBackendDialogOpen}
              onOpenChange={(open) => {
                if (!open && isAddingSavedBackend) return;
                if (!open) {
                  if (sshProbe !== null) void answerSshTrust(false);
                  else sshReviewGeneration.current += 1;
                  setPendingSshTarget(null);
                }
                setAddBackendDialogOpen(open);
                if (open) {
                  setRouteTarget(null);
                } else {
                  setSavedBackendError(null);
                }
              }}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DialogTrigger
                      render={
                        <Button size="xs" variant="ghost-muted" aria-label="Add device">
                          <PlusIcon className="size-3" />
                          <span>Add device</span>
                        </Button>
                      }
                    />
                  }
                />
                <TooltipPopup side="top">Add device</TooltipPopup>
              </Tooltip>
              <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
                <DialogHeader>
                  <DialogTitle>
                    {routeTarget ? `Add a route to ${routeTarget.label}` : "Add device"}
                  </DialogTitle>
                  <DialogDescription>
                    {routeTarget
                      ? "Pair this machine again over another address, such as its Tailscale name. It joins the existing routes instead of adding a second machine."
                      : desktopBridge
                        ? "Connect another device using SSH or a GOAT server on your tailnet."
                        : "Connect to a GOAT server on your tailnet."}
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel>
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      {desktopBridge
                        ? renderConnectionModeCard({
                            mode: "ssh",
                            title: "SSH",
                            description: "Connect using this device’s SSH settings.",
                            icon: <TerminalIcon aria-hidden className="size-4" />,
                          })
                        : null}
                      {renderConnectionModeCard({
                        mode: "remote",
                        title: "Tailscale (GOAT server)",
                        description: "Pair with a GOAT server on your tailnet.",
                        icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
                      })}
                    </div>
                    <AnimatedHeight>
                      {savedBackendMode === "ssh" ? renderSshFields() : renderRemoteModeBody()}
                    </AnimatedHeight>
                  </div>
                </DialogPanel>
              </DialogPopup>
            </Dialog>
          </div>
        }
      >
        {listedEnvironments.map((environment) => (
          <SavedBackendListRow
            key={environment.environmentId}
            environment={environment}
            removingEnvironmentId={removingSavedEnvironmentId}
            onSetEnabled={handleSetSavedBackendEnabled}
            onRemove={handleRemoveSavedBackend}
            onForget={
              ownsSshConfig && canWriteSsh
                ? (target) => {
                    setPendingForget(target);
                    setRemoveForgottenConnection(false);
                    setForgetError(null);
                  }
                : undefined
            }
            onReviewTrust={(target) => {
              const sshTarget = savedDesktopSshTarget(target);
              if (!sshTarget) return;
              setRouteTarget(null);
              setSavedBackendMode("ssh");
              setSavedBackendSshHost(sshTarget.hostname);
              setSavedBackendSshUsername(sshTarget.username ?? "");
              setSavedBackendSshPort(sshTarget.port === null ? "" : String(sshTarget.port));
              setAddBackendDialogOpen(true);
            }}
            onAddRoute={(target) => {
              setRouteTarget(target);
              setSavedBackendError(null);
              setAddBackendDialogOpen(true);
            }}
          />
        ))}
        <CloudRemoteEnvironmentRows
          primaryEnvironmentId={primaryEnvironmentId}
          savedEnvironments={savedEnvironments}
        />
      </SettingsSection>
      {hasCloudPublicConfig() ? (
        <RemoveT3ConnectEnvironmentDialog
          environmentLabel={pendingT3ConnectRemoval?.label ?? null}
          onCancel={() => setPendingT3ConnectRemoval(null)}
          onConfirm={() => {
            if (!pendingT3ConnectRemoval) return;
            setPendingT3ConnectRemoval(null);
            void removeSavedBackend(pendingT3ConnectRemoval);
          }}
        />
      ) : null}
      <AlertDialog
        open={pendingForget !== null}
        onOpenChange={(open) => {
          if (!open && !forgetBusy) setPendingForget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Forget {pendingForget ? savedDesktopSshTarget(pendingForget)?.alias : "host"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              GOAT removes its SSH entry and stops its server there when no work is running.
              Projects and files on the host stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={removeForgottenConnection}
              disabled={forgetBusy}
              onCheckedChange={(checked) => setRemoveForgottenConnection(checked === true)}
            />
            Also remove this connection from Connections
          </label>
          {forgetError ? (
            <p role="alert" className="text-sm text-destructive">
              {forgetError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button variant="outline" disabled={forgetBusy} onClick={() => setPendingForget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={forgetBusy || !canWriteSsh || !ownsSshConfig}
              onClick={() => void confirmForgetSshHost()}
            >
              {forgetBusy ? "Forgetting…" : "Forget host"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
