import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  MEMORY_IMPORT_RECOVERY_TTL_MS as TTL,
  MemoryImportRecoveryHandle,
  createMemoryImportRecoveryStore,
  decodeMemoryImportRecovery,
  encodeMemoryImportRecovery,
  memoryImportRecoveryKey,
} from "./memoryImportRecovery.ts";
import {
  createMemoryImportWorkflow,
  memoryImportChunks,
  sameMemoryImportFence,
  reduceMemoryImportProgress,
  initialMemoryImportWorkflowState,
} from "./memoryImportWorkflow.ts";

const decodeHandle = Schema.decodeUnknownSync(MemoryImportRecoveryHandle);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const destination = {
  environmentId: M.EnvironmentId.make("device"),
  memorySpaceId: M.MemorySpaceId.make(uuid(1)),
};
const operationId = M.MemoryOperationId.make(uuid(2));
const sourceId = M.MemoryImportSourceId.make(uuid(3));
const fence = { ...destination, session: "connection-1" };
const selections = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    sourceItemKey: `item-${i}`,
    sourceFingerprint: "a".repeat(64),
    scope: { kind: "user" as const },
  }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function storageFixture() {
  const data = new Map<string, string>();
  let now = 1000;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  return {
    data,
    storage,
    setNow: (value: number) => {
      now = value;
    },
    store: createMemoryImportRecoveryStore(storage, () => now),
  };
}
const syncStatus = M.MemorySyncStatus.make({
  memorySpaceId: destination.memorySpaceId,
  state: "online",
  pendingSync: 0,
  quarantined: 0,
  parked: 0,
  lastSuccessfulSyncAtUtc: null,
  lastHubSequence: 0,
  processing: {
    lastReceivedHubSequence: 0,
    receiveLag: null,
    deferred: 0,
    oldestDeferredAtUtc: null,
    unindexedItems: 0,
    scannerHeldItems: 0,
    scannerPendingItems: 0,
    missingParentItems: 0,
    pendingCleanupItems: 0,
    reportBacklog: 0,
    reportFailed: 0,
    hubAdmissionFailures: 0,
    indexCoverage: {
      status: "available",
      eligibleItems: 0,
      indexedItems: 0,
      unindexedItems: 0,
      projectionWatermark: 0,
    },
  },
  storage: {
    quotas: [],
    tables: [],
    measuredAtUtc: null,
    dbFileBytes: null,
    walBytes: null,
    freelistBytes: null,
    freelistRatio: null,
    retentionFloor: 0,
    checkpointSequence: 0,
    compaction: {
      lastRunAtUtc: null,
      removedRows: 0,
      reclaimedLogicalBytes: 0,
      reclaimableLogicalBytes: 0,
      blockedReasons: [],
    },
    ftsAdmission: {
      state: "open",
      changedAtUtc: null,
      lastMeasuredAtUtc: null,
      allocatedBytes: null,
      measurementStatus: "unavailable",
    },
    growth: {
      current: null,
      deltas: ([1, 7, 30] as const).flatMap((days) =>
        M.MemoryStorageMetric.literals.map((metric) => ({
          days,
          metric,
          status: "unavailable" as const,
          baselineAtUtc: null,
          currentAtUtc: null,
          elapsedMs: null,
          deltaBytes: null,
          reason: "missing_baseline" as const,
        })),
      ),
    },
    warnings: [],
  },
});

function workflowFixture(count = 65) {
  const fixture = storageFixture();
  const calls: M.MemoryImportProviderInput[] = [];
  const items = selections(count);
  let permitted = true;
  let nextId = 10;
  const preview = {
    action: "preview" as const,
    sourceId,
    sessionId: "import-session",
    items: items.map((item) => ({ ...item, byteCount: 1, mappingRequired: false })),
  };
  function result(input: M.MemoryImportProviderInput): M.MemoryImportProviderResult {
    if (input.action === "discover") return { action: "discover", sources: [] };
    if (input.action === "preview") return preview;
    return {
      action: input.action,
      receipt: {
        operationId: input.operationId,
        sourceId,
        sessionId: "import-session",
        sessionNewItems: 1,
        sessionBodyBytes: 1,
        state: "completed",
        remaining: 0,
        items: [],
      },
      syncStatus,
    };
  }
  let respond = async (input: M.MemoryImportProviderInput) => result(input);
  const workflow = createMemoryImportWorkflow({
    fence,
    recovery: fixture.store,
    canImport: () => permitted,
    operationId: () => M.MemoryOperationId.make(uuid(nextId++)),
    request: async (_, input) => {
      calls.push(input);
      return respond(input);
    },
  });
  return {
    ...fixture,
    workflow,
    calls,
    items,
    result,
    setRespond: (fn: typeof respond) => {
      respond = fn;
    },
    setPermitted: (value: boolean) => {
      permitted = value;
    },
    ready: async () => {
      await workflow.discover("codex");
      await workflow.preview(sourceId);
      workflow.select(items);
    },
  };
}

