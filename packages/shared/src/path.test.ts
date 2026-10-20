import { describe, expect, it } from "vite-plus/test";
import {
  fileBasename,
  workspaceRelativeFilePath,
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  isWindowsShellOs,
  msysDrivePathToWindows,
  newProjectFolderName,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  resolveWorkspaceFilePath,
  toWindowsHostPath,
  windowsHostPathKey,
} from "./path.ts";

describe("Windows host paths", () => {
  it.each([
    ["/c/Users/x", "C:\\Users\\x"],
    ["/C/Users/x/", "C:\\Users\\x"],
    ["/c", "C:\\"],
    ["/c/", "C:\\"],
    ["/cygdrive/d/a b", "D:\\a b"],
    ["/cygdrive/d", "D:\\"],
    ["C:/Users/x", "C:\\Users\\x"],
    ["c:\\Users\\x\\", "C:\\Users\\x"],
    ["C:\\", "C:\\"],
    ["\\\\server\\share", "\\\\server\\share"],
    ["/tmp/x", "/tmp/x"],
    ["/cygdrive", "/cygdrive"],
    ["/cd/x", "/cd/x"],
  ])("toWindowsHostPath(%j) is %j", (input, expected) => {
    expect(toWindowsHostPath(input)).toBe(expected);
  });

  it("recognizes only drive mounts as MSYS drive paths", () => {
    expect(msysDrivePathToWindows("/home/x")).toBeNull();
    expect(msysDrivePathToWindows("C:\\x")).toBeNull();
    expect(msysDrivePathToWindows("relative/c/x")).toBeNull();
  });

  it("keys every shell form of one folder the same", () => {
    const key = windowsHostPathKey("C:\\Users\\Super\\Dev");
    for (const form of ["/c/users/super/dev/", "/cygdrive/C/Users/Super/Dev", "c:/users/super/dev"])
      expect(windowsHostPathKey(form)).toBe(key);
    expect(windowsHostPathKey("D:\\Users\\Super\\Dev")).not.toBe(key);
  });

  it("detects Git Bash, MSYS2, and Cygwin unames", () => {
    expect(isWindowsShellOs("MINGW64_NT-10.0-26200")).toBe(true);
    expect(isWindowsShellOs("MSYS_NT-10.0")).toBe(true);
    expect(isWindowsShellOs("CYGWIN_NT-10.0")).toBe(true);
    expect(isWindowsShellOs("Linux")).toBe(false);
    expect(isWindowsShellOs(null)).toBe(false);
  });
});

describe("path helpers", () => {
  it.each([
    ["report:123", "/workspace", "/workspace/report:123"],
    ["/workspace/report:12:3", "/other", "/workspace/report:12:3"],
    ["src/file", "C:\\Workspace\\", "C:\\Workspace\\src\\file"],
    ["C:/Workspace/file", "/other", "C:/Workspace/file"],
    ["file", "\\\\host\\share\\", "\\\\host\\share\\file"],
    ["file", "/", "/file"],
    ["~/report:123", "/workspace", "~/report:123"],
  ])("resolves literal path %s within %s", (path, root, expected) => {
    expect(resolveWorkspaceFilePath(path, root)).toBe(expected);
  });

  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });

  it("normalizes a bare Windows drive root the same as one with a trailing separator", () => {
    expect(normalizeProjectPathForDispatch("C:")).toBe("C:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe("c:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:\\"));
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:/"));
    expect(normalizeProjectPathForDispatch("C:\\repo\\")).toBe("C:\\repo");
  });

  it("names a new project's folder from any typed name", () => {
    expect(newProjectFolderName("Pinball Stats")).toBe("pinball-stats");
    expect(newProjectFolderName("  Café & Crème!  ")).toBe("cafe-creme");
    expect(newProjectFolderName("../../etc")).toBe("etc");
    expect(newProjectFolderName("🎱🎱")).toBe("project");
    expect(newProjectFolderName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    expect(newProjectFolderName("Con")).toBe("con-project");
    expect(newProjectFolderName("LPT1")).toBe("lpt1-project");
    expect(newProjectFolderName("console")).toBe("console");
  });
});

describe("fileBasename", () => {
  it.each([
    ["/tmp/favicons/", "favicons"],
    ["C:\\Users\\kelchm\\.claude\\", ".claude"],
    ["/tmp/", "tmp"],
    ["AGENTS.md", "AGENTS.md"],
    ["/", "/"],
  ])("labels %s as %s", (path, basename) => {
    expect(fileBasename(path)).toBe(basename);
  });
});

describe("workspaceRelativeFilePath", () => {
  it.each([
    ["/repo/project/src/main.ts", "/repo/project", "src/main.ts"],
    ["/repo/project/src/main.ts", "/repo/project/", "src/main.ts"],
    ["C:\\Users\\mike\\t3code\\apps\\web\\a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/C:/Users/mike/t3code/apps/web/a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["/tmp/case/project/probe.txt", "/tmp/case/Project", null],
    ["//tmp/case/project/probe.txt", "//tmp/case/Project", null],
    ["/tmp/case/Project/probe.txt", "/tmp/case/Project", "probe.txt"],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/C:/USERS/mike/t3code/main.ts", "/c:/users/MIKE/t3code", "main.ts"],
    ["\\\\server\\share\\PROJECT\\main.ts", "\\\\Server\\Share\\Project", "main.ts"],
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/main.ts", "c:/", "Users/MIKE/main.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts ", "/tmp/repo", "file.ts "],
    ["/tmp/report.ts", "/repo/project", null],
    ["/repo/project-two/a.ts", "/repo/project", null],
    ["/repo/project/a.ts", undefined, null],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});
