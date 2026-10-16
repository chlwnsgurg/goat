import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  PreviewListResult,
  PreviewTabId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, PreviewAutomationUnavailableError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PreviewManager.PreviewManager,
    PreviewAutomationBroker.PreviewAutomationBroker,
  ],
};
const PreviewListTool = Tool.make(agentSurfaceRegistry["preview.list"].name, {
  ...shared,
  description: agentSurfaceRegistry["preview.list"].description,
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({
    ...PreviewListResult.fields,
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.list"]));
const PreviewCloseTool = Tool.make(agentSurfaceRegistry["preview.close"].name, {
  ...shared,
  description: agentSurfaceRegistry["preview.close"].description,
  parameters: Schema.Struct({ tabId: PreviewTabId }),
  success: Schema.Struct({}),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.close"]));
export const PreviewControlsToolkit = Toolkit.make(PreviewListTool, PreviewCloseTool);
