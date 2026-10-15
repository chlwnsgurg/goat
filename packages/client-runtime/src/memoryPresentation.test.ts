import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  MEMORY_FORGET_NOTICE,
  MEMORY_REVOCATION_NOTICE,
  memoryReportTarget,
  presentMemoryAvailability,
  presentMemoryForget,
  presentMemoryItem,
  presentMemoryOwnerPolicy,
  presentMemoryReport,
  presentMemoryResolution,
  presentMemoryRevert,
  presentMemoryRevertResult,
  presentMemoryRunAccess,
  presentMemorySync,
} from "./memoryPresentation.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const applied = "2026-10-01T00:00:00.000Z";
const deadline = "2026-10-31T00:00:00.000Z";
const visible = M.MemoryLocalAvailability.make({
  exposure: "visible",
  reasons: [],
  deferred: [],
  cleanupPending: false,
});
const payload = M.MemoryPayload.make({
  text: "Synthetic fact",
  evidence: [{ origin: "user", messageIds: [] }],
  derivedFromMemoryRevisions: [],
});
const decodeRevision = Schema.decodeUnknownSync(M.MemoryRevision);
const decodeOwnerView = Schema.decodeUnknownSync(M.MemoryOwnerSourceReadPolicyView);
const revision = (n: number) =>
  decodeRevision({
    memorySpaceId: id(1),
    memoryId: id(2),
    revisionId: id(n),
    operationId: id(10 + n),
    parents: [],
    scope: { kind: "user" },
    payloadRef: id(n),
    assertionKind: "fact",
    provenance: { environmentId: "owner" },
    createdAtUtc: applied,
  });
const item = {
  memorySpaceId: revision(5).memorySpaceId,
  memoryId: revision(5).memoryId,
  status: "active",
  scope: { kind: "user" },
  revision: revision(5),
  payload,
  pendingSync: true,
  localAvailability: visible,
} satisfies M.MemoryItem;
const resolution = Schema.decodeUnknownSync(M.MemoryResolution)({
  resolutionId: id(6),
  memorySpaceId: id(1),
  memoryId: id(2),
  inputRevisionIds: [id(3), id(4)],
  inputPayloadRefs: [id(3), id(4)],
  judgmentRef: id(6),
  requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
  effectiveProvider: "codex",
  effectiveModel: "synthetic",
  resolvingEnvironmentId: "owner",
  fencingToken: 1,
  resultRevisionId: id(5),
  appliedAtUtc: applied,
  revertDeadlineUtc: deadline,
});
const entry = {
  resolution,
  payload: M.MemoryResolutionPayload.make({
    resolutionId: resolution.resolutionId,
    judgment: "Synthetic judgment",
  }),
};
const history = {
  revisions: [3, 4].map((n) => ({ revision: revision(n), payload })),
  revertResults: [],
  nextCursor: null,
} satisfies Pick<M.MemoryHistoryPage, "revisions" | "revertResults" | "nextCursor">;
const report = Schema.decodeUnknownSync(M.MemoryReportDelivery)({
  reportId: "a".repeat(64),
  operationId: id(7),
  outcome: "resolved",
  resolvingEnvironmentId: "resolver",
  resolutionId: id(6),
  state: "failed",
  failureCode: "storage_failed",
  reportThread: null,
  sequence: null,
});

