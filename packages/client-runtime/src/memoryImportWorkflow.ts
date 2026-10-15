import type {
  MemoryImportFormat,
  MemoryImportProviderInput,
  MemoryImportProviderResult,
  MemoryImportReceipt,
  MemoryImportSourceId,
  MemoryOperationId,
} from "@goat/contracts";
import type { MemoryImportDestination, MemoryImportRecoveryStore } from "./memoryImportRecovery.ts";

type Apply = Extract<MemoryImportProviderInput, { action: "apply" }>;
type Preview = Extract<MemoryImportProviderResult, { action: "preview" }>;
export type MemoryImportSelection = Apply["items"][number];
export type MemoryImportFence = MemoryImportDestination & { readonly session: string };
export type MemoryImportPhase =
  | "idle"
  | "discovering"
  | "discovered"
  | "previewing"
  | "selecting"
  | "previewed"
  | "saving"
  | "applying"
  | "checking"
  | "recovery"
  | "partial"
  | "completed"
  | "repreview";
export interface MemoryImportWorkflowState {
  readonly phase: MemoryImportPhase;
  readonly stopped: boolean;
  readonly settledChunks: number;
  readonly receipt: MemoryImportReceipt | null;
  readonly message: string | null;
}

export const initialMemoryImportWorkflowState: MemoryImportWorkflowState = {
  phase: "idle",
  stopped: false,
  settledChunks: 0,
  receipt: null,
  message: null,
};
export type MemoryImportProgressEvent =
  | { readonly type: "stop"; readonly inFlight: boolean }
  | { readonly type: "receipt"; readonly receipt: MemoryImportReceipt }
  | { readonly type: "finish"; readonly totalChunks: number };

/** Pure progress reduction: stopping never turns an admitted receipt into cancellation. */
export function reduceMemoryImportProgress(
  state: MemoryImportWorkflowState,
  event: MemoryImportProgressEvent,
): MemoryImportWorkflowState {
  switch (event.type) {
    case "stop":
      return {
        ...state,
        stopped: true,
        phase: event.inFlight ? state.phase : "partial",
        message: "Stopped future chunks. An import already sent may still be applied.",
      };
    case "receipt":
      return event.receipt.state === "partial"
        ? {
            ...state,
            phase: "recovery",
            receipt: event.receipt,
            message: "Some items may have been applied. Check the import result.",
          }
        : { ...state, receipt: event.receipt, settledChunks: state.settledChunks + 1 };
    case "finish":
      return {
        ...state,
        phase: state.stopped || state.settledChunks !== event.totalChunks ? "partial" : "completed",
      };
  }
}

/** Snapshot selection/scope/project and split without ever persisting selectors. */
export function memoryImportChunks(items: readonly MemoryImportSelection[]) {
  if (items.length === 0 || items.length > 128) throw new Error("Select between 1 and 128 items");
  if (new Set(items.map((item) => item.sourceItemKey)).size !== items.length)
    throw new Error("Select each item once");
  const snapshot = structuredClone(items);
  return Array.from({ length: Math.ceil(snapshot.length / 32) }, (_, i) =>
    snapshot.slice(i * 32, (i + 1) * 32),
  );
}

export function sameMemoryImportFence(a: MemoryImportFence, b: MemoryImportFence) {
  return (
    a.environmentId === b.environmentId &&
    a.memorySpaceId === b.memorySpaceId &&
    a.session === b.session
  );
}

/** Inject the existing state/memory.importProvider guarded command, never a raw RPC client.
 * canImport must read that command's permissionAtom for this exact environment at execution.
 * A recovery handle is status-only evidence, never authority to apply again.
 */
