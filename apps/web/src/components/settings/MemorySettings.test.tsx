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
  exposure: 0,
  listeners: new Set<() => void>(),
  queries: new Map<string, unknown>(),
  refresh: vi.fn(),
  calls: vi.fn(),
  environment: null as unknown,
  environments: [] as {
    environmentId: string;
    label: string;
    connection: { phase: string };
    serverConfig: { environment: { capabilities: { memory: { protocolVersion: number } } } };
  }[],
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
    return atom.label === "syncChanges"
      ? state.exposure
      : ["forget", "upsert"].includes(atom.label)
        ? state.write
        : state.allowed;
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
      exposureAtom: () => ({ label: "syncChanges" }),
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
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  usePreparedConnection: () => {
    useFixtureVersion();
    return Option.fromNullishOr(state.connection);
  },
  readPreparedConnection: () => state.connection,
  readEnvironmentScope: () => state.allowed,
  useEnvironmentScope: () => {
    useFixtureVersion();
    return state.allowed;
  },
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: MemoryItem[];
    renderItem: (input: { item: MemoryItem }) => ReactNode;
  }) => (
    <div>
      {data.map((item) => (
        <div key={item.memoryId}>{renderItem({ item })}</div>
      ))}
    </div>
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: ReactNode;
    value: string | null;
    onValueChange: (id: string) => void;
    disabled: boolean;
  }) => (
    <select
      aria-label="Fixture device picker"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onValueChange(e.currentTarget.value)}
    >
      <option value="">Choose a device</option>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
  }: {
    title?: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div data-test-row>
      {title}
      {description}
      {status}
      {control}
      {children}
    </div>
  ),
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
  state.exposure = 0;
  state.queries.clear();
  state.executors.clear();
  state.refresh.mockClear();
  state.calls.mockClear();
  state.environment = null;
  state.environments = [
    "active-device",
    "pending-device",
    "device-a",
    "latest-device",
    "old-device",
  ].map((environmentId) => ({
    environmentId,
    label: environmentId.replace("-device", " device"),
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { memory: { protocolVersion: 1 } } } },
  }));
  state.result = { _tag: "Failure" };
  state.responses.clear();
  state.connection = { httpBaseUrl: "https://hub.example" };
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
  state.connection = { httpBaseUrl: "https://hub.example" };
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
  vi.spyOn(registry, "get").mockImplementation(() => state.write as never);
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
  state.write = false;
  await renderForget();
  expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
  state.write = true;
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
  expect(container.textContent).not.toContain("foreign-owner");
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
    value: { version: 2, members: [], settings: { mode: "hub", memorySpaceId: id(1) } },
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
  expect(container.textContent).toContain("pending device");
  expect(container.textContent).toContain("active device");
  const remove = [...container.querySelectorAll("[data-test-row]")]
    .find((entry) => entry.textContent?.startsWith("active device"))!
    .querySelector("button")!;
  await act(async () => remove.click());
  const request = state.calls.mock.calls.at(-1)![0] as {
    environmentId: string;
    input: { allowedRequesterEnvironmentIds: string[]; expectedVersion: number };
  };
  expect(request.input.allowedRequesterEnvironmentIds).toEqual(["pending-device"]);
  expect(request.input.expectedVersion).toBe(3);
  expect(request.environmentId).toBe("remote-owner");
  expect(
    [...container.querySelectorAll("[data-test-row]")].some((row) =>
      row.textContent?.startsWith("active device"),
    ),
  ).toBe(false);
  expect(container.textContent).toContain("pending device");
  const calls = state.calls.mock.calls.length;
  await click("Turn sharing off");
  await click("Cancel");
  expect(state.calls.mock.calls.length).toBe(calls);
  state.responses.set("hubSettingsUpdate", {
    _tag: "Success",
    value: { view: { version: 3, settings: { mode: "disabled" } }, credential: null },
  });
  await click("Turn sharing off");
  await click("Stop sharing");
  expect(container.textContent).toContain("Memory off");
  expect(container.textContent).toContain("Make this device the hub");
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
  members: [] as {
    environmentId: string;
    credentialVersion: number;
    status: string;
    joinedAt: number | null;
  }[],
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
    if (label) return (["forget", "upsert"].includes(label) ? state.write : state.allowed) as never;
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

