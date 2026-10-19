import { useAtomValue } from "@effect/atom-react";
import {
  canRemoveHubNode,
  HUB_NODE_IMPORT_NOTICE,
  hubNodeLastSeenLabel,
  hubNodeRemovalInput,
  hubNodeRouteLabel,
  hubNodeStatusLabel,
  isHubNodesUnsupportedError,
} from "@goat/client-runtime/hub-nodes";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsHubNodesRouteScreen() {
  const { availableTargets } = useSettingsEnvironmentFilter();
  const hub =
    availableTargets.find((target) => target.entry.target._tag === "PrimaryConnectionTarget") ??
    availableTargets[0];
  return (
    <SettingsScreen title="Devices on this hub">
      {hub ? (
        <HubNodesList key={hub.environmentId} environmentId={hub.environmentId} />
      ) : (
        <Text className="p-5 text-foreground-muted">Connect to a hub to see its devices.</Text>
      )}
    </SettingsScreen>
  );
}

function HubNodesList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const listed = useEnvironmentQuery(serverEnvironment.hubNodesLive({ environmentId, input: {} }));
  const canCheck = useAtomValue(serverEnvironment.checkHubNodes.permissionAtom(environmentId));
  const canRemove = useAtomValue(serverEnvironment.removeHubNode.permissionAtom(environmentId));
  const canDismiss = useAtomValue(
    serverEnvironment.dismissHubNodeNotice.permissionAtom(environmentId),
  );
  const check = useAtomCommand(serverEnvironment.checkHubNodes, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.removeHubNode, { reportFailure: false });
  const dismiss = useAtomCommand(serverEnvironment.dismissHubNodeNotice, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const run = async (key: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (busy !== null) return;
    setBusy(key);
    setError(null);
    const result = await action();
    setBusy(null);
    setNow(Date.now());
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The hub request failed.");
    }
  };
  if (isHubNodesUnsupportedError(listed.cause)) return null;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1"
      contentContainerClassName="gap-4 p-5 pb-10"
    >
      <Text className="text-sm text-foreground-muted">
        Add devices from the hub's Settings on desktop or web.
      </Text>
      <Button
        label={busy === "check-all" ? "Checking…" : "Check all"}
        disabled={!canCheck || busy !== null || listed.data === null}
        onPress={() => void run("check-all", () => check({ environmentId, input: {} }))}
      />
      {error || listed.error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error ?? listed.error}
        </Text>
      ) : null}
      {listed.data === null && !listed.error ? (
        <Text className="text-foreground-muted">Loading devices…</Text>
      ) : null}
      {listed.data?.notices.map((notice) => (
        <View key={notice.id} className="gap-3 rounded-xl bg-grouped-card p-4">
          <Text className="text-sm text-foreground">{HUB_NODE_IMPORT_NOTICE}</Text>
          <Button
            label="Dismiss"
            disabled={!canDismiss || busy !== null}
            onPress={() =>
              void run("dismiss", () => dismiss({ environmentId, input: { id: notice.id } }))
            }
          />
        </View>
      ))}
      {listed.data?.nodes.length === 0 ? (
        <Text className="text-foreground-muted">No devices added yet.</Text>
      ) : null}
      {listed.data?.nodes.map((node) => (
        <View key={node.nodeId} className="gap-2 rounded-xl bg-grouped-card p-4">
          <Text className="font-goat-medium text-foreground">{node.label}</Text>
          <Text className="text-sm text-foreground-muted">
            {node.routes.map(hubNodeRouteLabel).join(" · ")}
          </Text>
          <View className="flex-row items-center gap-2">
            <View
              accessible={false}
              className={
                node.status === "online"
                  ? "size-2 rounded-full bg-primary"
                  : node.status === "offline"
                    ? "size-2 rounded-full bg-danger"
                    : "size-2 rounded-full bg-subtle-strong"
              }
            />
            <Text className="text-sm text-foreground-muted">
              {hubNodeStatusLabel(node.status)}
              {node.lastSeenAt ? ` · ${hubNodeLastSeenLabel(node.lastSeenAt, now)}` : ""}
            </Text>
          </View>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={busy === node.nodeId ? "Checking…" : "Check"}
              disabled={!canCheck || busy !== null}
              onPress={() =>
                void run(node.nodeId, () =>
                  check({ environmentId, input: { nodeId: node.nodeId } }),
                )
              }
            />
            {canRemove && canRemoveHubNode(node) ? (
              <Button
                label="Remove"
                tone="danger"
                disabled={busy !== null}
                onPress={() =>
                  void run(`remove:${node.nodeId}`, () =>
                    remove({ environmentId, input: hubNodeRemovalInput(node) }),
                  )
                }
              />
            ) : null}
          </View>
          {!canRemoveHubNode(node) ? (
            <Text className="text-sm text-foreground-muted">
              Manage cloud machines from the hub's Settings on desktop or web.
            </Text>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
