import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";

import { resolveDesktopSshCliRunner } from "./desktopSshCliRunner.ts";

const server = { version: "0.0.45", engines: { node: "^24.13.1" } };
const archiveOptions = {
  archiveDirectory: "/home/me/.goat/runtime/archives",
  releaseBaseUrl: "https://mirror.example/releases/download",
};
const environment = (input: {
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly devRemoteEntry?: string;
}) => ({
  appVersion: input.appVersion,
  isPackaged: input.isPackaged,
  isDevelopment: input.isDevelopment,
  devRemoteT3ServerEntryPath: Option.fromNullishOr(input.devRemoteEntry),
});

describe("resolveDesktopSshCliRunner", () => {
  it("keeps a packaged app's own release, including nightly versions", () => {
    assert.deepStrictEqual(
      resolveDesktopSshCliRunner(
        environment({
          appVersion: "0.0.46-nightly.20261010.7",
          isPackaged: true,
          isDevelopment: false,
        }),
        archiveOptions,
        server,
      ),
      { archiveVersion: "0.0.46-nightly.20261010.7", ...archiveOptions },
    );
  });

  it.each([true, false])(
    "uses the server version when unpackaged Electron reports its own (development: %s)",
    (isDevelopment: boolean) => {
      assert.deepStrictEqual(
        resolveDesktopSshCliRunner(
          environment({ appVersion: "44.4.5", isPackaged: false, isDevelopment }),
          archiveOptions,
          server,
        ),
        { archiveVersion: "0.0.45", ...archiveOptions },
      );
    },
  );

  it("runs a configured source checkout in development", () => {
    assert.deepStrictEqual(
      resolveDesktopSshCliRunner(
        environment({
          appVersion: "44.4.5",
          isPackaged: false,
          isDevelopment: true,
          devRemoteEntry: "/src/goat/apps/server/src/bin.ts",
        }),
        archiveOptions,
        server,
      ),
      { nodeScriptPath: "/src/goat/apps/server/src/bin.ts", nodeEngineRange: "^24.13.1" },
    );
  });
});
