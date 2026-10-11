// Execute the generated remote script without contacting SSH or a release server.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildRemoteMcpSessionScript, decodeRemoteMcpSessionOutput } from "./tunnel.ts";

describe("remote MCP session script", () => {
  const stateKey = "session-test";
  const archiveVersion = "0.0.45";
  const token = "fake-mcp-session-token";
  const expiresAt = "2026-10-12T12:00:00.000Z";
  const options = {
    label: "worker's session; with spaces",
    // The fake accepts any duration so quoting can be tested independently of CLI validation.
    ttl: "12 hours' grace",
    runtimeModeCeiling: "approval-required",
  };
  let home: string;
  let runner: string;

  beforeEach(() => {
    home = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-session-")),
    );
    const stateDirectory = NodePath.join(home, ".goat", "ssh-launch", stateKey);
    NodeFS.mkdirSync(stateDirectory, { recursive: true });
    runner = NodePath.join(stateDirectory, "run-t3.sh");
  });

  afterEach(() => {
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  const fakeCli = (rejectCeiling: boolean, issuedToken = token) => `#!/bin/sh
set -eu
if [ -f "$HOME/call-1.args" ]; then
  ARGS="$HOME/call-2.args"
else
  ARGS="$HOME/call-1.args"
fi
printf '%s\\n' "$@" > "$ARGS"
for ARG in "$@"; do
  if [ "$ARG" = "--runtime-mode-ceiling" ] && [ "${rejectCeiling ? "1" : "0"}" = "1" ]; then
    printf 'unknown option: --runtime-mode-ceiling\\n' >&2
    exit 2
  fi
done
cat <<'JSON'
${JSON.stringify({ sessionId: "fake-session-id", token: issuedToken, expiresAt, subject: "mcp-client" }, null, 2)}
JSON
`;

  const installFakeRunner = (rejectCeiling: boolean) => {
    const script = fakeCli(rejectCeiling);
    NodeFS.writeFileSync(runner, script, { mode: 0o700 });
    return script;
  };

  const runSession = (
    keepExistingRunner = true,
    runtimeModeCeiling: string | null = options.runtimeModeCeiling,
  ) => {
    const stdout = NodeChildProcess.execFileSync("/bin/sh", [], {
      input: buildRemoteMcpSessionScript(
        stateKey,
        { ...options, runtimeModeCeiling },
        {
          archiveVersion,
          keepExistingRunner,
        },
      ),
      cwd: home,
      env: { HOME: home, PATH: process.env.PATH, LC_ALL: "C" },
      encoding: "utf8",
      timeout: 10_000,
    });
    return decodeRemoteMcpSessionOutput(stdout);
  };

  const receivedArgs = (call: number) =>
    NodeFS.readFileSync(NodePath.join(home, `call-${call}.args`), "utf8")
      .trimEnd()
      .split("\n");

  const expectedArgs = [
    "auth",
    "session",
    "issue",
    "--base-dir",
    "",
    "--subject",
    "mcp-client",
    "--scope",
    "orchestration:read",
    "--scope",
    "orchestration:operate",
    "--ttl",
    options.ttl,
    "--label",
    options.label,
    "--json",
  ];
  const baseArgs = () =>
    expectedArgs.map((arg) => (arg === "" ? NodePath.join(home, ".goat") : arg));

  it.effect("retries an older CLI without the ceiling and decodes its pretty JSON", () =>
    Effect.gen(function* () {
      const originalRunner = installFakeRunner(true);
      expect(yield* runSession()).toEqual({ token, expiresAt, runtimeModeCeilingApplied: false });
      expect(receivedArgs(1)).toEqual([
        ...baseArgs(),
        "--runtime-mode-ceiling",
        options.runtimeModeCeiling,
      ]);
      expect(receivedArgs(2)).toEqual(baseArgs());
      expect(NodeFS.readFileSync(runner, "utf8")).toBe(originalRunner);
    }),
  );

  it.effect("reports the ceiling as applied when the remote CLI accepts it", () =>
    Effect.gen(function* () {
      const originalRunner = installFakeRunner(false);
      expect(yield* runSession()).toEqual({ token, expiresAt, runtimeModeCeilingApplied: true });
      expect(receivedArgs(1)).toEqual([
        ...baseArgs(),
        "--runtime-mode-ceiling",
        options.runtimeModeCeiling,
      ]);
      expect(NodeFS.readFileSync(runner, "utf8")).toBe(originalRunner);
      // A second invocation would be logged separately even if it succeeded.
      expect(() => receivedArgs(2)).toThrow();
    }),
  );

  it.effect("issues one session with the remote default when no ceiling is requested", () =>
    Effect.gen(function* () {
      installFakeRunner(false);
      expect(yield* runSession(true, null)).toEqual({
        token,
        expiresAt,
        runtimeModeCeilingApplied: false,
      });
      expect(receivedArgs(1)).toEqual(baseArgs());
      expect(() => receivedArgs(2)).toThrow();
    }),
  );

  it.effect("retains the installed runner even when keepExistingRunner is false", () =>
    Effect.gen(function* () {
      const originalRunner = installFakeRunner(false);
      expect(yield* runSession(false)).toEqual({
        token,
        expiresAt,
        runtimeModeCeilingApplied: true,
      });
      expect(NodeFS.readFileSync(runner, "utf8")).toBe(originalRunner);
      expect(receivedArgs(1)).toEqual([
        ...baseArgs(),
        "--runtime-mode-ceiling",
        options.runtimeModeCeiling,
      ]);
      expect(() => receivedArgs(2)).toThrow();
      expect(NodeFS.existsSync(NodePath.join(home, ".goat", "runtime"))).toBe(false);
    }),
  );
});
