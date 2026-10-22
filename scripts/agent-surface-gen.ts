// @effect-diagnostics nodeBuiltinImport:off - a plain Node script that renders one file from the registry; no Effect runtime.
/**
 * Renders docs/llms.txt, the compact agent surface index, from
 * agentSurfaceRegistry. agent-surface-gen.test.ts fails CI when the committed
 * file differs from renderLlmsTxt().
 *
 *   node scripts/agent-surface-gen.ts           # rewrite docs/llms.txt
 *   node scripts/agent-surface-gen.ts --check   # exit 1 when docs/llms.txt is stale
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";

type Entry = (typeof agentSurfaceRegistry)[keyof typeof agentSurfaceRegistry];

export const LLMS_TXT_PATH = NodePath.resolve(import.meta.dirname, "../docs/llms.txt");

const HEADER = [
  "# GOAT agent surface",
  "",
  "> Every capability an agent can reach in GOAT, listed by `resource.verb` path. Generated from packages/contracts/src/agentSurface/registry.ts by scripts/agent-surface-gen.ts; run `vp run agent-surface:gen` instead of editing this file.",
  "",
  "Each line reads `path — summary (effect; MCP tool name; flags)`. The effect is read, write, or destructive. host-routable means the tool accepts `host` to act on another connected machine. thread only means the caller must be an agent running inside a GOAT thread, and client only means it needs a signed-in client session.",
  "",
  "When the goat_describe and goat_call tools are available, use goat_describe to read a path's arguments and goat_call to run it by path. Otherwise call the MCP tool named on the line.",
  "",
  "The design and rollout of these paths are in [docs/internals/agent-surface.md](internals/agent-surface.md).",
];

const REQUIRES_FLAG = { thread: "thread only", client: "client only", either: null } as const;

// Code-unit comparison so the order does not depend on the machine's locale.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const renderLine = (entry: Entry) => {
  const notes = [
    entry.effect,
    entry.name,
    entry.hostRoutable ? "host-routable" : null,
    REQUIRES_FLAG[entry.requires],
  ].filter((note) => note !== null);
  const summary = entry.summary.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return "- " + entry.path + " — " + summary + " (" + notes.join("; ") + ")";
};

export const renderLlmsTxt = (
  entries: ReadonlyArray<Entry> = Object.values(agentSurfaceRegistry),
): string => {
  const sorted = [...entries].sort(
    (a, b) => compare(a.resource, b.resource) || compare(a.verb, b.verb),
  );
  const sections: Array<string> = [];
  let resource: string | undefined;
  for (const entry of sorted) {
    if (entry.resource !== resource) {
      resource = entry.resource;
      sections.push("", "## " + resource, "");
    }
    sections.push(renderLine(entry));
  }
  return [...HEADER, ...sections, ""].join("\n");
};

const staleSummary = (current: string, fresh: string) => {
  const currentLines = new Set(current.split("\n"));
  const freshLines = new Set(fresh.split("\n"));
  const removed = [...currentLines].filter((line) => line !== "" && !freshLines.has(line));
  const added = [...freshLines].filter((line) => line !== "" && !currentLines.has(line));
  const show = (sign: string, lines: ReadonlyArray<string>) =>
    lines.slice(0, 10).map((line) => sign + " " + line);
  const more =
    removed.length + added.length - Math.min(removed.length, 10) - Math.min(added.length, 10);
  return [
    "docs/llms.txt is stale (+" + added.length + " -" + removed.length + " lines):",
    ...show("-", removed),
    ...show("+", added),
    ...(more > 0 ? ["... and " + more + " more"] : []),
    "Run: vp run agent-surface:gen",
  ].join("\n");
};

if (import.meta.main) {
  const fresh = renderLlmsTxt();
  if (process.argv.includes("--check")) {
    const current = NodeFS.existsSync(LLMS_TXT_PATH)
      ? NodeFS.readFileSync(LLMS_TXT_PATH, "utf8")
      : "";
    if (current !== fresh) {
      process.stderr.write(staleSummary(current, fresh) + "\n");
      process.exitCode = 1;
    }
  } else {
    NodeFS.writeFileSync(LLMS_TXT_PATH, fresh);
    process.stdout.write("Wrote docs/llms.txt\n");
  }
}