describe("body-free import recovery", () => {
  it("round-trips branded handles and expires at exactly 30 days", async () => {
    const f = storageFixture();
    const handle = await f.store.save(destination, operationId);
    expect(handle.expiresAt - handle.savedAt).toBe(TTL);
    const raw = encodeMemoryImportRecovery(handle);
    expect(Object.keys(JSON.parse(raw).handle).sort()).toEqual([
      "environmentId",
      "expiresAt",
      "memorySpaceId",
      "operationId",
      "savedAt",
    ]);
    expect(decodeMemoryImportRecovery(raw, handle.expiresAt - 1)).toEqual(handle);
    expect(decodeMemoryImportRecovery(raw, handle.expiresAt)).toBeNull();
    expect(decodeMemoryImportRecovery(raw, handle.savedAt - 1)).toBeNull();
    f.setNow(handle.expiresAt);
    expect(await f.store.load(destination)).toBeNull();
    expect(f.data.size).toBe(0);
  });
  it.each(["garbage", "null", '{"version":2,"handle":{}}', '{"version":1,"handle":{}}'])(
    "removes malformed metadata: %s",
    async (raw) => {
      const f = storageFixture();
      f.data.set(memoryImportRecoveryKey(destination), raw);
      expect(await f.store.load(destination)).toBeNull();
      expect(f.data.size).toBe(0);
    },
  );
  it("rejects extra private fields and non-exact TTLs", async () => {
    const f = storageFixture();
    const handle = await f.store.save(destination, operationId);
    for (const extra of [
      { body: "private" },
      { expiresAt: handle.expiresAt + 1 },
      { operationId: "bad" },
    ]) {
      expect(
        decodeMemoryImportRecovery(
          JSON.stringify({ version: 1, handle: { ...handle, ...extra } }),
          1000,
        ),
      ).toBeNull();
    }
    expect(() => decodeHandle({ ...handle, savedAt: NaN })).toThrow();
    const wider = { ...handle, body: "private" };
    expect(encodeMemoryImportRecovery(wider)).not.toContain("private");
  });
  it("serializes overlapping saves, never replaces an unresolved operation, and isolates destinations", async () => {
    const f = storageFixture();
    const first = f.store.save(destination, operationId);
    const second = f.store.save(destination, M.MemoryOperationId.make(uuid(4)));
    await first;
    await expect(second).rejects.toThrow("previous import");
    const other = { ...destination, environmentId: M.EnvironmentId.make("other") };
    await f.store.save(other, operationId);
    await f.store.clear(destination, M.MemoryOperationId.make(uuid(4)));
    expect(await f.store.load(destination)).not.toBeNull();
    await f.store.clear(destination);
    expect(await f.store.load(other)).not.toBeNull();
  });
  it("removes wrong-destination and clock-regressed handles", async () => {
    const f = storageFixture();
    const handle = await f.store.save(destination, operationId);
    f.data.set(
      memoryImportRecoveryKey(destination),
      encodeMemoryImportRecovery({ ...handle, environmentId: M.EnvironmentId.make("other") }),
    );
    expect(await f.store.load(destination)).toBeNull();
    await f.store.save(destination, operationId);
    f.setNow(999);
    expect(await f.store.load(destination)).toBeNull();
  });
});

