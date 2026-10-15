import { resolvePathLinkTarget, splitFilePathPosition } from "@goat/shared/fileLinks";
import { isAbsolutePath, workspaceRelativeFilePath } from "@goat/shared/path";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import { writeTextToClipboard } from "./hooks/useCopyToClipboard";
import { toastManager } from "./components/ui/toast";

/** Copy targets use the destination environment's roots, never the browser's origin. */
export function resolveFilePathCopyTargets(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
}) {
  const path = splitFilePathPosition(input.filePath).path;
  const workspacePath = resolveDiffPathForWorkspace({
    ...input,
    filePath: path,
    repositoryRoot: input.repositoryRoot,
  });
  const root = input.repositoryRoot ?? input.workspaceRoot;
  const fullPath = isAbsolutePath(path)
    ? path
    : root && isAbsolutePath(root)
      ? resolvePathLinkTarget(path, root)
      : null;
  return {
    relativePath: fullPath
      ? workspaceRelativeFilePath(fullPath, input.workspaceRoot)
      : workspacePath,
    fullPath,
  };
}

/** Reports success only after either the Clipboard API or its fallback succeeds. */
export async function copyFilePath(value: string, kind: "Relative path" | "Full path") {
  const path = splitFilePathPosition(value).path;
  try {
    if (!(await writeTextToClipboard(path, kind.toLowerCase()))) return;
    toastManager.add({ type: "success", title: `${kind} copied`, description: path });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Failed to copy ${kind.toLowerCase()}`,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}
