import {
  isAbsolutePath,
  resolveWorkspaceFilePath,
  workspaceRelativeFilePath,
} from "@goat/shared/path";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import { writeTextToClipboard } from "./hooks/useCopyToClipboard";
import { toastManager } from "./components/ui/toast";

/** Copy targets use the destination environment's roots, never the browser's origin. */
export function resolveFilePathCopyTargets(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
}) {
  const path = input.filePath;
  const workspacePath = resolveDiffPathForWorkspace({
    ...input,
    filePath: path,
    repositoryRoot: input.repositoryRoot,
  });
  const root = input.repositoryRoot ?? input.workspaceRoot;
  const fullPath = isAbsolutePath(path)
    ? path
    : root && isAbsolutePath(root)
      ? resolveWorkspaceFilePath(path, root)
      : null;
  return {
    relativePath: fullPath
      ? workspaceRelativeFilePath(fullPath, input.workspaceRoot)
      : workspacePath,
    fullPath,
  };
}

/** Reports success only after either the Clipboard API or its fallback succeeds. */
export async function copyFilePath(path: string, kind: "Relative path" | "Full path") {
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
