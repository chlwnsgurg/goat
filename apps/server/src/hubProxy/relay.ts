import type { AuthEnvironmentScope } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Socket from "effect/socket/Socket";

import { gateClientFrame, refuseProxiedCall } from "./frames.ts";

/**
 * Effect's socket writer hands frames to ws without waiting for them to leave, so a stalled peer
 * would make the hub queue replies without bound. Each pump waits for its sink's TCP buffer to fall
 * below this mark before pulling more, which also leaves the source unread so its reader pauses.
 */
export const RELAY_HIGH_WATER_BYTES = 1024 * 1024;
/** A single pull can overshoot the mark; past this the peer is not reading and the relay ends. */
export const RELAY_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** The bytes a socket has accepted but not yet sent, and when that falls back below the mark. */
export interface OutboundBuffer {
  readonly length: () => number;
  readonly drained: Effect.Effect<void>;
}

interface WritableSocket {
  readonly writableLength: number;
  once(event: "drain" | "close", listener: () => void): unknown;
  off(event: "drain" | "close", listener: () => void): unknown;
}

const isWritableSocket = (value: unknown): value is WritableSocket =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { writableLength?: unknown }).writableLength === "number" &&
  typeof (value as { once?: unknown }).once === "function";

export const outboundBuffer = (socket: unknown): OutboundBuffer | undefined => {
  if (!isWritableSocket(socket)) return undefined;
  return {
    length: () => socket.writableLength,
    drained: Effect.callback<void>((resume) => {
      if (socket.writableLength <= RELAY_HIGH_WATER_BYTES) return resume(Effect.void);
      const done = () => {
        socket.off("drain", done);
        socket.off("close", done);
        resume(Effect.void);
      };
      socket.once("drain", done);
      socket.once("close", done);
      return Effect.sync(() => {
        socket.off("drain", done);
        socket.off("close", done);
      });
    }),
  };
};

export class RelayOverflowError extends Error {
  override readonly name = "RelayOverflowError";
}

const withinLimit = (buffers: ReadonlyArray<OutboundBuffer>) =>
  buffers.some((buffer) => buffer.length() > RELAY_MAX_BUFFERED_BYTES)
    ? Effect.fail(new RelayOverflowError("A relay peer stopped reading."))
    : Effect.void;

const drained = (buffers: ReadonlyArray<OutboundBuffer>) =>
  Effect.forEach(buffers, (buffer) => buffer.drained, { discard: true });

/** Node to client, unchanged. */
export const pumpFrames = (
  source: Socket.Reader,
  sink: Socket.Writer,
  sinkBuffer: OutboundBuffer,
) =>
  Effect.gen(function* () {
    while (true) {
      yield* drained([sinkBuffer]);
      yield* sink.writeAll(yield* source.pull);
      yield* withinLimit([sinkBuffer]);
    }
  });

/** Client to node: every message is judged; refusals are answered here and never sent on. */
export const pumpGated = (
  source: Socket.Reader,
  upstreamSink: Socket.Writer,
  upstreamBuffer: OutboundBuffer,
  clientSink: Socket.Writer,
  clientBuffer: OutboundBuffer,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) =>
  Effect.gen(function* () {
    const admit = (method: string, payload: unknown) => refuseProxiedCall(scopes, method, payload);
    const buffers = [upstreamBuffer, clientBuffer];
    while (true) {
      // Refusals are written to the client, so a client that sends but never reads stalls here too.
      yield* drained(buffers);
      for (const frame of yield* source.pull) {
        const gated = gateClientFrame(frame, admit);
        for (const reply of gated.replies) yield* clientSink.write(reply);
        if (gated.forward !== undefined) yield* upstreamSink.write(gated.forward);
      }
      yield* withinLimit(buffers);
    }
  });
