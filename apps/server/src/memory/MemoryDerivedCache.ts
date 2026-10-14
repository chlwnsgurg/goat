import { MEMORY_DERIVED_CACHE_MAX_BYTES, MEMORY_DERIVED_CACHE_TTL_MS } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

/** One process-wide budget for bodies retained by adapter/runtime owners. */
export class MemoryDerivedCache extends Context.Service<
  MemoryDerivedCache,
  {
    readonly retain: (input: {
      readonly bytes: number;
      /** Drops local bodies only; must not restore or send a provider turn. */
      readonly release: Effect.Effect<void>;
    }) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
    readonly usage: Effect.Effect<{ readonly bytes: number; readonly owners: number }>;
  }
>()("goat/memory/MemoryDerivedCache") {}

const make = Effect.sync(() => {
  const entries = new Map<
    symbol,
    { bytes: number; release: Effect.Effect<void>; timer: Fiber.Fiber<void, never> | undefined }
  >();
  let bytes = 0;
  // Removal precedes release, so an owner can safely unregister during cleanup.
  const remove = (id: symbol) =>
    Effect.sync(() => {
      const entry = entries.get(id);
      if (entry) {
        entries.delete(id);
        bytes -= entry.bytes;
      }
      return entry;
    });
  const discard = Effect.fnUntraced(function* (id: symbol) {
    const entry = yield* remove(id);
    if (!entry) return;
    if (entry.timer) yield* Fiber.interrupt(entry.timer);
    yield* entry.release;
  });
  const retain = Effect.fnUntraced(function* (input: {
    bytes: number;
    release: Effect.Effect<void>;
  }) {
    const scope = yield* Scope.Scope;
    const id = Symbol();
    const entry = { ...input, timer: undefined as Fiber.Fiber<void, never> | undefined };
    entries.set(id, entry);
    bytes += input.bytes;
    for (;;) {
      if (bytes <= MEMORY_DERIVED_CACHE_MAX_BYTES) break;
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      yield* discard(oldest);
    }
    if (entries.has(id)) {
      entry.timer = yield* Effect.sleep(MEMORY_DERIVED_CACHE_TTL_MS).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const expired = yield* remove(id);
            if (expired) yield* expired.release;
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(scope),
      );
    }
    const unregister = discard(id);
    yield* Scope.addFinalizer(scope, unregister);
    return unregister;
  }, Effect.uninterruptible);
  return MemoryDerivedCache.of({
    retain,
    usage: Effect.sync(() => ({ bytes, owners: entries.size })),
  });
});

export const layer = Layer.effect(MemoryDerivedCache, make);
