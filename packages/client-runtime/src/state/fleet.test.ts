import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type CloudMachine,
  type RemoteLaunch,
} from "@goat/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleet,
  classifyFleetThread,
  createFleetSummaryAtom,
  type FleetEnvironment,
  type FleetShell,
} from "./fleet.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const codex = ProviderInstanceId.make("codex");
const CLOUD_ALIAS = "boat-bx_abcdefgh";

type ShellOptions = {
  readonly status?: NonNullable<FleetShell["runtime"]>["status"] | null;
  readonly background?: boolean;
  readonly approval?: boolean;
  readonly question?: boolean;
  readonly archived?: boolean;
  readonly sideChat?: boolean;
  readonly title?: string;
  readonly launchedBy?: FleetShell["source"]["launchedBy"];
};

function shell(environmentId: EnvironmentId, id: string, options: ShellOptions = {}): FleetShell {
  const status = options.status === undefined ? "running" : options.status;
  return {
    environmentId,
    id: ThreadId.make(id),
    title: options.title ?? id,
    providerInstanceId: codex,
    runtime:
      status === null
        ? null
        : {
            status,
            activeRunId: null,
            providerInstanceId: codex,
            providerName: null,
            lastError: null,
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
    hasPendingApprovals: options.approval ?? false,
    hasPendingUserInput: options.question ?? false,
    pendingBackgroundTasks: options.background
      ? ([{ kind: "command" }] as unknown as FleetShell["pendingBackgroundTasks"])
      : [],
    archivedAt: options.archived ? "2026-10-17T00:00:00.000Z" : null,
    deletedAt: null,
    sideChatOf: options.sideChat ? ThreadId.make("parent") : null,
    updatedAt: "2026-10-17T00:00:00.000Z",
    source: options.launchedBy === undefined ? {} : { launchedBy: options.launchedBy },
  };
}

function launch(overrides: Partial<RemoteLaunch> & Pick<RemoteLaunch, "host">): RemoteLaunch {
  return {
    threadId: null,
    title: "Remote task",
    launcherThreadId: ThreadId.make("launcher"),
    source: "thread",
    state: "running",
    latest: null,
    hostUnavailableSince: null,
    updatedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
}

function cloud(overrides: Partial<CloudMachine> = {}): CloudMachine {
  return {
    alias: CLOUD_ALIAS,
    sandboxId: "bx_abcdefgh",
    label: "Cloud box",
    provider: "boat",
    type: "default",
    ttlSeconds: 3600,
    presence: "present",
    state: "running",
    deletePending: false,
    lastError: null,
    ...overrides,
  } as CloudMachine;
}

const env = (environmentId: EnvironmentId, label: string, sshAliases: string[] = []) =>
  ({ environmentId, label, sshAliases }) satisfies FleetEnvironment;

describe("classifyFleetThread", () => {
  it("puts a pending request ahead of active work", () => {
    expect(classifyFleetThread(shell(local, "a", { approval: true }))).toBe("attention");
    expect(classifyFleetThread(shell(local, "b", { question: true, status: "idle" }))).toBe(
      "attention",
    );
  });

  it("counts active runs and idle runs held by background work", () => {
    for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
      expect(classifyFleetThread(shell(local, status, { status }))).toBe("running");
    }
    expect(classifyFleetThread(shell(local, "bg", { status: "idle", background: true }))).toBe(
      "running",
    );
  });

  it("leaves finished, failed, and hidden threads out", () => {
    expect(classifyFleetThread(shell(local, "idle", { status: "idle" }))).toBeNull();
    expect(classifyFleetThread(shell(local, "failed", { status: "failed" }))).toBeNull();
    expect(classifyFleetThread(shell(local, "never", { status: null }))).toBeNull();
    expect(classifyFleetThread(shell(local, "archived", { archived: true }))).toBeNull();
    expect(classifyFleetThread(shell(local, "side", { sideChat: true }))).toBeNull();
  });
});

describe("createFleetSummaryAtom", () => {
  it("counts per connected machine and keeps the same object until a count changes", () => {
    const shellsAtom = Atom.make<ReadonlyArray<FleetShell>>([
      shell(local, "a"),
      shell(local, "b", { question: true }),
      shell(local, "done", { status: "completed" }),
      shell(remote, "c"),
      shell(EnvironmentId.make("disconnected"), "d"),
    ]);
    const environmentsAtom = Atom.make<ReadonlyArray<FleetEnvironment>>([
      env(local, "Mac"),
      env(remote, "Box"),
    ]);
    const summaryAtom = createFleetSummaryAtom({
      threadShellsAtom: shellsAtom,
      environmentsAtom,
    });
    const registry = AtomRegistry.make();
    const stop = registry.subscribe(summaryAtom, () => undefined);
    const first = registry.get(summaryAtom);
    expect(first).toEqual({
      running: 2,
      attention: 1,
      machines: [
        { environmentId: local, label: "Mac", running: 1, attention: 1 },
        { environmentId: remote, label: "Box", running: 1, attention: 0 },
      ],
    });

    registry.set(shellsAtom, [
      shell(local, "a", { title: "Renamed" }),
      shell(local, "b", { question: true }),
      shell(local, "done", { status: "completed" }),
      shell(remote, "c"),
    ]);
    expect(registry.get(summaryAtom)).toBe(first);

    registry.set(shellsAtom, [shell(local, "b", { question: true }), shell(remote, "c")]);
    expect(registry.get(summaryAtom).machines[0]).toMatchObject({ running: 0, attention: 1 });
    stop();
  });
});

describe("buildFleet", () => {
  it("draws a disconnected environment without counting its stale threads", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), { ...env(remote, "Box"), connected: false }],
      primaryEnvironmentId: local,
      shells: [shell(local, "a"), shell(remote, "stale", { question: true })],
      remote: [],
    });
    expect(
      fleet.machines.map((machine) => [machine.label, machine.running, machine.attention]),
    ).toEqual([
      ["Mac", 1, 0],
      ["Box", 0, 0],
    ]);
    expect(fleet.threads.map((thread) => thread.title)).toEqual(["a"]);
  });

  it("counts a launch whose thread is loaded here once, as that live thread", () => {
    const remoteThread = shell(remote, "t1", {
      status: "completed",
      launchedBy: { environmentId: local, threadId: ThreadId.make("launcher") },
    } as ShellOptions);
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box")],
      primaryEnvironmentId: local,
      shells: [remoteThread],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [launch({ host: "box", threadId: ThreadId.make("t1") })],
          cloudMachines: [],
        },
      ],
    });
    expect(fleet.totals).toEqual({ running: 0, attention: 0, reported: 0, machines: 2 });
    expect(fleet.threads).toEqual([]);
  });

  it("reports an unresolved running launch on its SSH host, without a link", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells: [],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [
            launch({ host: "devbox", title: "Fix tests" }),
            launch({ host: "devbox", state: "settled" }),
            launch({ host: "gone", hostUnavailableSince: "2026-10-17T00:00:00.000Z" }),
          ],
          cloudMachines: [],
        },
      ],
    });
    expect(fleet.totals).toEqual({ running: 0, attention: 0, reported: 1, machines: 2 });
    expect(fleet.machines[1]).toMatchObject({ kind: "ssh", label: "devbox", subtitle: "via Mac" });
    expect(fleet.threads).toMatchObject([{ title: "Fix tests", ref: null, reportedBy: "Mac" }]);
  });

  it("ignores disconnected shells when resolving a launch", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells: [shell(remote, "t1", { status: "completed" })],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [launch({ host: "box", threadId: ThreadId.make("t1") })],
          cloudMachines: [],
        },
      ],
    });
    expect(fleet.totals.reported).toBe(1);
  });

  it("shows a connected cloud machine once when a launch resolved its host", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box")],
      primaryEnvironmentId: null,
      shells: [shell(remote, "t1")],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [launch({ host: CLOUD_ALIAS, threadId: ThreadId.make("t1") })],
          cloudMachines: [cloud()],
        },
      ],
    });
    expect(fleet.machines).toHaveLength(2);
    expect(fleet.machines[1]).toMatchObject({
      kind: "environment",
      subtitle: "Cloud box",
      cloudState: "running",
      running: 1,
    });
  });

  it("matches a cloud alias to the primary's SSH connection and adds no work for its state", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box", [CLOUD_ALIAS])],
      primaryEnvironmentId: local,
      shells: [],
      remote: [{ dispatcherEnvironmentId: local, launches: [], cloudMachines: [cloud()] }],
    });
    expect(fleet.machines).toHaveLength(2);
    expect(fleet.machines[1]).toMatchObject({ environmentId: remote, cloudState: "running" });
    expect(fleet.totals).toMatchObject({ running: 0, attention: 0, reported: 0 });
  });

  it("keeps a cloud machine separate when nothing ties it to a connection", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box", [CLOUD_ALIAS])],
      primaryEnvironmentId: remote,
      shells: [],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [],
          cloudMachines: [
            cloud(),
            cloud({ alias: "boat-bx_zzzzzzzz" as CloudMachine["alias"], deletePending: true }),
          ],
        },
      ],
    });
    expect(fleet.machines.map((machine) => machine.kind)).toEqual([
      "environment",
      "environment",
      "cloud",
    ]);
    expect(fleet.machines[2]).toMatchObject({ label: "Cloud box", subtitle: "via Mac" });
  });

  it("orders work needing the user first and groups agents per machine", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells: [shell(local, "a"), shell(local, "b", { approval: true }), shell(local, "c")],
      remote: [],
      provider: () => ({ label: "Codex", driver: ProviderDriverKind.make("codex") }),
    });
    expect(fleet.threads.map((thread) => thread.state)).toEqual([
      "attention",
      "running",
      "running",
    ]);
    expect(fleet.machines[0]!.agents).toEqual([
      { key: "codex", label: "Codex", driver: "codex", running: 2, attention: 1, reported: 0 },
    ]);
  });
});
