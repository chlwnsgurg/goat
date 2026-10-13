import { useAtomValue } from "@effect/atom-react";
import {
  isDecisionItemRemoved,
  orderDecisionQueue,
} from "@goat/client-runtime/state/decision-inbox";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { PendingUserInputDraftAnswer } from "@goat/client-runtime/state/user-input-draft";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type ScopedThreadRef,
} from "@goat/contracts";
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironmentScope } from "../../state/session";
import { decisionInbox, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

type QuestionDrafts = Record<string, PendingUserInputDraftAnswer>;
type InboxDrafts = Record<string, QuestionDrafts>;
type Submission =
  | { phase: "submitting" | "awaitingProjection" }
  | { phase: "failed"; message: string };

function prune<A>(values: Record<string, A>, keep: (id: string) => boolean) {
  const entries = Object.entries(values);
  const kept = entries.filter(([id]) => keep(id));
  return kept.length === entries.length ? values : Object.fromEntries(kept);
}

export function useDecisionInbox() {
  const snapshot = useAtomValue(decisionInbox.itemsAtom);
  const [skippedIds, setSkippedIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<InboxDrafts>({});
  const [submissions, setSubmissions] = useState<Record<string, Submission>>({});
  const inFlight = useRef(new Set<string>());
  const approval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const userInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const ordered = orderDecisionQueue(snapshot.items, skippedIds);
  const current = ordered.find((item) => item.id === activeId) ?? ordered[0] ?? null;
  // Initial partial results stay unpinned until loading finishes or the user acts.
  if ((!snapshot.isLoading || activeId !== null) && (current?.id ?? null) !== activeId)
    setActiveId(current?.id ?? null);

  function skip() {
    if (!current || ordered.length < 2) return;
    const nextSkipped = [...skippedIds.filter((id) => id !== current.id), current.id];
    const next = orderDecisionQueue(snapshot.items, nextSkipped);
    setSkippedIds(nextSkipped);
    setActiveId(next.find((item) => item.id !== current.id)?.id ?? current.id);
  }

  function setAnswers(id: string, answers: QuestionDrafts) {
    if (current?.id === id) setActiveId(id);
    setDrafts((previous) => ({ ...previous, [id]: answers }));
  }

  function fail(id: string, message: string) {
    setSubmissions((previous) => ({ ...previous, [id]: { phase: "failed", message } }));
  }

  async function submit(
    id: string,
    response: ProviderApprovalDecision | Record<string, string | string[]>,
  ) {
    const latest = appAtomRegistry.get(decisionInbox.itemsAtom);
    const live = latest.items.find((item) => item.id === id);
    if (!live || inFlight.current.has(id)) return;
    const sameRef = (ref: ScopedThreadRef) =>
      ref.environmentId === live.ref.environmentId && ref.threadId === live.ref.threadId;
    if (latest.loadingRefs.some(sameRef) || latest.errors.some(({ ref }) => sameRef(ref))) {
      fail(id, "Wait for this thread to reconnect before answering.");
      return;
    }
    if (live.request.responseCapability === "not_resumable") return;
    if (!readEnvironmentScope(live.ref.environmentId, AuthOrchestrationOperateScope)) {
      fail(id, "This connection cannot answer decisions.");
      return;
    }
    if ((live.kind === "approval") !== (typeof response === "string")) return;
    setActiveId(id);
    inFlight.current.add(id);
    setSubmissions((previous) => ({ ...previous, [id]: { phase: "submitting" } }));
    try {
      const input = { threadId: live.ref.threadId, requestId: live.request.requestId };
      const result =
        live.kind === "approval" && typeof response === "string"
          ? await approval({
              environmentId: live.ref.environmentId,
              input: { ...input, decision: response },
            })
          : typeof response !== "string"
            ? await userInput({
                environmentId: live.ref.environmentId,
                input: { ...input, answers: response },
              })
            : null;
      if (!result) return;
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        fail(
          id,
          isAtomCommandInterrupted(result)
            ? "Answer interrupted. Try again."
            : error instanceof Error
              ? error.message
              : "Could not send answer.",
        );
        inFlight.current.delete(id);
      } else {
        setSubmissions((previous) => ({ ...previous, [id]: { phase: "awaitingProjection" } }));
        // A receipt is not removal: hold the lock until projection drops this ID.
      }
    } catch (error) {
      fail(id, error instanceof Error ? error.message : "Could not send answer.");
      inFlight.current.delete(id);
    }
  }

  useEffect(() => {
    const keep = (id: string) => !isDecisionItemRemoved(snapshot, id);
    for (const id of inFlight.current) if (!keep(id)) inFlight.current.delete(id);
    setSkippedIds((previous) => {
      const next = previous.filter(keep);
      return next.length === previous.length ? previous : next;
    });
    setDrafts((previous) => prune(previous, keep));
    setSubmissions((previous) => prune(previous, keep));
  }, [snapshot, submissions]);

  return {
    snapshot,
    ordered,
    current,
    drafts,
    submissions,
    skip,
    setAnswers,
    submit,
    position: current ? ordered.findIndex((item) => item.id === current.id) + 1 : 0,
  };
}
