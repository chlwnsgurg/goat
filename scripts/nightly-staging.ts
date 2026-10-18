#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - streams tar archives through the host tar binary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import {
  makeGitHubReleasesClient,
  type GitHubRelease,
  type GitHubReleaseAsset,
  type GitHubReleasesClient,
} from "./lib/github-releases.ts";

// goat-nightly hands build outputs between jobs through a per-run draft release in
// goat-si/goat instead of Actions artifacts: release assets do not count toward the
// Actions and Packages storage quota. Each hand-off is one tar stream split into
// parts below GitHub's 2 GiB per-asset limit, plus a manifest uploaded last that
// records every part's size and SHA-256. A consumer only trusts a hand-off whose
// manifest exists and whose parts match it.

export class NightlyStagingError extends Schema.TaggedError<NightlyStagingError>()(
  "NightlyStagingError",
  { message: Schema.String },
) {}

export const STAGING_TAG_PREFIX = "goat-nightly-staging-";
/** GitHub refuses release assets of 2 GiB or more. */
export const MAX_ASSET_BYTES = 2 * 1024 ** 3 - 1;
/** Each part is buffered in memory once on upload and once on download. */
export const DEFAULT_PART_BYTES = 256 * 1024 ** 2;
const MANIFEST_SUFFIX = ".manifest.json";

export const StagingManifest = Schema.Struct({
  name: Schema.String,
  size: Schema.Int,
  parts: Schema.Array(
    Schema.Struct({ asset: Schema.String, size: Schema.Int, sha256: Schema.String }),
  ),
});
export type StagingManifest = typeof StagingManifest.Type;
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(StagingManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(StagingManifest));

const fail = (message: string) => Effect.fail(new NightlyStagingError({ message }));

export function isStagingTag(tag: string) {
  return /^goat-nightly-staging-\d+$/.test(tag);
}

export function partAssetName(name: string, index: number) {
  return `${name}.tar.${String(index).padStart(3, "0")}`;
}

/** The hand-off a staging asset belongs to: "cli-linux-x64.tar.001" -> "cli-linux-x64". */
export function handoffOfAsset(asset: string) {
  if (asset.endsWith(MANIFEST_SUFFIX)) return asset.slice(0, -MANIFEST_SUFFIX.length);
  return /^(.+)\.tar\.\d{3}$/.exec(asset)?.[1];
}

/** Shell-style glob with only "*"; anchored at both ends. */
export function globMatcher(glob: string) {
  const source = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const pattern = new RegExp(`^${source}$`);
  return (value: string) => pattern.test(value);
}

export function splitList(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
const validPath = (path: string) =>
  path.length > 0 &&
  !path.startsWith("-") &&
  !NodePath.isAbsolute(path) &&
  !path.split(/[\\/]/).includes("..");

/** The run's staging draft; the lowest id wins if a retry ever created two. */
export function findStagingRelease(releases: ReadonlyArray<GitHubRelease>, tag: string) {
  return releases
    .filter((release) => release.draft && release.tag_name === tag)
    .toSorted((left, right) => left.id - right.id)[0];
}

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

let tarFlavor: "bsd" | "gnu" | undefined;
/** bsdtar (macOS, Windows System32) and GNU tar (Linux, Git Bash) take different flags. */
function tarFlags() {
  tarFlavor ??= /bsdtar/.test(
    NodeChildProcess.spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "",
  )
    ? "bsd"
    : "gnu";
  if (tarFlavor === "bsd")
    return process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : [];
  return process.platform === "win32" ? ["--force-local"] : [];
}

/**
 * Runs tar with relative paths only, so GNU tar on Windows never reads a drive
 * letter as a remote host. COPYFILE_DISABLE and the bsdtar flags keep macOS
 * AppleDouble files and extended attributes out of the archive.
 */
const runTar = (
  args: ReadonlyArray<string>,
  cwd: string,
  io: { stdin?: string; stdout?: string },
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const input = io.stdin === undefined ? "ignore" : NodeFS.openSync(io.stdin, "r");
        const output = io.stdout === undefined ? "inherit" : NodeFS.openSync(io.stdout, "w");
        const child = NodeChildProcess.spawn("tar", [...tarFlags(), ...args], {
          cwd,
          env: { ...process.env, COPYFILE_DISABLE: "1" },
          stdio: [input, output, "inherit"],
        });
        const close = () => {
          if (typeof input === "number") NodeFS.closeSync(input);
          if (typeof output === "number") NodeFS.closeSync(output);
        };
        child.on("error", (error) => {
          close();
          reject(error);
        });
        child.on("close", (code) => {
          close();
          if (code === 0) resolve();
          else reject(new Error(`tar exited with ${code}`));
        });
      }),
    catch: (error) => new NightlyStagingError({ message: `tar failed: ${String(error)}` }),
  });