describe("import workflow admission and fences", () => {
  it("snapshots selectors, bounds and sequences chunks, with distinct stable IDs", async () => {
    const f = workflowFixture();
    await f.ready();
    f.items[0]!.sourceItemKey = "changed-after-preview";
    f.setRespond(async (input) => {
      if (input.action === "apply")
        expect((await f.store.load(destination))?.operationId).toBe(input.operationId);
      return f.result(input);
    });
    await f.workflow.apply();
    const applies = f.calls.filter((input) => input.action === "apply");
    expect(applies.map((input) => input.items.length)).toEqual([32, 32, 1]);
    expect(applies[0]!.items[0]!.sourceItemKey).toBe("item-0");
    expect(new Set(applies.map((input) => input.operationId)).size).toBe(3);
    expect(f.workflow.getState()).toMatchObject({ phase: "completed", settledChunks: 3 });
    expect(await f.store.load(destination)).toBeNull();
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
  });
  it("waits for storage success and does not apply after failed persistence", async () => {
    const f = workflowFixture(1);
    const gate = deferred<void>();
    const saved = deferred<void>();
    f.storage.setItem = async () => {
      saved.resolve();
      await gate.promise;
    };
    await f.ready();
    const applying = f.workflow.apply();
    await saved.promise;
    expect(f.calls.some((input) => input.action === "apply")).toBe(false);
    gate.reject(new Error("storage unavailable"));
    await expect(applying).rejects.toThrow("storage unavailable");
    expect(f.calls.some((input) => input.action === "apply")).toBe(false);
  });
  it("stops future chunks while settling the admitted chunk as partial", async () => {
    const f = workflowFixture();
    await f.ready();
    const gate = deferred<M.MemoryImportProviderResult>();
    const admitted = deferred<M.MemoryImportProviderInput>();
    f.setRespond((input) => {
      admitted.resolve(input);
      return gate.promise;
    });
    const applying = f.workflow.apply();
    const input = await admitted.promise;
    f.workflow.stop();
    gate.resolve(f.result(input));
    await applying;
    expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(1);
    expect(f.workflow.getState()).toMatchObject({
      phase: "partial",
      settledChunks: 1,
      stopped: true,
    });
  });
  it("lost responses survive restart and offline recovery calls only the exact status ID", async () => {
    const f = workflowFixture();
    await f.ready();
    f.setRespond(async () => {
      throw new Error("offline");
    });
    await f.workflow.apply();
    const handle = await f.store.load(destination);
    expect(handle).not.toBeNull();
    const before = f.calls.length;
    f.workflow.invalidate({ ...fence, session: "reconnected" });
    await f.workflow.recover();
    expect(f.calls.slice(before)).toEqual([
      {
        action: "status",
        memorySpaceId: destination.memorySpaceId,
        operationId: handle!.operationId,
      },
    ]);
    expect(await f.store.load(destination)).toEqual(handle);
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
    f.setRespond(async (input) => f.result(input));
    await f.workflow.recover();
    expect(await f.store.load(destination)).toBeNull();
    expect(f.workflow.getState().phase).toBe("repreview");
  });
  it("not_found removes the handle without claiming zero applied", async () => {
    const f = workflowFixture(1);
    await f.store.save(destination, operationId);
    f.setRespond(async () => {
      throw { code: "not_found" };
    });
    await f.workflow.recover();
    expect(await f.store.load(destination)).toBeNull();
    expect(f.workflow.getState()).toMatchObject({
      phase: "repreview",
      message: expect.stringContaining("may have been applied"),
    });
  });
  it.each(["environment", "space", "session"])(
    "discards late status after %s changes",
    async (change) => {
      const f = workflowFixture(1);
      await f.store.save(destination, operationId);
      const started = deferred<M.MemoryImportProviderInput>();
      const gate = deferred<M.MemoryImportProviderResult>();
      f.setRespond((input) => {
        started.resolve(input);
        return gate.promise;
      });
      const recovering = f.workflow.recover();
      const input = await started.promise;
      const next = {
        ...fence,
        ...(change === "environment"
          ? { environmentId: M.EnvironmentId.make("new") }
          : change === "space"
            ? { memorySpaceId: M.MemorySpaceId.make(uuid(9)) }
            : { session: "new" }),
      };
      expect(sameMemoryImportFence(fence, next)).toBe(false);
      f.workflow.invalidate(next);
      gate.resolve(f.result(input));
      await recovering;
      expect(f.workflow.getState().phase).toBe("idle");
      expect(await f.store.load(destination)).not.toBeNull();
    },
  );
  it("clears matching destination on rebind/revoke/removal and discards late apply", async () => {
    const f = workflowFixture();
    await f.ready();
    const started = deferred<M.MemoryImportProviderInput>();
    const gate = deferred<M.MemoryImportProviderResult>();
    f.setRespond((input) => {
      started.resolve(input);
      return gate.promise;
    });
    const applying = f.workflow.apply();
    const input = await started.promise;
    await f.workflow.removeDestination();
    gate.resolve(f.result(input));
    await applying;
    expect(f.workflow.getState().phase).toBe("idle");
    expect(await f.store.load(destination)).toBeNull();
  });
  it("retains partial receipts and never automatically reapplies them", async () => {
    const f = workflowFixture();
    await f.ready();
    f.setRespond(async (input) => {
      const result = f.result(input);
      return result.action === "apply" || result.action === "status"
        ? { ...result, receipt: { ...result.receipt, state: "partial", remaining: 1 } }
        : result;
    });
    await f.workflow.apply();
    expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(1);
    await f.workflow.recover();
    expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(1);
    expect(f.workflow.getState().phase).toBe("recovery");
    expect(await f.store.load(destination)).not.toBeNull();
  });
  it("rejects stale selection, invalidated previews and revoked execution permission", async () => {
    const f = workflowFixture(1);
    await f.workflow.preview(sourceId);
    f.workflow.select([{ ...f.items[0]!, sourceFingerprint: "b".repeat(64) }]);
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
    await f.ready();
    f.setPermitted(false);
    await f.workflow.apply();
    expect(f.calls.some((input) => input.action === "apply")).toBe(false);
    expect(await f.store.load(destination)).toBeNull();
    f.workflow.invalidate();
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
  });
  it("does not use an old unresolved operation as new apply authority", async () => {
    const f = workflowFixture(1);
    await f.store.save(destination, operationId);
    await f.ready();
    await expect(f.workflow.apply()).rejects.toThrow("previous import");
    expect(f.calls.some((input) => input.action === "apply")).toBe(false);
  });
  it("bounds selection and disallows duplicate keys", () => {
    expect(() => memoryImportChunks([])).toThrow();
    expect(() => memoryImportChunks(selections(129))).toThrow();
    expect(() => memoryImportChunks([...selections(1), ...selections(1)])).toThrow();
  });
});

