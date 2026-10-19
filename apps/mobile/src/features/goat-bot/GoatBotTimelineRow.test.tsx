// @vitest-environment jsdom
import type { ReactNode } from "react";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";

vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: () => null,
  useKeyboardState: () => false,
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollViewMarker: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
vi.mock("./GoatBotAvatar", () => ({ GoatBotAvatar: () => null }));
vi.mock("./GoatBotBubble", () => ({
  GoatBotBubble: (props: { children: ReactNode | ((color: string) => ReactNode) }) =>
    typeof props.children === "function" ? props.children("#000000") : props.children,
}));
import { GoatBotTimelineRow } from "./GoatBotScreen";

let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});

const props = { canSend: true, onSend: () => true, onRetry: vi.fn(), onSelectThread: () => {} };
const user = (
  delivery: Extract<GoatBotRow, { kind: "user" }>["delivery"],
  showReceipt: boolean,
): GoatBotRow => ({
  kind: "user",
  id: "user",
  text: "Hello",
  createdAt: "2026-10-12T09:40:00Z",
  firstInGroup: true,
  groupPosition: "single",
  delivery,
  showReceipt,
});

it("shows time in a same-day pause stamp", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={{ kind: "day", id: "day", at: new Date().toISOString() }}
    />,
  );
  await view.render();
  expect(view.container.textContent).toContain("Today");
  expect(view.container.textContent).toMatch(/\d/);
});

it("keeps the receipt on only the marked user row", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={user({ state: "read", readAt: "2026-10-12T09:41:00Z" }, false)}
    />,
  );
  await view.render();
  expect(view.container.textContent).not.toContain("Read");
  await view.rerender(
    <GoatBotTimelineRow
      {...props}
      row={user({ state: "read", readAt: "2026-10-12T09:41:00Z" }, true)}
    />,
  );
  expect(view.container.textContent).toContain("Read");
});

it("offers retry only for a recoverable failure", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={user({ state: "failed", clientKey: "r", rejectionReason: "Rejected" }, true)}
    />,
  );
  await view.render();
  expect(view.container.textContent).toContain("Rejected");
  expect(view.container.textContent).not.toContain("Retry");
  await view.rerender(
    <GoatBotTimelineRow {...props} row={user({ state: "failed", clientKey: "k" }, true)} />,
  );
  expect(view.container.textContent).toContain("Not Delivered");
  expect(view.container.textContent).toContain("Retry");
});
