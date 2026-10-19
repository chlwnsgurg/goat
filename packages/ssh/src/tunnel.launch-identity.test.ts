// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HostProcess from "@goat/shared/HostProcess";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { ARCHIVE, remoteShell } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import { REMOTE_LAUNCH_LISTENER_SCRIPT } from "./tunnel.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH launch identity", () => {
  it.live("checks the socket PID with noglob enabled and preserves the caller's options", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeHttp.Server>((resolve, reject) => {
              const listener = NodeHttp.createServer((_req, res) => res.end("ok"));
              listener.once("error", reject);
              listener.listen(0, "127.0.0.1", () => resolve(listener));
            }),
        ),
        (listener) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                listener.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
      );
      const address = server.address();
      if (address === null || typeof address === "string") assert.fail("Expected a TCP listener");
      const result = NodeChildProcess.spawnSync(
        remoteShell,
        [
          "-c",
          `set -f
GOAT_HOST_WINDOWS=0
${REMOTE_LAUNCH_LISTENER_SCRIPT.replaceAll("@@GOAT_READY_TIMEOUT_MS@@", "60000")}
server_owns_listener ${process.pid} ${address.port} || exit 1
if server_owns_listener "$$" ${address.port}; then exit 2; fi
case "$-" in *f*) ;; *) exit 3 ;; esac
`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
    }).pipe(Effect.scoped),
  );
  it.live.each([false, true])(
    "retries a selection/bind race; foreign descriptor=%s",
    (descriptor) =>
      Effect.gen(function* () {
        const foreign = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve, reject) => {
                const server = NodeHttp.createServer((_req, res) =>
                  res.end(
                    descriptor
                      ? JSON.stringify({
                          environmentId: "foreign",
                          label: "Other environment",
                          platform: { os: "linux", arch: "arm64" },
                          capabilities: {},
                          serverVersion: ARCHIVE.archiveVersion,
                          sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
                          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                        })
                      : "foreign",
                  ),
                );
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  server.close((error) => (error ? reject(error) : resolve()));
                  server.closeAllConnections();
                }),
            ),
        );
        const address = foreign.address();
        assert.isNotNull(address);
        if (address === null || typeof address === "string") return;
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          contestedPort: address.port,
        });
        const result = yield* f.run("launch");
        if (Result.isFailure(result)) assert.fail(String(result.failure));
        if (Result.isFailure(result)) return;
        assert.notEqual(result.success.port, address.port);
        const record = JSON.parse(
          yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
        );
        assert.equal(record.port, result.success.port);
        assert.equal(Number((yield* f.fs.readFileString(`${f.state}/pid`)).trim()), record.pid);
        assert.include(yield* f.fs.readFileString(`${f.state}/server.log`), "EADDRINUSE");
        assert.isTrue(foreign.listening);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("bounds repeated collisions and preserves the foreign listener", () =>
    Effect.gen(function* () {
      const foreign = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeHttp.Server>((resolve, reject) => {
              const server = NodeHttp.createServer((_req, res) => res.end("foreign"));
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
              }),
          ),
      );
      const address = foreign.address();
      assert.isNotNull(address);
      if (address === null || typeof address === "string") return;
      const f = yield* makeProtocolFixture({
        live: false,
        kind: "managed",
        oldVersion: ARCHIVE.archiveVersion,
        ssh: SSH_RUNTIME_PROTOCOL_VERSION,
        orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        contestedPort: address.port,
        contestedAttempts: 10,
      });
      const result = yield* f.run("launch");
      assert.isTrue(Result.isFailure(result));
      assert.equal(yield* f.fs.readFileString(`${f.test}/contested-picked`), "3");
      for (const name of ["pid", "port", "managed", "identity"])
        assert.isFalse(yield* f.fs.exists(`${f.state}/${name}`));
      assert.isTrue(foreign.listening);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live(
    "does not retry an unrelated startup failure because an old log mentions EADDRINUSE",
    () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* f.fs.writeFileString(`${f.state}/server.log`, "Previous start: EADDRINUSE\n");
        yield* f.fs.writeFileString(`${f.test}/fail-start-${ARCHIVE.archiveVersion}`, "1");
        const result = yield* f.run("launch");
        assert.isTrue(Result.isFailure(result));
        const events = (yield* f.fs.readFileString(`${f.test}/events`))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(events.filter((event) => event.type === "failed-start").length, 1);
        assert.isFalse(yield* f.fs.exists(`${f.state}/pid`));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
