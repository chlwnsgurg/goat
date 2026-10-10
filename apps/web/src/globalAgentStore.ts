import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";

export const GLOBAL_AGENT_STORAGE_KEY = "t3code:global-agent:v1";
export const GLOBAL_AGENT_STORAGE_VERSION = 1;

/**
 * The one projectless thread T3 opens on launch and from the sidebar logo.
 * Client-local: each installation remembers its own global agent.
 */
export interface GlobalAgentRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftId: DraftId;
}

export interface GlobalAgentStoreState {
  ref: GlobalAgentRef | null;
  setRef: (ref: GlobalAgentRef) => void;
  /** Forgets the global agent when the given thread is it (archived or deleted here). */
  clearIfThread: (target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export function isGlobalAgentRef(value: unknown): value is GlobalAgentRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    isNonEmptyString(ref.environmentId) &&
    isNonEmptyString(ref.threadId) &&
    isNonEmptyString(ref.draftId)
  );
}

function readPersistedRef(persisted: unknown): GlobalAgentRef | null {
  const ref = (persisted as { ref?: unknown } | null | undefined)?.ref;
  return isGlobalAgentRef(ref) ? ref : null;
}

/** Hydration from another storage version. */
export function migratePersistedGlobalAgent(persisted: unknown): { ref: GlobalAgentRef | null } {
  return { ref: readPersistedRef(persisted) };
}

/** Same-version hydration: zustand skips migrate here, so validate again. */
export function mergePersistedGlobalAgent(
  persisted: unknown,
  current: GlobalAgentStoreState,
): GlobalAgentStoreState {
  return { ...current, ref: readPersistedRef(persisted) };
}

export const useGlobalAgentStore = create<GlobalAgentStoreState>()(
  persist(
    (set) => ({
      ref: null,
      setRef: (ref) => set({ ref }),
      clearIfThread: (target) =>
        set((state) =>
          state.ref !== null &&
          state.ref.environmentId === target.environmentId &&
          state.ref.threadId === target.threadId
            ? { ref: null }
            : state,
        ),
    }),
    {
      name: GLOBAL_AGENT_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: GLOBAL_AGENT_STORAGE_VERSION,
      migrate: (persisted) => migratePersistedGlobalAgent(persisted) as GlobalAgentStoreState,
      merge: (persisted, current) => mergePersistedGlobalAgent(persisted, current),
      partialize: ({ ref }) => ({ ref }),
    },
  ),
);
