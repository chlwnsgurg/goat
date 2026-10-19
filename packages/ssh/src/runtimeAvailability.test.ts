import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as Stream from "effect/Stream";
import { checkRuntimeAvailability, RuntimeReleaseHead } from "./runtimeAvailability.ts";
import { makeSuccessfulProcess } from "./tunnel.fixture.ts";
import { MAX_RUNTIME_ARCHIVE_BYTES } from "./runtimeArchive.ts";
import { cliArchiveFileName } from "@goat/shared/cliRelease";

const fixture = (
  options: {
    local?: "archive" | "both" | "directory" | "oversized";
    cache?: boolean;
    head?: "present" | "absent" | "unknown";
    gh?: "both" | "archive" | "absent" | "unknown";
    installed?: string[];
    source?: boolean;
    checksum?: "absent" | "unknown";
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-runtime-preflight-" });
    const fileName = cliArchiveFileName("0.1.0", "linux-arm64");
    if (options.local === "directory") yield* fs.makeDirectory(`${directory}/${fileName}`);
    else if (options.local)
      yield* fs.writeFileString(`${directory}/${fileName}`, "not read or hashed");
    if (options.local === "oversized") {
      const file = yield* fs.open(`${directory}/${fileName}`, { flag: "r+" });
      yield* file.truncate(MAX_RUNTIME_ARCHIVE_BYTES + 1);
    }
    if (options.local === "both")
      yield* fs.writeFileString(`${directory}/${fileName}.sha256`, "not read or hashed");
    let requests = 0;
    const process = ChildProcessSpawner.make(() =>
      Effect.succeed({
        ...makeSuccessfulProcess(
          JSON.stringify({
            assets:
              options.gh === "both"
                ? [{ name: fileName }, { name: "SHA256SUMS" }]
                : [{ name: fileName }],
          }),
        ),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(
            options.gh === "absent" || options.gh === undefined || options.gh === "unknown" ? 1 : 0,
          ),
        ),
        stderr: Stream.make(
          new TextEncoder().encode(
            options.gh === "unknown" ? "not logged in" : "release not found",
          ),
        ),
      }),
    );
    const result = yield* checkRuntimeAvailability({
      ownerLabel: "Origin",
      platformKey: "linux-arm64",
      installedVersions: options.installed ?? [],
      runner: {
        archiveVersion: "0.1.0",
        ...(options.cache
          ? { archiveDirectory: directory }
          : { bundledArchiveDirectory: directory }),
        ...(options.source
          ? { nodeScriptPath: "/src/server.ts", nodeEngineRange: "^24.13.1" }
          : {}),
      },
    }).pipe(
      Effect.provideService(RuntimeReleaseHead, (url) => {
        requests++;
        return Effect.succeed(
          url.endsWith("/SHA256SUMS") && options.checksum
            ? options.checksum
            : (options.head ?? "absent"),
        );
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, process),
      Effect.provide(FetchHttpClient.layer),
    );
    return { ...result, requests };
  });
it.effect("source runners warn without looking for archives", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ source: true });
    expect(result.step.state).toBe("warning");
    expect(result.step.summary).toContain("/src/server.ts");
    expect(result.step.summary).toContain("^24.13.1");
    expect(result.requests).toBe(0);
    expect(result.needsTransfer).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("installed requested runtime needs no transfer", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ installed: ["0.1.0"] });
    expect(result.step.state).toBe("passed");
    expect(result.requests).toBe(0);
    expect(result.needsTransfer).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("a local archive and sidecar are checked by metadata only", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ local: "both" });
    expect(result.step.state).toBe("passed");
    expect(result.step.summary).toContain("Origin");
    expect(result.requests).toBe(0);
    expect(result.needsTransfer).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("a local archive without a checksum is not a confirmed source", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ local: "archive" });
    expect(result.step.state).toBe("failed");
    expect(result.step.fix?.instruction).toContain("published GOAT release");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["present", "absent", "unknown"] as const)("handles public HTTPS %s", (head) =>
  Effect.gen(function* () {
    const result = yield* fixture({ head });
    expect(result.step.state).toBe(
      head === "present" ? "passed" : head === "absent" ? "failed" : "warning",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["absent", "unknown"] as const)(
  "requires the release checksum asset (%s)",
  (checksum) =>
    Effect.gen(function* () {
      const result = yield* fixture({ head: "present", checksum });
      expect(result.step.state).toBe(checksum === "absent" ? "failed" : "warning");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["both", "archive", "unknown"] as const)(
  "handles authenticated release assets %s",
  (gh) =>
    Effect.gen(function* () {
      const result = yield* fixture({ gh });
      expect(result.step.state).toBe(
        gh === "both" ? "passed" : gh === "archive" ? "failed" : "warning",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("preserves a compatible-runtime fallback when the requested release is absent", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ installed: ["0.0.9"] });
    expect(result.step.state).toBe("warning");
    expect(result.step.summary).toContain("connect checks whether it is compatible");
    expect(result.needsTransfer).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([200, 404, 401, 500])(
  "release HEAD classifies HTTP %s without downloading",
  (status) =>
    Effect.gen(function* () {
      const head = yield* RuntimeReleaseHead;
      const client = HttpClient.make((request) => {
        expect(request.method).toBe("HEAD");
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
      });
      expect(
        yield* head("https://releases.example/runtime").pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      ).toBe(status === 200 ? "present" : status === 404 ? "absent" : "unknown");
    }),
);

it.effect("accepts a user-supplied cache archive without a checksum or content reads", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ local: "archive", cache: true });
    expect(result.step.state).toBe("passed");
    expect(result.step.summary).toContain("Uploads GOAT");
    expect(result.requests).toBe(0);
    expect(result.needsTransfer).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["directory", "oversized"] as const)(
  "rejects a cache archive with invalid %s metadata",
  (local) =>
    Effect.gen(function* () {
      const result = yield* fixture({ local, cache: true });
      expect(result.step.state).toBe("failed");
      expect(result.needsTransfer).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);
