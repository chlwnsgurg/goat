import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { Tool, Toolkit } from "effect/ai";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** JSON Schema presentation only; handlers still decode the original strict contracts. */
export const memoryInputSchema = (schema: Schema.Top) => {
  const expose = (ast: SchemaAST.AST): SchemaAST.AST => {
    if (ast._tag === "Declaration" && ast.typeParameters.length === 1)
      return expose(ast.typeParameters[0]!);
    if (ast._tag === "Objects")
      return new SchemaAST.Objects(
        ast.propertySignatures.map(
          (field) => new SchemaAST.PropertySignature(field.name, expose(field.type)),
        ),
        ast.indexSignatures.map(
          (field) => new SchemaAST.IndexSignature(expose(field.parameter), expose(field.type)),
        ),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    if (ast._tag === "Arrays")
      return new SchemaAST.Arrays(
        ast.isMutable,
        ast.elements.map(expose),
        ast.rest.map(expose),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    if (ast._tag === "Union")
      return new SchemaAST.Union(
        ast.types.map(expose),
        ast.options,
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    if (ast._tag === "Suspend")
      return new SchemaAST.Suspend(
        () => expose(ast.thunk()),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    return ast;
  };
  const document = Schema.toJsonSchemaDocument(Schema.make(expose(schema.ast)), {
    onExcessProperty: "error",
  });
  return {
    ...document.schema,
    type: "object" as const,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
  };
};

const failure = Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]);
const SearchTool = Tool.dynamic("memory_search", {
  description:
    "Search memory. Return the service cursor unchanged; pass it to the next request with the same query and scope.",
  parameters: memoryInputSchema(M.MemorySearchInput),
  success: M.MemoryPage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ListTool = Tool.dynamic("memory_list", {
  description: "List one bounded memory page.",
  parameters: memoryInputSchema(M.MemoryListInput),
  success: M.MemoryPage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ReadTool = Tool.dynamic("memory_read", {
  description: "Read one memory item.",
  parameters: memoryInputSchema(M.MemoryReadInput),
  success: M.MemoryItem,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const HistoryTool = Tool.dynamic("memory_history", {
  description: "Read one bounded memory history page.",
  parameters: memoryInputSchema(M.MemoryHistoryInput),
  success: M.MemoryHistoryPage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const SyncStatusTool = Tool.dynamic("memory_sync_status", {
  description: "Read memory synchronization status, including disabled or unbound state.",
  parameters: memoryInputSchema(M.MemorySyncStatusInput),
  success: M.MemorySyncStatus,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const UpsertTool = Tool.dynamic("memory_upsert", {
  description:
    "Create or update memory with an explicit memory:write grant. Read-only sessions cannot write.",
  parameters: memoryInputSchema(M.MemoryUpsertInput),
  success: M.MemoryMutationReceipt,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ForgetTool = Tool.dynamic("memory_forget", {
  description: "Forget memory. Requires memory:write and a session allowed to write.",
  parameters: memoryInputSchema(M.MemoryForgetInput),
  success: M.MemoryMutationReceipt,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const RevertResolutionTool = Tool.dynamic("memory_revert_resolution", {
  description: "Revert a memory resolution within its deadline. Requires memory:write.",
  parameters: memoryInputSchema(M.MemoryRevertResolutionInput),
  success: M.MemoryRevertResult,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const ReadSourceTool = Tool.dynamic("memory_read_source", {
  description:
    "Read original evidence through its owner. Requires memory:read and independently granted orchestration:read. No arbitrary path or SSH target.",
  parameters: memoryInputSchema(M.MemoryReadSourceInput),
  success: M.MemorySourcePage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
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
