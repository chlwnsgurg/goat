import type { OrchestrationV2TurnItem } from "@goat/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";
import { fileBasename } from "@goat/shared/path";

import { resolveFileDiffPath } from "../../lib/diffRendering";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

/** Larger files open in the diff panel, which virtualizes; the transcript does not. */
export const INLINE_DIFF_MAX_LINES = 400;

export function fileChangeTargetPaths(item: FileChangeItem): ReadonlyArray<string> {
  const paths = item.changes?.map((change) => change.path) ?? [];
  return paths.length > 0 ? [...new Set(paths)] : [item.fileName];
}

function fileChangeVerb(item: FileChangeItem): string {
  const operations = new Set(item.changes?.map((change) => change.operation));
  if (operations.size !== 1) return "Edited";
  switch ([...operations][0]) {
    case "add":
      return "Created";
    case "delete":
      return "Deleted";
    case "move":
      return "Moved";
    default:
      return "Edited";
  }
}

/** The verb and file name a changed-file row reads as, such as "Edited ChatView.tsx". */
export function fileChangeRowLabel(item: FileChangeItem): string {
  const paths = fileChangeTargetPaths(item);
  const name = fileBasename((paths[0] ?? item.fileName).replaceAll("\\", "/"));
  const more = paths.length > 1 ? ` +${paths.length - 1} more` : "";
  return `${fileChangeVerb(item)} ${name}${more}`;
}

/** The one-file section of a multi-file git patch, for copying. */
export function extractFilePatch(patch: string, file: FileDiffMetadata): string {
  const path = resolveFileDiffPath(file);
  const sections = patch.split(/^(?=diff --git )/m);
  const section = sections.find((candidate) => {
    const header = candidate.slice(0, candidate.indexOf("\n") + 1 || candidate.length);
    return header.endsWith(` b/${path}\n`) || header.endsWith(` b/${path}`);
  });
  return (section ?? "").trimEnd();
}
