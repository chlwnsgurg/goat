// @vitest-environment jsdom
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerSettingsPatch,
} from "@goat/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const homeId = EnvironmentId.make("home-env");

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    permitted: true,
    config: null as ServerConfig | null,
    updateSettings: vi.fn(),
    rows: [] as Array<{ label: string; value?: string; disabled?: boolean; onPress?: () => void }>,
    choices: [] as Array<{
      label: string;
      description?: string;
      selected: boolean;
      disabled?: boolean;
      onPress: () => void;
    }>,
  },
}));

vi.mock("react-native", () => ({ Text: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsRow", () => ({
  SettingsRow: (props: {
    label: string;
    value?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => {
    mocks.rows.push(props);
    return null;
  },
}));
vi.mock("./components/SettingsChoiceRow", () => ({
  SettingsChoiceRow: (props: {
    label: string;
    description?: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => {
    mocks.choices.push(props);
    return null;
  },
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => mocks.config,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: {} },
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => mocks.permitted,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.updateSettings,
}));
vi.mock("../goat-bot/useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({
    supported: true,
    resolution: {
      state: "claimed",
      claim: { environmentId: homeId, claimedAt: 1, claimId: "claim-1" },
      homeKnown: true,
      homeConnected: true,
      homeSupportsBot: true,
      staleTargetIds: [],
    },
    targets: [
      {
        environmentId: homeId,
        supportsHome: true,
        supportsBot: true,
        connected: true,
        settingsLoaded: true,
        home: { environmentId: homeId, claimedAt: 1, claimId: "claim-1" },
      },
    ],
    environments: [{ environmentId: homeId, label: "Mac Studio" }],
    writableIds: new Set([homeId]),
    busy: false,
    error: null,
    changeHome: vi.fn(),
  }),
}));

import { SettingsGoatBotRouteScreen } from "./SettingsGoatBotRouteScreen";

let root: Root;

function makeConfig(patch: Partial<ServerConfig["settings"]> = {}): ServerConfig {
  return {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      ...patch,
    },
    providers: [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00.000Z",
        models: [
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
          { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
  } as unknown as ServerConfig;
}

function render() {
  mocks.rows = [];
  mocks.choices = [];
  act(() => root.render(<SettingsGoatBotRouteScreen />));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  mocks.permitted = true;
  mocks.config = makeConfig();
  mocks.updateSettings.mockReset().mockResolvedValue({ _tag: "Success" });
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SettingsGoatBotRouteScreen", () => {
  it("picks an explicit model from the home catalog and resets to Automatic", async () => {
    render();
    const modelRow = mocks.rows.find((row) => row.label === "GOAT Bot model");
    expect(modelRow?.value).toBe("Automatic · gpt-5.4");

    mocks.rows = [];
    mocks.choices = [];
    act(() => modelRow?.onPress?.());
    expect(
      mocks.choices.map((choice) => ({ label: choice.label, selected: choice.selected })),
    ).toEqual([
      { label: "Automatic", selected: true },
      { label: "GPT-5.4", selected: false },
      { label: "GPT-5.4 Mini", selected: false },
    ]);

    const mini = mocks.choices.find((choice) => choice.label === "GPT-5.4 Mini")!;
    await act(async () => mini.onPress());
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      environmentId: homeId,
      input: {
        patch: {
          goatBotModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4-mini",
          },
        } satisfies ServerSettingsPatch,
      },
    });

    mocks.config = makeConfig({
      goatBotModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4-mini",
      },
    });
    render();
    const updatedRow = mocks.rows.find((row) => row.label === "GOAT Bot model");
    expect(updatedRow?.value).toBe("Codex · GPT-5.4 Mini");

    mocks.choices = [];
    act(() => updatedRow?.onPress?.());
    const automatic = mocks.choices.find((choice) => choice.label === "Automatic")!;
    expect(automatic.selected).toBe(false);
    await act(async () => automatic.onPress());
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: homeId,
      input: { patch: { goatBotModelSelection: null } },
    });
  });
});
