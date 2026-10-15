// @vitest-environment jsdom
import { act, type ReactNode } from "react";
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
  calls: vi.fn(),
  environment: null as unknown,
  result: null as unknown,
  navigate: vi.fn(),
  responses: new Map<string, unknown>(),
  executors: new Map<string, (input: unknown) => Promise<unknown>>(),
  connection: {} as object | null,
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.allowed,
}));
vi.mock("../../state/memory", () => ({
  memoryEnvironment: Object.fromEntries(
    [
      "forget",
      "revertResolution",
      "hubSettingsGet",
      "hubSettingsUpdate",
      "ownerSourceReadPolicyGet",
      "ownerSourceReadPolicyUpdate",
    ].map((label) => [label, { label, permissionAtom: () => ({}) }]),
  ),
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
  usePreparedConnection: () => Option.fromNullishOr(state.connection),
  readPreparedConnection: () => state.connection,
  useEnvironmentScope: () => state.allowed,
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
  await act(async () =>
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
    ),
  );
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
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <MemoryForgetControl environmentId={EnvironmentId.make("remote-owner")} item={item} />
      </RegistryContext>,
    ),
  );
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
  await act(async () =>
    root.render(
      <MemorySettings
        target={validateMemorySettingsSearch({
          environmentId: "foreign-owner",
          memorySpaceId: id(1),
          memoryId: id(2),
        })}
      />,
    ),
  );
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
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <MemoryAdministration environmentId={EnvironmentId.make("remote-owner")} />
      </RegistryContext>,
    ),
  );
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
