// The RPC session is real; the peer only serves the initial config protocol.
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerConfig,
  type ServerConfig as ServerConfigType,
  WS_METHODS,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { makeStallRelay, makeWebSocketPeer } from "../../../ssh/src/stallRelay.fixture.ts";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcSession from "./session.ts";
import { PING_TIMEOUT } from "./protocol.ts";

const environmentId = EnvironmentId.make("stalled-environment");
const SERVER_CONFIG: ServerConfigType = {
  environment: {
    environmentId,
    label: "Stalled environment",
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
    },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const decodeMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.String,
      id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      tag: Schema.optional(Schema.String),
    }),
  ),
);
const encodeConfig = Schema.encodeSync(ServerConfig);

it.effect("leaves connected after a half-open carrier exceeds the RPC silence budget", () =>
  Effect.gen(function* () {
    const peer = yield* makeWebSocketPeer((message) => {
      const request = decodeMessage(message);
      if (request._tag === "Ping") return JSON.stringify({ _tag: "Pong" });
      if (request.tag === WS_METHODS.subscribeServerConfig)
        return JSON.stringify({
          _tag: "Chunk",
          requestId: request.id,
          values: [{ version: 1, type: "snapshot", config: encodeConfig(SERVER_CONFIG) }],
        });
      return undefined;
    });
    const relay = yield* makeStallRelay(peer.port);
    const target = new PrimaryConnectionTarget({
      environmentId,
      label: "Stalled environment",
      httpBaseUrl: `http://127.0.0.1:${relay.port}/`,
      wsBaseUrl: `ws://127.0.0.1:${relay.port}/`,
    });
    const prepared: PreparedConnection = {
      environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: `${target.wsBaseUrl}ws`,
      httpAuthorization: null,
      target,
    };
    const sockets: WebSocket[] = [];
    const factory = yield* RpcSession.make().pipe(
      Effect.provideService(Socket.WebSocketConstructor, (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket;
      }),
    );
    const session = yield* factory.connect(prepared);
    yield* session.ready;
    expect(sockets[0]?.readyState).toBe(WebSocket.OPEN);
    yield* Queue.clear(relay.traffic);
    relay.setMode("stall");
    for (const socket of peer.server.clients) socket.send(JSON.stringify({ _tag: "Pong" }));
    expect(
      Option.getOrThrow(
        yield* Stream.fromQueue(relay.traffic).pipe(
          Stream.filter((item) => item.direction === "downstream" && !item.forwarded),
          Stream.runHead,
        ),
      ),
    ).toMatchObject({ direction: "downstream", forwarded: false });
    yield* TestClock.adjust("5 seconds");
    expect(
      Option.getOrThrow(
        yield* Stream.fromQueue(relay.traffic).pipe(
          Stream.filter((item) => item.direction === "upstream" && !item.forwarded),
          Stream.runHead,
        ),
      ),
    ).toMatchObject({ direction: "upstream", forwarded: false });
    expect(relay.openSockets).toBe(2);
    yield* TestClock.adjust("10 seconds");
    expect(sockets[0]?.readyState).toBe(WebSocket.OPEN);
    const disconnected = yield* session.closed.pipe(Effect.flip, Effect.forkChild);
    // The 15 s silence budget is checked on 5 s ticks and expires on the first tick beyond it.
    expect(PING_TIMEOUT).toBe("15 seconds");
    yield* TestClock.adjust("5 seconds");
    const failure = yield* Fiber.join(disconnected);
    expect(failure).toMatchObject({
      reason: "transport",
      detail: "Stalled environment stopped responding.",
    });
    expect(sockets[0]?.readyState).not.toBe(WebSocket.OPEN);
    yield* Effect.callback<void>((resume) => {
      const socket = sockets[0]!;
      socket.addEventListener("close", () => resume(Effect.void), { once: true });
      relay.setMode("reset");
    });
    expect(sockets[0]?.readyState).toBe(WebSocket.CLOSED);
    expect(sockets).toHaveLength(1);
  }).pipe(Effect.scoped),
);
