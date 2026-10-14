import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const failure = Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]);
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  MemoryService.MemoryService,
  MemorySyncService.MemorySyncService,
  ThreadManagementService.ThreadManagementService,
];

const SearchTool = Tool.make("memory_search", {
  description:
    "Search memory. Return the service cursor unchanged; pass it to the next request with the same query and scope.",
  parameters: M.MemorySearchInput,
  success: M.MemoryPage,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ListTool = Tool.make("memory_list", {
  description: "List one bounded memory page.",
  parameters: M.MemoryListInput,
  success: M.MemoryPage,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ReadTool = Tool.make("memory_read", {
  description: "Read one memory item.",
  parameters: M.MemoryReadInput,
  success: M.MemoryItem,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const HistoryTool = Tool.make("memory_history", {
  description: "Read one bounded memory history page.",
  parameters: M.MemoryHistoryInput,
  success: M.MemoryHistoryPage,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const SyncStatusTool = Tool.make("memory_sync_status", {
  description: "Read memory synchronization status, including disabled or unbound state.",
  parameters: M.MemorySyncStatusInput,
  success: M.MemorySyncStatus,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const UpsertTool = Tool.make("memory_upsert", {
  description:
    "Create or update memory with an explicit memory:write grant. Read-only sessions cannot write.",
  parameters: M.MemoryUpsertInput,
  success: M.MemoryMutationReceipt,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ForgetTool = Tool.make("memory_forget", {
  description: "Forget memory. Requires memory:write and a session allowed to write.",
  parameters: M.MemoryForgetInput,
  success: M.MemoryMutationReceipt,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const RevertResolutionTool = Tool.make("memory_revert_resolution", {
  description: "Revert a memory resolution within its deadline. Requires memory:write.",
  parameters: M.MemoryRevertResolutionInput,
  success: M.MemoryRevertResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const ReadSourceTool = Tool.make("memory_read_source", {
  description:
    "Read original evidence through its owner. Requires memory:read and independently granted orchestration:read. No arbitrary path or SSH target.",
  parameters: M.MemoryReadSourceInput,
  success: M.MemorySourcePage,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const MemoryToolkit = Toolkit.make(
  SearchTool,
  ListTool,
  ReadTool,
  HistoryTool,
  SyncStatusTool,
  UpsertTool,
  ForgetTool,
  RevertResolutionTool,
);
// Prepared definition only. L1 supplies the public service method before registration.
export const MemoryReadSourceToolkit = Toolkit.make(ReadSourceTool);
