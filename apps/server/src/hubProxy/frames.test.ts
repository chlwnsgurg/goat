import { expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  EnvironmentAuthorizationError,
  WS_METHODS,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { Rpc, RpcClient, RpcGroup, RpcMessage, RpcSerialization } from "effect/rpc";

import { gateClientFrame, hubProxyRefusal, refuseProxiedCall } from "./frames.ts";

const read = "orchestration.subscribeThread";
const write = "orchestration.dispatchCommand";
const admit = (method: string, payload: unknown) =>
  refuseProxiedCall(["orchestration:read"], method, payload);
const request = (id: string | number, tag = read) => ({
  _tag: "Request",
  id,
  tag,
  payload: {},
  headers: [],
});

it("preserves the original string and binary frame when every request is admitted", () => {
  for (const frame of [
    `  ${JSON.stringify([request(1), request("2")])}  `,
    new TextEncoder().encode(JSON.stringify(request(3))),
  ]) {
    const gated = gateClientFrame(frame, admit);
    expect(gated.forward).toBe(frame);
    expect(gated.replies).toEqual([]);
  }
});

it("refuses only the forbidden request in a mixed batch and serializes the rest", () => {
  const kept = [request(1), { _tag: "Ping" }, request("3")];
  const gated = gateClientFrame(JSON.stringify([...kept, request(2, write)]), admit);
  expect(JSON.parse(String(gated.forward))).toEqual(kept);
  expect(gated.replies.map((reply) => JSON.parse(reply))).toMatchObject([
    {
      _tag: "Exit",
      requestId: 2,
      exit: {
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { requiredScope: "orchestration:operate" } }],
      },
    },
  ]);
});

it("keeps numeric and string refusal request ids distinct", () => {
  const gated = gateClientFrame(JSON.stringify([request(7, write), request("7", write)]), admit);
  expect(gated.forward).toBeUndefined();
  expect(gated.replies.map((reply) => JSON.parse(reply).requestId)).toEqual([7, "7"]);
});

it("passes Ping, Ack, Interrupt and Eof unchanged", () => {
  const frame = JSON.stringify([
    { _tag: "Ping" },
    { _tag: "Ack", requestId: 1 },
    { _tag: "Interrupt", requestId: "2" },
    { _tag: "Eof" },
  ]);
  expect(gateClientFrame(frame, admit)).toEqual({ forward: frame, replies: [] });
});

it("drops unparseable frames and malformed request envelopes", () => {
  for (const frame of ["{", "not json", "null", JSON.stringify({ ...request(1, write), id: {} })]) {
    expect(gateClientFrame(frame, admit)).toEqual({ forward: undefined, replies: [] });
  }
});

it("admits read subscriptions and refuses dispatch with the missing operate scope", () => {
  expect(admit(read, {})).toBeUndefined();
  expect(admit(write, {})).toMatchObject({
    _tag: "EnvironmentAuthorizationError",
    requiredScope: "orchestration:operate",
  });
});

it("refuses unknown methods with hub:proxy", () => {
  expect(admit("unknown.method", {})).toMatchObject({ requiredScope: "hub:proxy" });
});

it("enforces the hub method policy even when the caller supplies settings:write", () => {
  expect(
    refuseProxiedCall(AuthStandardClientScopes, WS_METHODS.connectionCatalogServe, {}),
  ).toMatchObject({ requiredScope: "hub:proxy" });
});

it.effect(
  "decodes gate refusal JSON into typed RPC errors for two numeric ids and a string id",
  () =>
    Effect.gen(function* () {
      const group = RpcGroup.make(
        Rpc.make(write, {
          success: Schema.Void,
          error: EnvironmentAuthorizationError,
        }),
      );
      const responses = yield* Queue.unbounded<string>();
      const ids = [41, 42, "42"];
      const observed: Array<string | number> = [];
      const send = (frame: string | Uint8Array | Socket.CloseEvent) =>
        Effect.gen(function* () {
          if (Socket.isCloseEvent(frame)) return;
          const gated = gateClientFrame(frame, admit);
          for (const reply of gated.replies) {
            observed.push(JSON.parse(reply).requestId);
            yield* Queue.offer(responses, reply);
          }
        });
      const socket = Socket.make({
        reader: Effect.succeed({
          pull: Queue.take(responses).pipe(Effect.map((frame) => [frame] as const)),
          upgrade: () => Effect.void,
        }),
        writer: Effect.succeed({
          write: send,
          writeAll: (frames) => Effect.forEach(frames, send, { discard: true }),
        }),
      });
      const protocol = yield* RpcClient.makeProtocolSocket().pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerJson),
      );
      const client = yield* RpcClient.make(group, {
        generateRequestId: () => RpcMessage.RequestId(ids.shift()!),
      }).pipe(Effect.provideService(RpcClient.Protocol, protocol));
      for (let i = 0; i < 3; i++) {
        const error = yield* Effect.flip(client[write]());
        expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
        expect(error).toMatchObject({ requiredScope: "orchestration:operate" });
      }
      expect(observed).toEqual([41, 42, "42"]);
      expect(hubProxyRefusal("denied").requiredScope).toBe("hub:proxy");
    }).pipe(Effect.scoped),
);
