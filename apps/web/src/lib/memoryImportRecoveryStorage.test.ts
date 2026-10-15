// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as M from "@goat/contracts";
import { createMemoryImportWorkflow } from "@goat/client-runtime/memory-import-workflow";
import {
  memoryImportRecoveryKey,
  MEMORY_IMPORT_RECOVERY_TTL_MS,
} from "@goat/client-runtime/memory-import-recovery";
import { memoryImportRecoveryStorage } from "./memoryImportRecoveryStorage";
import { memorySyncFixture } from "../test/memorySyncFixture";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const destination = {
  environmentId: M.EnvironmentId.make("device"),
  memorySpaceId: M.MemorySpaceId.make(uuid(1)),
};
const sourceId = M.MemoryImportSourceId.make(uuid(3));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
function fixture(count = 65) {
  const store = memoryImportRecoveryStorage(localStorage);
  const calls: M.MemoryImportProviderInput[] = [];
  const selections = Array.from({ length: count }, (_, index) => ({
    sourceItemKey: `item-${index}`,
    sourceFingerprint: "a".repeat(64),
    scope: { kind: "user" as const },
  }));
  let nextId = 10;
  let allowed = true;
  const respond = (input: M.MemoryImportProviderInput): M.MemoryImportProviderResult =>
    input.action === "discover"
      ? { action: "discover", sources: [] }
      : input.action === "preview"
        ? {
            action: "preview",
            sourceId,
            sessionId: "preview-session",
            items: selections.map((item) => ({ ...item, byteCount: 1, mappingRequired: false })),
          }
        : {
            action: input.action,
            receipt: {
              operationId: input.operationId,
              sourceId,
              sessionId: "preview-session",
              sessionNewItems: 1,
              sessionBodyBytes: 1,
              state: "completed",
              items: [],
              remaining: 0,
            },
            syncStatus: memorySyncFixture,
          };
  let request = async (input: M.MemoryImportProviderInput) => respond(input);
  const create = () =>
    createMemoryImportWorkflow({
      fence: { ...destination, session: `session-${nextId++}` },
      recovery: store,
      canImport: () => allowed,
      operationId: () => M.MemoryOperationId.make(uuid(nextId++)),
      request: async (_, input) => {
        calls.push(input);
        return request(input);
      },
    });
  const workflow = create();
  return {
    store,
    calls,
    selections,
    respond,
    create,
    workflow,
    setRequest: (next: typeof request) => {
      request = next;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    ready: async () => {
      await workflow.preview(sourceId);
      workflow.select(selections);
    },
  };
}
it("shares a store across mounts and persists only the strict handle", async () => {
  const f = fixture(1);
  expect(memoryImportRecoveryStorage(localStorage)).toBe(f.store);
  await f.ready();
  f.setRequest(async (input) => {
    if (input.action === "apply") {
      expect((await f.store.load(destination))?.operationId).toBe(input.operationId);
      const raw = localStorage.getItem(memoryImportRecoveryKey(destination))!;
      expect(raw).not.toContain("sourceItemKey");
      expect(raw).not.toContain("preview-session");
      throw new Error("response lost");
    }
    return f.respond(input);
  });
  await f.workflow.apply();
  const saved = await f.store.load(destination);
  expect(saved).not.toBeNull();
  f.calls.length = 0;
  f.setRequest(async (input) => f.respond(input));
  await f.create().recover();
  expect(f.calls).toEqual([
    { action: "status", memorySpaceId: destination.memorySpaceId, operationId: saved!.operationId },
  ]);
  expect(await f.store.load(destination)).toBeNull();
});
it("blocks apply until storage succeeds and never admits after storage failure", async () => {
  const f = fixture(1);
  await f.ready();
  const saved = deferred<void>();
  const release = deferred<void>();
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    original.call(this, key, value);
  });
  const save = f.store.save.bind(f.store);
  vi.spyOn(f.store, "save").mockImplementation(async (...args) => {
    saved.resolve();
    await release.promise;
    return save(...args);
  });
  const applying = f.workflow.apply();
  await saved.promise;
  expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(0);
  release.resolve();
  await applying;
  expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(1);
  const next = fixture(1);
  await next.ready();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await expect(next.workflow.apply()).rejects.toThrow("quota");
  expect(next.calls.filter((input) => input.action === "apply")).toHaveLength(0);
});
it("Stop allows the admitted chunk to settle and stops subsequent chunks", async () => {
  const f = fixture();
  await f.ready();
  const admitted = deferred<void>();
  const reply = deferred<void>();
  f.setRequest(async (input) => {
    if (input.action === "apply") {
      admitted.resolve();
      await reply.promise;
    }
    return f.respond(input);
  });
  const applying = f.workflow.apply();
  await admitted.promise;
  f.workflow.stop();
  reply.resolve();
  await applying;
  expect(
    f.calls.filter((input) => input.action === "apply").map((input) => input.items.length),
  ).toEqual([32]);
  expect(f.workflow.getState()).toMatchObject({
    phase: "partial",
    stopped: true,
    settledChunks: 1,
  });
});
it("keeps partial and offline handles and clears not_found without reapplying", async () => {
  const f = fixture(1);
  await f.ready();
  f.setRequest(async (input) => {
    const result = f.respond(input);
    return result.action === "apply"
      ? { ...result, receipt: { ...result.receipt, state: "partial", remaining: 1 } }
      : result;
  });
  await f.workflow.apply();
  expect(f.workflow.getState().phase).toBe("recovery");
  f.calls.length = 0;
  f.setRequest(async () => {
    throw new Error("offline");
  });
  await f.create().recover();
  expect(await f.store.load(destination)).not.toBeNull();
  f.setRequest(async () => {
    throw { code: "not_found" };
  });
  await f.create().recover();
  expect(await f.store.load(destination)).toBeNull();
  expect(f.calls.every((input) => input.action === "status")).toBe(true);
});
it.each(["expired", "invalid"])(
  "drops %s handles with zero automatic apply/status",
  async (mode) => {
    const now = 1000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const f = fixture(1);
    await f.store.save(destination, M.MemoryOperationId.make(uuid(9)));
    if (mode === "expired")
      vi.mocked(Date.now).mockReturnValue(now + MEMORY_IMPORT_RECOVERY_TTL_MS);
    else localStorage.setItem(memoryImportRecoveryKey(destination), "malformed");
    await f.create().recover();
    expect(f.calls).toEqual([]);
    expect(await f.store.load(destination)).toBeNull();
  },
);
it("revoke/removal discards late replies and removes the old destination handle", async () => {
  const f = fixture(1);
  await f.ready();
  const admitted = deferred<void>();
  const release = deferred<void>();
  f.setRequest(async (input) => {
    if (input.action === "apply") {
      admitted.resolve();
      await release.promise;
    }
    return f.respond(input);
  });
  const applying = f.workflow.apply();
  await admitted.promise;
  f.setAllowed(false);
  await f.workflow.removeDestination();
  release.resolve();
  await applying;
  expect(f.workflow.getState().receipt).toBeNull();
  expect(await f.store.load(destination)).toBeNull();
});
it("serializes 65 selected items into three persisted chunks", async () => {
  const f = fixture();
  await f.ready();
  f.setRequest(async (input) => {
    if (input.action === "apply")
      expect((await f.store.load(destination))?.operationId).toBe(input.operationId);
    return f.respond(input);
  });
  await f.workflow.apply();
  expect(
    f.calls.filter((input) => input.action === "apply").map((input) => input.items.length),
  ).toEqual([32, 32, 1]);
  expect(f.workflow.getState()).toMatchObject({ phase: "completed", settledChunks: 3 });
  expect(await f.store.load(destination)).toBeNull();
});
it("session invalidation rejects late replies while preserving exact status recovery", async () => {
  const f = fixture(1);
  await f.ready();
  const admitted = deferred<void>();
  const reply = deferred<void>();
  f.setRequest(async (input) => {
    if (input.action === "apply") {
      admitted.resolve();
      await reply.promise;
    }
    return f.respond(input);
  });
  const applying = f.workflow.apply();
  await admitted.promise;
  f.workflow.invalidate({ ...destination, session: "reconnected" });
  reply.resolve();
  await applying;
  expect(f.workflow.getState().receipt).toBeNull();
  const handle = await f.store.load(destination);
  expect(handle).not.toBeNull();
  f.calls.length = 0;
  await f.create().recover();
  expect(f.calls).toEqual([
    {
      action: "status",
      memorySpaceId: destination.memorySpaceId,
      operationId: handle!.operationId,
    },
  ]);
});
