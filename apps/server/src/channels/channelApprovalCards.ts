/**
 * Approve/deny cards for the approvals a GOAT Bot task's worker or its subagents wait on. A card is
 * sent once per runtime request; a reply is read without a model, so an approval never depends on
 * how a model understood the message. Which approvals are open comes from the task's observation,
 * which already drops a request once anyone answers it.
 *
 * @module channelApprovalCards
 */
import type {
  ChannelTask,
  ChannelTaskApprovalRef,
  OrchestrationV2RuntimeRequest,
  ProviderApprovalDecision,
} from "@goat/contracts";

export interface OpenApprovalCard {
  readonly task: ChannelTask;
  readonly approval: ChannelTaskApprovalRef;
  readonly code: string;
}

/** A short, stable code that tells cards apart in text transports and when several are open. */
export const approvalCode = (requestId: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < requestId.length; index += 1) {
    hash ^= requestId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 36 ** 3).toString(36).padStart(3, "0").toUpperCase();
};

export const openApprovalCards = (
  tasks: ReadonlyArray<ChannelTask>,
): ReadonlyArray<OpenApprovalCard> =>
  tasks.flatMap((task) =>
    (task.observed?.needsYou ?? []).flatMap((need) =>
      need.approval === undefined
        ? []
        : [{ task, approval: need.approval, code: approvalCode(need.approval.requestId) }],
    ),
  );

const ACCEPT = new Set(["approve", "approved", "allow", "accept", "승인", "허용"]);
const DECLINE = new Set(["deny", "denied", "decline", "reject", "거절", "거부"]);

/** Longer messages are conversation, not a card answer, and go to the model as usual. */
const MAX_REPLY_LENGTH = 80;

export interface ApprovalReply {
  readonly decision: Extract<ProviderApprovalDecision, "accept" | "decline">;
  /** What followed the verb: a card code, or nothing. */
  readonly target: string;
}

/** Reads "approve", "deny K3F", "승인" and the like; anything else is not a card answer. */
export const parseApprovalReply = (text: string): ApprovalReply | undefined => {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > MAX_REPLY_LENGTH) return undefined;
  const [first = "", ...rest] = trimmed.split(/\s+/);
  const verb = first.toLowerCase().replace(/[.!,:]+$/, "");
  const decision = ACCEPT.has(verb) ? "accept" : DECLINE.has(verb) ? "decline" : undefined;
  if (decision === undefined) return undefined;
  const target = rest
    .join(" ")
    .replace(/^[#:\-–—\s]+/, "")
    .replace(/[.!]+$/, "")
    .trim();
  return { decision, target };
};

export type ApprovalMatch =
  | { readonly type: "one"; readonly card: OpenApprovalCard }
  | { readonly type: "several"; readonly cards: ReadonlyArray<OpenApprovalCard> }
  /** A code that names no open card: that approval was answered or is gone. */
  | { readonly type: "gone" }
  | { readonly type: "none" };

const CODE = /^[0-9a-z]{3}$/i;
/** As a button sends it; a typed "approve all" is not a stale code. */
const SENT_CODE = /^[0-9A-Z]{3}$/;

/**
 * The card a reply answers: the only open one for a bare verb, else the one whose code it names.
 * Only a code picks a card: words like "approve the PR" are conversation, never an approval of
 * whatever a task with a matching title happens to be waiting on.
 */
export const matchApprovalCard = (
  cards: ReadonlyArray<OpenApprovalCard>,
  target: string,
): ApprovalMatch => {
  if (target === "") {
    if (cards.length === 0) return { type: "none" };
    return cards.length === 1 ? { type: "one", card: cards[0]! } : { type: "several", cards };
  }
  if (!CODE.test(target)) return { type: "none" };
  const named = cards.find((card) => card.code === target.toUpperCase());
  if (named !== undefined) return { type: "one", card: named };
  return SENT_CODE.test(target) ? { type: "gone" } : { type: "none" };
};

const actionPhrase = (kind: OrchestrationV2RuntimeRequest["kind"] | undefined): string => {
  switch (kind) {
    case "command":
      return "run a command";
    case "file-change":
      return "change files";
    case "file-read":
      return "read files";
    case "permission":
      return "use more permissions";
    default:
      return "go ahead";
  }
};

const MAX_PROMPT_CHARS = 400;

/**
 * The card's words and buttons. Buttons always carry the card's code, so an old card's button
 * can only ever answer its own request.
 */
export const approvalCard = (input: {
  readonly card: OpenApprovalCard;
  readonly bySubagent: boolean;
  readonly kind: OrchestrationV2RuntimeRequest["kind"] | undefined;
  readonly prompt: string | undefined;
}): { readonly text: string; readonly options: ReadonlyArray<string> } => {
  const prompt = input.prompt?.trim();
  const detail =
    prompt === undefined || prompt === ""
      ? ""
      : "\n" +
        (prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS - 1) + "…" : prompt);
  return {
    text:
      input.card.task.title +
      ": " +
      (input.bySubagent ? "a subagent" : "the agent") +
      " wants to " +
      actionPhrase(input.kind) +
      "." +
      detail,
    options: ["Approve " + input.card.code, "Deny " + input.card.code],
  };
};

/** The question asked when a bare "approve" could mean more than one card. */
export const whichApproval = (
  cards: ReadonlyArray<OpenApprovalCard>,
  decision: ApprovalReply["decision"],
): { readonly text: string; readonly options: ReadonlyArray<string> } => {
  const verb = decision === "accept" ? "Approve" : "Deny";
  const shown = cards.slice(0, 4);
  return {
    text:
      "More than one approval is waiting. Which one?\n" +
      shown.map((card) => "- " + card.code + ": " + card.task.title).join("\n"),
    options: shown.map((card) => verb + " " + card.code),
  };
};
