// @effect-diagnostics nodeBuiltinImport:off - round-trips real files through tar.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeGitHubReleasesClient } from "./lib/github-releases.ts";
import {
  cleanupStaging,
  getHandoffs,
  globMatcher,
  handoffOfAsset,
  partAssetName,
  putHandoff,
} from "./nightly-staging.ts";

const tag = "goat-nightly-staging-42";
const now = Date.parse("2026-10-19T00:00:00Z");

interface FakeAsset {
  id: number;
  name: string;
  size: number;
  state: string;
  bytes: Uint8Array;
}
interface FakeRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  assets: FakeAsset[];
}

function fakeGitHub(releases: FakeRelease[] = []) {
  let nextId = 1000;
  const calls: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const assetView = ({ bytes: _bytes, ...asset }: FakeAsset) => asset;
  const fetch: typeof globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    const method = init.method ?? "GET";
    const path = target.pathname.replace(/^\/repos\/owner\/repo/, "");
    calls.push(`${method} ${path}`);
    const allAssets = releases.flatMap((release) => release.assets);
    let match: RegExpExecArray | null;
    if (method === "GET" && path === "/releases")
      return json(releases.map(({ assets: _a, ...r }) => r));
    if (method === "POST" && path === "/releases") {
      const body = JSON.parse(String(init.body)) as { tag_name: string; draft: boolean };
      const release: FakeRelease = {
        id: nextId++,
        tag_name: body.tag_name,
        draft: body.draft,
        prerelease: true,
        published_at: null,
        created_at: "2026-10-19T00:00:00.000Z",
        assets: [],
      };
      releases.push(release);
      return json(release, 201);
    }
    if ((match = /^\/releases\/(\d+)\/assets$/.exec(path))) {
      const release = releases.find((candidate) => candidate.id === Number(match![1]))!;
      if (method === "GET") return json(release.assets.map(assetView));
      const name = target.searchParams.get("name")!;
      if (release.assets.some((asset) => asset.name === name)) return json({}, 422);
      const bytes = new Uint8Array(init.body as Uint8Array);
      const asset = { id: nextId++, name, size: bytes.byteLength, state: "uploaded", bytes };
      release.assets.push(asset);
      return json(assetView(asset), 201);
    }
    if ((match = /^\/releases\/assets\/(\d+)$/.exec(path))) {
      const id = Number(match[1]);
      if (method === "DELETE") {
        for (const release of releases) release.assets = release.assets.filter((a) => a.id !== id);
        return new Response(null, { status: 204 });
      }
      const asset = allAssets.find((candidate) => candidate.id === id);
      return asset ? new Response(Uint8Array.from(asset.bytes)) : json({}, 404);
    }
    if ((match = /^\/releases\/(\d+)$/.exec(path)) && method === "DELETE") {
      const index = releases.findIndex((release) => release.id === Number(match![1]));
      releases.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json({ path }, 404);
  };
  return { fetch, releases, calls };
}

const clientFor = (fetch: typeof globalThis.fetch) =>
  makeGitHubReleasesClient("owner/repo", { fetch, retries: 0 }).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GOAT_RELEASES_TOKEN: "fake-token" } })),
    ),
  );

function tempDir() {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nightly-staging-test-"));
}

function writeTree(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), content);
  }
}

describe("nightly staging names", () => {
  it("maps parts and manifests back to their hand-off", () => {
    expect(partAssetName("cli-linux-x64", 7)).toBe("cli-linux-x64.tar.007");
    expect(handoffOfAsset("cli-linux-x64.tar.007")).toBe("cli-linux-x64");
    expect(handoffOfAsset("verify-cli-linux-x64.manifest.json")).toBe("verify-cli-linux-x64");
    expect(handoffOfAsset("stray.zip")).toBeUndefined();
  });

  it("anchors globs so cli-* never matches verify-cli-*", () => {
    const cli = globMatcher("cli-*");
    expect(cli("cli-win32-x64")).toBe(true);
    expect(cli("verify-cli-win32-x64")).toBe(false);
    expect(globMatcher("desktop-*")("desktop-mac-arm64")).toBe(true);
    expect(globMatcher("js-bundle")("js-bundle.x")).toBe(false);
  });
});

