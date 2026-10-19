import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/process";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import { uploadTarget } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import { prepareRemoteRuntime } from "./tunnel.ts";

const current = {
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
};

// Each case runs two full launches through fake executables, each a Node start.
const LAUNCHES_TIMEOUT_MS = 60_000;

type Fixture = Effect.Success<ReturnType<typeof makeProtocolFixture>>;

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

const probe = (f: Fixture) =>
  prepareRemoteRuntime(uploadTarget, {}, f.runner, REMOTE_RUNTIME_STATE_KEY).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
    Effect.provideService(FileSystem.FileSystem, f.observedFs),
  );

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
        yield* f.shiftHostClock(60);
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
        yield* f.shiftHostClock(60);
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
        yield* f.shiftHostClock(60);
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
    "records and reuses a freshly installed executable on the first probe",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(0, true);
        yield* probe(f);
        const first = yield* recordableAsks(f);
        assert.isAbove(first.own, 0);
        yield* probe(f);
        assert.deepEqual(yield* recordableAsks(f), first);
        const names = yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch/facts`);
        assert.include(names, "version.1.2.2.exe");
        yield* launch(f);
        const afterLaunch = yield* recordableAsks(f);
        yield* launch(f);
        assert.deepEqual(yield* recordableAsks(f), afterLaunch);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "a same-size rewrite within the same second misses recorded answers",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(0, true);
        yield* probe(f);
        const first = yield* recordableAsks(f);
        const executable = `${f.old}/goat`;
        const source = yield* f.fs.readFileString(executable);
        const rebuilt = source.replace("1.2.2", "1.2.1");
        assert.notEqual(rebuilt, source);
        assert.equal(rebuilt.length, source.length);
        yield* f.fs.writeFileString(executable, rebuilt);
        const selected = yield* probe(f);
        assert.isAbove((yield* recordableAsks(f)).own, first.own);
        assert.notEqual(selected.source, "retained");
        const fact = yield* f.fs.readFileString(
          `${f.home}/.goat/ssh-launch/facts/version.1.2.2.exe`,
        );
        assert.include(fact, "\ngoat v1.2.1\n");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "prunes only facts of removed versions without following symlinks",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        yield* probe(f);
        const facts = `${f.home}/.goat/ssh-launch/facts`;
        const versions = `${f.home}/.goat/runtime/goat/versions`;
        const removed = `${versions}/1.0.0`;
        yield* f.fs.makeDirectory(removed);
        const kinds = ["version", "own", "commit", "scopes", "live", "compat"];
        const stale = kinds.flatMap((kind) =>
          ["exe", "runner"].map((via) => `${kind}.1.0.0.${via}`),
        );
        for (const name of stale) yield* f.fs.writeFileString(`${facts}/${name}`, "obsolete\n");
        // Directory existence protects incomplete installs too; neither link is traversed.
        yield* f.fs.makeDirectory(`${versions}/1.0.1`);
        yield* f.fs.symlink(`${f.home}/absent`, `${versions}/1.0.2`);
        const preserved = ["own.1.0.1.exe", "own.1.0.2.exe", "unknown.1.0.0.exe", "own.bad.exe"];
        for (const name of preserved) yield* f.fs.writeFileString(`${facts}/${name}`, "keep\n");
        yield* f.fs.symlink(`${f.test}/events`, `${facts}/own.1.0.3.exe`);
        yield* f.fs.makeDirectory(`${facts}/own.1.0.4.exe`);
        const installed = yield* f.fs.readFileString(`${facts}/version.1.2.2.exe`);
        yield* f.fs.remove(removed, { recursive: true });
        yield* probe(f);
        const names = yield* f.fs.readDirectory(facts);
        for (const name of stale) assert.notInclude(names, name);
        for (const name of [...preserved, "own.1.0.3.exe", "own.1.0.4.exe"])
          assert.include(names, name);
        assert.equal(yield* f.fs.readFileString(`${facts}/version.1.2.2.exe`), installed);
        assert.isAbove((yield* recordableAsks(f)).own, 0);
        const movedFacts = `${f.test}/moved-facts`;
        yield* f.fs.rename(facts, movedFacts);
        yield* f.fs.symlink(movedFacts, facts);
        yield* f.fs.writeFileString(`${movedFacts}/own.1.0.0.exe`, "keep behind link\n");
        yield* probe(f);
        assert.equal(
          yield* f.fs.readFileString(`${movedFacts}/own.1.0.0.exe`),
          "keep behind link\n",
        );
        yield* f.fs.remove(facts);
        yield* f.fs.rename(movedFacts, facts);
        const movedVersions = `${f.test}/moved-versions`;
        yield* f.fs.rename(versions, movedVersions);
        yield* f.fs.symlink(movedVersions, versions);
        yield* probe(f);
        assert.equal(yield* f.fs.readFileString(`${facts}/own.1.0.0.exe`), "keep behind link\n");
        yield* f.fs.remove(versions);
        yield* f.fs.rename(movedVersions, versions);
        f.setScriptPrefix("rm() { return 1; }\n");
        yield* probe(f);
        assert.equal(yield* f.fs.readFileString(`${facts}/own.1.0.0.exe`), "keep behind link\n");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "a damaged record is asked again instead of trusted",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        const facts = `${f.home}/.goat/ssh-launch/facts`;
        for (const name of yield* f.fs.readDirectory(facts)) {
          const [key] = (yield* f.fs.readFileString(`${facts}/${name}`)).split("\n");
          yield* f.fs.writeFileString(`${facts}/${name}`, `${key}\nlive garbled\n`);
        }
        yield* launch(f);
        const second = yield* recordableAsks(f);
        assert.isAbove(second.own, first.own);
        assert.isAbove(second.live, first.live);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "records no live answer when the record does not name the answering process",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        const record = `${f.home}/.goat/userdata/server-runtime.json`;
        // A record from before versions were persisted grants the helper no PID, so whatever
        // listens on its port could change while every recorded input stays the same.
        const { serverVersion: _version, ...historical } = JSON.parse(
          yield* f.fs.readFileString(record),
        ) as Record<string, unknown>;
        yield* f.fs.writeFileString(record, JSON.stringify(historical));
        yield* launch(f);
        const first = yield* recordableAsks(f);
        yield* launch(f);
        assert.isAbove((yield* recordableAsks(f)).live, first.live);
        const names = yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch/facts`);
        assert.isFalse(
          names.some((name) => name.startsWith("live.") || name.startsWith("compat.")),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );
});
