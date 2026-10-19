import type { RunId, ScopedThreadRef } from "@goat/contracts";
import { FileDiff } from "@pierre/diffs/react";
import { memo, type ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useCheckpointDiff } from "../../lib/checkpointDiffState";
import {
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  findPatchFile,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { useThreadCheckpointSummaries } from "../../state/entities";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DiffStatLabel } from "./DiffStatLabel";
import { extractFilePatch, INLINE_DIFF_MAX_LINES } from "./fileChangeInlineDiff.logic";
import { MessageCopyButton } from "./MessageCopyButton";

function InlineDiffNote({ children }: { children: ReactNode }) {
  return <p className="ms-7 py-1 text-xs text-muted-foreground">{children}</p>;
}

/**
 * The turn's checkpoint diff for the files one edit touched. Provider payloads do not reach
 * clients (see projectTurnItemForWire), and the checkpoint is the same source the diff panel
 * reads, so both views agree and share one cached query.
 */
export const FileChangeInlineDiff = memo(function FileChangeInlineDiff(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runId: RunId;
  readonly paths: ReadonlyArray<string>;
  readonly resolvedTheme: "light" | "dark";
  readonly onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const { threadRef, runId, paths, resolvedTheme, onOpenTurnDiff } = props;
  const ignoreWhitespace = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const summary = useThreadCheckpointSummaries(threadRef).find(
    (candidate) => candidate.runId === runId,
  );
  const turnCount = summary?.checkpointTurnCount ?? null;
  const diff = useCheckpointDiff(
    {
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      fromTurnCount: turnCount === null ? null : Math.max(0, turnCount - 1),
      toTurnCount: turnCount,
      ignoreWhitespace,
      cacheScope: `turn:${runId}`,
    },
    { enabled: summary !== undefined },
  );

  if (summary === undefined) {
    return <InlineDiffNote>The diff appears when this turn finishes.</InlineDiffNote>;
  }
  const patch = diff.data?.diff;
  if (patch === undefined) {
    return diff.error ? (
      <InlineDiffNote>{diff.error}</InlineDiffNote>
    ) : (
      <InlineDiffNote>Loading diff…</InlineDiffNote>
    );
  }
  // The panel's cache scope, so opening the panel reuses this parse.
  const renderable = getRenderablePatch(patch, `diff-panel:${resolvedTheme}`);
  const files = renderable?.kind === "files" ? renderable.files : [];
  const matched = paths.flatMap((path) => {
    const file = findPatchFile(files, path);
    return file === null ? [] : [file];
  });
  const uniqueFiles = [...new Set(matched)];
  if (uniqueFiles.length === 0) {
    return <InlineDiffNote>No net change to this file by the end of the turn.</InlineDiffNote>;
  }

  return (
    <div className="flex flex-col gap-2">
      {uniqueFiles.map((file) => {
        const filePath = resolveFileDiffPath(file);
        const stat = getDiffLineStat([file]);
        const filePatch = extractFilePatch(patch, file);
        const tooLarge = file.unifiedLineCount > INLINE_DIFF_MAX_LINES;
        return (
          <div
            key={filePath}
            className="overflow-hidden rounded-lg border border-border/70 bg-(--code-background)"
            data-file-change-inline-diff={filePath}
          >
            <div className="flex min-w-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-2.5 py-1 text-xs">
              <Tooltip>
                <TooltipTrigger
                  render={<span className="min-w-0 truncate font-mono text-foreground/80" />}
                >
                  {filePath}
                </TooltipTrigger>
                <TooltipPopup>{filePath}</TooltipPopup>
              </Tooltip>
              <DiffStatLabel
                additions={stat.additions}
                deletions={stat.deletions}
                layout="inline"
                className="shrink-0"
              />
              <span className="flex-1" />
              {filePatch.length > 0 ? (
                <MessageCopyButton
                  text={filePatch}
                  label="Copy diff"
                  size="icon-xs"
                  variant="ghost"
                />
              ) : null}
            </div>
            {tooLarge ? (
              <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
                <span>
                  {file.unifiedLineCount.toLocaleString()} lines is too long to show here.
                </span>
                <InlineButton onClick={() => onOpenTurnDiff(runId, filePath)}>
                  Show full diff in panel
                </InlineButton>
              </div>
            ) : (
              <div className="max-h-72 overflow-auto">
                <DiffWorkerPoolProvider>
                  <FileDiff
                    fileDiff={file}
                    options={{
                      collapsed: false,
                      diffStyle: "unified",
                      disableFileHeader: true,
                      hunkSeparators: "simple",
                      theme: resolveDiffThemeName(resolvedTheme),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
                    }}
                  />
                </DiffWorkerPoolProvider>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
