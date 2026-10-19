// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

const appearance = vi.hoisted(() => ({ mode: "dark" as "light" | "dark" }));

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: appearance.mode }),
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    style,
    className,
  }: {
    children?: ReactNode;
    style?: unknown;
    className?: string;
  }) => (
    <div data-style={JSON.stringify(style)} data-class={className}>
      {children}
    </div>
  ),
  Text: ({
    children,
    style,
    className,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: unknown;
    className?: string;
    accessibilityLabel?: string;
  }) => (
    <span data-style={JSON.stringify(style)} data-class={className} aria-label={accessibilityLabel}>
      {children}
    </span>
  ),
  Pressable: ({
    children,
    style,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
  }) => (
    <button data-style={JSON.stringify(style)} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
  TextInput: () => <input />,
  Platform: { OS: "ios" },
}));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useKeyboardState: () => false,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0 }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollViewMarker: () => null }));
vi.mock("../settings/SettingsMemoryRouteScreen", () => ({ MemoryReportLink: () => null }));
vi.mock("../home/home-thread-navigation", () => ({ useHomeThreadSelection: () => () => {} }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("./useReplying", () => ({ useReplying: () => false }));
vi.mock("./useMobileGoatBotSession", () => ({
  useMobileGoatBotSession: () => ({
    availability: "ready",
    rows: [],
    canSend: true,
    onSend: () => true,
    onRetryInput: () => {},
    replyingSince: null,
  }),
}));

import { GoatBotScreen, GoatBotTimelineRow } from "./GoatBotScreen";

const props = { canSend: true, onSend: () => true, onRetry: () => {}, onSelectThread: () => {} };
const bot: Extract<GoatBotRow, { kind: "bot" }> = {
  kind: "bot",
  id: "bot",
  text: "Could not continue",
  createdAt: "2026-10-12T09:40:00Z",
  tone: "failure",
  proactive: false,
  replyTo: null,
  options: ["Try again"],
  firstInGroup: true,
  groupPosition: "single",
};

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("marks a failed answer as danger and prefixes its accessibility label", async () => {
  const view = await render(<GoatBotTimelineRow {...props} row={bot} />);
  const { container } = view;
  const failure = container.querySelector('[aria-label="Failed: Could not continue"]');
  expect(failure?.getAttribute("data-class")).toContain("text-danger-foreground");
  expect(failure?.getAttribute("data-style")).toBeNull();
  await view.unmount();
});

it("uses the selected app appearance for answer chips and the send button", async () => {
  appearance.mode = "dark";
  const rowView = await render(<GoatBotTimelineRow {...props} row={{ ...bot, tone: "reply" }} />);
  const chip = rowView.container.querySelector("button");
  expect(JSON.parse(chip?.getAttribute("data-style") ?? "null").borderColor).toBe("#2C66CA");
  expect(JSON.parse(chip?.querySelector("span")?.getAttribute("data-style") ?? "null").color).toBe(
    "#2C66CA",
  );
  await rowView.unmount();

  const screenView = await render(<GoatBotScreen visible />);
  const send = screenView.container.querySelector('[aria-label="Send message"]');
  expect(JSON.parse(send?.getAttribute("data-style") ?? "null").backgroundColor).toBe("#2C66CA");
  await screenView.unmount();
});
