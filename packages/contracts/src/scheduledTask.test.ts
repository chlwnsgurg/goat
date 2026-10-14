import { WsRpcGroup, WS_METHODS } from "./rpc.ts";
import { MemoryTaskGrantCeilingField } from "./memory.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTask,
  ScheduledTaskUpsertInput,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

describe("persisted task memory ceiling", () => {
  it("normalizes legacy absence to none and preserves each explicit ceiling", () => {
    const row = {
      id: "task",
      title: "Synthetic schedule",
      prompt: "Synthetic prompt",
      enabled: true,
      schedule: { type: "interval", everyMs: 60000 },
      projectId: "project",
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    const persisted = Schema.decodeUnknownSync(ScheduledTask)(row);
    expect(persisted.memoryGrantCeiling).toBe("none");
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(ScheduledTask))(
        Schema.encodeSync(Schema.fromJsonString(ScheduledTask))(persisted),
      ).memoryGrantCeiling,
    ).toBe("none");
    expect(() =>
      Schema.decodeUnknownSync(ScheduledTaskUpsertInput)({
        ...row,
        memoryGrantCeiling: "read_write",
      }),
    ).toThrow();
    const codec = Schema.Struct({ memoryGrantCeiling: MemoryTaskGrantCeilingField });
    expect(Schema.decodeUnknownSync(codec)({})).toEqual({ memoryGrantCeiling: "none" });
    expect(Schema.encodeSync(codec)({})).toEqual({ memoryGrantCeiling: "none" });
    for (const memoryGrantCeiling of ["none", "read", "read_write"] as const) {
      expect(Schema.decodeUnknownSync(codec)({ memoryGrantCeiling })).toEqual({
        memoryGrantCeiling,
      });
      expect(Schema.encodeSync(codec)({ memoryGrantCeiling })).toEqual({ memoryGrantCeiling });
      const json = Schema.fromJsonString(ScheduledTask);
      const task = Schema.decodeUnknownSync(ScheduledTask)({ ...row, memoryGrantCeiling });
      const encoded = Schema.encodeSync(json)(task);
      expect(JSON.parse(encoded).memoryGrantCeiling).toBe(memoryGrantCeiling);
      expect(Schema.decodeUnknownSync(json)(encoded).memoryGrantCeiling).toBe(memoryGrantCeiling);
    }
    const rpc = WsRpcGroup.requests.get(WS_METHODS.scheduledTasksUpsert)!;
    const decodeRpc = Schema.decodeUnknownSync(Schema.fromJsonString(rpc.payloadSchema));
    const publicInput = {
      title: row.title,
      prompt: row.prompt,
      enabled: true,
      schedule: row.schedule,
      projectId: row.projectId,
      workspaceStrategy: row.workspaceStrategy,
      modelSelection: row.modelSelection,
      runtimeMode: row.runtimeMode,
      interactionMode: row.interactionMode,
    };
    expect(decodeRpc(JSON.stringify(publicInput))).toHaveProperty("title", row.title);
    for (const memoryGrantCeiling of ["none", "read", "read_write"])
      expect(() => decodeRpc(JSON.stringify({ ...publicInput, memoryGrantCeiling }))).toThrow();
    expect(() => Schema.decodeUnknownSync(codec)({ memoryGrantCeiling: "full-access" })).toThrow();
  });
});
