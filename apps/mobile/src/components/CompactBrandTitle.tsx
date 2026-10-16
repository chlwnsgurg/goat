import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "../native/NativeWorkspaceColumns";
import Constants from "expo-constants";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform, View } from "react-native";

import { AppText as Text } from "./AppText";
import { GoatWordmark } from "./GoatWordmark";
import { BrandChannelPill } from "./BrandChannelPill";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveMobileBrandChannel } from "../lib/mobileBranding";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

/**
 * Horizontal correction applied to content rendered in the brand title slot,
 * shared with the connection-status swap so both align identically.
 */
export function brandTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad && !NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? IPAD_HOME_TITLE_OFFSET : 0;
}

/**
 * Compact brand lockup sized for native navigation bars.
 */
export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
    readonly accessibilityLabel?: string;
  } = {},
) {
  const channel = resolveMobileBrandChannel(Constants.expoConfig?.extra?.appVariant);
  const titleOffset = brandTitleOffset();
  const { scale } = useAndroidControlSizing();

  return (
    <View
      aria-level={1}
      accessibilityLabel={props.accessibilityLabel ?? "GOAT, Threads"}
      accessible
      role="heading"
      className="flex-row items-center gap-1.5"
      style={[{ marginLeft: titleOffset }, Platform.OS === "android" && { gap: 5.25 * scale }]}
    >
      <GoatWordmark colorClassName="accent-icon" height={Math.round(15 * scale)} />
      <Text
        allowFontScaling={props.allowFontScaling}
        className="font-goat-bold text-foreground-muted"
        style={{ fontSize: 21 * scale, letterSpacing: -0.5 * scale }}
      >
        GOAT
      </Text>
      <BrandChannelPill channel={channel} allowFontScaling={props.allowFontScaling} />
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
    unstable_headerLeftItems: undefined,
  };
}
