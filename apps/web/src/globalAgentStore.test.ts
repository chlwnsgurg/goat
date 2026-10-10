import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createJSONStorage } from "zustand/middleware";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  GLOBAL_AGENT_STORAGE_KEY,
  isGlobalAgentRef,
  mergePersistedGlobalAgent,
  migratePersistedGlobalAgent,
  useGlobalAgentStore,
} from "./globalAgentStore";
import { createMemoryStorage } from "./lib/storage";

const REF = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
  draftId: "draft-1" as DraftId,
};

async function hydrateFrom(raw: unknown) {
  const storage = createMemoryStorage();
  storage.setItem(GLOBAL_AGENT_STORAGE_KEY, JSON.stringify(raw));
  useGlobalAgentStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  await useGlobalAgentStore.persist.rehydrate();
  return useGlobalAgentStore.getState().ref;
}

beforeEach(() => {
  useGlobalAgentStore.setState({ ref: null });
});

describe("isGlobalAgentRef", () => {
  it("accepts a complete ref", () => {
    expect(isGlobalAgentRef(REF)).toBe(true);
  });
  it("rejects an empty field", () => {
    expect(isGlobalAgentRef({ ...REF, draftId: "" })).toBe(false);
  });
  it("rejects non-objects", () => {
    expect(isGlobalAgentRef(null)).toBe(false);
    expect(isGlobalAgentRef(42)).toBe(false);
  });
});

describe("persisted global agent", () => {
  it("migrate keeps a valid ref", () => {
    expect(migratePersistedGlobalAgent({ ref: REF })).toEqual({ ref: REF });
  });
  it("migrate drops an invalid ref", () => {
    expect(migratePersistedGlobalAgent({ ref: 1 })).toEqual({ ref: null });
  });
  it("merge drops an invalid ref and keeps actions", () => {
    const current = useGlobalAgentStore.getState();
    const merged = mergePersistedGlobalAgent({ ref: { ...REF, draftId: "" } }, current);
    expect(merged.ref).toBeNull();
    expect(merged.setRef).toBe(current.setRef);
  });
  it("same-version hydration drops an invalid ref (merge path)", async () => {
    expect(await hydrateFrom({ state: { ref: { ...REF, threadId: "" } }, version: 1 })).toBeNull();
  });
  it("same-version hydration keeps a valid ref", async () => {
    expect(await hydrateFrom({ state: { ref: REF }, version: 1 })).toEqual(REF);
  });
  it("older-version hydration keeps a valid ref (migrate path)", async () => {
    expect(await hydrateFrom({ state: { ref: REF }, version: 0 })).toEqual(REF);
  });
});

describe("clearIfThread", () => {
  it("clears the matching thread", () => {
    useGlobalAgentStore.setState({ ref: REF });
    useGlobalAgentStore
      .getState()
      .clearIfThread({ environmentId: REF.environmentId, threadId: REF.threadId });
    expect(useGlobalAgentStore.getState().ref).toBeNull();
  });
  it("keeps the ref for another thread", () => {
    useGlobalAgentStore.setState({ ref: REF });
    useGlobalAgentStore
      .getState()
      .clearIfThread({ environmentId: REF.environmentId, threadId: "thread-2" as ThreadId });
    expect(useGlobalAgentStore.getState().ref).toEqual(REF);
  });
});
