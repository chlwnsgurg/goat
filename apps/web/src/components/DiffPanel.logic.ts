import type { RunId } from "@goat/contracts";

/**
 * Which checkpoint a turn selection shows. A run's checkpoint is captured when it ends, so a file
 * clicked during the latest run has no summary yet; showing another turn in its place would read
 * as that edit having no changes, and reconciling to it would keep the wrong turn once the
 * checkpoint arrives.
 */
export function resolveDiffPanelTurn<T extends { readonly runId: RunId }>(input: {
  readonly orderedSummaries: ReadonlyArray<T>;
  readonly selectedRunId: RunId | null;
  readonly activeRunId: RunId | null | undefined;
  readonly latestRunId: RunId | null | undefined;
}): { readonly turn: T | undefined; readonly awaitingCheckpoint: boolean } {
  const { orderedSummaries, selectedRunId } = input;
  if (selectedRunId === null) return { turn: undefined, awaitingCheckpoint: false };
  const exact = orderedSummaries.find((summary) => summary.runId === selectedRunId);
  if (exact !== undefined) return { turn: exact, awaitingCheckpoint: false };
  if (selectedRunId === input.activeRunId || selectedRunId === input.latestRunId) {
    return { turn: undefined, awaitingCheckpoint: true };
  }
  return { turn: orderedSummaries[0], awaitingCheckpoint: false };
}
