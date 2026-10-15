import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  MemoryOperationId,
  type MemoryHubSettingsUpdateInput,
  type MemoryHubSettingsView,
  type MemoryOwnerSourceReadPolicyView,
  type MemorySyncStatus,
} from "@goat/contracts";
import {
  presentMemoryOwnerPolicy,
  presentMemorySync,
} from "@goat/client-runtime/memory-presentation";
import { useContext, useEffect, useRef, useState } from "react";
import { useEnvironments } from "../../state/environments";
import { readPreparedConnection, usePreparedConnection } from "../../state/session";
import * as Option from "effect/Option";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { isMemoryEnvironmentAvailable, memoryOwnerDesiredIds } from "./MemorySettings.logic";
import { memoryDeviceFlow } from "./memoryDeviceFlow";

const operationId = () => MemoryOperationId.make(randomUUID());

export function MemoryAdministration({
  environmentId,
  onSharingRefresh,
  sync,
}: {
  environmentId: EnvironmentId;
  onSharingRefresh?: () => void;
  sync?: MemorySyncStatus | null;
}) {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const getHub = useAtomCommand(memoryEnvironment.hubSettingsGet, { reportFailure: false });
  const updateHub = useAtomCommand(memoryEnvironment.hubSettingsUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  const getOwner = useAtomCommand(memoryEnvironment.ownerSourceReadPolicyGet, {
    reportFailure: false,
  });
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
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<"hub" | "owner" | "device" | null>(null);
  const [device, setDevice] = useState<EnvironmentId | null>(null);
  const [requester, setRequester] = useState<EnvironmentId | null>(null);
  const [endpoint, setEndpoint] = useState(connection?.httpBaseUrl ?? "");
  const [confirm, setConfirm] = useState<"disable" | "add" | "rotate" | EnvironmentId | null>(null);
  // The contract has no membership read API. Only successful additions in this mounted view are known.
  const [knownMembers, setKnownMembers] = useState<EnvironmentId[]>([]);
  const intent = useRef<MemoryHubSettingsUpdateInput | null>(null);
  const ownerIntent = useRef<Parameters<typeof updateOwner>[0]["input"] | null>(null);
  const flow = useRef<ReturnType<typeof memoryDeviceFlow> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flow.current?.dispose();
      flow.current = null;
    };
  }, []);
  const name = (id: EnvironmentId) =>
    environments.find((e) => e.environmentId === id)?.label ?? "Unknown device";
  const live = () =>
    mounted.current && connection !== null && readPreparedConnection(environmentId) === connection;
  const writable = (id: EnvironmentId) =>
    registry.get(memoryEnvironment.hubSettingsUpdate.permissionAtom(id));
  const candidates = environments.filter(
    (e) =>
      e.environmentId !== environmentId &&
      e.connection.phase === "connected" &&
      isMemoryEnvironmentAvailable(e.serverConfig?.environment.capabilities),
  );
  useEffect(() => {
    let current = true;
    setError(null);
    void (async () => {
      const result = await getHub({ environmentId, input: {} });
      if (!current) return;
      if (result._tag === "Success") setHub(result.value);
      else setError("Could not load sharing settings.");
      if (registry.get(memoryEnvironment.ownerSourceReadPolicyGet.permissionAtom(environmentId))) {
        const policy = await getOwner({ environmentId, input: {} });
        if (!current) return;
        if (policy._tag === "Success") setOwner(policy.value);
        else setError("Could not load original conversation access.");
      }
    })();
    return () => {
      current = false;
    };
  }, [environmentId, getHub, getOwner, registry, reload]);
  async function saveHub(input: MemoryHubSettingsUpdateInput) {
    if (busy || !live() || !writable(environmentId)) return;
    intent.current = input;
    setPending("hub");
    setBusy(true);
    setError(null);
    const result = await updateHub({ environmentId, input });
    if (!live()) return;
    setBusy(false);
    if (result._tag === "Failure") {
      setError("Sharing update failed. Retry to continue the same request.");
      return;
    }
    intent.current = null;
    setPending(null);
    setHub(result.value.view);
    setConfirm(null);
    onSharingRefresh?.();
    if (input.action === "revokeMember")
      setKnownMembers((ids) => ids.filter((id) => id !== input.environmentId));
  }
  async function saveOwner(id: EnvironmentId, allowed: boolean) {
    if (
      !owner ||
      busy ||
      !live() ||
      !registry.get(memoryEnvironment.ownerSourceReadPolicyUpdate.permissionAtom(environmentId))
    )
      return;
    const input = ownerIntent.current ?? {
      requestId: operationId(),
      expectedVersion: owner.version,
      allowedRequesterEnvironmentIds: memoryOwnerDesiredIds(owner, id, allowed),
    };
    ownerIntent.current = input;
    setPending("owner");
    setBusy(true);
    setError(null);
    const result = await updateOwner({ environmentId, input });
    if (!live()) return;
    setBusy(false);
    if (result._tag === "Success") {
      setOwner(result.value);
      ownerIntent.current = null;
      setPending(null);
      setRequester(null);
    } else setError("Could not update access. Retry to continue the same request.");
  }
  async function addDevice(action: "provisionMember" | "rotateMemberCredential") {
    if (!hub || !device || busy || !live() || !writable(environmentId) || !writable(device)) return;
    if (!readPreparedConnection(device)) {
      setError("Connect the device in Settings → Connections first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!flow.current) {
        const deviceConnection = readPreparedConnection(device);
        const target = await getHub({ environmentId: device, input: {} });
        if (!live() || readPreparedConnection(device) !== deviceConnection) return;
        if (target._tag === "Failure") throw new Error();
        const selected = device;
        setPending("device");
        flow.current = memoryDeviceFlow({
          hubId: environmentId,
          deviceId: selected,
          endpoint,
          hubVersion: hub.version,
          deviceVersion: target.value.version,
          action,
          requestIds: [operationId(), operationId(), operationId()],
          isActive: () =>
            live() &&
            readPreparedConnection(selected) === deviceConnection &&
            writable(environmentId) &&
            writable(selected),
          update: async (id, input) => {
            if (!live() || !writable(id) || !readPreparedConnection(id)) throw new Error();
            const result = await updateHub({ environmentId: id, input });
            if (result._tag === "Failure") throw new Error();
            return result.value;
          },
        });
      }
      const view = await flow.current.run();
      if (!live()) return;
      setHub(view);
      setKnownMembers((ids) => [...new Set([...ids, device])]);
      flow.current.dispose();
      flow.current = null;
      setPending(null);
      setConfirm(null);
      setDevice(null);
      onSharingRefresh?.();
    } catch {
      if (live())
        setError(
          "Device setup did not finish. Retry to continue. If you reload, select the device and use Replace key to recover, or Remove to clean up.",
        );
    } finally {
      if (live()) setBusy(false);
    }
  }
  const policy = owner ? presentMemoryOwnerPolicy(owner) : null;
  function picker(
    value: EnvironmentId | null,
    onChange: (id: EnvironmentId | null) => void,
    ids: typeof candidates,
    label: string,
  ) {
    return (
      <Select value={value} onValueChange={onChange} disabled={busy || pending !== null}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="Choose a device">{value ? name(value) : undefined}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {ids.map((e) => (
            <SelectItem key={e.environmentId} value={e.environmentId}>
              {e.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }
  const blocked = busy || !canHub || pending !== null;
  return (
    <>
      <SettingsSection title="Sharing" id="memory-sharing">
        <SettingsRow
          title={
            hub?.settings.mode === "hub"
              ? "This device is the hub"
              : hub?.settings.mode === "member"
                ? "Memory sharing"
                : "Memory off"
          }
          description={
            hub?.settings.mode === "hub"
              ? "Devices you add here share memory with it."
              : hub?.settings.mode === "member"
                ? `Shares memory with ${name(hub.settings.hubEnvironmentId)}.`
                : "Memory is off on this device. Make this device the hub, or add it from the hub's Memory settings."
          }
          status={
            sync && hub?.settings.mode !== "disabled" ? presentMemorySync(sync).label : undefined
          }
          control={
            hub ? (
              hub.settings.mode === "disabled" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={() =>
                    void saveHub({
                      action: "configure",
                      requestId: operationId(),
                      expectedVersion: hub.version,
                      settings: { mode: "hub", memorySpaceId: null },
                    })
                  }
                >
                  Make this device the hub
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={() => setConfirm("disable")}
                >
                  {hub.settings.mode === "member" ? "Leave sharing" : "Turn sharing off"}
                </Button>
              )
            ) : undefined
          }
        />
        {confirm === "disable" && hub ? (
          <SettingsRow
            title="Stop sharing on this device?"
            description="Saved memories stay."
            control={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={blocked}
                  onClick={() =>
                    void saveHub({
                      action: "configure",
                      requestId: operationId(),
                      expectedVersion: hub.version,
                      settings: { mode: "disabled" },
                    })
                  }
                >
                  Stop sharing
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || pending !== null}
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </Button>
              </div>
            }
          />
        ) : null}
        {error ? (
          <SettingsRow
            title="Could not complete request"
            description={<span role="alert">{error}</span>}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (flow.current)
                    void addDevice(
                      confirm === "rotate" ? "rotateMemberCredential" : "provisionMember",
                    );
                  else if (intent.current) void saveHub(intent.current);
                  else if (ownerIntent.current) void saveOwner(environmentId, true);
                  else {
                    setReload((n) => n + 1);
                    onSharingRefresh?.();
                  }
                }}
              >
                Retry
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
      {hub?.settings.mode === "hub" ? (
        <SettingsSection title="Devices">
          <SettingsRow
            title="Device list unavailable"
            description="This server cannot list existing member devices. Select a connected device below to replace its key or remove it. Connect the device in Settings → Connections first."
          />
          {knownMembers.map((id) => (
            <SettingsRow
              key={id}
              title={name(id)}
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={blocked}
                    onClick={() => {
                      setDevice(id);
                      setConfirm("rotate");
                    }}
                  >
                    Replace key
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={blocked}
                    onClick={() => setConfirm(id)}
                  >
                    Remove
                  </Button>
                </div>
              }
            />
          ))}
          <SettingsRow
            title="Add device"
            description="Choose a connected device that supports memory."
            control={
              <div className="flex flex-wrap gap-2">
                {picker(
                  device,
                  setDevice,
                  candidates.filter((e) => !knownMembers.includes(e.environmentId)),
                  "Device",
                )}
                <Button size="sm" disabled={blocked || !device} onClick={() => setConfirm("add")}>
                  Add
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked || !device}
                  onClick={() => setConfirm("rotate")}
                >
                  Replace key
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={blocked || !device}
                  onClick={() => device && setConfirm(device)}
                >
                  Remove
                </Button>
              </div>
            }
          />
          {device && !writable(device) ? (
            <SettingsRow
              title="Settings write permission required on this device"
              description="Connect the device in Settings → Connections first, using an account with settings access."
            />
          ) : null}
          {(confirm === "add" || confirm === "rotate") && device ? (
            <SettingsRow
              title={
                confirm === "add" ? `Add ${name(device)}?` : `Replace key for ${name(device)}?`
              }
              description="Address the device uses to reach this hub."
              control={
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="memory-hub-address">Hub address</label>
                  <Input
                    id="memory-hub-address"
                    value={endpoint}
                    disabled={blocked}
                    onChange={(e) => setEndpoint(e.currentTarget.value)}
                  />
                  <Button
                    size="sm"
                    disabled={blocked || !writable(device)}
                    onClick={() =>
                      void addDevice(
                        confirm === "rotate" ? "rotateMemberCredential" : "provisionMember",
                      )
                    }
                  >
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || pending !== null}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              }
            />
          ) : null}
          {confirm && confirm !== "disable" && confirm !== "add" && confirm !== "rotate" ? (
            <SettingsRow
              title={`Remove ${name(confirm)}?`}
              description="This device will lose access to shared memory."
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={blocked}
                    onClick={() =>
                      void saveHub({
                        action: "revokeMember",
                        requestId: operationId(),
                        expectedVersion: hub.version,
                        environmentId: confirm,
                      })
                    }
                  >
                    Remove device
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || pending !== null}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}
      <SettingsSection title="Original conversations" id="memory-owner-policy">
        <SettingsRow
          title="Conversation access"
          description="When a memory points to a conversation on this device, these devices can open the original. Removing a device applies to later requests and to results still on the hub."
        />
        {policy?.desiredRequesterEnvironmentIds.map((id) => (
          <SettingsRow
            key={id}
            title={name(id)}
            status={policy.pendingEnrollments.find((e) => e.requesterEnvironmentId === id)?.label}
            control={
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !canOwner || pending !== null}
                onClick={() => void saveOwner(id, false)}
              >
                Remove
              </Button>
            }
          />
        ))}
        {owner?.policy.removals
          .filter((r) => r.state === "pending")
          .map((r) => (
            <SettingsRow
              key={r.requesterEnvironmentId}
              title={name(r.requesterEnvironmentId)}
              status="Removal pending"
            />
          ))}
        <SettingsRow
          title="Allow device"
          description={!canOwner ? "Settings write permission is required." : undefined}
          control={
            <div className="flex gap-2">
              {picker(
                requester,
                setRequester,
                candidates.filter(
                  (e) => !policy?.desiredRequesterEnvironmentIds.includes(e.environmentId),
                ),
                "Conversation access device",
              )}
              <Button
                size="sm"
                disabled={busy || !canOwner || !requester || pending !== null}
                onClick={() => requester && void saveOwner(requester, true)}
              >
                Allow
              </Button>
            </div>
          }
        />
      </SettingsSection>
    </>
  );
}
