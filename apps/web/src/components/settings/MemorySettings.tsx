import { XIcon } from "../solar";
import { MemoryAdministration } from "./MemorySharingSettings";
import { randomUUID } from "../../lib/utils";
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react";
import {
  AuthMemoryReadScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  MemoryOperationId,
  MemorySpaceId,
  MemoryId,
  type MemoryHistoryPage,
  type MemoryRevisionId,
  type MemoryRevertResolutionInput,
  type MemoryRevertResult,
  type ScopedThreadRef,
  type MessageId,
  type MemoryItem,
  type MemorySyncStatus,
  type MemoryReportDelivery,
} from "@goat/contracts";
import {
  presentMemoryItem,
  presentMemoryResolution,
  presentMemoryRevert,
  presentMemoryRevertResult,
  presentMemoryReport,
  presentMemorySync,
} from "@goat/client-runtime/memory-presentation";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useEnvironment, useEnvironments } from "../../state/environments";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
  usePreparedConnection,
} from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { memoryEnvironment } from "../../state/memory";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
import { formatTimestamp } from "../../timestampFormat";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";
import {
  isMemoryEnvironmentAvailable,
  memorySettingsDestination,
  memoryForgetIntent,
  validateMemorySettingsSearch,
  type MemorySettingsSearch,
} from "./MemorySettings.logic";

/** Navigation only. A missing space opens the explicit destination chooser. */
export function MemorySettingsEntry({
  environmentId,
  reference,
  label = "Memory",
}: {
  environmentId: EnvironmentId;
  reference?: unknown;
  label?: string;
}) {
  const environment = useEnvironment(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthMemoryReadScope);
  const navigate = useNavigate();
  const target =
    reference === undefined
      ? validateMemorySettingsSearch({ environmentId })
      : memorySettingsDestination(reference);
  if (
    !target ||
    target.environmentId !== environmentId ||
    !canRead ||
    !isMemoryEnvironmentAvailable(environment?.serverConfig?.environment.capabilities)
  )
    return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => void navigate({ to: "/settings/memory", search: target, hash: "" })}
    >
      {label}
    </Button>
  );
}

export function MemorySettings({ target }: { target: MemorySettingsSearch }) {
  const { environments } = useEnvironments();
  const environment = useEnvironment(target.environmentId ?? null);
  const navigate = useNavigate();
  if (!target.environmentId)
    return (
      <SettingsPageContainer>
        <SettingsSection title="Memory">
          <SettingsRow
            title="Choose a device"
            description="Select the device whose memory you want to manage."
          />
          {environments
            .filter((item) =>
              isMemoryEnvironmentAvailable(item.serverConfig?.environment.capabilities),
            )
            .map((item) => (
              <SettingsRow
                key={item.environmentId}
                title={item.label}
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void navigate({
                        to: "/settings/memory",
                        search: validateMemorySettingsSearch({ environmentId: item.environmentId }),
                        hash: "",
                      })
                    }
                  >
                    Open Memory
                  </Button>
                }
              />
            ))}
        </SettingsSection>
      </SettingsPageContainer>
    );
  if (!isMemoryEnvironmentAvailable(environment?.serverConfig?.environment.capabilities))
    return (
      <SettingsPageContainer>
        <SettingsSection title="Memory">
          <SettingsRow
            title="Memory unavailable"
            description="Update or reconnect the selected environment to use Memory."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  return (
    <MemoryDestination
      key={`${target.environmentId}:${target.memorySpaceId ?? ""}`}
      target={target}
      environmentId={target.environmentId}
    />
  );
}

function MemoryDestination({
  target,
  environmentId,
}: {
  target: MemorySettingsSearch;
  environmentId: EnvironmentId;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthMemoryReadScope);
  const prepared = usePreparedConnection(environmentId);
  // Reconnection drops all open forms and command results; no prior destination survives.
  const connection = Option.getOrNull(prepared);
  const [identity, setIdentity] = useState({ value: connection, key: 0 });
  if (identity.value !== connection) setIdentity({ value: connection, key: identity.key + 1 });
  return (
    <SettingsPageContainer>
      {connection === null ? (
        <SettingsSection title="Memory">
          <SettingsRow
            title="Device disconnected"
            description="Reconnect this environment to continue."
          />
        </SettingsSection>
      ) : (
        <MemoryDestinationContent
          key={`${identity.key}:${canRead}`}
          target={target}
          environmentId={environmentId}
          canRead={canRead}
        />
      )}
    </SettingsPageContainer>
  );
}

