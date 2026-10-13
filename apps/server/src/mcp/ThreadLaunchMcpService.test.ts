import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type Project,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ThreadLaunchMcp from "./ThreadLaunchMcpService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CloudSource from "../orchestration-v2/CloudTaskSourceService.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Reports from "../remoteReports/RemoteReportService.ts";
import * as Watches from "./LaunchWatchService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { newLaunchWatch } from "./launchWatch.ts";
import { fakeCloudCapabilities } from "../orchestration-v2/testkit/FakeCloudAdapter.ts";

const projectId = ProjectId.make("project:cloud-launch");
const instanceId = ProviderInstanceId.make("fakeCloud");
const modelSelection = { instanceId, model: "fake" };
const callerId = ThreadId.make("thread:cloud-caller");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("env:cloud-launch"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "cloud-launch-ci",
  client: undefined,
  thread: { threadId: callerId, providerSessionId: "ps:caller", providerInstanceId: instanceId },
};
const caller = {
  id: callerId,
  projectId,
  modelSelection,
  providerInstanceId: instanceId,
  title: "Parent",
  activeRunId: "run:parent",
  runtimeMode: "full-access",
  interactionMode: "default",
  archivedAt: null,
  deletedAt: null,
} as OrchestrationV2ThreadShell;

function fixture(unpublished = false) {
  const launched: ThreadLaunch.ThreadLaunchInput[] = [];
  const sources: Parameters<CloudSource.CloudTaskSourceService["Service"]["resolve"]>[0][] = [];
  let routes = 0;
  const deps = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(),
    ServerConfig.layerTest("/repo", { prefix: "goat-cloud-launch-ci-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(caller),
    }),
    Layer.mock(Adapters.ProviderAdapterRegistryV2)({
      get: () =>
        Effect.succeed({
          instanceId,
          driver: ProviderDriverKind.make("fakeCloud"),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("Launch admission does not open a provider session."),
          getCapabilities: () => Effect.succeed(fakeCloudCapabilities()),
        }),
    }),
    Layer.mock(CloudSource.CloudTaskSourceService)({
      resolve: (input) => {
        sources.push(input);
        return unpublished
          ? Effect.fail(new CloudSource.CloudTaskSourceError({ reason: "unpublished" }))
          : Effect.succeed({
              source: {
                repository: "https://github.com/acme/repo",
                branch: "dev",
                sha: "a".repeat(40),
              },
              localChangesExcluded: false,
              launchSource: { cwd: input.cwd, restriction: input.restriction ?? "published-ref" },
            });
      },
    }),
    Layer.mock(Projects.ProjectService)({
      getById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            workspaceRoot: "/repo",
            defaultModelSelection: modelSelection,
          } as Project),
        ),
    }),
    Layer.mock(Folders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
    Layer.mock(Git.GitVcsDriver)({}),
    Layer.mock(Reports.RemoteReportService)({}),
    Layer.mock(Watches.LaunchWatchService)({
      resolveRoute: () =>
        Effect.sync(() => {
          routes += 1;
          return { notifyWebhook: false, webhookTarget: null };
        }),
      register: (input) =>
        Effect.succeed(
          newLaunchWatch({
            ...input,
            host: input.host ?? null,
            incarnation: "cloud-launch-test",
            notifyWebhook: input.notifyWebhook ?? false,
            now: 0,
          }),
        ),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.die("Cloud must bypass local branch collision checks"),
      launch: (input) =>
        Effect.sync(() => {
          launched.push(input);
          return {
            threadId: input.threadId,
            resumed: false,
            projection: {
              thread: { id: input.threadId, projectId, title: input.title, modelSelection },
              runs: [
                {
                  id: "run:cloud-launched",
                  userMessageId: input.initialMessage?.messageId,
                  status: "starting",
                },
              ],
            },
          } as unknown as ThreadLaunch.ThreadLaunchResult;
        }),
    }),
  );
  return {
    layer: ThreadLaunchMcp.layer.pipe(Layer.provide(deps)),
    launched,
    sources,
    routes: () => routes,
  };
}

it.effect(
  "cloud launch resolves the published input before local output worktree validation",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
      yield* service.launch(
        scope,
        {
          title: "Cloud",
          message: "Inspect",
          standingInstructions: false,
          workspaceStrategy: { type: "worktree", baseRef: "dev", branch: "existing-local-branch" },
        },
        { runtimeMode: "full-access", interactionMode: "default" },
      );
      expect(f.sources).toEqual([{ cwd: "/repo", branch: "dev", restriction: "published-ref" }]);
      expect(f.launched).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("unpublished cloud input refuses before thread creation or watch route binding", () => {
  const f = fixture(true);
  return Effect.gen(function* () {
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
    const error = yield* service
      .launch(
        scope,
        {
          title: "Cloud",
          message: "Inspect",
          standingInstructions: false,
          notifyTarget: { name: "ci-only" },
        },
        { runtimeMode: "full-access", interactionMode: "default" },
      )
      .pipe(Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toBe("Push this branch before starting a cloud task.");
    expect(f.launched).toHaveLength(0);
    expect(f.routes()).toBe(0);
  }).pipe(Effect.provide(f.layer));
});
it.effect("explicit cloud scratch rejects before a Scratch folder or thread can be created", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
    const error = yield* service
      .launch(
        scope,
        { title: "Cloud", scratch: true, modelSelection },
        { runtimeMode: "full-access", interactionMode: "default" },
      )
      .pipe(Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(f.sources).toHaveLength(0);
    expect(f.launched).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});
