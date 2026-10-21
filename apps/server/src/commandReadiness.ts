import { GOAT_ENVIRONMENT_PATH, LEGACY_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const DESCRIPTOR_PATHS: ReadonlySet<string> = new Set([
  GOAT_ENVIRONMENT_PATH,
  LEGACY_ENVIRONMENT_PATH,
]);

const isDescriptorRequest = (request: HttpServerRequest.HttpServerRequest) =>
  request.method === "GET" && DESCRIPTOR_PATHS.has(new URL(request.url, "http://local").pathname);

/**
 * Requests wait until startup accepts commands. The environment descriptor is exempt: a service
 * trial reports `prepared` and stays parked until its launcher's smoke probe reads the
 * descriptor, so gating it would deadlock every launcher update (docs/internals/server-updates.md).
 */
export const layerCommandReadiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!isDescriptorRequest(request)) {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.awaitCommandReady.pipe(Effect.orDie);
      }
      return yield* httpEffect;
    }),
  { global: true },
);