const readRange = (file: string, offset: number, length: number) =>
  Effect.try({
    try: () => {
      const bytes = Buffer.alloc(length);
      const fd = NodeFS.openSync(file, "r");
      try {
        let read = 0;
        while (read < length) {
          const count = NodeFS.readSync(fd, bytes, read, length - read, offset + read);
          if (count === 0) throw new Error("unexpected end of archive");
          read += count;
        }
      } finally {
        NodeFS.closeSync(fd);
      }
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    catch: (error) => new NightlyStagingError({ message: `Cannot read archive: ${String(error)}` }),
  });

const temporaryFile = (label: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(
        NodePath.join(process.env.RUNNER_TEMP ?? NodeOS.tmpdir(), `goat-staging-`),
      );
      return { dir, file: NodePath.join(dir, label) };
    }),
    ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

/** Uploads one asset, replacing a leftover of the same name from an interrupted attempt. */
const uploadVerified = Effect.fn("uploadVerified")(function* (
  client: GitHubReleasesClient,
  releaseId: number,
  name: string,
  bytes: Uint8Array,
) {
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return yield* fail(
      `${name} is ${bytes.byteLength} bytes, above the 2 GiB release asset limit.`,
    );
  }
  for (let attempt = 1; ; attempt++) {
    for (const asset of yield* client.listAssets(releaseId)) {
      if (asset.name === name) yield* client.deleteAsset(asset.id);
    }
    const uploaded = yield* client.uploadAsset(releaseId, name, bytes).pipe(Effect.option);
    if (uploaded._tag === "Some") {
      if (uploaded.value.size !== bytes.byteLength) {
        return yield* fail(
          `GitHub stored ${uploaded.value.size} bytes for ${name}, expected ${bytes.byteLength}.`,
        );
      }
      return uploaded.value;
    }
    if (attempt >= 3) return yield* fail(`Failed to upload ${name} after ${attempt} attempts.`);
    yield* Console.log(`Upload of ${name} failed; retrying.`);
  }
});

export interface PutOptions {
  readonly tag: string;
  readonly target: string;
  readonly name: string;
  readonly dir: string;
  readonly paths: ReadonlyArray<string>;
  readonly create: boolean;
  readonly partBytes?: number;
}

