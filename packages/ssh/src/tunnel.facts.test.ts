import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const current = {
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
};

// Each case runs two full launches through fake executables, each a Node start.
const LAUNCHES_TIMEOUT_MS = 60_000;

type Fixture = Effect.Success<ReturnType<typeof makeProtocolFixture>>;

// Answers are recorded only for executables older than 2 s. Shifting the host clock makes the
// fixture's just-written files old (or new) without waiting.
const shiftHostClock = (f: Fixture, seconds: number) =>
  Effect.gen(function* () {
    const bin = `${f.test}/clock`;
    yield* f.fs.makeDirectory(bin, { recursive: true });
    yield* f.fs.writeFileString(
      `${bin}/date`,
      `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = +%s ]; then echo $(( $(/bin/date +%s) + (${seconds}) )); else exec /bin/date "$@"; fi
`,
    );
    yield* f.fs.chmod(`${bin}/date`, 0o700);
    f.setRemotePath(`${bin}:${f.test}/identity-bin:${process.env.PATH ?? ""}`);
  });

// How many times each launch started goat to ask a question whose answer could be recorded.
const recordableAsks = (f: Fixture) =>
  Effect.gen(function* () {
    const events = (yield* f.fs.readFileString(`${f.test}/events`))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; live?: boolean });
    return {
      own: events.filter(
        (event) => event.type === "version" || (event.type === "protocol" && !event.live),
      ).length,
      live: events.filter((event) => event.type === "protocol" && event.live === true).length,
    };
  });

const launch = (f: Fixture) =>
  Effect.gen(function* () {
    const result = yield* f.run("launch");
    if (Result.isFailure(result)) throw result.failure;
    assert.equal(result.success.status, "ready");
    assert.equal(result.success.port, f.port);
  });

const liveFixture = makeProtocolFixture({
  live: true,
  kind: "managed",
  oldVersion: "1.2.2",
  commitTime: 1_700_000_000,
  ...current,
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH host facts", () => {
  it.live(
    "a reconnect to an unchanged runtime starts goat only for readiness",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* shiftHostClock(f, 60);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        assert.isAbove(first.own, 0);
        assert.isAbove(first.live, 0);
        yield* launch(f);
        // Probe, candidate checks and every live recheck reuse the recorded answers.
        assert.deepEqual(yield* recordableAsks(f), first);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "a rewritten executable is asked again",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* shiftHostClock(f, 60);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        const executable = `${f.old}/goat`;
        // A longer file changes the recorded size even when the rewrite lands in the same second.
        yield* f.fs.writeFileString(
          executable,
          (yield* f.fs.readFileString(executable)) + "\n// rebuilt\n",
        );
        yield* launch(f);
        assert.isAbove((yield* recordableAsks(f)).own, first.own);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "a changed runtime record asks the live server again",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* shiftHostClock(f, 60);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        const record = `${f.home}/.goat/userdata/server-runtime.json`;
        const runtime = JSON.parse(yield* f.fs.readFileString(record)) as Record<string, unknown>;
        // A restarted server writes a new record; only the start time differs here.
        yield* f.fs.writeFileString(
          record,
          JSON.stringify({ ...runtime, startedAt: "1970-01-01T00:00:00.000Z" }),
        );
        yield* launch(f);
        const second = yield* recordableAsks(f);
        assert.isAbove(second.live, first.live);
        assert.equal(second.own, first.own);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "records nothing for an executable written within the last 2 s",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* shiftHostClock(f, -60);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        yield* launch(f);
        const second = yield* recordableAsks(f);
        assert.equal(second.own, first.own * 2);
        assert.isFalse(yield* f.fs.exists(`${f.home}/.goat/ssh-launch/facts`));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );
});
