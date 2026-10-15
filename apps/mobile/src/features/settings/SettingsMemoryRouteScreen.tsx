import { RegistryContext, useAtomValue, useAtomSet } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId as EnvironmentIdSchema,
  MemorySpaceId as MemorySpaceIdSchema,
  MemoryId,
  MemoryOperationId,
  supportsMemoryProtocol,
  type EnvironmentId,
  type MemoryItem,
  type MemoryScope,
  type MemorySpaceId,
  type MemorySyncStatus,
  type MemoryHubSettingsView,
  type MemoryOwnerSourceReadPolicyView,
  type MemoryProjectBinding,
  type MemoryHubSettings,
  type MemoryReportReference,
  type MemoryReadSourceInput,
} from "@goat/contracts";
import {
  presentMemoryItem,
  presentMemorySync,
  presentMemoryForget,
  presentMemoryOwnerPolicy,
  presentMemoryResolution,
  presentMemoryRevertResult,
  presentMemoryReport,
  memoryReportTarget,
  MEMORY_FORGET_NOTICE,
} from "@goat/client-runtime/memory-presentation";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { memoryEnvironment as memory } from "../../state/memory";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHomeThreadSelection } from "../home/home-thread-navigation";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsRow } from "./components/SettingsRow";
import {
  memoryExpectedHeads,
  memoryScopeForSelection,
  toggleMemoryRequester,
  validateMemoryDestination,
  type MemoryScreenParams,
} from "./SettingsMemoryRouteScreen.logic";

const operationId = () => MemoryOperationId.make(Crypto.randomUUID());
const PAGE_SIZE = 30;
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
  const open = useCallback(() => {
    if (environmentId === null) return;
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsMemory",
        params: { environmentId, ...extra, ...(project ? { project } : {}) },
      },
    });
  }, [
    navigation,
    environmentId,
    project?.projectId,
    extra.project,
    extra.thread,
    extra.memorySpaceId,
    extra.memoryId,
    extra.resolutionId,
  ]);
  return { visible, open };
}

