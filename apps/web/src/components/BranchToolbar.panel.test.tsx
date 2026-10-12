// @vitest-environment jsdom

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  worktreePath: "/tmp/worktree" as string | null,
  serverThread: true,
  faultInjection: false,
  showContextMenu: vi.fn().mockResolvedValue("copy-path"),
  writeTextToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: state.showContextMenu } }),
}));
vi.mock("../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock("./BranchToolbarBranchSelector", () => ({ BranchToolbarBranchSelector: () => null }));
vi.mock("../state/entities", () => ({
  useThreadShell: () =>
    state.serverThread
      ? {
          environmentId: "local",
          projectId: "project",
          worktreePath: state.worktreePath,
        }
      : null,
  useProject: () => ({ workspaceRoot: "/tmp/project" }),
  useThreadShellsForProjectRefs: () => [],
}));

vi.mock("./ui/select", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ui/select")>();
  return {
    ...original,
    Select: (props: ComponentProps<typeof original.Select>) => (
      <>
        {createElement(original.Select, props)}
        {state.faultInjection ? (
          <>
            <button onClick={() => props.onValueChange?.(null, {} as never)}>Null selection</button>
            <button onClick={() => props.onValueChange?.("not-a-mode", {} as never)}>
              Invalid selection
            </button>
          </>
        ) : null}
      </>
    ),
  };
});

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { BranchToolbar } from "./BranchToolbar";

it("keeps machine choices usable when the combined row's workspace is locked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onEnvironmentChange = vi.fn();
  try {
    await act(async () => {
      root.render(
        <BranchToolbar
          layout="panel"
          panelSection="workspace"
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          showGitControls
          envMode="local"
          envLocked={false}
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
          onEnvModeChange={vi.fn()}
          onEnvironmentChange={onEnvironmentChange}
          availableEnvironments={["local", "remote"].map((id) => ({
            environmentId: EnvironmentId.make(id),
            projectId: ProjectId.make("project"),
            label: id,
            isPrimary: id === "local",
            machine: "server",
          }))}
        />,
      );
    });
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toBe("Worktree");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => trigger.click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(
      items.find((item) => item.textContent === "New worktree")?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => items.find((item) => item.textContent === "remote")!.click());
    expect(onEnvironmentChange).toHaveBeenCalledWith("remote");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  ["local", null, "/tmp/project"],
  ["worktree", null, null],
  ["worktree", "/tmp/worktree", "/tmp/worktree"],
] as const)(
  "copies only an existing workspace path with mode %s and worktree %s",
  async (envMode, worktreePath, copiedPath) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.worktreePath = worktreePath;
    state.showContextMenu.mockClear();
    state.writeTextToClipboard.mockClear();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <BranchToolbar
            layout="panel"
            panelSection="workspace"
            environmentId={EnvironmentId.make("local")}
            threadId={ThreadId.make("thread")}
            showGitControls
            envMode={envMode}
            envLocked={false}
            startFromOrigin={false}
            onStartFromOriginChange={vi.fn()}
            onEnvModeChange={vi.fn()}
          />,
        );
      });
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      await act(async () => {
        container.querySelector('[aria-label="Run context"]')!.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(copiedPath !== null);
      if (copiedPath === null) {
        expect(state.showContextMenu).not.toHaveBeenCalled();
        expect(state.writeTextToClipboard).not.toHaveBeenCalled();
      } else {
        expect(state.writeTextToClipboard).toHaveBeenCalledWith(copiedPath, "workspace path");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.worktreePath = "/tmp/worktree";
      vi.unstubAllGlobals();
    }
  },
);

beforeEach(() => {
  Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
  state.serverThread = true;
  state.worktreePath = "/tmp/worktree";
  state.faultInjection = false;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});

