import {
  createMemoryImportRecoveryStore,
  type MemoryImportRecoveryStorage,
} from "@goat/client-runtime/memory-import-recovery";

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
    store = createMemoryImportRecoveryStore(storage, Date.now);
    stores.set(storage, store);
  }
  return store;
}