describe("memory presentation boundaries", () => {
  it("explains removal and forgetting in the app language", () => {
    expect(MEMORY_REVOCATION_NOTICE).toBe(
      "Removing a device applies to later requests and to results still on the hub.",
    );
    expect(MEMORY_FORGET_NOTICE).toBe(
      "The provider's original conversation stays, but forgotten content is never imported again.",
    );
  });
  it("keeps propagation separate from usable memory", () => {
    expect(presentMemoryItem(item)).toMatchObject({
      label: "Available",
      syncLabel: "Waiting to sync",
      canEdit: true,
    });
  });
  it.each([
    ["scanner_pending", "Checking content", true],
    ["secret_detected", "Held for sensitive content", true],
    ["forget_pending", "Forgetting memory", false],
    ["missing_parent", "Waiting for earlier memory", true],
  ] as const)("presents %s without offering a rescan", (reason, label, canForget) => {
    expect(presentMemoryAvailability({ ...visible, exposure: "held", reasons: [reason] })).toEqual({
      label,
      detailsAvailable: false,
      canForget,
    });
  });
  it("does not expose forgotten details even while cleanup remains", () => {
    expect(
      presentMemoryAvailability({ ...visible, exposure: "forgotten", cleanupPending: true }),
    ).toEqual({
      label: "Forgotten memory",
      detailsAvailable: false,
      canForget: false,
    });
  });
  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["cursor", "Cursor"],
    ["grok", "Grok"],
    ["opencode", "OpenCode"],
    ["antigravity", "Antigravity"],
    ["custom-resolver", "custom-resolver"],
  ])("labels resolver %s independently of importer profiles", (driver, label) => {
    expect(
      presentMemoryResolution({
        ...entry,
        resolution: { ...resolution, effectiveProvider: M.ProviderDriverKind.make(driver) },
      }).providerLabel,
    ).toBe(label);
  });
  it("shows retained resolution metadata without regenerating purged judgment", () => {
    expect(presentMemoryResolution({ ...entry, payload: null })).toMatchObject({
      label: "Automatic resolution applied",
      providerLabel: "Codex",
      effectiveModel: "synthetic",
      resolvingEnvironmentId: "owner",
      judgmentAvailable: false,
    });
    expect(
      presentMemoryResolution({
        ...entry,
        resolution: { ...resolution, revertsResolutionId: resolution.resolutionId },
      }).label,
    ).toBe("Revert applied");
  });
  it.each([
    ["behind", Date.parse(applied), "before_deadline"],
    ["just before deadline", Date.parse(deadline) - 1, "before_deadline"],
    ["at deadline", Date.parse(deadline), "confirmation_needed"],
    ["ahead", Date.parse(deadline) + 1, "confirmation_needed"],
    ["unknown", NaN, "confirmation_needed"],
  ] as const)("keeps the client clock %s advisory", (_clock, now, localDeadlineState) => {
    expect(presentMemoryRevert({ item, entry, history, now })).toMatchObject({
      canRevert: true,
      reason: null,
      localDeadlineState,
    });
  });
  it("requires complete history and the current result", () => {
    const input = { item, entry, history, now: Date.parse(applied) };
    const incomplete = presentMemoryRevert({
      ...input,
      history: { ...history, nextCursor: "more", revisions: [] },
    });
    const absent = presentMemoryRevert({ ...input, history: { ...history, revisions: [] } });
    expect(incomplete.canRevert).toBe(false);
    expect(absent.canRevert).toBe(false);
    expect(incomplete.reason).not.toBe(absent.reason);
    expect(
      presentMemoryRevert({ ...input, item: { ...item, revision: revision(8) } }).canRevert,
    ).toBe(false);
    expect(
      presentMemoryRevert({
        ...input,
        entry: {
          ...entry,
          resolution: { ...resolution, revertsResolutionId: resolution.resolutionId },
        },
      }).canRevert,
    ).toBe(false);
  });
  it("can restore a retained input without the resolution judgment", () => {
    const missingJudgment = { ...entry, payload: null };
    expect(presentMemoryResolution(missingJudgment).judgmentAvailable).toBe(false);
    expect(
      presentMemoryRevert({
        item,
        entry: missingJudgment,
        history,
        now: Date.parse(applied),
        restoredRevisionId: revision(3).revisionId,
      }),
    ).toMatchObject({ canRevert: true, reason: null });
  });
  it("offers only retained inputs and validates the chosen original", () => {
    const input = {
      item,
      entry,
      now: Date.parse(applied),
      history: {
        ...history,
        revisions: [
          { revision: revision(3), payload },
          { revision: revision(4), payload: null },
          { revision: revision(8), payload },
        ],
      },
    };
    expect(presentMemoryRevert(input)).toMatchObject({
      canRevert: true,
      restorableRevisionIds: [revision(3).revisionId],
    });
    expect(
      presentMemoryRevert({ ...input, restoredRevisionId: revision(3).revisionId }).canRevert,
    ).toBe(true);
    for (const n of [4, 8]) {
      expect(
        presentMemoryRevert({ ...input, restoredRevisionId: revision(n).revisionId }).canRevert,
      ).toBe(false);
    }
  });
  it.each([
    ["just before hub deadline with client ahead", "accepted", Date.parse(deadline) + 1000],
    ["at hub deadline with client behind", "revert_expired", Date.parse(deadline) - 1000],
  ] as const)("settles from the supplied hub result: %s", (_scenario, status, now) => {
    // The result is producer evidence; no hub clock is inferred or added to the DTO.
    const identity = {
      operationId: report.operationId,
      memoryId: item.memoryId,
      resolutionId: resolution.resolutionId,
      revertDeadlineUtc: resolution.revertDeadlineUtc,
    };
    const result =
      status === "accepted"
        ? M.MemoryRevertResult.make({
            ...identity,
            status,
            receipt: {
              operationId: report.operationId,
              memoryId: item.memoryId,
              outcome: "accepted",
              revisionId: revision(8).revisionId,
              pendingSync: false,
            },
            localAvailability: visible,
          })
        : M.MemoryRevertResult.make({ ...identity, status });
    expect(presentMemoryRevert({ item, entry, history, now }).canRevert).toBe(true);
    expect(presentMemoryRevertResult(result)).toMatchObject({
      settled: true,
      detailsAvailable: status === "accepted",
    });
    expect(
      presentMemoryRevert({
        item,
        entry,
        history: { ...history, revertResults: [result] },
        now,
      }),
    ).toMatchObject({
      canRevert: false,
      reason: presentMemoryRevertResult(result).label,
      timeNotice: null,
    });
  });
  it("keeps replayed accepted revert accepted after expiry and body held", () => {
    const result = M.MemoryRevertResult.make({
      operationId: report.operationId,
      memoryId: item.memoryId,
      resolutionId: resolution.resolutionId,
      revertDeadlineUtc: resolution.revertDeadlineUtc,
      status: "accepted",
      receipt: {
        operationId: report.operationId,
        memoryId: item.memoryId,
        outcome: "accepted",
        revisionId: revision(8).revisionId,
        pendingSync: false,
      },
      localAvailability: { ...visible, exposure: "held", reasons: ["scanner_pending"] },
    });
    expect(presentMemoryRevertResult(result)).toEqual({
      label: "Revert approved",
      settled: true,
      detailsAvailable: false,
    });
    expect(
      presentMemoryRevert({
        item,
        entry,
        history: { ...history, revertResults: [result] },
        now: Date.parse(deadline) + 1,
      }),
    ).toMatchObject({ canRevert: false, reason: "Revert approved" });
  });
  it("does not promote a forget receipt into completed propagation or cleanup", () => {
    expect(
      presentMemoryForget({
        operationId: report.operationId,
        memoryId: item.memoryId,
        outcome: "deleted",
        revisionId: null,
        pendingSync: true,
      }),
    ).toMatchObject({
      label: "Forget request applied",
      pendingSync: true,
      expansionStatus: "unknown",
    });
  });
  it("preserves desired pending enrollment without claiming effective permission", () => {
    const view = decodeOwnerView({
      policy: {
        allowedRequesterEnvironmentIds: ["active"],
        ownerPolicyEpoch: 3,
        removals: [
          {
            memorySpaceId: id(1),
            ownerEnvironmentId: "owner",
            requesterEnvironmentId: "pending",
            removalEpoch: 2,
            state: "pending",
          },
        ],
        enrollments: [
          {
            memorySpaceId: id(1),
            ownerEnvironmentId: "owner",
            requesterEnvironmentId: "active",
            ownerPolicyEpoch: 1,
            state: "active",
          },
          {
            memorySpaceId: id(1),
            ownerEnvironmentId: "owner",
            requesterEnvironmentId: "pending",
            ownerPolicyEpoch: 3,
            removalEpoch: 2,
            state: "pending",
          },
        ],
      },
      version: 4,
      revocationPropagation: "pending",
    });
    expect(presentMemoryOwnerPolicy(view)).toMatchObject({
      effectiveRequesterEnvironmentIds: ["active"],
      desiredRequesterEnvironmentIds: ["active", "pending"],
      revocationLabel: "Syncing device removal",
      pendingEnrollments: [{ label: "Waiting to allow this device again after removal completes" }],
    });
  });
  it.each([undefined, -1, 11, 1.5, NaN])(
    "treats invalid or absent attempts %s as unknown",
    (automaticAttempts) => {
      expect(presentMemoryReport(report, { automaticAttempts })).toMatchObject({
        automaticAttempts: null,
        retryState: "unknown",
        canResetInSettings: false,
      });
    },
  );
  it("requires exact exhausted owner and no active claim for a Settings reset", () => {
    const options = {
      automaticAttempts: 10,
      isResetEligible: true,
      isDeliveryOwner: true,
      hasActiveClaim: false,
    };
    expect(presentMemoryReport(report, options)).toMatchObject({
      canResetInSettings: true,
      label: "All 10 automatic retries used",
    });
    for (const overrides of [
      { automaticAttempts: 9 },
      { isResetEligible: false },
      { isDeliveryOwner: false },
      { hasActiveClaim: true },
      { hasActiveClaim: undefined },
    ]) {
      expect(presentMemoryReport(report, { ...options, ...overrides }).canResetInSettings).toBe(
        false,
      );
    }
    expect(presentMemoryReport({ ...report, state: "pending" }, options).canResetInSettings).toBe(
      false,
    );
    expect(presentMemoryReport(report, { automaticAttempts: 0 }).retryState).toBe("remaining");
  });
  it("links delivered reports by their actual thread, not the resolving device", () => {
    const reportThread = {
      environmentId: M.EnvironmentId.make("delivery-owner"),
      threadId: M.ThreadId.make("bot"),
    };
    expect(
      presentMemoryReport({ ...report, state: "delivered", reportThread, sequence: 0 })
        .reportTarget,
    ).toEqual(reportThread);
  });
  it("keeps memory links scoped and body-free", () => {
    const reference = M.MemoryReportReference.make({
      environmentId: M.EnvironmentId.make("delivery-owner"),
      memorySpaceId: item.memorySpaceId,
      memoryId: item.memoryId,
      resolutionId: resolution.resolutionId,
    });
    expect(memoryReportTarget(reference)).toEqual(reference);
  });
  it("does not infer readiness or effective permission from connection or ceiling", () => {
    expect(presentMemorySync({ state: "online", memorySpaceId: item.memorySpaceId })).toMatchObject(
      { diagnostics: "unknown", canReconcileInSettings: false },
    );
    expect(presentMemorySync({ state: "offline", memorySpaceId: null }).label).toBe(
      "Connect a memory space",
    );
    expect(presentMemorySync({ state: "disabled", memorySpaceId: null }).label).toBe(
      "Memory sharing off",
    );
    expect(presentMemoryRunAccess({})).toEqual({
      savedCeiling: "none",
      savedCeilingLabel: "Memory limit: none",
      effectiveAccess: "unknown",
      effectiveReason: null,
    });
    expect(presentMemoryRunAccess({ memoryGrantCeiling: "read_write" })).toMatchObject({
      savedCeiling: "read_write",
      effectiveAccess: "unknown",
    });
  });
});
