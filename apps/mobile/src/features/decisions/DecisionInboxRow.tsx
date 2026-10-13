import { useAtomValue } from "@effect/atom-react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { decisionInbox } from "../../state/threads";

export function DecisionInboxRow(props: { readonly onPress: () => void }) {
  const summary = useAtomValue(decisionInbox.summaryAtom);
  if (summary.count === 0) return null;
  const label = `${summary.count} decision${summary.count === 1 ? "" : "s"} waiting`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={props.onPress}
      className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
    >
      <View className="min-w-0 flex-1">
        <Text className="font-goat-bold text-sm text-foreground">{label}</Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
    </Pressable>
  );
}
