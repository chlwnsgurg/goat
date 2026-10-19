import {
  formatGoatBotStamp,
  goatBotReceiptLabel,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { BellIcon, CircleAlertIcon, MessageCircleQuestionIcon } from "~/components/solar";
import {
  Fragment,
  type UIEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "~/timestampFormat";

import { MemorySettingsEntry } from "../settings/MemorySettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GoatBotTaskChip } from "./GoatBotTaskChip";

/** How close to the bottom still counts as "following" new messages. */
const FOLLOW_THRESHOLD_PX = 48;

/**
 * Reception gives up after 45 seconds and then sends a failure note, so a reply that has not
 * come by this point is not coming. The indicator stops instead of spinning forever.
 */
const REPLYING_LIMIT_MS = 90_000;

/** Each dot hops a beat after the one before it, so the three read as a wave. */
const TYPING_DOT_DELAYS = ["0ms", "150ms", "300ms"] as const;

export function GoatBotTimeline({
  rows,
  replyingSince = null,
  onRetry,
  onPick,
}: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly replyingSince?: string | null;
  readonly onRetry: (clientKey: string) => void;
  /** Sends a question's choice as the user's answer; absent while the bot can't take messages. */
  readonly onPick?: ((answer: string) => void) | undefined;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [nowMs] = useState(() => Date.now());
  const replying = useReplying(replyingSince);
  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    followingRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
  };
  // New rows and the replying bubble keep the view pinned to the latest message unless the
  // reader scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if ((rows.length === 0 && !replying) || element === null || !followingRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [rows, replying]);

  const time = (iso: string) => formatShortTimestamp(iso, timestampFormat);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-stable"
    >
      <ol
        aria-label="Conversation with GOAT Bot"
        className="mx-auto flex w-full max-w-3xl flex-col px-4 py-4"
      >
        {rows.map((row, index) => {
          switch (row.kind) {
            case "day":
              return (
                <li key={row.id} className="mt-4 mb-1 text-center text-2xs text-muted-foreground">
                  {formatGoatBotStamp(row.at, nowMs, time)}
                </li>
              );
            case "user": {
              const delivery = row.delivery;
              return (
                <li
                  key={row.id}
                  className={cn(
                    "flex flex-col items-end",
                    index > 1 && (row.firstInGroup ? "mt-2.5" : "mt-0.5"),
                  )}
                >
                  <div
                    className={cn(
                      "flex max-w-full items-end",
                      delivery.state === "failed" && delivery.rejectionReason === undefined
                        ? "gap-7"
                        : "gap-2",
                    )}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <div
                            className={cn(
                              "goat-bubble bg-goat-bubble-out text-goat-bubble-out-foreground",
                              (row.groupPosition === "single" || row.groupPosition === "last") &&
                                "goat-bubble-tail-out",
                            )}
                          />
                        }
                      >
                        {row.text}
                      </TooltipTrigger>
                      <TooltipPopup side="top">{time(row.createdAt)}</TooltipPopup>
                    </Tooltip>
                    {delivery.state === "failed" && delivery.rejectionReason === undefined ? (
                      <button
                        type="button"
                        aria-label="Retry sending"
                        onClick={() => onRetry(delivery.clientKey)}
                        className="mb-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive text-white"
                      >
                        <CircleAlertIcon className="size-4" />
                        <span className="sr-only">Retry</span>
                      </button>
                    ) : null}
                  </div>
                  {row.delivery.state === "failed" ? (
                    <span className="mt-1 text-2xs font-medium text-destructive-foreground">
                      {row.delivery.rejectionReason ?? "Not Delivered"}
                    </span>
                  ) : row.showReceipt ? (
                    <span
                      className="mt-1 text-2xs font-medium text-muted-foreground"
                      aria-label={goatBotReceiptLabel(row.delivery, time)?.accessibleText}
                    >
                      {goatBotReceiptLabel(row.delivery, time)?.text}
                    </span>
                  ) : null}
                </li>
              );
            }
            case "bot":
              return (
                <Fragment key={row.id}>
                  <li
                    className={cn(
                      "flex flex-col items-start",
                      index > 1 && (row.firstInGroup ? "mt-2.5" : "mt-0.5"),
                    )}
                  >
                    {row.proactive && row.firstInGroup ? (
                      <div className="mb-1.5 flex items-center gap-1 text-2xs text-muted-foreground">
                        <BellIcon className="size-3" aria-hidden />
                        GOAT Bot · Update
                      </div>
                    ) : null}
                    {row.replyTo ? (
                      <blockquote className="goat-reply-line mb-1 ml-2 max-w-[min(75%,34rem)] px-2 pt-1 text-xs text-muted-foreground">
                        <span className="block truncate">{row.replyTo}</span>
                      </blockquote>
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <div
                            className={cn(
                              "goat-bubble flex gap-1.5 bg-goat-bubble-in text-goat-bubble-in-foreground",
                              (row.groupPosition === "single" || row.groupPosition === "last") &&
                                "goat-bubble-tail-in",
                            )}
                          />
                        }
                      >
                        {row.tone === "failure" ? (
                          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
                        ) : row.tone === "question" ? (
                          <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                        ) : null}
                        <div className="min-w-0">
                          {row.text}
                          {row.memory ? (
                            <MemorySettingsEntry
                              environmentId={row.memory.environmentId}
                              reference={row.memory}
                              label="View memory details"
                            />
                          ) : null}
                        </div>
                      </TooltipTrigger>
                      <TooltipPopup side="top">{time(row.createdAt)}</TooltipPopup>
                    </Tooltip>
                  </li>
                  {row.options.length > 0 ? (
                    <li className="flex gap-2 pt-1">
                      <div
                        role="group"
                        aria-label="Suggested answers"
                        className="flex max-w-3/4 flex-wrap gap-1.5"
                      >
                        {row.options.map((option) => (
                          <button
                            type="button"
                            key={option}
                            disabled={onPick === undefined}
                            onClick={() => onPick?.(option)}
                            className="rounded-full border border-goat-bubble-out/40 px-3 py-1 text-sm text-goat-bubble-out hover:bg-goat-bubble-out/8 disabled:opacity-50"
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </li>
                  ) : null}
                </Fragment>
              );
            case "task":
              return (
                <li
                  key={row.id}
                  className={cn(
                    "flex items-end",
                    index > 1 && (row.firstInGroup ? "mt-2.5" : "mt-0.5"),
                  )}
                >
                  <GoatBotTaskChip
                    card={row.card}
                    tail={row.groupPosition === "last" || row.groupPosition === "single"}
                  />
                </li>
              );
          }
        })}
        {replying ? (
          <li className={cn("flex items-end", rows.at(-1)?.kind === "user" && "mt-2.5")}>
            <div
              role="status"
              aria-label="GOAT Bot is replying"
              className="goat-typing-tail relative flex h-9 items-center gap-1 rounded-2xl bg-goat-bubble-in px-3.5"
            >
              {TYPING_DOT_DELAYS.map((delay) => (
                <span
                  key={delay}
                  aria-hidden
                  className="size-1.5 animate-typing-wave rounded-full bg-muted-foreground motion-reduce:animate-none"
                  style={{ animationDelay: delay }}
                />
              ))}
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/** True from when GOAT Bot starts reading until its reply lands or the limit passes. */
function useReplying(since: string | null): boolean {
  const deadlineMs = (since === null ? Number.NaN : Date.parse(since)) + REPLYING_LIMIT_MS;
  const getSnapshot = () => Date.now() < deadlineMs;
  const subscribe = (onChange: () => void) => {
    const remaining = deadlineMs - Date.now();
    const timer = remaining > 0 ? setTimeout(onChange, remaining) : undefined;
    return () => clearTimeout(timer);
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