export const putHandoff = Effect.fn("putHandoff")(function* (
  client: GitHubReleasesClient,
  options: PutOptions,
) {
  const partBytes = options.partBytes ?? DEFAULT_PART_BYTES;
  if (!isStagingTag(options.tag)) return yield* fail(`${options.tag} is not a staging tag.`);
  if (!validName(options.name)) return yield* fail(`Invalid hand-off name ${options.name}.`);
  if (partBytes <= 0 || partBytes > MAX_ASSET_BYTES) return yield* fail("Invalid part size.");
  const paths = options.paths.length === 0 ? ["."] : options.paths;
  for (const path of paths) {
    if (!validPath(path)) return yield* fail(`Hand-off paths must be relative: ${path}`);
    const full = NodePath.join(options.dir, path);
    const empty =
      !NodeFS.existsSync(full) ||
      (NodeFS.statSync(full).isDirectory() && NodeFS.readdirSync(full).length === 0);
    if (empty) return yield* fail(`${full} is missing or empty; nothing to hand off.`);
  }

  let release = findStagingRelease(yield* client.listReleases(), options.tag);
  if (release === undefined) {
    if (!options.create)
      return yield* fail(`No staging draft ${options.tag}; JS bundle creates it.`);
    release = yield* client.createStagingDraft(options.tag, options.target);
    yield* Console.log(`Created staging draft ${options.tag} (${release.id}).`);
  }
  const releaseId = release.id;

  // Remove the manifest first so a consumer never trusts a half-replaced hand-off.
  const stale = (yield* client.listAssets(releaseId)).filter(
    (asset) => handoffOfAsset(asset.name) === options.name,
  );
  for (const asset of stale.toSorted(
    (a, b) => Number(b.name.endsWith(MANIFEST_SUFFIX)) - Number(a.name.endsWith(MANIFEST_SUFFIX)),
  )) {
    yield* client.deleteAsset(asset.id);
  }

  const { file } = yield* temporaryFile(`${options.name}.tar`);
  yield* runTar(["-cf", "-", ...paths], options.dir, { stdout: file });
  const size = NodeFS.statSync(file).size;
  const parts: Array<{ asset: string; size: number; sha256: string }> = [];
  for (let offset = 0, index = 0; offset < size || index === 0; offset += partBytes, index++) {
    const bytes = yield* readRange(file, offset, Math.min(partBytes, size - offset));
    const asset = partAssetName(options.name, index);
    yield* uploadVerified(client, releaseId, asset, bytes);
    parts.push({ asset, size: bytes.byteLength, sha256: sha256(bytes) });
    yield* Console.log(`Staged ${asset} (${bytes.byteLength} bytes).`);
  }
  const manifest: StagingManifest = { name: options.name, size, parts };
  const manifestText = yield* encodeManifest(manifest).pipe(
    Effect.mapError(() => new NightlyStagingError({ message: "Cannot encode manifest." })),
  );
  yield* uploadVerified(
    client,
    releaseId,
    `${options.name}${MANIFEST_SUFFIX}`,
    new TextEncoder().encode(manifestText),
  );
  return manifest;
}, Effect.scoped);

export interface GetOptions {
  readonly tag: string;
  readonly names: ReadonlyArray<string>;
  readonly dir: string;
}

export const getHandoffs = Effect.fn("getHandoffs")(function* (
  client: GitHubReleasesClient,
  options: GetOptions,
) {
  const release = findStagingRelease(yield* client.listReleases(), options.tag);
  if (release === undefined) return yield* fail(`No staging draft ${options.tag}.`);
  const assets = yield* client.listAssets(release.id);
  const byName = new Map<string, GitHubReleaseAsset>(assets.map((asset) => [asset.name, asset]));
  const handoffs = assets
    .filter((asset) => asset.name.endsWith(MANIFEST_SUFFIX) && asset.state === "uploaded")
    .map((asset) => asset.name.slice(0, -MANIFEST_SUFFIX.length))
    .toSorted();
  const selected = new Set<string>();
  for (const glob of options.names) {
    const matches = handoffs.filter(globMatcher(glob));
    if (matches.length === 0)
      return yield* fail(`No complete hand-off matches ${glob} in ${options.tag}.`);
    for (const match of matches) selected.add(match);
  }
  NodeFS.mkdirSync(options.dir, { recursive: true });
  const fetched: string[] = [];
  for (const name of [...selected].toSorted()) {
    const manifestAsset = byName.get(`${name}${MANIFEST_SUFFIX}`)!;
    const manifest = yield* decodeManifest(
      new TextDecoder().decode(yield* client.downloadAsset(manifestAsset.id)),
    ).pipe(
      Effect.mapError(
        () => new NightlyStagingError({ message: `Malformed manifest for ${name}.` }),
      ),
    );
    if (manifest.name !== name) return yield* fail(`Manifest ${name} names ${manifest.name}.`);
    const { file } = yield* temporaryFile(`${name}.tar`);
    let total = 0;
    for (const part of manifest.parts) {
      const asset = byName.get(part.asset);
      if (
        asset === undefined ||
        asset.state !== "uploaded" ||
        handoffOfAsset(part.asset) !== name
      ) {
        return yield* fail(`${name} is missing part ${part.asset}.`);
      }
      const bytes = yield* client.downloadAsset(asset.id);
      if (bytes.byteLength !== part.size || sha256(bytes) !== part.sha256) {
        return yield* fail(`${part.asset} does not match its manifest size and SHA-256.`);
      }
      NodeFS.appendFileSync(file, bytes);
      total += bytes.byteLength;
    }
    if (total !== manifest.size)
      return yield* fail(`${name} is ${total} bytes, manifest says ${manifest.size}.`);
    yield* runTar(["-xf", "-"], options.dir, { stdin: file });
    yield* Console.log(`Restored ${name} (${total} bytes) into ${options.dir}.`);
    fetched.push(name);
  }
  return fetched;
}, Effect.scoped);

