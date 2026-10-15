// @vitest-environment jsdom
import { act, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MemoryItem,
  MemoryRevision,
  MemoryResolution,
  MemoryResolutionPayload,
  type MemoryHistoryPage,
  MemoryRevertResult,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
const state = vi.hoisted(() => ({
  allowed: true,
  write: true,
  version: 0,
  listeners: new Set<() => void>(),
  queries: new Map<string, unknown>(),
  refresh: vi.fn(),
  calls: vi.fn(),
  environment: null as unknown,
  result: null as unknown,
  navigate: vi.fn(),
  responses: new Map<string, unknown>(),
  executors: new Map<string, (input: unknown) => Promise<unknown>>(),
  connection: {} as object | null,
}));
function useFixtureVersion() {
  useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    () => state.version,
  );
}
function notifyFixture() {
  state.version += 1;
  for (const listener of state.listeners) listener();
}
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: { label: string }) => {
    useFixtureVersion();
    return state.allowed && (!["forget", "upsert"].includes(atom.label) || state.write);
  },
}));
vi.mock("../../state/memory", async () => {
  const { Atom } = await import("effect/reactivity");
  const drafts = Atom.family((_key: string) => {
    const stored = Atom.make<{ text: string; memoryIds: readonly string[] } | null>(null);
    return Atom.writable(
      (get) => get(stored)?.text ?? null,
      (ctx, value: { text: string; memoryIds: readonly string[] } | null) => ctx.set(stored, value),
    );
  });
  return {
    memoryEnvironment: {
      ...Object.fromEntries(
        [
          "syncStatus",
          "upsert",
          "forget",
          "revertResolution",
          "hubSettingsGet",
          "hubSettingsUpdate",
          "ownerSourceReadPolicyGet",
          "ownerSourceReadPolicyUpdate",
        ].map((label) => [label, { label, permissionAtom: () => ({ label }) }]),
      ),
      ...Object.fromEntries(
        ["list", "search", "read", "history", "readSource"].map((label) => [
          label,
          () => ({ label }),
        ]),
      ),
      draftAtom: ({ draftId }: { draftId: string }) => drafts(draftId),
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: ({ label }: { label: string }) => {
    useFixtureVersion();
    return { data: state.queries.get(label) ?? Option.none(), error: null, refresh: state.refresh };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => {
    if (!state.executors.has(command.label))
      state.executors.set(command.label, async (input: unknown) => {
        state.calls(input);
        return state.responses.get(command.label) ?? state.result;
      });
    return state.executors.get(command.label);
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => state.environment,
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  usePreparedConnection: () => {
    useFixtureVersion();
    return Option.fromNullishOr(state.connection);
  },
  readPreparedConnection: () => state.connection,
  useEnvironmentScope: () => {
    useFixtureVersion();
    return state.allowed;
  },
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
import { RegistryContext } from "@effect/atom-react";
import {
  MemorySettings,
  MemoryForgetControl,
  MemoryAdministration,
  MemoryRevertControl,
} from "./MemorySettings";
import { validateMemorySettingsSearch } from "./MemorySettings.logic";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = Schema.decodeUnknownSync(MemoryItem)({
  memorySpaceId: id(1),
  memoryId: id(2),
  status: "blocked",
  scope: { kind: "user" },
  failureCode: "secret_detected",
  pendingSync: false,
  localAvailability: {
    exposure: "held",
    reasons: ["secret_detected"],
    deferred: [],
    cleanupPending: false,
  },
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-15T00:00:00.000Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.allowed = true;
  state.write = true;
  state.queries.clear();
  state.executors.clear();
  state.refresh.mockClear();
  state.calls.mockClear();
  state.environment = null;
  state.result = { _tag: "Failure" };
  state.responses.clear();
  state.connection = {};
});

const decodeRevision = Schema.decodeUnknownSync(MemoryRevision);
const decodeRevert = Schema.decodeUnknownSync(MemoryRevertResult);
const revision = (n: number) =>
  decodeRevision({
    memorySpaceId: id(1),
    memoryId: id(2),
    revisionId: id(n),
    operationId: id(10 + n),
    parents: [],
    scope: { kind: "user" },
    payloadRef: id(n),
    assertionKind: "fact",
    provenance: { environmentId: "remote-owner" },
    createdAtUtc: "2026-09-01T00:00:00.000Z",
  });
const payload = {
  text: "Synthetic original",
  evidence: [{ origin: "user" as const, messageIds: [] }],
  derivedFromMemoryRevisions: [],
};
const activeItem = Schema.decodeUnknownSync(MemoryItem)({
  memorySpaceId: item.memorySpaceId,
  memoryId: item.memoryId,
  scope: { kind: "user" },
  pendingSync: false,
  status: "active",
  revision: revision(5),
  payload,
  localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
});
const resolution = Schema.decodeUnknownSync(MemoryResolution)({
  resolutionId: id(6),
  memorySpaceId: id(1),
  memoryId: id(2),
  inputRevisionIds: [id(3), id(4)],
  inputPayloadRefs: [id(3), id(4)],
  judgmentRef: id(6),
  requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
  effectiveProvider: "codex",
  effectiveModel: "synthetic",
  resolvingEnvironmentId: "remote-owner",
  fencingToken: 1,
  resultRevisionId: id(5),
  appliedAtUtc: "2026-09-01T00:00:00.000Z",
  revertDeadlineUtc: "2026-10-01T00:00:00.000Z",
});
const entry = {
  resolution,
  payload: MemoryResolutionPayload.make({
    resolutionId: resolution.resolutionId,
    judgment: "Synthetic judgment",
  }),
};
const retained = {
  revisions: [
    { revision: revision(3), payload },
    { revision: revision(4), payload: null },
  ],
  revertResults: [],
  nextCursor: null,
} satisfies Pick<MemoryHistoryPage, "revisions" | "revertResults" | "nextCursor">;
const settled = vi.fn();
async function renderRevert(
  history:
    | typeof retained
    | Pick<MemoryHistoryPage, "revisions" | "revertResults" | "nextCursor"> = retained,
) {
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  vi.spyOn(registry, "get").mockImplementation(() => state.allowed as never);
  await act(async () => {
    notifyFixture();
    root.render(
      <RegistryContext value={registry}>
        <MemoryRevertControl
          environmentId={EnvironmentId.make("remote-owner")}
          item={activeItem}
          entry={entry}
          history={history}
          onSettled={settled}
        />
      </RegistryContext>,
    );
  });
}
async function chooseOriginal() {
  const original = container.querySelector<HTMLInputElement>('input[type="radio"]')!;
  await act(async () => original.click());
}
it("restores only the chosen retained original despite the local deadline, retries the same intent, and settles from the hub", async () => {
  settled.mockClear();
  await renderRevert();
  expect(container.textContent).toContain("The hub needs to confirm the revert window");
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(1);
  await click("Revert resolution");
  expect(state.calls).not.toHaveBeenCalled();
  await chooseOriginal();
  await click("Revert resolution");
  const first = state.calls.mock.calls[0]![0] as {
    environmentId: string;
    input: { operationId: string; restoredRevisionId: string; expectedHeads: string[] };
  };
  expect(first).toMatchObject({
    environmentId: "remote-owner",
    input: {
      memorySpaceId: id(1),
      memoryId: id(2),
      resolutionId: id(6),
      restoredRevisionId: id(3),
      expectedHeads: [id(5)],
    },
  });
  expect(container.textContent).toContain("Revert request failed");
  state.result = {
    _tag: "Success",
    value: {
      operationId: first.input.operationId,
      memoryId: id(2),
      resolutionId: id(6),
      revertDeadlineUtc: resolution.revertDeadlineUtc,
      status: "revert_expired",
    },
  };
  await click("Revert resolution");
  expect(state.calls.mock.calls[1]![0]).toEqual(first);
  expect(container.textContent).toContain("Revert window expired");
  expect(container.querySelector('[aria-label="Revert confirmation"]')).toBeNull();
  expect(settled).toHaveBeenCalledTimes(1);
});
it.each(["pending", "accepted", "revision_changed", "forgotten"] as const)(
  "presents authoritative %s settlement",
  async (status) => {
    await renderRevert();
    await chooseOriginal();
    state.result = {
      _tag: "Success",
      value: decodeRevert({
        operationId: id(9),
        memoryId: id(2),
        resolutionId: id(6),
        revertDeadlineUtc: resolution.revertDeadlineUtc,
        status,
        ...(status === "accepted"
          ? {
              localAvailability: activeItem.localAvailability,
              receipt: {
                operationId: id(9),
                memoryId: id(2),
                outcome: "accepted",
                revisionId: id(8),
                pendingSync: false,
              },
            }
          : {}),
      }),
    };
    await click("Revert resolution");
    const labels = {
      pending: "Waiting for revert approval",
      accepted: "Revert approved",
      revision_changed: "Memory changed; cannot revert",
      forgotten: "Forgotten memory cannot be reverted",
    };
    expect(container.querySelector('[role="status"]')?.textContent).toBe(labels[status]);
    expect(container.querySelector('[aria-label="Revert confirmation"]')).toBeNull();
  },
);
it("cancels without sending, revalidates missing originals, and closes on revoke or incomplete history", async () => {
  await renderRevert();
  await chooseOriginal();
  await click("Cancel");
  await click("Revert resolution");
  expect(state.calls).not.toHaveBeenCalled();
  await chooseOriginal();
  await renderRevert({ ...retained, revisions: [] });
  expect(container.querySelector('[aria-label="Revert confirmation"]')).toBeNull();
  await renderRevert({ ...retained, nextCursor: "more" });
  expect(container.textContent).toContain("Load the remaining history before reverting");
  await renderRevert();
  await chooseOriginal();
  state.allowed = false;
  await renderRevert();
  expect(container.querySelector('[aria-label="Revert confirmation"]')).toBeNull();
  expect(state.calls).not.toHaveBeenCalled();
});
it("rejects a disconnected destination at admission and discards a late result after rebinding", async () => {
  await renderRevert();
  await chooseOriginal();
  const connection = state.connection;
  state.connection = null;
  await click("Revert resolution");
  expect(state.calls).not.toHaveBeenCalled();
  state.connection = connection;
  let complete!: (result: unknown) => void;
  state.executors.set("revertResolution", (input) => {
    state.calls(input);
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  await renderRevert();
  settled.mockClear();
  await click("Revert resolution");
  state.connection = {};
  await act(async () =>
    complete({
      _tag: "Success",
      value: decodeRevert({
        operationId: id(9),
        memoryId: id(2),
        resolutionId: id(6),
        revertDeadlineUtc: resolution.revertDeadlineUtc,
        status: "pending",
      }),
    }),
  );
  expect(settled).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')).toBeNull();
  state.executors.delete("revertResolution");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function renderForget() {
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  vi.spyOn(registry, "get").mockImplementation(() => state.allowed as never);
  await act(async () => {
    notifyFixture();
    root.render(
      <RegistryContext value={registry}>
        <MemoryForgetControl environmentId={EnvironmentId.make("remote-owner")} item={item} />
      </RegistryContext>,
    );
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("requires confirmation, retains operation identity after failure, and displays settlement separately", async () => {
  await renderForget();
  await click("Forget memory");
  expect(state.calls).not.toHaveBeenCalled();
  await click("Confirm forget");
  expect(container.textContent).toContain("Forget request failed");
  const first = state.calls.mock.calls[0]![0] as {
    environmentId: string;
    input: { operationId: string };
  };
  state.result = {
    _tag: "Success",
    value: {
      operationId: first.input.operationId,
      outcome: "deleted",
      pendingSync: true,
      forgetExpansion: { status: "pending" },
    },
  };
  await click("Confirm forget");
  expect(state.calls.mock.calls[1]![0]).toEqual(first);
  expect(first.environmentId).toBe("remote-owner");
  expect(container.textContent).toContain("Expansion: pending");
  expect(container.textContent).toContain("Sharing pending: true");
  expect(container.textContent).not.toContain("Forget confirmation");
});
it("cancels without mutation and removes an open intent when permission is revoked", async () => {
  await renderForget();
  await click("Forget memory");
  await click("Cancel");
  expect(state.calls).not.toHaveBeenCalled();
  await click("Forget memory");
  state.allowed = false;
  await renderForget();
  expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
  state.allowed = true;
  await renderForget();
  expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
});
it("does not mount memory consumers for an unsupported explicit foreign deep link", async () => {
  await act(async () => {
    notifyFixture();
    root.render(
      <MemorySettings
        target={validateMemorySettingsSearch({
          environmentId: "foreign-owner",
          memorySpaceId: id(1),
          memoryId: id(2),
        })}
      />,
    );
  });
  expect(container.textContent).toContain("Update or reconnect");
  expect(container.textContent).toContain("foreign-owner");
  expect(state.calls).not.toHaveBeenCalled();
});

it("keeps pending reenrollment when removing another owner permission and renders the committed policy", async () => {
  const pair = {
    memorySpaceId: id(1),
    ownerEnvironmentId: "remote-owner",
    requesterEnvironmentId: "pending-device",
  };
  const view = {
    version: 3,
    revocationPropagation: "pending",
    policy: {
      ownerPolicyEpoch: 3,
      allowedRequesterEnvironmentIds: ["active-device"],
      enrollments: [
        { ...pair, ownerPolicyEpoch: 3, removalEpoch: 2, state: "pending" },
        { ...pair, requesterEnvironmentId: "active-device", ownerPolicyEpoch: 3, state: "active" },
      ],
      removals: [{ ...pair, removalEpoch: 2, state: "pending" }],
    },
  };
  state.responses.set("hubSettingsGet", {
    _tag: "Success",
    value: { version: 2, settings: { mode: "hub", memorySpaceId: id(1) } },
  });
  state.responses.set("ownerSourceReadPolicyGet", { _tag: "Success", value: view });
  state.responses.set("ownerSourceReadPolicyUpdate", {
    _tag: "Success",
    value: {
      ...view,
      version: 4,
      policy: {
        ...view.policy,
        allowedRequesterEnvironmentIds: [],
        enrollments: [view.policy.enrollments[0]],
      },
    },
  });
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  vi.spyOn(registry, "get").mockImplementation(() => state.allowed as never);
  await act(async () => {
    notifyFixture();
    root.render(
      <RegistryContext value={registry}>
        <MemoryAdministration environmentId={EnvironmentId.make("remote-owner")} />
      </RegistryContext>,
    );
  });
  expect(container.textContent).toContain("pending-device");
  expect(container.textContent).toContain("active-device");
  const remove = [...container.querySelectorAll("li")]
    .find((entry) => entry.textContent?.includes("active-device"))!
    .querySelector("button")!;
  await act(async () => remove.click());
  const request = state.calls.mock.calls.at(-1)![0] as {
    environmentId: string;
    input: { allowedRequesterEnvironmentIds: string[]; expectedVersion: number };
  };
  expect(request.input.allowedRequesterEnvironmentIds).toEqual(["pending-device"]);
  expect(request.input.expectedVersion).toBe(3);
  expect(request.environmentId).toBe("remote-owner");
  expect(container.textContent).not.toContain("active-device");
  expect(container.textContent).toContain("pending-device");
  const calls = state.calls.mock.calls.length;
  await click("Turn sharing off");
  await click("Cancel");
  expect(state.calls.mock.calls.length).toBe(calls);
  state.responses.set("hubSettingsUpdate", {
    _tag: "Success",
    value: { view: { version: 3, settings: { mode: "disabled" } }, credential: null },
  });
  await click("Turn sharing off");
  await click("Confirm sharing off");
  expect(container.textContent).toContain("Sharing: disabled");
  expect(container.textContent).toContain("Turn sharing on");
});

// A manually settled Deferred keeps response ordering deterministic without timers.
async function deferredResult() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const success = (value: unknown) => ({ _tag: "Success", value });
const hubView = (version: number, space = id(1)) => ({
  version,
  settings: { mode: "hub", memorySpaceId: space },
});
const ownerView = (version: number, requester: string) => ({
  version,
  revocationPropagation: "complete",
  policy: {
    ownerPolicyEpoch: version,
    allowedRequesterEnvironmentIds: [requester],
    enrollments: [],
    removals: [],
  },
});
async function supportedScreen(withDetails = true) {
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  const get = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation((atom) => {
    const label = (atom as unknown as { label?: string }).label;
    if (label)
      return (state.allowed && (!["forget", "upsert"].includes(label) || state.write)) as never;
    return get(atom);
  });
  state.environment = {
    serverConfig: { environment: { capabilities: { memory: { protocolVersion: 1 } } } },
  };
  state.queries.set("read", Option.some(activeItem));
  state.responses.set("hubSettingsGet", success(hubView(2)));
  state.responses.set("ownerSourceReadPolicyGet", success(ownerView(2, "device-a")));
  const target = validateMemorySettingsSearch({
    environmentId: "remote-owner",
    ...(withDetails ? { memorySpaceId: id(1), memoryId: id(2) } : {}),
  });
  const render = () =>
    act(async () => {
      notifyFixture();
      root.render(
        <RegistryContext value={registry}>
          <MemorySettings target={target} />
        </RegistryContext>,
      );
    });
  await render();
  return { render, registry };
}

it.each([false, true])(
  "clears an in-flight forget on write-only revoke and ignores its late result (after regrant: %s)",
  async (afterRegrant) => {
    const first = await deferredResult();
    state.executors.set("forget", (input) => {
      state.calls(input);
      return first.promise;
    });
    const { render } = await supportedScreen();
    await click("Forget memory");
    await click("Confirm forget");
    const oldRequest = state.calls.mock.calls.at(-1)![0];
    state.write = false;
    await render();
    expect(container.textContent).toContain("Synthetic original");
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    if (afterRegrant) {
      state.write = true;
      await render();
    }
    await act(async () => {
      await first.resolve({ _tag: "Failure" });
      await first.promise;
    });
    state.write = true;
    await render();
    expect(container.textContent).not.toContain("Forget request failed");
    await click("Forget memory");
    expect(
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Confirm forget")
        ?.disabled,
    ).toBe(false);
    await click("Cancel");
    await click("Forget memory");
    state.executors.set("forget", async (input) => {
      state.calls(input);
      return { _tag: "Failure" };
    });
    await render();
    await click("Confirm forget");
    expect(state.calls.mock.calls.at(-1)![0]).not.toEqual(oldRequest);
    expect(container.textContent).toContain("Forget request failed");
  },
);

it("discards the editor and its draft on write-only revoke and requires Edit after regrant", async () => {
  const { render, registry } = await supportedScreen();
  const writes = vi.spyOn(registry, "set");
  await click("Edit memory");
  expect(container.querySelector<HTMLInputElement>('[aria-label="Memory text"]')?.value).toBe(
    "Synthetic original",
  );
  state.write = false;
  await render();
  expect(container.querySelector('[aria-label="Memory text"]')).toBeNull();
  expect(writes.mock.calls.at(-1)?.[1]).toBeNull();
  state.write = true;
  await render();
  expect(container.querySelector('[aria-label="Memory text"]')).toBeNull();
  await click("Edit memory");
  expect(container.querySelector<HTMLInputElement>('[aria-label="Memory text"]')?.value).toBe(
    "Synthetic original",
  );
});

it("keeps the latest hub and owner versions when pre-Reload loads finish last", async () => {
  const oldHub = await deferredResult();
  const newHub = await deferredResult();
  const oldOwner = await deferredResult();
  const newOwner = await deferredResult();
  let hubCalls = 0;
  let ownerCalls = 0;
  state.executors.set("hubSettingsGet", () => (++hubCalls === 1 ? oldHub : newHub).promise);
  state.executors.set(
    "ownerSourceReadPolicyGet",
    () => (++ownerCalls === 1 ? oldOwner : newOwner).promise,
  );
  await supportedScreen();
  await click("Reload sharing settings");
  await act(async () => {
    await newHub.resolve(success(hubView(9)));
    await newOwner.resolve(success(ownerView(9, "latest-device")));
    await Promise.all([newHub.promise, newOwner.promise]);
  });
  await act(async () => {
    await oldHub.resolve(success({ version: 2, settings: { mode: "disabled" } }));
    await oldOwner.resolve(success(ownerView(2, "old-device")));
    await Promise.all([oldHub.promise, oldOwner.promise]);
  });
  expect(container.textContent).toContain("Sharing: hub");
  expect(container.textContent).toContain("latest-device");
  expect(container.textContent).not.toContain("old-device");
  await click("Turn sharing off");
  await click("Confirm sharing off");
  expect(state.calls.mock.calls.at(-1)![0]).toMatchObject({ input: { expectedVersion: 9 } });
  await click("Remove access");
  expect(state.calls.mock.calls.at(-1)![0]).toMatchObject({
    input: { expectedVersion: 9, allowedRequesterEnvironmentIds: [] },
  });
});

async function enterInput(label: string, text: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("refreshes sharing status and connected-space destination after off/on and explicit Reload", async () => {
  let syncReply = Promise.resolve<unknown>(success({ state: "online", memorySpaceId: id(1) }));
  const getSync = vi.fn(() => syncReply);
  state.executors.set("syncStatus", getSync);
  await supportedScreen(false);
  expect(getSync).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Hub connected");
  await click("Open connected memory space");
  expect(state.navigate.mock.calls.at(-1)![0]).toMatchObject({
    search: { environmentId: "remote-owner", memorySpaceId: id(1) },
  });
  const offSync = await deferredResult();
  syncReply = offSync.promise;
  state.responses.set(
    "hubSettingsUpdate",
    success({ view: { version: 3, settings: { mode: "disabled" } } }),
  );
  await click("Turn sharing off");
  await click("Confirm sharing off");
  expect(getSync).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Hub connected");
  expect(container.textContent).not.toContain("Open connected memory space");
  await act(async () => {
    await offSync.resolve(success({ state: "disabled", memorySpaceId: null }));
    await offSync.promise;
  });
  expect(container.textContent).toContain("Memory sharing off");
  syncReply = Promise.resolve(success({ state: "online", memorySpaceId: id(8) }));
  state.responses.set("hubSettingsUpdate", success({ view: hubView(4, id(8)) }));
  await click("Turn sharing on");
  await click("This environment is the hub");
  await enterInput("Sharing memory space ID (optional)", id(8));
  await click("Enable sharing");
  expect(getSync).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain("Hub connected");
  expect(
    state.calls.mock.calls.findLast(
      ([input]) => (input as { input?: { action?: string } }).input?.action === "configure",
    )?.[0],
  ).toMatchObject({ input: { settings: { mode: "hub", memorySpaceId: id(8) } } });
  await click("Open connected memory space");
  expect(state.navigate.mock.calls.at(-1)![0]).toMatchObject({
    search: { environmentId: "remote-owner", memorySpaceId: id(8) },
  });
  syncReply = Promise.resolve(success({ state: "offline", memorySpaceId: id(7) }));
  await click("Reload sharing settings");
  expect(getSync).toHaveBeenCalledTimes(4);
  expect(container.textContent).toContain("Hub disconnected");
  await click("Open connected memory space");
  expect(state.navigate.mock.calls.at(-1)![0]).toMatchObject({
    search: { environmentId: "remote-owner", memorySpaceId: id(7) },
  });
});

it("unmounts retained bodies and an open source when read is None, without reopening source on recovery", async () => {
  const { render } = await supportedScreen();
  state.queries.set(
    "history",
    Option.some({
      ...retained,
      revisions: [
        {
          revision: revision(3),
          payload: {
            ...payload,
            text: "Retained body",
            evidence: [
              {
                origin: "user",
                sourceThread: { environmentId: "source-owner", threadId: "synthetic-thread" },
                messageIds: ["synthetic-message"],
              },
            ],
          },
        },
      ],
      resolutions: [entry],
      reports: [],
    }),
  );
  state.queries.set(
    "readSource",
    Option.some({
      messages: [{ messageId: "synthetic-message", text: "Source body" }],
      nextCursor: null,
    }),
  );
  await render();
  const original = [...container.querySelectorAll("details")].find((el) =>
    el.textContent?.includes("Retained body"),
  )!;
  await act(async () => {
    original.open = true;
  });
  await click("Read original");
  expect(container.textContent).toContain("Retained body");
  expect(container.textContent).toContain("Synthetic judgment");
  expect(container.textContent).toContain("Source body");
  state.queries.set("read", Option.none());
  await render();
  expect(container.textContent).toContain("Visible details have been cleared");
  expect(container.textContent).not.toContain("Retained body");
  expect(container.textContent).not.toContain("Synthetic judgment");
  expect(container.textContent).not.toContain("Source body");
  expect(container.textContent).not.toContain("Read original");
  expect(container.textContent).not.toContain("Close original");
  state.queries.set("read", Option.some(activeItem));
  await render();
  expect(container.textContent).toContain("Read original");
  expect(container.textContent).not.toContain("Source body");
  expect(container.textContent).not.toContain("Close original");
  const recovered = [...container.querySelectorAll("details")].find((el) =>
    el.textContent?.includes("Retained body"),
  )!;
  expect(recovered.open).toBe(false);
});

it.each([false, true])(
  "retries the same forget after body-free invalidation (signal first: %s)",
  async (signalFirst) => {
    const first = await deferredResult();
    state.executors.set("forget", (input) => {
      state.calls(input);
      return first.promise;
    });
    const { render } = await supportedScreen();
    await click("Forget memory");
    await click("Confirm forget");
    const original = state.calls.mock.calls.at(-1)![0];
    async function invalidate() {
      state.queries.set("read", Option.none());
      state.queries.set("history", Option.none());
      await render();
      expect(container.textContent).not.toContain("Synthetic original");
      expect(container.textContent).not.toContain("Synthetic judgment");
      expect(container.querySelector('[aria-label="Memory text"]')).toBeNull();
    }
    if (signalFirst) await invalidate();
    await act(async () => {
      first.resolve({ _tag: "Failure" });
      await first.promise;
    });
    if (!signalFirst) await invalidate();
    expect(container.textContent).toContain("Retry this request with the same operation ID");
    state.executors.set("forget", async (input) => {
      state.calls(input);
      return { _tag: "Failure" };
    });
    await render();
    const callsBeforeRetry = state.calls.mock.calls.length;
    await click("Confirm forget");
    expect(state.calls.mock.calls.length).toBe(callsBeforeRetry + 1);
    expect(state.calls.mock.calls.at(-1)![0]).toEqual(original);
    expect(original).toMatchObject({
      environmentId: "remote-owner",
      input: { memorySpaceId: id(1), memoryId: id(2), expectedHeads: [id(5)] },
    });
    expect(container.textContent).not.toContain("Synthetic original");
  },
);

it.each(["write", "read", "reconnect", "close"])(
  "discards a body-free forget retry after %s changes",
  async (boundary) => {
    const first = await deferredResult();
    const forgetCalls = vi.fn();
    state.executors.set("forget", (input) => {
      state.calls(input);
      forgetCalls(input);
      return first.promise;
    });
    const { render } = await supportedScreen();
    await click("Forget memory");
    await click("Confirm forget");
    state.queries.set("read", Option.none());
    state.queries.set("history", Option.none());
    await render();
    const calls = forgetCalls.mock.calls.length;
    if (boundary === "write") state.write = false;
    if (boundary === "read") state.allowed = false;
    if (boundary === "reconnect") state.connection = {};
    if (boundary === "close") await act(async () => root.render(null));
    else await render();
    await act(async () => {
      first.resolve({ _tag: "Failure" });
      await first.promise;
    });
    state.write = true;
    state.allowed = true;
    await render();
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    expect(container.textContent).not.toContain("Forget request failed");
    expect(forgetCalls.mock.calls.length).toBe(calls);
  },
);

it.each(["write", "reconnect"])(
  "checks the current %s before sending a retry from the rendered confirmation",
  async (boundary) => {
    const { render } = await supportedScreen();
    await click("Forget memory");
    await click("Confirm forget");
    state.queries.set("read", Option.none());
    state.queries.set("history", Option.none());
    await render();
    const calls = state.calls.mock.calls.length;
    // Change the authoritative guard before React has observed the new lifecycle.
    if (boundary === "write") state.write = false;
    else state.connection = {};
    await click("Confirm forget");
    expect(state.calls.mock.calls.length).toBe(calls);
    await render();
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
  },
);