/** Metadata commands have no body cache. Revoke/disconnect unmounts their owning content. */
function MemoryDestinationContent({
  target,
  environmentId,
  canRead,
}: {
  target: MemorySettingsSearch;
  environmentId: EnvironmentId;
  canRead: boolean;
}) {
  const canAdmin = useAtomValue(memoryEnvironment.hubSettingsGet.permissionAtom(environmentId));
  const canSync = useAtomValue(memoryEnvironment.syncStatus.permissionAtom(environmentId));
  const getSync = useAtomCommand(memoryEnvironment.syncStatus, { reportFailure: false });
  const [sync, setSync] = useState<MemorySyncStatus | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncReload, setSyncReload] = useState(0);
  const refreshSync = useCallback(() => {
    setSync(null);
    setSyncError(null);
    setSyncReload((value) => value + 1);
  }, []);

  useEffect(() => {
    let current = true;
    setSyncError(null);
    if (!canSync) setSync(null);
    if (canSync)
      void getSync({ environmentId, input: {} }).then((result) => {
        if (!current) return;
        if (result._tag === "Success") setSync(result.value);
        else setSyncError("Could not load memory sharing status.");
      });
    return () => {
      current = false;
    };
  }, [canSync, environmentId, getSync, syncReload]);
  const refreshBootstrap = useCallback(() => setSyncReload((value) => value + 1), []);
  const readySpace =
    sync && sync.state !== "disabled" && sync.state !== "bootstrapping" ? sync.memorySpaceId : null;
  const [savedSpace, setSavedSpace] = useState<MemorySpaceId | null>(null);
  if (readySpace && readySpace !== savedSpace) setSavedSpace(readySpace);
  const memorySpaceId = target.memorySpaceId ?? readySpace ?? savedSpace;

  return (
    <>
      {canRead && sync?.state === "bootstrapping" && sync.memorySpaceId ? (
        <MemoryBootstrapRefresh
          environmentId={environmentId}
          memorySpaceId={sync.memorySpaceId}
          onChange={refreshBootstrap}
        />
      ) : null}
      {canAdmin ? (
        <MemoryAdministration
          environmentId={environmentId}
          onSharingRefresh={refreshSync}
          sync={sync}
        />
      ) : (
        <SettingsSection title="Sharing">
          <SettingsRow
            title="Sharing unavailable"
            description="Settings write permission is required to manage sharing."
          />
        </SettingsSection>
      )}
      {syncError ? (
        <SettingsSection title="Memory status">
          <SettingsRow
            title="Could not load memory status"
            description={<span role="alert">{syncError}</span>}
            control={
              <Button size="sm" variant="outline" onClick={refreshSync}>
                Retry
              </Button>
            }
          />
        </SettingsSection>
      ) : null}
      {!memorySpaceId ? (
        <SettingsSection title="Memories" id="memory-records">
          <SettingsRow
            title={
              sync?.state === "disabled"
                ? "Turn on memory to see and save memories."
                : "Memory is getting ready."
            }
            description={
              sync && sync.state !== "disabled" ? presentMemorySync(sync).label : undefined
            }
          />
        </SettingsSection>
      ) : canRead ? (
        <MemoryRecords
          key={memorySpaceId}
          target={target}
          environmentId={environmentId}
          memorySpaceId={memorySpaceId}
          memoryEnabled={
            sync !== null && sync.state !== "disabled" && sync.state !== "bootstrapping"
          }
        />
      ) : (
        <SettingsSection title="Memories">
          <SettingsRow
            title="Memory read permission required"
            description="Memory read permission is required to view records. Write permission does not grant read access."
          />
        </SettingsSection>
      )}
    </>
  );
}

/** Bootstrap commits emit memory resets. Follow those signals instead of polling status. */
function MemoryBootstrapRefresh({
  environmentId,
  memorySpaceId,
  onChange,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  onChange: () => void;
}) {
  const exposure = useAtomValue(
    memoryEnvironment.exposureAtom({ environmentId, input: { memorySpaceId } }),
  );
  useEffect(() => {
    onChange();
  }, [exposure, onChange]);
  return null;
}

