import * as HomeRequests from "../../../provider/CodexHomeRequests.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  OrchestratorMcpFailure,
  ProviderAddableListResult,
  ProviderHomeRequestInput,
  ProviderHomeRequestResultJson,
  ProviderDiagnoseOnHostInput,
  ProviderDiagnoseOnHostResult,
  ProviderHostMatrixInput,
  ProviderHostMatrixResult,
  ProviderSyncCancelInput,
  ProviderSyncInput,
  ProviderSyncResultJson,
  ProviderSyncState,
  ProviderSyncStatusInput,
  ProviderLoginFlowInput,
  ProviderLoginResultJson,
  ProviderLoginStartInput,
  ProviderSetupOpenInput,
  ProviderSetupOpenResultJson,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderDiagnosisRouting from "../../../provider/ProviderDiagnosisRouting.ts";
import * as ProviderHostSync from "../../../provider/ProviderHostSync.ts";
import * as ProviderOnboarding from "../../../provider/ProviderOnboarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ProviderDiagnoseTool = Tool.make(agentSurfaceRegistry["provider.diagnose"].name, {
  description: agentSurfaceRegistry["provider.diagnose"].description,
  parameters: ProviderDiagnoseOnHostInput,
  success: ProviderDiagnoseOnHostResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderDiagnosisRouting.ProviderDiagnosisRouting,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.diagnose"]));

const ProviderHomeRequestTool = Tool.make(agentSurfaceRegistry["provider.home_request"].name, {
  description: agentSurfaceRegistry["provider.home_request"].description,
  parameters: ProviderHomeRequestInput,
  success: ProviderHomeRequestResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HomeRequests.CodexHomeRequests,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.home_request"]));

const hostSyncDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProviderHostSync.ProviderHostSync,
];
const ProviderHostMatrixTool = Tool.make(agentSurfaceRegistry["provider.host_matrix"].name, {
  description: agentSurfaceRegistry["provider.host_matrix"].description,
  parameters: ProviderHostMatrixInput,
  success: ProviderHostMatrixResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: hostSyncDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.host_matrix"]));
const ProviderSyncTool = Tool.make(agentSurfaceRegistry["provider.sync"].name, {
  description: agentSurfaceRegistry["provider.sync"].description,
  parameters: ProviderSyncInput,
  success: ProviderSyncResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: hostSyncDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.sync"]));
const ProviderSyncStatusTool = Tool.make(agentSurfaceRegistry["provider.sync_status"].name, {
  description: agentSurfaceRegistry["provider.sync_status"].description,
  parameters: ProviderSyncStatusInput,
  success: ProviderSyncState,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: hostSyncDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.sync_status"]));
const ProviderSyncCancelTool = Tool.make(agentSurfaceRegistry["provider.sync_cancel"].name, {
  description: agentSurfaceRegistry["provider.sync_cancel"].description,
  parameters: ProviderSyncCancelInput,
  success: ProviderSyncState,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: hostSyncDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.sync_cancel"]));
const onboardingDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProviderOnboarding.ProviderOnboarding,
];

const ProviderAddableListTool = Tool.make(agentSurfaceRegistry["provider.addable_list"].name, {
  description: agentSurfaceRegistry["provider.addable_list"].description,
  parameters: Tool.EmptyParams,
  success: ProviderAddableListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.addable_list"]));
const ProviderSetupOpenTool = Tool.make(agentSurfaceRegistry["provider.setup_open"].name, {
  description: agentSurfaceRegistry["provider.setup_open"].description,
  parameters: ProviderSetupOpenInput,
  success: ProviderSetupOpenResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.setup_open"]));
const ProviderLoginStartTool = Tool.make(agentSurfaceRegistry["provider.login_start"].name, {
  description: agentSurfaceRegistry["provider.login_start"].description,
  parameters: ProviderLoginStartInput,
  success: ProviderLoginResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.login_start"]));
const ProviderLoginStatusTool = Tool.make(agentSurfaceRegistry["provider.login_status"].name, {
  description: agentSurfaceRegistry["provider.login_status"].description,
  parameters: ProviderLoginFlowInput,
  success: ProviderLoginResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.login_status"]));
const ProviderLoginCancelTool = Tool.make(agentSurfaceRegistry["provider.login_cancel"].name, {
  description: agentSurfaceRegistry["provider.login_cancel"].description,
  parameters: ProviderLoginFlowInput,
  success: ProviderLoginResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.login_cancel"]));

export const ProviderToolkit = Toolkit.make(
  ProviderDiagnoseTool,
  ProviderHomeRequestTool,
  ProviderHostMatrixTool,
  ProviderSyncTool,
  ProviderSyncStatusTool,
  ProviderSyncCancelTool,
  ProviderAddableListTool,
  ProviderSetupOpenTool,
  ProviderLoginStartTool,
  ProviderLoginStatusTool,
  ProviderLoginCancelTool,
);
