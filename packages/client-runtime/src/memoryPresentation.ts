import {
  MEMORY_REPORT_MAX_AUTOMATIC_ATTEMPTS,
  type MemoryHistoryPage,
  type MemoryItem,
  type MemoryLocalAvailability,
  type MemoryMutationReceipt,
  type MemoryOwnerSourceReadPolicyView,
  type MemoryReportDelivery,
  type MemoryReportReference,
  type MemoryRevertResult,
  type MemoryRevisionId,
  type MemorySyncStatus,
  type MemoryTaskGrantCeiling,
} from "@goat/contracts";

export const MEMORY_REVOCATION_NOTICE =
  "Removing a device applies to later requests and to results still on the hub.";
export const MEMORY_FORGET_NOTICE =
  "The provider's original conversation stays, but forgotten content is never imported again.";

/** Navigation identity only. Renderers still check destination capability and live read permission. */
export function memoryReportTarget(reference: MemoryReportReference) {
  return {
    environmentId: reference.environmentId,
    memorySpaceId: reference.memorySpaceId,
    memoryId: reference.memoryId,
    ...(reference.resolutionId === undefined ? {} : { resolutionId: reference.resolutionId }),
  };
}

export function presentMemoryAvailability(availability: MemoryLocalAvailability) {
  if (availability.exposure === "forgotten") {
    return { label: "Forgotten memory", detailsAvailable: false, canForget: false };
  }
  if (availability.exposure === "visible") {
    return { label: "Available", detailsAvailable: true, canForget: true };
  }
  const reasons = availability.reasons;
  const label = reasons.includes("secret_detected")
    ? "Held for sensitive content"
    : reasons.includes("forget_pending")
      ? "Forgetting memory"
      : reasons.includes("scanner_pending")
        ? "Checking content"
        : reasons.includes("dependency_invalidated")
          ? "Original content unavailable"
          : reasons.includes("missing_parent")
            ? "Waiting for earlier memory"
            : "On hold";
  return { label, detailsAvailable: false, canForget: !reasons.includes("forget_pending") };
}

export function presentMemoryItem(item: MemoryItem) {
  const availability = presentMemoryAvailability(item.localAvailability);
  return {
    ...availability,
    label: item.status === "quarantined" ? "Conflicting memory on hold" : availability.label,
    syncLabel: item.pendingSync ? "Waiting to sync" : null,
    cleanupLabel: item.localAvailability.cleanupPending ? "Cleaning up remaining content" : null,
    canEdit: item.status === "active" && availability.detailsAvailable,
  };
}

const REVERT_LABELS = {
  pending: "Waiting for revert approval",
  accepted: "Revert approved",
  revision_changed: "Memory changed; cannot revert",
  forgotten: "Forgotten memory cannot be reverted",
  revert_expired: "Revert window expired",
} as const;

const MEMORY_RESOLVER_LABELS = new Map([
  ["codex", "Codex"],
  ["claudeAgent", "Claude"],
  ["cursor", "Cursor"],
  ["grok", "Grok"],
  ["opencode", "OpenCode"],
  ["antigravity", "Antigravity"],
]);

/** Retained resolution metadata remains useful even when its judgment has been purged. */
export function presentMemoryResolution(entry: MemoryHistoryPage["resolutions"][number]) {
  const resolution = entry.resolution;
  return {
    label:
      resolution.revertsResolutionId === undefined
        ? "Automatic resolution applied"
        : "Revert applied",
    providerLabel:
      MEMORY_RESOLVER_LABELS.get(resolution.effectiveProvider) ?? resolution.effectiveProvider,
    requestedModelSelection: resolution.requestedModelSelection,
    effectiveModel: resolution.effectiveModel,
    resolvingEnvironmentId: resolution.resolvingEnvironmentId,
    appliedAtUtc: resolution.appliedAtUtc,
    revertDeadlineUtc: resolution.revertDeadlineUtc,
    judgmentAvailable: entry.payload !== null,
  };
}

export function presentMemoryRevertResult(result: MemoryRevertResult) {
  return {
    label: REVERT_LABELS[result.status],
    settled: result.status !== "pending",
    // Acceptance survives replay after expiry; visibility is a separate local milestone.
    detailsAvailable:
      result.status === "accepted" && result.localAvailability.exposure === "visible",
  };
}

