import { MemoryReportLink } from "../settings/SettingsMemoryRouteScreen";
import { LegendList } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  formatGoatBotStamp,
  goatBotReceiptLabel,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { memo, useCallback, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useReplying } from "./useReplying";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useHomeThreadSelection } from "../home/home-thread-navigation";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useMobileGoatBotSession } from "./useMobileGoatBotSession";
import { GoatBotBubble } from "./GoatBotBubble";
import { GOAT_BOT_BUBBLE_COLORS, goatBotBubbleLayout } from "./goatBotBubbleStyle";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;
const rowKey = (row: GoatBotRow) => row.id;
const receiptTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const availabilityCopy = {
  ready: "Answers here, works in its own threads",
  connecting: "Connecting to GOAT Bot…",
  home_offline: "GOAT Bot’s computer is offline.",
  offline: "GOAT Bot's computer is offline. Messages will be available when it reconnects.",
  unsupported: "Update the server to use GOAT Bot here.",
  permission: "This connection does not have permission to message GOAT Bot.",
  legacy_active: "Your global agent is still working. Check again when it finishes.",
  error: "Couldn't reach GOAT Bot",
};

type GoatBotTaskRow = Extract<GoatBotRow, { kind: "task" }>;

/** A piece of work GOAT Bot started; remote work names its machine and waits for it to connect. */
function GoatBotTaskCard(props: {
  readonly card: GoatBotTaskRow["card"];
  readonly onSelectThread: (thread: ThreadSelection) => void;
  readonly tail: boolean;
}) {
  const { card } = props;
  const target = card.target;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const unreachableHost =
    target.kind === "thread" &&
    target.host !== undefined &&
    !connectedEnvironments.some(
      (environment) =>
        environment.environmentId === target.environmentId &&
        environment.connectionState === "connected",
    )
      ? target.host
      : null;
  const action =
    target.kind !== "thread"
      ? target.label
      : unreachableHost !== null
        ? `Connect ${unreachableHost} to open`
        : "Open thread";
  return (
    <GoatBotBubble side="in" tail={props.tail} maxWidth="90%">
      {(textColor) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${card.title}. ${card.statusLabel}.${card.attentionLabel ? ` ${card.attentionLabel}.` : ""}${card.continuationLabel ? ` ${card.continuationLabel}.` : ""} ${action}`}
          disabled={target.kind !== "thread" || unreachableHost !== null}
          onPress={() => {
            if (target.kind === "thread" && unreachableHost === null)
              props.onSelectThread({ environmentId: target.environmentId, id: target.threadId });
          }}
          className="gap-1"
        >
          <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
            {card.statusLabel}
            {card.attentionLabel ? ` · ${card.attentionLabel}` : ""}
          </Text>
          <Text className="font-semibold" style={{ color: textColor }}>
            {card.title}
          </Text>
          {card.sourceLabel ? (
            <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
              {card.sourceLabel}
            </Text>
          ) : null}
          {card.continuationLabel ? (
            <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
              {card.continuationLabel}
            </Text>
          ) : null}
          {card.summary ? (
            <Text numberOfLines={3} className="text-sm" style={{ color: textColor }}>
              {card.summary}
            </Text>
          ) : null}
          {card.pullRequests.length > 0 ? (
            <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
              {"Pull requests: " +
                card.pullRequests.map((pullRequest) => pullRequest.label).join(", ")}
            </Text>
          ) : null}
          <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
            {action === "Open thread" ? "Open thread ↗" : action}
          </Text>
        </Pressable>
      )}
    </GoatBotBubble>
  );
}

export const GoatBotTimelineRow = memo(function GoatBotTimelineRow(props: {
  readonly row: GoatBotRow;
  readonly canSend: boolean;
  readonly onSend: (answer: string) => boolean;
  readonly onRetry: (key: string) => void;
  readonly onSelectThread: (thread: ThreadSelection) => void;
}) {
  const { row } = props;
  const { themeAppearance } = useAppearancePreferences();
  const outgoingColor = GOAT_BOT_BUBBLE_COLORS[themeAppearance].out;
  const [nowMs] = useState(() => Date.now());
  if (row.kind === "day") {
    return (
      <Text className="py-4 text-center text-xs font-semibold text-foreground-muted">
        {formatGoatBotStamp(row.at, nowMs, receiptTime)}
      </Text>
    );
  }
  const layout = goatBotBubbleLayout(row.groupPosition);
  if (row.kind === "task") {
    return (
      <View style={{ marginTop: layout.marginTop, alignItems: "flex-start" }}>
        <GoatBotTaskCard card={row.card} onSelectThread={props.onSelectThread} tail={layout.tail} />
      </View>
    );
  }
  if (row.kind === "user") {
    const delivery = row.delivery;
    const receipt = goatBotReceiptLabel(delivery, receiptTime);
    return (
      <View className="items-end gap-1" style={{ marginTop: layout.marginTop }}>
        <GoatBotBubble side="out" tail={layout.tail}>
          {(textColor) => (
            <Text selectable className="text-base" style={{ color: textColor }}>
              {row.text}
            </Text>
          )}
        </GoatBotBubble>
        {row.showReceipt || delivery.state === "failed" ? (
          <View className="flex-row items-center gap-2">
            <Text
              className="text-xs text-foreground-muted"
              accessibilityLabel={receipt?.accessibleText}
            >
              {delivery.state === "failed"
                ? (delivery.rejectionReason ?? "Not Delivered")
                : receipt?.text}
            </Text>
            {delivery.state === "failed" && delivery.rejectionReason === undefined ? (
              <Pressable
                accessibilityRole="button"
                disabled={!props.canSend}
                onPress={() => props.onRetry(delivery.clientKey)}
                className="p-2"
              >
                <Text className="text-sm text-foreground">Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View className="items-start gap-1" style={{ marginTop: layout.marginTop }}>
      {row.proactive && row.firstInGroup ? (
        <Text className="text-xs text-foreground-muted">GOAT Bot · Update</Text>
      ) : null}
      <GoatBotBubble side="in" tail={layout.tail}>
        {(textColor) => (
          <View className="gap-1">
            {row.replyTo ? (
              <Text
                numberOfLines={2}
                className="border-l-2 border-border pl-2 text-xs"
                style={{ color: textColor, opacity: 0.7 }}
              >
                {row.replyTo}
              </Text>
            ) : null}
            <Text
              selectable
              className={row.tone === "failure" ? "text-base text-danger-foreground" : "text-base"}
              style={row.tone === "failure" ? undefined : { color: textColor }}
              accessibilityLabel={row.tone === "failure" ? `Failed: ${row.text}` : undefined}
            >
              {row.text}
            </Text>
          </View>
        )}
      </GoatBotBubble>
      {row.memory ? <MemoryReportLink reference={row.memory} /> : null}
      {row.options.length > 0 ? (
        <View
          accessibilityLabel="Suggested answers"
          className="max-w-[90%] flex-row flex-wrap gap-2"
        >
          {row.options.map((answer) => (
            <Pressable
              key={answer}
              accessibilityRole="button"
              disabled={!props.canSend}
              onPress={() => props.onSend(answer)}
              className="rounded-full border px-3 py-2"
              style={{ borderColor: outgoingColor }}
            >
              <Text className="text-sm" style={{ color: outgoingColor }}>
                {answer}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
});

export function GoatBotScreen(props: {
  readonly visible: boolean;
  readonly onSelectThread?: (thread: ThreadSelection) => void;
}) {
  const session = useMobileGoatBotSession(props.visible);
  const { themeAppearance } = useAppearancePreferences();
  const outgoingColor = GOAT_BOT_BUBBLE_COLORS[themeAppearance].out;
  const selectThread = useHomeThreadSelection();
  const onSelectThread = props.onSelectThread ?? selectThread;
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(8, insets.bottom);
  const topInset = Platform.OS === "ios" ? insets.top : 0;
  const hasBanner = session.availability !== "ready";
  const [text, setText] = useState("");
  const [inputHeight, setInputHeight] = useState(40);
  const replying = useReplying(session.replyingSince, props.visible);
  const renderItem = useCallback(
    ({ item }: { item: GoatBotRow }) => (
      <GoatBotTimelineRow
        row={item}
        canSend={session.canSend}
        onSend={session.onSend}
        onRetry={session.onRetryInput}
        onSelectThread={onSelectThread}
      />
    ),
    [session.canSend, session.onSend, session.onRetryInput, onSelectThread],
  );
  const send = () => {
    if (session.onSend(text)) {
      setText("");
      setInputHeight(40);
    }
  };
  return (
    <KeyboardAvoidingView className="flex-1 bg-screen" automaticOffset behavior="height">
      {hasBanner ? (
        <View
          accessibilityRole="alert"
          className="gap-2 border-b border-border px-4 py-3"
          style={{ paddingTop: topInset + 12 }}
        >
          <Text className="text-sm text-foreground-muted">
            {session.availability === "home_offline"
              ? `GOAT Bot runs on ${session.homeLabel}. It will continue when that computer connects.`
              : session.availability === "error"
                ? (session.error ?? availabilityCopy.error)
                : availabilityCopy[session.availability]}
          </Text>
          {session.availability === "error" || session.availability === "legacy_active" ? (
            <Pressable
              accessibilityRole="button"
              onPress={session.onRetryAvailability}
              className="self-start rounded-lg border border-border px-3 py-2"
            >
              <Text className="text-sm text-foreground">Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <NativeScrollViewMarker style={{ flex: 1 }}>
        <LegendList
          style={{ flex: 1 }}
          data={session.rows}
          keyExtractor={rowKey}
          renderItem={renderItem}
          maintainScrollAtEnd
          alignItemsAtEnd
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="never"
          contentInset={{ top: hasBanner ? 0 : topInset }}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={
            <Text className="py-6 text-center text-foreground-muted">
              Ask GOAT Bot for anything. It answers here and starts work in its own threads.
            </Text>
          }
          ListFooterComponent={
            replying ? (
              <View
                accessibilityRole="text"
                accessibilityLabel="GOAT Bot is replying"
                className="self-start"
              >
                <GoatBotBubble side="in" tail>
                  {(textColor) => (
                    <View className="flex-row items-center gap-1 py-1">
                      {[0, 1, 2].map((dot) => (
                        <View
                          key={dot}
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: textColor,
                          }}
                        />
                      ))}
                    </View>
                  )}
                </GoatBotBubble>
              </View>
            ) : null
          }
        />
      </NativeScrollViewMarker>
      <View
        className="flex-row items-end gap-2 border-t border-border px-4 pt-2"
        style={{ paddingBottom: bottomInset }}
      >
        <TextInput
          accessibilityLabel="Message GOAT Bot"
          placeholder="Message GOAT Bot"
          placeholderTextColorClassName="accent-placeholder"
          value={text}
          onChangeText={setText}
          multiline
          editable={session.canSend}
          onContentSizeChange={(event) =>
            setInputHeight(Math.min(160, Math.max(40, event.nativeEvent.contentSize.height)))
          }
          className="flex-1 rounded-full border border-border px-3 py-2 text-base text-foreground"
          style={{ height: inputHeight }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          disabled={!session.canSend || !text.trim()}
          onPress={send}
          className="items-center justify-center rounded-full"
          style={{
            width: 32,
            height: 32,
            backgroundColor: outgoingColor,
            opacity: session.canSend && text.trim() ? 1 : 0.45,
          }}
        >
          <Text className="text-xl font-semibold text-white">↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
