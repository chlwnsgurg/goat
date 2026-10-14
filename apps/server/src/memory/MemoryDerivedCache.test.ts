import { assert, it } from "@effect/vitest";
import { MEMORY_DERIVED_CACHE_MAX_BYTES, MEMORY_DERIVED_CACHE_TTL_MS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Cache from "./MemoryDerivedCache.ts";

it.effect("evicts the oldest bodies across runtime scopes at the aggregate limit", () =>
  Effect.gen(function* () {
    const cache = yield* Cache.MemoryDerivedCache;
    const dropped: string[] = [];
    const retain = (owner: string, bytes: number) =>
      Effect.scoped(
        cache.retain({
          bytes,
          release: Effect.sync(() => {
            dropped.push(owner);
          }),
        }),
      );
    // Distinct session scopes share the same server service.
    const a = yield* Scope.make();
    const b = yield* Scope.make();
    const c = yield* Scope.make();
    const _registration0 = yield* cache
      .retain({
        bytes: 16 * 1024 * 1024,
        release: Effect.sync(() => {
          dropped.push("a");
        }),
      })
      .pipe(Effect.provideService(Scope.Scope, a));
    const _registration1 = yield* cache
      .retain({
        bytes: 16 * 1024 * 1024,
        release: Effect.sync(() => {
          dropped.push("b");
        }),
      })
      .pipe(Effect.provideService(Scope.Scope, b));
    assert.deepEqual(dropped, []);
    const _registration2 = yield* cache
      .retain({
        bytes: 1,
        release: Effect.sync(() => {
          dropped.push("c");
        }),
      })
      .pipe(Effect.provideService(Scope.Scope, c));
    assert.deepEqual(dropped, ["a"]);
    assert.deepEqual(yield* cache.usage, { bytes: 16 * 1024 * 1024 + 1, owners: 2 });
    yield* Scope.close(b, Exit.void);
    assert.deepEqual(yield* cache.usage, { bytes: 1, owners: 1 });
    yield* Scope.close(a, Exit.void);
    yield* Scope.close(c, Exit.void);
    const _oversize = yield* retain("oversize", MEMORY_DERIVED_CACHE_MAX_BYTES + 1);
    assert.deepEqual(yield* cache.usage, { bytes: 0, owners: 0 });
    assert.deepEqual(dropped, ["a", "b", "c", "oversize"]);
  }).pipe(Effect.provide(Cache.layer)),
);

it.effect("expires an idle body without another turn and unregisters stopped owners", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cache = yield* Cache.MemoryDerivedCache;
      const expired = yield* Deferred.make<void>();
      const unregister = yield* cache.retain({
        bytes: 23,
        release: Deferred.succeed(expired, undefined).pipe(Effect.asVoid),
      });
      yield* TestClock.adjust(MEMORY_DERIVED_CACHE_TTL_MS - 1);
      assert.deepEqual(yield* cache.usage, { bytes: 23, owners: 1 });
      yield* TestClock.adjust(1);
      yield* Deferred.await(expired);
      assert.deepEqual(yield* cache.usage, { bytes: 0, owners: 0 });
      yield* unregister;
      let stopped = 0;
      const stop = yield* cache.retain({
        bytes: 42,
        release: Effect.sync(() => {
          stopped++;
        }),
      });
      yield* stop;
      yield* TestClock.adjust(MEMORY_DERIVED_CACHE_TTL_MS);
      assert.equal(stopped, 1);
      assert.deepEqual(yield* cache.usage, { bytes: 0, owners: 0 });
    }),
  ).pipe(Effect.provide(Cache.layer)),
);
