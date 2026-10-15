// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  WS_METHODS,
  type MemoryOwnerSourceReadPolicyUpdateInput,
  type MemoryUpsertInput,
} from "@goat/contracts";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  nativeSpace,
  nativeId,
  nativeOwnerPolicy,
  nativeSyncStatus,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
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
