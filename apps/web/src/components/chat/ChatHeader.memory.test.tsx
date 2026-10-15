// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ supported: true, allowed: true, destination: "" }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: {
      environment: { capabilities: state.supported ? { memory: { protocolVersion: 1 } } : {} },
    },
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => async (input: { to: string; search: Record<string, unknown> }) => {
    const query = new URLSearchParams(
      Object.entries(input.search)
        .filter((entry) => entry[1] !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    state.destination = `${input.to}?${query}`;
  },
}));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => undefined }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../goatBot/GoatBotModeButton", () => ({ GoatBotModeButton: () => null }));
import { ChatHeader } from "./ChatHeader";
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  state.allowed = true;
  state.supported = true;
  state.destination = "";
  vi.unstubAllGlobals();
});
it("opens Memory for the active remote thread, and removes the action when its environment lacks support", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const render = () =>
    root.render(
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("remote-owner")}
        activeThreadId={ThreadId.make("remote-thread")}
        activeThreadTitle="Synthetic thread"
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />,
    );
  await act(async () => render());
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Memory",
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  const target = new URL(state.destination, "https://synthetic.invalid");
  expect(target.pathname).toBe("/settings/memory");
  expect(target.searchParams.get("environmentId")).toBe("remote-owner");
  expect(target.searchParams.has("project")).toBe(false);
  state.supported = false;
  await act(async () => render());
  expect(
    [...container.querySelectorAll("button")].some((item) => item.textContent === "Memory"),
  ).toBe(false);
});
