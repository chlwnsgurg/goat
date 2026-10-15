import { RegistryContext, useAtomValue, useAtomSet } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthMemoryReadScope,
  AuthOrchestrationReadScope,
  MemoryId,
  MemoryOperationId,
  supportsMemoryProtocol,
  type EnvironmentId,
  type MemoryItem,
  type MemoryScope,
  type MemorySpaceId,
  type MemorySyncStatus,
  type MemoryReportReference,
  type MemoryReadSourceInput,
  type MemoryHistoryPage,
  type MemoryRevisionId,
  type MemoryRevertResolutionInput,
  type MemoryRevertResult,
} from "@goat/contracts";
import {
  presentMemoryItem,
  presentMemoryResolution,
  presentMemoryRevertResult,
  presentMemoryRevert,
  presentMemoryReport,
  memoryReportTarget,
  MEMORY_FORGET_NOTICE,
} from "@goat/client-runtime/memory-presentation";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Modal, FlatList, Pressable, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { memoryEnvironment as memory } from "../../state/memory";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentSession, useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHomeThreadSelection } from "../home/home-thread-navigation";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { MemoryAdministration } from "./MemorySharingSettings";
import { SettingsRow } from "./components/SettingsRow";
import {
  memoryExpectedHeads,
  validateMemoryDestination,
  type MemoryScreenParams,
} from "./SettingsMemoryRouteScreen.logic";

const operationId = () => MemoryOperationId.make(Crypto.randomUUID());
const PAGE_SIZE = 30;
function formatMemoryTime(value: string | null) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : "The request could not be completed.";
}
function Copy({ children }: { readonly children: React.ReactNode }) {
  return (
    <Text selectable className="p-3 text-sm text-foreground-muted">
      {children}
    </Text>
  );
}
function Action(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly tone?: "danger";
}) {
  return <SettingsActionRow icon="brain" {...props} />;
}
function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly multiline?: boolean;
}) {
  return (
    <View className="gap-2 p-3">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        editable={!props.disabled}
        multiline={props.multiline}
        className="rounded-lg border border-border p-3 text-foreground"
      />
    </View>
  );
}

/** A dialog and its callbacks belong to one connected screen lifetime. */
function useMemoryLifetime(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const connection = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const config = registry.get(serverEnvironment.configValueAtom(environmentId));
    return (
      mounted.current &&
      Option.isSome(connection) &&
      registry.get(environmentSession.preparedConnectionValueAtom(environmentId)) === connection &&
      config !== null &&
      supportsMemoryProtocol(config.environment.capabilities)
    );
  };
}
function MemoryConfirmation({
  title,
  message,
  label,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  label: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View className="flex-1 justify-center bg-background p-6" accessibilityViewIsModal>
        <Copy>{title}</Copy>
        <Copy>{message}</Copy>
        <Action label="Cancel" onPress={onClose} />
        <Action label={label} tone="danger" onPress={onConfirm} />
      </View>
    </Modal>
  );
}

/** Same explicit destination in Settings, native headers, palette and Bot reports. */
export function useMemoryNavigation(
  environmentId: EnvironmentId | null,
  extra: Omit<MemoryScreenParams, "environmentId"> = {},
) {
  const navigation = useNavigation();
  const thread = useThreadShell(extra.thread ?? null);
  const project =
    extra.project ??
    (thread && environmentId ? { environmentId, projectId: thread.projectId } : undefined);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const visible = config !== null && supportsMemoryProtocol(config.environment.capabilities);
  const destination = useMemo(
    () => ({ environmentId, ...extra, ...(project ? { project } : {}) }),
    [environmentId, extra, project],
  );
  const open = useCallback(() => {
    if (environmentId === null) return;
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsMemory", params: destination as MemoryScreenParams },
    });
  }, [navigation, environmentId, destination]);
  return { visible, open };
}

