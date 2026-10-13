import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { threadKey, threadRefsEqual } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import type { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import type { ThreadPendingApproval, ThreadPendingUserInput } from "./threadRequests.ts";

export type DecisionItem = {
  readonly id: string;
  readonly ref: ScopedThreadRef;
  readonly createdAt: string;
} & (
  | { readonly kind: "approval"; readonly request: ThreadPendingApproval }
  | { readonly kind: "user_input"; readonly request: ThreadPendingUserInput }
);

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function orderDecisionQueue(
  items: ReadonlyArray<DecisionItem>,
  skipOrder: ReadonlyArray<string>,
): ReadonlyArray<DecisionItem> {
  const skipped = new Map<string, number>();
  for (const id of skipOrder) {
    if (!skipped.has(id)) skipped.set(id, skipped.size);
  }
  return [...items].sort((left, right) => {
    const leftSkip = skipped.get(left.id);
    const rightSkip = skipped.get(right.id);
    if (leftSkip !== undefined || rightSkip !== undefined) {
      if (leftSkip === undefined) return -1;
      if (rightSkip === undefined) return 1;
      return leftSkip - rightSkip;
    }
    return compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id);
  });
}

export function skipDecisionItem(
  items: ReadonlyArray<DecisionItem>,
  skipOrder: ReadonlyArray<string>,
  id: string,
): ReadonlyArray<string> {
  const liveIds = new Set(items.map((item) => item.id));
  const next = [...new Set(skipOrder)].filter((key) => liveIds.has(key) && key !== id);
  if (liveIds.has(id)) next.push(id);
  return next;
}

export function createDecisionInboxAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly presentationAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
  readonly details: Pick<
    ReturnType<typeof createEnvironmentThreadDetailAtoms>,
    "pendingRequestsAtom" | "statusAtom" | "errorAtom"
  >;
}) {
  let previousSummary: { readonly count: number; readonly refs: ReadonlyArray<ScopedThreadRef> } = {
    count: 0,
    refs: [],
  };
  const summaryAtom = Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    const connected = new Set<EnvironmentId>();
    for (const [id, entry] of catalog.entries) {
      if (entry.enabled && get(input.presentationAtom(id))?.connection.phase === "connected") {
        connected.add(id);
      }
    }
    const unique = new Map<string, ScopedThreadRef>();
    for (const thread of get(input.threadShellsAtom)) {
      if (
        !connected.has(thread.environmentId) ||
        (!thread.hasPendingApprovals && !thread.hasPendingUserInput)
      )
        continue;
      const ref = { environmentId: thread.environmentId, threadId: thread.id };
      unique.set(threadKey(ref), ref);
    }
    const refs = [...unique.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, ref]) => ref);
    if (threadRefsEqual(previousSummary.refs, refs)) return previousSummary;
    previousSummary = { count: refs.length, refs };
    return previousSummary;
  }).pipe(Atom.withLabel("decision-inbox-summary"));

  const itemsAtom = Atom.make((get) => {
    const items: DecisionItem[] = [];
    const loadingRefs: ScopedThreadRef[] = [];
    const errors: { readonly ref: ScopedThreadRef; readonly message: string }[] = [];
    for (const ref of get(summaryAtom).refs) {
      const pending = get(input.details.pendingRequestsAtom(ref));
      const status = get(input.details.statusAtom(ref));
      const error = get(input.details.errorAtom(ref));
      if (status === "deleted") continue;
      if (error !== null) errors.push({ ref, message: error });
      else if (status !== "live") loadingRefs.push(ref);
      if (pending === null) continue;
      for (const request of pending.approvals) {
        items.push({
          id: JSON.stringify([ref.environmentId, ref.threadId, request.requestId]),
          ref,
          kind: "approval",
          createdAt: request.createdAt,
          request,
        });
      }
      for (const request of pending.userInputs) {
        items.push({
          id: JSON.stringify([ref.environmentId, ref.threadId, request.requestId]),
          ref,
          kind: "user_input",
          createdAt: request.createdAt,
          request,
        });
      }
    }
    return {
      items: orderDecisionQueue(items, []),
      loadingRefs,
      errors,
      isLoading: loadingRefs.length > 0,
    };
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel("decision-inbox-items"));

  return { summaryAtom, itemsAtom };
}
