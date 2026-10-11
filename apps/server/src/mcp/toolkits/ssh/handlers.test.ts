import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import { newLaunchWatch } from "../../launchWatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as SshHandlers from "./handlers.ts";
import { SshToolkit } from "./tools.ts";

type Registration = Parameters<LaunchWatchService.LaunchWatchServiceShape["register"]>[0];

const launchFromThread = (
  options: {
    readonly notifyOnCompletion?: boolean;
    readonly registerError?: LaunchWatchService.LaunchWatchStoreError;
  } = {},
) =>
  Effect.gen(function* () {
    const callerThreadId = ThreadId.make("caller");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: callerThreadId,
      projectId: ProjectId.make("caller-project"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const registrations: Array<Registration> = [];
    const remoteResult: SshRemoteDispatch.SshLaunchResult = {
      host: "box",
      cwd: "/remote/project",
      projectId: "remote-project",
      projectCreated: false,
      threadId: "remote-thread",
      runId: "remote-run",
      workspaceStrategy: { type: "root" },
      runtimeMode: "full-access",
      remoteServerKind: "external",
      notes: ["Remote launch succeeded."],
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: callerThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        launchThread: (_input, beforeLaunch) => beforeLaunch.pipe(Effect.as(remoteResult)),
      }),
      Layer.mock(LaunchWatchService.LaunchWatchService)({
        register: (input) =>
          Effect.gen(function* () {
            registrations.push(input);
            if (options.registerError !== undefined) return yield* options.registerError;
            return newLaunchWatch({
              ...input,
              host: input.host ?? null,
              incarnation: "ssh-watch",
              now: 0,
            });
          }),
      }),
    );
    const toolkit = yield* SshToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SshHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const responses = yield* toolkit
      .handle("goat_ssh_thread_launch", {
        host: "box",
        cwd: "/remote/project",
        title: "Audit",
        message: "Review the change",
        ...(options.notifyOnCompletion === undefined
          ? {}
          : { notifyOnCompletion: options.notifyOnCompletion }),
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return { result: responses.at(-1)?.result, registrations, callerThreadId, remoteResult };
  });

it.effect("watches the remote run for its calling thread and explains how to stop reports", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread();
    expect(launched.registrations).toEqual([
      {
        launcherThreadId: launched.callerThreadId,
        host: "box",
        threadId: "remote-thread",
        runId: "remote-run",
        projectId: null,
        title: "Audit",
      },
    ]);
    expect(launched.result).toMatchObject({
      ...launched.remoteResult,
      watching: true,
      notes: expect.arrayContaining([expect.stringContaining("goat_thread_unwatch")]),
    });
  }),
);

it.effect("launches without registering a watch when completion notifications are disabled", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({ notifyOnCompletion: false });
    expect(launched.registrations).toEqual([]);
    expect(launched.result).toEqual({ ...launched.remoteResult, watching: false });
  }),
);

it.effect("returns the successful remote launch even when its watch cannot be saved", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      registerError: new LaunchWatchService.LaunchWatchStoreError({ message: "Disk full" }),
    });
    expect(launched.registrations).toHaveLength(1);
    expect(launched.result).toEqual({ ...launched.remoteResult, watching: false });
  }),
);