export function MemoryEnvironmentEntry({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { visible, open } = useMemoryNavigation(environmentId);
  const { savedConnectionsById } = useSavedRemoteConnections();
  return visible ? (
    <SettingsRow
      icon="brain"
      label={`Memory · ${savedConnectionsById[environmentId]?.environmentLabel ?? "Unknown device"}`}
      onPress={open}
    />
  ) : null;
}

export function MemoryReportLink({ reference }: { readonly reference: MemoryReportReference }) {
  const target = memoryReportTarget(reference);
  const { visible, open } = useMemoryNavigation(target.environmentId, target);
  const allowed = useAtomValue(memory.syncStatus.permissionAtom(target.environmentId));
  if (!visible) return null;
  return (
    <Action
      label={
        allowed ? "View memory details" : "Memory read permission is required to view this report"
      }
      onPress={open}
    />
  );
}

export function SettingsMemoryRouteScreen({
  route,
}: StaticScreenProps<MemoryScreenParams | undefined>) {
  const params = route.params;
  if (!validateMemoryDestination(params))
    return (
      <SettingsScreen title="Memory">
        <Copy>This memory link is invalid. Open Memory from Settings.</Copy>
      </SettingsScreen>
    );
  return (
    <SettingsScreen title="Memory">
      {params?.environmentId ? (
        <MemoryEnvironment
          key={JSON.stringify(params)}
          params={params as MemoryScreenParams & { environmentId: EnvironmentId }}
        />
      ) : (
        <MemoryChooser />
      )}
    </SettingsScreen>
  );
}
function MemoryChooser() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  return (
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic">
      <Copy>Choose the environment whose memory you want to manage.</Copy>
      {Object.values(savedConnectionsById).map((connection) => (
        <MemoryEnvironmentEntry
          key={connection.environmentId}
          environmentId={connection.environmentId}
        />
      ))}
      <Copy>Missing an environment? Connect it or update its server to use Memory.</Copy>
    </ScreenScrollView>
  );
}

function MemoryEnvironment({
  params,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
}) {
  const { environmentId } = params;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const session = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  const [connectionVersion, setConnectionVersion] = useState({ connection: session, version: 0 });
  if (connectionVersion.connection !== session)
    setConnectionVersion({ connection: session, version: connectionVersion.version + 1 });
  const readAllowed = useAtomValue(memory.syncStatus.permissionAtom(environmentId));
  const adminAllowed = useAtomValue(memory.hubSettingsGet.permissionAtom(environmentId));
  const writeAllowed = useAtomValue(memory.upsert.permissionAtom(environmentId));
  const supported = config !== null && supportsMemoryProtocol(config.environment.capabilities);
  // Remount all projections on connection replacement or loss of access. No late reply survives.
  if (!supported)
    return (
      <MemoryConnectionHelp
        environmentId={environmentId}
        message="Update this environment's server and reconnect to use Memory."
      />
    );
  if (Option.isNone(session))
    return (
      <MemoryConnectionHelp
        environmentId={environmentId}
        message="Reconnect this environment to manage its memory."
      />
    );
  if (!readAllowed && !adminAllowed && !writeAllowed)
    return <Copy>This connection does not have permission to manage memory.</Copy>;
  return (
    <MemoryConnected
      key={`${connectionVersion.version}:${readAllowed}:${adminAllowed}:${writeAllowed}`}
      params={params}
      readAllowed={readAllowed}
    />
  );
}

function MemoryConnectionHelp({
  environmentId,
  message,
}: {
  readonly environmentId: EnvironmentId;
  readonly message: string;
}) {
  const navigation = useNavigation();
  return (
    <>
      <Copy>{message}</Copy>
      <SettingsRow
        icon="desktopcomputer"
        label="Open environment connection"
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsEnvironmentDetail", params: { environmentId } },
          })
        }
      />
      <SettingsRow
        icon="desktopcomputer"
        label="Saved environments"
        target="SettingsEnvironments"
      />
    </>
  );
}

