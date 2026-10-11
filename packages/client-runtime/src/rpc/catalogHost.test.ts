import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  WS_METHODS,
  type ConnectionCatalogHostResponse,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "./session.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import { serveConnectionCatalog } from "./catalogHost.ts";

const makeHarness = Effect.gen(function* () {
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("primary"),
      label: "Local",
      httpBaseUrl: "http://localhost/",
      wsBaseUrl: "ws://localhost/",
    }),
    state,
    prepared,
    session: activeSession,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return { activeSession, supervisor };
});
function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("connection catalog RPC host", () => {
  it.effect(
    "processes serially, replies on the receiving session, and attaches after reconnect",
    () =>
      Effect.gen(function* () {
        const { activeSession, supervisor } = yield* makeHarness;
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const firstSessionDone = yield* Deferred.make<void>();
        const secondSessionDone = yield* Deferred.make<void>();
        const started = yield* Ref.make(0);
        const responses: Array<{ socket: string; response: ConnectionCatalogHostResponse }> = [];
        function makeSession(socket: string, requestIds: string[], done: Deferred.Deferred<void>) {
          const client = {
            [WS_METHODS.connectionCatalogServe]: () =>
              Stream.make(
                ...requestIds.map((requestId) => ({
                  requestId,
                  operation: { type: "list" as const },
                })),
              ).pipe(Stream.concat(Stream.never)),
            [WS_METHODS.connectionCatalogRespond]: (response: ConnectionCatalogHostResponse) =>
              Effect.gen(function* () {
                responses.push({ socket, response });
                if (response.requestId === requestIds.at(-1))
                  yield* Deferred.succeed(done, undefined);
              }),
          } as unknown as WsRpcProtocolClient;
          return session(client);
        }
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(makeSession("first", ["one", "two"], firstSessionDone)),
        );
        const host = yield* serveConnectionCatalog(() =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(started, (count) => count + 1);
            if (count === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return { type: "list" as const, connections: [] };
          }),
        ).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkScoped,
        );
        yield* Deferred.await(firstStarted);
        expect(yield* Ref.get(started)).toBe(1);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(firstSessionDone);
        yield* SubscriptionRef.set(activeSession, Option.none());
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(makeSession("second", ["three"], secondSessionDone)),
        );
        yield* Deferred.await(secondSessionDone);
        expect(responses.map(({ socket, response }) => [socket, response.requestId])).toEqual([
          ["first", "one"],
          ["first", "two"],
          ["second", "three"],
        ]);
        expect(yield* Ref.get(started)).toBe(3);
        yield* Fiber.interrupt(host);
      }).pipe(Effect.scoped),
  );

  it.effect("quiets an authorization refusal until the next primary session", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const refused = yield* Deferred.make<void>();
      const handled = yield* Deferred.make<void>();
      let responses = 0;
      const rejectedClient = {
        [WS_METHODS.connectionCatalogServe]: () =>
          Stream.fromEffect(Deferred.succeed(refused, undefined)).pipe(
            Stream.flatMap(() =>
              Stream.fail(
                new EnvironmentAuthorizationError({
                  message: "Desktop only",
                  requiredScope: "settings:write",
                }),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(rejectedClient)));
      const host = yield* serveConnectionCatalog(() =>
        Effect.succeed({ type: "list", connections: [] }),
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkScoped,
      );
      yield* Deferred.await(refused);
      const acceptedClient = {
        [WS_METHODS.connectionCatalogServe]: () =>
          Stream.succeed({ requestId: "accepted", operation: { type: "list" as const } }).pipe(
            Stream.concat(Stream.never),
          ),
        [WS_METHODS.connectionCatalogRespond]: () =>
          Effect.gen(function* () {
            responses++;
            yield* Deferred.succeed(handled, undefined);
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(acceptedClient)));
      yield* Deferred.await(handled);
      expect(responses).toBe(1);
      yield* Fiber.interrupt(host);
    }).pipe(Effect.scoped),
  );
});
