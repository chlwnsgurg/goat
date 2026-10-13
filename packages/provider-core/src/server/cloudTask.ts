import type {
  OrchestrationV2CloudTask,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
} from "@goat/contracts";

export function isCloudExecution(capabilities: OrchestrationV2ProviderCapabilities) {
  return capabilities.sessions.executionLocation === "cloud";
}

export function canCheckpoint(capabilities: OrchestrationV2ProviderCapabilities) {
  return !isCloudExecution(capabilities);
}

export function cloudFollowUpReason(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerThreads">,
  instanceId: ProviderInstanceId,
  capabilities: OrchestrationV2ProviderCapabilities,
  excludingRunId?: RunId,
) {
  const thread = projection.providerThreads.findLast(
    (candidate) => candidate.ownerNodeId === null && candidate.providerInstanceId === instanceId,
  );
  if (thread?.cloudTask?.status === "unknown") {
    return (
      thread.cloudTask.error ??
      "Cloud submission outcome is unknown. Open the task before continuing."
    );
  }
  if (capabilities.sessions.followUp?.supported !== false) return null;
  const reserved = projection.runs.some(
    (run) =>
      run.id !== excludingRunId &&
      run.providerInstanceId === instanceId &&
      run.status !== "rolled_back" &&
      (run.startedAt != null ||
        ["queued", "preparing", "starting", "running", "waiting"].includes(run.status)),
  );
  return reserved || thread?.cloudTask !== undefined
    ? (capabilities.sessions.followUp.reason ??
        "This cloud provider does not support follow-up messages.")
    : null;
}

// True when the text links exactly this URL (not a longer one such as /pull/70 for /pull/7).
function linksUrl(text: string, url: string) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(url, from);
    if (at === -1) return false;
    const next = text.charAt(at + url.length);
    if (next === "" || /[\s)\]>.,;:!?'"`]/.test(next)) return true;
    from = at + 1;
  }
}

export function cloudTaskResultText(task: OrchestrationV2CloudTask) {
  const title =
    task.tracking === "link-only" && task.status === "running"
      ? "Running in the cloud"
      : `Cloud task ${task.status}`;
  const summary = task.summary?.trim() || title;
  // Rendered as markdown: one link per list item so URLs never run into the next label,
  // and the pull request is not repeated when the summary already links it.
  const links = [
    task.prUrl && !linksUrl(summary, task.prUrl) ? `- Pull request: ${task.prUrl}` : undefined,
    task.branch ? `- Branch: \`${task.branch}\`` : undefined,
    task.url ? `- Cloud task: ${task.url}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return links.length === 0 ? summary : `${summary}\n\n${links.join("\n")}`;
}
