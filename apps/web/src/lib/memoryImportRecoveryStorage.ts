import {
  createMemoryImportRecoveryStore,
  memoryImportRecoveryKey,
  type MemoryImportDestination,
  type MemoryImportRecoveryStorage,
} from "@goat/client-runtime/memory-import-recovery";

/** A browser-wide lock prevents two tabs from replacing the same unresolved handle. */
function withDestinationLock<T>(destination: MemoryImportDestination, run: () => Promise<T>) {
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request(memoryImportRecoveryKey(destination), run)
    : run();
}

/** One store owns serialization for each browser storage adapter, including remounts. */
const stores = new WeakMap<
  MemoryImportRecoveryStorage,
  ReturnType<typeof createMemoryImportRecoveryStore>
>();
export function memoryImportRecoveryStorage(
  storage: MemoryImportRecoveryStorage = window.localStorage,
) {
  let store = stores.get(storage);
  if (!store) {
    const base = createMemoryImportRecoveryStore(storage, () => Date.now());
    store = {
      load: (destination) => withDestinationLock(destination, () => base.load(destination)),
      save: (destination, operationId) =>
        withDestinationLock(destination, () => base.save(destination, operationId)),
      clear: (destination, operationId) =>
        withDestinationLock(destination, () => base.clear(destination, operationId)),
    };
    stores.set(storage, store);
  }
  return store;
}