export { MemoryAdministration } from "./MemorySharingSettings";

function MemoryRecords({
  target,
  environmentId,
  memorySpaceId,
  memoryEnabled,
}: {
  target: MemorySettingsSearch;
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  memoryEnabled: boolean;
}) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const writePermission = useAtomValue(memoryEnvironment.upsert.permissionAtom(environmentId));
  const canWrite = writePermission && memoryEnabled;
  const [quarantine, setQuarantine] = useState(false);
  const navigate = useNavigate();
  if (!canWrite && adding) setAdding(false);
  const input = { memorySpaceId, limit: 40, ...(cursor ? { cursor } : {}) };
  const page = useEnvironmentQuery(
    query
      ? memoryEnvironment.search({ environmentId, input: { ...input, query, mode: "substring" } })
      : memoryEnvironment.list({
          environmentId,
          input: { ...input, includeQuarantined: quarantine },
        }),
  );
  const value = page.data ? Option.getOrNull(page.data) : null;
  const items = value?.items ?? [];
  const [listLayout, setListLayout] = useState<{
    items: readonly MemoryItem[];
    height: number;
    sizes: ReadonlyMap<string, number>;
  } | null>(null);
  function select(item: MemoryItem) {
    void navigate({
      to: "/settings/memory",
      search: validateMemorySettingsSearch({
        environmentId,
        memorySpaceId,
        memoryId: item.memoryId,
      }),
      hash: "",
    });
  }
  return (
    <>
      <SettingsSection title="Memories" id="memory-records">
        <SettingsRow
          title="Save a memory"
          description={
            memoryEnabled
              ? "Add something you want this device to remember."
              : "Saved memories stay. Turn on memory to save new memories."
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite}
              onClick={() => setAdding(true)}
            >
              Remember something
            </Button>
          }
        />
        {adding && canWrite ? (
          <SettingsRow title="New memory">
            <MemoryEditor
              environmentId={environmentId}
              memorySpaceId={memorySpaceId}
              onClose={() => {
                setAdding(false);
                page.refresh();
              }}
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          title="Search memories"
          control={
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setCursor(undefined);
                setQuery(queryInput.trim());
              }}
            >
              <Input
                aria-label="Search memories"
                placeholder="Search memories"
                value={queryInput}
                onChange={(event) => setQueryInput(event.currentTarget.value)}
              />
              <Button type="submit" size="sm" variant="outline">
                Search
              </Button>
              {queryInput || query ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setQueryInput("");
                    setQuery("");
                    setCursor(undefined);
                  }}
                >
                  Clear search
                </Button>
              ) : null}
            </form>
          }
        />
        <SettingsRow
          title="Quarantined memories"
          description="Review memories that need attention."
          control={
            <Switch
              aria-label="Include quarantined memories"
              checked={quarantine}
              onCheckedChange={(checked) => {
                setQuarantine(checked);
                setCursor(undefined);
              }}
            />
          }
        />
        {page.error ? (
          <SettingsRow
            title="Could not load memories"
            description={<span role="alert">{page.error}</span>}
            control={
              <Button size="sm" variant="outline" onClick={page.refresh}>
                Retry
              </Button>
            }
          />
        ) : null}
        {notice ? <SettingsRow title={<span role="status">{notice}</span>} /> : null}
        {!value && !page.error ? (
          <SettingsRow
            title="Loading memories"
            description="Reconnect this device if records do not appear."
          />
        ) : !value ? null : items.length === 0 ? (
          <SettingsRow
            title="No memories yet"
            description="Memories saved on this device will appear here."
          />
        ) : (
          <LegendList
            data={items}
            keyExtractor={(item) => item.memoryId}
            estimatedItemSize={72}
            style={{
              height:
                listLayout?.items === items ? listLayout.height : Math.min(320, items.length * 88),
            }}
            onItemSizeChanged={({ itemKey, size }) => {
              setListLayout((previous) => {
                if (previous?.items === items && previous.sizes.get(itemKey) === size)
                  return previous;
                const sizes = new Map(previous?.items === items ? previous.sizes : []);
                sizes.set(itemKey, size);
                const height = Math.min(
                  320,
                  Math.ceil(
                    items.reduce((total, item) => total + (sizes.get(item.memoryId) ?? 88), 0),
                  ),
                );
                return { items, height, sizes };
              });
            }}
            renderItem={({ item }) => (
              <SettingsRow
                title={
                  item.status === "active" ? (
                    item.payload.text.slice(0, 120)
                  ) : item.status === "forgotten" ? (
                    <span className="text-muted-foreground">Forgotten memory</span>
                  ) : (
                    presentMemoryItem(item).label
                  )
                }
                description={
                  item.status === "forgotten"
                    ? `Forgotten ${formatTimestamp(item.tombstone.deletedAtUtc, "locale")}. Content has been removed.`
                    : presentMemoryItem(item).syncLabel
                }
                control={
                  <Button size="sm" variant="ghost" onClick={() => select(item)}>
                    Open
                  </Button>
                }
              />
            )}
          />
        )}
        {cursor || value?.nextCursor ? (
          <SettingsRow
            title="Browse memories"
            control={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={cursor === undefined}
                  onClick={() => setCursor(undefined)}
                >
                  First page
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!value?.nextCursor}
                  onClick={() => {
                    if (value?.nextCursor) setCursor(value.nextCursor);
                  }}
                >
                  Next page
                </Button>
              </div>
            }
          />
        ) : null}
      </SettingsSection>
      {target.memoryId ? (
        <MemoryDetails
          key={target.memoryId}
          target={target}
          environmentId={environmentId}
          memorySpaceId={memorySpaceId}
          memoryEnabled={memoryEnabled}
          onForgotten={(message) => {
            setNotice(message);
            page.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function MemoryDetails({
  target,
  environmentId,
  memorySpaceId,
  onForgotten,
  memoryEnabled,
}: {
  target: MemorySettingsSearch;
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  onForgotten: (message: string) => void;
  memoryEnabled: boolean;
}) {
  const { environments } = useEnvironments();
  const deviceName = (id: EnvironmentId) =>
    environments.find((e) => e.environmentId === id)?.label ?? "Unknown device";
  const memoryId = target.memoryId!;
  const [editing, setEditing] = useState(false);
  const writePermission = useAtomValue(memoryEnvironment.upsert.permissionAtom(environmentId));
  const canWrite = writePermission && memoryEnabled;
  const read = useEnvironmentQuery(
    memoryEnvironment.read({ environmentId, input: { memorySpaceId, memoryId } }),
  );
  const [cursor, setCursor] = useState<string | undefined>();
  const history = useEnvironmentQuery(
    memoryEnvironment.history({
      environmentId,
      input: { memorySpaceId, memoryId, limit: 40, ...(cursor ? { cursor } : {}) },
    }),
  );
  const item = read.data ? Option.getOrNull(read.data) : null;
  if ((item === null || !canWrite) && editing) setEditing(false);
  const value = history.data ? Option.getOrNull(history.data) : null;
  const navigate = useNavigate();
  const detailsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    detailsRef.current?.scrollIntoView?.({ block: "start" });
    detailsRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <SettingsSection title="Memory details" id="memory-details">
      <SettingsRow
        title={item?.status === "forgotten" ? "Forgotten memory" : "Memory"}
        control={
          <div className="flex items-center justify-end gap-2">
            {item?.status === "active" && canWrite ? (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
            <MemoryForgetControl
              environmentId={environmentId}
              item={item}
              label="Forget"
              onForgotten={(message) => {
                onForgotten(message);
                void navigate({
                  to: "/settings/memory",
                  search: validateMemorySettingsSearch({ environmentId, memorySpaceId }),
                  hash: "",
                });
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close details"
              onClick={() =>
                void navigate({
                  to: "/settings/memory",
                  search: validateMemorySettingsSearch({ environmentId, memorySpaceId }),
                  hash: "",
                })
              }
            >
              <XIcon />
            </Button>
          </div>
        }
      >
        <div ref={detailsRef} tabIndex={-1} aria-label="Memory details" className="space-y-3">
          {read.error || history.error ? <p role="alert">{read.error ?? history.error}</p> : null}
          {item ? (
            <>
              {item.status !== "active" ? (
                <p>
                  {item.status === "forgotten"
                    ? `Content has been removed. Forgotten ${formatTimestamp(item.tombstone.deletedAtUtc, "locale")}.`
                    : presentMemoryItem(item).label}
                </p>
              ) : null}
              <p>
                {presentMemoryItem(item).syncLabel} {presentMemoryItem(item).cleanupLabel}
              </p>
              {item.status === "active" ? (
                <p className="whitespace-pre-wrap break-words">{item.payload.text}</p>
              ) : null}
              {item.status === "active" && canWrite ? (
                <>
                  {editing ? (
                    <MemoryEditor
                      key={item.revision.revisionId}
                      environmentId={environmentId}
                      memorySpaceId={memorySpaceId}
                      item={item}
                      onClose={() => {
                        setEditing(false);
                        read.refresh();
                        history.refresh();
                      }}
                    />
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <p role="status">This memory is unavailable. Visible details have been cleared.</p>
          )}
          {item && item.status !== "forgotten" && value ? (
            <>
              {value.resolutions.length > 0 ? (
                <h3 className="text-sm font-medium">Resolution history</h3>
              ) : null}
              {value.resolutions.map((entry) => {
                const display = presentMemoryResolution(entry);
                return (
                  <MemoryHistoryDisclosure
                    key={entry.resolution.resolutionId}
                    title="Resolution"
                    description={`${display.label} · ${display.providerLabel} · ${formatTimestamp(display.appliedAtUtc, "locale")}`}
                    defaultOpen={target.resolutionId === entry.resolution.resolutionId}
                  >
                    <p>Effective model: {display.effectiveModel}</p>
                    <p>Resolved on {deviceName(display.resolvingEnvironmentId)}</p>
                    <p>Revert deadline: {formatTimestamp(display.revertDeadlineUtc, "locale")}</p>
                    <p>{entry.payload?.judgment ?? "Retained judgment unavailable."}</p>
                    {item && memoryEnabled ? (
                      <MemoryRevertControl
                        environmentId={environmentId}
                        item={item}
                        entry={entry}
                        history={value}
                        onSettled={() => {
                          read.refresh();
                          history.refresh();
                        }}
                      />
                    ) : null}
                  </MemoryHistoryDisclosure>
                );
              })}
              {value.revisions.length > 0 ? <h3 className="text-sm font-medium">History</h3> : null}
              {value.revisions.map((entry, index) => (
                <MemoryHistoryDisclosure
                  key={entry.revision.revisionId}
                  title={`${value.resolutions.some(({ resolution }) => resolution.inputRevisionIds.includes(entry.revision.revisionId)) ? "Original" : "Version"} ${index + 1}`}
                  description={formatTimestamp(entry.revision.createdAtUtc, "locale")}
                >
                  <p className="whitespace-pre-wrap break-words">
                    {entry.payload?.text ?? "Version unavailable."}
                  </p>
                  <p>Saved on {deviceName(entry.revision.provenance.environmentId)}</p>
                  {entry.payload?.evidence
                    .filter(
                      (evidence) =>
                        evidence.sourceThread !== undefined && evidence.messageIds.length > 0,
                    )
                    .map((evidence) => (
                      <MemorySourceControl
                        key={`${evidence.sourceThread!.environmentId}:${evidence.sourceThread!.threadId}:${evidence.messageIds.join(",")}`}
                        environmentId={environmentId}
                        memorySpaceId={memorySpaceId}
                        memoryId={memoryId}
                        sourceThread={evidence.sourceThread!}
                        messageIds={evidence.messageIds}
                      />
                    ))}
                </MemoryHistoryDisclosure>
              ))}
              {value.revertResults.map((result) => (
                <p key={result.operationId}>{presentMemoryRevertResult(result).label}</p>
              ))}
              {value.reports.map((report) => (
                <MemoryReportControl key={report.reportId} report={report} />
              ))}
              {cursor || value.nextCursor ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!cursor}
                    onClick={() => setCursor(undefined)}
                  >
                    First history page
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!value.nextCursor}
                    onClick={() => {
                      if (value.nextCursor) setCursor(value.nextCursor);
                    }}
                  >
                    Next history page
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function MemoryHistoryDisclosure({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SettingsRow
        title={title}
        description={description}
        control={
          <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
            {open ? "Close" : "Open"} {title}
          </CollapsibleTrigger>
        }
      />
      <CollapsiblePanel animate={false}>
        <div className="space-y-3 px-4 pb-4 text-sm">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Revalidate the selected original and live destination at admission and settlement. */
export function MemoryRevertControl({
  environmentId,
  item,
  entry,
  history,
  onSettled,
}: {
  environmentId: EnvironmentId;
  item: MemoryItem;
  entry: MemoryHistoryPage["resolutions"][number];
  history: Pick<MemoryHistoryPage, "revertResults" | "revisions" | "nextCursor">;
  onSettled: () => void;
}) {
  const { environments } = useEnvironments();
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(memoryEnvironment.revertResolution.permissionAtom(environmentId));
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const revert = useAtomCommand(memoryEnvironment.revertResolution, { reportFailure: false });
  const [selected, setSelected] = useState<MemoryRevisionId | null>(null);
  const [intent, setIntent] = useState<MemoryRevertResolutionInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MemoryRevertResult | null>(null);
  const [openedAt] = useState(Date.now);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const display = presentMemoryRevert({
    item,
    entry,
    history,
    now: openedAt,
    ...(selected ? { restoredRevisionId: selected } : {}),
  });
  const available = canWrite && connection !== null && display.canRevert;
  if (
    (!available ||
      (intent &&
        (item.status !== "active" || intent.expectedHeads[0] !== item.revision.revisionId))) &&
    selected !== null
  ) {
    setSelected(null);
    setIntent(null);
    setError(null);
  }
  function liveDestination() {
    return (
      mounted.current &&
      connection !== null &&
      readPreparedConnection(environmentId) === connection &&
      registry.get(memoryEnvironment.revertResolution.permissionAtom(environmentId))
    );
  }
  async function submit() {
    if (!selected || busy || result || !liveDestination() || item.status !== "active") return;
    const eligibility = presentMemoryRevert({
      item,
      entry,
      history,
      restoredRevisionId: selected,
      now: Date.now(),
    });
    if (!eligibility.canRevert) return;
    const input = intent ?? {
      operationId: MemoryOperationId.make(randomUUID()),
      memorySpaceId: item.memorySpaceId,
      memoryId: item.memoryId,
      resolutionId: entry.resolution.resolutionId,
      restoredRevisionId: selected,
      expectedHeads: [item.revision.revisionId],
    };
    setIntent(input);
    setBusy(true);
    setError(null);
    const response = await revert({ environmentId, input });
    if (!mounted.current) return;
    setBusy(false);
    if (!liveDestination()) return;
    if (response._tag === "Failure") {
      setError("Revert request failed. Try again to continue this request.");
      return;
    }
    setResult(response.value);
    setSelected(null);
    setIntent(null);
    onSettled();
  }
  return (
    <div>
      <p>{display.windowLabel}</p>
      {display.timeNotice ? <p>{display.timeNotice}</p> : null}
      {display.reason ? <p>{display.reason}</p> : null}
      {!canWrite ? <p>Memory write permission is required to revert.</p> : null}
      {result ? <p role="status">{presentMemoryRevertResult(result).label}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!result && available ? (
        <div role="group" aria-label="Revert confirmation">
          <p>Choose the retained original to restore.</p>
          {display.restorableRevisionIds.map((revisionId) => {
            const index = history.revisions.findIndex(
              (entry) => entry.revision.revisionId === revisionId,
            );
            const original = history.revisions[index]!;
            return (
              <label key={revisionId} className="block space-x-2">
                <input
                  type="radio"
                  name={`revert-${entry.resolution.resolutionId}`}
                  value={revisionId}
                  checked={selected === revisionId}
                  disabled={busy || intent !== null}
                  onChange={() => setSelected(revisionId)}
                />
                <span>
                  Original {index + 1} · {formatTimestamp(original.revision.createdAtUtc, "locale")}{" "}
                  ·{" "}
                  {environments.find(
                    (device) => device.environmentId === original.revision.provenance.environmentId,
                  )?.label ?? "Unknown device"}
                </span>
                <p className="whitespace-pre-wrap break-words">{original.payload?.text}</p>
              </label>
            );
          })}
          <Button
            size="sm"
            variant="outline"
            disabled={!selected || busy}
            onClick={() => void submit()}
          >
            Revert resolution
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setSelected(null);
              setIntent(null);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function MemoryForgetControl({
  label = "Forget memory",
  environmentId,
  item,
  onForgotten,
}: {
  environmentId: EnvironmentId;
  item: MemoryItem | null;
  label?: string;
  onForgotten?: ((message: string) => void) | undefined;
}) {
  const canForget = useAtomValue(memoryEnvironment.forget.permissionAtom(environmentId));
  return (
    <MemoryForgetRequest
      key={String(canForget)}
      environmentId={environmentId}
      item={item}
      canForget={canForget}
      label={label}
      onForgotten={onForgotten}
    />
  );
}

function MemoryForgetRequest({
  label,
  environmentId,
  item,
  canForget,
  onForgotten,
}: {
  environmentId: EnvironmentId;
  item: MemoryItem | null;
  canForget: boolean;
  label: string;
  onForgotten?: ((message: string) => void) | undefined;
}) {
  const registry = useContext(RegistryContext);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const forget = useAtomCommand(memoryEnvironment.forget, { reportFailure: false });
  const [intent, setIntent] = useState<ReturnType<typeof memoryForgetIntent>>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const imported = useRef(false);
  const available = item !== null && presentMemoryItem(item).canForget;
  function liveDestination() {
    return (
      mounted.current &&
      connection !== null &&
      readPreparedConnection(environmentId) === connection &&
      readEnvironmentScope(environmentId, AuthMemoryReadScope) &&
      registry.get(memoryEnvironment.forget.permissionAtom(environmentId))
    );
  }
  async function submit() {
    if (!intent || busy || !liveDestination()) return;
    setBusy(true);
    const result = await forget({ environmentId, input: intent });
    if (!liveDestination()) return;
    setBusy(false);
    if (result._tag === "Success") {
      if (result.value.outcome === "rejected") {
        setMessage("Could not forget this memory. Review the record before trying again.");
        setIntent(null);
        return;
      }
      const notice =
        "Forgotten. Other devices remove it when they sync." +
        (imported.current
          ? " The provider's original conversation stays, but forgotten content is never imported again."
          : "");
      setMessage(notice);
      onForgotten?.(notice);
      setIntent(null);
    } else setMessage("Forget request failed. Try again to continue this request.");
  }
  return (
    <div>
      {message ? <p role="status">{message}</p> : null}
      {available || intent ? (
        intent && canForget ? (
          <div role="group" aria-label="Forget confirmation">
            <p>Forget this memory? This cannot be undone.</p>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void submit()}>
              Confirm forget
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setIntent(null);
                setMessage(null);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!canForget}
            onClick={() => {
              if (item && liveDestination()) {
                imported.current =
                  item.status === "active" &&
                  item.payload.evidence.some((e) => e.origin === "import");
                setIntent(memoryForgetIntent(item));
              }
            }}
          >
            {label}
          </Button>
        )
      ) : null}
    </div>
  );
}

function MemoryReportControl({ report }: { report: MemoryReportDelivery }) {
  const display = presentMemoryReport(report);
  const destination = display.reportTarget;
  const environment = useEnvironment(destination?.environmentId ?? null);
  const canRead = useEnvironmentScope(
    destination?.environmentId ?? null,
    AuthOrchestrationReadScope,
  );
  const navigate = useNavigate();
  return (
    <div>
      <p>{display.label}</p>
      {display.failureCode ? <p>{display.failureCode}</p> : null}
      {destination ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={!canRead || environment?.connection.phase !== "connected"}
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: destination.environmentId, threadId: destination.threadId },
              search: {},
              hash: "",
            })
          }
        >
          Open report
        </Button>
      ) : null}
      {report.state === "failed" ? (
        <p>Manual report retry is not available in this environment version.</p>
      ) : null}
    </div>
  );
}

function MemoryEditor({
  environmentId,
  memorySpaceId,
  item,
  onClose,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  item?: Extract<MemoryItem, { status: "active" }>;
  onClose: () => void;
}) {
  const [id] = useState(() => item?.memoryId ?? MemoryId.make(randomUUID()));
  const [operationId, setOperationId] = useState<MemoryOperationId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = memoryEnvironment.draftAtom({
    environmentId,
    input: { memorySpaceId },
    draftId: `editor:${id}`,
  });
  const [text, setText] = useAtom(draft);
  const registry = useContext(RegistryContext);
  const upsert = useAtomCommand(memoryEnvironment.upsert, { reportFailure: false });
  const canWrite = useAtomValue(memoryEnvironment.upsert.permissionAtom(environmentId));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (item) registry.set(draft, { text: item.payload.text, memoryIds: [id] });
    return () => {
      mounted.current = false;
      registry.set(draft, null);
    };
  }, [draft, id, item, registry]);
  if (!canWrite || (item && text === null))
    return (
      <div>
        <p>Editing unavailable. Close this editor and reload the memory.</p>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close editor
        </Button>
      </div>
    );
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          busy ||
          !text?.trim() ||
          !registry.get(memoryEnvironment.upsert.permissionAtom(environmentId))
        )
          return;
        const intentId = operationId ?? MemoryOperationId.make(randomUUID());
        setOperationId(intentId);
        setBusy(true);
        const result = await upsert({
          environmentId,
          input: {
            memorySpaceId,
            memoryId: id,
            operationId: intentId,
            expectedHeads: item ? [item.revision.revisionId] : [],
            scope: item?.scope ?? { kind: "user" },
            assertionKind: item?.revision.assertionKind ?? "fact",
            payload: {
              text,
              evidence: item?.payload.evidence ?? [{ origin: "user", messageIds: [] }],
              derivedFromMemoryRevisions: item?.payload.derivedFromMemoryRevisions ?? [],
            },
            baseBoundary: null,
          },
        });
        if (
          !mounted.current ||
          !registry.get(memoryEnvironment.upsert.permissionAtom(environmentId))
        )
          return;
        setBusy(false);
        if (result._tag === "Success" && result.value.outcome !== "rejected") onClose();
        else
          setError("Memory update failed. Retry the same request or close the editor and reload.");
      }}
    >
      <Textarea
        aria-label="Memory text"
        value={text ?? ""}
        disabled={busy || operationId !== null}
        onChange={(event) =>
          setText({ text: event.currentTarget.value, memoryIds: item ? [id] : [] })
        }
      />
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" size="sm" disabled={busy || !text?.trim()}>
        {operationId ? "Retry memory request" : "Save memory"}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
    </form>
  );
}

function MemorySourceControl({
  environmentId,
  memorySpaceId,
  memoryId,
  sourceThread,
  messageIds,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  memoryId: MemoryId;
  sourceThread: ScopedThreadRef;
  messageIds: ReadonlyArray<MessageId>;
}) {
  const [open, setOpen] = useState(false);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return (
    <div>
      <p>Original conversation</p>
      <Button size="sm" variant="ghost" disabled={!canRead} onClick={() => setOpen(!open)}>
        {open ? "Close original" : "Read original"}
      </Button>
      {open && canRead ? (
        <MemorySourcePage
          environmentId={environmentId}
          memorySpaceId={memorySpaceId}
          memoryId={memoryId}
          sourceThread={sourceThread}
          messageIds={messageIds}
        />
      ) : null}
    </div>
  );
}
function MemorySourcePage({
  environmentId,
  memorySpaceId,
  memoryId,
  sourceThread,
  messageIds,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  memoryId: MemoryId;
  sourceThread: ScopedThreadRef;
  messageIds: ReadonlyArray<MessageId>;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useEnvironmentQuery(
    memoryEnvironment.readSource({
      environmentId,
      input: {
        memorySpaceId,
        memoryId,
        sourceThread,
        messageIds,
        limit: 40,
        ...(cursor ? { cursor } : {}),
      },
    }),
  );
  const page = query.data ? Option.getOrNull(query.data) : null;
  return (
    <div>
      {query.error ? <p role="alert">{query.error}</p> : null}
      {page ? (
        page.messages.map((message) => (
          <p key={message.messageId} className="whitespace-pre-wrap break-words">
            {message.text}
          </p>
        ))
      ) : (
        <p>Original unavailable. Check access or reconnect the source environment.</p>
      )}
      <Button size="sm" variant="ghost" onClick={query.refresh}>
        Retry original
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!page?.nextCursor}
        onClick={() => {
          if (page?.nextCursor) setCursor(page.nextCursor);
        }}
      >
        Next original page
      </Button>
    </div>
  );
}
