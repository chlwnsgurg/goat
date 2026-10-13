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

export function cloudTaskResultText(task: OrchestrationV2CloudTask) {
  const title =
    task.tracking === "link-only" && task.status === "running"
      ? "Running in the cloud"
      : `Cloud task ${task.status}`;
  return [
    task.summary ?? title,
    task.prUrl ? `Pull request: ${task.prUrl}` : undefined,
    task.branch ? `Branch: ${task.branch}` : undefined,
    task.url ? `Task: ${task.url}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
