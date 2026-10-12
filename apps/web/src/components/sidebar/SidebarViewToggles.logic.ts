import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { excludeGlobalAgentThreads } from "../../globalAgentRoute";
import type { GlobalAgentRef } from "../../globalAgentStore";
import {
  filterSidebarV2VisibleThreads,
  isSidebarDelegatedChildThread,
  resolveSidebarThreadStatus,
  sidebarDelegatedChildState,
} from "../Sidebar.logic";

/** Attention belongs to a visible parent, including its nested delegated tasks. */
export function hasSidebarActivityAttention(
  threads: readonly EnvironmentThreadShell[],
  globalAgentRef: GlobalAgentRef | null,
): boolean {
  const attentionParents = new Set<string>();
  for (const thread of threads) {
    if (
      isSidebarDelegatedChildThread(thread) &&
      thread.lineage.parentThreadId !== null &&
      sidebarDelegatedChildState(thread) === "attention"
    ) {
      attentionParents.add(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.lineage.parentThreadId)),
      );
    }
  }
  return excludeGlobalAgentThreads(
    filterSidebarV2VisibleThreads(threads, null),
    globalAgentRef,
  ).some((thread) => {
    if (thread.deletedAt !== null) return false;
    const status = resolveSidebarThreadStatus(thread);
    return (
      status === "approval" ||
      status === "input" ||
      attentionParents.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    );
  });
}
