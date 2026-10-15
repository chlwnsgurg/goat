import { randomUUID } from "./utils";
import {
  createMemoryImportRecoveryStore,
  memoryImportRecoveryKey,
  type MemoryImportDestination,
  type MemoryImportRecoveryStorage,
} from "@goat/client-runtime/memory-import-recovery";

export const unsafeImportBrowserMessage =
  "This browser can't safely run imports. Use a current browser or the desktop app.";
export const changedImportDestinationMessage =
  "Destination changed. Choose a scope and preview again.";
export function canSafelyImport() {
  return typeof navigator !== "undefined" && !!navigator.locks;
}
function withDestinationLock<T>(destination: MemoryImportDestination, run: () => Promise<T>) {
  return canSafelyImport()
    ? navigator.locks.request(memoryImportRecoveryKey(destination), run)
    : run();
}
export const memoryImportGenerationKey = (destination: MemoryImportDestination) =>
  `${memoryImportRecoveryKey(destination)}:generation`;

const stores = new WeakMap<
  MemoryImportRecoveryStorage,
  ReturnType<typeof createMemoryImportRecoveryStore>
>();
/** All admission, including the read/check/write sequence, runs inside the destination lock. */
export function memoryImportRecoveryStorage(
  storage: MemoryImportRecoveryStorage = window.localStorage,
) {
  let store = stores.get(storage);
  if (!store) {
    const base = createMemoryImportRecoveryStore(storage, () => Date.now());
    store = {
      load: (destination) => withDestinationLock(destination, () => base.load(destination)),
      save: (destination, operationId) => {
        if (!canSafelyImport()) return Promise.reject(new Error(unsafeImportBrowserMessage));
        return withDestinationLock(destination, () => base.save(destination, operationId));
      },
      clear: (destination, operationId) =>
        withDestinationLock(destination, () => base.clear(destination, operationId)),
    };
    stores.set(storage, store);
  }
  return store;
}

/** One preview generation per importer; the shared generation is the authoritative fence. */
export function createMemoryImportAdmission(
  destination: MemoryImportDestination,
  invalidate: () => void = () => {},
  storage: MemoryImportRecoveryStorage = window.localStorage,
) {
  const base = createMemoryImportRecoveryStore(storage, () => Date.now());
  const invalidations = new Set([invalidate]);
  let previewGeneration: string | null | undefined;
  return {
    subscribeInvalidation: (listener: () => void) => {
      invalidations.add(listener);
      return () => {
        invalidations.delete(listener);
      };
    },
    capturePreview: async () => {
      previewGeneration = await storage.getItem(memoryImportGenerationKey(destination));
    },
    recovery: {
      ...memoryImportRecoveryStorage(storage),
      save: (target: MemoryImportDestination, operationId: Parameters<typeof base.save>[1]) => {
        if (!canSafelyImport()) return Promise.reject(new Error(unsafeImportBrowserMessage));
        return withDestinationLock(target, async () => {
          if (
            previewGeneration === undefined ||
            previewGeneration !== (await storage.getItem(memoryImportGenerationKey(target)))
          ) {
            for (const listener of invalidations) listener();
            throw new Error(changedImportDestinationMessage);
          }
          return base.save(target, operationId);
        });
      },
    },
  };
}

const activeDestinations = new Set<{
  destination: MemoryImportDestination;
  remove: () => Promise<void>;
}>();
/** Storage notifications stop other tabs promptly; admission remains fenced even if delivery is late. */
export function registerMemoryImportDestination(
  destination: MemoryImportDestination,
  remove: () => Promise<void>,
) {
  const entry = { destination, remove };
  activeDestinations.add(entry);
  const changed = (event: StorageEvent) => {
    if (
      event.storageArea === window.localStorage &&
      (event.key === memoryImportGenerationKey(destination) || event.key === null)
    )
      void remove();
  };
  window.addEventListener("storage", changed);
  return () => {
    activeDestinations.delete(entry);
    window.removeEventListener("storage", changed);
  };
}
/** Binding changes preserve unresolved handles, including work already sent by another tab. */
export async function removeMemoryImportDestination(
  destination: MemoryImportDestination,
  storage: MemoryImportRecoveryStorage = window.localStorage,
) {
  await withDestinationLock(destination, async () => {
    await storage.setItem(memoryImportGenerationKey(destination), randomUUID());
  });
  const matching = [...activeDestinations].filter(
    (entry) =>
      entry.destination.environmentId === destination.environmentId &&
      entry.destination.memorySpaceId === destination.memorySpaceId,
  );
  await Promise.all(matching.map((entry) => entry.remove()));
}
