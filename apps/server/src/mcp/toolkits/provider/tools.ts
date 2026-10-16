import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  OrchestratorMcpFailure,
  ProviderDiagnoseInput,
  ProviderDiagnoseResult,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderDiagnosisService from "../../../provider/ProviderDiagnosisService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ProviderDiagnoseTool = Tool.make(agentSurfaceRegistry["provider.diagnose"].name, {
  description: agentSurfaceRegistry["provider.diagnose"].description,
  parameters: ProviderDiagnoseInput,
  success: ProviderDiagnoseResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderDiagnosisService.ProviderDiagnosisService,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.diagnose"]));

export const ProviderToolkit = Toolkit.make(ProviderDiagnoseTool);
