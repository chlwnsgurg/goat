/**
 * Builds the git-style patch of one edit, so a client can show what that tool call changed,
 * mid-turn and apart from other edits to the same file. Clients parse it with the same parser
 * as checkpoint diffs, so every file gets a `diff --git` header.
 */

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

// Git C-quotes a path holding a control character, a quote or a backslash; the parser decodes it.
function headerPath(prefix: "a/" | "b/", path: string): string {
  const prefixed = `${prefix}${path}`;
  let quoted = "";
  let needsQuotes = false;
  for (const character of prefixed) {
    const code = character.charCodeAt(0);
    const escaped =
      character === '"' || character === "\\"
        ? `\\${character}`
        : character === "\t"
          ? "\\t"
          : character === "\n"
            ? "\\n"
            : character === "\r"
              ? "\\r"
              : code < 0x20 || code === 0x7f
                ? `\\${code.toString(8).padStart(3, "0")}`
                : character;
    needsQuotes ||= escaped !== character;
    quoted += escaped;
  }
  return needsQuotes ? `"${quoted}"` : prefixed;
}

function contentLines(content: string, marker: "+" | "-"): string {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = body.split("\n").map((line) => `${marker}${line}`);
  if (!content.endsWith("\n")) lines.push("\\ No newline at end of file");
  return lines.join("\n");
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

function wholeFileSection(path: string, content: string, kind: "add" | "delete"): string {
  const count = lineCount(content);
  const header =
    kind === "add"
      ? ["new file mode 100644", "--- /dev/null", `+++ ${headerPath("b/", path)}`]
      : ["deleted file mode 100644", `--- ${headerPath("a/", path)}`, "+++ /dev/null"];
  const hunk =
    count === 0
      ? []
      : [
          kind === "add" ? `@@ -0,0 +1,${count} @@` : `@@ -1,${count} +0,0 @@`,
          contentLines(content, kind === "add" ? "+" : "-"),
        ];
  return [
    `diff --git ${headerPath("a/", path)} ${headerPath("b/", path)}`,
    ...header,
    ...hunk,
  ].join("\n");
}

function updateSection(path: string, hunks: string, oldPath = path): string {
  const lines = [`diff --git ${headerPath("a/", oldPath)} ${headerPath("b/", path)}`];
  if (oldPath !== path) {
    lines.push(`rename from ${oldPath}`, `rename to ${path}`);
  }
  if (hunks.length > 0) {
    lines.push(`--- ${headerPath("a/", oldPath)}`, `+++ ${headerPath("b/", path)}`, hunks);
  }
  return lines.join("\n");
}

/** The hunks of unified diff text, dropping any file header before the first one. */
function hunksOf(diff: string): string | undefined {
  const start = diff.search(HUNK_HEADER);
  return start === -1 ? undefined : diff.slice(start).replace(/\n+$/, "");
}

/**
 * A Codex apply_patch item. Codex sends whole file content for an added or deleted file and
 * the hunks of a unified diff for an update. Undefined when an update's diff has no hunk.
 */
export function codexFileChangePatch(
  changes: ReadonlyArray<{
    readonly path: string;
    readonly diff: string;
    readonly kind:
      | { readonly type: "add" }
      | { readonly type: "delete" }
      | { readonly type: "update"; readonly move_path?: string | null | undefined };
  }>,
): string | undefined {
  const sections: Array<string> = [];
  for (const change of changes) {
    switch (change.kind.type) {
      case "add":
      case "delete":
        sections.push(wholeFileSection(change.path, change.diff, change.kind.type));
        break;
      case "update": {
        const movedTo = change.kind.move_path ?? undefined;
        const hunks = change.diff.trim().length === 0 ? "" : hunksOf(change.diff);
        if (hunks === undefined) return undefined;
        if (hunks.length === 0 && movedTo === undefined) break;
        sections.push(updateSection(movedTo ?? change.path, hunks, change.path));
        break;
      }
    }
  }
  return sections.length === 0 ? undefined : `${sections.join("\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claudeHunk(hunk: unknown): string | undefined {
  if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return undefined;
  const { oldStart, oldLines, newStart, newLines } = hunk;
  if (
    typeof oldStart !== "number" ||
    typeof oldLines !== "number" ||
    typeof newStart !== "number" ||
    typeof newLines !== "number"
  ) {
    return undefined;
  }
  const lines = hunk.lines.filter((line): line is string => typeof line === "string");
  return [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...lines].join("\n");
}

/**
 * A Claude Code Edit, MultiEdit, or Write result. Its structuredPatch hunks carry real line
 * numbers; a created file carries its content instead. Staged writes changed nothing.
 */
export function claudeFileChangePatch(path: string, result: unknown): string | undefined {
  if (!isRecord(result) || result.staged === true) return undefined;
  const filePath = typeof result.filePath === "string" && result.filePath ? result.filePath : path;
  const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch : undefined;
  if (hunks !== undefined && hunks.length > 0) {
    const rendered = hunks.map(claudeHunk);
    if (rendered.some((hunk) => hunk === undefined)) return undefined;
    return `${updateSection(filePath, rendered.join("\n"))}\n`;
  }
  if (result.type === "create" && typeof result.content === "string") {
    return `${wholeFileSection(filePath, result.content, "add")}\n`;
  }
  return undefined;
}
