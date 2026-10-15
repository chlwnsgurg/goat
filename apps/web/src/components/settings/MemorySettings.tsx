const decodeSpace = Schema.decodeUnknownSync(MemorySpaceId);
const decodeEnvironmentId = Schema.decodeUnknownSync(EnvironmentId);
const decodeHubConfiguration = Schema.decodeUnknownSync(memoryHubConfigureSchema);

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
  type ScopedThreadRef,
  type MessageId,
  type MemoryItem,
  type MemoryHubSettingsView,
  type MemoryOwnerSourceReadPolicyView,
  type MemorySyncStatus,
  type MemoryReportDelivery,
  type MemoryHubSettingsUpdateInput,
} from "@goat/contracts";
import {
  presentMemoryItem,
  presentMemoryResolution,
  presentMemoryRevertResult,
  presentMemoryForget,
  presentMemoryOwnerPolicy,
  presentMemoryReport,
  presentMemorySync,
} from "@goat/client-runtime/memory-presentation";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useContext, useEffect, useRef, useState } from "react";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { memoryEnvironment } from "../../state/memory";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  isMemoryEnvironmentAvailable,
  memorySettingsDestination,
  memoryForgetIntent,
  memoryOwnerDesiredIds,
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
          <p>Choose an environment to manage its memory.</p>
          {environments
            .filter((item) =>
              isMemoryEnvironmentAvailable(item.serverConfig?.environment.capabilities),
            )
            .map((item) => (
              <Button
                key={item.environmentId}
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
                {item.label}
              </Button>
            ))}
        </SettingsSection>
      </SettingsPageContainer>
    );
  if (!isMemoryEnvironmentAvailable(environment?.serverConfig?.environment.capabilities))
    return (
      <SettingsPageContainer>
        <p role="status">Update or reconnect the selected environment to use Memory.</p>
        <p>{target.environmentId}</p>
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
      <p className="text-xs text-muted-foreground">
        {environmentId} · {target.memorySpaceId ?? "Choose a memory space"}
      </p>
      {connection === null ? (
        <p role="status">Reconnect this environment to continue.</p>
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
  const canOwner = useAtomValue(
    memoryEnvironment.ownerSourceReadPolicyGet.permissionAtom(environmentId),
  );
  const canSync = useAtomValue(memoryEnvironment.syncStatus.permissionAtom(environmentId));
  const getSync = useAtomCommand(memoryEnvironment.syncStatus, { reportFailure: false });
  const [sync, setSync] = useState<MemorySyncStatus | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [space, setSpace] = useState("");
  useEffect(() => {
    let current = true;
    if (canSync)
      void getSync({ environmentId, input: {} }).then((result) => {
        if (!current) return;
        if (result._tag === "Success") setSync(result.value);
        else setSyncError("Could not load memory sharing status.");
      });
    return () => {
      current = false;
    };
  }, [canSync, environmentId, getSync]);
  const chooseSpace = (value: string) => {
    try {
      const memorySpaceId = decodeSpace(value);
      void navigate({
        to: "/settings/memory",
        search: validateMemorySettingsSearch({ environmentId, memorySpaceId }),
        hash: "",
      });
    } catch {
      setSyncError("Enter a valid memory space ID.");
    }
  };
  return (
    <>
      <SettingsSection title="Sharing" id="memory-sharing">
        {canSync && sync ? <p>{presentMemorySync(sync).label}</p> : null}
        {syncError ? <p role="alert">{syncError}</p> : null}
        {canAdmin ? (
          <MemoryAdministration
            key={`${environmentId}:${canAdmin}:${canOwner}`}
            environmentId={environmentId}
          />
        ) : (
          <p>Settings write permission is required to manage sharing and source access.</p>
        )}
        <details>
          <summary>Operational details</summary>
          <p>
            Detailed diagnostics and manual reconciliation are not available in this environment
            version.
          </p>
        </details>
      </SettingsSection>
      {!target.memorySpaceId ? (
        <SettingsSection title="Memory space">
          {canSync && sync?.memorySpaceId ? (
            <Button variant="outline" size="sm" onClick={() => chooseSpace(sync.memorySpaceId!)}>
              Open connected memory space
            </Button>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              chooseSpace(space);
            }}
          >
            <Input
              aria-label="Memory space ID"
              value={space}
              onChange={(event) => setSpace(event.currentTarget.value)}
            />
            <Button type="submit" size="sm">
              Open memory space
            </Button>
          </form>
        </SettingsSection>
      ) : canRead ? (
        <MemoryRecords
          key={target.memorySpaceId}
          target={target}
          environmentId={environmentId}
          memorySpaceId={target.memorySpaceId}
        />
      ) : (
        <p role="status">
          Memory read permission is required to view records. Write permission does not grant read
          access.
        </p>
      )}
    </>
  );
}

export function MemoryAdministration({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const getHub = useAtomCommand(memoryEnvironment.hubSettingsGet, { reportFailure: false });
  const getOwner = useAtomCommand(memoryEnvironment.ownerSourceReadPolicyGet, {
    reportFailure: false,
  });
  const updateHub = useAtomCommand(memoryEnvironment.hubSettingsUpdate, { reportFailure: false });
  const updateOwner = useAtomCommand(memoryEnvironment.ownerSourceReadPolicyUpdate, {
    reportFailure: false,
  });
  const canHub = useAtomValue(memoryEnvironment.hubSettingsUpdate.permissionAtom(environmentId));
  const canOwner = useAtomValue(
    memoryEnvironment.ownerSourceReadPolicyUpdate.permissionAtom(environmentId),
  );
  const [hub, setHub] = useState<MemoryHubSettingsView | null>(null);
  const [owner, setOwner] = useState<MemoryOwnerSourceReadPolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requester, setRequester] = useState("");
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [hubIntent, setHubIntent] = useState<MemoryHubSettingsUpdateInput | null>(null);
  const [ownerIntent, setOwnerIntent] = useState<Parameters<typeof updateOwner>[0]["input"] | null>(
    null,
  );
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void getHub({ environmentId, input: {} }).then((result) => {
      if (!mounted.current) return;
      if (result._tag === "Success") setHub(result.value);
      else setError("Could not load sharing settings.");
    });
    if (registry.get(memoryEnvironment.ownerSourceReadPolicyGet.permissionAtom(environmentId)))
      void getOwner({ environmentId, input: {} }).then((result) => {
        if (!mounted.current) return;
        if (result._tag === "Success") setOwner(result.value);
        else setError("Could not load source access policy.");
      });
    return () => {
      mounted.current = false;
    };
  }, [environmentId, getHub, getOwner, registry, reload]);
  async function saveHub(input: MemoryHubSettingsUpdateInput) {
    if (busy || !registry.get(memoryEnvironment.hubSettingsUpdate.permissionAtom(environmentId)))
      return;
    setBusy(true);
    setHubIntent(input);
    const result = await updateHub({ environmentId, input });
    if (
      !mounted.current ||
      !registry.get(memoryEnvironment.hubSettingsUpdate.permissionAtom(environmentId))
    )
      return;
    setBusy(false);
    if (result._tag === "Success") {
      setHub(result.value.view);
      setHubIntent(null);
      setConfigure(false);
      setConfirmDisable(false);
      setError(null);
    } else
      setError(
        "Sharing update failed. Retry the same request or reload settings before making a new change.",
      );
  }
  async function saveOwner(id: EnvironmentId, allowed: boolean) {
    if (
      !owner ||
      busy ||
      !registry.get(memoryEnvironment.ownerSourceReadPolicyUpdate.permissionAtom(environmentId))
    )
      return;
    const input = ownerIntent ?? {
      requestId: MemoryOperationId.make(randomUUID()),
      expectedVersion: owner.version,
      allowedRequesterEnvironmentIds: memoryOwnerDesiredIds(owner, id, allowed),
    };
    setBusy(true);
    setOwnerIntent(input);
    const result = await updateOwner({ environmentId, input });
    if (
      !mounted.current ||
      !registry.get(memoryEnvironment.ownerSourceReadPolicyUpdate.permissionAtom(environmentId))
    )
      return;
    setBusy(false);
    if (result._tag === "Success") {
      setOwner(result.value);
      setOwnerIntent(null);
      setError(null);
      setRequester("");
    } else setError("Source access update failed. Retry the same request or reload settings.");
  }
  const policy = owner ? presentMemoryOwnerPolicy(owner) : null;
  return (
    <div className="space-y-3">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setHub(null);
          setOwner(null);
          setHubIntent(null);
          setOwnerIntent(null);
          setConfirmDisable(false);
          setConfigure(false);
          setReload((value) => value + 1);
        }}
      >
        Reload sharing settings
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {hub ? (
        <>
          <p>Sharing: {hub.settings.mode}</p>
          {hubIntent ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canHub}
              onClick={() => void saveHub(hubIntent)}
            >
              Retry sharing request
            </Button>
          ) : hub.settings.mode !== "disabled" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canHub}
              onClick={() => setConfirmDisable(true)}
            >
              Turn sharing off
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canHub}
              onClick={() => setConfigure(true)}
            >
              Turn sharing on
            </Button>
          )}
          {confirmDisable && !hubIntent ? (
            <div role="group" aria-label="Turn sharing off confirmation">
              <p>Stop sharing on this environment? Stored memories remain.</p>
              <Button
                size="sm"
                disabled={busy || !canHub}
                onClick={() =>
                  void saveHub({
                    action: "configure",
                    requestId: MemoryOperationId.make(randomUUID()),
                    expectedVersion: hub.version,
                    settings: { mode: "disabled" },
                  })
                }
              >
                Confirm sharing off
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDisable(false)}>
                Cancel
              </Button>
            </div>
          ) : null}
          {configure && !hubIntent ? (
            <HubConfiguration
              view={hub}
              disabled={busy || !canHub}
              onSave={(input) => void saveHub(input)}
              onCancel={() => setConfigure(false)}
            />
          ) : null}
        </>
      ) : (
        <p>Sharing settings unavailable.</p>
      )}
      {policy && owner ? (
        <div id="memory-owner-policy">
          <h3>Original source access</h3>
          <p>{policy.revocationLabel}</p>
          <p>{policy.notice}</p>
          <ul>
            {policy.desiredRequesterEnvironmentIds.map((id) => (
              <li key={id}>
                {id} ·{" "}
                {policy.pendingEnrollments.find((entry) => entry.requesterEnvironmentId === id)
                  ?.label ?? "Effective"}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || !canOwner || ownerIntent !== null}
                  onClick={() => void saveOwner(id, false)}
                >
                  Remove access
                </Button>
              </li>
            ))}
          </ul>
          {ownerIntent ? (
            <Button
              size="sm"
              disabled={busy || !canOwner}
              onClick={() =>
                void saveOwner(ownerIntent.allowedRequesterEnvironmentIds[0] ?? environmentId, true)
              }
            >
              Retry source access request
            </Button>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  void saveOwner(decodeEnvironmentId(requester), true);
                } catch {
                  setError("Enter a valid requester environment ID.");
                }
              }}
            >
              <Input
                aria-label="Requester environment ID"
                value={requester}
                onChange={(event) => setRequester(event.currentTarget.value)}
              />
              <Button type="submit" size="sm" disabled={busy || !canOwner}>
                Allow source access
              </Button>
            </form>
          )}
        </div>
      ) : (
        <p>Source access policy unavailable.</p>
      )}
    </div>
  );
}

