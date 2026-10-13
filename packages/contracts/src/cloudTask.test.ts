import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationV2CloudTask, OrchestrationV2SessionCapabilities } from "./orchestrationV2.ts";

const decodeCapabilities = Schema.decodeUnknownSync(OrchestrationV2SessionCapabilities);
const decodeTask = Schema.decodeUnknownSync(OrchestrationV2CloudTask);
const encodeTask = Schema.encodeSync(OrchestrationV2CloudTask);

describe("cloud foundation schemas", () => {
  it("decodes historical local session capabilities without requiring adapter changes", () => {
    const decoded = decodeCapabilities({
      supportsMultipleProviderThreadsPerSession: false,
      supportsModelSwitchInSession: false,
      supportsProviderSwitchingViaHandoff: false,
      supportsRuntimeModeSwitchInSession: false,
      pendingRequestsSurviveRestart: false,
    });
    expect(decoded.executionLocation).toBe("local");
    expect(decoded.sourceRestriction).toBe("published-ref");
    expect(decoded.followUp).toEqual({ supported: true });
  });
  it("round-trips the exact task/result/source wire value", () => {
    const task = {
      taskId: "remote-1",
      url: "https://example.com/tasks/1",
      title: "Fix task",
      status: "succeeded" as const,
      tracking: "polled" as const,
      progress: "Done",
      summary: "Fixed",
      prUrl: "https://github.com/acme/repo/pull/1",
      branch: "agent/fix",
      source: { repository: "https://github.com/acme/repo", branch: "dev", sha: "a".repeat(40) },
      localChangesExcluded: true,
      updatedAt: "2026-10-13T00:00:00.000Z",
    };
    const encoded = encodeTask(task);
    expect(decodeTask(encoded)).toEqual(task);
    expect(() => decodeTask({ ...task, status: "completed" })).toThrow();
    expect(() => decodeTask({ ...task, tracking: "timer" })).toThrow();
  });
});
