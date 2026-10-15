// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  WS_METHODS,
  MemoryItem,
  MemorySourcePage,
  type MemoryOwnerSourceReadPolicyUpdateInput,
  type MemoryUpsertInput,
  MemoryHistoryPage,
  MemoryRevertResult,
  type MemoryRevertResolutionInput,
} from "@goat/contracts";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  nativeSpace,
  nativeId,
  nativeOwnerPolicy,
  nativeSyncStatus,
  nativeItem,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import type { PreparedConnection } from "@goat/client-runtime/connection";
import * as Schema from "effect/Schema";
import { SettingsMemoryRouteScreen } from "./SettingsMemoryRouteScreen";

let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});
async function mount(scopes?: Parameters<NativeMemoryHarness["grant"]>[0]) {
  h = createNativeMemoryHarness();
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
    await view.click("Clear search and filters");
    expect(view.container.textContent).toContain("Synthetic memory body");
  });
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
    await view.click(`Open memory ${nativeId}`);
    h.responses.set(WS_METHODS.memoryForget, () => ({
      memoryId: nativeId,
      outcome: "deleted",
      pendingSync: true,
    }));
    await view.click("Forget memory");
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
    expect(view.container.textContent).toContain("Expansion: unknown");
  });
  it("retries the original access value after the server applies it but loses its response", async () => {
    await mount(["memory:read", "memory:write", "settings:write"]);
    await h.waitForAtom(h.updateSettings.permissionAtom(nativeEnv), Boolean);
    h.responses.set(WS_METHODS.serverUpdateSettings, () => {
      const current = h.registry.get(h.configs(nativeEnv))!;
      h.registry.set(h.configs(nativeEnv), {
        ...current,
        settings: { ...current.settings, enableAgentMemoryAccess: false },
      });
      throw new Error("Synthetic settings response lost");
    });
    await view.click("Disable agent memory access");
    expect(view.container.textContent).toContain("Enable agent memory access");
    h.responses.set(WS_METHODS.serverUpdateSettings, () => ({}));
    await view.click("Retry administrative request");
    const calls = h.calls.filter((call) => call.method === WS_METHODS.serverUpdateSettings);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.input)).toEqual([
      { patch: { enableAgentMemoryAccess: false } },
      { patch: { enableAgentMemoryAccess: false } },
    ]);
  });
  it("closes confirmation on grant loss and refuses an old callback after access is restored", async () => {
    await mount();
    await view.click(`Open memory ${nativeId}`);
    await view.click("Forget memory");
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    const oldConfirm = h.takeConfirmation()!;
    await act(async () => h.revoke());
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => h.grant(["memory:read", "memory:write", "orchestration:read"]));
    await view.click(`Open memory ${nativeId}`);
    expect(view.container.textContent).toContain("Synthetic memory body");
    await act(async () => oldConfirm());
    expect(h.calls.filter((call) => call.method === WS_METHODS.memoryForget)).toHaveLength(0);
  });
  it("retries a lost forget receipt with the same intent while the forget signal keeps bodies hidden", async () => {
    await mount();
    await view.click(`Open memory ${nativeId}`);
    h.responses.set(WS_METHODS.memoryForget, () => {
      throw new Error("Synthetic forget response lost");
    });
    await view.click("Forget memory");
    await act(async () => h.confirm());
    expect(view.container.textContent).toContain("Retry uses the same request");
    await act(async () => {
      await h.signal({
        kind: "forget",
        memorySpaceId: nativeSpace,
        memoryId: nativeId,
        projectionWatermark: 2,
      });
    });
    expect(view.container.textContent).not.toContain("Synthetic memory body");
    h.responses.set(WS_METHODS.memoryForget, () => ({
      memoryId: nativeId,
      outcome: "deleted",
      pendingSync: true,
    }));
    await view.click("Retry forget request");
    const calls = h.calls.filter((call) => call.method === WS_METHODS.memoryForget);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.input).toEqual(calls[1]!.input);
    expect(calls[1]).toMatchObject({
      environmentId: nativeEnv,
      input: {
        memorySpaceId: nativeSpace,
        memoryId: nativeId,
        expectedHeads: ["00000000-0000-4000-8000-000000000004"],
      },
    });
    expect(view.container.textContent).not.toContain("Synthetic memory body");
  });
  it("refuses a body-free forget retry before rendering read-only grant loss", async () => {
    await mount();
    await view.click(`Open memory ${nativeId}`);
    h.responses.set(WS_METHODS.memoryForget, () => {
      throw new Error("Synthetic forget response lost");
    });
    await view.click("Forget memory");
    await act(async () => h.confirm());
    await act(async () => {
      await h.signal({
        kind: "forget",
        memorySpaceId: nativeSpace,
        memoryId: nativeId,
        projectionWatermark: 2,
      });
    });
    expect(view.container.textContent).not.toContain("Synthetic memory body");
    expect(view.container.textContent).toContain("Retry uses the same request");
    const oldRetry = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry forget request",
    )!;
    const connection = h.registry.get(h.prepared(nativeEnv));
    await act(async () => {
      h.grant(["memory:write", "orchestration:read"]);
      expect(h.registry.get(h.memory.forget.permissionAtom(nativeEnv))).toBe(true);
      expect(h.registry.get(h.memory.syncStatus.permissionAtom(nativeEnv))).toBe(false);
      expect(h.registry.get(h.prepared(nativeEnv))).toBe(connection);
      // Invoke the existing rendered control synchronously, before React replaces its lifetime.
      expect(view.container.contains(oldRetry)).toBe(true);
      oldRetry.click();
    });
    expect(h.calls.filter((call) => call.method === WS_METHODS.memoryForget)).toHaveLength(1);
    expect(view.container.textContent).not.toContain("Retry uses the same request");
    expect(view.container.textContent).not.toContain("Retry forget request");
    await act(async () => h.grant(["memory:read", "memory:write", "orchestration:read"]));
    expect(view.container.textContent).not.toContain("Retry forget request");
    await act(async () => oldRetry.click());
    expect(h.calls.filter((call) => call.method === WS_METHODS.memoryForget)).toHaveLength(1);
  });
  it("owns the sharing confirmation for the current connection lifetime", async () => {
    await mount(["memory:read", "memory:write", "settings:write"]);
    h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
      settings: { mode: "hub", memorySpaceId: nativeSpace },
      version: 1,
    }));
    h.responses.set(WS_METHODS.memoryOwnerSourceReadPolicyGet, () => nativeOwnerPolicy);
    await view.click("Load sharing and original access settings");
    await view.click("Turn off memory sharing");
    const oldConfirm = h.takeConfirmation()!;
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () =>
      h.registry.set(h.prepared(nativeEnv), Option.some({} as PreparedConnection)),
    );
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => oldConfirm());
    expect(
      h.calls.filter((call) => call.method === WS_METHODS.memoryHubSettingsUpdate),
    ).toHaveLength(0);
  });
  it("selects a retained original despite a local deadline warning and settles with the hub result", async () => {
    await mount();
    h.responses.set(WS_METHODS.memoryHistory, revertHistory);
    h.responses.set(WS_METHODS.memoryRevertResolution, () => {
      throw new Error("Synthetic revert response lost");
    });
    await view.click(`Open memory ${nativeId}`);
    expect(view.container.textContent).toContain("The hub needs to confirm the revert window");
    await view.click(`Restore original ${originalId}`);
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
    await view.click(`Open memory ${nativeId}`);
    await view.click(`Restore original ${originalId}`);
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
    await view.click(`Open memory ${nativeId}`);
    await view.click(`Restore original ${originalId}`);
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
    await view.click(`Open memory ${nativeId}`);
    await view.click(`Restore original ${originalId}`);
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
  it("allows explicit-space creation with write-only access without subscribing to bodies", async () => {
    h = createNativeMemoryHarness();
    h.grant(["memory:write"]);
    await h.waitForAtom(h.memory.upsert.permissionAtom(nativeEnv), Boolean);
    view = renderNative(
      h,
      <SettingsMemoryRouteScreen
        route={{ params: { environmentId: nativeEnv, memorySpaceId: nativeSpace } }}
      />,
    );
    await view.render();
    await view.click("Remember in selected space");
    expect(view.container.querySelector('input[aria-label="Memory text"]')).not.toBeNull();
    expect(h.calls).toEqual([]);
  });
  it("changes an owner requester without cancelling an unrelated pending enrollment", async () => {
    await mount(["memory:read", "memory:write", "settings:write"]);
    const policy = nativeOwnerPolicy;
    h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
      settings: { mode: "hub", memorySpaceId: nativeSpace },
      version: 1,
    }));
    h.responses.set(WS_METHODS.memoryOwnerSourceReadPolicyGet, () => policy);
    h.responses.set(WS_METHODS.memoryOwnerSourceReadPolicyUpdate, (input) => {
      const adding = (
        input as MemoryOwnerSourceReadPolicyUpdateInput
      ).allowedRequesterEnvironmentIds.includes("active-requester" as never);
      return {
        ...policy,
        version: adding ? 5 : 4,
        policy: {
          ...policy.policy,
          ownerPolicyEpoch: adding ? 5 : 4,
          allowedRequesterEnvironmentIds: [],
          removals: [
            ...policy.policy.removals,
            {
              memorySpaceId: nativeSpace,
              ownerEnvironmentId: nativeEnv,
              requesterEnvironmentId: "active-requester",
              removalEpoch: 4,
              state: "pending",
            },
          ],
          enrollments: [
            ...policy.policy.enrollments.filter((entry) => entry.state === "pending"),
            ...(adding
              ? [
                  {
                    memorySpaceId: nativeSpace,
                    ownerEnvironmentId: nativeEnv,
                    requesterEnvironmentId: "active-requester",
                    removalEpoch: 4,
                    ownerPolicyEpoch: 5,
                    state: "pending",
                  },
                ]
              : []),
          ],
        },
      };
    });
    await view.click("Load sharing and original access settings");
    await view.click("Remove active-requester");
    expect(
      h.calls.find((call) => call.method === WS_METHODS.memoryOwnerSourceReadPolicyUpdate),
    ).toMatchObject({
      environmentId: nativeEnv,
      input: { expectedVersion: 3, allowedRequesterEnvironmentIds: ["pending-requester"] },
    });
    expect(view.container.textContent).toContain("pending-requester");
    await view.click("Allow active-requester");
    const updates = h.calls.filter(
      (call) => call.method === WS_METHODS.memoryOwnerSourceReadPolicyUpdate,
    );
    expect(updates).toHaveLength(2);
    expect(updates[1]!.input).toMatchObject({
      expectedVersion: 4,
      allowedRequesterEnvironmentIds: ["pending-requester", "active-requester"],
    });
    expect(view.container.textContent).toContain("Remove active-requester");
  });
  it("keeps the newest sharing status and diagnostics when refresh replies arrive in reverse order", async () => {
    await mount();
    const older = h.deferred<typeof nativeSyncStatus>();
    const newer = h.deferred<typeof nativeSyncStatus>();
    let count = 0;
    h.responses.set(WS_METHODS.memorySyncStatus, () => (count++ === 0 ? older : newer).response);
    await view.click("Refresh sharing status");
    await view.click("Refresh sharing status");
    await act(async () => {
      await newer.succeed({ ...nativeSyncStatus, state: "disabled", pendingSync: 7 });
    });
    expect(view.container.textContent).toContain("Memory sharing off");
    await view.click("Show sharing details");
    expect(view.container.textContent).toContain("Pending sync: 7");
    await act(async () => {
      await older.succeed(nativeSyncStatus);
    });
    expect(view.container.textContent).toContain("Memory sharing off");
    expect(view.container.textContent).toContain("Pending sync: 7");
    expect(view.container.textContent).not.toContain("Hub connected");
  });
  it("ignores an older refresh failure after a newer success", async () => {
    await mount();
    const older = h.deferred<typeof nativeSyncStatus>();
    let count = 0;
    h.responses.set(WS_METHODS.memorySyncStatus, () =>
      count++ === 0 ? older.response : nativeSyncStatus,
    );
    await view.click("Refresh sharing status");
    await view.click("Refresh sharing status");
    await act(async () => {
      await older.fail(new Error("Synthetic obsolete refresh"));
    });
    expect(view.container.textContent).toContain("Hub connected");
    expect(view.container.textContent).not.toContain("Synthetic obsolete refresh");
  });
  it("refreshes sharing after configuration and administration reload while preserving the selected space", async () => {
    await mount(["memory:read", "memory:write", "settings:write"]);
    h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
      settings: { mode: "hub", memorySpaceId: nativeSpace },
      version: 1,
    }));
    h.responses.set(WS_METHODS.memoryOwnerSourceReadPolicyGet, () => nativeOwnerPolicy);
    await view.click("Load sharing and original access settings");
    const configured = h.deferred<typeof nativeSyncStatus>();
    h.responses.set(WS_METHODS.memorySyncStatus, () => configured.response);
    h.responses.set(WS_METHODS.memoryHubSettingsUpdate, () => ({
      view: { settings: { mode: "disabled" }, version: 2 },
    }));
    await view.click("Turn off memory sharing");
    await act(async () => h.confirm());
    expect(view.container.textContent).toContain("Checking memory sharing");
    expect(view.container.textContent).not.toContain("Hub connected");
    await act(async () => {
      await configured.succeed({
        ...nativeSyncStatus,
        state: "disabled",
        memorySpaceId: null,
      });
    });
    expect(view.container.textContent).toContain("Memory sharing off");
    expect(view.container.textContent).toContain("Current bound space: None");
    const rebound = h.deferred<typeof nativeSyncStatus>();
    h.responses.set(WS_METHODS.memorySyncStatus, () => rebound.response);
    await view.click("Load sharing and original access settings");
    expect(view.container.textContent).toContain("Checking memory sharing");
    expect(view.container.textContent).not.toContain("Memory sharing off");
    const nextSpace = nativeSpace.replace(/1$/, "9") as typeof nativeSpace;
    await act(async () => {
      await rebound.succeed({ ...nativeSyncStatus, memorySpaceId: nextSpace });
    });
    expect(view.container.textContent).toContain("Hub connected");
    expect(view.container.textContent).toContain(`Current bound space: ${nextSpace}`);
    expect(view.container.textContent).toContain(`Space: ${nativeSpace}`);
    await view.click("Remember something");
    await view.type("Memory text", "Synthetic pinned destination");
    h.responses.set(WS_METHODS.memoryUpsert, () => ({ outcome: "accepted", pendingSync: false }));
    await view.click("Save memory");
    expect(h.calls.find((call) => call.method === WS_METHODS.memoryUpsert)?.input).toMatchObject({
      memorySpaceId: nativeSpace,
    });
    expect(h.calls.filter((call) => call.method === WS_METHODS.memorySyncStatus)).toHaveLength(4);
    for (const call of h.calls.filter((call) => call.method === WS_METHODS.memoryList))
      expect(call.input).toMatchObject({ memorySpaceId: nativeSpace });
  });
  it.each(["disabled", "rebound"] as const)(
    "refreshes sharing after hub reload even when owner lookup fails (%s)",
    async (mode) => {
      await mount(["memory:read", "memory:write", "settings:write"]);
      await view.click("Show sharing details");
      expect(view.container.textContent).toContain("Hub connected");
      expect(view.container.textContent).toContain("Pending sync: 0");
      const nextSpace = nativeSpace.replace(/1$/, "9") as typeof nativeSpace;
      h.responses.set(WS_METHODS.memoryHubSettingsGet, () => ({
        settings:
          mode === "disabled" ? { mode: "disabled" } : { mode: "hub", memorySpaceId: nextSpace },
        version: 2,
      }));
      h.responses.set(WS_METHODS.memoryOwnerSourceReadPolicyGet, () => {
        throw new Error("Synthetic owner lookup failed");
      });
      const refresh = h.deferred<typeof nativeSyncStatus>();
      h.responses.set(WS_METHODS.memorySyncStatus, () => refresh.response);
      await view.click("Load sharing and original access settings");
      expect(h.calls.filter((call) => call.method === WS_METHODS.memorySyncStatus)).toHaveLength(2);
      expect(view.container.textContent).toContain("Checking memory sharing");
      expect(view.container.textContent).not.toContain("Hub connected");
      expect(view.container.textContent).not.toContain("Pending sync: 0");
      await act(async () => {
        await refresh.succeed({
          ...nativeSyncStatus,
          state: mode === "disabled" ? "disabled" : "online",
          memorySpaceId: mode === "disabled" ? null : nextSpace,
        });
      });
      expect(view.container.textContent).toContain("Synthetic owner lookup failed");
      expect(view.container.textContent).toContain("Retry administrative request");
      expect(view.container.textContent).toContain(
        mode === "disabled" ? "Memory sharing off" : "Hub connected",
      );
      expect(view.container.textContent).toContain(
        `Current bound space: ${mode === "disabled" ? "None" : nextSpace}`,
      );
      expect(view.container.textContent).toContain(`Space: ${nativeSpace}`);
      h.responses.set(WS_METHODS.memoryOwnerSourceReadPolicyGet, () => nativeOwnerPolicy);
      h.responses.set(WS_METHODS.memorySyncStatus, () => ({
        ...nativeSyncStatus,
        state: mode === "disabled" ? "disabled" : "online",
        memorySpaceId: mode === "disabled" ? null : nextSpace,
      }));
      await view.click("Retry administrative request");
      expect(view.container.textContent).not.toContain("Synthetic owner lookup failed");
      expect(
        h.calls.filter((call) => call.method === WS_METHODS.memoryOwnerSourceReadPolicyGet),
      ).toHaveLength(2);
      await view.click("Remember something");
      await view.type("Memory text", "Synthetic pinned destination after owner failure");
      h.responses.set(WS_METHODS.memoryUpsert, () => ({ outcome: "accepted", pendingSync: false }));
      await view.click("Save memory");
      expect(h.calls.find((call) => call.method === WS_METHODS.memoryUpsert)).toMatchObject({
        environmentId: nativeEnv,
        input: { memorySpaceId: nativeSpace },
      });
      expect(h.calls.filter((call) => call.method === WS_METHODS.memorySyncStatus)).toHaveLength(3);
      for (const call of h.calls.filter((call) => call.method === WS_METHODS.memoryList))
        expect(call.input).toMatchObject({ memorySpaceId: nativeSpace });
    },
  );
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
    await view.click(`Open memory ${nativeId}`);
    await view.click(`Read original on ${nativeEnv}`);
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
    await view.click(`Read original on ${nativeEnv}`);
    expect(view.container.querySelector('section[aria-label="Original"]')).not.toBeNull();
  });
  it("requires a new edit click after read access recovers", async () => {
    await mount();
    await view.click(`Open memory ${nativeId}`);
    await view.click("Edit memory");
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
    await view.click("Edit memory");
    expect(
      view.container.querySelector<HTMLInputElement>('input[aria-label="Memory text"]')?.value,
    ).toBe("Synthetic memory body");
  });
  it("pins the first selected space across later environment binding changes", async () => {
    h = createNativeMemoryHarness();
    await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
    view = renderNative(
      h,
      <SettingsMemoryRouteScreen route={{ params: { environmentId: nativeEnv } }} />,
    );
    await view.render();
    expect(view.container.textContent).toContain("Synthetic memory body");
    h.responses.set(WS_METHODS.memorySyncStatus, () => ({
      ...nativeSyncStatus,
      memorySpaceId: "00000000-0000-4000-8000-000000000003",
    }));
    await view.click("Refresh sharing status");
    expect(view.container.textContent).toContain("Its destination has been preserved");
    const lists = h.calls.filter((call) => call.method === WS_METHODS.memoryList);
    expect(lists.length).toBeGreaterThan(0);
    for (const call of lists) expect(call.input).toMatchObject({ memorySpaceId: nativeSpace });
  });
});