/** UI eligibility only; the hub authorizes the intent and its deadline. Incomplete pages cannot prove unused. */
export function presentMemoryRevert(input: {
  readonly item: MemoryItem;
  readonly entry: MemoryHistoryPage["resolutions"][number];
  readonly history: Pick<MemoryHistoryPage, "revertResults" | "revisions" | "nextCursor">;
  readonly now: number;
  /** Omit while choosing an original; once selected, validate only that input. */
  readonly restoredRevisionId?: MemoryRevisionId;
}) {
  const { item, entry, history, now, restoredRevisionId } = input;
  const resolution = entry.resolution;
  const result = history.revertResults.find(
    (value) => value.resolutionId === resolution.resolutionId && value.memoryId === item.memoryId,
  );
  const restorableRevisionIds = resolution.inputRevisionIds.filter((id) =>
    history.revisions.some((pair) => pair.revision.revisionId === id && pair.payload !== null),
  );
  // A client clock can warn, but cannot establish hub expiry or close admission.
  const localDeadlineState =
    Number.isFinite(now) && now < Date.parse(resolution.revertDeadlineUtc)
      ? ("before_deadline" as const)
      : ("confirmation_needed" as const);
  const reason =
    item.memoryId !== resolution.memoryId || item.memorySpaceId !== resolution.memorySpaceId
      ? "Memory does not match"
      : item.status === "forgotten"
        ? "Forgotten memory cannot be reverted"
        : result !== undefined
          ? REVERT_LABELS[result.status]
          : resolution.revertsResolutionId !== undefined
            ? "A revert cannot be reverted"
            : item.status !== "active" || item.revision.revisionId !== resolution.resultRevisionId
              ? "Check the current memory before reverting"
              : history.nextCursor !== null
                ? "Load the remaining history before reverting"
                : restoredRevisionId !== undefined
                  ? restorableRevisionIds.includes(restoredRevisionId)
                    ? null
                    : "Selected original unavailable"
                  : restorableRevisionIds.length === 0
                    ? "Retained originals unavailable"
                    : null;
  return {
    canRevert: reason === null,
    reason,
    windowLabel: "Revert once within 30 days of resolution",
    revertDeadlineUtc: resolution.revertDeadlineUtc,
    restorableRevisionIds,
    localDeadlineState,
    timeNotice:
      result === undefined && localDeadlineState === "confirmation_needed"
        ? "The hub needs to confirm the revert window"
        : null,
  };
}

/** A deleted receipt is not evidence that cleanup or hub propagation has finished. */
export function presentMemoryForget(receipt: MemoryMutationReceipt) {
  return {
    label:
      receipt.outcome === "rejected"
        ? "Forget request rejected"
        : receipt.outcome === "deleted" || receipt.outcome === "noop"
          ? "Forget request applied"
          : "Check the forget result",
    pendingSync: receipt.pendingSync,
    expansionStatus: receipt.forgetExpansion?.status ?? "unknown",
    failureCode: receipt.failureCode ?? null,
    notice: MEMORY_FORGET_NOTICE,
  };
}

export function presentMemoryOwnerPolicy(view: MemoryOwnerSourceReadPolicyView) {
  const pending = view.policy.enrollments.filter((entry) => entry.state === "pending");
  return {
    effectiveRequesterEnvironmentIds: view.policy.allowedRequesterEnvironmentIds,
    desiredRequesterEnvironmentIds: [
      ...new Set([
        ...view.policy.allowedRequesterEnvironmentIds,
        ...pending.map((entry) => entry.requesterEnvironmentId),
      ]),
    ],
    pendingEnrollments: pending.map((entry) => ({
      ...entry,
      label: "Waiting to allow this device again after removal completes",
    })),
    revocationLabel:
      view.revocationPropagation === "pending"
        ? "Syncing device removal"
        : "Device removal applied",
    notice: MEMORY_REVOCATION_NOTICE,
  };
}

/** Missing pre-feature attempt metadata is unknown, never reconstructed from failed state. */
export function presentMemoryReport(
  report: MemoryReportDelivery,
  options: {
    readonly automaticAttempts?: number | undefined;
    readonly isDeliveryOwner?: boolean;
    /** Authoritative classification/approval eligibility, supplied after the lifecycle handoff. */
    readonly isResetEligible?: boolean;
    readonly hasActiveClaim?: boolean | undefined;
  } = {},
) {
  const value = options.automaticAttempts;
  const attempts =
    value !== undefined &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MEMORY_REPORT_MAX_AUTOMATIC_ATTEMPTS
      ? value
      : null;
  const exhausted = attempts === MEMORY_REPORT_MAX_AUTOMATIC_ATTEMPTS;
  return {
    label:
      report.state === "delivered"
        ? "Report delivered"
        : report.state === "failed" && exhausted
          ? "All 10 automatic retries used"
          : report.state === "failed"
            ? "Report delivery failed"
            : "Waiting to deliver report",
    automaticAttempts: attempts,
    retryState: attempts === null ? "unknown" : exhausted ? "exhausted" : "remaining",
    // Settings alone consumes this eligibility; a future guarded command remains authoritative.
    canResetInSettings:
      report.state === "failed" &&
      exhausted &&
      options.isResetEligible === true &&
      options.isDeliveryOwner === true &&
      options.hasActiveClaim === false,
    reportTarget: report.state === "delivered" ? report.reportThread : null,
    failureCode: report.failureCode ?? null,
  };
}

/** Online is a connection state, not proof of publication, exposure or policy readiness. */
export function presentMemorySync(status: Pick<MemorySyncStatus, "state" | "memorySpaceId">) {
  const labels = {
    disabled: "Memory sharing off",
    bootstrapping: "Receiving initial memories",
    online: "Hub connected",
    offline: "Hub disconnected",
    error: "Memory sync error",
  } as const;
  return {
    label:
      status.state !== "disabled" && status.memorySpaceId === null
        ? "Connect a memory space"
        : labels[status.state],
    diagnostics: "unknown" as const,
    canReconcileInSettings: false,
  };
}

/** Saved ceiling has a legacy default; current effective access needs independent producer evidence. */
export function presentMemoryRunAccess(input: {
  readonly memoryGrantCeiling?: MemoryTaskGrantCeiling;
}) {
  return {
    savedCeiling: input.memoryGrantCeiling ?? "none",
    effectiveAccess: "unknown" as const,
    effectiveReason: null,
  };
}
