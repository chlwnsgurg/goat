import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import * as SshTunnel from "./tunnel.ts";
import { ARCHIVE, arch, platform, uploadTarget } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;

/**
 * A fake curl on the host's PATH stands in for the release server: it serves the
 * fixture archive and its checksum, fails like a host without a route, or serves a
 * checksum that does not match.
 */
const fakeCurl = (cache: string, log: string, mode: string) => `#!/bin/sh
url=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$(basename "$url")" >> '${log}'
mode='${mode}'
if [ "$mode" = offline ]; then exit 6; fi
case "$url" in
  */SHA256SUMS)
    if [ "$mode" = corrupt ]; then printf '%s  %s\\n' "$(printf 'f%.0s' $(seq 64))" '${stem}.tar.gz' > "$out"
    else cp '${cache}/${stem}.tar.gz.sha256' "$out"; fi ;;
  *) cp '${cache}/${stem}.tar.gz' "$out" ;;
esac
`;

const prepare = (mode: string | null) =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: "1.2.2",
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    });
    const bin = `${f.home}/.test/fake-curl`;
    const log = `${f.test}/curl-calls`;
    yield* f.fs.makeDirectory(bin, { recursive: true });
    yield* f.fs.writeFileString(
      `${bin}/curl`,
      fakeCurl(f.runner.archiveDirectory, log, mode ?? "serve"),
    );
    yield* f.fs.chmod(`${bin}/curl`, 0o755);
    yield* f.fs.writeFileString(log, "");
    f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
    const selected = yield* SshTunnel.prepareRemoteRuntime(
      uploadTarget,
      {},
      { ...f.runner, ...(mode === null ? {} : { hostDownload: true }) },
      REMOTE_RUNTIME_STATE_KEY,
      true,
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
    const record = yield* f.fs.readFileString(
      `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-record`,
    );
    const fetched = (yield* f.fs.readFileString(log)).split("\n").filter(Boolean);
    return {
      selected,
      source: record.trim().split(" ")[3],
      fetched,
      uploads: f.counters().uploads,
    };
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH host download", () => {
  it.live("installs a published release from the host's own network without uploading", () =>
    Effect.gen(function* () {
      const result = yield* prepare("serve");
      assert.equal(result.selected.version, ARCHIVE.archiveVersion);
      assert.isTrue(result.selected.uploaded);
      assert.equal(result.source, "https");
      assert.equal(result.uploads, 0);
      assert.deepEqual(result.fetched, ["SHA256SUMS", `${stem}.tar.gz`]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.each(["offline", "corrupt"])(
    "uploads the client's archive when the host download is %s",
    (mode) =>
      Effect.gen(function* () {
        const result = yield* prepare(mode);
        assert.equal(result.selected.version, ARCHIVE.archiveVersion);
        assert.equal(result.source, "cache");
        assert.equal(result.uploads, 1);
        assert.isAtLeast(result.fetched.length, 1);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("leaves acquisition to the client unless the runner opts in", () =>
    Effect.gen(function* () {
      const result = yield* prepare(null);
      assert.equal(result.source, "cache");
      assert.equal(result.uploads, 1);
      assert.deepEqual(result.fetched, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
