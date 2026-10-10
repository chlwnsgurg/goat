import type { GlobalAgentRef } from "./globalAgentStore";
import type { ThreadRouteTarget } from "./threadRoutes";

export const GLOBAL_AGENT_TITLE = "Global agent";

export function isGlobalAgentThread(
  thread: { readonly environmentId: string; readonly id: string },
  ref: GlobalAgentRef | null,
): boolean {
  return ref !== null && thread.environmentId === ref.environmentId && thread.id === ref.threadId;
}

export function excludeGlobalAgentThreads<
  T extends { readonly environmentId: string; readonly id: string },
>(threads: readonly T[], ref: GlobalAgentRef | null): T[] {
  return threads.filter((thread) => !isGlobalAgentThread(thread, ref));
}

/**
 * True on the global draft and thread routes. "/" is never active: it is a
 * transient route that immediately replaces itself with the resolved target
 * (the global agent, or a project draft when it falls back).
 */
export function isGlobalAgentRoute(
  pathname: string,
  target: ThreadRouteTarget | null,
  ref: GlobalAgentRef | null,
): boolean {
  if (ref === null || pathname === "/" || target === null) return false;
  if (target.kind === "draft") return target.draftId === ref.draftId;
  return (
    target.threadRef.environmentId === ref.environmentId &&
    target.threadRef.threadId === ref.threadId
  );
}
