// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: {},
    toggleAuxiliaryPane: () => {},
    togglePrimarySidebar: () => {},
  }),
}));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceListNavigation: () => () => {},
}));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("./ThreadGitControls", () => ({
  ThreadGitControls: () => null,
  useThreadGitCenterHeaderItems: () => [],
  useThreadGitRightHeaderItems: () => [],
}));
vi.mock("../../components/ScreenHeaderButton", () => ({ ScreenHeaderButton: () => null }));
vi.mock("../../components/ScreenHeader", () => ({
  ScreenHeader: (props: {
    options: {
      unstable_headerRightItems?: () => Array<{ identifier: string; onPress: () => void }>;
    };
    actions: Array<{ accessibilityLabel: string; onPress: () => void }>;
  }) => (
    <div>
      {props.options.unstable_headerRightItems?.().map((item) => (
        <button key={item.identifier} onClick={item.onPress}>
          iOS {item.identifier}
        </button>
      ))}
      {props.actions.map((action) => (
        <button key={action.accessibilityLabel} onClick={action.onPress}>
          Android {action.accessibilityLabel}
        </button>
      ))}
    </div>
  ),
}));
import { ThreadHeader } from "./ThreadHeader";
let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});
it("opens memory from both platform header actions without substituting the environment", async () => {
  h = createNativeMemoryHarness();
  const props = {
    title: "Synthetic thread",
    subtitle: "",
    headerColor: "#000",
    usesNativeHeaderGlass: true,
    gitControls: {
      environmentId: nativeEnv,
      threadId: "synthetic-thread",
      projectScripts: [],
      terminalSessions: [],
    },
    hasThreadCwd: false,
    hasWorkspaceRoot: false,
    fileInspectorSupported: false,
    inspectorMode: null,
    onToggleInspector: () => {},
    onOpenGitInspector: () => {},
    onOpenFilesInspector: () => {},
  } as unknown as Parameters<typeof ThreadHeader>[0];
  view = renderNative(h, <ThreadHeader {...props} />);
  await view.render();
  await view.click("iOS thread-memory");
  await view.click("Android Open memory");
  expect(h.navigations).toHaveLength(2);
  for (const call of h.navigations)
    expect(call).toMatchObject([
      "SettingsSheet",
      {
        screen: "SettingsContent",
        params: {
          screen: "SettingsMemory",
          params: {
            environmentId: nativeEnv,
            thread: { environmentId: nativeEnv, threadId: "synthetic-thread" },
          },
        },
      },
    ]);
  h.registry.set(h.configs(nativeEnv), null);
  await view.rerender(<ThreadHeader {...props} />);
  expect(view.container.textContent).not.toContain("memory");
});