export function createMemoryImportWorkflow(options: {
  readonly fence: MemoryImportFence;
  readonly recovery: MemoryImportRecoveryStore;
  readonly canImport: (destination: MemoryImportDestination) => boolean;
  readonly request: (
    environmentId: MemoryImportDestination["environmentId"],
    input: MemoryImportProviderInput,
  ) => Promise<MemoryImportProviderResult>;
  readonly operationId: () => MemoryOperationId;
}) {
  let fence = { ...options.fence };
  let generation = 0;
  let busy = false;
  let state = initialMemoryImportWorkflowState;
  let preview: Preview | null = null;
  let chunks: Array<{ operationId: MemoryOperationId; items: Apply["items"] }> = [];
  const current = (token: number) => token === generation;
  const permitted = () => options.canImport(fence);
  const set = (patch: Partial<MemoryImportWorkflowState>) => {
    state = { ...state, ...patch };
  };
  const request = (input: MemoryImportProviderInput) => {
    if (!permitted()) throw new Error("Memory import is unavailable");
    return options.request(fence.environmentId, input);
  };
  function invalidate(next = fence) {
    fence = { ...next };
    generation++;
    preview = null;
    chunks = [];
    set({ phase: "idle", stopped: false, settledChunks: 0, receipt: null, message: null });
  }
  async function exclusive<T>(run: (token: number) => Promise<T>) {
    if (busy) throw new Error("Wait for the current import request");
    busy = true;
    const token = generation;
    try {
      return await run(token);
    } finally {
      busy = false;
    }
  }
  return {
    getState: () => state,
    /** Call for destination/session changes. Selection or scope changes also invalidate preview. */
    invalidate,
    removeDestination: async () => {
      const previous = { ...fence };
      invalidate();
      await options.recovery.clear(previous);
    },
    stop: () => {
      state = reduceMemoryImportProgress(state, { type: "stop", inFlight: busy });
    },
    discover: (format: MemoryImportFormat) =>
      exclusive(async (token) => {
        preview = null;
        chunks = [];
        set({
          phase: "discovering",
          stopped: false,
          settledChunks: 0,
          receipt: null,
          message: null,
        });
        const result = await request({
          action: "discover",
          format,
          memorySpaceId: fence.memorySpaceId,
        });
        if (!current(token)) return;
        if (result.action !== "discover") throw new Error("Unexpected import result");
        set({ phase: "discovered" });
        return result;
      }),
    preview: (sourceId: MemoryImportSourceId) =>
      exclusive(async (token) => {
        preview = null;
        chunks = [];
        set({
          phase: "previewing",
          stopped: false,
          settledChunks: 0,
          receipt: null,
          message: null,
        });
        const result = await request({
          action: "preview",
          sourceId,
          memorySpaceId: fence.memorySpaceId,
        });
        if (!current(token)) return;
        if (result.action !== "preview" || result.sourceId !== sourceId)
          throw new Error("Unexpected import preview");
        preview = structuredClone(result);
        set({ phase: "selecting" });
        return result;
      }),
    /** Confirm once. Any later selection/scope change must invalidate and preview again. */
    select: (items: readonly MemoryImportSelection[]) => {
      if (busy || state.phase !== "selecting" || preview === null)
        throw new Error("Preview before selecting items");
      const selected = memoryImportChunks(items);
      const fixedPreview = preview;
      if (
        selected
          .flat()
          .some(
            (item) =>
              !fixedPreview.items.some(
                (candidate) =>
                  candidate.sourceItemKey === item.sourceItemKey &&
                  candidate.sourceFingerprint === item.sourceFingerprint &&
                  candidate.issue === undefined,
              ),
          )
      ) {
        preview = null;
        set({
          phase: "repreview",
          message: "The selection changed. Preview again before importing.",
        });
        return;
      }
      chunks = selected.map((items) => ({ operationId: options.operationId(), items }));
      if (new Set(chunks.map((chunk) => chunk.operationId)).size !== chunks.length) {
        chunks = [];
        throw new Error("Each chunk needs a distinct operation");
      }
      set({ phase: "previewed" });
    },
    /** One deliberate start runs sequential chunks; recovery never calls this method. */
    apply: () =>
      exclusive(async (token) => {
        if (state.phase !== "previewed" || preview === null || state.stopped)
          throw new Error("Preview before importing");
        const fixedPreview = preview;
        const destination = { ...fence };
        for (const chunk of chunks) {
          if (!current(token) || state.stopped) break;
          if (!permitted()) {
            set({ phase: "partial", message: "Memory import is unavailable" });
            break;
          }
          set({ phase: "saving" });
          // Storage failure must escape before request admission. Existing unresolved IDs cannot be replaced.
          await options.recovery.save(destination, chunk.operationId);
          if (!current(token) || state.stopped || !permitted()) {
            await options.recovery.clear(destination, chunk.operationId);
            if (current(token)) set({ phase: "partial" });
            break;
          }
          set({ phase: "applying" });
          try {
            const result = await request({
              action: "apply",
              memorySpaceId: destination.memorySpaceId,
              sourceId: fixedPreview.sourceId,
              sessionId: fixedPreview.sessionId,
              operationId: chunk.operationId,
              items: chunk.items,
            });
            if (!current(token)) return;
            if (
              result.action !== "apply" ||
              result.receipt.operationId !== chunk.operationId ||
              result.receipt.sessionId !== fixedPreview.sessionId ||
              result.receipt.sourceId !== fixedPreview.sourceId
            )
              throw new Error("Unexpected import result");
            // A partial receipt is unresolved: do not discard its recovery ID or admit another chunk.
            if (result.receipt.state === "partial") {
              state = reduceMemoryImportProgress(state, {
                type: "receipt",
                receipt: result.receipt,
              });
              return;
            }
            await options.recovery.clear(destination, chunk.operationId);
            if (!current(token)) return;
            state = reduceMemoryImportProgress(state, { type: "receipt", receipt: result.receipt });
          } catch {
            if (current(token))
              set({
                phase: "recovery",
                message: "The result is unknown. Reconnect and check the import result.",
              });
            return;
          }
        }
        if (current(token))
          state = reduceMemoryImportProgress(state, { type: "finish", totalChunks: chunks.length });
      }),
    /** Restart/offline recovery issues exactly one status request and never an apply. */
    recover: () =>
      exclusive(async (token) => {
        const destination = { ...fence };
        const handle = await options.recovery.load(destination);
        if (!current(token)) return;
        if (handle === null) {
          set({
            phase: "repreview",
            message: "Preview again before importing. Previous items may have been applied.",
          });
          return;
        }
        set({ phase: "checking" });
        try {
          const result = await request({
            action: "status",
            memorySpaceId: destination.memorySpaceId,
            operationId: handle.operationId,
          });
          if (!current(token)) return;
          if (result.action !== "status" || result.receipt.operationId !== handle.operationId)
            throw new Error("Unexpected import status");
          if (result.receipt.state === "completed")
            await options.recovery.clear(destination, handle.operationId);
          if (!current(token)) return;
          preview = null;
          chunks = [];
          set({
            phase: result.receipt.state === "partial" ? "recovery" : "repreview",
            receipt: result.receipt,
            message: "Review the result and preview again before importing more items.",
          });
        } catch (error) {
          if (!current(token)) return;
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "not_found"
          ) {
            await options.recovery.clear(destination, handle.operationId);
            if (current(token))
              set({
                phase: "repreview",
                message:
                  "The saved result is unavailable. Previous items may have been applied. Preview again.",
              });
          } else set({ phase: "recovery", message: "Reconnect and check the import result." });
        }
      }),
  };
}
