import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  EnvironmentId,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadStatusResult,
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
import * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpServer, McpSchema } from "effect/ai";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterTurnStartError,
} from "@goat/provider-core/server/ProviderAdapter";
import * as TestClock from "effect/testing/TestClock";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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
const decodeThreadStatus = Schema.decodeUnknownEffect(OrchestratorMcpThreadStatusResult);
const decodeThreadRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeTaskStatus = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);

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
        const resumeError = yield* orchestrator
          .dispatch({
            type: "queue.resume",
            commandId: CommandId.make("command:cloud-resume-queue"),
            threadId,
          })
          .pipe(Effect.flip);
        assert.isTrue(
          Cause.pretty(Cause.fail(resumeError)).includes("Fake Cloud has no follow-up"),
        );
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(resumed.runs.find((run) => run.id === queuedId)?.status, "queued");
        assert.equal(yield* Ref.get(fake.submissions), 0);
        assert.equal(resumed.checkpointScopes.length, 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect.each([
  { outcome: "succeeded", resultBeforeStop: false },
  { outcome: "cancelled", resultBeforeStop: false },
  { outcome: "unknown", resultBeforeStop: false },
  { outcome: "succeeded", resultBeforeStop: true },
  { outcome: "cancelled", resultBeforeStop: true },
] as const)(
  "cloud $outcome settlement retains parent delivery resultBeforeStop=$resultBeforeStop",
  ({ outcome, resultBeforeStop }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      const interruptEntered = yield* Deferred.make<void>();
      const acknowledge = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const observerReady = yield* Deferred.make<void>();
      const observerRelease = yield* Deferred.make<void>();
      const observerClosed = yield* Deferred.make<void>();
      const resultPersisted = yield* Deferred.make<void>();
      const releaseTerminal = yield* Deferred.make<void>();
      const lateCallbacks = yield* Ref.make(0);
      const offers: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
      const adapter = {
        ...fake.adapter,
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.gen(function* () {
            const session = yield* fake.adapter.openSession(input);
            const scope = yield* Scope.Scope;
            return {
              ...session,
              startTurn: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                session.startTurn(turn).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      // The attached observer belongs to the provider runtime, not the run.
                      yield* Deferred.await(observerRelease).pipe(
                        Effect.andThen(Ref.update(lateCallbacks, (count) => count + 1)),
                        Effect.andThen(
                          turn.commitCloudTaskMetadata!("native-session-1", {
                            title: "Disposed observer",
                          }),
                        ),
                        Effect.ensuring(Deferred.succeed(observerClosed, undefined)),
                        Effect.forkIn(scope),
                      );
                      yield* Deferred.succeed(observerReady, undefined);
                    }),
                  ),
                ),
              interruptTurn: (request: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
                Deferred.succeed(interruptEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(acknowledge)),
                  Effect.andThen(session.interruptTurn(request)),
                ),
            };
          }),
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
        Layer.provide(
          Layer.mock(LaunchWatches.LaunchWatchService)({ find: () => Effect.succeed(null) }),
        ),
        Layer.provide(
          ThreadResults.layer.pipe(
            Layer.provide(runtime),
            Layer.provide(SqlitePersistence.layerMemory),
          ),
        ),
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
        const finishing = resultBeforeStop
          ? yield* fake
              .finish(
                false,
                outcome,
                Deferred.succeed(resultPersisted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseTerminal)),
                ),
              )
              .pipe(Effect.forkChild)
          : null;
        if (finishing !== null) yield* Deferred.await(resultPersisted);
        const savedTask = (yield* orchestrator.getThreadProjection(childId)).providerThreads[0]
          ?.cloudTask;
        if (resultBeforeStop) assert.equal(savedTask?.status, outcome);
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
        const captured = (yield* Ref.get(fake.current))!;
        const terminal: ProviderAdapter.ProviderAdapterV2Event = {
          type: "turn.terminal",
          driver: fake.adapter.driver,
          providerThreadId: captured.providerThread.id,
          providerTurnId: ProviderTurnId.make(`provider-turn:fake-cloud:${captured.attemptId}`),
          runOrdinal: captured.runOrdinal,
          ...(outcome === "unknown"
            ? {
                status: "failed" as const,
                failureItemOrdinal: 101,
                failure: {
                  class: "unknown" as const,
                  message: "Observation lost",
                  code: null,
                  retryable: null,
                },
              }
            : {
                status: outcome === "cancelled" ? ("cancelled" as const) : ("completed" as const),
                failure: null,
              }),
          threadDisposition: "reusable",
        };
        if (outcome === "unknown") {
          yield* captured.commitCloudTask!({ ...savedTask!, summary: "Last observed summary" });
          yield* fake.publish(terminal);
        } else if (finishing !== null) {
          yield* Deferred.succeed(releaseTerminal, undefined);
          yield* Fiber.join(finishing);
        } else {
          yield* fake.finish(false, outcome);
        }
        yield* Deferred.await(delivered);
        yield* worker.drain();
        const finished = yield* orchestrator.getThreadProjection(childId);
        assert.equal(
          finished.runs[0]?.status,
          outcome === "unknown" ? "failed" : outcome === "cancelled" ? "cancelled" : "completed",
        );
        assert.equal(finished.providerThreads[0]?.cloudTask?.status, outcome);
        assert.equal(
          finished.messages.filter(
            (message) => message.id === `message:cloud-result:${childRun.id}`,
          ).length,
          1,
        );
        const resultBefore = finished.messages.find(
          (message) => message.id === `message:cloud-result:${childRun.id}`,
        )!;
        assert.isFalse(resultBefore.streaming);
        assert.isTrue(
          resultBefore.text.includes(
            outcome === "unknown" ? "Last observed summary" : "Completed fake task",
          ),
        );
        const metadata = {
          url: "https://example.com/tasks/refreshed",
          title: "Late title",
          progress: "Blocked after end_turn",
        };
        // This callback must wait for real ingestion cleanup, including the final full-thread write.
        yield* captured.commitCloudTaskMetadata!("native-session-1", metadata);
        const refreshed = yield* orchestrator.getThreadProjection(childId);
        const beforeProvider = finished.providerThreads[0]!;
        const afterProvider = refreshed.providerThreads[0]!;
        const { updatedAt: _beforeAt, ...beforeTask } = beforeProvider.cloudTask!;
        const { updatedAt: _afterAt, ...afterTask } = afterProvider.cloudTask!;
        assert.deepEqual(afterTask, { ...beforeTask, ...metadata });
        assert.equal(afterProvider.status, beforeProvider.status);
        assert.deepEqual(refreshed.runs, finished.runs);
        assert.deepEqual(refreshed.attempts, finished.attempts);
        assert.deepEqual(refreshed.nodes, finished.nodes);
        assert.deepEqual(refreshed.messages, finished.messages);
        assert.equal(refreshed.thread.settledAt, finished.thread.settledAt);
        const sequence = yield* sink.latestSequence();
        yield* captured.commitCloudTaskMetadata!("native-session-1", metadata);
        yield* captured.commitCloudTaskMetadata!("foreign-session", { title: "Foreign title" });
        assert.equal(yield* sink.latestSequence(), sequence);

        // Observe the manager pump's duplicate terminal, after the original run subscriber closed.
        const session = Option.getOrThrow(
          yield* (yield* ProviderSessions.ProviderSessionManagerV2).get(
            afterProvider.providerSessionId!,
          ),
        );
        const duplicateSubscription = yield* session.subscribeEvents!;
        const duplicateSeen = yield* duplicateSubscription.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* fake.publish(terminal);
        yield* Fiber.join(duplicateSeen);
        yield* duplicateSubscription.close;
        yield* worker.drain();
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(childId)).messages,
          finished.messages,
        );
        assert.equal(offers.length, 1);
        const delivery = offers[0]!.delegatedCompletion!;
        if (outcome !== "unknown") {
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
        }
        if (outcome !== "unknown") yield* orchestrator.recoverDelegatedTasks;
        assert.equal(offers.length, 1);
        const parent = yield* orchestrator.getThreadProjection(parentId);
        assert.equal(parent.subagents[0]?.completionDelivery?.state, "claimed");
        assert.equal(
          parent.runs.filter((run) => run.delegatedCompletion?.delivery != null).length,
          1,
        );
        assert.equal(
          parent.messages.filter((message) => message.delegatedCompletion !== undefined).length,
          outcome === "unknown" ? 0 : 1,
        );
        assert.equal(yield* Ref.get(fake.submissions), 1);
        const mcpServer = yield* McpServer.McpServer;
        const invoke = (name: string, arguments_: Record<string, unknown>) =>
          mcpServer
            .callTool({ name, arguments: arguments_ })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, cloudMcpClient),
            );
        const statusResult = yield* invoke("goat_thread_status", { threadId: childId });
        assert.isFalse(statusResult.isError === true, JSON.stringify(statusResult.content));
        const statusView = yield* decodeThreadStatus(statusResult.structuredContent);
        const readResult = yield* invoke("goat_thread_read", { threadId: childId });
        assert.isFalse(readResult.isError === true, JSON.stringify(readResult.content));
        const readView = yield* decodeThreadRead(readResult.structuredContent);
        const taskResult = yield* invoke("task_status", { taskId });
        assert.isFalse(taskResult.isError === true, JSON.stringify(taskResult.content));
        const taskView = yield* decodeTaskStatus(taskResult.structuredContent);
        for (const view of [statusView, readView, taskView]) {
          assert.equal(view.cloudTask?.url, metadata.url);
          assert.equal(view.cloudTask?.progress, metadata.progress);
          assert.equal(view.cloudTask?.status, outcome);
        }
        assert.isTrue(statusView.terminal);
        assert.equal(offers.length, 1);
        if (outcome !== "unknown") {
          // Hold the old observer's callback while a real follow-up claims the same native session.
          const staleReady = yield* Deferred.make<void>();
          const staleRelease = yield* Deferred.make<void>();
          const stale = yield* Deferred.succeed(staleReady, undefined).pipe(
            Effect.andThen(Deferred.await(staleRelease)),
            Effect.andThen(
              captured.commitCloudTaskMetadata!("native-session-1", {
                title: "Old observer",
                progress: "Stale activity",
              }),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(staleReady);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:metadata-followup"),
            threadId: childId,
            messageId: MessageId.make("message:metadata-followup"),
            text: "Follow up in the same session",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          const successorInput = (yield* Ref.get(fake.current))!;
          const successorAccepted = yield* sink
            .stream({ threadId: childId, eventType: "provider-turn.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.runAttemptId === successorInput.attemptId,
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkChild,
            );
          yield* Fiber.join(successorAccepted);
          assert.notEqual(successorInput.runId, captured.runId);
          const successor = yield* orchestrator.getThreadProjection(childId);
          assert.equal(successor.providerThreads[0]!.nativeThreadRef?.nativeId, "native-session-1");
          assert.equal(successor.providerThreads[0]!.cloudTask?.status, "running");
          const successorSequence = yield* sink.latestSequence();
          yield* Deferred.succeed(staleRelease, undefined);
          yield* Fiber.join(stale);
          assert.equal(yield* sink.latestSequence(), successorSequence);
          assert.deepEqual(yield* orchestrator.getThreadProjection(childId), successor);
          // Settle the successor before proving runtime disposal never reopens either run.
          yield* fake.finish();
          yield* successorInput.commitCloudTaskMetadata!("native-session-1", {});
          yield* worker.drain();
        }
        const beforeDisposal = yield* orchestrator.getThreadProjection(childId);
        // Runtime disposal interrupts the attached observer without a remote cancel or new terminal.
        yield* Deferred.await(observerReady);
        yield* (yield* ProviderSessions.ProviderSessionManagerV2).close(
          afterProvider.providerSessionId!,
        );
        yield* Deferred.await(observerClosed);
        yield* Deferred.succeed(observerRelease, undefined);
        assert.equal(yield* Ref.get(lateCallbacks), 0);
        assert.equal(yield* Ref.get(fake.cancellations), 1);
        assert.equal(yield* Ref.get(fake.detaches), 1);
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(childId)).runs,
          beforeDisposal.runs,
        );
      }).pipe(Effect.provide(mcp));
    }).pipe(Effect.scoped),
);

