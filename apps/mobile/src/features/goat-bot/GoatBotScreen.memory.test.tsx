// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  nativeSpace,
  nativeId,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
vi.mock("@legendapp/list/keyboard", () => ({ KeyboardAwareLegendList: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
import { GoatBotTimelineRow } from "./GoatBotScreen";
let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});
it("opens a report's exact memory target and leaves legacy text without an action", async () => {
  h = createNativeMemoryHarness();
  await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
  const row = {
    id: "row",
    kind: "assistant",
    text: "Synthetic resolution report",
    options: [],
    tone: "normal",
    firstInGroup: true,
    memory: { environmentId: nativeEnv, memorySpaceId: nativeSpace, memoryId: nativeId },
  } as unknown as GoatBotRow;
  const props = {
    canSend: false,
    onSend: () => false,
    onRetry: () => {},
    onSelectThread: () => {},
  };
  view = renderNative(h, <GoatBotTimelineRow {...props} row={row} />);
  await view.render();
  await view.click("View memory details");
  expect(h.navigations).toMatchObject([
    [
      "SettingsSheet",
      {
        params: {
          params: { environmentId: nativeEnv, memorySpaceId: nativeSpace, memoryId: nativeId },
        },
      },
    ],
  ]);
  await view.rerender(
    <GoatBotTimelineRow {...props} row={{ ...row, memory: undefined } as GoatBotRow} />,
  );
  expect(view.container.textContent).toContain("Synthetic resolution report");
  expect(view.container.querySelector("button")).toBeNull();
});
