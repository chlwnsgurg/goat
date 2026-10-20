import type { AuthEnvironmentScope } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Socket from "effect/socket/Socket";

import { gateClientFrame, refuseProxiedCall } from "./frames.ts";

/**
 * A ws socket can hold sent frames in its compression queue as well as its TCP buffer, and
 * Effect's writer returns before either drains, so a stalled peer would let the hub queue relay
 * frames without bound. Each pump sends through ws with a completion callback and pulls again only
 * once every frame it sent has reached the socket; past this many queued bytes the relay ends.
 */
export const RELAY_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** The parts of a ws WebSocket the relay uses; `bufferedAmount` includes the compression queue. */
export interface RelayWebSocket {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array, callback: (error?: Error) => void): void;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export class RelayOverflowError extends Error {
  override readonly name = "RelayOverflowError";
}

export class RelaySendError extends Error {
  override readonly name = "RelaySendError";
}

/** Where a pump writes: sends complete only once ws has handed them to the socket. */
export interface RelaySink {
  readonly write: (frame: string | Uint8Array) => Effect.Effect<void, RelaySendError>;
  /** Waits until every frame written so far has been sent, or the socket closed. */
  readonly sent: Effect.Effect<void>;
  readonly queuedBytes: () => number;
}

export const relaySink = (ws: RelayWebSocket): RelaySink => {
  let pending = 0;
  let closed = false;
  let failure: Error | undefined;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const waiter of waiters) waiter();
  };
  const onClose = () => {
    closed = true;
    wake();
  };
  ws.once("close", onClose);
  const settled = () => pending === 0 || closed;
  return {
    write: (frame) =>
      Effect.suspend(() => {
        if (failure !== undefined) return Effect.fail(new RelaySendError(failure.message));
        if (closed) return Effect.fail(new RelaySendError("The relay socket closed."));
        pending += 1;
        try {
          ws.send(frame, (error) => {
            pending -= 1;
            if (error !== undefined && error !== null) failure ??= error;
            wake();
          });
        } catch (cause) {
          pending -= 1;
          return Effect.fail(new RelaySendError(String(cause)));
        }
        return Effect.void;
      }),
    sent: Effect.callback<void>((resume) => {
      if (settled()) return resume(Effect.void);
      const done = () => {
        if (!settled()) return;
        waiters.delete(done);
        resume(Effect.void);
      };
      waiters.add(done);
      return Effect.sync(() => {
        waiters.delete(done);
      });
    }),
    queuedBytes: () => ws.bufferedAmount,
  };
};

/**
 * The accepted client socket stays inside Effect's platform server; ws records itself on the TCP
 * socket it upgraded under a symbol named "websocket", which is the only way back to it.
 */
export const webSocketOfTransport = (transport: unknown): RelayWebSocket | undefined => {
  if (typeof transport !== "object" || transport === null) return undefined;
  const key = Object.getOwnPropertySymbols(transport).find(
    (symbol) => symbol.description === "websocket",
  );
  const ws = key === undefined ? undefined : (transport as Record<symbol, unknown>)[key];
  return isRelayWebSocket(ws) ? ws : undefined;
};

export const isRelayWebSocket = (value: unknown): value is RelayWebSocket =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { bufferedAmount?: unknown }).bufferedAmount === "number" &&
  typeof (value as { send?: unknown }).send === "function" &&
  typeof (value as { once?: unknown }).once === "function";

const withinLimit = (sinks: ReadonlyArray<RelaySink>) =>
  sinks.some((sink) => sink.queuedBytes() > RELAY_MAX_BUFFERED_BYTES)
    ? Effect.fail(new RelayOverflowError("A relay peer stopped reading."))
    : Effect.void;

const allSent = (sinks: ReadonlyArray<RelaySink>) =>
  Effect.forEach(sinks, (sink) => sink.sent, { discard: true });

/** Node to client, unchanged. */
export const pumpFrames = (source: Socket.Reader, sink: RelaySink) =>
  Effect.gen(function* () {
    while (true) {
      yield* allSent([sink]);
      for (const frame of yield* source.pull) yield* sink.write(frame);
      yield* withinLimit([sink]);
    }
  });

/** Client to node: every message is judged; refusals are answered here and never sent on. */
export const pumpGated = (
  source: Socket.Reader,
  upstream: RelaySink,
  client: RelaySink,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) =>
  Effect.gen(function* () {
    const admit = (method: string, payload: unknown) => refuseProxiedCall(scopes, method, payload);
    // Refusals go to the client, so a client that sends but never reads stalls here too.
    const sinks = [upstream, client];
    while (true) {
      yield* allSent(sinks);
      for (const frame of yield* source.pull) {
        const gated = gateClientFrame(frame, admit);
        for (const reply of gated.replies) yield* client.write(reply);
        if (gated.forward !== undefined) yield* upstream.write(gated.forward);
      }
      yield* withinLimit(sinks);
    }
  });