export interface CleanupOptions {
  readonly tag: string;
  readonly keep: ReadonlyArray<string>;
  readonly maxAgeHours: number;
}

/**
 * Deletes this run's staging draft, or only the hand-offs outside keep, and any
 * other staging draft older than maxAgeHours (a run whose cleanup never ran).
 */
export const cleanupStaging = Effect.fn("cleanupStaging")(function* (
  client: GitHubReleasesClient,
  options: CleanupOptions,
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const cutoff = now - options.maxAgeHours * 3_600_000;
  const keep = options.keep.map(globMatcher);
  for (const release of yield* client.listReleases()) {
    if (!release.draft || !isStagingTag(release.tag_name)) continue;
    if (release.tag_name === options.tag) {
      if (keep.length === 0) {
        yield* Console.log(`Deleting staging draft ${release.tag_name} (${release.id}).`);
        yield* client.deleteRelease(release.id);
        continue;
      }
      for (const asset of yield* client.listAssets(release.id)) {
        const handoff = handoffOfAsset(asset.name);
        if (handoff !== undefined && keep.some((matches) => matches(handoff))) continue;
        yield* client.deleteAsset(asset.id);
      }
      yield* Console.log(`Kept ${options.keep.join(", ")} in ${release.tag_name} for inspection.`);
      continue;
    }
    const created = release.created_at === undefined ? Number.NaN : Date.parse(release.created_at);
    if (Number.isFinite(created) && created <= cutoff) {
      yield* Console.log(`Deleting stale staging draft ${release.tag_name} (${release.id}).`);
      yield* client.deleteRelease(release.id);
    }
  }
});

const repo = Flag.String("repo");
const tag = Flag.String("tag");
const put = Command.make(
  "put",
  {
    repo,
    tag,
    target: Flag.String("target"),
    name: Flag.String("name"),
    dir: Flag.String("dir"),
    paths: Flag.String("paths").pipe(Flag.withDefault(".")),
    create: Flag.Boolean("create").pipe(Flag.withDefault(false)),
  },
  (options) =>
    Effect.gen(function* () {
      const client = yield* makeGitHubReleasesClient(options.repo);
      yield* putHandoff(client, { ...options, paths: splitList(options.paths) });
    }),
);
const get = Command.make(
  "get",
  { repo, tag, names: Flag.String("names"), dir: Flag.String("dir") },
  (options) =>
    Effect.gen(function* () {
      const client = yield* makeGitHubReleasesClient(options.repo);
      yield* getHandoffs(client, { ...options, names: splitList(options.names) });
    }),
);
const NonnegativeInteger = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const cleanup = Command.make(
  "cleanup",
  {
    repo,
    tag,
    keep: Flag.String("keep").pipe(Flag.withDefault("")),
    maxAgeHours: Flag.String("max-age-hours").pipe(
      Flag.withSchema(NonnegativeInteger),
      Flag.withDefault(72),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const client = yield* makeGitHubReleasesClient(options.repo);
      yield* cleanupStaging(client, { ...options, keep: splitList(options.keep) });
    }),
);
const command = Command.make("nightly-staging").pipe(Command.withSubcommands([put, get, cleanup]));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
