import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { buildFleet, type FleetShell } from "@goat/client-runtime/state/fleet";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { FleetThreadList } from "./FleetThreadList";

const local = EnvironmentId.make("local");
const codex = ProviderInstanceId.make("codex");
const at = (minute: number) => `2026-10-17T00:${String(minute).padStart(2, "0")}:00.000Z`;

function shell(
  id: string,
  createdMinute: number,
  options: {
    readonly status?: NonNullable<FleetShell["runtime"]>["status"];
    readonly approval?: boolean;
    readonly updatedMinute?: number;
  } = {},
): FleetShell {
  const updatedAt = at(options.updatedMinute ?? createdMinute);
  return {
    environmentId: local,
    id: ThreadId.make(id),
    title: id,
    providerInstanceId: codex,
    runtime: {
      status: options.status ?? "running",
      activeRunId: null,
      providerInstanceId: codex,
      providerName: null,
      lastError: null,
      updatedAt,
    },
    hasPendingApprovals: options.approval ?? false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    sideChatOf: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    createdAt: at(createdMinute),
    updatedAt,
    source: {},
  };
}

let container: HTMLDivElement;
let root: Root;
const store = {
  shells: [] as ReadonlyArray<FleetShell>,
  listeners: new Set<() => void>(),
  subscribe: (listener: () => void) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
};

function List() {
  const shells = useSyncExternalStore(store.subscribe, () => store.shells);
  const { threads } = buildFleet({
    environments: [{ environmentId: local, label: "Mac", sshAliases: [] }],
    primaryEnvironmentId: local,
    shells,
    remote: [],
  });
  return <FleetThreadList threads={threads} />;
}

async function show(next: ReadonlyArray<FleetShell>) {
  await act(async () => {
    store.shells = next;
    for (const listener of store.listeners) listener();
  });
}

const rows = () => [...container.querySelectorAll("li")];
const titles = () => rows().map((row) => row.querySelector(".truncate")?.textContent);

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  store.shells = [shell("first", 1), shell("second", 2), shell("third", 3)];
  const router = createRouter({
    routeTree: createRootRoute({ component: List }),
    history: createMemoryHistory({ initialEntries: ["/fleet"] }),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("FleetThreadList", () => {
  it("keeps rows in place, without remounting, as threads stream and change state", async () => {
    expect(titles()).toEqual(["first", "second", "third"]);
    const before = rows();

    await show([
      shell("third", 3, { updatedMinute: 40 }),
      shell("first", 1, { updatedMinute: 30 }),
      shell("second", 2, { approval: true, updatedMinute: 50 }),
    ]);
    expect(titles()).toEqual(["first", "second", "third"]);
    expect(rows().every((row, index) => row === before[index])).toBe(true);
    expect(rows()[1]!.textContent).toContain("Needs you");
  });

  it("appends a new thread, drops a finished one, and keeps the rest mounted", async () => {
    const [first, , third] = rows();
    await show([
      shell("first", 1),
      shell("second", 2, { status: "completed" }),
      shell("third", 3),
      shell("fourth", 9),
    ]);
    expect(titles()).toEqual(["first", "third", "fourth"]);
    expect(rows()[0]).toBe(first);
    expect(rows()[1]).toBe(third);
  });
});