function HubConfiguration({
  view,
  disabled,
  onSave,
  onCancel,
}: {
  view: MemoryHubSettingsView;
  disabled: boolean;
  onSave: (input: MemoryHubSettingsUpdateInput) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"hub" | "member" | null>(null);
  const [space, setSpace] = useState("");
  const [hubId, setHubId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secretName, setSecretName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          if (!mode) throw new Error("Choose this environment's sharing role.");
          const input = decodeHubConfiguration({
            action: "configure",
            requestId: randomUUID(),
            expectedVersion: view.version,
            settings:
              mode === "hub"
                ? { mode, memorySpaceId: space || null }
                : {
                    mode,
                    memorySpaceId: space || null,
                    hubEnvironmentId: hubId,
                    endpoint,
                    secretName,
                  },
          });
          onSave(input);
        } catch {
          setError(
            "Choose a role and enter valid sharing settings. Member mode requires an installed credential reference.",
          );
        }
      }}
    >
      <p>
        Select the configured hub or connect as a member. Credentials must already be installed.
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === "hub" ? "default" : "outline"}
          onClick={() => setMode("hub")}
        >
          This environment is the hub
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "member" ? "default" : "outline"}
          onClick={() => setMode("member")}
        >
          Connect to the hub
        </Button>
      </div>
      <Input
        aria-label="Sharing memory space ID (optional)"
        value={space}
        onChange={(event) => setSpace(event.currentTarget.value)}
      />
      {mode === "member" ? (
        <>
          <Input
            aria-label="Hub environment ID"
            value={hubId}
            onChange={(event) => setHubId(event.currentTarget.value)}
          />
          <Input
            aria-label="Hub endpoint"
            value={endpoint}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
          />
          <Input
            aria-label="Installed credential reference"
            value={secretName}
            onChange={(event) => setSecretName(event.currentTarget.value)}
          />
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" size="sm" disabled={disabled}>
        Enable sharing
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
import { MemoryHubSettingsUpdateInput as memoryHubConfigureSchema } from "@goat/contracts";

function MemoryRecords({
  target,
  environmentId,
  memorySpaceId,
}: {
  target: MemorySettingsSearch;
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
}) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const canWrite = useAtomValue(memoryEnvironment.upsert.permissionAtom(environmentId));
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
        <Button size="sm" variant="outline" disabled={!canWrite} onClick={() => setAdding(true)}>
          Remember something
        </Button>
        {adding && canWrite ? (
          <MemoryEditor
            environmentId={environmentId}
            memorySpaceId={memorySpaceId}
            onClose={() => {
              setAdding(false);
              page.refresh();
            }}
          />
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setCursor(undefined);
            setQuery(queryInput.trim());
          }}
        >
          <Input
            aria-label="Search memories"
            value={queryInput}
            onChange={(event) => setQueryInput(event.currentTarget.value)}
          />
          <Button type="submit" size="sm">
            Search
          </Button>
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
        </form>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setQuarantine(!quarantine);
            setCursor(undefined);
          }}
        >
          {" "}
          {quarantine ? "Hide quarantined memories" : "Include quarantined memories"}
        </Button>
        {page.error ? <p role="alert">{page.error}</p> : null}
        {!value ? (
          <p role="status">
            Memory records unavailable. Refresh after reconnecting or checking access.
          </p>
        ) : items.length === 0 ? (
          <p>No memories on this page.</p>
        ) : (
          <LegendList
            data={items}
            keyExtractor={(item) => item.memoryId}
            estimatedItemSize={72}
            style={{ height: 320 }}
            renderItem={({ item }) => (
              <div className="border-b p-2">
                <Button size="sm" variant="ghost" onClick={() => select(item)}>
                  {item.status === "active" ? item.payload.text.slice(0, 120) : item.memoryId}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {presentMemoryItem(item).label} {presentMemoryItem(item).syncLabel}
                </p>
              </div>
            )}
          />
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={page.refresh}>
            Refresh records
          </Button>
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
      </SettingsSection>
      {target.memoryId ? (
        <MemoryDetails
          key={target.memoryId}
          target={target}
          environmentId={environmentId}
          memorySpaceId={memorySpaceId}
        />
      ) : null}
    </>
  );
}

