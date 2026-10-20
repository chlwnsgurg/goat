import { assert, it } from "@effect/vitest";
import { GOAT_ENVIRONMENT_PATH, LEGACY_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { layerCommandReadiness } from "./commandReadiness.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it.effect(
  "answers the environment descriptor before commands are ready and holds other routes",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void, ServerRuntimeStartup.ServerRuntimeStartupError>();
      const app = Layer.mergeAll(
        HttpRouter.add("GET", GOAT_ENVIRONMENT_PATH, HttpServerResponse.text("descriptor")),
        HttpRouter.add("GET", LEGACY_ENVIRONMENT_PATH, HttpServerResponse.text("descriptor")),
        HttpRouter.add("GET", "/api/other", HttpServerResponse.text("other")),
      ).pipe(
        Layer.provide(layerCommandReadiness),
        Layer.provideMerge(
          Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
            awaitCommandReady: Deferred.await(ready),
            markHttpListening: Effect.void,
            enqueueCommand: (effect) => effect,
          }),
        ),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
      const get = (path: string) =>
        Effect.promise(async () => {
          const response = await handler(new Request(`http://127.0.0.1${path}`), Context.empty());
          return { status: response.status, body: await response.text() };
        });
      yield* Effect.gen(function* () {
        const other = yield* Effect.forkChild(get("/api/other"));
        // A launcher trial stays parked until its smoke probe reads the descriptor.
        for (const path of [GOAT_ENVIRONMENT_PATH, LEGACY_ENVIRONMENT_PATH]) {
          assert.deepStrictEqual(yield* get(path), { status: 200, body: "descriptor" });
        }
        assert.isUndefined(other.pollUnsafe(), "other routes wait for command readiness");
        yield* Deferred.succeed(ready, undefined);
        assert.deepStrictEqual(yield* Fiber.join(other), { status: 200, body: "other" });
      }).pipe(Effect.ensuring(Effect.promise(() => dispose())));
    }),
);