describe("pure import progress", () => {
  it("settles an admitted chunk after Stop without mutating prior progress", () => {
    const f = workflowFixture(1);
    const response = f.result({
      action: "status",
      memorySpaceId: destination.memorySpaceId,
      operationId,
    });
    if (response.action !== "status") throw new Error("Status fixture required");
    const before = { ...initialMemoryImportWorkflowState, phase: "applying" as const };
    const stopped = reduceMemoryImportProgress(before, { type: "stop", inFlight: true });
    const received = reduceMemoryImportProgress(stopped, {
      type: "receipt",
      receipt: response.receipt,
    });
    const finished = reduceMemoryImportProgress(received, { type: "finish", totalChunks: 1 });
    expect(before).toMatchObject({ phase: "applying", stopped: false, settledChunks: 0 });
    expect(finished).toMatchObject({ phase: "partial", stopped: true, settledChunks: 1 });
  });
  it.each(["stop", "revoke", "invalidate"])(
    "prevents admission when %s occurs during persistence",
    async (action) => {
      const f = workflowFixture(1);
      const saved = deferred<void>();
      const gate = deferred<void>();
      const write = f.storage.setItem;
      f.storage.setItem = async (key, value) => {
        write(key, value);
        saved.resolve();
        await gate.promise;
      };
      await f.ready();
      const applying = f.workflow.apply();
      await saved.promise;
      if (action === "stop") f.workflow.stop();
      if (action === "revoke") f.setPermitted(false);
      if (action === "invalidate") f.workflow.invalidate({ ...fence, session: "changed" });
      gate.resolve();
      await applying;
      expect(f.calls.some((input) => input.action === "apply")).toBe(false);
      expect(await f.store.load(destination)).toBeNull();
    },
  );
  it("expired handles cannot trigger apply or status on restart", async () => {
    const f = workflowFixture(1);
    const handle = await f.store.save(destination, operationId);
    f.setNow(handle.expiresAt);
    await f.workflow.recover();
    expect(f.calls).toHaveLength(0);
    expect(f.workflow.getState().phase).toBe("repreview");
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
  });
});
