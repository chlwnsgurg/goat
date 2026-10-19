import type { OrchestratorMcpThreadStatusResult } from "@goat/contracts";

/**
 * Whether a self-healing worker is stuck, from one goat_thread_status read. Stateless: the
 * thread's own lastActivityAt moves on every event, token batch or item the projection writes,
 * so no tick needs to remember the previous read.
 *
 * usage_limit is not a stall here: UsageLimitRecoveryWorker continues those after the reset and
 * fallback chains belong to the resources work. Requests are never answered on anyone's behalf;
 * an old one is reported so the owner hears about it.
 */
export const STALL_THRESHOLDS = {
  /** Running or waiting with no recorded activity for this long. */
  noProgressMs: 20 * 60_000,
  /** Accepted but not started for this long. */
  startingMs: 10 * 60_000,
  /** A question or approval nobody answered for this long. */
  unansweredRequestMs: 60 * 60_000,
} as const;
export type StallThresholds = typeof STALL_THRESHOLDS;

export type StallReason =
  | { readonly type: "no_progress"; readonly idleMs: number }
  | {
      readonly type: "unanswered_request";
      readonly waitingMs: number;
      readonly kind: string | null;
    }
  | {
      readonly type: "retryable_failure";
      readonly failureClass: "transport_error" | "provider_error";
    };

type StatusFields = Pick<
  OrchestratorMcpThreadStatusResult,
  | "phase"
  | "run"
  | "pendingRequest"
  | "lastActivityAt"
  | "lastMessage"
  | "lastError"
  | "lastErrorClass"
>;

// For hosts older than lastErrorClass: the provider and transport errors adapters report.
const TRANSPORT_TEXT =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network error|connection (reset|closed|lost)|stream (closed|ended)|timed out/i;
const PROVIDER_TEXT =
  /overloaded|internal server error|bad gateway|service unavailable|\b5\d\d\b|rate.?limited/i;
const USAGE_LIMIT_TEXT = /usage limit|quota/i;

export function failureClassOf(
  status: Pick<StatusFields, "lastError" | "lastErrorClass">,
): "transport_error" | "provider_error" | null {
  const declared = status.lastErrorClass;
  if (declared !== undefined && declared !== null) {
    return declared === "transport_error" || declared === "provider_error" ? declared : null;
  }
  const text = status.lastError ?? "";
  if (text.length === 0 || USAGE_LIMIT_TEXT.test(text)) return null;
  if (TRANSPORT_TEXT.test(text)) return "transport_error";
  if (PROVIDER_TEXT.test(text)) return "provider_error";
  return null;
}

const ms = (iso: string | null | undefined) => {
  if (iso === null || iso === undefined) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};

export function detectStall(
  status: StatusFields,
  now: number,
  thresholds: StallThresholds = STALL_THRESHOLDS,
): StallReason | null {
  switch (status.phase) {
    case "failed": {
      const failureClass = failureClassOf(status);
      return failureClass === null ? null : { type: "retryable_failure", failureClass };
    }
    case "waiting_input":
    case "waiting_approval": {
      const since = ms(status.pendingRequest?.since) ?? ms(status.lastActivityAt);
      if (since === null || now - since < thresholds.unansweredRequestMs) return null;
      return {
        type: "unanswered_request",
        waitingMs: now - since,
        kind: status.pendingRequest?.kind ?? null,
      };
    }
    case "starting": {
      const since = ms(status.run?.requestedAt) ?? ms(status.lastActivityAt);
      if (since === null || now - since < thresholds.startingMs) return null;
      return { type: "no_progress", idleMs: now - since };
    }
    case "running":
    case "waiting": {
      const last = Math.max(
        ms(status.lastActivityAt) ?? 0,
        ms(status.lastMessage?.at) ?? 0,
        ms(status.run?.startedAt) ?? 0,
      );
      if (last === 0 || now - last < thresholds.noProgressMs) return null;
      return { type: "no_progress", idleMs: now - last };
    }
    default:
      // idle, queued (capacity, not a stall) and the other terminal phases.
      return null;
  }
}
