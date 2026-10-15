import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { memoryInputSchema } from "../memory/tools.ts";
export const MemoryAdministrationToolkit = Toolkit.make(
  Tool.dynamic(agentSurfaceRegistry["memory.hub_disable"].name, {
    description: agentSurfaceRegistry["memory.hub_disable"].description,
    parameters: memoryInputSchema(M.MemoryHubDisableInput),
    success: M.MemoryHubDisableResult,
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemorySyncService.MemorySyncService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.hub_disable"])),
);
