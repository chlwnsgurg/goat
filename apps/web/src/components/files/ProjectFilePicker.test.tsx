// @vitest-environment jsdom

import { EnvironmentId, ThreadId, type FilesystemEntryMetadata } from "@goat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

const state = vi.hoisted(() => ({
  platform: "linux",
  cwd: "/work/repo",
  home: "/srv/remote-user",
  canReadFiles: true,
  pending: false,
  error: null as string | null,
  entries: new Map<string, FilesystemEntryMetadata>(),
  search: vi.fn(),
  metadata: vi.fn(),
  browse: vi.fn(),
}));

const threadRef = {
  environmentId: EnvironmentId.make("remote-environment"),
  threadId: ThreadId.make("picker-thread"),
};
vi.mock("~/hooks/useActiveProjectTarget", () => ({
  useActiveProjectTarget: () => ({
    ...threadRef,
    threadRef,
    cwd: state.cwd,
    projectName: "Project",
  }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: unknown) => atom }));
vi.mock("~/state/server", () => ({
  primaryServerKeybindingsAtom: [],
  serverEnvironment: {
    configValueAtom: () => ({ environment: { platform: { os: state.platform } } }),
  },
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({
    canReadFiles: state.canReadFiles,
    isPending: false,
    error: null,
  }),
  filesystemEnvironment: {
    browse: (target: unknown) => {
      state.browse(target);
      return { data: { parentPath: state.home }, isPending: false, error: null };
    },
  },
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    fileMetadata: (target: { input: { path: string } }) => {
      state.metadata(target);
      return {
        data: state.entries.get(target.input.path) ?? null,
        isPending: state.pending,
        error: state.error,
      };
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => atom ?? { data: null, isPending: false, error: null },
}));
vi.mock("./projectFilesQueryState", () => ({
  useProjectFilePickerQuery: (environmentId: string, cwd: string, query: string) => {
    state.search({ environmentId, cwd, query });
    return {
      entries: query ? [{ path: "src", kind: "directory" }] : [{ path: "README.md", kind: "file" }],
      matchedQuery: query,
      isPending: false,
      error: null,
    };
  },
}));

import { ProjectFilePicker } from "./ProjectFilePicker";

let root: Root;
let container: HTMLDivElement;
const setOpen = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Element.prototype.scrollIntoView = vi.fn();
  state.platform = "linux";
  state.cwd = "/work/repo";
  state.home = "/srv/remote-user";
  state.canReadFiles = true;
  state.pending = false;
  state.error = null;
  state.entries.clear();
  vi.clearAllMocks();
  useRightPanelStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render() {
  await act(() => root.render(<ProjectFilePicker setOpen={setOpen} />));
  await act(() => vi.advanceTimersByTimeAsync(0));
}

async function type(query: string) {
  const input = container.querySelector("input")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => vi.advanceTimersByTimeAsync(0));
  return input;
}

async function enter() {
  await act(() =>
    container
      .querySelector("input")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
  );
}

function selectedSurface() {
  return selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef);
}

describe("file picker keyboard flow", () => {
  it("keeps Enter auto-selection for recents and directory search results", async () => {
    await render();
    await enter();
    expect(selectedSurface()).toMatchObject({ kind: "file", relativePath: "README.md" });
    await type("src");
    await enter();
    expect(selectedSurface()).toMatchObject({ kind: "file", relativePath: "src" });
  });

  it("opens an absolute path at its line without fuzzy searching it", async () => {
    state.entries.set("/work/repo/src/app.ts", { kind: "file" });
    await render();
    state.search.mockClear();
    await type("/work/repo/src/app.ts:42:3");
    await enter();
    expect(state.search).not.toHaveBeenCalled();
    expect(state.metadata).toHaveBeenCalledWith({
      environmentId: "remote-environment",
      input: { path: "/work/repo/src/app.ts" },
    });
    expect(selectedSurface()).toMatchObject({
      kind: "file",
      relativePath: "src/app.ts",
      revealLine: 42,
    });
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it("uses the destination Windows platform and remote home for a home-relative folder", async () => {
    state.platform = "windows";
    state.cwd = "C:\\repo";
    state.home = "D:\\Remote";
    state.entries.set("D:\\Remote\\notes", { kind: "directory" });
    await render();
    state.search.mockClear();
    await type("~\\notes\\");
    await enter();
    expect(state.search).not.toHaveBeenCalled();
    expect(state.browse).toHaveBeenCalledWith({
      environmentId: "remote-environment",
      input: { partialPath: "~/" },
    });
    expect(selectedSurface()).toMatchObject({
      kind: "file",
      relativePath: "D:\\Remote\\notes",
      revealLine: null,
    });
  });

  it("shows missing, denied, and pending paths inline without closing or opening a surface", async () => {
    await render();
    await type("/missing/file.ts");
    await enter();
    expect(container.textContent).toContain("Path not found or permission denied.");
    state.error = "Permission denied by remote host.";
    await type("/private/file.ts");
    await enter();
    expect(container.textContent).toContain("Permission denied by remote host.");
    state.error = null;
    state.pending = true;
    await type("/pending/file.ts");
    await enter();
    expect(container.textContent).toContain("Checking path…");
    expect(selectedSurface()).toBeNull();
    expect(setOpen).not.toHaveBeenCalled();
  });

  it("does not query a denied destination or open a file with a directory separator", async () => {
    state.canReadFiles = false;
    await render();
    await type("~/private/file.ts");
    expect(state.browse).not.toHaveBeenCalled();
    expect(state.metadata).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This connection cannot read host files.");
    state.canReadFiles = true;
    state.entries.set("/work/repo/file.ts", { kind: "file" });
    await type("/work/repo/file.ts/");
    await enter();
    expect(container.textContent).toContain("The path is a file, not a folder.");
    expect(selectedSurface()).toBeNull();
    expect(setOpen).not.toHaveBeenCalled();
  });
});