it.effect.each([
  { ownershipLost: false, stage: "open" },
  { ownershipLost: true, stage: "open" },
  { ownershipLost: false, stage: "resume" },
  { ownershipLost: true, stage: "resume" },
] as const)(
  "final attach $stage failure settles only its original attempt ownershipLost=$ownershipLost",
  ({ ownershipLost, stage }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      const opening = yield* Deferred.make<void>();
      const failOpen = yield* Deferred.make<void>();
      const adapter = {
        ...fake.adapter,
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.gen(function* () {
            const failure = Deferred.succeed(opening, undefined).pipe(
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
            );
            if (stage === "open") return yield* failure;
            const session = yield* fake.adapter.openSession(input);
            return { ...session, resumeTurn: () => failure };
          }),
      };
      const runtime = layerWithRegistry(
        { name: `cloud-attach-${stage}-failure-${ownershipLost}` },
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

it.effect.each([
  {
    taskStatus: "unknown",
    previousOrdinal: 0,
    recordedOrdinal: null,
    expectedOrdinal: 1,
    failure: "open",
    savedStart: true,
  },
  {
    taskStatus: "succeeded",
    previousOrdinal: 4,
    recordedOrdinal: 5,
    expectedOrdinal: 5,
    failure: "resume",
    savedStart: true,
  },
  {
    taskStatus: "succeeded",
    previousOrdinal: 4,
    recordedOrdinal: null,
    expectedOrdinal: 5,
    failure: "none",
    savedStart: true,
  },
  {
    taskStatus: "failed",
    previousOrdinal: 0,
    recordedOrdinal: null,
    expectedOrdinal: 1,
    failure: "none",
    savedStart: false,
  },
  {
    taskStatus: "cancelled",
    previousOrdinal: 0,
    recordedOrdinal: null,
    expectedOrdinal: 1,
    failure: "none",
    savedStart: true,
  },
  {
    taskStatus: "running",
    previousOrdinal: 4,
    recordedOrdinal: 2,
    expectedOrdinal: 2,
    failure: "none",
    savedStart: true,
  },
  {
    taskStatus: "running",
    previousOrdinal: 0,
    recordedOrdinal: 1,
    expectedOrdinal: 1,
    failure: "none",
    savedStart: true,
  },
] as const)(
  "recovers accepted $taskStatus task ordinal=$expectedOrdinal after $failure failure savedStart=$savedStart",
  (scenario) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      const delivered = yield* Deferred.make<void>();
      const offers: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
      const originalStart = DateTime.makeUnsafe(1_000);
      const adapterStart = DateTime.makeUnsafe(10_000);
      let opens = 0;
      let resumes = 0;
      const adapter = {
        ...fake.adapter,
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.gen(function* () {
            opens += 1;
            if (scenario.failure === "open" && opens === 1)
              return yield* new ProviderAdapterOpenSessionError({
                driver: fake.adapter.driver,
                providerSessionId: input.providerSessionId,
                cause: "Transient open failure",
              });
            const session = yield* fake.adapter.openSession(input);
            return {
              ...session,
              resumeTurn: (
                turn: Parameters<
                  NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeTurn"]>
                >[0],
              ) =>
                Effect.gen(function* () {
                  resumes += 1;
                  if (scenario.failure === "resume" && resumes === 1)
                    return yield* new ProviderAdapterTurnStartError({
                      driver: fake.adapter.driver,
                      threadId: turn.threadId,
                      providerThreadId: turn.providerThread.id,
                      runId: turn.runId,
                      cause: "Transient observer failure",
                    });
                  yield* session.resumeTurn!(turn);
                  yield* fake.publish({
                    type: "provider_turn.updated",
                    driver: fake.adapter.driver,
                    threadId: turn.threadId,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:fake-cloud:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver: fake.adapter.driver,
                        nativeId: turn.cloudTask.taskId,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: scenario.taskStatus === "unknown" ? null : adapterStart,
                      completedAt: null,
                    },
                  });
                }),
            };
          }),
      };
      const runtime = layerWithRegistry(
        { name: `cloud-recovery-regression-${scenario.taskStatus}` },
        Registry.layerFromAdapters([adapter]),
        {
          runEffectWorker: false,
          continuationRequests: Layer.succeed(
            ProviderContinuationRequests.ProviderContinuationRequests,
            {
              offer: (request) =>
                Effect.sync(() => offers.push(request)).pipe(
                  Effect.andThen(Deferred.succeed(delivered, undefined)),
                  Effect.asVoid,
                ),
              take: Effect.never,
            },
          ),
        },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const parentId = ThreadId.make("thread:recovery-parent");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:recovery-parent"),
          threadId: parentId,
          projectId: ProjectId.make("project:recovery"),
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
          commandId: CommandId.make("command:recovery-parent-run"),
          threadId: parentId,
          messageId: MessageId.make("message:recovery-parent"),
          text: "Delegate",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root", branch: "dev" } },
          createdBy: "user",
          creationSource: "web",
        });
        const parentRun = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:recovery-parent-running"),
              type: "run.updated",
              threadId: parentId,
              occurredAt: now,
              payload: { ...parentRun, status: "running", startedAt: now },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("command:recovery-delegate"),
          parentThreadId: parentId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Accepted cloud work",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
        const childId = task.childThreadId!;
        const initial = yield* orchestrator.getThreadProjection(childId);
        const run = initial.runs[0]!;
        const attempt = initial.attempts[0]!;
        const root = initial.nodes.find((node) => node.id === run.rootNodeId)!;
        const thread = initial.providerThreads[0]!;
        const cloudTask = {
          taskId: "accepted-before-restart",
          status: scenario.taskStatus,
          tracking: "live" as const,
          source: {
            repository: "https://github.com/acme/repo",
            branch: "dev",
            sha: "a".repeat(40),
          },
          url: "https://example.com/tasks/saved",
          localChangesExcluded: true,
          updatedAt: DateTime.formatIso(now),
        };
        const startedAt = scenario.savedStart ? originalStart : null;
        for (const event of [
          { type: "run.updated", payload: { ...run, status: "running", startedAt } },
          { type: "run-attempt.updated", payload: { ...attempt, status: "running", startedAt } },
          { type: "node.updated", payload: { ...root, status: "running", startedAt } },
          {
            type: "provider-thread.updated",
            payload: {
              ...thread,
              cloudTask,
              nativeThreadRef: {
                driver: fake.adapter.driver,
                nativeId: "accepted-native-session",
                strength: "strong",
              },
            },
          },
        ] as const)
          yield* sink.write({
            events: [
              {
                ...event,
                id: EventId.make(`event:recovery:${event.type}`),
                threadId: childId,
                occurredAt: now,
              },
            ],
          });
        const turnId = ProviderTurnId.make(`provider-turn:fake-cloud:${attempt.id}`);
        for (const savedTurn of [
          ...(scenario.previousOrdinal === 0
            ? []
            : [
                {
                  id: ProviderTurnId.make("turn:earlier"),
                  runAttemptId: RunAttemptId.make("attempt:earlier"),
                  ordinal: scenario.previousOrdinal,
                },
              ]),
          ...(scenario.recordedOrdinal === null
            ? []
            : [{ id: turnId, runAttemptId: attempt.id, ordinal: scenario.recordedOrdinal }]),
        ])
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:${savedTurn.id}`),
                type: "provider-turn.updated",
                threadId: childId,
                occurredAt: now,
                payload: {
                  ...savedTurn,
                  providerThreadId: thread.id,
                  nodeId: root.id,
                  nativeTurnRef: {
                    driver: fake.adapter.driver,
                    nativeId: cloudTask.taskId,
                    strength: "strong",
                  },
                  status: "running",
                  startedAt: originalStart,
                  completedAt: null,
                },
              },
            ],
          });
        const saved = yield* orchestrator.getThreadProjection(childId);
        if (scenario.recordedOrdinal === null) {
          const stop = yield* orchestrator
            .dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:recovery-stop-untracked"),
              threadId: childId,
              runId: run.id,
            })
            .pipe(Effect.exit);
          assert.equal(stop._tag, "Failure");
          assert.deepEqual(yield* orchestrator.getThreadProjection(childId), saved);
          assert.equal(yield* Ref.get(fake.cancellations), 0);
        }
        const commandId = CommandId.make("command:recovery-reattach");
        const effectId = "effect:recovery-reattach";
        const afterSequence = yield* orchestrator.getThreadEventSequence(childId);
        yield* outbox.enqueue([
          {
            id: effectId,
            commandId,
            threadId: childId,
            request: { type: "provider-turn.reattach", runId: run.id },
          },
        ]);
        // The original start effect sees the saved running run and does no work.
        yield* worker.drain();
        if (scenario.failure !== "none") {
          const retry = Option.getOrThrow(yield* outbox.get(effectId));
          assert.equal(retry.status, "pending");
          assert.equal(retry.attemptCount, 1);
          const afterFailure = yield* orchestrator.getThreadProjection(childId);
          assert.equal(afterFailure.runs[0]?.status, "running");
          assert.equal(afterFailure.attempts[0]?.status, "running");
          assert.equal(afterFailure.nodes.find((node) => node.id === root.id)?.status, "running");
          assert.deepEqual(afterFailure.providerThreads[0]?.cloudTask, cloudTask);
          assert.equal(
            afterFailure.messages.filter(
              (message) => message.id === `message:cloud-result:${run.id}`,
            ).length,
            0,
          );
          yield* TestClock.adjust("100 millis");
          yield* worker.drain();
        }
        assert.equal(Option.getOrThrow(yield* outbox.get(effectId)).status, "succeeded");
        assert.equal((yield* Ref.get(fake.current))?.providerTurnOrdinal, scenario.expectedOrdinal);
        const recovered = yield* orchestrator
          .streamStoredEventsFrom({
            threadId: childId,
            eventType: "provider-turn.updated",
            afterSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" && stored.event.payload.id === turnId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
        yield* Fiber.join(recovered);
        const attached = yield* orchestrator.getThreadProjection(childId);
        const turn = attached.providerTurns.find((candidate) => candidate.id === turnId)!;
        assert.equal(turn.ordinal, scenario.expectedOrdinal);
        assert.equal(
          DateTime.toEpochMillis(turn.startedAt!),
          DateTime.toEpochMillis(scenario.savedStart ? originalStart : adapterStart),
        );
        assert.equal(attached.runs[0]?.activeAttemptId, attempt.id);
        for (const recoveredStart of [
          attached.runs[0]!.startedAt,
          attached.attempts[0]!.startedAt,
          attached.nodes.find((node) => node.id === root.id)!.startedAt,
        ])
          assert.equal(
            recoveredStart === null ? null : DateTime.toEpochMillis(recoveredStart),
            startedAt === null ? null : DateTime.toEpochMillis(startedAt),
          );
        assert.equal(opens, scenario.failure === "open" ? 2 : 1);
        assert.equal(resumes, scenario.failure === "resume" ? 2 : 1);
        assert.equal(yield* Ref.get(fake.attachments), 1);
        assert.equal(yield* Ref.get(fake.creations), 0);
        assert.equal(yield* Ref.get(fake.submissions), 0);
        assert.equal(
          (yield* Ref.get(fake.current))?.providerThread.nativeThreadRef?.nativeId,
          "accepted-native-session",
        );
        assert.equal(
          (yield* Ref.get(fake.current))?.providerThread.cloudTask?.taskId,
          cloudTask.taskId,
        );
        yield* fake.finish();
        yield* Deferred.await(delivered);
        yield* worker.drain();
        const finished = yield* orchestrator.getThreadProjection(childId);
        assert.equal(finished.runs[0]?.status, "completed");
        assert.equal(
          finished.messages.filter((message) => message.id === `message:cloud-result:${run.id}`)
            .length,
          1,
        );
        assert.equal(offers.length, 1);
        assert.equal(
          (yield* orchestrator.getThreadProjection(parentId)).subagents[0]?.completionDelivery
            ?.state,
          "claimed",
        );
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.scoped),
);
