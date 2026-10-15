import * as M from "@goat/contracts";
import { makeSubagentChildThread } from "@goat/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const encodeThread = Schema.encodeSync(Schema.fromJsonString(M.OrchestrationV2AppThreadJson));
const encodeProvider = Schema.encodeSync(
  Schema.fromJsonString(M.OrchestrationV2ProviderThreadJson),
);
const encodeTransfer = Schema.encodeSync(
  Schema.fromJsonString(M.OrchestrationV2ContextTransferJson),
);
const now = DateTime.makeUnsafe("2026-10-14T00:00:00.000Z");
const parent = M.ThreadId.make("parent");
const selection = { instanceId: M.ProviderInstanceId.make("fixture"), model: "fixture" };
type OriginEvent =
  | { readonly type: "provider-thread.updated"; readonly payload: M.OrchestrationV2ProviderThread }
  | {
      readonly type: "context-transfer.created" | "context-transfer.updated";
      readonly payload: M.OrchestrationV2ContextTransfer;
    };

/** Canonical persisted shapes from threadCreate, delegateTask, ThreadForkService and imports.
 * Launcher/parent/node metadata identifies relationships; only fork/import/transfer carries history.
 */
export function threadProvenanceCases(threadId: M.ThreadId) {
  const fresh: M.OrchestrationV2AppThread = {
    id: threadId,
    projectId: M.ProjectId.make("project"),
    title: "synthetic provenance",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const transfer = (
    type: M.OrchestrationV2ContextTransferType,
    sourceThreadId = parent,
  ): M.OrchestrationV2ContextTransfer => ({
    id: M.ContextTransferId.make(`transfer-${type}`),
    type,
    sourceThreadId,
    targetThreadId: threadId,
    sourcePoint: { threadId: sourceThreadId, runId: M.RunId.make("source-run") },
    basePoint: null,
    sourceProviderInstanceId: selection.instanceId,
    targetProviderInstanceId: selection.instanceId,
    targetRunId: M.RunId.make("target-run"),
    status: "consumed",
    resolution: null,
    createdBy: "agent",
    error: null,
    createdAt: now,
    updatedAt: now,
    consumedAt: now,
  });
  const providerThread: M.OrchestrationV2ProviderThread = {
    id: M.ProviderThreadId.make("native"),
    driver: M.ProviderDriverKind.make("codex"),
    providerInstanceId: selection.instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: M.ProviderDriverKind.make("codex"),
      nativeId: "synthetic",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const child = makeSubagentChildThread({
    parentThread: { ...fresh, id: parent },
    childThreadId: threadId,
    parentNodeId: M.NodeId.make("task"),
    activeProviderThreadId: null,
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    title: fresh.title,
    now,
    createdBy: "agent",
    creationSource: "mcp",
  });
  const fork: M.OrchestrationV2AppThread = {
    ...fresh,
    lineage: { parentThreadId: parent, relationshipToParent: "fork", rootThreadId: parent },
    forkedFrom: { type: "run", threadId: parent, runId: M.RunId.make("source-run") },
  };
  const row = (
    name: string,
    state: "tracked" | "unknown",
    thread = fresh,
    events: readonly OriginEvent[] = [],
  ) => ({
    name,
    state,
    createdJson: encodeThread(thread),
    events: events.map((event) => ({
      type: event.type,
      payloadJson:
        event.type === "provider-thread.updated"
          ? encodeProvider(event.payload)
          : encodeTransfer(event.payload),
    })),
  });
  const launched = (via: NonNullable<M.OrchestrationV2AppThread["launchedBy"]>["via"]) => ({
    ...fresh,
    launchedBy: {
      kind: "launch" as const,
      threadId: parent,
      environmentId: null,
      environmentLabel: null,
      threadTitle: "synthetic parent",
      via,
    },
  });
  return [
    row("direct", "tracked"),
    row("scheduled task", "tracked", { ...fresh, createdBy: "system", creationSource: "server" }),
    row("channel worker", "tracked", { ...fresh, createdBy: "system", creationSource: "server" }),
    row("fresh side chat", "tracked", { ...fresh, sideChatOf: parent }),
    row("goat_thread_launch", "tracked", launched("thread_launch")),
    row("create_threads", "tracked", launched("create_threads")),
    row("SSH remote launch", "tracked", launched("ssh_thread_launch")),
    row("delegate_task", "tracked", child, [
      { type: "context-transfer.created", payload: transfer("subagent_spawn") },
    ]),
    row("subagent follow-up", "tracked", child, [
      { type: "context-transfer.updated", payload: transfer("subagent_spawn") },
    ]),
    row("fresh attached provider", "tracked", {
      ...fresh,
      activeProviderThreadId: providerThread.id,
    }),
    row(
      "native prompt-only subagent",
      "tracked",
      {
        ...child,
        creationSource: "provider",
        activeProviderThreadId: providerThread.id,
      },
      [
        {
          type: "provider-thread.updated",
          payload: {
            ...providerThread,
            status: "active",
            providerSessionId: M.ProviderSessionId.make("synthetic-session"),
          },
        },
      ],
    ),
    row("native fork origin", "unknown", {
      ...fresh,
      forkedFrom: {
        type: "provider_thread",
        providerThreadId: M.ProviderThreadId.make("source-native"),
      },
    }),
    row("spawn followed by real context transfer", "unknown", child, [
      { type: "context-transfer.created", payload: transfer("subagent_spawn") },
      { type: "context-transfer.updated", payload: transfer("provider_handoff") },
    ]),
    row("fork", "unknown", fork, [{ type: "context-transfer.created", payload: transfer("fork") }]),
    row("fork side chat", "unknown", { ...fork, sideChatOf: parent }),
    row("legacy import", "unknown", { ...fresh, historyOrigin: "v1_import" }),
    row("agent session import", "unknown", {
      ...fresh,
      historyOrigin: "v1_import",
      activeProviderThreadId: providerThread.id,
    }),
    row("native import", "unknown", fresh, [
      { type: "provider-thread.updated", payload: providerThread },
    ]),
    row("same-thread handoff", "tracked", fresh, [
      { type: "context-transfer.created", payload: transfer("provider_handoff", threadId) },
    ]),
    row("cross-thread handoff", "unknown", fresh, [
      { type: "context-transfer.created", payload: transfer("provider_handoff") },
    ]),
    row("merge back", "unknown", fresh, [
      { type: "context-transfer.updated", payload: transfer("merge_back") },
    ]),
    row("subagent result", "unknown", fresh, [
      { type: "context-transfer.created", payload: transfer("subagent_result") },
    ]),
  ];
}
