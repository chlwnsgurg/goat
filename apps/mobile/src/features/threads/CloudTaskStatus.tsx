import type { OrchestrationV2CloudTask } from "@goat/contracts";
import { presentCloudTask } from "@goat/client-runtime/state/cloud-task";
import { Alert, Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export function CloudTaskStatus({ task }: { readonly task: OrchestrationV2CloudTask }) {
  const view = presentCloudTask(task);
  const openLink = (url: string) => {
    void Linking.openURL(url).catch(() =>
      Alert.alert("Could not open link", "Try opening the task from your browser."),
    );
  };
  return (
    <View accessibilityLabel="Cloud task" className="mx-4 my-2 rounded-lg border p-3">
      <Text accessibilityLiveRegion="polite">{view.label}</Text>
      {task.title ? <Text>{task.title}</Text> : null}
      <Text>Project files and terminal show the local source, not cloud changes.</Text>
      <Text>
        {task.source.repository} · {task.source.branch}
      </Text>
      {view.localChangesNotice ? <Text>{view.localChangesNotice}</Text> : null}
      {task.progress ? <Text>{task.progress}</Text> : null}
      {task.summary ? <Text>{task.summary}</Text> : null}
      {task.error ? <Text accessibilityRole="alert">{task.error}</Text> : null}
      {task.branch ? <Text>Branch: {task.branch}</Text> : null}
      {view.taskUrl ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open cloud task"
          onPress={() => {
            openLink(view.taskUrl!);
          }}
        >
          <Text>Open cloud task</Text>
        </Pressable>
      ) : null}
      {view.prUrl ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open pull request"
          onPress={() => {
            openLink(view.prUrl!);
          }}
        >
          <Text>Open pull request</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