function MemoryDetails({
  target,
  environmentId,
  memorySpaceId,
}: {
  target: MemorySettingsSearch;
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
}) {
  const memoryId = target.memoryId!;
  const [editing, setEditing] = useState(false);
  const canWrite = useAtomValue(memoryEnvironment.upsert.permissionAtom(environmentId));
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
  if (item === null && editing) setEditing(false);
  const value = history.data ? Option.getOrNull(history.data) : null;
  const navigate = useNavigate();
  return (
    <SettingsSection title="Memory details" id="memory-details">
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          void navigate({
            to: "/settings/memory",
            search: validateMemorySettingsSearch({ environmentId, memorySpaceId }),
            hash: "",
          })
        }
      >
        Close details
      </Button>
      {read.error || history.error ? <p role="alert">{read.error ?? history.error}</p> : null}
      {item ? (
        <>
          <p>{presentMemoryItem(item).label}</p>
          <p>
            {presentMemoryItem(item).syncLabel} {presentMemoryItem(item).cleanupLabel}
          </p>
          {item.status === "active" ? (
            <p className="whitespace-pre-wrap break-words">{item.payload.text}</p>
          ) : null}
          {item.status === "active" && canWrite ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Edit memory
              </Button>
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
          <MemoryForgetControl
            key={`${item.memoryId}:${item.status}:${item.status === "active" ? item.revision.revisionId : ""}`}
            environmentId={environmentId}
            item={item}
          />
        </>
      ) : (
        <p role="status">This memory is unavailable. Visible details have been cleared.</p>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          read.refresh();
          history.refresh();
        }}
      >
        Refresh details
      </Button>
      <h3>Resolution history</h3>
      {value ? (
        <>
          {value.resolutions.map((entry) => {
            const display = presentMemoryResolution(entry);
            return (
              <details
                key={entry.resolution.resolutionId}
                open={target.resolutionId === entry.resolution.resolutionId}
              >
                <summary>
                  {display.label} · {display.providerLabel} · {display.appliedAtUtc}
                </summary>
                <p>Requested model: {JSON.stringify(display.requestedModelSelection)}</p>
                <p>Effective model: {display.effectiveModel}</p>
                <p>Resolving environment: {display.resolvingEnvironmentId}</p>
                <p>Revert deadline: {display.revertDeadlineUtc}</p>
                <p>
                  {entry.payload ? JSON.stringify(entry.payload) : "Retained judgment unavailable."}
                </p>
                <Button size="sm" variant="outline" disabled>
                  Revert resolution
                </Button>
                <p>Revert controls are unavailable while eligibility support is being updated.</p>
              </details>
            );
          })}
          <h3>Retained originals</h3>
          {value.revisions.map((entry) => (
            <details key={entry.revision.revisionId}>
              <summary>
                {entry.revision.revisionId} · {entry.revision.createdAtUtc}
              </summary>
              <p className="whitespace-pre-wrap break-words">
                {entry.payload?.text ?? "Original unavailable."}
              </p>
              <p>Source environment: {entry.revision.provenance.environmentId}</p>
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
            </details>
          ))}
          {value.revertResults.map((result) => (
            <p key={result.operationId}>{presentMemoryRevertResult(result).label}</p>
          ))}
          {value.reports.map((report) => (
            <MemoryReportControl key={report.reportId} report={report} />
          ))}
          <Button size="sm" variant="ghost" disabled={!cursor} onClick={() => setCursor(undefined)}>
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
        </>
      ) : (
        <p>History unavailable.</p>
      )}
    </SettingsSection>
  );
}

