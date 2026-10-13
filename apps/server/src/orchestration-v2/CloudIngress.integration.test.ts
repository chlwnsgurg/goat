import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  EnvironmentId,
  OrchestratorMcpTaskCancelResult,
  type Project,
  type OrchestrationV2Command,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpServer, McpSchema } from "effect/ai";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { ProviderAdapterOpenSessionError } from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as EffectWorker from "./EffectWorker.ts";
import * as CloudSource from "./CloudTaskSourceService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as RemoteDispatch from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as LaunchWatches from "../mcp/LaunchWatchService.ts";
import * as ThreadResults from "../threadResults/ThreadResultService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { makeFakeCloudAdapter } from "./testkit/FakeCloudAdapter.ts";

const cloudMcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "cloud-ingress-ci", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cloud-ingress-ci", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const decodeTaskCancelResult = Schema.decodeUnknownSync(OrchestratorMcpTaskCancelResult);

it.effect(
  "serializes cloud direct, queued and MCP admission before durable second messages exist",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeCloudAdapter(false);
      // Reuse an enabled test slot; the registered adapter is still the test fakeCloud driver.
      // No provider session opens because the first run is explicitly deferred.
      const instanceId = ProviderInstanceId.make("codex");
      const adapter = { ...fake.adapter, instanceId };
      const layer = layerWithRegistry(
        { name: "cloud-ingress" },
        Registry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:cloud-ingress");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:cloud-create"),
          threadId,
          projectId: ProjectId.make("project:cloud-ingress"),
          title: "Cloud task",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "dev",
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:cloud-first"),
          threadId,
          messageId: MessageId.make("message:cloud-first"),
          text: "First cloud task",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root", branch: "dev" } },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(before.runs.length, 1);
        assert.equal(before.checkpointScopes.length, 0);
        assert.isTrue(before.nodes.every((node) => node.checkpointScopeId === null));
        const calls: ReadonlyArray<
          Pick<
            Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
            "dispatchMode" | "createdBy" | "creationSource"
          >
        > = [
          { dispatchMode: { type: "start_immediately" }, createdBy: "user", creationSource: "web" },
          {
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          },
          {
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "mcp",
          },
          {
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "mcp",
          },
        ];
        for (const [index, call] of calls.entries()) {
          const error = yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`command:cloud-second:${index}`),
              threadId,
              messageId: MessageId.make(`message:cloud-second:${index}`),
              text: "Must not submit",
              attachments: [],
              ...call,
            })
            .pipe(Effect.flip);
          assert.isTrue(Cause.pretty(Cause.fail(error)).includes("Fake Cloud has no follow-up"));
        }
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.length, 1);
        assert.equal(after.messages.length, before.messages.length);
        assert.equal(yield* Ref.get(fake.submissions), 0);
        // Round-trip the provider-thread payload through the real SQLite projection.
        const thread = after.providerThreads[0]!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:cloud-task-roundtrip"),
              type: "provider-thread.updated",
              threadId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                ...thread,
                cloudTask: {
                  taskId: "remote-1",
                  status: "running",
                  tracking: "polled",
                  source: {
                    repository: "https://github.com/acme/repo",
                    branch: "dev",
                    sha: "a".repeat(40),
                  },
                  localChangesExcluded: true,
                  updatedAt: DateTime.formatIso(now),
                },
              },
            },
          ],
        });
        const reconnect = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(reconnect.providerThreads[0]?.cloudTask?.taskId, "remote-1");
        assert.equal(reconnect.providerThreads[0]?.cloudTask?.source.branch, "dev");
        assert.isTrue(reconnect.providerThreads[0]?.cloudTask?.localChangesExcluded);
        // Older queued state must not bypass the new one-shot guard on promote or resume.
        const original = reconnect.runs[0]!;
        const originalNode = reconnect.nodes.find((node) => node.id === original.rootNodeId)!;
        const originalAttempt = reconnect.attempts.find(
          (attempt) => attempt.id === original.activeAttemptId,
        )!;
        const originalMessage = reconnect.messages.find(
          (message) => message.id === original.userMessageId,
        )!;
        const queuedId = RunId.make("run:legacy-cloud-queue");
        const queuedNodeId = NodeId.make("node:legacy-cloud-queue");
        const queuedAttemptId = RunAttemptId.make("attempt:legacy-cloud-queue");
        const queuedMessageId = MessageId.make("message:legacy-cloud-queue");
        const queued = {
          ...original,
          id: queuedId,
          ordinal: original.ordinal + 1,
          userMessageId: queuedMessageId,
          rootNodeId: queuedNodeId,
          activeAttemptId: queuedAttemptId,
          status: "queued" as const,
          queueHeld: true,
          queuePosition: 1,
          startedAt: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:legacy-cloud-run"),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: queued,
            },
            {
              id: EventId.make("event:legacy-cloud-node"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...originalNode,
                id: queuedNodeId,
                rootNodeId: queuedNodeId,
                runId: queuedId,
                status: "pending",
                startedAt: null,
              },
            },
            {
              id: EventId.make("event:legacy-cloud-attempt"),
              type: "run-attempt.created",
              threadId,
              occurredAt: now,
              payload: {
                ...originalAttempt,
                id: queuedAttemptId,
                runId: queuedId,
                rootNodeId: queuedNodeId,
                status: "pending",
                startedAt: null,
              },
            },
            {
              id: EventId.make("event:legacy-cloud-message"),
              type: "message.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...originalMessage,
                id: queuedMessageId,
                runId: queuedId,
                nodeId: queuedNodeId,
                text: "Cannot follow up",
              },
            },
          ],
        });
        const promoteError = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("command:cloud-promote"),
            threadId,
            queuedRunId: queuedId,
            targetRunId: original.id,
          })
          .pipe(Effect.flip);
        assert.isTrue(
          Cause.pretty(Cause.fail(promoteError)).includes("Fake Cloud has no follow-up"),
        );
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:cloud-first-completed"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...original, status: "completed", startedAt: now, completedAt: now },
            },
            {
              id: EventId.make("event:cloud-first-node-completed"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: { ...originalNode, status: "completed", completedAt: now },
            },
            {
              id: EventId.make("event:cloud-first-attempt-completed"),
              type: "run-attempt.updated",
              threadId,
              occurredAt: now,
              payload: { ...originalAttempt, status: "completed", completedAt: now },
            },
          ],
        });
        yield* Effect.result(
          orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make("command:cloud-resume-queue"),
            threadId,
          }),
        );
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(resumed.runs.find((run) => run.id === queuedId)?.status, "queued");
        assert.equal(yield* Ref.get(fake.submissions), 0);
        assert.equal(resumed.checkpointScopes.length, 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect.each(["succeeded", "cancelled"] as const)(
  "task_cancel retains parent delivery until authoritative %s",
  (outcome) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      const interruptEntered = yield* Deferred.make<void>();
      const acknowledge = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const offers: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
      const adapter = {
        ...fake.adapter,
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          fake.adapter.openSession(input).pipe(
            Effect.map((session) => ({
              ...session,
              interruptTurn: (request: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
                Deferred.succeed(interruptEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(acknowledge)),
                  Effect.andThen(session.interruptTurn(request)),
                ),
            })),
          ),
      };
      const registry = Registry.layerFromAdapters([adapter]);
      const projectId = ProjectId.make("project:cloud-cancel");
      const projects = Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              workspaceRoot: "/repo",
              defaultModelSelection: { instanceId, model: "fake" },
            } as Project),
          ),
      });
      const runtime = layerWithRegistry({ name: `cloud-cancel-${outcome}` }, registry, {
        runEffectWorker: false,
        projects,
        cloudSources: Layer.succeed(CloudSource.CloudTaskSourceService, {
          resolve: (input) =>
            Effect.succeed({
              source: { repository: "https://github.com/acme/repo", branch: "dev" },
              launchSource: { cwd: input.cwd, restriction: "published-ref" },
              localChangesExcluded: true,
            }),
        }),
        continuationRequests: Layer.succeed(
          ProviderContinuationRequests.ProviderContinuationRequests,
          {
            offer: (request) =>
              Effect.sync(() => {
                offers.push(request);
              }).pipe(Effect.andThen(Deferred.succeed(delivered, undefined)), Effect.asVoid),
            take: Effect.never,
          },
        ),
      });
      const mcp = McpHttpServer.layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(runtime),
        Layer.provide(registry),
        Layer.provide(projects),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        ),
        Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(Secrets.SecretRequests)({})),
        Layer.provide(Layer.mock(RemoteDispatch.RemoteDispatchCoordinator)({})),
        Layer.provide(Layer.mock(SshDispatch.SshRemoteDispatch)({})),
        Layer.provide(Layer.mock(LaunchWatches.LaunchWatchService)({})),
        Layer.provide(Layer.mock(ThreadResults.ThreadResultService)({})),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const parentId = ThreadId.make("thread:cloud-cancel-parent");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:cancel-parent"),
          threadId: parentId,
          projectId,
          title: "Parent",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "dev",
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:cancel-parent-run"),
          threadId: parentId,
          messageId: MessageId.make("message:cancel-parent"),
          text: "Delegate",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root", branch: "dev" } },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* orchestrator.getThreadProjection(parentId);
        const parentRun = before.runs[0]!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:parent-running"),
              type: "run.updated",
              threadId: parentId,
              occurredAt: now,
              payload: { ...parentRun, status: "running", startedAt: now },
            },
          ],
        });
        const delegation = yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("command:cloud-child"),
          parentThreadId: parentId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Cloud work",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const taskEvent = delegation.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        assert.equal(taskEvent?.event.type, "subagent.updated");
        if (taskEvent?.event.type !== "subagent.updated") return;
        const taskId = taskEvent.event.payload.id;
        const childId = taskEvent.event.payload.childThreadId!;
        const accepted = yield* orchestrator
          .streamStoredEventsFrom({ threadId: childId, eventType: "provider-turn.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
        yield* worker.drain();
        yield* Fiber.join(accepted);
        const childBeforeStop = yield* orchestrator.getThreadProjection(childId);
        const childRun = childBeforeStop.runs[0]!;
        const savedTask = childBeforeStop.providerThreads[0]?.cloudTask;
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make("env:cloud-cancel"),
          requestNamespace: `cloud-cancel-${outcome}`,
          thread: {
            threadId: parentId,
            providerSessionId: "ps:parent",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        };
        const result = yield* (yield* McpServer.McpServer)
          .callTool({ name: "task_cancel", arguments: { taskId, clientRequestId: "stop-child" } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, cloudMcpClient),
          );
        assert.isFalse(result.isError === true);
        assert.equal(decodeTaskCancelResult(result.structuredContent).status, "cancel_requested");
        const draining = yield* worker.drain().pipe(Effect.forkChild);
        yield* Deferred.await(interruptEntered);
        assert.equal(
          (yield* orchestrator.getThreadProjection(parentId)).subagents[0]?.completionDelivery
            ?.state,
          "pending",
        );
        yield* Deferred.succeed(acknowledge, undefined);
        yield* Fiber.join(draining);
        const acknowledged = yield* orchestrator.getThreadProjection(childId);
        assert.equal(acknowledged.runs[0]?.status, "running");
        assert.equal(acknowledged.attempts[0]?.status, "running");
        assert.deepEqual(acknowledged.providerThreads[0]?.cloudTask, savedTask);
        assert.equal(yield* Ref.get(fake.cancellations), 1);
        yield* fake.finish(false, outcome);
        yield* Deferred.await(delivered);
        const finished = yield* orchestrator.getThreadProjection(childId);
        assert.equal(finished.runs[0]?.status, outcome === "cancelled" ? "cancelled" : "completed");
        assert.equal(finished.providerThreads[0]?.cloudTask?.status, outcome);
        assert.equal(
          finished.messages.filter(
            (message) => message.id === `message:cloud-result:${childRun.id}`,
          ).length,
          1,
        );
        const delivery = offers[0]!.delegatedCompletion!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:deliver-cloud-result"),
          threadId: parentId,
          messageId: delivery.messageId,
          text: "The delegated cloud task has returned its result.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: delivery.parentRunId,
            generation: delivery.generation,
            taskIds: [taskId],
          },
        });
        yield* orchestrator.recoverDelegatedTasks;
        assert.equal(offers.length, 1);
        const parent = yield* orchestrator.getThreadProjection(parentId);
        assert.equal(parent.subagents[0]?.completionDelivery?.state, "claimed");
        assert.equal(
          parent.runs.filter((run) => run.delegatedCompletion?.delivery != null).length,
          1,
        );
        assert.equal(
          parent.messages.filter((message) => message.delegatedCompletion !== undefined).length,
          1,
        );
        assert.equal(yield* Ref.get(fake.submissions), 1);
      }).pipe(Effect.provide(mcp));
    }).pipe(Effect.scoped),
);