it("retries a failed load inline without a reload control", async () => {
  let loads = 0;
  state.executors.set("hubSettingsGet", async () =>
    ++loads === 1 ? { _tag: "Failure" } : success(hubView(3)),
  );
  state.responses.set("syncStatus", success({ state: "disabled", memorySpaceId: null }));
  await supportedScreen(false);
  expect(container.textContent).toContain("Could not load sharing settings.");
  await click("Retry");
  expect(loads).toBe(2);
  expect(container.textContent).toContain("This device is the hub");
  expect(container.textContent).not.toContain("Could not load sharing settings.");
  expect(container.textContent).not.toContain("Reload sharing settings");
  expect(container.textContent).not.toContain("Operational details");
  expect(container.textContent).not.toContain("Device removal applied");
});

it("automatically opens the ready space and shows the off empty state after confirmation", async () => {
  state.responses.set("syncStatus", success({ state: "online", memorySpaceId: id(1) }));
  state.queries.set("list", Option.some({ items: [activeItem], nextCursor: null }));
  await supportedScreen(false);
  expect(container.textContent).toContain("Synthetic original");
  expect(container.querySelector('[aria-label="Memory space ID"]')).toBeNull();
  expect(container.textContent).not.toContain("remote-owner ·");
  state.responses.set("syncStatus", success({ state: "disabled", memorySpaceId: null }));
  state.responses.set(
    "hubSettingsUpdate",
    success({ view: { version: 3, settings: { mode: "disabled" } }, credential: null }),
  );
  await click("Turn sharing off");
  expect(container.textContent).toContain("Saved memories stay.");
  await click("Stop sharing");
  expect(container.textContent).toContain("Turn on memory to start saving memories.");
  expect(container.textContent).not.toContain("Synthetic original");
  state.responses.set("syncStatus", success({ state: "online", memorySpaceId: id(8) }));
  state.responses.set("hubSettingsUpdate", success({ view: hubView(4, id(8)), credential: null }));
  await click("Make this device the hub");
  expect(
    state.calls.mock.calls.findLast(
      ([input]) => (input as { input?: { action?: string } }).input?.action === "configure",
    )?.[0],
  ).toMatchObject({ input: { settings: { mode: "hub", memorySpaceId: null } } });
  expect(container.textContent).toContain("Synthetic original");
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

it.each(["write", "read", "reconnect"])(
  "checks the current %s before sending a retry from the rendered confirmation",
  async (boundary) => {
    const forgetCalls = vi.fn();
    state.executors.set("forget", async (input) => {
      forgetCalls(input);
      return { _tag: "Failure" };
    });
    const { render } = await supportedScreen();
    await click("Forget memory");
    await click("Confirm forget");
    const original = forgetCalls.mock.calls[0]![0];
    expect(container.textContent).toContain("Retry this request with the same operation ID");
    state.queries.set("read", Option.none());
    state.queries.set("history", Option.none());
    await render();
    expect(container.textContent).not.toContain("Synthetic original");
    const calls = forgetCalls.mock.calls.length;
    const connection = state.connection;
    // Change the authoritative guard before React has observed the new lifecycle.
    if (boundary === "write") state.write = false;
    if (boundary === "read") state.allowed = false;
    if (boundary === "reconnect") state.connection = {};
    if (boundary === "read") {
      expect(state.write).toBe(true);
      expect(state.connection).toBe(connection);
    }
    await click("Confirm forget");
    expect(forgetCalls.mock.calls.length).toBe(calls);
    await render();
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    expect(container.textContent).not.toContain("Forget request failed");
    state.write = true;
    state.allowed = true;
    await render();
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    expect(container.textContent).not.toContain("Forget request failed");
    expect(forgetCalls.mock.calls.length).toBe(calls);
    // A returning body permits a new explicit intent, never revives the old one.
    state.queries.set("read", Option.some(activeItem));
    await render();
    expect(container.querySelector('[aria-label="Forget confirmation"]')).toBeNull();
    await click("Forget memory");
    await click("Confirm forget");
    expect(forgetCalls.mock.calls.length).toBe(calls + 1);
    expect(forgetCalls.mock.calls.at(-1)![0]).not.toEqual(original);
  },
);

it("adds a named device, retries install without exposing its key, and confirms removal", async () => {
  const { render } = await supportedScreen(false);
  const select = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "active-device";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Add");
  expect(container.textContent).toContain("Add active device?");
  const credential = "ephemeral-key-that-must-not-be-rendered";
  const mutations: { environmentId: string; input: Record<string, unknown> }[] = [];
  let failInstall = true;
  const log = vi.spyOn(console, "log");
  const warn = vi.spyOn(console, "warn");
  const error = vi.spyOn(console, "error");
  state.executors.set("hubSettingsUpdate", async (raw) => {
    const request = raw as { environmentId: string; input: Record<string, unknown> };
    mutations.push(request);
    if (request.input.action === "installCredential" && failInstall) {
      failInstall = false;
      return { _tag: "Failure" };
    }
    return success({
      view: {
        ...hubView(request.input.action === "provisionMember" ? 3 : 4),
        members:
          request.input.action === "revokeMember"
            ? []
            : [
                {
                  environmentId: "active-device",
                  credentialVersion: 1,
                  status: "active",
                  joinedAt: 0,
                },
              ],
      },
      credential:
        request.input.action === "provisionMember"
          ? { requestId: request.input.requestId, memorySpaceId: id(1), credential }
          : null,
    });
  });
  await render();
  await click("Confirm");
  expect(mutations.map((r) => r.input.action)).toEqual(["provisionMember", "installCredential"]);
  expect(container.innerHTML).not.toContain(credential);
  expect(container.textContent).toContain("Retry to continue");
  await click("Retry");
  expect(mutations.map((r) => r.input.action)).toEqual([
    "provisionMember",
    "installCredential",
    "installCredential",
    "acknowledgeCredential",
  ]);
  expect(mutations[1]).toEqual(mutations[2]);
  expect(container.innerHTML).not.toContain(credential);
  expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(
    credential,
  );
  const row = [...container.querySelectorAll("[data-test-row]")].find((e) =>
    e.textContent?.startsWith("active device"),
  )!;
  const remove = [...row.querySelectorAll("button")].find((b) => b.textContent === "Remove")!;
  await act(async () => remove.click());
  expect(mutations).toHaveLength(4);
  expect(container.textContent).toContain("Remove active device?");
  await click("Remove device");
  expect(mutations.at(-1)?.input.action).toBe("revokeMember");
});

it("opens memories when bootstrap publishes a reset without a reload or timer", async () => {
  state.responses.set("syncStatus", success({ state: "bootstrapping", memorySpaceId: id(1) }));
  state.queries.set("list", Option.some({ items: [activeItem], nextCursor: null }));
  await supportedScreen(false);
  expect(container.textContent).toContain("Memory is getting ready.");
  expect(container.textContent).not.toContain("Synthetic original");
  state.responses.set("syncStatus", success({ state: "online", memorySpaceId: id(1) }));
  await act(async () => {
    state.exposure += 1;
    notifyFixture();
  });
  expect(container.textContent).toContain("Synthetic original");
  expect(container.textContent).not.toContain("Memory is getting ready.");
});

it("reloads persisted members, excludes them from Add, and removes an offline unknown device", async () => {
  const { render } = await supportedScreen(false);
  const members = [
    { environmentId: "active-device", credentialVersion: 2, status: "active", joinedAt: 0 },
    {
      environmentId: "unregistered-private-id",
      credentialVersion: 1,
      status: "pending_ack",
      joinedAt: 0,
    },
  ];
  state.responses.set("hubSettingsGet", success({ ...hubView(4), members }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await render();
  expect(container.textContent).not.toContain("Device list unavailable");
  expect(container.textContent).not.toContain("unregistered-private-id");
  expect(container.textContent).toContain("Waiting for the device to confirm");
  const picker =
    container.querySelector<HTMLSelectElement>('select[aria-label="Device"]') ??
    container.querySelector<HTMLSelectElement>("select")!;
  expect([...picker.options].map((o) => o.value)).not.toContain("active-device");
  const row = [...container.querySelectorAll("[data-test-row]")].find((e) =>
    e.textContent?.startsWith("Unknown device"),
  )!;
  expect(row.textContent).toContain(
    "Connect this device in Settings → Connections to replace its key.",
  );
  const buttons = [...row.querySelectorAll("button")];
  expect(buttons.find((b) => b.textContent === "Replace key")!.disabled).toBe(true);
  expect(buttons.find((b) => b.textContent === "Remove")!.disabled).toBe(false);
  await act(async () => buttons.find((b) => b.textContent === "Remove")!.click());
  state.responses.set(
    "hubSettingsUpdate",
    success({
      view: { ...hubView(5), members: [members[0]] },
      credential: null,
    }),
  );
  await click("Remove device");
  expect(state.calls.mock.calls.at(-1)![0]).toMatchObject({
    environmentId: "remote-owner",
    input: { action: "revokeMember", environmentId: "unregistered-private-id", expectedVersion: 4 },
  });
  expect(container.textContent).not.toContain("Unknown device");
});
