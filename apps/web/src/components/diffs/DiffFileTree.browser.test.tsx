import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FileDiffMetadata } from "@pierre/diffs";

import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { diffFileTreeEntries } from "./diffFileTree.logic";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

const captured = vi.hoisted(() => ({ model: null as unknown }));
// Read the tree model the component builds, so tests can assert its selection and expansion.
vi.mock(import("@pierre/trees/react"), async (original) => {
  const actual = await original();
  const RealFileTree = actual.FileTree;
  return {
    ...actual,
    FileTree: ((props: ComponentProps<typeof RealFileTree>) => {
      captured.model = props.model;
      return <RealFileTree {...props} />;
    }) as typeof RealFileTree,
  };
});

const entries: DiffFileTreeEntry[] = [
  { path: "01-tall.ts", status: "modified" },
  { path: "02-short.ts", status: "modified" },
  { path: "03-medium.ts", status: "modified" },
];

describe("diff tree file activation", () => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  const targets: CodeViewScrollTarget[] = [];
  const viewer = {
    getInstance: () => viewer,
    scrollTo: (target: CodeViewScrollTarget) => targets.push(target),
  };

  function Panel({
    files = entries,
    selectedPath = null,
    open = true,
  }: {
    files?: DiffFileTreeEntry[];
    selectedPath?: string | null;
    open?: boolean;
  }) {
    const reveal = useCodeViewFileReveal(viewer, "working-tree");
    return (
      <DiffFileTree
        entries={files}
        open={open}
        ariaLabel="Working tree files"
        selectedPath={selectedPath}
        onSelectFile={(path) => reveal(`${path}\0${path}`)}
      />
    );
  }

  const model = (): FileTreeModel => captured.model as FileTreeModel;
  const visibleFiles = () =>
    model()
      .getVisibleRows(0, model().getVisibleCount())
      .filter((row) => row.kind === "file")
      .map((row) => row.path);
  const input = () => container.querySelector<HTMLInputElement>('input[type="search"]')!;
  async function filter(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(),
        value,
      );
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function clearWithEscape() {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      input().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  }

  async function mount(props: Parameters<typeof Panel>[0] = {}) {
    root ??= createRoot(container);
    await act(async () => root!.render(<Panel {...props} />));
  }

  function row(path: string): HTMLElement {
    const host = container.querySelector("file-tree-container");
    const element = (host?.shadowRoot ?? container).querySelector<HTMLElement>(
      `[data-item-path="${CSS.escape(path)}"]`,
    );
    expect(element, `row ${path}`).not.toBeNull();
    return element!;
  }

  async function activate(path: string, modifiers: MouseEventInit = {}) {
    await act(async () => {
      row(path).dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          composed: true,
          button: 0,
          detail: 1,
          ...modifiers,
        }),
      );
    });
  }

  beforeEach(() => {
    targets.length = 0;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    container.style.cssText = "display: flex; flex-direction: column; width: 320px; height: 480px";
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
  });

  it("mounts a file-to-symlink type change as one tree row", async () => {
    const typeChange = diffFileTreeEntries([
      { type: "deleted", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
      { type: "new", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
      { type: "change", name: "CLAUDE.md", prevName: "CLAUDE.md" } as FileDiffMetadata,
    ]);
    await mount({ files: [...typeChange] });

    const tree = model();
    expect(tree.getItem("AGENTS.md")?.isDirectory()).toBe(false);
    expect(tree.getItem("CLAUDE.md")?.isDirectory()).toBe(false);
    await activate("AGENTS.md");
    expect(targets).toEqual([{ type: "item", id: "AGENTS.md\u0000AGENTS.md", align: "start" }]);
  });

  it("reissues the reveal when the sole selected file is activated again", async () => {
    await mount();
    await activate("02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    await activate("02-short.ts");
    expect(targets).toEqual([
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
    ]);
  });

  it("reveals newly selected files once in either direction", async () => {
    await mount();
    await activate("02-short.ts");
    await activate("01-tall.ts");
    await activate("03-medium.ts");
    expect(targets.map((target) => ("id" in target ? target.id : null))).toEqual(
      ["02-short.ts", "01-tall.ts", "03-medium.ts"].map((path) => `${path}\0${path}`),
    );
  });

  it("keeps focus-only navigation separate from button activation", async () => {
    await mount();
    await activate("02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.focus());
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
    await activate("01-tall.ts", { detail: 0 });
    await activate("01-tall.ts", { detail: 0 });
    expect(targets).toHaveLength(3);
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "does not reveal a selected file that a %s click deselects",
    async (modifier) => {
      await mount();
      await activate("02-short.ts");
      await activate("02-short.ts", { [modifier]: true });
      expect(model().getSelectedPaths()).toEqual([]);
      expect(targets).toHaveLength(1);
    },
  );

  it("lets a click narrow multiple selected files without a second reveal", async () => {
    await mount();
    await activate("02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.select());
    expect(model().getSelectedPaths()).toHaveLength(2);
    targets.length = 0;
    await activate("02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
  });

  it("leaves directory selection and expansion to the tree", async () => {
    await mount({ files: [{ path: "src/app.ts", status: "modified" }] });
    const directory = model().getItem("src/")!;
    if (!("isExpanded" in directory)) throw new Error("Expected the directory handle");
    expect(directory.isExpanded()).toBe(true);
    await activate("src/");
    expect(directory.isExpanded()).toBe(false);
    await activate("src/");
    expect(directory.isExpanded()).toBe(true);
    expect(targets).toEqual([]);
  });

  it("reorders refreshed files without reopening a collapsed folder", async () => {
    const files: DiffFileTreeEntry[] = [
      { path: "src/state/shell.ts", status: "modified" },
      { path: "src/features/route.ts", status: "added" },
    ];
    await mount({ files });
    const initialFolder = model().getItem("src/features/")!;
    if (!("collapse" in initialFolder)) throw new Error("Expected the directory handle");
    await act(async () => initialFolder.collapse());
    await act(async () => {
      root!.render(<Panel files={[files[1]!, files[0]!]} />);
    });
    const folder = model().getItem("src/features/")!;
    if (!("isExpanded" in folder)) throw new Error("Expected the directory handle");
    expect(folder.isExpanded()).toBe(false);
  });

  it("does not echo controlled selection, but lets the reader activate it", async () => {
    await mount({ selectedPath: "02-short.ts" });
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toEqual([]);
    await activate("02-short.ts");
    expect(targets).toHaveLength(1);
    await act(async () => {
      root!.render(<Panel selectedPath="03-medium.ts" />);
    });
    expect(model().getSelectedPaths()).toEqual(["03-medium.ts"]);
    expect(targets).toHaveLength(1);
  });

  it("filters full paths without case sensitivity, reveals collapsed matches, and restores folders", async () => {
    const files: DiffFileTreeEntry[] = [
      { path: "src/features/Route.ts", status: "added" },
      { path: "src/state/shell.ts", status: "modified" },
      { path: "README.md", status: "deleted" },
    ];
    await mount({ files, selectedPath: files[0]!.path });
    const folder = model().getItem("src/")!;
    if (!("collapse" in folder)) throw new Error("Expected the directory handle");
    await act(async () => folder.collapse());
    expect(visibleFiles()).toEqual(["README.md"]);
    targets.length = 0;

    await filter("  SRC/FEATURES/route  ");
    expect(visibleFiles()).toEqual(["src/features/Route.ts"]);
    expect(targets).toEqual([]);
    await clearWithEscape();
    expect(visibleFiles()).toEqual(["README.md"]);
    expect(model().getSelectedPaths()).toContain("src/features/Route.ts");
    expect(targets).toEqual([]);

    // Clearing ends the search session, so later searches remember newer folder choices.
    await activate("src/");
    await filter("README");
    await filter("");
    expect(visibleFiles()).toEqual(files.map((file) => file.path));
  });

  it("keeps an excluded selected file and never reveals a diff just from filtering", async () => {
    await mount({ selectedPath: "02-short.ts" });
    await filter("01-tall");
    expect(visibleFiles()).toEqual(["01-tall.ts"]);
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toEqual([]);
    await activate("01-tall.ts");
    await activate("01-tall.ts");
    expect(targets).toHaveLength(2);
    await clearWithEscape();
    expect(visibleFiles()).toEqual(entries.map((file) => file.path));
  });

  it("distinguishes no files from no matching files and recovers on clear", async () => {
    await mount({ files: [] });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("No files in this diff.");
    await act(async () => root!.render(<Panel />));
    await filter("missing");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("No matching files.");
    await clearWithEscape();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(visibleFiles()).toEqual(entries.map((file) => file.path));
    expect(targets).toEqual([]);
  });

  it("filters appended and reordered files while preserving the unfiltered expansion", async () => {
    const files: DiffFileTreeEntry[] = [
      { path: "src/features/route.ts", status: "added" },
      { path: "src/state/shell.ts", status: "modified" },
    ];
    const appended: DiffFileTreeEntry = { path: "test/route.test.ts", status: "added" };
    await mount({ files });
    await activate("src/");
    await filter("route");
    await act(async () => root!.render(<Panel files={[...files, appended]} />));
    expect(visibleFiles()).toEqual([files[0]!.path, appended.path]);
    await act(async () => root!.render(<Panel files={[appended, files[1]!, files[0]!]} />));
    expect(visibleFiles()).toEqual([appended.path, files[0]!.path]);
    await clearWithEscape();
    expect(visibleFiles()).toEqual([appended.path]);
    await activate("src/");
    expect(visibleFiles()).toEqual([appended.path, files[1]!.path, files[0]!.path]);
    expect(targets).toEqual([]);
  });

  it("filters a path that changes from a file to a directory after refresh", async () => {
    await mount({ files: [{ path: "foo", status: "deleted" }] });
    await filter("FOO");
    expect(visibleFiles()).toEqual(["foo"]);
    await act(async () =>
      root!.render(
        <Panel
          files={[
            { path: "foo/bar.ts", status: "added" },
            { path: "other.ts", status: "modified" },
          ]}
        />,
      ),
    );
    expect(visibleFiles()).toEqual(["foo/bar.ts"]);
    await filter("foo/bar");
    expect(visibleFiles()).toEqual(["foo/bar.ts"]);
    await activate("foo/bar.ts");
    expect(targets).toHaveLength(1);
    await filter("  ");
    expect(visibleFiles()).toEqual(["foo/bar.ts", "other.ts"]);
  });

  it("mounts lazily and keeps query and expansion across hiding and reopening", async () => {
    const files: DiffFileTreeEntry[] = [
      { path: "src/route.ts", status: "modified" },
      { path: "README.md", status: "modified" },
    ];
    await mount({ files, open: false });
    expect(container.querySelector("file-tree-container")).toBeNull();
    await act(async () => root!.render(<Panel files={files} />));
    const tree = model();
    await activate("src/");
    await filter("route");
    await act(async () => root!.render(<Panel files={files} open={false} />));
    expect(container.querySelector("aside")!.hidden).toBe(true);
    expect(container.querySelector("aside")!.inert).toBe(true);
    await act(async () => root!.render(<Panel files={files} />));
    expect(container.querySelector("aside")!.hidden).toBe(false);
    expect(model()).toBe(tree);
    expect(input().value).toBe("route");
    expect(visibleFiles()).toEqual(["src/route.ts"]);
    await clearWithEscape();
    expect(visibleFiles()).toEqual(["README.md"]);
    await act(async () => root!.render(<Panel files={files} open={false} />));
    await act(async () => root!.render(<Panel files={files} />));
    expect(visibleFiles()).toEqual(["README.md"]);
  });
});
