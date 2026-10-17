import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import { SshHttpBridgeError } from "@goat/ssh/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  CLOUD_MACHINE_READY_WINDOW_MS,
  DesktopSshEnvironmentRequestError,
  fetchSshEnvironmentDescriptor,
  ensureSshEnvironment,
  requireReadiedCloudMachine,
} from "./sshEnvironment.ts";

/** A desktop whose home is `home`, for the cloud machine guard. */
const desktopAt = (home: string) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.DesktopEnvironment.of({
        path,
        homeDirectory: home,
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

describe("SSH environment IPC", () => {
  it.effect("preserves key-only options across the IPC handler", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: null,
        port: null,
      };
      let received: unknown;
      const result = yield* ensureSshEnvironment
        .handler({ target, options: { keyOnly: true, issuePairingToken: true } })
        .pipe(
          Effect.provide(desktopAt("/nonexistent-home")),
          Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
            discoverHosts: () => Effect.die("unused"),
            resolveHost: () => Effect.die("unused"),
            disconnectEnvironment: () => Effect.die("unused"),
            revalidateTunnels: Effect.die("unused"),
            ensureEnvironment: (receivedTarget, options) =>
              Effect.sync(() => {
                received = { target: receivedTarget, options };
                return {
                  target,
                  httpBaseUrl: "http://127.0.0.1:41773/",
                  wsBaseUrl: "ws://127.0.0.1:41773/",
                  pairingToken: "fixture-token",
                };
              }),
          }),
        );
      assert.deepEqual(received, { target, options: { keyOnly: true, issuePairingToken: true } });
      assert.deepEqual(result, {
        target,
        httpBaseUrl: "http://127.0.0.1:41773/",
        wsBaseUrl: "ws://127.0.0.1:41773/",
        pairingToken: "fixture-token",
      });
    }),
  );
  it.effect("fetches and decodes the remote environment descriptor", () => {
    const requestUrls: string[] = [];
    const layer = layerHttpClient((request) =>
      Effect.sync(() => {
        requestUrls.push(request.url);
        return jsonResponse(request, {
          environmentId: "remote-env",
          label: "Remote Devbox",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1.2.3",
          capabilities: { repositoryIdentity: true },
        });
      }),
    );

    return Effect.gen(function* () {
      const descriptor = yield* fetchSshEnvironmentDescriptor.handler({
        httpBaseUrl: "http://127.0.0.1:41773/",
      });

      assert.deepEqual(descriptor, {
        environmentId: "remote-env",
        label: "Remote Devbox",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "1.2.3",
        capabilities: { repositoryIdentity: true },
      });
      assert.deepEqual(requestUrls, ["http://127.0.0.1:41773/.well-known/goat/environment"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("wraps schema decode failures in a typed request error", () => {
    const layer = layerHttpClient((request) =>
      Effect.succeed(jsonResponse(request, { environmentId: "remote-env" })),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://127.0.0.1:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.equal(error.operation, "fetch-environment-descriptor");
      assert.equal(error.cause instanceof SshHttpBridgeError, false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects non-loopback HTTP endpoints before issuing a request", () => {
    let requestCount = 0;
    const layer = layerHttpClient((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return jsonResponse(request, {});
      }),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://remote.example.com:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.instanceOf(error.cause, SshHttpBridgeError);
      assert.equal(requestCount, 0);
    }).pipe(Effect.provide(layer));
  });
});

describe("cloud machine guard", () => {
  const ALIAS = "boat-bx_23456789";
  const withHome = <A, E>(
    use: (
      home: string,
      fs: FileSystem.FileSystem,
    ) => Effect.Effect<A, E, DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-desktop-cloud-test-" });
        return yield* use(home, fs).pipe(Effect.provide(desktopAt(home)));
      }),
    ).pipe(Effect.provide(NodeServices.layer));

  it.effect("refuses a cloud machine this computer's server has not readied recently", () =>
    withHome((home, fs) =>
      Effect.gen(function* () {
        const missing = yield* requireReadiedCloudMachine(ALIAS).pipe(Effect.flip);
        assert.include(missing.message, "belongs to another GOAT server");

        const dir = `${home}/.ssh/goat-cloud`;
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.writeFileString(`${dir}/${ALIAS}.conf`, "Host x\n");
        const written = Option.getOrThrow((yield* fs.stat(`${dir}/${ALIAS}.conf`)).mtime).getTime();
        yield* TestClock.setTime(written);
        yield* requireReadiedCloudMachine(ALIAS);

        yield* TestClock.setTime(written + CLOUD_MACHINE_READY_WINDOW_MS + 60_000);
        const stale = yield* requireReadiedCloudMachine(ALIAS).pipe(Effect.flip);
        assert.include(stale.message, "Prepare this cloud machine");

        // Ordinary hosts, including other boat- names, are not checked.
        yield* requireReadiedCloudMachine("devbox");
        yield* requireReadiedCloudMachine("boat-house");
      }),
    ),
  );
});
