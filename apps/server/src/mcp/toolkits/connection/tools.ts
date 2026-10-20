import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  SavedConnection,
  TrimmedNonEmptyString,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ConnectionCatalogBroker from "../../../connections/ConnectionCatalogBroker.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ConnectionCatalogBroker.ConnectionCatalogBroker,
  ],
};

const ListTool = Tool.make(agentSurfaceRegistry["connection.list"].name, {
  ...shared,
  description: agentSurfaceRegistry["connection.list"].description,
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ connections: Schema.Array(SavedConnection) }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["connection.list"]));

const AddSshTool = Tool.make(agentSurfaceRegistry["connection.add_ssh"].name, {
  ...shared,
  description: agentSurfaceRegistry["connection.add_ssh"].description,
  parameters: Schema.Struct({
    host: TrimmedNonEmptyString.annotate({
      description: "SSH alias or host from goat_ssh_host_list.",
    }),
    label: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ created: Schema.Boolean, connection: SavedConnection }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["connection.add_ssh"]));

const RemoveTool = Tool.make(agentSurfaceRegistry["connection.remove"].name, {
  ...shared,
  description: agentSurfaceRegistry["connection.remove"].description,
  parameters: Schema.Struct({ environmentId: EnvironmentId }),
  success: Schema.Struct({ removed: SavedConnection }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["connection.remove"]));

export const ConnectionToolkit = Toolkit.make(ListTool, AddSshTool, RemoveTool);
