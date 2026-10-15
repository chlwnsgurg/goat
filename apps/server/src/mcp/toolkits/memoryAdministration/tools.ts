import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { memoryInputSchema } from "../memory/tools.ts";
export const MemoryAdministrationToolkit = Toolkit.make(
  Tool.dynamic("memory_hub_disable", {
    description:
      "Disable the memory hub using settings:write and a versioned compare-and-swap. Returns only the disabled settings view; no credential.",
    parameters: memoryInputSchema(M.MemoryHubDisableInput),
    success: M.MemoryHubDisableResult,
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemorySyncService.MemorySyncService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, false),
);
