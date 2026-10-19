/**
 * GOAT Bot's notes and skills: plain files on the bot's home machine that every reception pass
 * reads and every worker can open.
 *
 * `memory.md` holds standing notes the people using the bot asked it to keep, one line each,
 * newest last. Reception appends to it; editing or deleting a note is ordinary file work for a
 * worker. `journal.md` is the bot's own record of the work it started and how each ended; only
 * the server writes it, so a message cannot plant instructions in it. `skills/*.md` holds written
 * procedures; reception sees each by name and first line, and workers read the file itself.
 * Slack and the GOAT bot share one reception, so they share these files too.
 *
 * @module channelBotNotes
 */
import type { ChannelReceptionSkill } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The newest part of the notes reception reads, in characters. */
const NOTES_READ_CHARS = 6_000;
const NOTE_MAX_CHARS = 500;
const SKILLS_LIMIT = 20;
const SKILL_SUMMARY_CHARS = 200;
/** The newest part of the journal every reception pass sees, in characters. */
const JOURNAL_READ_CHARS = 3_000;
const JOURNAL_LINE_CHARS = 400;
/** Past this size the oldest journal lines are dropped on the next write. */
export const JOURNAL_MAX_CHARS = 64_000;

const NOTES_HEADER =
  "# GOAT Bot notes\n\nStanding notes people asked GOAT Bot to keep, newest last. Edit or delete lines freely.\n\n";
const JOURNAL_HEADER =
  "# GOAT Bot journal\n\nWork GOAT Bot started and how it ended, newest last. GOAT writes this file.\n\n";

export interface ChannelBotFiles {
  readonly dir: string;
  readonly notes: string;
  readonly journal: string;
  readonly skills: string;
}

export const channelBotFilesFor = (path: Path.Path, stateDir: string): ChannelBotFiles => {
  const dir = path.join(stateDir, "goat-bot");
  return {
    dir,
    notes: path.join(dir, "memory.md"),
    journal: path.join(dir, "journal.md"),
    skills: path.join(dir, "skills"),
  };
};

/** The newest notes, or an empty string when there are none or they cannot be read. */
export const readChannelBotNotes = (fs: FileSystem.FileSystem, files: ChannelBotFiles) =>
  Effect.gen(function* () {
    const text = yield* fs.readFileString(files.notes);
    const body = text.startsWith(NOTES_HEADER) ? text.slice(NOTES_HEADER.length) : text;
    return body.length <= NOTES_READ_CHARS ? body.trim() : body.slice(-NOTES_READ_CHARS).trim();
  }).pipe(Effect.orElseSucceed(() => ""));

/**
 * Appends one note as a single dated line, naming the channel input that asked for it. A note
 * for an input already named in the file is not added again, so a repeated pass is harmless.
 */
export const appendChannelBotNote = (
  fs: FileSystem.FileSystem,
  files: ChannelBotFiles,
  note: string,
  date: string,
  sourceInputId: string,
) =>
  Effect.gen(function* () {
    const line = note.replace(/\s+/gu, " ").trim().slice(0, NOTE_MAX_CHARS);
    if (line === "") return;
    const source = " (asked in " + sourceInputId.replace(/\s+/gu, "") + ")";
    yield* fs.makeDirectory(files.dir, { recursive: true });
    const exists = yield* fs.exists(files.notes);
    if (exists && (yield* fs.readFileString(files.notes)).includes(source)) return;
    yield* fs.writeFileString(
      files.notes,
      (exists ? "" : NOTES_HEADER) + "- " + date.slice(0, 10) + ": " + line + source + "\n",
      { flag: "a" },
    );
  });

/**
 * The journal's lines without its header, oldest first: all of them for a search, or the newest
 * JOURNAL_READ_CHARS for a reception pass's context.
 */
export const readChannelBotJournal = (
  fs: FileSystem.FileSystem,
  files: ChannelBotFiles,
  options: { readonly whole?: boolean } = {},
) =>
  Effect.gen(function* () {
    const text = yield* fs.readFileString(files.journal);
    const body = (
      text.startsWith(JOURNAL_HEADER) ? text.slice(JOURNAL_HEADER.length) : text
    ).trim();
    if (options.whole === true || body.length <= JOURNAL_READ_CHARS) return body;
    const tail = body.slice(-JOURNAL_READ_CHARS);
    const firstBreak = tail.indexOf("\n");
    return firstBreak === -1 ? tail : tail.slice(firstBreak + 1);
  }).pipe(Effect.orElseSucceed(() => ""));

/**
 * Adds one journal line keyed by the ledger event it records, so a replayed narration writes it
 * once. The file keeps the newest JOURNAL_MAX_CHARS; older lines are dropped whole.
 */
export const appendChannelBotJournal = (
  fs: FileSystem.FileSystem,
  files: ChannelBotFiles,
  entry: string,
  date: string,
  key: string,
) =>
  Effect.gen(function* () {
    const line = entry.replace(/\s+/gu, " ").trim().slice(0, JOURNAL_LINE_CHARS);
    if (line === "") return;
    const marker = " [" + key.replace(/[\s\]]+/gu, "") + "]";
    yield* fs.makeDirectory(files.dir, { recursive: true });
    const current = (yield* fs.exists(files.journal))
      ? yield* fs.readFileString(files.journal)
      : JOURNAL_HEADER;
    if (current.includes(marker)) return;
    const body = current.startsWith(JOURNAL_HEADER)
      ? current.slice(JOURNAL_HEADER.length)
      : current;
    let next = body + "- " + date.slice(0, 16).replace("T", " ") + " " + line + marker + "\n";
    while (next.length > JOURNAL_MAX_CHARS) {
      const firstBreak = next.indexOf("\n");
      if (firstBreak === -1) break;
      next = next.slice(firstBreak + 1);
    }
    yield* fs.writeFileString(files.journal, JOURNAL_HEADER + next);
  });

/**
 * Whether `quote` occurs in the person's message, ignoring differences in whitespace. Used to
 * check that a note request the model reports came from the current input.
 */
export const quotedFromInput = (quote: string, input: string): boolean => {
  const collapse = (text: string) => text.replace(/\s+/gu, " ").trim();
  const needle = collapse(quote);
  return needle !== "" && collapse(input).includes(needle);
};

/** Skills by file name and first line, alphabetically. A missing folder means none. */
export const listChannelBotSkills = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  files: ChannelBotFiles,
) =>
  Effect.gen(function* () {
    const names = (yield* fs.readDirectory(files.skills))
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .toSorted()
      .slice(0, SKILLS_LIMIT);
    return yield* Effect.forEach(names, (name) =>
      fs.readFileString(path.join(files.skills, name)).pipe(
        Effect.map((text): ChannelReceptionSkill => {
          const first =
            text
              .split("\n")
              .map((line) => line.replace(/^#+\s*/u, "").trim())
              .find((line) => line !== "") ?? "";
          return { name: name.slice(0, -3), summary: first.slice(0, SKILL_SUMMARY_CHARS) };
        }),
        Effect.orElseSucceed((): ChannelReceptionSkill => ({
          name: name.slice(0, -3),
          summary: "",
        })),
      ),
    );
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<ChannelReceptionSkill> => []));