it.each(["composer", "panel", "wide"] as const)(
  "shows workspace modes and retires the old option in %s",
  async (layout) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.serverThread = false;
    const draftId = DraftId.make("panel-draft");
    const projectRef = scopeProjectRef(EnvironmentId.make("remote"), ProjectId.make("project"));
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId("project", projectRef, draftId, {
        threadId: ThreadId.make("thread"),
        envMode: "local",
      });
    // An existing tree remains in the store; it must not create a third choice.
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId("recent", projectRef, DraftId.make("recent"), {
        threadId: ThreadId.make("recent-thread"),
        envMode: "worktree",
        worktreePath: "/recent/wt",
      });
    const environments = ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id === "remote" ? "Build host" : "This device",
      isPrimary: id === "local",
      machine: "server" as const,
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onEnvModeChange = (envMode: "local" | "worktree") =>
      useComposerDraftStore.getState().setDraftThreadContext(draftId, { envMode });
    const render = async () =>
      act(async () => {
        const envMode = useComposerDraftStore.getState().getDraftSession(draftId)!.envMode;
        root.render(
          <div className="group/composer-context" data-compact="">
            {layout === "wide" ? (
              <BranchToolbarEnvModeSelector
                envLocked={false}
                effectiveEnvMode={envMode}
                activeWorktreePath={null}
                activeEnvironment={environments[1]!}
                onEnvModeChange={onEnvModeChange}
              />
            ) : (
              <BranchToolbar
                layout={layout}
                panelSection="workspace"
                draftId={draftId}
                environmentId={projectRef.environmentId}
                threadId={ThreadId.make("thread")}
                showGitControls
                envMode={envMode}
                envLocked={false}
                startFromOrigin={false}
                onStartFromOriginChange={vi.fn()}
                onEnvModeChange={onEnvModeChange}
                availableEnvironments={environments}
                onEnvironmentChange={vi.fn()}
                autoEnvironmentLabel="Auto balance"
                onAutoEnvironment={vi.fn()}
              />
            )}
          </div>,
        );
      });
    try {
      await render();
      const trigger = () =>
        layout === "wide"
          ? container.querySelector<HTMLButtonElement>('[aria-label="Workspace"]')!
          : container.querySelector<HTMLButtonElement>(
              layout === "panel"
                ? '[aria-label="Run context"]'
                : '[data-composer-shortcut*="composer.workspace"]',
            )!;
      expect(trigger().textContent).toContain("Local · Build host");
      const label = trigger().querySelector("[data-composer-label]")!;
      expect(label.textContent).toBe("Local · Build host");
      expect(label.className).not.toContain("max-w-0");
      expect(label.querySelector("[data-composer-label-motion]")!.className).not.toContain(
        "opacity-0",
      );
      for (const [choice, mode] of [
        ["New worktree", "worktree"],
        ["Local", "local"],
      ] as const) {
        await act(async () => trigger().click());
        const items = [
          ...document.querySelectorAll<HTMLElement>(
            layout === "wide" ? '[role="option"]' : '[role="menuitemradio"]',
          ),
        ];
        expect(items.some((item) => item.textContent?.includes("Previous worktree"))).toBe(false);
        const item = items.find((item) => item.textContent === choice)!;
        expect(item).toBeDefined();
        await act(async () => item.click());
        expect(useComposerDraftStore.getState().getDraftSession(draftId)?.envMode).toBe(mode);
        await render();
        expect(trigger().textContent).toContain(`${choice} · Build host`);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  [false, "local", null, "Local · Build host"],
  [false, "worktree", "/existing", "Worktree · Build host"],
  [false, "worktree", null, "New worktree · Build host"],
  [true, "local", "/stale", "New worktree · Build host"],
] as const)(
  "labels locked wide mode with force=%s mode=%s path=%s",
  async (forceNewWorktree, effectiveEnvMode, activeWorktreePath, label) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <BranchToolbarEnvModeSelector
            forceNewWorktree={forceNewWorktree}
            envLocked
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            activeEnvironment={{ isPrimary: false, label: "Build host" }}
            onEnvModeChange={vi.fn()}
          />,
        ),
      );
      expect(container.textContent).toBe(label);
      expect(container.querySelector("button")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it("ignores null and non-mode Select callback values", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.faultInjection = true;
  const draftId = DraftId.make("fault-draft");
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "fault",
      scopeProjectRef(EnvironmentId.make("local"), ProjectId.make("project")),
      draftId,
      { envMode: "local" },
    );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BranchToolbarEnvModeSelector
          envLocked={false}
          effectiveEnvMode="local"
          activeWorktreePath={null}
          onEnvModeChange={(envMode) =>
            useComposerDraftStore.getState().setDraftThreadContext(draftId, { envMode })
          }
        />,
      ),
    );
    const before = useComposerDraftStore.getState().getDraftSession(draftId);
    for (const button of container.querySelectorAll<HTMLButtonElement>("button")) {
      if (!button.textContent?.includes("selection")) continue;
      await act(async () => button.click());
      expect(useComposerDraftStore.getState().getDraftSession(draftId)).toEqual(before);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.faultInjection = false;
    vi.unstubAllGlobals();
  }
});
