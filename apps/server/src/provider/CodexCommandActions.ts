import {
  ORCHESTRATION_V2_MAX_COMMAND_ACTIONS,
  type OrchestrationV2CommandAction,
} from "@goat/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

type CodexCommandAction =
  | CodexSchema.V2ItemStartedNotification__CommandAction
  | CodexSchema.V2ItemCompletedNotification__CommandAction;

function bounded(value: string | null | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

/**
 * Codex parses each exec command into read, list, and search steps. One
 * unknown step makes it a plain command, returned as an empty list so the
 * server does not reclassify it.
 */
export function codexCommandActions(
  actions: ReadonlyArray<CodexCommandAction>,
): OrchestrationV2CommandAction[] {
  if (actions.length > ORCHESTRATION_V2_MAX_COMMAND_ACTIONS) return [];
  const mapped: OrchestrationV2CommandAction[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "read": {
        const path = bounded(action.path, 4_096);
        if (path === undefined) return [];
        mapped.push({ type: "read", path });
        break;
      }
      case "listFiles": {
        const path = bounded(action.path, 4_096);
        mapped.push({ type: "list", ...(path === undefined ? {} : { path }) });
        break;
      }
      case "search": {
        const query = bounded(action.query, 1_024);
        const path = bounded(action.path, 4_096);
        mapped.push({
          type: "search",
          ...(query === undefined ? {} : { query }),
          ...(path === undefined ? {} : { path }),
        });
        break;
      }
      case "unknown":
        return [];
    }
  }
  return mapped;
}
