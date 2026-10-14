import { assert, describe, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk/Git fixture uses Node directly, without application services.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk/Git fixture uses Node directly, without application services.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  MEMORY_IMPORT_FIXTURE_PROFILES,
  buildMemoryImportFault,
  buildMemoryImportFixture,
  captureMemoryImportInventory,
  makeMemoryImportWorkload,
  snapshotMemoryImportFiles,
} from "./MemoryImportFixtures.fixture.ts";

describe("MemoryImportFixtures frozen API", () => {
  it.effect.each(MEMORY_IMPORT_FIXTURE_PROFILES)(
    "same seed fixes %s bytes, digest and OID",
    (profile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const a = yield* buildMemoryImportFixture(profile);
          const b = yield* buildMemoryImportFixture(profile);
          const changed = yield* buildMemoryImportFixture(profile, { seed: "different-seed" });
          assert.notEqual(a.sandbox, b.sandbox);
          assert.deepEqual(a.snapshot, b.snapshot);
          assert.notEqual(a.snapshot.snapshotDigest, changed.snapshot.snapshotDigest);
          assert.deepEqual(a.discovered.slot, a.snapshot.slot);
          assert.deepEqual(
            captureMemoryImportInventory(a.sourceRoot),
            captureMemoryImportInventory(b.sourceRoot),
          );
          for (const file of a.snapshot.files) {
            assert.equal(file.byteCount, Buffer.byteLength(file.text));
            if (profile !== "omo-memory-core-beta63")
              assert.equal(
                NodeFS.readFileSync(NodePath.join(a.sourceRoot, file.selector), "utf8"),
                file.text,
              );
          }
          if (profile === "omo-memory-core-beta63") {
            assert.match(a.snapshot.commitOid!, /^[0-9a-f]{40}$/);
            assert.notEqual(
              NodeFS.readFileSync(
                NodePath.join(a.sourceRoot, a.snapshot.files[0]!.selector),
                "utf8",
              ),
              a.snapshot.files[0]!.text,
            );
            const inventory = captureMemoryImportInventory(a.sourceRoot);
            for (const name of [
              ".git/config",
              ".git/HEAD",
              ".git/index",
              ".git/refs/heads/fixture",
              "untracked.md",
            ]) {
              assert.ok(inventory.entries.some((entry) => entry.path === name));
            }
            assert.ok(
              inventory.entries.some(
                (entry) => entry.path.startsWith(".git/objects/") && entry.kind === "file",
              ),
            );
          }
        }),
      ),
  );

  it.effect("Scope removes the entire sandbox on success and failure", () =>
    Effect.gen(function* () {
      for (const fail of [false, true]) {
        let sandbox = "";
        const result = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const fixture = yield* buildMemoryImportFixture("omo-memory-core-beta63");
              sandbox = fixture.sandbox;
              assert.ok(NodeFS.existsSync(fixture.sourceRoot));
              assert.ok(NodeFS.existsSync(fixture.stateDir));
              if (fail) return yield* Effect.fail("synthetic failure");
            }),
          ),
        );
        try {
          assert.equal(Exit.isFailure(result), fail);
          assert.notEqual(sandbox, "");
          assert.equal(NodeFS.existsSync(sandbox), false);
        } finally {
          // Keep the red cleanup proof itself from leaking its deliberately broken sandbox.
          if (sandbox) NodeFS.rmSync(sandbox, { recursive: true, force: true });
        }
      }
    }),
  );

  it.effect(
    "negative disk trees preserve their pre-fault snapshot and inventory observes changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const fault of [
            "symlink-root",
            "symlink-ancestor",
            "symlink-file",
            "traversal",
            "malformed-utf8",
            "nul",
            "oversized-file",
            "secret-header",
          ] as const) {
            const fixture = yield* buildMemoryImportFixture("claude-topic-v1");
            const before = captureMemoryImportInventory(fixture.sandbox);
            const snapshot = JSON.stringify(fixture.snapshot);
            const input = buildMemoryImportFault(fixture, fault);
            assert.equal(JSON.stringify(fixture.snapshot), snapshot);
            if (fault === "traversal") assert.equal(input.slot.selection, "../outside");
            else
              assert.notEqual(captureMemoryImportInventory(fixture.sandbox).digest, before.digest);
            if (fault === "malformed-utf8")
              assert.throws(() =>
                new TextDecoder("utf-8", { fatal: true }).decode(
                  NodeFS.readFileSync(NodePath.join(fixture.sourceRoot, "fixture.md")),
                ),
              );
            if (fault === "oversized-file")
              assert.equal(
                NodeFS.readFileSync(NodePath.join(fixture.sourceRoot, "fixture.md")).length,
                262_145,
              );
          }
        }),
      ),
  );

  it.effect("constructs bounded synthetic Git refusal cases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const fault of [
          "git-symlink",
          "gitlink",
          "gitfile",
          "commondir",
          "alternates",
          "http-alternates",
          "metadata-symlink",
          "config-include",
          "missing-object",
        ] as const) {
          const fixture = yield* buildMemoryImportFixture("omo-memory-core-beta63");
          const before = captureMemoryImportInventory(fixture.sourceRoot);
          buildMemoryImportFault(fixture, fault);
          assert.notEqual(captureMemoryImportInventory(fixture.sourceRoot).digest, before.digest);
        }
      }),
    ),
  );

  it.effect("text override and pure snapshot cloning expose exact parser inputs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1", {
          files: { "extensions/ad_hoc/notes/synthetic.md": "Exact synthetic bytes\n" },
        });
        assert.deepEqual(fixture.snapshot.files, [
          {
            selector: "extensions/ad_hoc/notes/synthetic.md",
            text: "Exact synthetic bytes\n",
            byteCount: 22,
          },
        ]);
        const cloned = snapshotMemoryImportFiles(fixture.snapshot, [
          { selector: "../unsafe.md", text: "\0", byteCount: 1 },
        ]);
        assert.notEqual(cloned.snapshotDigest, fixture.snapshot.snapshotDigest);
        assert.equal(cloned.files[0]!.selector, "../unsafe.md");
        assert.equal(fixture.snapshot.files[0]!.text, "Exact synthetic bytes\n");
      }),
    ),
  );

  it("fixes the physical-growth workload at 16 bodies and 64 stable aliases", () => {
    const initial = makeMemoryImportWorkload();
    const changed = makeMemoryImportWorkload(1);
    assert.deepEqual(initial, makeMemoryImportWorkload());
    assert.equal(initial.length, 16);
    assert.equal(new Set(initial.map((item) => item.body)).size, 16);
    assert.equal(new Set(initial.flatMap((item) => item.aliases)).size, 64);
    for (const [index, item] of initial.entries()) {
      assert.equal(Buffer.byteLength(item.body), 4096);
      assert.equal(Buffer.byteLength(changed[index]!.body), 4096);
      assert.notEqual(item.body, changed[index]!.body);
      assert.deepEqual(item.aliases, changed[index]!.aliases);
    }
  });
});