describe("nightly staging hand-off", () => {
  it.effect("splits a hand-off into verified parts and restores it byte for byte", () =>
    Effect.gen(function* () {
      const github = fakeGitHub();
      const client = yield* clientFor(github.fetch);
      const source = tempDir();
      const big = "x".repeat(5000);
      writeTree(source, {
        "server/dist/index.mjs": big,
        "desktop/dist-electron/main.js": "main",
        "other/skip": "no",
      });
      const manifest = yield* putHandoff(client, {
        tag,
        target: "a".repeat(40),
        name: "js-bundle",
        dir: source,
        paths: ["server/dist", "desktop/dist-electron"],
        create: true,
        partBytes: 2048,
      });
      expect(manifest.parts.length).toBeGreaterThan(2);
      const names = github.releases[0]!.assets.map((asset) => asset.name);
      expect(names.at(-1)).toBe("js-bundle.manifest.json");

      const dest = tempDir();
      expect(yield* getHandoffs(client, { tag, names: ["js-bundle"], dir: dest })).toEqual([
        "js-bundle",
      ]);
      expect(NodeFS.readFileSync(NodePath.join(dest, "server/dist/index.mjs"), "utf8")).toBe(big);
      expect(
        NodeFS.readFileSync(NodePath.join(dest, "desktop/dist-electron/main.js"), "utf8"),
      ).toBe("main");
      expect(NodeFS.existsSync(NodePath.join(dest, "other"))).toBe(false);
    }),
  );

  it.effect("merges every hand-off a glob selects and replaces a re-staged hand-off", () =>
    Effect.gen(function* () {
      const github = fakeGitHub();
      const client = yield* clientFor(github.fetch);
      for (const key of ["linux-x64", "win32-x64"]) {
        const dir = tempDir();
        writeTree(dir, { [`goat-${key}.tar.gz`]: key });
        yield* putHandoff(client, {
          tag,
          target: "a".repeat(40),
          name: `cli-${key}`,
          dir,
          paths: [],
          create: true,
        });
        const reports = tempDir();
        writeTree(reports, { [`verify-cli-${key}.json`]: "{}" });
        yield* putHandoff(client, {
          tag,
          target: "a".repeat(40),
          name: `verify-cli-${key}`,
          dir: reports,
          paths: [],
          create: false,
        });
      }
      const again = tempDir();
      writeTree(again, { "goat-linux-x64.tar.gz": "rebuilt" });
      yield* putHandoff(client, {
        tag,
        target: "a".repeat(40),
        name: "cli-linux-x64",
        dir: again,
        paths: [],
        create: false,
      });
      expect(github.releases).toHaveLength(1);

      const dest = tempDir();
      expect(yield* getHandoffs(client, { tag, names: ["cli-*"], dir: dest })).toEqual([
        "cli-linux-x64",
        "cli-win32-x64",
      ]);
      expect(NodeFS.readdirSync(dest).toSorted()).toEqual([
        "goat-linux-x64.tar.gz",
        "goat-win32-x64.tar.gz",
      ]);
      expect(NodeFS.readFileSync(NodePath.join(dest, "goat-linux-x64.tar.gz"), "utf8")).toBe(
        "rebuilt",
      );
    }),
  );

  it.effect("refuses tampered parts, missing hand-offs, missing drafts and empty inputs", () =>
    Effect.gen(function* () {
      const github = fakeGitHub();
      const client = yield* clientFor(github.fetch);
      const dir = tempDir();
      writeTree(dir, { "a.txt": "a".repeat(3000) });
      expect(
        (yield* putHandoff(client, {
          tag,
          target: "a".repeat(40),
          name: "x",
          dir,
          paths: [],
          create: false,
        }).pipe(Effect.flip)).message,
      ).toContain("No staging draft");
      yield* putHandoff(client, {
        tag,
        target: "a".repeat(40),
        name: "x",
        dir,
        paths: [],
        create: true,
        partBytes: 1024,
      });
      expect(
        (yield* getHandoffs(client, { tag, names: ["desktop-*"], dir: tempDir() }).pipe(
          Effect.flip,
        )).message,
      ).toContain("No complete hand-off matches desktop-*");
      github.releases[0]!.assets[1]!.bytes = new Uint8Array(1024);
      expect(
        (yield* getHandoffs(client, { tag, names: ["x"], dir: tempDir() }).pipe(Effect.flip))
          .message,
      ).toContain("does not match its manifest");
      expect(
        (yield* putHandoff(client, {
          tag,
          target: "a".repeat(40),
          name: "y",
          dir: tempDir(),
          paths: [],
          create: false,
        }).pipe(Effect.flip)).message,
      ).toContain("missing or empty");
      expect(
        (yield* putHandoff(client, {
          tag,
          target: "a".repeat(40),
          name: "y",
          dir,
          paths: ["../etc"],
          create: false,
        }).pipe(Effect.flip)).message,
      ).toContain("must be relative");
    }),
  );
});

describe("nightly staging cleanup", () => {
  const draft = (id: number, tagName: string, created: string, draftFlag = true): FakeRelease => ({
    id,
    tag_name: tagName,
    draft: draftFlag,
    prerelease: true,
    published_at: null,
    created_at: created,
    assets: [],
  });
  const asset = (id: number, name: string) => ({
    id,
    name,
    size: 1,
    state: "uploaded",
    bytes: new Uint8Array(1),
  });

  it.effect("deletes this run's draft and stale staging drafts only", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const github = fakeGitHub([
        draft(1, tag, "2026-10-18T23:00:00Z"),
        draft(2, "goat-nightly-staging-7", "2026-10-15T00:00:00Z"),
        draft(3, "goat-nightly-staging-8", "2026-10-18T12:00:00Z"),
        draft(4, "goat-nightly-staging-9", "2026-10-01T00:00:00Z", false),
        draft(5, "v1.0.0", "2026-10-01T00:00:00Z"),
      ]);
      const client = yield* clientFor(github.fetch);
      yield* cleanupStaging(client, { tag, keep: [], maxAgeHours: 72 });
      expect(github.releases.map((release) => release.id)).toEqual([3, 4, 5]);
      yield* cleanupStaging(client, { tag, keep: [], maxAgeHours: 72 });
      expect(github.releases.map((release) => release.id)).toEqual([3, 4, 5]);
    }),
  );

  it.effect("keeps only the selected hand-offs of a dry run", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const release = draft(1, tag, "2026-10-18T23:00:00Z");
      release.assets = [
        asset(10, "release-assets.tar.000"),
        asset(11, "release-assets.manifest.json"),
        asset(12, "js-bundle.tar.000"),
        asset(13, "js-bundle.manifest.json"),
      ];
      const github = fakeGitHub([release]);
      const client = yield* clientFor(github.fetch);
      yield* cleanupStaging(client, { tag, keep: ["release-assets"], maxAgeHours: 72 });
      expect(github.releases[0]!.assets.map((item) => item.name)).toEqual([
        "release-assets.tar.000",
        "release-assets.manifest.json",
      ]);
    }),
  );
});