export function MemoryForgetControl({
  environmentId,
  item,
}: {
  environmentId: EnvironmentId;
  item: MemoryItem;
}) {
  const canForget = useAtomValue(memoryEnvironment.forget.permissionAtom(environmentId));
  const registry = useContext(RegistryContext);
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
  if (!canForget && intent !== null) setIntent(null);
  const available = presentMemoryItem(item).canForget && memoryForgetIntent(item) !== null;
  async function submit() {
    if (!intent || busy || !registry.get(memoryEnvironment.forget.permissionAtom(environmentId)))
      return;
    setBusy(true);
    const result = await forget({ environmentId, input: intent });
    if (!mounted.current || !registry.get(memoryEnvironment.forget.permissionAtom(environmentId)))
      return;
    setBusy(false);
    if (result._tag === "Success") {
      const display = presentMemoryForget(result.value);
      setMessage(
        `${display.label} · Expansion: ${display.expansionStatus} · Sharing pending: ${display.pendingSync} · ${display.failureCode ?? ""} · ${display.notice}`,
      );
      setIntent(null);
    } else setMessage("Forget request failed. Retry this request with the same operation ID.");
  }
  return (
    <div>
      {message ? <p role="status">{message}</p> : null}
      {available ? (
        intent && canForget ? (
          <div role="group" aria-label="Forget confirmation">
            <p>Forget this memory? This cannot be undone.</p>
            <Button size="sm" disabled={busy} onClick={() => void submit()}>
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
            onClick={() => setIntent(memoryForgetIntent(item))}
          >
            Forget memory
          </Button>
        )
      ) : (
        <p>Forget is unavailable for this record.</p>
      )}
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
      <Input
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
      <p>
        Original: {sourceThread.environmentId} · {sourceThread.threadId}
      </p>
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
