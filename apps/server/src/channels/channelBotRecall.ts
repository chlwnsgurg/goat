/**
 * What GOAT Bot can look up before it answers: its own memory (notes, journal, GOAT memory) and
 * the record of the work it started. These are the pure parts: who may see a task, which tasks a
 * query means, and how each result is cut to size. ChannelReceptionService runs the reads.
 *
 * @module channelBotRecall
 */
import type {
  ChannelConversationId,
  ChannelRequester,
  ChannelTask,
  ChannelTaskPullRequest,
} from "@goat/contracts";

/** Each read result is cut to this many characters before a pass sees it. */
export const RECALL_RESULT_CHARS = 4_000;
/** At most this many tasks answer one work read. */
export const RECALL_TASK_LIMIT = 5;
/** How many of the owner's newest tasks a work read searches. */
export const RECALL_TASK_SCAN = 200;
/** How many of a thread's newest messages a thread read returns. */
export const RECALL_THREAD_MESSAGES = 6;
const RECALL_MESSAGE_CHARS = 700;
const RECALL_FIELD_CHARS = 600;
/** At most this many memory lines or items answer one memory read. */
export const RECALL_MEMORY_LINES = 12;

/**
 * Whether a requester may see a task in GOAT Bot's answers. Everyone sees the work of the
 * conversation they are in. A person also sees work they asked for elsewhere, and all of the
 * owner's work when they may read GOAT's threads anyway. Agents over MCP see only their own
 * conversation, because their conversations are scoped to the agent.
 */
export const canSeeTask = (
  viewer: ChannelRequester,
  task: ChannelTask,
  conversationId: ChannelConversationId,
): boolean => {
  if (viewer.ownerId !== task.requester.ownerId) return false;
  if (task.conversationId === conversationId) return true;
  if (viewer.originKind === "mcp") return false;
  return (
    viewer.principalId === task.requester.principalId ||
    viewer.grantedScopes.includes("orchestration:read")
  );
};

const cut = (text: string, chars: number) =>
  text.length <= chars ? text : text.slice(0, chars - 1).trimEnd() + "…";

export const pullRequestLabel = (pr: ChannelTaskPullRequest) =>
  pr.repository + "#" + pr.number + " (" + (pr.state ?? "state unknown") + ")";

/** English filler that would otherwise match every task; other languages rarely collide. */
const FILLER = new Set(
  "the and for with what that this did does was were has have had about from into what's when where which who how why is it its are any all our you your can".split(
    " ",
  ),
);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}#_./-]+/u)
    .filter((word) => word.length >= 2 && !FILLER.has(word));

/** A pull request number ("#123", "123") or URL in a query. */
const pullRequestNumberIn = (query: string): number | undefined => {
  const match = /(?:pull\/|#)(\d+)\b/u.exec(query) ?? /^\s*(\d+)\s*$/u.exec(query);
  return match === null ? undefined : Number(match[1]);
};

/**
 * The tasks a query means, best first: an exact task id, then a pull request number or URL the
 * task linked, then the tasks sharing the most words with the query. An empty or generic query
 * returns the newest tasks.
 */
export const matchTasks = (
  tasks: ReadonlyArray<ChannelTask>,
  query: string,
  limit = RECALL_TASK_LIMIT,
): ReadonlyArray<ChannelTask> => {
  const trimmed = query.trim();
  const exact = tasks.filter((task) => task.taskId === trimmed);
  if (exact.length > 0) return exact;
  const prNumber = pullRequestNumberIn(trimmed);
  if (prNumber !== undefined) {
    const linked = tasks.filter((task) =>
      (task.observed?.pullRequests ?? []).some(
        (pr) => pr.number === prNumber || trimmed.includes(pr.url),
      ),
    );
    if (linked.length > 0) return linked.slice(0, limit);
  }
  const wanted = new Set(words(trimmed));
  if (wanted.size === 0) return tasks.slice(0, limit);
  return tasks
    .map((task, index) => {
      const haystack = new Set(
        words(
          [
            task.title,
            task.instruction,
            task.resultSummary ?? "",
            task.host ?? "",
            ...(task.observed?.pullRequests ?? []).map((pr) => pr.repository + " " + pr.url),
          ].join(" "),
        ),
      );
      let score = 0;
      for (const word of wanted) if (haystack.has(word)) score += 1;
      return { task, index, score };
    })
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.task);
};

/** One task as GOAT Bot reads it back: what was asked, where it ran, and how it ended. */
export const taskDigest = (task: ChannelTask): string => {
  const prs = (task.observed?.pullRequests ?? []).map(pullRequestLabel);
  const lines = [
    "task " + task.taskId + " [" + task.status + "] " + task.title,
    "  asked by " + task.requester.displayName + " on " + task.createdAt.slice(0, 16),
    ...(task.host === undefined && task.worker?.host === undefined
      ? []
      : ["  runs on " + (task.worker?.host ?? task.host)]),
    "  request: " + cut(task.instruction.replace(/\s+/gu, " "), RECALL_FIELD_CHARS),
    ...(task.resultSummary === undefined || task.resultSummary.trim() === ""
      ? []
      : ["  result: " + cut(task.resultSummary, RECALL_FIELD_CHARS)]),
    ...(task.completionReport === "missing"
      ? ["  the worker ended without filing a final report"]
      : []),
    ...(prs.length === 0 ? [] : ["  pull requests: " + prs.join(", ")]),
    ...task.openQuestions.map((question) => "  open question: " + question.text),
    ...(task.completedAt === undefined ? [] : ["  ended " + task.completedAt.slice(0, 16)]),
  ];
  return lines.join("\n");
};

/** Lines of the notes and journal that share a word with the query, newest first. */
export const matchMemoryLines = (text: string, query: string, limit = RECALL_MEMORY_LINES) => {
  const wanted = words(query);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const matched =
    wanted.length === 0
      ? lines
      : lines.filter((line) => {
          const lower = line.toLowerCase();
          return wanted.some((word) => lower.includes(word));
        });
  return matched.toReversed().slice(0, limit);
};

export interface RecallMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
}

/** The newest messages of a thread, oldest first, each cut to size. */
export const threadDigest = (title: string, messages: ReadonlyArray<RecallMessage>) => {
  const newest = messages
    .filter((message) => message.role !== "system" && message.text.trim() !== "")
    .slice(-RECALL_THREAD_MESSAGES);
  return [
    "thread " + JSON.stringify(title) + ", newest " + newest.length + " messages:",
    ...newest.map(
      (message) =>
        "- " +
        message.createdAt.slice(0, 16) +
        " " +
        (message.role === "user" ? "request" : "agent") +
        ": " +
        cut(message.text.replace(/\s+/gu, " ").trim(), RECALL_MESSAGE_CHARS),
    ),
  ].join("\n");
};

/** A read result cut to RECALL_RESULT_CHARS, keeping its start. */
export const boundRecall = (text: string) => cut(text, RECALL_RESULT_CHARS);
