import type { GoatBotGroupPosition } from "@goat/client-runtime/goatBot";

export type BubbleSide = "out" | "in";

export const GOAT_BOT_BUBBLE_COLORS = {
  light: { out: "#1B86F9", outText: "#FFFFFF", in: "#E9E9EB", inText: "#000000" },
  dark: { out: "#2C66CA", outText: "#FFFFFF", in: "#3A3A3C", inText: "#FFFFFF" },
} as const;

export function goatBotBubbleLayout(
  position: GoatBotGroupPosition,
  isFirstRow: boolean,
): { readonly marginTop: number; readonly tail: boolean } {
  return {
    marginTop: isFirstRow ? 0 : position === "single" || position === "first" ? 10 : 2,
    tail: position === "single" || position === "last",
  };
}
