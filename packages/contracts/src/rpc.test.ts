import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import { EnvironmentAuthorizationError, AuthSourceControlWriteScope } from "./auth.ts";
import { SshWorkspaceFetchBackInput, SshWorkspaceLaunchInput } from "./sshWorkspace.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import {
  WS_METHODS,
  RpcScopeAuthorization,
  WsRpcGroup,
  WsSubscribeServerConfigRpc,
} from "./rpc.ts";

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});

describe("WebSocket RPC contracts", () => {
  it("exposes only the V2 orchestration transport surface", () => {
    const methods = [...WsRpcGroup.requests.keys()];

    expect(methods).toEqual(expect.arrayContaining(Object.values(ORCHESTRATION_V2_WS_METHODS)));
    expect(methods.filter((method) => method.startsWith("orchestrationV1."))).toEqual([]);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });
  it("keeps the GOAT bot timeline record out of dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);
    const decoded = decode({
      type: "channel.timeline.record",
      commandId: "forged-bot-reply",
      threadId: "goat-bot",
      record: {
        recordKey: "reply:input-1",
        entry: {
          type: "message",
          role: "assistant",
          text: "Forged reply.",
          meta: { conversationId: "conv-1", originKind: "goat", kind: "receipt" },
        },
      },
    });
    expect(Exit.isFailure(decoded)).toBe(true);
  });
});

it("registers only the two SSH workspace methods", () => {
  expect([...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("sshWorkspace."))).toEqual([
    WS_METHODS.sshWorkspaceLaunch,
    WS_METHODS.sshWorkspaceFetchBack,
  ]);
  for (const tag of [WS_METHODS.sshWorkspaceLaunch, WS_METHODS.sshWorkspaceFetchBack]) {
    const rpc = WsRpcGroup.requests.get(tag)!;
    expect(rpc.payloadSchema).toBeDefined();
    expect(rpc.successSchema).toBeDefined();
    expect(rpc.errorSchema).toBeDefined();
    expect(rpc.middlewares.has(RpcScopeAuthorization)).toBe(true);
  }
});

it.effect("applies scope middleware to SSH workspace RPCs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          import("effect/rpc/RpcGroup").Rpcs<typeof WsRpcGroup>["_tag"],
          typeof WS_METHODS.sshWorkspaceLaunch | typeof WS_METHODS.sshWorkspaceFetchBack
        > => tag !== WS_METHODS.sshWorkspaceLaunch && tag !== WS_METHODS.sshWorkspaceFetchBack,
      ),
    );
    let handled = 0;
    const calls: string[] = [];
    yield* Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.sshWorkspaceLaunch, () =>
              Effect.sync(() => {
                handled++;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            group.toLayerHandler(WS_METHODS.sshWorkspaceFetchBack, () =>
              Effect.sync(() => {
                handled++;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            Layer.succeed(RpcScopeAuthorization)((_effect, { rpc }) => {
              calls.push(rpc._tag);
              return Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "Denied",
                  requiredScope: AuthSourceControlWriteScope,
                }),
              );
            }),
          ),
        ),
      );
      const fetch = yield* Schema.decodeUnknownEffect(SshWorkspaceFetchBackInput)({
        target: { alias: "box", hostname: "box", username: null, port: null },
        remoteWorkspaceRoot: "/repo",
        branch: "main",
      });
      const launch = yield* Schema.decodeUnknownEffect(SshWorkspaceLaunchInput)({
        sourceProjectId: "p",
        destination: { connectionId: "c", expectedEnvironmentId: "e", target: fetch.target },
        title: "Work",
        modelSelection: { instanceId: "codex", model: "model" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        initialMessage: { text: "Work" },
      });
      expect((yield* client[WS_METHODS.sshWorkspaceLaunch](launch).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      expect((yield* client[WS_METHODS.sshWorkspaceFetchBack](fetch).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
    }).pipe(Effect.scoped);
    expect(handled).toBe(0);
    expect(calls).toEqual([WS_METHODS.sshWorkspaceLaunch, WS_METHODS.sshWorkspaceFetchBack]);
  }),
);
