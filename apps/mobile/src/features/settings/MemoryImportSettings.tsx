import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import {
  MemoryOperationId,
  type MemoryImportFormat,
  type MemoryImportProviderResult,
  type MemoryScope,
  type MemorySpaceId,
} from "@goat/contracts";
import type { MemoryImportWorkflowState } from "@goat/client-runtime/memory-import-workflow";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import * as Option from "effect/Option";
import { mobileMemoryImportRecovery } from "../../persistence/memory-import-recovery";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { memoryEnvironment as memory } from "../../state/memory";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { nativeMemoryImportOutcomes } from "./SettingsMemoryRouteScreen.logic";
import type { MemoryScreenParams } from "./SettingsMemoryRouteScreen.logic";
import type { EnvironmentId } from "@goat/contracts";

type Discovery = Extract<MemoryImportProviderResult, { action: "discover" }>;
type Preview = Extract<MemoryImportProviderResult, { action: "preview" }>;
const Copy = ({ children }: { children: React.ReactNode }) => (
  <Text className="p-3 text-sm text-foreground-muted">{children}</Text>
);
const Action = (props: { label: string; disabled?: boolean; onPress: () => void }) => (
  <SettingsActionRow icon="brain" {...props} />
);

/** Mount/reconnect/foreground only recover status. Applying always requires two deliberate actions. */
export function MemoryImportSettings({
  params,
  memorySpaceId,
  scope,
  bindingToken,
  enabled,
  retireRef,
}: {
  params: MemoryScreenParams & { environmentId: EnvironmentId };
  memorySpaceId: MemorySpaceId;
  scope: MemoryScope | undefined;
  bindingToken: string;
  enabled: boolean;
  retireRef: React.RefObject<() => Promise<void>>;
}) {
  const registry = useContext(RegistryContext);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const allowed = useAtomValue(memory.importProvider.permissionAtom(params.environmentId));
  const connection = useAtomValue(
    environmentSession.preparedConnectionValueAtom(params.environmentId),
  );
  const [workflow] = useState(() =>
    memory.createImportWorkflow(registry, {
      fence: { environmentId: params.environmentId, memorySpaceId, session: Crypto.randomUUID() },
      recovery: mobileMemoryImportRecovery,
      operationId: () => MemoryOperationId.make(Crypto.randomUUID()),
    }),
  );
  const [state, setState] = useState<MemoryImportWorkflowState>(workflow.getState());
  const [format, setFormat] = useState<MemoryImportFormat | null>(null);
  const [sources, setSources] = useState<Discovery | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [destinationConfirmed, setDestinationConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const previous = useRef({ connection, allowed, enabled, bindingToken, scope });
  const transition = useRef(Promise.resolve());
  const invalidateSelection = useCallback(() => {
    setPreview(null);
    setSources(null);
    setSelected(new Set());
    setDestinationConfirmed(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      workflow.invalidate();
      // A lost connection preserves recovery. Explicit grant revocation removes this destination.
      if (
        Option.isSome(
          registry.get(environmentSession.preparedConnectionValueAtom(params.environmentId)),
        ) &&
        (!readEnvironmentScope(params.environmentId, "memory:write") ||
          !readEnvironmentScope(params.environmentId, "filesystem:read"))
      ) {
        void workflow.removeDestination().catch(() => {});
      }
    };
  }, [workflow, params.environmentId, registry]);
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      if (pending.current) return;
      pending.current = true;
      const token = generation.current;
      setBusy(true);
      setError(null);
      try {
        await transition.current;
        if (!mounted.current || token !== generation.current) return;
        const request = action();
        setState(workflow.getState());
        await request;
      } catch {
        if (mounted.current && token === generation.current)
          setError("Import could not finish. Check the saved result before previewing again.");
      } finally {
        if (mounted.current && token === generation.current) {
          setState(workflow.getState());
          setBusy(false);
          pending.current = false;
        }
      }
    },
    [workflow],
  );
  useEffect(() => {
    const retire = async () => {
      generation.current++;
      pending.current = false;
      setBusy(false);
      invalidateSelection();
      // Invalidation fences an admitted reply immediately; clear must settle before rebinding.
      workflow.invalidate();
      transition.current = transition.current.then(() => workflow.removeDestination());
      await transition.current;
      if (mounted.current) setState(workflow.getState());
    };
    retireRef.current = retire;
    return () => {
      retireRef.current = async () => {};
    };
  }, [workflow, retireRef, invalidateSelection]);
  const recover = useCallback(() => {
    if (!registry.get(memory.importProvider.permissionAtom(params.environmentId)) || !enabled)
      return;
    void run(async () => {
      if (
        await mobileMemoryImportRecovery.load({
          environmentId: params.environmentId,
          memorySpaceId,
        })
      )
        await workflow.recover();
    });
  }, [registry, params.environmentId, memorySpaceId, enabled, run, workflow]);
  useEffect(() => {
    const old = previous.current;
    previous.current = { connection, allowed, enabled, bindingToken, scope };
    const remove =
      (old.allowed && !allowed && Option.isSome(connection)) ||
      (old.enabled && !enabled) ||
      old.bindingToken !== bindingToken;
    if (remove || old.connection !== connection || old.scope !== scope) {
      generation.current++;
      pending.current = false;
      // The workflow is external mutable state; retire the displayed preview with its fence.
      setBusy(false);
      invalidateSelection();
      workflow.invalidate();
      const nextFence = {
        environmentId: params.environmentId,
        memorySpaceId,
        session: Crypto.randomUUID(),
      };
      transition.current = transition.current.then(async () => {
        if (remove) await workflow.removeDestination();
        workflow.invalidate(nextFence);
      });
      void transition.current
        .then(() => {
          if (mounted.current) {
            setState(workflow.getState());
            recover();
          }
        })
        .catch(() => {
          if (mounted.current)
            setError("Could not clear the previous import. Reopen Settings before importing.");
        });
    } else if (allowed) void Promise.resolve().then(recover);
  }, [
    allowed,
    enabled,
    connection,
    bindingToken,
    scope,
    workflow,
    params.environmentId,
    memorySpaceId,
    recover,
    invalidateSelection,
  ]);
  useFocusEffect(
    useCallback(() => {
      recover();
      const listener = AppState.addEventListener("change", (next) => {
        if (next === "active") recover();
      });
      return () => listener.remove();
    }, [recover]),
  );
  const writable = allowed && enabled && !busy;
  const selecting = state.phase === "selecting";
  return (
    <SettingsSection title="Import memories">
      <Copy>
        Import from Codex, Claude or OMO. Other provider profiles are not supported. Choose a
        profile, preview its memories and confirm a destination before applying.
      </Copy>
      <Copy>
        Destination:{" "}
        {savedConnectionsById[params.environmentId]?.environmentLabel ?? "Selected environment"} ·{" "}
        {scope?.kind === "user"
          ? "User memories"
          : scope?.kind === "project"
            ? "Selected project"
            : scope?.kind === "thread"
              ? "Selected thread"
              : "Choose a scope"}
      </Copy>
      {!allowed ? <Copy>Memory write and file read permissions are required.</Copy> : null}
      {(["codex", "claude", "omo"] as const).map((value) => (
        <Action
          key={value}
          label={`Discover ${value === "codex" ? "Codex" : value === "claude" ? "Claude" : "OMO"} profiles`}
          disabled={!writable}
          onPress={() => {
            invalidateSelection();
            setFormat(value);
            void run(async () => {
              const result = await workflow.discover(value);
              if (result) setSources(result);
            });
          }}
        />
      ))}
      {sources?.sources.length === 0 ? <Copy>No supported profiles found.</Copy> : null}
      {sources?.sources.map((source, index) => (
        <Action
          key={source.sourceId}
          label={`Preview ${format === "codex" ? "Codex" : format === "claude" ? "Claude" : "OMO"} profile ${index + 1}`}
          disabled={!writable}
          onPress={() => {
            setSelected(new Set());
            setDestinationConfirmed(false);
            void run(async () => {
              const result = await workflow.preview(source.sourceId);
              if (result) setPreview(result);
            });
          }}
        />
      ))}
      {preview ? (
        <>
          <Copy>
            {preview.items.length} memories in this preview. Select the memories to import.
          </Copy>
          {preview.items.map((item, index) => (
            <SettingsSwitchRow
              key={item.sourceItemKey}
              label={
                item.issue
                  ? `Memory ${index + 1} unavailable`
                  : (item.title ?? `Memory ${index + 1}`)
              }
              value={selected.has(item.sourceItemKey)}
              disabled={!writable || !selecting || !!item.issue || !item.sourceFingerprint}
              onValueChange={(value) =>
                setSelected((old) => {
                  const next = new Set(old);
                  if (value) next.add(item.sourceItemKey);
                  else next.delete(item.sourceItemKey);
                  return next;
                })
              }
            />
          ))}
          <SettingsSwitchRow
            label="Use selected scope and this environment as the import destination"
            value={destinationConfirmed}
            disabled={!writable || !selecting || !scope}
            onValueChange={setDestinationConfirmed}
          />
          <Action
            label="Confirm import selection"
            disabled={
              !writable || !selecting || !scope || !destinationConfirmed || selected.size === 0
            }
            onPress={() => {
              if (!scope) return;
              workflow.select(
                preview.items
                  .filter(
                    (item) =>
                      selected.has(item.sourceItemKey) && item.sourceFingerprint && !item.issue,
                  )
                  .map((item) => ({
                    sourceItemKey: item.sourceItemKey,
                    sourceFingerprint: item.sourceFingerprint!,
                    scope,
                    ...(scope.kind !== "user" && params.project ? { project: params.project } : {}),
                  })),
              );
              setState(workflow.getState());
            }}
          />
          <Action
            label="Apply selected memories"
            disabled={!writable || state.phase !== "previewed"}
            onPress={() => void run(() => workflow.apply())}
          />
          <Action
            label="Change import selection"
            disabled={!writable || selecting}
            onPress={() => {
              workflow.invalidate();
              invalidateSelection();
              setState(workflow.getState());
            }}
          />
        </>
      ) : null}
      {busy ? (
        <Action
          label="Stop import"
          onPress={() => {
            workflow.stop();
            setState(workflow.getState());
          }}
        />
      ) : null}
      <Action
        label="Check saved import result"
        disabled={!writable}
        onPress={() => void run(() => workflow.recover())}
      />
      {state.message ? <Copy>{state.message}</Copy> : null}
      {state.phase === "completed" ? (
        <Copy>Import completed. Accepted memories may still be processing or waiting to sync.</Copy>
      ) : null}
      {state.phase === "partial" ? (
        <Copy>Import stopped with partial progress. Preview again before importing more.</Copy>
      ) : null}
      {state.receipt ? (
        <Copy>
          {state.receipt.items.length} results in the latest batch; {state.receipt.remaining}{" "}
          remaining. Completed batches: {state.settledChunks}. Accepted items may still be
          processing.
        </Copy>
      ) : null}
      {state.receipt
        ? nativeMemoryImportOutcomes(state.receipt).map((label) => <Copy key={label}>{label}</Copy>)
        : null}
      {error ? <Copy>{error}</Copy> : null}
    </SettingsSection>
  );
}
