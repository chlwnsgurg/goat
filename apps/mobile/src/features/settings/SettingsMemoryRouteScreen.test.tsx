// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  WS_METHODS,
  MemoryItem,
  MemoryMutationReceipt,
  type MemoryForgetInput,
  MemorySourcePage,
  type MemoryUpsertInput,
  MemoryHistoryPage,
  MemoryRevertResult,
  type MemoryRevertResolutionInput,
} from "@goat/contracts";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  nativeDevice,
  nativeSpace,
  nativeId,
  nativeSyncStatus,
  nativeItem,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { SettingsMemoryRouteScreen, MemoryEnvironmentEntry } from "./SettingsMemoryRouteScreen";

let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
  vi.restoreAllMocks();
});
async function mount(
  scopes?: Parameters<NativeMemoryHarness["grant"]>[0],
  setup?: (harness: NativeMemoryHarness) => void,
) {
  h = createNativeMemoryHarness();
  setup?.(h);
  if (scopes) h.grant(scopes);
  await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
  view = renderNative(
    h,
    <SettingsMemoryRouteScreen
      route={{ params: { environmentId: nativeEnv, memorySpaceId: nativeSpace } }}
    />,
  );
  await view.render();
}
const originalId = "00000000-0000-4000-8000-000000000003";
const resolutionId = "00000000-0000-4000-8000-000000000006";
const decodeRevertResult = Schema.decodeUnknownSync(MemoryRevertResult);
const decodeItem = Schema.decodeUnknownSync(MemoryItem);
const decodeSource = Schema.decodeUnknownSync(MemorySourcePage);
const decodeHistory = Schema.decodeUnknownSync(MemoryHistoryPage);
function revertHistory() {
  if (nativeItem.status !== "active") throw new Error("Expected active fixture");
  return decodeHistory({
    memoryId: nativeId,
    revisions: [
      {
        revision: { ...nativeItem.revision, revisionId: originalId, payloadRef: originalId },
        payload: nativeItem.status === "active" ? nativeItem.payload : null,
      },
    ],
    resolutions: [
      {
        resolution: {
          resolutionId,
          memorySpaceId: nativeSpace,
          memoryId: nativeId,
          inputRevisionIds: [originalId, "00000000-0000-4000-8000-000000000007"],
          inputPayloadRefs: [originalId, "00000000-0000-4000-8000-000000000007"],
          judgmentRef: resolutionId,
          requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
          effectiveProvider: "codex",
          effectiveModel: "synthetic",
          resolvingEnvironmentId: nativeEnv,
          fencingToken: 1,
          resultRevisionId: "00000000-0000-4000-8000-000000000004",
          appliedAtUtc: "2000-01-01T00:00:00.000Z",
          revertDeadlineUtc: "2000-01-31T00:00:00.000Z",
        },
        payload: { resolutionId, judgment: "Synthetic resolution" },
      },
    ],
    tombstone: null,
    reports: [],
    revertResults: [],
    localAvailability: nativeItem.localAvailability,
    nextCursor: null,
  });
}
const decodeReceipt = Schema.decodeUnknownSync(MemoryMutationReceipt);
function receipt(input: unknown, rejected = false) {
  return decodeReceipt({
    operationId: (input as MemoryForgetInput).operationId,
    memoryId: nativeId,
    revisionId: null,
    outcome: rejected ? "rejected" : "deleted",
    pendingSync: !rejected,
    ...(rejected ? { failureCode: "revision_changed" } : {}),
  });
}
describe("native Memory with shared factory", () => {
  it("searches the selected destination, retains an empty page's cursor, and clears search", async () => {
    await mount();
    expect(view.container.textContent).toContain("Synthetic memory body");
    await view.type("Search memory", "absent");
    await view.click("Search");
    expect(view.container.textContent).toContain("No matching memories on this page");
    await view.click("Next page");
    const searches = h.calls.filter((call) => call.method === WS_METHODS.memorySearch);
    expect(searches).toHaveLength(2);
    expect(searches[1]).toMatchObject({
      environmentId: nativeEnv,
      input: { memorySpaceId: nativeSpace, query: "absent", cursor: "synthetic-next" },
    });
    await view.click("Clear");
    expect(view.container.textContent).toContain("Synthetic memory body");
  });
  it("keeps the bootstrap subscription stable until a new reset makes it ready", async () => {
    h = createNativeMemoryHarness();
    h.grant(["memory:read", "memory:write", "settings:write"]);
    const initial = h.deferred<unknown>();
    const refresh = h.deferred<unknown>();
    let calls = 0;
    h.responses.set(WS_METHODS.memorySyncStatus, () =>
      ++calls === 1 ? initial.response : calls === 2 ? refresh.response : nativeSyncStatus,
    );
    await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
    view = renderNative(
      h,
      <SettingsMemoryRouteScreen route={{ params: { environmentId: nativeEnv } }} />,
    );
    await view.render();
    await act(async () => {
      await initial.succeed({ ...nativeSyncStatus, state: "bootstrapping" });
    });
    expect(calls).toBe(2);
    await act(async () => {
      await refresh.succeed({ ...nativeSyncStatus, state: "bootstrapping" });
    });
    expect(calls).toBe(2);
    await view.render();
    expect(calls).toBe(2);
    await act(async () => {
      await h.signal({ kind: "reset", memorySpaceId: nativeSpace, projectionWatermark: 2 });
    });
    expect(calls).toBe(3);
    expect(view.container.textContent).toContain("Synthetic memory body");
    expect(view.container.textContent).toContain("Hub connected");
  });
  it("retains local forget completion when the signal closes details before the receipt", async () => {
    await mount();
    const response = h.deferred<unknown>();
    h.responses.set(WS_METHODS.memoryForget, () => response.response);
    await view.click("Open memory: Synthetic memory body");
    await view.click("Forget");
    expect(view.container.textContent).not.toContain("provider's original");
    await view.click("Confirm forget");
    const input = h.calls.find((c) => c.method === WS_METHODS.memoryForget)!.input;
    await act(async () => {
      await h.signal({
        kind: "forget",
        memorySpaceId: nativeSpace,
        memoryId: nativeId,
        projectionWatermark: 2,
      });
    });
    expect(view.container.textContent).not.toContain("Close details");
    expect(view.container.textContent).not.toContain("Forgotten. Other devices");
    await act(async () => {
      await response.succeed(receipt(input));
    });
    expect(view.container.textContent).toContain(
      "Forgotten. Other devices remove it when they sync.",
    );
  });
  it.each([false, true])(
    "shows provider retention notice only for imported memories (%s)",
    async (imported) => {
      await mount();
      if (nativeItem.status !== "active") throw new Error("active fixture required");
      const item = decodeItem({
        ...nativeItem,
        payload: {
          ...nativeItem.payload,
          evidence: imported
            ? [{ origin: "import", importSourceId: originalId, messageIds: [] }]
            : nativeItem.payload.evidence,
        },
      });
      h.responses.set(WS_METHODS.memoryRead, () => item);
      h.responses.set(WS_METHODS.memoryForget, (input) => receipt(input));
      await view.click("Open memory: Synthetic memory body");
      await view.click("Forget");
      expect(
        view.container.textContent!.includes("The provider's original conversation stays"),
      ).toBe(imported);
      await view.click("Confirm forget");
      expect(view.container.textContent).toContain("Forgotten. Other devices");
      expect(
        view.container.textContent!.includes("The provider's original conversation stays"),
      ).toBe(imported);
    },
  );
  it("explains a metadata-only forgotten row without its removed body", async () => {
    h = createNativeMemoryHarness();
    const item = decodeItem({
      memorySpaceId: nativeSpace,
      memoryId: nativeId,
      status: "forgotten",
      pendingSync: false,
      localAvailability: { ...nativeItem.localAvailability, exposure: "forgotten" },
      tombstone: {
        memorySpaceId: nativeSpace,
        memoryId: nativeId,
        deleteOperationId: originalId,
        deletingEnvironmentId: nativeEnv,
        deletedAtUtc: "2026-10-15T00:00:00.000Z",
        suppressedSourceKeys: [],
        suppressedContent: [],
        sourceExclusions: [],
      },
    });
    h.responses.set(WS_METHODS.memoryList, () => ({
      items: [item],
      nextCursor: null,
      projectionWatermark: 1,
    }));
    await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
    view = renderNative(
      h,
      <SettingsMemoryRouteScreen route={{ params: { environmentId: nativeEnv } }} />,
    );
    await view.render();
    expect(view.container.textContent).toContain("Forgotten memory");
    expect(view.container.textContent).toContain("The memory body has been removed.");
    expect(view.container.textContent).not.toContain("Synthetic memory body");
  });
  it("keeps rejected forget open and reports failure with a schema-valid receipt", async () => {
    await mount();
    h.responses.set(WS_METHODS.memoryForget, (input) => receipt(input, true));
    await view.click("Open memory: Synthetic memory body");
    await view.click("Forget");
    await view.click("Confirm forget");
    expect(view.container.textContent).toContain("Could not forget this memory. Review the record");
    expect(view.container.textContent).toContain("Close details");
    expect(view.container.textContent).not.toContain("Forgotten. Other devices");
  });
  it.each([2, 3])(
    "restores the displayed Original %i with missing payloads and reversed inputs",
    async (number) => {
      await mount();
      const history = revertHistory();
      if (nativeItem.status !== "active") throw new Error("active fixture required");
      const activeItem = nativeItem;
      const ids = [
        "00000000-0000-4000-8000-000000000009",
        originalId,
        "00000000-0000-4000-8000-000000000007",
      ];
      h.responses.set(WS_METHODS.memoryHistory, () =>
        decodeHistory({
          ...history,
          revisions: ids.map((revisionId, index) => ({
            revision: { ...activeItem.revision, revisionId, payloadRef: revisionId },
            payload:
              index === 0
                ? null
                : { ...activeItem.payload, text: `Distinct original ${index + 1}` },
          })),
          resolutions: history.resolutions.map((entry) => ({
            ...entry,
            resolution: {
              ...entry.resolution,
              inputRevisionIds: [ids[2], ids[1], ids[0]],
              inputPayloadRefs: [ids[2], ids[1], ids[0]],
            },
          })),
        }),
      );
      h.responses.set(WS_METHODS.memoryRevertResolution, () => {
        throw new Error("Synthetic response lost");
      });
      await view.click("Open memory: Synthetic memory body");
      expect(view.container.textContent).toContain("Original 2");
      expect(view.container.textContent).toContain("Original 3");
      expect(view.container.textContent).toContain("Distinct original 2");
      expect(view.container.textContent).toContain("Distinct original 3");
      expect(view.container.textContent).not.toContain("Restore original 1");
      const button = [...view.container.querySelectorAll("button")].find(
        (node) => node.textContent === `Restore original ${number}`,
      )!;
      expect(button.parentElement!.textContent).toContain(`Distinct original ${number}`);
      await view.click(`Restore original ${number}`);
      await view.click("Revert resolution");
      expect(
        h.calls.find((c) => c.method === WS_METHODS.memoryRevertResolution)?.input,
      ).toMatchObject({ restoredRevisionId: ids[number - 1] });
    },
  );
  it("saves through the shared command and hides the editor after grant revocation", async () => {
    await mount();
    h.responses.set(WS_METHODS.memoryUpsert, (input) => ({
      memoryId: (input as MemoryUpsertInput).memoryId,
      operationId: (input as MemoryUpsertInput).operationId,
      outcome: "accepted",
      pendingSync: true,
    }));
    await view.click("Remember something");
    await view.type("Memory text", "Synthetic new fact");
    await view.click("Save memory");
    expect(h.calls.find((call) => call.method === WS_METHODS.memoryUpsert)).toMatchObject({
      environmentId: nativeEnv,
      input: {
        memorySpaceId: nativeSpace,
        expectedHeads: [],
        scope: { kind: "user" },
        payload: { text: "Synthetic new fact" },
      },
    });
    await act(async () => h.revoke());
    expect(view.container.textContent).not.toContain("Synthetic new fact");
    expect(view.container.textContent).toContain("does not have permission");
  });
  it("forgets the exact memory after confirmation and drops invalidated bodies", async () => {
    await mount();
    await view.click("Open memory: Synthetic memory body");
    h.responses.set(WS_METHODS.memoryForget, (input) => receipt(input));
    await view.click("Forget");
    expect(h.calls.some((call) => call.method === WS_METHODS.memoryForget)).toBe(false);
    await act(async () => h.confirm());
    expect(h.calls.find((call) => call.method === WS_METHODS.memoryForget)).toMatchObject({
      environmentId: nativeEnv,
      input: {
        memorySpaceId: nativeSpace,
        memoryId: nativeId,
        expectedHeads: ["00000000-0000-4000-8000-000000000004"],
      },
    });
    await act(async () => {
      await h.signal({
        kind: "forget",
        memorySpaceId: nativeSpace,
        memoryId: nativeId,
        projectionWatermark: 2,
      });
    });
    expect(view.container.textContent).not.toContain("Synthetic memory body");
    expect(view.container.textContent).toContain(
      "Forgotten. Other devices remove it when they sync.",
    );
  });
  it("closes confirmation on grant loss and refuses an old callback after access is restored", async () => {
    await mount();
    await view.click("Open memory: Synthetic memory body");
    await view.click("Forget");
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    const oldConfirm = h.takeConfirmation()!;
    await act(async () => h.revoke());
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => h.grant(["memory:read", "memory:write", "orchestration:read"]));
    await view.click("Open memory: Synthetic memory body");
    expect(view.container.textContent).toContain("Synthetic memory body");
    await act(async () => oldConfirm());
    expect(h.calls.filter((call) => call.method === WS_METHODS.memoryForget)).toHaveLength(0);
  });
  it("selects a retained original despite a local deadline warning and settles with the hub result", async () => {
    await mount();
    h.responses.set(WS_METHODS.memoryHistory, revertHistory);
    h.responses.set(WS_METHODS.memoryRevertResolution, () => {
      throw new Error("Synthetic revert response lost");
    });
    await view.click("Open memory: Synthetic memory body");
    expect(view.container.textContent).toContain("The hub needs to confirm the revert window");
    await view.click("Restore original 1");
    await view.click("Revert resolution");
    h.responses.set(WS_METHODS.memoryRevertResolution, (value) => {
      const input = value as MemoryRevertResolutionInput;
      return decodeRevertResult({
        operationId: input.operationId,
        memoryId: nativeId,
        resolutionId,
        revertDeadlineUtc: "2000-01-31T00:00:00.000Z",
        status: "accepted",
        localAvailability: nativeItem.localAvailability,
        receipt: {
          operationId: input.operationId,
          memoryId: nativeId,
          revisionId: "00000000-0000-4000-8000-000000000008",
          outcome: "accepted",
          pendingSync: false,
        },
      });
    });
    await view.click("Retry revert request");
    const calls = h.calls.filter((call) => call.method === WS_METHODS.memoryRevertResolution);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toEqual(calls[0]!.input);
    expect(calls[1]).toMatchObject({
      environmentId: nativeEnv,
      input: {
        memorySpaceId: nativeSpace,
        memoryId: nativeId,
        resolutionId,
        restoredRevisionId: originalId,
        expectedHeads: ["00000000-0000-4000-8000-000000000004"],
      },
    });
    expect(view.container.textContent).toContain("Revert approved");
    expect(view.container.textContent).not.toContain("Retry revert request");
  });
  it("settles an eligible revert with the hub's expired result", async () => {
    await mount();
    h.responses.set(WS_METHODS.memoryHistory, revertHistory);
    h.responses.set(WS_METHODS.memoryRevertResolution, (value) => {
      const input = value as MemoryRevertResolutionInput;
      return decodeRevertResult({
        operationId: input.operationId,
        memoryId: nativeId,
        resolutionId,
        revertDeadlineUtc: "2000-01-31T00:00:00.000Z",
        status: "revert_expired",
      });
    });
    await view.click("Open memory: Synthetic memory body");
    await view.click("Restore original 1");
    await view.click("Revert resolution");
    expect(
      h.calls.filter((call) => call.method === WS_METHODS.memoryRevertResolution),
    ).toHaveLength(1);
    expect(view.container.textContent).toContain("Revert window expired");
    expect(view.container.textContent).not.toContain("Retry revert request");
    expect(view.container.textContent).not.toContain("Restore original");
  });
  it("clears a selected original after refreshed history no longer retains it", async () => {
    await mount();
    h.responses.set(WS_METHODS.memoryHistory, revertHistory);
    await view.click("Open memory: Synthetic memory body");
    await view.click("Restore original 1");
    h.responses.set(WS_METHODS.memoryHistory, () => ({ ...revertHistory(), revisions: [] }));
    await view.click("Refresh details");
    expect(view.container.textContent).toContain("Retained originals unavailable");
    expect(view.container.textContent).not.toContain("Selected original");
    expect(
      h.calls.filter((call) => call.method === WS_METHODS.memoryRevertResolution),
    ).toHaveLength(0);
  });
  it("closes revert selection after write permission is removed", async () => {
    await mount();
    h.responses.set(WS_METHODS.memoryHistory, revertHistory);
    await view.click("Open memory: Synthetic memory body");
    await view.click("Restore original 1");
    await act(async () => h.grant(["memory:read"]));
    expect(view.container.textContent).not.toContain("Selected original");
    expect(
      h.calls.filter((call) => call.method === WS_METHODS.memoryRevertResolution),
    ).toHaveLength(0);
  });
  it("sends no memory calls for an unsupported explicit destination", async () => {
    h = createNativeMemoryHarness();
    h.registry.set(h.configs(nativeEnv), null);
    view = renderNative(
      h,
      <SettingsMemoryRouteScreen
        route={{
          params: { environmentId: nativeEnv, memorySpaceId: nativeSpace, memoryId: nativeId },
        }}
      />,
    );
    await view.render();
    expect(view.container.textContent).toContain("Update this environment");
    expect(h.calls).toEqual([]);
  });
  it("preserves one save intent after a lost response and explicitly retries the same payload", async () => {
    await mount();
    h.responses.set(WS_METHODS.memoryUpsert, () => {
      throw new Error("Synthetic lost response");
    });
    await view.click("Remember something");
    await view.type("Memory text", "Synthetic retry fact");
    await view.click("Save memory");
    expect(view.container.textContent).toContain("Retry uses the same request");
    h.responses.set(WS_METHODS.memoryUpsert, () => ({ outcome: "accepted", pendingSync: true }));
    await view.click("Retry save request");
    const writes = h.calls.filter((call) => call.method === WS_METHODS.memoryUpsert);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.input).toEqual(writes[1]!.input);
  });
  it("keeps reading available on a read-only connection without allowing a write", async () => {
    await mount(["memory:read"]);
    expect(view.container.textContent).toContain("Synthetic memory body");
    await view.click("Remember something");
    expect(view.container.querySelector('input[aria-label="Memory text"]')).toBeNull();
    expect(h.calls.some((call) => call.method === WS_METHODS.memoryUpsert)).toBe(false);
  });
  it("unmounts history bodies and discards original entry when only read becomes unavailable", async () => {
    await mount();
    if (nativeItem.status !== "active") throw new Error("Expected active fixture");
    const sourceThread = { environmentId: nativeEnv, threadId: "synthetic-source-thread" };
    const item = decodeItem({
      ...nativeItem,
      payload: {
        ...nativeItem.payload,
        evidence: [
          {
            origin: "thread",
            sourceThread,
            watermark: { fromEventId: "e1", toEventId: "e2", throughSequence: 2 },
            messageIds: ["synthetic-message"],
          },
        ],
      },
    });
    const history = revertHistory();
    h.responses.set(WS_METHODS.memoryRead, () => item);
    h.responses.set(WS_METHODS.memoryHistory, () => history);
    h.responses.set(WS_METHODS.memoryReadSource, () =>
      decodeSource({
        sourceThread,
        watermark: { fromEventId: "e1", toEventId: "e2", throughSequence: 2 },
        messages: [{ messageId: "synthetic-message", text: "Synthetic original body" }],
        nextCursor: null,
      }),
    );
    await view.click("Open memory: Synthetic memory body");
    await view.click("Read original on Test hub");
    expect(view.container.textContent).toContain("Synthetic original body");
    expect(view.container.textContent).toContain("Synthetic resolution");
    const read = h.memory.read({
      environmentId: nativeEnv,
      input: { memorySpaceId: nativeSpace, memoryId: nativeId },
    });
    const historyAtom = h.memory.history({
      environmentId: nativeEnv,
      input: { memorySpaceId: nativeSpace, memoryId: nativeId, limit: 30 },
    });
    const resumed = h.deferred<MemoryItem>();
    h.responses.set(WS_METHODS.memoryRead, () => resumed.response);
    await act(async () => h.registry.refresh(read));
    const retained = h.registry.get(historyAtom);
    expect(AsyncResult.isSuccess(retained) && Option.isSome(retained.value)).toBe(true);
    expect(view.container.textContent).toContain("Memory unavailable");
    expect(view.container.textContent).not.toContain("Synthetic memory body");
    expect(view.container.textContent).not.toContain("Synthetic resolution");
    expect(view.container.textContent).not.toContain("Synthetic original body");
    expect(view.container.querySelector('section[aria-label="Original"]')).toBeNull();
    await act(async () => {
      await resumed.succeed(item);
    });
    expect(view.container.textContent).toContain("Synthetic memory body");
    expect(view.container.querySelector('section[aria-label="Original"]')).toBeNull();
    expect(h.calls.filter((call) => call.method === WS_METHODS.memoryReadSource)).toHaveLength(1);
    await view.click("Read original on Test hub");
    expect(view.container.querySelector('section[aria-label="Original"]')).not.toBeNull();
  });
  it("requires a new edit click after read access recovers", async () => {
    await mount();
    await view.click("Open memory: Synthetic memory body");
    await view.click("Edit");
    await view.type("Memory text", "Synthetic discarded draft");
    const read = h.memory.read({
      environmentId: nativeEnv,
      input: { memorySpaceId: nativeSpace, memoryId: nativeId },
    });
    const resumed = h.deferred<MemoryItem>();
    h.responses.set(WS_METHODS.memoryRead, () => resumed.response);
    await act(async () => h.registry.refresh(read));
    expect(view.container.querySelector('input[aria-label="Memory text"]')).toBeNull();
    await act(async () => {
      await resumed.succeed(nativeItem);
    });
    expect(view.container.querySelector('input[aria-label="Memory text"]')).toBeNull();
    await view.click("Edit");
    expect(
      view.container.querySelector<HTMLInputElement>('input[aria-label="Memory text"]')?.value,
    ).toBe("Synthetic memory body");
  });
});

