import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import { EnvironmentId, ProjectWriteFileError } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, readScope, getUnsavedFile, getFile, reloadFile, getSaveSession } =
  vi.hoisted(() => ({
    writeFile: vi.fn(),
    confirmFile: vi.fn(),
    readScope: vi.fn(),
    getUnsavedFile: vi.fn(),
    getFile: vi.fn(),
    reloadFile: vi.fn(),
    getSaveSession: vi.fn(),
  }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: readScope,
  useEnvironmentScope: readScope,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("./projectFilesQueryState", () => ({
  confirmProjectFileQueryData: confirmFile,
  getUnsavedProjectFileQueryData: getUnsavedFile,
  getProjectFileData: getFile,
  reloadProjectFileData: reloadFile,
  getProjectFileSaveSession: getSaveSession,
}));

import { FileSaveSession } from "./fileSaveCoordinator";
import { setMarkdownTaskChecked } from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

const environmentId = EnvironmentId.make("save-lifecycle-audit");
const onPendingChange = vi.fn();
const defaultProps = {
  environmentId,
  cwd: "/workspace",
  relativePath: "file.txt",
  onPendingChange,
};
let renderer: ReactTestRenderer | null;

function ChangeSource(_props: {
  onChange: (contents: string) => void;
  coordinator: ReturnType<typeof useFileSaveCoordinator>;
}) {
  return null;
}

function FileSurface(props: Parameters<typeof useFileSaveCoordinator>[0]) {
  const coordinator = useFileSaveCoordinator(props);
  return (
    <ChangeSource coordinator={coordinator} onChange={(contents) => coordinator.change(contents)} />
  );
}

function mount(props = defaultProps) {
  act(() => {
    renderer = create(
      <StrictMode>
        <FileSurface {...props} />
      </StrictMode>,
    );
  });
}

function changeHandler(): (contents: string) => void {
  return renderer!.root.findByType(ChangeSource).props.onChange;
}

beforeEach(() => {
  renderer = null;
  const sessions = new Map<string, FileSaveSession>();
  getSaveSession.mockReset().mockImplementation((...identity) => {
    const key = JSON.stringify(identity);
    if (!sessions.has(key)) sessions.set(key, new FileSaveSession());
    return sessions.get(key)!;
  });
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  confirmFile.mockReset();
  readScope.mockReset().mockReturnValue(true);
  getUnsavedFile.mockReset().mockReturnValue(null);
  getFile.mockReset().mockReturnValue(null);
  reloadFile.mockReset().mockImplementation(async (...identity) => {
    getSaveSession(...identity).discard();
    return AsyncResult.success({});
  });
  onPendingChange.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("file-save React lifecycle", () => {
  it.each(["changed_on_disk", "deleted_on_disk"] as const)(
    "keeps the draft and pauses %s until explicit overwrite",
    async (failure) => {
      getFile.mockReturnValue({
        version: "loaded-version",
        textFormat: { encoding: "utf-8", bom: true, lineEnding: "crlf" },
      });
      writeFile.mockResolvedValueOnce(
        AsyncResult.failure(
          Cause.fail(
            new ProjectWriteFileError({ cwd: "/workspace", relativePath: "file.txt", failure }),
          ),
        ),
      );
      mount();
      changeHandler()("draft");
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(writeFile.mock.calls[0]![0].input).toMatchObject({
        expectedVersion: "loaded-version",
        textFormat: { bom: true, lineEnding: "crlf" },
      });
      expect(confirmFile).not.toHaveBeenCalled();
      changeHandler()("newer draft");
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(writeFile).toHaveBeenCalledTimes(1);
      await act(async () => renderer!.root.findByType(ChangeSource).props.coordinator.overwrite());
      expect(writeFile.mock.calls[1]![0].input).toEqual({
        cwd: "/workspace",
        relativePath: "file.txt",
        contents: "newer draft",
        textFormat: { encoding: "utf-8", bom: true, lineEnding: "crlf" },
      });
    },
  );

  it("reloads a conflict without persisting the dirty draft on close", async () => {
    writeFile.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new ProjectWriteFileError({
            cwd: "/workspace",
            relativePath: "file.txt",
            failure: "changed_on_disk",
          }),
        ),
      ),
    );
    mount();
    changeHandler()("draft");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => renderer!.root.findByType(ChangeSource).props.coordinator.reload());
    expect(reloadFile).toHaveBeenCalledExactlyOnceWith(environmentId, "/workspace", "file.txt");
    await act(async () => renderer!.unmount());
    renderer = null;
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("discards a delayed reload's draft across source/Markdown view switches", async () => {
    getFile.mockReturnValue({ version: "loaded" });
    getUnsavedFile.mockReturnValue({ contents: "stale draft" });
    writeFile.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new ProjectWriteFileError({
            cwd: "/workspace",
            relativePath: "file.txt",
            failure: "changed_on_disk",
          }),
        ),
      ),
    );
    mount();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(writeFile).toHaveBeenCalledTimes(1);
    let finishReload!: () => void;
    reloadFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReload = () => {
            getUnsavedFile.mockReturnValue(null);
            getFile.mockReturnValue({ version: "reloaded" });
            getSaveSession(environmentId, "/workspace", "file.txt").discard();
            resolve(AsyncResult.success({}));
          };
        }),
    );
    let reloading!: Promise<void>;
    act(() => {
      reloading = renderer!.root.findByType(ChangeSource).props.coordinator.reload();
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface key="markdown" {...defaultProps} />
        </StrictMode>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      finishReload();
      await reloading;
    });
    await act(async () => vi.runAllTimersAsync());
    expect(writeFile).toHaveBeenCalledTimes(1);
    changeHandler()("explicit post-reload edit");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(writeFile.mock.calls[1]![0].input).toMatchObject({
      contents: "explicit post-reload edit",
      expectedVersion: "reloaded",
    });
  });

  it("retains a conflict across view switches until explicit overwrite", async () => {
    getFile.mockReturnValue({ version: "loaded" });
    getUnsavedFile.mockReturnValue({ contents: "draft" });
    writeFile.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new ProjectWriteFileError({
            cwd: "/workspace",
            relativePath: "file.txt",
            failure: "changed_on_disk",
          }),
        ),
      ),
    );
    mount();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface key="markdown" {...defaultProps} />
        </StrictMode>,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByType(ChangeSource).props.coordinator.status).toBe("changed");
    await act(async () => renderer!.root.findByType(ChangeSource).props.coordinator.overwrite());
    expect(writeFile.mock.calls[1]![0].input).not.toHaveProperty("expectedVersion");
  });

  it("resolves the next view's expected version after the pending save confirms", async () => {
    getFile.mockReturnValue({ version: "loaded" });
    const saved = AsyncResult.success({ relativePath: "file.txt", version: "first-written" });
    let finishWrite!: (value: typeof saved) => void;
    writeFile.mockReturnValueOnce(
      new Promise<typeof saved>((resolve) => {
        finishWrite = resolve;
      }),
    );
    writeFile.mockImplementation(async ({ input }) =>
      input.expectedVersion === "first-written"
        ? AsyncResult.success({ relativePath: "file.txt", version: "second-written" })
        : AsyncResult.failure(
            Cause.fail(
              new ProjectWriteFileError({
                cwd: "/workspace",
                relativePath: "file.txt",
                failure: "changed_on_disk",
              }),
            ),
          ),
    );
    confirmFile.mockImplementation((_env, _cwd, _path, contents, written) => {
      getFile.mockReturnValue({ version: written.version });
      return contents === "second edit";
    });
    mount();
    changeHandler()("first edit");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface key="markdown" {...defaultProps} />
        </StrictMode>,
      ),
    );
    changeHandler()("second edit");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => {
      finishWrite(saved);
    });
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[1]![0].input).toMatchObject({
      contents: "second edit",
      expectedVersion: "first-written",
    });
    expect(renderer!.root.findByType(ChangeSource).props.coordinator.status).toBe("saved");
  });

  it("persists editor model changes after StrictMode setup replay", async () => {
    mount();
    changeHandler()("AUDIT7907NATIVE\n");
    expect(onPendingChange).toHaveBeenCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "AUDIT7907NATIVE\n" },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "file.txt",
      "AUDIT7907NATIVE\n",
      undefined,
    );
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("saves an existing legacy project file to the path that was read", async () => {
    mount({ ...defaultProps, relativePath: LEGACY_PROJECT_FILE_NAME });
    changeHandler()('{ "iconPath": "updated.svg" }');
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: LEGACY_PROJECT_FILE_NAME,
        contents: '{ "iconPath": "updated.svg" }',
      },
    });
  });

  it("persists rendered Markdown task changes after StrictMode setup replay", async () => {
    mount({ ...defaultProps, relativePath: "README.md" });
    const nextContents = setMarkdownTaskChecked("- [ ] task\n", 2, true);
    changeHandler()(nextContents);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "README.md", contents: "- [x] task\n" },
    });
  });

  it("keeps the debounce across rerenders of the same file", async () => {
    mount();
    changeHandler()("first");
    await vi.advanceTimersByTimeAsync(300);
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...defaultProps} />
        </StrictMode>,
      ),
    );
    changeHandler()("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("latest");
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("pending edit");
    await act(async () => renderer!.unmount());
    renderer = null;
    retiredChange("stale editor contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("pending edit");
  });

  it.each([false, true])(
    "keeps edits pending after permission is revoked before a React update (unmount: %s)",
    async (unmount) => {
      mount();
      changeHandler()("pending edit");
      readScope.mockReturnValue(false);
      if (unmount) {
        await act(async () => renderer!.unmount());
        renderer = null;
      }
      await vi.runAllTimersAsync();
      expect(writeFile).not.toHaveBeenCalled();
      expect(confirmFile).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    },
  );

  it("resumes an unsaved draft when write permission returns after effect replay", async () => {
    readScope.mockReturnValue(false);
    getUnsavedFile.mockReturnValue({ contents: "pending draft" });
    mount();
    await vi.runAllTimersAsync();
    expect(writeFile).not.toHaveBeenCalled();

    readScope.mockReturnValue(true);
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...defaultProps} />
        </StrictMode>,
      ),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "pending draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("recovers an existing draft once after StrictMode setup replay", async () => {
    getUnsavedFile.mockReturnValue({ contents: "reopened draft" });
    mount();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "reopened draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it.each([
    { relativePath: "other.txt" },
    { cwd: "/other-workspace" },
    { environmentId: EnvironmentId.make("other-environment") },
  ])("retires callbacks when the file identity changes: %j", async (change) => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("old file edit");
    const nextProps = { ...defaultProps, ...change };
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...nextProps} />
        </StrictMode>,
      ),
    );
    retiredChange("stale editor contents");
    changeHandler()("new file edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId,
        input: { cwd: "/workspace", relativePath: "file.txt", contents: "old file edit" },
      },
      {
        environmentId: nextProps.environmentId,
        input: {
          cwd: nextProps.cwd,
          relativePath: nextProps.relativePath,
          contents: "new file edit",
        },
      },
    ]);
  });

  it("does not reactivate a retired callback when the same file mounts again", async () => {
    mount();
    const retiredChange = changeHandler();
    await act(async () => renderer!.unmount());
    renderer = null;
    mount();
    retiredChange("stale contents");
    changeHandler()("current contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("current contents");
  });
});
