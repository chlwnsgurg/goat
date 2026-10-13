import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import { prepareMemoryServer } from "./memoryIsolation.ts";

it.layer(NodeServices.layer)("OpenCode memory server isolation", (it) => {
  it.effect("copies only selected credentials and removes every helper directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "goat-memory-auth-fixture-" });
      yield* fs.makeDirectory(path.join(source, "opencode"));
      yield* fs.writeFileString(
        path.join(source, "opencode", "auth.json"),
        JSON.stringify({
          openai: { type: "api", key: "synthetic-key" },
          untrusted: { type: "wellknown", key: "EVIL", token: "synthetic" },
        }),
      );
      let helper = "";
      yield* Effect.gen(function* () {
        const isolated = yield* prepareMemoryServer(
          "generateMemorySummary",
          "openai",
          {
            XDG_DATA_HOME: source,
            OPENCODE_CONFIG_DIR: source,
            OPENCODE_CONFIG_CONTENT: '{"plugin":["untrusted"]}',
            NODE_OPTIONS: "--require untrusted",
            OPENAI_API_KEY: "synthetic-openai",
            ANTHROPIC_API_KEY: "unselected-secret",
          },
          1,
        );
        helper = path.dirname(isolated.directory);
        expect(isolated.environment.OPENCODE_CONFIG_DIR).not.toBe(source);
        expect(isolated.environment.NODE_OPTIONS).toBeUndefined();
        expect(isolated.environment.ANTHROPIC_API_KEY).toBeUndefined();
        expect(isolated.environment.OPENAI_API_KEY).toBe("synthetic-openai");
        const auth = JSON.parse(
          yield* fs.readFileString(path.join(helper, "data", "opencode", "auth.json")),
        );
        expect(auth).toEqual({ openai: { type: "api", key: "synthetic-key" } });
        expect(
          yield* fs.exists(path.join(isolated.environment.OPENCODE_CONFIG_DIR!, "plugins")),
        ).toBe(false);
        expect(yield* fs.exists(path.join(isolated.environment.HOME!, ".opencode"))).toBe(false);
      }).pipe(Effect.scoped);
      expect(yield* fs.exists(helper)).toBe(false);
    }).pipe(Effect.scoped),
  );
  it.effect("refuses credential-only migration from a v2 login database", () =>
    prepareMemoryServer("generateMemorySummary", "openai", {}, 2).pipe(
      Effect.flip,
      Effect.tap((failure) =>
        Effect.sync(() => expect(failure.cause).toMatchObject({ code: "unavailable" })),
      ),
      Effect.scoped,
    ),
  );
  it.effect("refuses system plugin discovery before preparing a server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const failure = yield* prepareMemoryServer("generateMemorySummary", "openai", {}, 1).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (path) => (path === "/etc/opencode" ? Effect.succeed(true) : fs.exists(path)),
        }),
        Effect.flip,
        Effect.scoped,
      );
      expect(failure.cause).toMatchObject({ code: "unavailable" });
    }),
  );
});