describe("native sharing workflow", () => {
  async function start() {
    h = createNativeMemoryHarness();
    h.grant(["memory:read", "memory:write", "settings:write"]);
    await h.waitForAtom(h.memory.hubSettingsUpdate.permissionAtom(nativeEnv), Boolean);
    view = renderNative(
      h,
      <SettingsMemoryRouteScreen route={{ params: { environmentId: nativeEnv } }} />,
    );
    await view.render();
  }
  it.each(["focus", "active"] as const)(
    "refreshes hub, owner and sync on %s and keeps saved memories read-only after remote disable",
    async (event) => {
      await start();
      h.responses.set(WS_METHODS.memorySyncStatus, () => ({
        ...nativeSyncStatus,
        state: "disabled",
        memorySpaceId: null,
      }));
      h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
        settings: { mode: "disabled" },
        members: [],
        version: 2,
      }));
      const ownerCalls = h.calls.filter(
        (c) => c.method === WS_METHODS.memoryOwnerSourceReadPolicyGet,
      ).length;
      await act(async () => h[event]());
      expect(
        h.calls.filter((c) => c.method === WS_METHODS.memoryOwnerSourceReadPolicyGet),
      ).toHaveLength(ownerCalls + 1);
      expect(view.container.textContent).toContain("Memory off");
      expect(view.container.textContent).toContain("Synthetic memory body");
      await view.click("Remember something");
      expect(view.container.querySelector('input[aria-label="Memory text"]')).toBeNull();
    },
  );
  it("reloads the roster on active and leaves recovery CTA intact on focus", async () => {
    await start();
    h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
      settings: { mode: "hub", memorySpaceId: nativeSpace },
      members: [{ environmentId: nativeDevice, status: "pending_ack" }],
      version: 2,
    }));
    await act(async () => h.active());
    expect(view.container.textContent).toContain("Waiting for the device to confirm");
    h.responses.set(WS_METHODS.memoryHubSettingsUpdate, () =>
      Effect.fail({ code: "revision_changed" }),
    );
    await view.click("Turn sharing off");
    await view.click("Stop sharing");
    const reads = h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsGet).length;
    await act(async () => h.focus());
    expect(view.container.textContent).toContain("Review latest settings");
    expect(h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsGet)).toHaveLength(reads);
  });
  it("ignores a late settings and sync read after a newer active refresh", async () => {
    await start();
    const oldHub = h.deferred<unknown>();
    const oldSync = h.deferred<unknown>();
    h.responses.set(WS_METHODS.memoryHubSettingsGet, () => oldHub.response);
    h.responses.set(WS_METHODS.memorySyncStatus, () => oldSync.response);
    await act(async () => h.active());
    h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
      settings: { mode: "disabled" },
      members: [],
      version: 9,
    }));
    h.responses.set(WS_METHODS.memorySyncStatus, () => ({
      ...nativeSyncStatus,
      state: "disabled",
      memorySpaceId: null,
    }));
    await act(async () => h.active());
    await act(async () => {
      await oldHub.succeed({
        settings: { mode: "hub", memorySpaceId: nativeSpace },
        members: [],
        version: 1,
      });
      await oldSync.succeed(nativeSyncStatus);
    });
    expect(view.container.textContent).toContain("Memory off");
    expect(view.container.textContent).not.toContain("This device is the hub");
    await view.click("Remember something");
    expect(view.container.querySelector('input[aria-label="Memory text"]')).toBeNull();
  });
  it("preserves an in-flight device request across active and focus events", async () => {
    await start();
    const provision = h.deferred<unknown>();
    h.responses.set(WS_METHODS.memoryHubSettingsUpdate, () => provision.response);
    await view.click("Add Test device");
    await view.type("Hub address", "https://hub.example.test");
    await view.click("Confirm");
    const reads = h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsGet).length;
    await act(async () => {
      h.active();
      h.focus();
    });
    expect(h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsGet)).toHaveLength(reads);
    expect(h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsUpdate)).toHaveLength(1);
    await act(async () => {
      await provision.fail(new Error("Synthetic response lost"));
    });
    expect(view.container.textContent).toContain("Retry");
    await act(async () => h.active());
    expect(h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsGet)).toHaveLength(reads);
    expect(view.container.textContent).toContain("Retry");
  });
  it("toggles quarantine without refreshing healthy lists and clears search", async () => {
    await start();
    expect(view.container.textContent).not.toContain("Refresh memories");
    await view.click("Include quarantined");
    expect(h.calls.findLast((c) => c.method === WS_METHODS.memoryList)?.input).toMatchObject({
      includeQuarantined: true,
    });
    await view.type("Search memory", "absent");
    await view.click("Search");
    await view.click("Clear");
    expect(view.container.textContent).toContain("Synthetic memory body");
  });
  it("automatically displays ready memories without raw IDs or manual setup fields", async () => {
    await start();
    expect(view.container.textContent).toContain("This device is the hub");
    expect(view.container.textContent).toContain("Synthetic memory body");
    expect(view.container.textContent).not.toContain(nativeEnv);
    expect(view.container.textContent).not.toContain(nativeSpace);
    for (const label of [
      "Memory space ID",
      "Hub environment ID",
      "Hub endpoint",
      "Installed credential name",
    ])
      expect(view.container.querySelector(`input[aria-label="${label}"]`)).toBeNull();
  });
  it("confirms sharing off, keeps saved records read-only, and hides original conversation controls", async () => {
    await start();
    h.responses.set(WS_METHODS.memoryHubSettingsUpdate, () => ({
      view: { settings: { mode: "disabled" }, members: [], version: 2 },
      credential: null,
    }));
    h.responses.set(WS_METHODS.memorySyncStatus, () => ({
      ...nativeSyncStatus,
      state: "disabled",
      memorySpaceId: null,
    }));
    await view.click("Turn sharing off");
    expect(view.container.textContent).toContain("Stop sharing on this device?");
    expect(view.container.textContent).toContain("Saved memories stay.");
    expect(h.calls.some((c) => c.method === WS_METHODS.memoryHubSettingsUpdate)).toBe(false);
    await view.click("Stop sharing");
    expect(view.container.textContent).toContain("Memory off");
    expect(view.container.textContent).toContain(
      "Saved memories stay. Turn on memory to save new memories.",
    );
    expect(view.container.querySelector('section[aria-label="Original conversations"]')).toBeNull();
    await view.click("Remember something");
    expect(view.container.querySelector('input[aria-label="Memory text"]')).toBeNull();
    await view.click("Open memory: Synthetic memory body");
    await view.click("Edit");
    expect(view.container.querySelector('input[aria-label="Memory text"]')).toBeNull();
    expect(h.calls.some((c) => c.method === WS_METHODS.memoryUpsert)).toBe(false);
  });
  it("shows the first-use message with no space while off", async () => {
    h = createNativeMemoryHarness();
    h.responses.set(WS_METHODS.memorySyncStatus, () => ({
      ...nativeSyncStatus,
      state: "disabled",
      memorySpaceId: null,
    }));
    h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
      settings: { mode: "disabled" },
      members: [],
      version: 1,
    }));
    await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
    view = renderNative(
      h,
      <SettingsMemoryRouteScreen route={{ params: { environmentId: nativeEnv } }} />,
    );
    await view.render();
    expect(view.container.textContent).toContain("Turn on memory to see and save memories.");
    expect(h.calls.some((c) => c.method === WS_METHODS.memoryList)).toBe(false);
  });
  it.each(["details", "edit"] as const)(
    "closes %s after same-space forget and allows a new explicit open",
    async (mode) => {
      await start();
      await view.click("Open memory: Synthetic memory body");
      if (mode === "edit") {
        await view.click("Edit");
        await view.type("Memory text", "Discard this draft");
      }
      await act(async () => {
        await h.signal({
          kind: "forget",
          memorySpaceId: nativeSpace,
          memoryId: "00000000-0000-4000-8000-000000000099" as never,
          projectionWatermark: 2,
        });
      });
      expect(view.container.querySelector('input[aria-label="Memory text"]')).toBeNull();
      expect(view.container.textContent).not.toContain("Close details");
      expect(view.container.textContent).not.toContain("Discard this draft");
      await view.click("Open memory: Synthetic memory body");
      expect(view.container.textContent).toContain("Close details");
      expect(view.container.textContent).toContain("Synthetic memory body");
    },
  );
  it("adds a device in order and retries the same install without exposing credential or repeating provision", async () => {
    await start();
    const errors = vi.spyOn(console, "error");
    const warnings = vi.spyOn(console, "warn");
    let failed = false;
    const credential = "synthetic-ephemeral-key";
    h.responses.set(WS_METHODS.memoryHubSettingsUpdate, (input) => {
      const action = (input as { action: string }).action;
      if (action === "installCredential" && !failed) {
        failed = true;
        throw new Error("synthetic install lost");
      }
      return {
        view: {
          settings: { mode: "hub", memorySpaceId: nativeSpace },
          members: [],
          version: action === "provisionMember" ? 2 : 3,
        },
        credential:
          action === "provisionMember" ? { memorySpaceId: nativeSpace, credential } : null,
      };
    });
    await view.click("Add Test device");
    await view.type("Hub address", "https://hub.example.test");
    await view.click("Confirm");
    expect(view.container.textContent).toContain("Device setup did not finish");
    expect(view.container.textContent).not.toContain(credential);
    expect(view.container.innerHTML).not.toContain(credential);
    await view.click("Retry");
    const calls = h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsUpdate);
    expect(calls.map((c) => (c.input as { action: string }).action)).toEqual([
      "provisionMember",
      "installCredential",
      "installCredential",
      "acknowledgeCredential",
    ]);
    expect(calls[1]!.input).toEqual(calls[2]!.input);
    expect(JSON.stringify([errors.mock.calls, warnings.mock.calls])).not.toContain(credential);
    expect(calls.map((c) => c.environmentId)).toEqual([
      nativeEnv,
      nativeDevice,
      nativeDevice,
      nativeEnv,
    ]);
    expect(view.container.textContent).not.toContain(credential);
  });
  it("refuses loopback hub addresses before provisioning", async () => {
    await start();
    await view.click("Add Test device");
    await view.type("Hub address", "http://127.0.0.1:3773");
    await view.click("Confirm");
    expect(view.container.textContent).toContain("Localhost points to the device itself");
    expect(h.calls.some((c) => c.method === WS_METHODS.memoryHubSettingsUpdate)).toBe(false);
  });
  it.each(["capacity_exceeded", "revision_changed"] as const)(
    "requires latest review after %s and creates a fresh attempt",
    async (code) => {
      await start();
      const failure = { code, capacity: { dimension: "members" } };
      h.responses.set(WS_METHODS.memoryHubSettingsUpdate, () => Effect.fail(failure));
      await view.click("Add Test device");
      await view.type("Hub address", "https://hub.example.test");
      await view.click("Confirm");
      expect(view.container.textContent).toContain(
        code === "capacity_exceeded"
          ? "Device limit reached. Remove a device to add another."
          : "Device settings changed during setup",
      );
      expect(view.container.textContent).toContain("Review latest settings");
      const first = h.calls.find((c) => c.method === WS_METHODS.memoryHubSettingsUpdate)!.input;
      h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
        settings: { mode: "hub", memorySpaceId: nativeSpace },
        members: [],
        version: 9,
      }));
      await view.click("Review latest settings");
      await view.click("Add Test device");
      await view.click("Confirm");
      const second = h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsUpdate)[1]!
        .input;
      expect(second).toMatchObject({ expectedVersion: 9 });
      expect((second as { requestId: string }).requestId).not.toBe(
        (first as { requestId: string }).requestId,
      );
    },
  );
  it("shows unknown pending members, explains disconnected key replacement, and revokes on confirmation", async () => {
    h = createNativeMemoryHarness();
    h.grant(["memory:read", "memory:write", "settings:write"]);
    h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
      settings: { mode: "hub", memorySpaceId: nativeSpace },
      version: 7,
      members: [{ environmentId: "unknown-member", status: "pending_ack" }],
    }));
    await h.waitForAtom(h.memory.hubSettingsUpdate.permissionAtom(nativeEnv), Boolean);
    view = renderNative(
      h,
      <SettingsMemoryRouteScreen route={{ params: { environmentId: nativeEnv } }} />,
    );
    await view.render();
    expect(view.container.textContent).toContain("Unknown device");
    expect(view.container.textContent).toContain("Waiting for the device to confirm");
    expect(view.container.textContent).toContain(
      "Connect this device in Settings → Connections to replace its key.",
    );
    expect(view.container.textContent).not.toContain("unknown-member");
    h.responses.set(WS_METHODS.memoryHubSettingsUpdate, () => ({
      view: { settings: { mode: "hub", memorySpaceId: nativeSpace }, members: [], version: 8 },
      credential: null,
    }));
    await view.click("Remove Unknown device");
    expect(h.calls.some((c) => c.method === WS_METHODS.memoryHubSettingsUpdate)).toBe(false);
    await view.click("Remove device");
    expect(
      h.calls.find((c) => c.method === WS_METHODS.memoryHubSettingsUpdate)?.input,
    ).toMatchObject({
      action: "revokeMember",
      environmentId: "unknown-member",
      expectedVersion: 7,
    });
  });
  it("disposes a credential attempt on connection replacement before install", async () => {
    await start();
    const provision = h.deferred<unknown>();
    h.responses.set(WS_METHODS.memoryHubSettingsUpdate, () => provision.response);
    await view.click("Add Test device");
    await view.type("Hub address", "https://hub.example.test");
    await view.click("Confirm");
    await act(async () => h.registry.set(h.prepared(nativeDevice), Option.some({} as never)));
    await act(async () => {
      await provision.succeed({
        view: { settings: { mode: "hub", memorySpaceId: nativeSpace }, members: [], version: 2 },
        credential: { memorySpaceId: nativeSpace, credential: "synthetic-ephemeral-key" },
      });
    });
    expect(view.container.textContent).toContain("Device connection changed");
    expect(h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsUpdate)).toHaveLength(1);
    expect(view.container.textContent).not.toContain("synthetic-ephemeral-key");
  });
  it("routes environment settings entries to the same explicit Memory settings destination", async () => {
    h = createNativeMemoryHarness();
    view = renderNative(h, <MemoryEnvironmentEntry environmentId={nativeEnv} />);
    await view.render();
    await view.click("Memory · Test hub");
    expect(h.navigations).toMatchObject([
      [
        "SettingsSheet",
        {
          screen: "SettingsContent",
          params: { screen: "SettingsMemory", params: { environmentId: nativeEnv } },
        },
      ],
    ]);
    expect(h.calls).toHaveLength(0);
  });
});

