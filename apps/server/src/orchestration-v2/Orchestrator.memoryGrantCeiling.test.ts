import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ScheduledTaskId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { runMemoryPrepareInput } from "./RunExecutionService.ts";
import { withCreationProvenance } from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process before L2 consumption"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const databaseLayer = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "memory-ceiling" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer, runEffectWorker: false },
  ),
);

it.effect(
  "persists local delegation ceilings through commands, events and child run preparation",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      for (const ceiling of ["read_write", "read", "none", undefined] as const) {
        const suffix = ceiling ?? "legacy";
        const threadId = ThreadId.make(`parent:${suffix}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${suffix}`),
          threadId,
          projectId: ProjectId.make("project:memory-ceiling"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`message:${suffix}`),
          threadId,
          messageId: MessageId.make(`message:${suffix}`),
          text: "Parent work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const parent = yield* store.getThreadProjection(threadId);
        const run = parent.runs[0]!;
        expect(runMemoryPrepareInput({ run, message: parent.messages[0]! })).toEqual({
          memoryGrantCeiling: null,
        });
        const command = {
          type: "delegated_task.request" as const,
          commandId: CommandId.make(`delegate:${suffix}`),
          parentThreadId: threadId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Child work",
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
          ...(ceiling === undefined ? {} : { memoryGrantCeiling: ceiling }),
        };
        yield* orchestrator.dispatch(command);
        const updated = yield* store.getThreadProjection(threadId);
        const task = updated.subagents[0]!;
        expect(task.memoryGrantCeiling).toBe(ceiling ?? "none");
        const child = yield* store.getThreadProjection(task.childThreadId!);
        expect(child.runs[0]!.memoryGrantCeiling).toBe(ceiling ?? "none");
        expect(runMemoryPrepareInput({ run: child.runs[0]!, message: child.messages[0]! })).toEqual(
          { memoryGrantCeiling: ceiling ?? "none" },
        );
        const scheduledMessage = MessageId.make(`scheduled:${suffix}`);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`scheduled:${suffix}`),
          threadId,
          messageId: scheduledMessage,
          scheduledTaskId: ScheduledTaskId.make(`scheduled-task:${suffix}`),
          memoryGrantCeiling: ceiling ?? "none",
          text: "Bound task",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const bound = yield* store.getThreadProjection(threadId);
        const boundRun = bound.runs.find((run) => run.userMessageId === scheduledMessage)!;
        const boundMessage = bound.messages.find((message) => message.id === scheduledMessage)!;
        expect(runMemoryPrepareInput({ run: boundRun, message: boundMessage })).toEqual({
          memoryGrantCeiling: ceiling ?? "none",
        });
        expect(
          withCreationProvenance(
            { ...command, memoryGrantCeiling: "read_write" },
            { createdBy: "user", creationSource: "web" },
          ),
        ).toMatchObject({ memoryGrantCeiling: "none" });
      }
    }).pipe(Effect.provide(layer)),
);
