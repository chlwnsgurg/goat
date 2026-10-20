import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Socket from "effect/socket/Socket";

import {
  type OutboundBuffer,
  RELAY_HIGH_WATER_BYTES,
  RELAY_MAX_BUFFERED_BYTES,
  RelayOverflowError,
  pumpFrames,
  pumpGated,
} from "./relay.ts";

const byteLength = (chunk: Uint8Array | string | Socket.CloseEvent) =>
  typeof chunk === "string"
    ? new TextEncoder().encode(chunk).byteLength
    : chunk instanceof Uint8Array
      ? chunk.byteLength
      : 0;

/** A peer that never reads: everything written stays queued, and draining never happens. */
const stalledPeer = Effect.gen(function* () {
  const blocked = yield* Deferred.make<void>();
  let queued = 0;
  const frames: Array<Uint8Array | string> = [];
  const writer: Socket.Writer = {
    write: (chunk) =>
      Effect.sync(() => {
        queued += byteLength(chunk);
        if (typeof chunk === "string" || chunk instanceof Uint8Array) frames.push(chunk);
      }),
    writeAll: (chunks) =>
      Effect.sync(() => {
        for (const chunk of chunks) {
          queued += byteLength(chunk);
          frames.push(chunk);
        }
      }),
  };
  const buffer: OutboundBuffer = {
    length: () => queued,
    drained: Effect.suspend(() =>
      queued <= RELAY_HIGH_WATER_BYTES
        ? Effect.void
        : Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never)),
    ),
  };
  return { writer, buffer, blocked, frames, queued: () => queued };
});

const source = (pulls: number, batch: () => ReadonlyArray<string>) => {
  let pulled = 0;
  const reader: Socket.Reader = {
    pull: Effect.suspend(() => {
      if (pulled >= pulls) return Effect.never;
      pulled += 1;
      return Effect.succeed(batch() as unknown as readonly [string, ...string[]]);
    }),
    upgrade: () => Effect.void,
  };
  return { reader, pulled: () => pulled };
};

const idle: OutboundBuffer = { length: () => 0, drained: Effect.void };
const discard: Socket.Writer = { write: () => Effect.void, writeAll: () => Effect.void };

it.effect("a stalled client stops the node-to-client relay from reading more frames", () =>
  Effect.gen(function* () {
    const client = yield* stalledPeer;
    const frame = "x".repeat(64 * 1024);
    const node = source(128, () => [frame]);
    const pump = yield* Effect.forkChild(pumpFrames(node.reader, client.writer, client.buffer));
    yield* Deferred.await(client.blocked);
    // It stops at the first pull that crosses the mark, instead of queueing all 8 MiB.
    expect(node.pulled()).toBe(RELAY_HIGH_WATER_BYTES / frame.length + 1);
    expect(client.queued()).toBeLessThanOrEqual(RELAY_HIGH_WATER_BYTES + frame.length);
    yield* Fiber.interrupt(pump);
  }),
);

it.effect("a client that sends refused calls but never reads cannot grow the hub's buffer", () =>
  Effect.gen(function* () {
    const client = yield* stalledPeer;
    let id = 0;
    const refused = () =>
      Array.from({ length: 500 }, () =>
        JSON.stringify({
          _tag: "Request",
          id: String((id += 1)),
          tag: "orchestration.dispatchCommand",
          payload: { type: "thread.delete", commandId: `c${id}`, threadId: "t1" },
          headers: [],
        }),
      );
    const phone = source(128, refused);
    const forwarded: Array<unknown> = [];
    const node: Socket.Writer = {
      write: (chunk) => Effect.sync(() => void forwarded.push(chunk)),
      writeAll: (chunks) => Effect.sync(() => void forwarded.push(...chunks)),
    };
    const pump = yield* Effect.forkChild(
      pumpGated(phone.reader, node, idle, client.writer, client.buffer, [
        "orchestration:read",
        "orchestration:operate",
      ]),
    );
    yield* Deferred.await(client.blocked);
    expect(forwarded).toEqual([]);
    expect(client.frames.length).toBe(phone.pulled() * 500);
    expect(phone.pulled()).toBeLessThan(128);
    expect(client.queued()).toBeLessThanOrEqual(RELAY_HIGH_WATER_BYTES * 2);
    yield* Fiber.interrupt(pump);
  }),
);

it.effect("a relay ends once a peer leaves more than the cap queued", () =>
  Effect.gen(function* () {
    const client = yield* stalledPeer;
    const oversized = "x".repeat(RELAY_MAX_BUFFERED_BYTES + 1);
    const node = source(1, () => [oversized]);
    const error = yield* Effect.flip(pumpFrames(node.reader, client.writer, client.buffer));
    expect(error).toBeInstanceOf(RelayOverflowError);
    const refusedTo = yield* stalledPeer;
    // Refusals echo the request id, so one refused call can carry a reply past the cap.
    const hugeRefusal = JSON.stringify({
      _tag: "Request",
      id: "x".repeat(RELAY_MAX_BUFFERED_BYTES + 1),
      tag: "orchestration.dispatchCommand",
      payload: { type: "thread.delete", commandId: "c1", threadId: "t1" },
      headers: [],
    });
    const refused = yield* Effect.flip(
      pumpGated(
        source(1, () => [hugeRefusal]).reader,
        discard,
        idle,
        refusedTo.writer,
        refusedTo.buffer,
        ["orchestration:read", "orchestration:operate"],
      ),
    );
    expect(refused).toBeInstanceOf(RelayOverflowError);
  }),
);