it("uses the bound project for native list, search and creation, and resets on returning to user", async () => {
  const scope = {
    kind: "project",
    projectKey: { kind: "explicit", sharedProjectId: "synthetic-shared" },
  };
  await mount(undefined, (harness) => {
    harness.projects.push({
      id: "synthetic-project",
      title: "Synthetic project",
      environmentId: nativeEnv,
      repositoryIdentity: null,
    });
    harness.responses.set(WS_METHODS.memoryProjectBindingGet, () => ({
      memorySpaceId: nativeSpace,
      project: { environmentId: nativeEnv, projectId: "synthetic-project" },
      projectKey: scope.projectKey,
      repositoryKey: null,
      version: 1,
    }));
    harness.responses.set(WS_METHODS.memoryUpsert, (input) => {
      const request = input as MemoryUpsertInput;
      return {
        operationId: request.operationId,
        memoryId: request.memoryId,
        revisionId: "00000000-0000-4000-8000-000000000009",
        outcome: "accepted",
        pendingSync: false,
      };
    });
  });
  await view.click("Memory scope");
  await view.click("Synthetic project");
  expect(h.calls.findLast((call) => call.method === WS_METHODS.memoryList)).toMatchObject({
    input: { scope },
  });
  await view.type("Search memory", "absent");
  await view.click("Search");
  expect(h.calls.findLast((call) => call.method === WS_METHODS.memorySearch)).toMatchObject({
    input: { scope, mode: "fts" },
  });
  await view.click("Remember something");
  expect(view.container.textContent).toContain("Save to: Project");
  await view.type("Memory text", "Synthetic project memory");
  await view.click("Save memory");
  expect(h.calls.findLast((call) => call.method === WS_METHODS.memoryUpsert)).toMatchObject({
    input: { scope, payload: { text: "Synthetic project memory" } },
  });
  await view.click("Memory scope");
  await view.click("User");
  expect(view.container.textContent).toContain("Memory scope: User");
  expect(view.container.querySelector('[aria-label="Memory text"]')).toBeNull();
});