export function MemoryEnvironmentEntry({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { visible, open } = useMemoryNavigation(environmentId);
  return visible ? <SettingsRow icon="brain" label="Memory" onPress={open} /> : null;
}

export function MemoryReportLink({ reference }: { readonly reference: MemoryReportReference }) {
  const target = memoryReportTarget(reference);
  const { visible, open } = useMemoryNavigation(target.environmentId, target);
  const allowed = useAtomValue(memory.syncStatus.permissionAtom(target.environmentId));
  return (
    <Action
      label={
        visible && allowed
          ? "View memory details"
          : "Connect or update the report's environment to view memory"
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
  const connectionVersion = useRef({ connection: session, version: 0 });
  if (connectionVersion.current.connection !== session)
    connectionVersion.current = {
      connection: session,
      version: connectionVersion.current.version + 1,
    };
  const readAllowed = useAtomValue(memory.syncStatus.permissionAtom(environmentId));
  const adminAllowed = useAtomValue(memory.hubSettingsGet.permissionAtom(environmentId));
  const writeAllowed = useAtomValue(memory.upsert.permissionAtom(environmentId));
  const supported = config !== null && supportsMemoryProtocol(config.environment.capabilities);
  // Remount all projections on connection replacement or loss of access. No late reply survives.
  if (!supported) return <Copy>Update this environment's server and reconnect to use Memory.</Copy>;
  if (Option.isNone(session)) return <Copy>Reconnect this environment to manage its memory.</Copy>;
  if (!readAllowed && !adminAllowed && !writeAllowed)
    return <Copy>This connection does not have permission to manage memory.</Copy>;
  return (
    <MemoryConnected
      key={`${connectionVersion.current.version}:${readAllowed}:${adminAllowed}:${writeAllowed}`}
      params={params}
      connection={session.value}
      readAllowed={readAllowed}
      adminAllowed={adminAllowed}
    />
  );
}

function MemoryConnected({
  params,
  connection,
  readAllowed,
  adminAllowed,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly connection: object;
  readonly readAllowed: boolean;
  readonly adminAllowed: boolean;
}) {
  const registry = useContext(RegistryContext);
  const { environmentId } = params;
  const sync = useAtomCommand(memory.syncStatus);
  const [status, setStatus] = useState<MemorySyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [connection]);
  const load = useCallback(async () => {
    if (!registry.get(memory.syncStatus.permissionAtom(environmentId))) return;
    const before = generation.current;
    const result = await sync({ environmentId, input: {} });
    if (
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
    if (readAllowed) void load();
  }, [load, readAllowed]);
  const space = params.memorySpaceId ?? status?.memorySpaceId;
  return (
    <View className="flex-1">
      <Copy>
        Environment: {environmentId}
        {space ? ` · Space: ${space}` : ""}
      </Copy>
      {error ? <Copy>{error}</Copy> : null}
      {readAllowed ? (
        <>
          <Copy>{status ? presentMemorySync(status).label : "Checking memory sharing…"}</Copy>
          <Action label="Refresh sharing status" onPress={() => void load()} />
        </>
      ) : null}
      {params.memorySpaceId &&
      status?.memorySpaceId &&
      status.memorySpaceId !== params.memorySpaceId ? (
        <Copy>This link names a different memory space. Its destination has been preserved.</Copy>
      ) : null}
      {space && readAllowed ? (
        <MemoryBrowser key={space} params={params} memorySpaceId={space} />
      ) : (
        <ScreenScrollView>
          <Copy>
            {readAllowed
              ? "No memory space is bound yet. Configure sharing below."
              : "Memory read access is unavailable. Administrative settings remain available."}
          </Copy>
          <MemoryWriteAccess params={params} />
          <MemoryAdministration params={params} memorySpaceId={null} />
        </ScreenScrollView>
      )}
    </View>
  );
}

function MemoryWriteAccess({
  params,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
}) {
  const allowed = useAtomValue(memory.upsert.permissionAtom(params.environmentId));
  const [space, setSpace] = useState(params.memorySpaceId ?? "");
  const [selected, setSelected] = useState<MemorySpaceId | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!allowed) return null;
  if (selected)
    return (
      <MemoryEditor
        params={params}
        memorySpaceId={selected}
        scope={{ kind: "user" }}
        onClose={() => setSelected(null)}
      />
    );
  return (
    <>
      <Copy>
        Write access does not include reading existing memories. Choose the exact space for a new
        memory.
      </Copy>
      <Field label="Memory space ID" value={space} onChange={setSpace} />
      <Action
        label="Remember in selected space"
        disabled={!space.trim()}
        onPress={() => {
          try {
            setSelected(MemorySpaceIdSchema.make(space.trim()));
          } catch {
            setError("Enter a valid memory space ID.");
          }
        }}
      />
      {error ? <Copy>{error}</Copy> : null}
    </>
  );
}

function MemoryBrowser({
  params,
  memorySpaceId,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId;
}) {
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(memory.upsert.permissionAtom(params.environmentId));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState(params.memoryId);
  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState<MemoryScope | undefined>();
  const [quarantine, setQuarantine] = useState(true);
  const [binding, setBinding] = useState<MemoryProjectBinding | null>(null);
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
        onClose={() => setSelected(undefined)}
      />
    );
  if (creating)
    return (
      <MemoryEditor
        params={params}
        memorySpaceId={memorySpaceId}
        scope={scope ?? { kind: "user" }}
        onClose={() => setCreating(false)}
      />
    );
  return (
    <FlatList
      data={page?.items ?? []}
      keyExtractor={(item) => item.memoryId}
      contentInsetAdjustmentBehavior="automatic"
      ListHeaderComponent={
        <>
          <Field label="Search memory" value={query} onChange={setQuery} />
          <Action
            label="Search"
            onPress={() => {
              setSearch(query.trim());
              setCursor(undefined);
            }}
          />
          <Action
            label="Clear search and filters"
            onPress={() => {
              setQuery("");
              setSearch("");
              setScope(undefined);
              setCursor(undefined);
            }}
          />
          <View className="flex-row flex-wrap">
            {(["user", "project", "thread"] as const).map((kind) => (
              <View key={kind}>
                <Action
                  label={`${kind} memory`}
                  disabled={
                    kind === "project"
                      ? binding?.projectKey == null
                      : kind === "thread" && !params.thread
                  }
                  onPress={() => {
                    setScope(memoryScopeForSelection(kind, params, binding?.projectKey ?? null));
                    setCursor(undefined);
                  }}
                />
              </View>
            ))}
          </View>
          <Action
            label={quarantine ? "Hide quarantined memories" : "Include quarantined memories"}
            onPress={() => {
              setQuarantine((value) => !value);
              setCursor(undefined);
            }}
          />
          <Action
            label="Remember something"
            onPress={() => setCreating(true)}
            disabled={!canWrite}
          />
        </>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open memory ${item.memoryId}`}
          onPress={() => setSelected(item.memoryId)}
          className="gap-1 border-b border-border p-4"
        >
          <Text className="text-foreground">
            {item.status === "active" ? item.payload.text : item.memoryId}
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
          <Action
            label="Next page"
            disabled={!page?.nextCursor}
            onPress={() => setCursor(page?.nextCursor ?? undefined)}
          />
          <Action label="First page" disabled={!cursor} onPress={() => setCursor(undefined)} />
          {page ? <Copy>Index coverage: {page.indexCoverage?.status ?? "Unknown"}</Copy> : null}
          <MemoryAdministration
            params={params}
            memorySpaceId={memorySpaceId}
            onBinding={(value) => {
              setBinding(value);
              setScope(undefined);
              setCursor(undefined);
            }}
          />
        </>
      }
    />
  );
}

function MemoryDetails({
  params,
  memorySpaceId,
  memoryId,
  onClose,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId;
  readonly memoryId: MemoryId;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
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
  const forget = useAtomCommand(memory.forget);
  const intent = useRef<{
    operationId: MemoryOperationId;
    expectedHeads: ReturnType<typeof memoryExpectedHeads>;
  } | null>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  async function performForget() {
    const current = registry.get(readAtom);
    const live = AsyncResult.isSuccess(current) ? Option.getOrNull(current.value) : null;
    if (busy.current || !live || !registry.get(memory.forget.permissionAtom(params.environmentId)))
      return;
    intent.current ??= { operationId: operationId(), expectedHeads: memoryExpectedHeads(live) };
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
        const view = presentMemoryForget(result.value);
        setNotice(
          `${view.label} · Expansion: ${view.expansionStatus}${view.pendingSync ? " · Propagation pending" : ""}${view.failureCode ? ` · ${view.failureCode}` : ""}`,
        );
        intent.current = null;
        registry.refresh(readAtom);
        registry.refresh(historyAtom);
      } else if (AsyncResult.isFailure(result))
        setNotice(`${failureMessage(result)} Retry uses the same request.`);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  if (editing && item?.status === "active")
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
      <Action label="Back to memories" onPress={onClose} />
      <Copy>Memory: {memoryId}</Copy>
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
                {item.revision.provenance.environmentId}
              </Copy>
              <Action
                label="Edit memory"
                disabled={!canWrite || pending}
                onPress={() => setEditing(true)}
              />
              {item.payload.evidence.map((evidence, index) =>
                evidence.sourceThread && evidence.messageIds.length > 0 ? (
                  <Action
                    key={index}
                    label={`Read original on ${evidence.sourceThread.environmentId}`}
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
          <Action
            label={intent.current ? "Retry forget request" : "Forget memory"}
            disabled={!canForget || !presentMemoryItem(item).canForget || pending}
            onPress={() =>
              Alert.alert("Forget this memory?", MEMORY_FORGET_NOTICE, [
                { text: "Cancel", style: "cancel" },
                { text: "Forget", style: "destructive", onPress: () => void performForget() },
              ])
            }
          />
        </>
      ) : (
        <Copy>
          {AsyncResult.isFailure(result)
            ? "Could not load this memory."
            : "Memory unavailable or awaiting fresh access."}
        </Copy>
      )}
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
        {history?.revisions.map((pair) => (
          <View key={pair.revision.revisionId}>
            <Copy>
              {pair.revision.createdAtUtc} · {pair.revision.provenance.provider ?? "User"}
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
                {view.resolvingEnvironmentId}
              </Copy>
              <Copy>
                Applied: {view.appliedAtUtc} · Revert deadline: {view.revertDeadlineUtc}
              </Copy>
              <Copy>{entry.payload?.judgment ?? "Judgment unavailable"}</Copy>
              <Action label="Revert resolution" disabled onPress={() => {}} />
              <Copy>
                Revert is unavailable until the server can confirm the current result and retained
                original.
              </Copy>
            </View>
          );
        })}
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
  const allowed = useAtomValue(memory.syncStatus.permissionAtom(target?.environmentId ?? null));
  return (
    <View>
      <Copy>
        {view.label} · Automatic attempts: {view.automaticAttempts ?? "Unknown"}
        {view.failureCode ? ` · ${view.failureCode}` : ""}
      </Copy>
      {target ? (
        <Action
          label="Open report"
          disabled={!config || !allowed}
          onPress={() =>
            onSelectThread({ environmentId: target.environmentId, id: target.threadId })
          }
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
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    registry.set(draftAtom, { text: item?.payload.text ?? "", memoryIds: item ? [id] : [] });
    return () => {
      mounted.current = false;
      registry.set(draftAtom, null);
    };
  }, [registry, draftAtom]);
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
          `Request ${result.value.outcome}${result.value.pendingSync ? " · Propagation pending" : ""}${result.value.failureCode ? ` · ${result.value.failureCode}` : ""}`,
        );
        intent.current = null;
        if (result.value.outcome === "accepted" || result.value.outcome === "noop") onClose();
      } else if (AsyncResult.isFailure(result))
        setError(`${failureMessage(result)} Retry uses the same request.`);
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
            disabled={pending || intent.current !== null || !allowed}
            multiline
          />
          <Action
            label={intent.current ? "Retry save request" : "Save memory"}
            onPress={() => void save()}
            disabled={!allowed || pending || !text.trim()}
          />
        </>
      )}
      {error ? <Copy>{error}</Copy> : null}
    </ScreenScrollView>
  );
}

function MemoryAdministration({
  params,
  memorySpaceId,
  onBinding,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId | null;
  readonly onBinding?: (value: MemoryProjectBinding) => void;
}) {
  const registry = useContext(RegistryContext);
  const { environmentId } = params;
  const navigation = useNavigation();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const adminAllowed = useAtomValue(memory.hubSettingsGet.permissionAtom(environmentId));
  const bindingAllowed = useAtomValue(memory.projectBindingGet.permissionAtom(environmentId));
  const settingsAllowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId),
  );
  const getHub = useAtomCommand(memory.hubSettingsGet);
  const updateHub = useAtomCommand(memory.hubSettingsUpdate);
  const getOwner = useAtomCommand(memory.ownerSourceReadPolicyGet);
  const updateOwner = useAtomCommand(memory.ownerSourceReadPolicyUpdate);
  const getBinding = useAtomCommand(memory.projectBindingGet);
  const updateBinding = useAtomCommand(memory.projectBindingUpdate);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const [hub, setHub] = useState<MemoryHubSettingsView | null>(null);
  const [owner, setOwner] = useState<MemoryOwnerSourceReadPolicyView | null>(null);
  const [binding, setBinding] = useState<MemoryProjectBinding | null>(null);
  const [sharedProjectId, setSharedProjectId] = useState("");
  const [hubId, setHubId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secretName, setSecretName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  function active() {
    return mounted.current && registry.get(memory.hubSettingsGet.permissionAtom(environmentId));
  }
  async function run(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function loadAdministration() {
    if (!active()) return;
    const h = await getHub({ environmentId, input: {} });
    if (!active()) return;
    if (AsyncResult.isFailure(h)) throw squashAtomCommandFailure(h);
    if (AsyncResult.isSuccess(h)) setHub(h.value);
    const o = await getOwner({ environmentId, input: {} });
    if (!active()) return;
    if (AsyncResult.isFailure(o)) throw squashAtomCommandFailure(o);
    if (AsyncResult.isSuccess(o)) setOwner(o.value);
  }
  async function loadBinding() {
    if (
      !params.project ||
      !memorySpaceId ||
      !registry.get(memory.projectBindingGet.permissionAtom(environmentId))
    )
      return;
    const result = await getBinding({
      environmentId,
      input: { memorySpaceId, project: params.project },
    });
    if (!mounted.current || !registry.get(memory.projectBindingGet.permissionAtom(environmentId)))
      return;
    if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
    if (AsyncResult.isSuccess(result)) {
      setBinding(result.value);
      onBinding?.(result.value);
    }
  }
  async function configure(settings: MemoryHubSettings) {
    if (!hub || !active()) return;
    const result = await updateHub({
      environmentId,
      input: {
        requestId: operationId(),
        expectedVersion: hub.version,
        action: "configure",
        settings,
      },
    });
    if (!active()) return;
    if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
    if (AsyncResult.isSuccess(result)) {
      setHub(result.value.view);
      setNotice("Sharing settings saved. Refresh sharing status to check progress.");
    }
  }
  const ownerView = owner ? presentMemoryOwnerPolicy(owner) : null;
  return (
    <View className="gap-4">
      <SettingsSection title="Environment access">
        <Copy>
          Saved task access is a ceiling. Turning access on does not widen existing task
          permissions.
        </Copy>
        <Action
          label={
            config?.settings.enableAgentMemoryAccess === false
              ? "Enable agent memory access"
              : "Disable agent memory access"
          }
          disabled={pending || !settingsAllowed}
          onPress={() =>
            void run(async () => {
              if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId)))
                return;
              const current = registry.get(serverEnvironment.configValueAtom(environmentId));
              if (!current) return;
              const result = await updateSettings({
                environmentId,
                input: {
                  patch: {
                    enableAgentMemoryAccess: current.settings.enableAgentMemoryAccess === false,
                  },
                },
              });
              if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
            })
          }
        />
      </SettingsSection>
      <SettingsSection title="Memory sharing">
        <Action
          label="Load sharing and original access settings"
          disabled={!adminAllowed || pending}
          onPress={() => void run(loadAdministration)}
        />
        {hub && adminAllowed ? (
          <>
            <Copy>
              Mode: {hub.settings.mode} · Version: {hub.version}
            </Copy>
            {hub.settings.mode !== "disabled" ? (
              <Action
                label="Turn off memory sharing"
                disabled={pending}
                onPress={() =>
                  Alert.alert(
                    "Turn off memory sharing?",
                    "Existing memories remain. Future sharing stops on this environment.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Turn off",
                        onPress: () => void run(() => configure({ mode: "disabled" })),
                      },
                    ],
                  )
                }
              />
            ) : null}
            <Action
              label="Use this environment as the hub"
              disabled={pending}
              onPress={() =>
                Alert.alert(
                  "Use this environment as the hub?",
                  "Choose this only for the environment you want to own the memory space.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Configure hub",
                      onPress: () =>
                        void run(() => configure({ mode: "hub", memorySpaceId: null })),
                    },
                  ],
                )
              }
            />
            <Field label="Hub environment ID" value={hubId} onChange={setHubId} />
            <Field label="Hub endpoint" value={endpoint} onChange={setEndpoint} />
            <Field label="Installed credential name" value={secretName} onChange={setSecretName} />
            <Action
              label="Connect to selected hub"
              disabled={pending || !hubId.trim() || !endpoint.trim() || !secretName.trim()}
              onPress={() =>
                void run(async () => {
                  const { MemoryHubEndpoint } = await import("@goat/contracts");
                  await configure({
                    mode: "member",
                    hubEnvironmentId: EnvironmentIdSchema.make(hubId.trim()),
                    endpoint: MemoryHubEndpoint.make(endpoint.trim()),
                    secretName: secretName.trim(),
                    memorySpaceId: null,
                  });
                })
              }
            />
          </>
        ) : null}
        <Copy>
          Detailed publication diagnostics and manual reconciliation are unavailable on this server.
        </Copy>
        <SettingsRow
          icon="desktopcomputer"
          label="Connection and credentials"
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironmentDetail", params: { environmentId } },
            })
          }
        />
      </SettingsSection>
      <SettingsSection title="Original access">
        {ownerView && adminAllowed ? (
          <>
            <Copy>{ownerView.revocationLabel}</Copy>
            <Copy>{ownerView.notice}</Copy>
            {ownerView.pendingEnrollments.map((entry) => (
              <Copy key={entry.requesterEnvironmentId}>
                {entry.requesterEnvironmentId} · {entry.label}
              </Copy>
            ))}
            {[
              ...new Set([
                ...Object.keys(savedConnectionsById),
                ...ownerView.desiredRequesterEnvironmentIds,
              ]),
            ].map((value) => {
              const id = value as EnvironmentId;
              return (
                <Action
                  key={id}
                  label={`${ownerView.desiredRequesterEnvironmentIds.includes(id) ? "Remove" : "Allow"} ${savedConnectionsById[id]?.environmentLabel ?? id}`}
                  disabled={pending}
                  onPress={() =>
                    void run(async () => {
                      if (!owner || !active()) return;
                      const result = await updateOwner({
                        environmentId,
                        input: {
                          requestId: operationId(),
                          expectedVersion: owner.version,
                          allowedRequesterEnvironmentIds: toggleMemoryRequester(owner, id),
                        },
                      });
                      if (!active()) return;
                      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                      if (AsyncResult.isSuccess(result)) setOwner(result.value);
                    })
                  }
                />
              );
            })}
          </>
        ) : (
          <Copy>
            Load settings with administrative access to manage which environments may read
            originals.
          </Copy>
        )}
      </SettingsSection>
      {params.project && memorySpaceId ? (
        <SettingsSection title="Project memory">
          <Action
            label="Load project binding"
            disabled={pending || !bindingAllowed}
            onPress={() => void run(loadBinding)}
          />
          {binding && bindingAllowed ? (
            <>
              <Copy>
                {binding.projectKey
                  ? JSON.stringify(binding.projectKey)
                  : "No shared project binding"}
              </Copy>
              <Field
                label="Shared project ID"
                value={sharedProjectId}
                onChange={setSharedProjectId}
              />
              {(["setExplicit", "useRepository"] as const).map((action) => (
                <Action
                  key={action}
                  label={
                    action === "setExplicit" ? "Use shared project" : "Use repository identity"
                  }
                  disabled={pending || (action === "setExplicit" && !sharedProjectId.trim())}
                  onPress={() =>
                    void run(async () => {
                      if (
                        !params.project ||
                        !registry.get(memory.projectBindingUpdate.permissionAtom(environmentId))
                      )
                        return;
                      const result = await updateBinding({
                        environmentId,
                        input: {
                          memorySpaceId,
                          project: params.project,
                          requestId: operationId(),
                          expectedVersion: binding.version,
                          ...(action === "setExplicit"
                            ? { action, sharedProjectId: sharedProjectId.trim() }
                            : { action }),
                        },
                      });
                      if (
                        !mounted.current ||
                        !registry.get(memory.projectBindingUpdate.permissionAtom(environmentId))
                      )
                        return;
                      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                      if (AsyncResult.isSuccess(result)) {
                        setBinding(result.value.binding);
                        onBinding?.(result.value.binding);
                      }
                    })
                  }
                />
              ))}
            </>
          ) : null}
        </SettingsSection>
      ) : null}
      <SettingsSection title="Provider memory">
        <Copy>Provider memory import and recovery are unavailable on this server.</Copy>
      </SettingsSection>
      {notice ? <Copy>{notice}</Copy> : null}
    </View>
  );
}
