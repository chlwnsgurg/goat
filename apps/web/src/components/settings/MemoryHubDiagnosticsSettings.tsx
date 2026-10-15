import { useAtomValue } from "@effect/atom-react";
import { presentMemorySync } from "@goat/client-runtime/memory-presentation";
import type {
  EnvironmentId,
  MemorySyncStatus,
  MemoryHubDiagnostics,
  ExecutionEnvironmentCapabilities,
} from "@goat/contracts";
import { useState, useEffect, useRef } from "react";
import { useEnvironment } from "../../state/environments";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function MemoryHubDiagnosticsSettings({
  environmentId,
  sync,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  sync: MemorySyncStatus;
  onRefresh: () => void;
}) {
  const environment = useEnvironment(environmentId);
  const capabilities = environment?.serverConfig?.environment.capabilities;
  const supported = capabilities?.memory?.hubDiagnostics === true;
  return supported ? (
    <Diagnostics
      key={environmentId}
      environmentId={environmentId}
      sync={sync}
      onRefresh={onRefresh}
      capabilities={capabilities}
    />
  ) : null;
}

function Diagnostics({
  environmentId,
  sync,
  onRefresh,
  capabilities,
}: {
  environmentId: EnvironmentId;
  sync: MemorySyncStatus;
  onRefresh: () => void;
  capabilities: ExecutionEnvironmentCapabilities;
}) {
  const canRead = useAtomValue(memoryEnvironment.hubDiagnostics.permissionAtom(environmentId));
  const getDiagnostics = useAtomCommand(memoryEnvironment.hubDiagnostics, { reportFailure: false });
  const [diagnostics, setDiagnostics] = useState<MemoryHubDiagnostics | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setDiagnostics(null);
    setError(false);
    if (canRead)
      void getDiagnostics({ environmentId, input: {} }).then((result) => {
        if (!current) return;
        if (result._tag === "Success") setDiagnostics(result.value);
        else setError(true);
      });
    return () => {
      current = false;
    };
  }, [canRead, environmentId, getDiagnostics, reload, sync]);
  const view = presentMemorySync(sync, {
    capabilities,
    ...(canRead && diagnostics ? { diagnostics } : {}),
  });
  const allowed = useAtomValue(memoryEnvironment.hubReconcile.permissionAtom(environmentId));
  const reconcile = useAtomCommand(memoryEnvironment.hubReconcile, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const permission = useRef({ canRead, allowed });
  permission.current = { canRead, allowed };
  useEffect(() => {
    if (!canRead || !allowed) setMessage(null);
  }, [canRead, allowed]);
  async function submit() {
    if (
      !canRead ||
      !diagnostics ||
      !sync.memorySpaceId ||
      !allowed ||
      !view.canReconcileInSettings ||
      busy
    )
      return;
    setBusy(true);
    setMessage(null);
    const result = await reconcile({
      environmentId,
      input: {
        environmentId,
        memorySpaceId: sync.memorySpaceId,
        expectedVersion: diagnostics.version,
      },
    });
    if (!mounted.current) return;
    setBusy(false);
    if (!permission.current.canRead || !permission.current.allowed) return;
    setMessage(
      result._tag === "Success"
        ? "Reconcile accepted. Synchronization may still be in progress."
        : "Could not reconcile. Reload diagnostics before trying again.",
    );
    setDiagnostics(null);
    setReload((n) => n + 1);
    onRefresh();
  }
  return (
    <SettingsSection title="Hub diagnostics">
      <SettingsRow title={view.label} description={view.publicationLabel ?? undefined} />
      {view.recoverableHolds.length ? (
        <SettingsRow
          title="Recoverable sync hold"
          description="Compatibility or availability needs attention. Reconcile can rearm eligible work."
        />
      ) : null}
      {view.permanentHolds.length ? (
        <SettingsRow
          title="Device access needs attention"
          description="Review device identity and authorization in Sharing settings."
        />
      ) : null}
      {canRead && diagnostics ? (
        <Collapsible>
          <CollapsibleTrigger>Settings details</CollapsibleTrigger>
          <CollapsiblePanel>
            <p>Settings version {diagnostics.version}</p>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {error ? <p role="alert">Could not load hub diagnostics.</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <SettingsRow
        title="Reconcile sync"
        description="Rearm eligible held work on this device."
        control={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !allowed || !view.canReconcileInSettings || !sync.memorySpaceId}
              onClick={() => void submit()}
            >
              Reconcile
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setMessage(null);
                setDiagnostics(null);
                setReload((n) => n + 1);
              }}
            >
              Reload diagnostics
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}
