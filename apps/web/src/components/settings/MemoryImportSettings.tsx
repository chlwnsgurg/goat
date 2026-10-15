import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthMemoryWriteScope,
  AuthFilesystemReadScope,
  MemoryOperationId,
  type EnvironmentId,
  type MemorySpaceId,
  type MemoryImportFormat,
  type MemoryImportSource,
  type MemoryImportPreviewItem,
} from "@goat/contracts";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { memoryEnvironment } from "../../state/memory";
import {
  registerMemoryImportDestination,
  createMemoryImportAdmission,
  canSafelyImport,
  unsafeImportBrowserMessage,
  changedImportDestinationMessage,
} from "../../lib/memoryImportRecoveryStorage";
import { randomUUID } from "../../lib/utils";
import { MemoryScopeSettings, type MemoryScopeSelection } from "./MemoryScopeSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

/** A mount may check a saved receipt; only the explicit Apply button admits writes. */
export function MemoryImportSettings({
  environmentId,
  memorySpaceId,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
}) {
  const registry = useContext(RegistryContext);
  const canImport = useAtomValue(memoryEnvironment.importProvider.permissionAtom(environmentId));
  const [admission] = useState(() => {
    try {
      return createMemoryImportAdmission({ environmentId, memorySpaceId });
    } catch {
      return null;
    }
  });
  const [workflow] = useState(() => {
    try {
      if (!admission) return null;
      return memoryEnvironment.createImportWorkflow(registry, {
        fence: { environmentId, memorySpaceId, session: randomUUID() },
        recovery: admission.recovery,
        operationId: () => MemoryOperationId.make(randomUUID()),
      });
    } catch {
      return null;
    }
  });
  const progress = useSyncExternalStore(
    workflow?.subscribe ?? (() => () => {}),
    workflow?.getSnapshot ?? (() => undefined),
  );
  const [format, setFormat] = useState<MemoryImportFormat | null>(null);
  const [sources, setSources] = useState<readonly MemoryImportSource[]>([]);
  const [items, setItems] = useState<readonly MemoryImportPreviewItem[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [scope, setScope] = useState<MemoryScopeSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const authorized = useRef(canImport);
  const generation = useRef(0);
  const previousScope = useRef<MemoryScopeSelection | null>(null);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    const token = generation.current;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      if (mounted.current && token === generation.current)
        setError("Import request failed. Check the result before previewing again.");
    }
    if (mounted.current && token === generation.current) {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (canImport) authorized.current = true;
    // Recover synchronizes the saved handle with the server, never admitting a write.
    // eslint-disable-next-line react/set-state-in-effect
    if (canImport && workflow) void run(() => workflow.recover());
    if (
      !canImport &&
      authorized.current &&
      workflow &&
      readPreparedConnection(environmentId) !== null &&
      (!readEnvironmentScope(environmentId, AuthMemoryWriteScope) ||
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope))
    ) {
      generation.current++;
      setItems([]);
      setSelected([]);
      setSources([]);
      setBusy(true);
      void workflow
        .removeDestination()
        .then(() => {
          if (mounted.current) {
            setBusy(false);
          }
        })
        .catch(() => {
          if (mounted.current) setError("Could not clear saved import recovery.");
        });
    }
    return () => {
      mounted.current = false;
      generation.current++;
      if (
        workflow &&
        authorized.current &&
        readPreparedConnection(environmentId) !== null &&
        (!readEnvironmentScope(environmentId, AuthMemoryWriteScope) ||
          !readEnvironmentScope(environmentId, AuthFilesystemReadScope))
      )
        void workflow.removeDestination().catch(() => undefined);
      else workflow?.invalidate({ environmentId, memorySpaceId, session: randomUUID() });
    };
  }, [canImport, workflow, run, environmentId, memorySpaceId]);
  const changeScope = useCallback(
    (next: MemoryScopeSelection | null) => {
      const previous = previousScope.current;
      previousScope.current = next;
      setScope(next);
      if (JSON.stringify(previous) === JSON.stringify(next) || !workflow) return;
      generation.current++;
      workflow.stop();
      workflow.invalidate({ environmentId, memorySpaceId, session: randomUUID() });
      setItems([]);
      setSelected([]);
      setBusy(false);
    },
    [workflow, environmentId, memorySpaceId],
  );
  const invalidateDestination = useCallback(async () => {
    generation.current++;
    workflow?.stop();
    workflow?.invalidate({ environmentId, memorySpaceId, session: randomUUID() });
    setError(changedImportDestinationMessage);
    setBusy(false);
    setItems([]);
    setSelected([]);
    setSources([]);
  }, [environmentId, memorySpaceId, workflow]);
  useEffect(() => {
    const unsubscribe = admission?.subscribeInvalidation(() => {
      void invalidateDestination();
    });
    const unregister = registerMemoryImportDestination(
      { environmentId, memorySpaceId },
      invalidateDestination,
    );
    return () => {
      unsubscribe?.();
      unregister();
    };
  }, [environmentId, memorySpaceId, invalidateDestination, admission]);
  const locked =
    busy ||
    ["previewed", "save_failed", "recovery", "saving", "applying", "checking"].includes(
      progress?.phase ?? "",
    );
  return (
    <SettingsSection title="Import memories">
      <SettingsRow
        title="Provider memories"
        description="Import supported Codex, Claude, or OMO memories from the selected device. Other providers are not supported. Memory write and file read permissions are required."
      >
        <div className="space-y-3">
          {!canSafelyImport() ? <p role="alert">{unsafeImportBrowserMessage}</p> : null}
          {!workflow ? (
            <p role="alert">
              Browser storage is unavailable. Imports require saved recovery information.
            </p>
          ) : null}
          <Select
            value={format}
            disabled={!canImport || locked || !workflow}
            onValueChange={(value) => {
              setFormat(value);
              setSources([]);
              setItems([]);
              setSelected([]);
              workflow?.invalidate();
            }}
          >
            <SelectTrigger aria-label="Import provider">
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectPopup>
              {(["codex", "claude", "omo"] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "codex" ? "Codex" : value === "claude" ? "Claude" : "OMO"}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <MemoryScopeSettings
            environmentId={environmentId}
            memorySpaceId={memorySpaceId}
            disabled={!canImport || locked}
            onChange={changeScope}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!workflow || !canImport || !format || !scope || locked}
            onClick={() =>
              void run(async () => {
                setItems([]);
                setSelected([]);
                const result = await workflow!.discover(format!);
                if (result && mounted.current) setSources(result.sources);
              })
            }
          >
            Discover profiles
          </Button>
          {progress?.phase === "discovered" && sources.length === 0 ? (
            <p>No supported profiles found on this device.</p>
          ) : null}
          {sources.map((source, index) => (
            <Button
              key={source.sourceId}
              size="sm"
              variant="outline"
              disabled={!canImport || locked}
              onClick={() =>
                void run(async () => {
                  setItems([]);
                  setSelected([]);
                  await admission!.capturePreview();
                  const result = await workflow!.preview(source.sourceId);
                  if (result && mounted.current) setItems(result.items);
                })
              }
            >
              Preview profile {index + 1}
            </Button>
          ))}
          {items.length > 0 ? (
            <div role="group" aria-label="Choose memories to import">
              {items.map((item, index) => (
                <label key={item.sourceItemKey} className="block space-x-2">
                  <input
                    type="checkbox"
                    disabled={
                      !canImport || locked || item.issue !== undefined || !item.sourceFingerprint
                    }
                    checked={selected.includes(item.sourceItemKey)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelected((current) =>
                        checked
                          ? [...current, item.sourceItemKey]
                          : current.filter((key) => key !== item.sourceItemKey),
                      );
                    }}
                  />
                  <span>
                    {item.title ?? `Memory ${index + 1}`}
                    {item.issue !== undefined ? " · Unavailable for import" : ""}
                  </span>
                </label>
              ))}
            </div>
          ) : progress?.phase === "selecting" ? (
            <p>No importable memories found in this profile.</p>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!canImport || locked || !scope || selected.length === 0}
            onClick={() => {
              if (!workflow || !scope) return;
              try {
                workflow.select(
                  items
                    .filter(
                      (item) => selected.includes(item.sourceItemKey) && item.sourceFingerprint,
                    )
                    .map((item) => ({
                      sourceItemKey: item.sourceItemKey,
                      sourceFingerprint: item.sourceFingerprint!,
                      ...scope,
                    })),
                );
              } catch {
                setError("Preview again before confirming your selection.");
              }
            }}
          >
            Confirm selection
          </Button>
          {progress?.phase === "previewed" ? (
            <div role="group" aria-label="Confirm import">
              <p>
                Import {selected.length} selected memories into the chosen scope on this device?
                Chunks of up to 32 run in sequence.
              </p>
              <Button
                size="sm"
                disabled={!canImport || busy || !canSafelyImport()}
                onClick={() => void run(() => workflow!.apply())}
              >
                Apply import
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  workflow?.invalidate();

                  setItems([]);
                  setSelected([]);
                }}
              >
                Cancel selection
              </Button>
            </div>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={!busy && progress?.phase !== "save_failed"}
            onClick={() => {
              workflow?.stop();
            }}
          >
            Stop import
          </Button>
          {progress?.phase === "save_failed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canImport || busy || !canSafelyImport()}
              onClick={() => void run(() => workflow!.retry())}
            >
              Retry saving import
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!workflow || !canImport || busy}
            onClick={() => void run(() => workflow!.recover())}
          >
            Check import result
          </Button>
          {progress ? (
            <p role="status">
              {busy ? "Import request in progress. " : ""}
              {progress.message}
              {progress.stopped ? " Future chunks stopped. Already sent work can finish." : ""}{" "}
              {progress.settledChunks} chunks completed.
            </p>
          ) : null}
          {progress?.receipt ? (
            <p>
              {progress.receipt.state === "partial"
                ? "Partial import; some memories may have been applied."
                : "Import results received across all chunks."}{" "}
              {progress.totals.outcomes.created ?? 0} created,{" "}
              {progress.totals.outcomes.revised ?? 0} updated,{" "}
              {progress.totals.outcomes.rejected ?? 0} rejected. Acceptance does not mean content is
              available on every device.
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
