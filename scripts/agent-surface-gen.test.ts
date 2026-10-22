// @effect-diagnostics nodeBuiltinImport:off - compares a committed file with its generator's output.
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";

import { LLMS_TXT_PATH, renderLlmsTxt } from "./agent-surface-gen.ts";

it("docs/llms.txt matches the agent surface registry", () => {
  expect(
    NodeFS.readFileSync(LLMS_TXT_PATH, "utf8"),
    "docs/llms.txt is stale. Run: vp run agent-surface:gen",
  ).toBe(renderLlmsTxt());
});
