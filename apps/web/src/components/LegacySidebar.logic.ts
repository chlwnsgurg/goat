import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { SidebarThreadSummary } from "../types";

/** Forks are standalone chats; subagents belong to their parent's Agents surface. */
export function isProjectsViewPinnedThread(
  thread: Pick<SidebarThreadSummary, "pinnedAt" | "archivedAt" | "deletedAt" | "lineage">,
) {
  return (
    thread.pinnedAt != null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.lineage.relationshipToParent !== "subagent"
  );
}

/** Keyboard jumps and traversal follow the displayed order, with pins appearing once. */
export function resolveProjectsViewThreadOrder(
  pinnedKeys: readonly string[],
  projectKeys: readonly string[],
) {
  return [...new Set([...pinnedKeys, ...projectKeys])];
}

/** A grouped remote project reports the least healthy member connection. */
export function resolveProjectConnectionStatus(phases: readonly EnvironmentConnectionPhase[]) {
  if (
    phases.length === 0 ||
    phases.some((phase) => ["available", "offline", "error", "unsupported"].includes(phase))
  )
    return "disconnected";
  if (phases.some((phase) => phase !== "connected")) return "connecting";
  return "connected";
}
