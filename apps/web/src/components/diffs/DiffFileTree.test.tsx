import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import { FileTree } from "@pierre/trees/react";
import { act, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FileDiffMetadata } from "@pierre/diffs";

import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { diffFileTreeEntries } from "./diffFileTree.logic";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";
import { Input } from "../ui/input";

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
// Tooltip positioning is unrelated to the tree's actual model and activation path.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

const entries: DiffFileTreeEntry[] = [
  { path: "01-tall.ts", status: "modified" },
  { path: "02-short.ts", status: "modified" },
  { path: "03-medium.ts", status: "modified" },
];

class TreeRow {
  constructor(readonly path: string) {}

  getAttribute(name: string) {
    return name === "data-item-path" ? this.path : null;
  }
}

describe("diff tree file activation", () => {
  let renderer: ReactTestRenderer | undefined;
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

  const model = (): FileTreeModel => renderer!.root.findByType(FileTree).props.model;
  const visibleFiles = () =>
    model()
      .getVisibleRows(0, model().getVisibleCount())
      .filter((row) => row.kind === "file")
      .map((row) => row.path);

  async function filter(value: string) {
    await act(async () => {
      renderer!.root.findByType(Input).props.onChange({ target: { value } });
    });
  }

  async function clearWithEscape() {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      renderer!.root.findByType(Input).props.onKeyDown({
        key: "Escape",
        preventDefault,
        stopPropagation,
      } as unknown as KeyboardEvent<HTMLInputElement>);
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  }

  async function mount(props: Parameters<typeof Panel>[0] = {}) {
    await act(async () => {
      renderer = create(<Panel {...props} />);
    });
  }

  // Exercise T3's capture handler before the real Pierre model's selection transition.
  // Only DOM hit testing is represented here; native pointer/keyboard dispatch and diff
  // geometry are verified separately in the integrated client.
  async function activate(path: string, modifiers: Partial<MouseEvent<HTMLElement>> = {}) {
    const event = {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      nativeEvent: { composedPath: () => [{}, new TreeRow(path), {}] },
      ...modifiers,
    } as MouseEvent<HTMLElement>;
    await act(async () => {
      renderer!.root
        .find((node) => String(node.type) === "file-tree-container")
        .props.onClickCapture?.(event);
      const tree = model();
      const item = tree.getItem(path)!;
      if (event.ctrlKey || event.metaKey) {
        item.toggleSelect();
      } else {
        for (const selected of tree.getSelectedPaths()) {
          if (selected !== path) tree.getItem(selected)?.deselect();
        }
        item.select();
      }
      item.focus();
      if ("toggle" in item && !event.ctrlKey && !event.metaKey && !event.shiftKey) item.toggle();
    });
  }

  beforeEach(() => {
    targets.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("HTMLElement", TreeRow);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mounts a file-to-symlink type change as one tree row", async () => {
    // Git carries a type change as a deletion and an addition of the same path.
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
      renderer!.update(<Panel files={[files[1]!, files[0]!]} />);
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
      renderer!.update(<Panel selectedPath="03-medium.ts" />);
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
    expect(renderer!.root.findByProps({ role: "status" }).children).toEqual([
      "No files in this diff.",
    ]);
    await act(async () => renderer!.update(<Panel />));
    await filter("missing");
    expect(renderer!.root.findByProps({ role: "status" }).children).toEqual(["No matching files."]);
    await clearWithEscape();
    expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
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
    await act(async () => renderer!.update(<Panel files={[...files, appended]} />));
    expect(visibleFiles()).toEqual([files[0]!.path, appended.path]);
    await act(async () => renderer!.update(<Panel files={[appended, files[1]!, files[0]!]} />));
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
      renderer!.update(
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
    expect(renderer!.root.findAllByType(FileTree)).toHaveLength(0);
    await act(async () => renderer!.update(<Panel files={files} />));
    const tree = model();
    await activate("src/");
    await filter("route");
    await act(async () => renderer!.update(<Panel files={files} open={false} />));
    expect(renderer!.root.findByType("aside").props.hidden).toBe(true);
    expect(renderer!.root.findByType("aside").props.inert).toBe(true);
    await act(async () => renderer!.update(<Panel files={files} />));
    expect(renderer!.root.findByType("aside").props.hidden).toBe(false);
    expect(model()).toBe(tree);
    expect(renderer!.root.findByType(Input).props.value).toBe("route");
    expect(visibleFiles()).toEqual(["src/route.ts"]);
    await clearWithEscape();
    expect(visibleFiles()).toEqual(["README.md"]);
    await act(async () => renderer!.update(<Panel files={files} open={false} />));
    await act(async () => renderer!.update(<Panel files={files} />));
    expect(visibleFiles()).toEqual(["README.md"]);
  });
});