it.effect.each([false, true])(
  "final attach open failure settles only its original attempt ownershipLost=%s",
  (ownershipLost) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      const opening = yield* Deferred.make<void>();
      const failOpen = yield* Deferred.make<void>();
      const adapter = {
        ...fake.adapter,
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Deferred.succeed(opening, undefined).pipe(
            Effect.andThen(Deferred.await(failOpen)),
            Effect.andThen(
              Effect.fail(
                new ProviderAdapterOpenSessionError({
                  driver: fake.adapter.driver,
                  providerSessionId: input.providerSessionId,
                  cause: "Tracking transport unavailable",
                }),
              ),
            ),
          ),
      };
      const runtime = layerWithRegistry(
        { name: `cloud-attach-open-failure-${ownershipLost}` },
        Registry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:cloud-open-failure");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:open-failure-thread"),
          threadId,
          projectId: ProjectId.make("project:open-failure"),
          title: "Recover cloud task",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "deleted-local-branch",
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:open-failure-run"),
          threadId,
          messageId: MessageId.make("message:open-failure"),
          text: "Original prompt",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
          createdBy: "user",
          creationSource: "web",
        });
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const run = initial.runs[0]!;
        const attempt = initial.attempts[0]!;
        const root = initial.nodes.find((node) => node.id === run.rootNodeId)!;
        const providerThread = initial.providerThreads[0]!;
        const now = yield* DateTime.now;
        const task = {
          taskId: "accepted-before-restart",
          status: "running" as const,
          tracking: "live" as const,
          url: "https://example.com/tasks/saved",
          source: {
            repository: "https://github.com/acme/repo",
            branch: "dev",
            sha: "a".repeat(40),
          },
          localChangesExcluded: true,
          updatedAt: DateTime.formatIso(now),
        };
        const savedThread = {
          ...providerThread,
          cloudTask: task,
          nativeThreadRef: {
            driver: fake.adapter.driver,
            nativeId: "accepted-native-session",
            strength: "strong" as const,
          },
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:open-failure-run"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...run, status: "running", startedAt: now },
            },
            {
              id: EventId.make("event:open-failure-attempt"),
              type: "run-attempt.updated",
              threadId,
              occurredAt: now,
              payload: { ...attempt, status: "running", startedAt: now },
            },
            {
              id: EventId.make("event:open-failure-node"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: { ...root, status: "running", startedAt: now },
            },
            {
              id: EventId.make("event:open-failure-task"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: savedThread,
            },
          ],
        });
        const starting = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
          .start({
            threadId,
            runId: run.id,
            reattach: true,
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(opening);
        const newerAttemptId = RunAttemptId.make("attempt:newer-cloud-owner");
        if (ownershipLost)
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:newer-cloud-attempt"),
                type: "run-attempt.created",
                threadId,
                occurredAt: now,
                payload: { ...attempt, id: newerAttemptId, attemptOrdinal: 2, status: "running" },
              },
              {
                id: EventId.make("event:newer-cloud-owner"),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...run,
                  status: "running",
                  activeAttemptId: newerAttemptId,
                  startedAt: now,
                },
              },
            ],
          });
        yield* Deferred.succeed(failOpen, undefined);
        assert.equal((yield* Fiber.join(starting))._tag, "Failure");
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs[0]?.status, ownershipLost ? "running" : "failed");
        assert.equal(
          after.providerThreads[0]?.cloudTask?.status,
          ownershipLost ? "running" : "unknown",
        );
        assert.deepEqual(after.providerThreads[0]?.nativeThreadRef, savedThread.nativeThreadRef);
        assert.deepEqual(after.providerThreads[0]?.cloudTask?.source, task.source);
        assert.equal(after.providerThreads[0]?.cloudTask?.url, task.url);
        if (ownershipLost) {
          assert.equal(after.runs[0]?.activeAttemptId, newerAttemptId);
          assert.equal(
            after.messages.filter((message) => message.id === `message:cloud-result:${run.id}`)
              .length,
            0,
          );
        } else {
          assert.equal(after.attempts[0]?.status, "failed");
          assert.equal(after.nodes.find((node) => node.id === root.id)?.status, "failed");
          assert.isTrue(
            after.providerThreads[0]?.cloudTask?.error?.includes("remote work may continue"),
          );
          assert.isTrue(after.messages.some((message) => message.text.includes(task.url)));
        }
        assert.equal(yield* Ref.get(fake.submissions), 0);
        assert.equal(yield* Ref.get(fake.creations), 0);
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.scoped),
);