it("bounds native previews and explains incomplete indexed search results", async () => {
  await mount(undefined, (harness) => {
    const item = decodeItem({
      ...nativeItem,
      payload: {
        ...(nativeItem.status === "active" ? nativeItem.payload : {}),
        text: "x".repeat(120) + "hidden preview tail",
      },
    });
    harness.responses.set(WS_METHODS.memoryList, () => ({
      items: [item],
      nextCursor: null,
      projectionWatermark: 1,
    }));
    harness.responses.set(WS_METHODS.memorySearch, () => ({
      items: [],
      nextCursor: null,
      projectionWatermark: 1,
      indexCoverage: {
        status: "partial",
        eligibleItems: 2,
        indexedItems: 1,
        unindexedItems: 1,
        projectionWatermark: 1,
      },
    }));
  });
  expect(view.container.textContent).toContain("x".repeat(120));
  expect(view.container.textContent).not.toContain("hidden preview tail");
  await view.type("Search memory", "pending");
  await view.click("Search");
  expect(view.container.textContent).toContain(
    "Search index is preparing. Results may be incomplete.",
  );
  expect(view.container.textContent).not.toContain("No memories yet");
});

it("keeps dozens of native projects behind one menu row", async () => {
  await mount(undefined, (harness) => {
    harness.projects.push(
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `project-${index}`,
        title: `Project ${index}`,
        environmentId: nativeEnv,
        repositoryIdentity: null,
      })),
    );
    harness.responses.set(WS_METHODS.memoryProjectBindingGet, () => ({
      memorySpaceId: nativeSpace,
      project: { environmentId: nativeEnv, projectId: "project-59" },
      projectKey: { kind: "explicit", sharedProjectId: "last-shared" },
      repositoryKey: null,
      version: 1,
    }));
  });
  expect(view.container.textContent).not.toContain("Project 59");
  expect(view.container.querySelectorAll('button[aria-label="Memory scope"]')).toHaveLength(1);
  await view.click("Memory scope");
  await view.click("Project 59");
  expect(view.container.textContent).toContain("Memory scope: Project 59");
  expect(view.container.textContent).not.toContain("Project 58");
  expect(h.calls.findLast((call) => call.method === WS_METHODS.memoryList)).toMatchObject({
    input: {
      scope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "last-shared" } },
    },
  });
});