function MemoryConnected({
  params,
  readAllowed,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly readAllowed: boolean;
}) {
  const registry = useContext(RegistryContext);
  const { environmentId } = params;
  const sync = useAtomCommand(memory.syncStatus);
  const [status, setStatus] = useState<MemorySyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedSpace, setSavedSpace] = useState<MemorySpaceId | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    if (!mounted.current || !registry.get(memory.syncStatus.permissionAtom(environmentId))) return;
    const before = ++generation.current;
    setStatus(null);
    setError(null);
    const result = await sync({ environmentId, input: {} });
    if (
      !mounted.current ||
      before !== generation.current ||
      !registry.get(memory.syncStatus.permissionAtom(environmentId))
    )
      return;
    if (AsyncResult.isSuccess(result)) {
      setStatus(result.value);

      setError(null);
    } else if (AsyncResult.isFailure(result)) setError(failureMessage(result));
  }, [registry, environmentId, sync]);
  useEffect(() => {
    // The command synchronizes the selected environment, not derived render state.
    // oxlint-disable-next-line react/set-state-in-effect
    if (readAllowed) void load();
  }, [load, readAllowed]);
  const readySpace =
    status && status.state !== "disabled" && status.state !== "bootstrapping"
      ? status.memorySpaceId
      : null;
  if (readySpace && readySpace !== savedSpace) setSavedSpace(readySpace);
  const space = params.memorySpaceId ?? readySpace ?? savedSpace;
  const enabled =
    status !== null && status.state !== "disabled" && status.state !== "bootstrapping";
  return (
    <View className="flex-1">
      {status?.state === "bootstrapping" && status.memorySpaceId ? (
        <MemoryBootstrapRefresh
          environmentId={environmentId}
          memorySpaceId={status.memorySpaceId}
          onChange={load}
        />
      ) : null}
      {error ? <Copy>Could not load memory status.</Copy> : null}
      {space && readAllowed ? (
        <MemoryBrowser
          key={space}
          params={params}
          memorySpaceId={space}
          memoryEnabled={enabled}
          onSyncRefresh={load}
          status={status}
        />
      ) : (
        <ScreenScrollView>
          <MemoryAdministration
            environmentId={environmentId}
            onSharingRefresh={() => void load()}
            sync={status}
          />
          <SettingsSection title="Memories">
            <Copy>
              {!readAllowed
                ? "Memory read permission is required to view records."
                : status?.state === "disabled"
                  ? "Turn on memory to see and save memories."
                  : "Memory is getting ready."}
            </Copy>
          </SettingsSection>
          {error ? <Action label="Retry memory status" onPress={() => void load()} /> : null}
        </ScreenScrollView>
      )}
    </View>
  );
}

function MemoryBootstrapRefresh({
  environmentId,
  memorySpaceId,
  onChange,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  onChange: () => Promise<void>;
}) {
  const exposure = useAtomValue(memory.exposureAtom({ environmentId, input: { memorySpaceId } }));
  useEffect(() => {
    if (exposure.ready) void onChange();
  }, [exposure, onChange]);
  return null;
}

