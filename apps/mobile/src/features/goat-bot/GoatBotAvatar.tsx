import { View } from "react-native";

import { GoatWordmark } from "../../components/GoatWordmark";

const SIZES = { sm: 20, md: 28, lg: 48 } as const;

/** Decorative identity; the adjacent label names GOAT Bot. */
export function GoatBotAvatar(props: { readonly size?: keyof typeof SIZES }) {
  const size = SIZES[props.size ?? "md"];
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar"
      style={{ width: size, height: size }}
    >
      <GoatWordmark colorClassName="accent-goat-avatar-foreground" height={size * 0.36} />
    </View>
  );
}
