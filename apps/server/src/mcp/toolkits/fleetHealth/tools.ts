import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  GoatHostCordonInput,
  GoatHostDrainInput,
  GoatHostScheduleResult,
  GoatHostUncordonInput,
  GoatThreadRescheduleInput,
  GoatThreadRescheduleResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as Health from "../../../fleet/health/HostHealthMonitor.ts";
import * as Rescheduler from "../../../fleet/health/Rescheduler.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Health.Health,
    Rescheduler.Rescheduler,
  ],
};

const HostCordonTool = Tool.make(agentSurfaceRegistry["host.cordon"].name, {
  ...shared,
  description: agentSurfaceRegistry["host.cordon"].description,
  parameters: GoatHostCordonInput,
  success: GoatHostScheduleResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host.cordon"]));

const HostUncordonTool = Tool.make(agentSurfaceRegistry["host.uncordon"].name, {
  ...shared,
  description: agentSurfaceRegistry["host.uncordon"].description,
  parameters: GoatHostUncordonInput,
  success: GoatHostScheduleResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host.uncordon"]));

const HostDrainTool = Tool.make(agentSurfaceRegistry["host.drain"].name, {
  ...shared,
  description: agentSurfaceRegistry["host.drain"].description,
  parameters: GoatHostDrainInput,
  success: GoatHostScheduleResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host.drain"]));

const ThreadRescheduleTool = Tool.make(agentSurfaceRegistry["thread.reschedule"].name, {
  ...shared,
  description: agentSurfaceRegistry["thread.reschedule"].description,
  parameters: GoatThreadRescheduleInput,
  success: GoatThreadRescheduleResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.reschedule"]));

export const FleetHealthToolkit = Toolkit.make(
  HostCordonTool,
  HostUncordonTool,
  HostDrainTool,
  ThreadRescheduleTool,
);