function MemoryBrowser({
  params,
  memorySpaceId,
  onSyncRefresh,
  memoryEnabled,
  status,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId;
  readonly onSyncRefresh: () => Promise<void>;
  readonly memoryEnabled: boolean;
  readonly status: MemorySyncStatus | null;
}) {
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(memory.upsert.permissionAtom(params.environmentId));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState(params.memoryId);
  const [creating, setCreating] = useState(false);
  const [scope] = useState<MemoryScope | undefined>();
  const [quarantine] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const exposure = useAtomValue(
    memory.exposureAtom({ environmentId: params.environmentId, input: { memorySpaceId } }),
  );
  const [forgetGeneration, setForgetGeneration] = useState(exposure.forgetGeneration);
  if (forgetGeneration !== exposure.forgetGeneration) {
    setForgetGeneration(exposure.forgetGeneration);
    setSelected(undefined);
    setCreating(false);
  }
  const [wasEnabled, setWasEnabled] = useState(memoryEnabled);
  if (wasEnabled !== memoryEnabled) {
    setWasEnabled(memoryEnabled);
    setCreating(false);
  }

  const input = {
    memorySpaceId,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(scope ? { scope } : {}),
  };
  const atom = search
    ? memory.search({
        environmentId: params.environmentId,
        input: { ...input, query: search, mode: "fts" },
      })
    : memory.list({
        environmentId: params.environmentId,
        input: { ...input, includeQuarantined: quarantine },
      });
  const result = useAtomValue(atom);
  const page = AsyncResult.isSuccess(result) ? Option.getOrNull(result.value) : null;
  if (selected)
    return (
      <MemoryDetails
        key={selected}
        params={params}
        memorySpaceId={memorySpaceId}
        memoryId={selected}
        memoryEnabled={memoryEnabled}
        onClose={() => setSelected(undefined)}
        onForgotten={() => {
          setSelected(undefined);
          setNotice("Forgotten. Other devices remove it when they sync.");
          registry.refresh(atom);
        }}
      />
    );
  if (creating && memoryEnabled)
    return (
      <MemoryEditor
        params={params}
        memorySpaceId={memorySpaceId}
        scope={scope ?? { kind: "user" }}
        onClose={() => {
          setCreating(false);
          registry.refresh(atom);
        }}
      />
    );
  return (
    <FlatList
      data={page?.items ?? []}
      keyExtractor={(item) => item.memoryId}
      contentInsetAdjustmentBehavior="automatic"
      ListHeaderComponent={
        <>
          <MemoryAdministration
            environmentId={params.environmentId}
            onSharingRefresh={() => void onSyncRefresh()}
            sync={status}
          />
          <SettingsSection title="Memories">
            {!memoryEnabled ? (
              <Copy>Saved memories stay. Turn on memory to save new memories.</Copy>
            ) : null}
            {notice ? <Copy>{notice}</Copy> : null}
          </SettingsSection>
          <Field label="Search memory" value={query} onChange={setQuery} />
          <Action
            label="Search"
            onPress={() => {
              setSearch(query.trim());
              setCursor(undefined);
            }}
          />
          <Action
            label="Remember something"
            onPress={() => setCreating(true)}
            disabled={!canWrite || !memoryEnabled}
          />
        </>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open memory: ${item.status === "active" ? item.payload.text : item.status === "forgotten" ? "Forgotten memory" : "Conflicting memory"}`}
          onPress={() => {
            registry.refresh(
              memory.read({
                environmentId: params.environmentId,
                input: { memorySpaceId, memoryId: item.memoryId },
              }),
            );
            setSelected(item.memoryId);
          }}
          className="gap-1 border-b border-border p-4"
        >
          <Text className="text-foreground">
            {item.status === "active"
              ? item.payload.text
              : item.status === "forgotten"
                ? "Forgotten memory"
                : "Conflicting memory"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {presentMemoryItem(item).label}
            {presentMemoryItem(item).syncLabel ? ` · ${presentMemoryItem(item).syncLabel}` : ""}
          </Text>
        </Pressable>
      )}
      ListEmptyComponent={
        <Copy>
          {AsyncResult.isFailure(result)
            ? "Could not load memory. Refresh to try again."
            : page
              ? "No matching memories on this page."
              : "Waiting for memory access or fresh data. Refresh to try again."}
        </Copy>
      }
      ListFooterComponent={
        <>
          <Action label="Refresh memories" onPress={() => registry.refresh(atom)} />
          {page?.nextCursor ? (
            <Action
              label="Next page"
              disabled={!page?.nextCursor}
              onPress={() => setCursor(page?.nextCursor ?? undefined)}
            />
          ) : null}
          {cursor ? <Action label="First page" onPress={() => setCursor(undefined)} /> : null}
        </>
      }
    />
  );
}

function MemoryDetails({
  params,
  memorySpaceId,
  memoryId,
  memoryEnabled,
  onForgotten,
  onClose,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId;
  readonly memoryId: MemoryId;
  readonly memoryEnabled: boolean;
  readonly onForgotten: () => void;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const deviceName = (id: EnvironmentId) =>
    savedConnectionsById[id]?.environmentLabel ?? "Unknown device";
  const target = { environmentId: params.environmentId, input: { memorySpaceId, memoryId } };
  const readAtom = memory.read(target);
  const result = useAtomValue(readAtom);
  const item = AsyncResult.isSuccess(result) ? Option.getOrNull(result.value) : null;
  const [cursor, setCursor] = useState<string | undefined>();
  const historyAtom = memory.history({
    ...target,
    input: { ...target.input, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
  });
  const historyResult = useAtomValue(historyAtom);
  const history = AsyncResult.isSuccess(historyResult)
    ? Option.getOrNull(historyResult.value)
    : null;
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState<MemoryReadSourceInput | null>(null);
  const canWrite = useAtomValue(memory.upsert.permissionAtom(params.environmentId));
  const canForget = useAtomValue(memory.forget.permissionAtom(params.environmentId));
  const canReadOriginal = useEnvironmentScope(params.environmentId, AuthOrchestrationReadScope);
  const forget = useAtomCommand(memory.forget);
  const liveDestination = useMemoryLifetime(params.environmentId);
  const [confirmForget, setConfirmForget] = useState(false);
  const intent = useRef<{
    operationId: MemoryOperationId;
    expectedHeads: ReturnType<typeof memoryExpectedHeads>;
  } | null>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const [hadItem, setHadItem] = useState(item !== null);
  if (hadItem !== (item !== null)) {
    setHadItem(item !== null);
    if (!item) {
      setSource(null);
      setEditing(false);
      setConfirmForget(false);
    }
  }
  async function performForget() {
    const current = registry.get(readAtom);
    const live = AsyncResult.isSuccess(current) ? Option.getOrNull(current.value) : null;
    if (
      !liveDestination() ||
      !readEnvironmentScope(params.environmentId, AuthMemoryReadScope) ||
      busy.current ||
      !registry.get(memory.forget.permissionAtom(params.environmentId))
    )
      return;
    if (!intent.current) {
      if (!live) return;
      intent.current = { operationId: operationId(), expectedHeads: memoryExpectedHeads(live) };
    }
    busy.current = true;
    setPending(true);
    try {
      const result = await forget({
        environmentId: params.environmentId,
        input: { memorySpaceId, memoryId, ...intent.current },
      });
      if (!mounted.current || !registry.get(memory.forget.permissionAtom(params.environmentId)))
        return;
      if (AsyncResult.isSuccess(result)) {
        onForgotten();
        intent.current = null;
        setRetry(false);
        registry.refresh(readAtom);
        registry.refresh(historyAtom);
      } else if (AsyncResult.isFailure(result)) {
        setRetry(true);
        setNotice(`${failureMessage(result)} Retry uses the same request.`);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  if (editing && memoryEnabled && item?.status === "active")
    return (
      <MemoryEditor
        params={params}
        memorySpaceId={memorySpaceId}
        scope={item.scope}
        item={item}
        onClose={() => {
          setEditing(false);
          registry.refresh(readAtom);
        }}
      />
    );
  return (
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic">
      <Action label="Close details" onPress={onClose} />
      {notice ? <Copy>{notice}</Copy> : null}
      {item ? (
        <>
          <Copy>
            {presentMemoryItem(item).label}
            {presentMemoryItem(item).syncLabel ? ` · ${presentMemoryItem(item).syncLabel}` : ""}
            {presentMemoryItem(item).cleanupLabel
              ? ` · ${presentMemoryItem(item).cleanupLabel}`
              : ""}
          </Copy>
          {item.status === "active" ? (
            <>
              <Copy>{item.payload.text}</Copy>
              <Copy>
                Source: {item.revision.provenance.provider ?? "User"} ·{" "}
                {deviceName(item.revision.provenance.environmentId)}
              </Copy>
              <Action
                label="Edit"
                disabled={!canWrite || !memoryEnabled || pending}
                onPress={() => setEditing(true)}
              />
              {item.payload.evidence.map((evidence) =>
                evidence.sourceThread && evidence.messageIds.length > 0 ? (
                  <Action
                    key={JSON.stringify(evidence)}
                    label={`Read original on ${deviceName(evidence.sourceThread.environmentId)}`}
                    disabled={!canReadOriginal}
                    onPress={() =>
                      setSource({
                        memorySpaceId,
                        memoryId,
                        sourceThread: evidence.sourceThread!,
                        messageIds: evidence.messageIds,
                        limit: PAGE_SIZE,
                      })
                    }
                  />
                ) : null,
              )}
            </>
          ) : null}
          {!retry ? (
            <Action
              label="Forget"
              disabled={!canForget || !presentMemoryItem(item).canForget || pending}
              onPress={() => setConfirmForget(true)}
            />
          ) : null}
        </>
      ) : (
        <Copy>
          {AsyncResult.isFailure(result)
            ? "Could not load this memory."
            : "Memory unavailable or awaiting fresh access."}
        </Copy>
      )}
      {pending ? <Copy>Forget request pending.</Copy> : null}
      {retry ? (
        <Action
          label="Retry forget request"
          disabled={!canForget || pending}
          onPress={() => void performForget()}
        />
      ) : null}
      {confirmForget ? (
        <MemoryConfirmation
          title="Forget this memory?"
          message={MEMORY_FORGET_NOTICE}
          label="Confirm forget"
          onClose={() => setConfirmForget(false)}
          onConfirm={() => {
            setConfirmForget(false);
            void performForget();
          }}
        />
      ) : null}
      <Action
        label="Refresh details"
        onPress={() => {
          registry.refresh(readAtom);
          registry.refresh(historyAtom);
        }}
      />
      {source && item ? (
        <MemorySource
          key={JSON.stringify(source)}
          environmentId={params.environmentId}
          input={source}
          onClose={() => setSource(null)}
        />
      ) : null}
      <SettingsSection title="History">
        {item ? (
          <>
            {history?.revisions.map((pair, index) => (
              <View key={pair.revision.revisionId}>
                <Copy>
                  {history.resolutions.some((r) =>
                    r.resolution.inputRevisionIds.includes(pair.revision.revisionId),
                  )
                    ? "Original"
                    : "Version"}{" "}
                  {index + 1} · {formatMemoryTime(pair.revision.createdAtUtc)} ·{" "}
                  {pair.revision.provenance.provider ?? "User"}
                </Copy>
                <Copy>{pair.payload?.text ?? "Original unavailable"}</Copy>
              </View>
            ))}
            {history?.resolutions.map((entry) => {
              const view = presentMemoryResolution(entry);
              return (
                <View key={entry.resolution.resolutionId}>
                  <Copy>
                    {params.resolutionId === entry.resolution.resolutionId
                      ? "Selected resolution · "
                      : ""}
                    {view.label} · {view.providerLabel} · {view.effectiveModel} ·{" "}
                    {deviceName(view.resolvingEnvironmentId)}
                  </Copy>
                  <Copy>
                    Applied: {formatMemoryTime(view.appliedAtUtc)} · Revert deadline:{" "}
                    {formatMemoryTime(view.revertDeadlineUtc)}
                  </Copy>
                  <Copy>{entry.payload?.judgment ?? "Judgment unavailable"}</Copy>
                  {item && history && memoryEnabled ? (
                    <MemoryRevertControl
                      environmentId={params.environmentId}
                      item={item}
                      entry={entry}
                      history={history}
                      readCurrent={() => {
                        const value = registry.get(readAtom);
                        return AsyncResult.isSuccess(value) ? Option.getOrNull(value.value) : null;
                      }}
                      readHistory={() => {
                        const value = registry.get(historyAtom);
                        return AsyncResult.isSuccess(value) ? Option.getOrNull(value.value) : null;
                      }}
                      onSettled={() => {
                        registry.refresh(readAtom);
                        registry.refresh(historyAtom);
                      }}
                    />
                  ) : null}
                </View>
              );
            })}
          </>
        ) : null}
        {history?.revertResults.map((value) => (
          <Copy key={value.operationId}>{presentMemoryRevertResult(value).label}</Copy>
        ))}
        {history?.reports.map((report) => (
          <MemoryReport key={report.reportId} report={report} />
        ))}
        <Action
          label="Next history page"
          disabled={!history?.nextCursor}
          onPress={() => setCursor(history?.nextCursor ?? undefined)}
        />
        <Action
          label="First history page"
          disabled={!cursor}
          onPress={() => setCursor(undefined)}
        />
      </SettingsSection>
    </ScreenScrollView>
  );
}

function MemoryRevertControl({
  environmentId,
  item,
  entry,
  history,
  readCurrent,
  readHistory,
  onSettled,
}: {
  environmentId: EnvironmentId;
  item: MemoryItem;
  entry: MemoryHistoryPage["resolutions"][number];
  history: MemoryHistoryPage;
  readCurrent: () => MemoryItem | null;
  readHistory: () => MemoryHistoryPage | null;
  onSettled: () => void;
}) {
  const registry = useContext(RegistryContext);
  const liveDestination = useMemoryLifetime(environmentId);
  const allowed = useAtomValue(memory.revertResolution.permissionAtom(environmentId));
  const revert = useAtomCommand(memory.revertResolution);
  const [selected, setSelected] = useState<MemoryRevisionId | null>(null);
  const [intent, setIntent] = useState<MemoryRevertResolutionInput | null>(null);
  const [result, setResult] = useState<MemoryRevertResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [openedAt] = useState(Date.now);
  const display = presentMemoryRevert({
    item,
    entry,
    history,
    now: openedAt,
    ...(selected ? { restoredRevisionId: selected } : {}),
  });
  const available = allowed && display.canRevert;
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
  function active() {
    return liveDestination() && registry.get(memory.revertResolution.permissionAtom(environmentId));
  }
  async function submit() {
    if (!selected || busy.current || result || !active()) return;
    const current = readCurrent();
    const page = readHistory();
    const resolution = page?.resolutions.find(
      (value) => value.resolution.resolutionId === entry.resolution.resolutionId,
    );
    if (
      !current ||
      !page ||
      !resolution ||
      current.memoryId !== item.memoryId ||
      current.memorySpaceId !== item.memorySpaceId ||
      current.status !== "active"
    )
      return;
    if (
      !presentMemoryRevert({
        item: current,
        entry: resolution,
        history: page,
        now: Date.now(),
        restoredRevisionId: selected,
      }).canRevert
    )
      return;
    if (intent && intent.expectedHeads[0] !== current.revision.revisionId) return;
    const input = intent ?? {
      memorySpaceId: current.memorySpaceId,
      memoryId: current.memoryId,
      resolutionId: resolution.resolution.resolutionId,
      restoredRevisionId: selected,
      expectedHeads: [current.revision.revisionId],
      operationId: operationId(),
    };
    setIntent(input);
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await revert({ environmentId, input });
      if (!active()) return;
      if (AsyncResult.isFailure(response)) {
        setError("Revert request failed. Retry uses the same request.");
      } else if (AsyncResult.isSuccess(response)) {
        setResult(response.value);
        setIntent(null);
        setSelected(null);
        onSettled();
      }
    } finally {
      busy.current = false;
      if (active()) setPending(false);
    }
  }
  return (
    <View>
      <Copy>{display.windowLabel}</Copy>
      {display.timeNotice ? <Copy>{display.timeNotice}</Copy> : null}
      {display.reason ? <Copy>{display.reason}</Copy> : null}
      {!allowed ? <Copy>Memory write permission is required to revert.</Copy> : null}
      {error ? <Copy>{error}</Copy> : null}
      {result ? <Copy>{presentMemoryRevertResult(result).label}</Copy> : null}
      {!result && available ? (
        <>
          <Copy>Choose the retained original to restore.</Copy>
          {display.restorableRevisionIds.map((id, index) => (
            <Action
              key={id}
              label={`${selected === id ? "Selected original" : "Restore original"} ${index + 1}`}
              disabled={pending || intent !== null}
              onPress={() => setSelected(id)}
            />
          ))}
          <Action
            label={intent ? "Retry revert request" : "Revert resolution"}
            disabled={!selected || pending}
            onPress={() => void submit()}
          />
          <Action
            label="Cancel revert"
            disabled={pending}
            onPress={() => {
              setSelected(null);
              setIntent(null);
              setError(null);
            }}
          />
        </>
      ) : null}
    </View>
  );
}

function MemorySource({
  environmentId,
  input,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: MemoryReadSourceInput;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [cursor, setCursor] = useState<string | undefined>();
  const atom = memory.readSource({
    environmentId,
    input: { ...input, ...(cursor ? { cursor } : {}) },
  });
  const result = useAtomValue(atom);
  const page = AsyncResult.isSuccess(result) ? Option.getOrNull(result.value) : null;
  return (
    <SettingsSection title="Original">
      <Action label="Close original" onPress={onClose} />
      <Copy>
        {page
          ? page.messages.map((message) => message.text).join("\n\n")
          : "Original unavailable. Check source permissions and the owner's connection."}
      </Copy>
      <Action label="Refresh original" onPress={() => registry.refresh(atom)} />
      <Action
        label="Next original page"
        disabled={!page?.nextCursor}
        onPress={() => setCursor(page?.nextCursor ?? undefined)}
      />
    </SettingsSection>
  );
}

function MemoryReport({ report }: { readonly report: Parameters<typeof presentMemoryReport>[0] }) {
  const view = presentMemoryReport(report);
  const onSelectThread = useHomeThreadSelection();
  const target = view.reportTarget;
  const config = useAtomValue(serverEnvironment.configValueAtom(target?.environmentId ?? null));
  const allowed = useEnvironmentScope(target?.environmentId ?? null, AuthOrchestrationReadScope);
  return (
    <View>
      <Copy>
        {view.label} · Automatic attempts: {view.automaticAttempts ?? "Unknown"}
      </Copy>
      {target ? (
        <Action
          label="Open report"
          disabled={!config || !allowed}
          onPress={() => {
            if (readEnvironmentScope(target.environmentId, AuthOrchestrationReadScope))
              onSelectThread({ environmentId: target.environmentId, id: target.threadId });
          }}
        />
      ) : null}
      <Copy>Manual delivery retry is unavailable on this server.</Copy>
    </View>
  );
}

function MemoryEditor({
  params,
  memorySpaceId,
  scope,
  item,
  onClose,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId;
  readonly scope: MemoryScope;
  readonly item?: Extract<MemoryItem, { status: "active" }>;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [id] = useState(() => item?.memoryId ?? MemoryId.make(Crypto.randomUUID()));
  const draftAtom = useMemo(
    () =>
      memory.draftAtom({
        environmentId: params.environmentId,
        input: { memorySpaceId },
        draftId: `native:${id}`,
      }),
    [params.environmentId, memorySpaceId, id],
  );
  const text = useAtomValue(draftAtom);
  const setDraft = useAtomSet(draftAtom);
  const allowed = useAtomValue(memory.upsert.permissionAtom(params.environmentId));
  const upsert = useAtomCommand(memory.upsert);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<MemoryOperationId | null>(null);
  const [retry, setRetry] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    registry.set(draftAtom, { text: item?.payload.text ?? "", memoryIds: item ? [id] : [] });
    return () => {
      mounted.current = false;
      registry.set(draftAtom, null);
    };
  }, [registry, draftAtom, item, id]);
  async function save() {
    const current = registry.get(draftAtom);
    if (
      !current?.trim() ||
      busy.current ||
      !registry.get(memory.upsert.permissionAtom(params.environmentId))
    )
      return;
    intent.current ??= operationId();
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await upsert({
        environmentId: params.environmentId,
        input: {
          memorySpaceId,
          operationId: intent.current,
          memoryId: id,
          expectedHeads: item ? [item.revision.revisionId] : [],
          scope,
          assertionKind: item?.revision.assertionKind ?? "fact",
          payload: {
            text: current,
            evidence: item?.payload.evidence ?? [{ origin: "user", messageIds: [] }],
            derivedFromMemoryRevisions: item?.payload.derivedFromMemoryRevisions ?? [],
          },
          baseBoundary: null,
        },
      });
      if (
        !mounted.current ||
        registry.get(draftAtom) !== current ||
        !registry.get(memory.upsert.permissionAtom(params.environmentId))
      )
        return;
      if (AsyncResult.isSuccess(result)) {
        setError(
          `Request ${result.value.outcome}${result.value.pendingSync ? " · Propagation pending" : ""}`,
        );
        intent.current = null;
        if (result.value.outcome === "accepted" || result.value.outcome === "noop") onClose();
      } else if (AsyncResult.isFailure(result)) {
        setRetry(true);
        setError(`${failureMessage(result)} Retry uses the same request.`);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic">
      <Action label="Close editor" onPress={onClose} />
      {text === null ? (
        <Copy>The draft is no longer available. Close and reopen this memory.</Copy>
      ) : (
        <>
          <Field
            label="Memory text"
            value={text}
            onChange={(value) => setDraft({ text: value, memoryIds: item ? [id] : [] })}
            disabled={pending || retry || !allowed}
            multiline
          />
          <Action
            label={retry ? "Retry save request" : "Save memory"}
            onPress={() => void save()}
            disabled={!allowed || pending || !text.trim()}
          />
        </>
      )}
      {error ? <Copy>{error}</Copy> : null}
    </ScreenScrollView>
  );
}
