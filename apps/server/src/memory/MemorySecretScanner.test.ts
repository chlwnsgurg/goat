import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";
import { scanMemoryValue } from "./MemorySecretScanner.ts";

const decodePayload = Schema.decodeUnknownSync(M.MemoryPayload);

describe("MemorySecretScanner", () => {
  it("blocks fabricated tokens and PEM private keys", () => {
    const sentinel = "sk-" + "A".repeat(32);
    const result = scanMemoryValue({ text: sentinel, judgment: "-----BEGIN PRIVATE KEY-----" });
    assert.deepStrictEqual(result.kind === "blocked" ? result.ruleIds : [], [
      "pem_private_key",
      "provider_token",
    ]);
    assert.notInclude(JSON.stringify(result), sentinel);
  });
  it("screens input output judgment and originals", () => {
    const sentinel = "ghp_" + "Z".repeat(32);
    for (const field of ["payload", "result", "inputs", "originals", "resolutionPayload"])
      assert.strictEqual(
        scanMemoryValue({ [field]: [{ text: sentinel, judgment: sentinel }] }).kind,
        "blocked",
      );
    assert.strictEqual(scanMemoryValue({ messages: [{ text: sentinel }] }).kind, "blocked");
  });
  it("allows ordinary memory prose", () => {
    assert.deepStrictEqual(
      scanMemoryValue({ text: "Prefer targeted checks. Keep the default model options." }),
      { kind: "allowed" },
    );
    assert.deepStrictEqual(scanMemoryValue({ environmentId: "sk-" + "A".repeat(32) }), {
      kind: "allowed",
    });
  });
  it("unknown secret-bearing fields cannot enter operation encoding", () => {
    const payload = {
      text: "ordinary",
      evidence: [],
      derivedFromMemoryRevisions: [],
      secret: "sk-" + "A".repeat(32),
    };
    assert.throws(() => decodePayload(payload, { onExcessProperty: "error" }));
  });
  it("pre-admission blocked operation keeps metadata only", () => {
    const sentinel = "xoxb-" + "A".repeat(32);
    const result = scanMemoryValue({ payload: { text: sentinel } });
    assert.strictEqual(result.kind, "blocked");
    assert.notInclude(JSON.stringify(result), sentinel);
    assert.deepStrictEqual(Object.keys(result).sort(), ["inspectedBytes", "kind", "ruleIds"]);
  });
});
