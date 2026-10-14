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
  type MemorySyncStatus,
  type MemoryTaskGrantCeiling,
} from "@goat/contracts";

export const MEMORY_REVOCATION_NOTICE = "철회는 이후 요청과 허브에 남은 결과에 적용";
export const MEMORY_FORGET_NOTICE =
  "provider 원문 대화는 남지만, 잊은 원문/내용은 다시 가져오지 않습니다";

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
    return { label: "잊은 기억", detailsAvailable: false, canForget: false };
  }
  if (availability.exposure === "visible") {
    return { label: "사용 가능", detailsAvailable: true, canForget: true };
  }
  const reasons = availability.reasons;
  const label = reasons.includes("secret_detected")
    ? "민감한 내용으로 보류됨"
    : reasons.includes("forget_pending")
      ? "잊기 처리 중"
      : reasons.includes("scanner_pending")
        ? "내용 확인 중"
        : reasons.includes("dependency_invalidated")
          ? "원문을 사용할 수 없음"
          : reasons.includes("missing_parent")
            ? "이전 기억 수신 대기"
            : "사용 보류 중";
  return { label, detailsAvailable: false, canForget: !reasons.includes("forget_pending") };
}

export function presentMemoryItem(item: MemoryItem) {
  const availability = presentMemoryAvailability(item.localAvailability);
  return {
    ...availability,
    label: item.status === "quarantined" ? "충돌한 기억 격리 중" : availability.label,
    syncLabel: item.pendingSync ? "전파 대기" : null,
    cleanupLabel: item.localAvailability.cleanupPending ? "남은 내용 정리 중" : null,
    canEdit: item.status === "active" && availability.detailsAvailable,
  };
}

const REVERT_LABELS = {
  pending: "되돌리기 승인 대기",
  accepted: "되돌리기 승인됨",
  revision_changed: "기억이 변경되어 되돌릴 수 없음",
  forgotten: "잊은 기억은 되돌릴 수 없음",
  revert_expired: "되돌리기 기간 만료",
} as const;

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
}) {
  const { item, entry, history, now } = input;
  const resolution = entry.resolution;
  const result = history.revertResults.find(
    (value) => value.resolutionId === resolution.resolutionId && value.memoryId === item.memoryId,
  );
  const reason =
    item.memoryId !== resolution.memoryId || item.memorySpaceId !== resolution.memorySpaceId
      ? "기억 대상 불일치"
      : item.status === "forgotten"
        ? "잊은 기억은 되돌릴 수 없음"
        : result !== undefined
          ? REVERT_LABELS[result.status]
          : resolution.revertsResolutionId !== undefined
            ? "되돌리기는 다시 되돌릴 수 없음"
            : !Number.isFinite(now)
              ? "되돌리기 기간 확인 필요"
              : now >= Date.parse(resolution.revertDeadlineUtc)
                ? "되돌리기 기간 만료"
                : item.status !== "active" ||
                    item.revision.revisionId !== resolution.resultRevisionId
                  ? "현재 결과 기억 확인 필요"
                  : history.nextCursor !== null
                    ? "나머지 해결 기록 확인 필요"
                    : entry.payload === null ||
                        !resolution.inputRevisionIds.every((id) =>
                          history.revisions.some(
                            (pair) => pair.revision.revisionId === id && pair.payload !== null,
                          ),
                        )
                      ? "보존된 원본을 사용할 수 없음"
                      : null;
  return {
    canRevert: reason === null,
    reason,
    windowLabel: "해결 후 30일 이내 한 번 되돌리기",
    revertDeadlineUtc: resolution.revertDeadlineUtc,
  };
}

/** A deleted receipt is not evidence that cleanup or hub propagation has finished. */
export function presentMemoryForget(receipt: MemoryMutationReceipt) {
  return {
    label:
      receipt.outcome === "rejected"
        ? "잊기 요청 거절됨"
        : receipt.outcome === "deleted" || receipt.outcome === "noop"
          ? "잊기 요청 반영됨"
          : "잊기 결과 확인 필요",
    pendingSync: receipt.pendingSync,
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
      label: "재등록 대기 — 이전 철회가 끝나면 다시 허용됩니다",
    })),
    revocationLabel: view.revocationPropagation === "pending" ? "철회 전파 중" : "철회 적용 완료",
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
        ? "보고서 전달됨"
        : report.state === "failed" && exhausted
          ? "자동 재시도 10회 소진"
          : report.state === "failed"
            ? "보고서 전달 실패"
            : "보고서 전달 대기",
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
    disabled: "메모리 공유 꺼짐",
    bootstrapping: "메모리 초기 수신 중",
    online: "허브 연결됨",
    offline: "허브 연결 끊김",
    error: "메모리 동기화 오류",
  } as const;
  return {
    label:
      status.state !== "disabled" && status.memorySpaceId === null
        ? "메모리 공간 연결 필요"
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
