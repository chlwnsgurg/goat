import { EnvironmentId, ThreadId, type RemoteLaunch } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "../environment/scoped.ts";
import { presentRemoteLaunches, type RemoteLaunchShell } from "./remoteLaunches.ts";

const dispatcher = EnvironmentId.make("dispatcher");
const builder = EnvironmentId.make("builder-env");
const copy = EnvironmentId.make("copied-env");

const launch = (overrides: Partial<RemoteLaunch> = {}): RemoteLaunch => ({
  host: "builder",
  threadId: ThreadId.make("remote-thread"),
  title: "Stored title",
  launcherThreadId: ThreadId.make("launcher"),
  source: "thread",
  state: "running",
  latest: null,
  hostUnavailableSince: null,
  updatedAt: "2026-10-12T10:00:00.000Z",
  ...overrides,
});

const shell = (
  environmentId: EnvironmentId,
  id: string,
  launchedFrom: EnvironmentId | null = null,
): RemoteLaunchShell => ({
  environmentId,
  id: ThreadId.make(id),
  title: `Live ${id}`,
  source:
    launchedFrom === null
      ? {}
      : {
          launchedBy: {
            kind: "launch",
            threadId: ThreadId.make("launcher"),
            environmentId: launchedFrom,
            environmentLabel: "Dispatcher",
            threadTitle: "Launcher",
          },
        },
});

describe("presentRemoteLaunches", () => {
  it("opens a remote thread the client has loaded and learns the host's environment", () => {
    const [group] = presentRemoteLaunches({
      dispatcherEnvironmentId: dispatcher,
      launches: [launch(), launch({ threadId: ThreadId.make("archived"), title: "Archived" })],
      shells: [shell(builder, "remote-thread", dispatcher)],
    });
    expect(group?.host).toBe("builder");
    expect(group?.environmentId).toBe(builder);
    expect(group?.launches.map((entry) => [entry.ref, entry.title])).toEqual([
      [scopeThreadRef(builder, ThreadId.make("remote-thread")), "Live remote-thread"],
      [null, "Archived"],
    ]);
  });

  it("leaves a host unresolved when the client is not connected to it", () => {
    const groups = presentRemoteLaunches({
      dispatcherEnvironmentId: dispatcher,
      launches: [launch(), launch({ host: "laptop", threadId: null, state: "launching" })],
      shells: [],
    });
    expect(groups.map((group) => [group.host, group.environmentId])).toEqual([
      ["builder", null],
      ["laptop", null],
    ]);
    expect(groups.flatMap((group) => group.launches.map((entry) => entry.ref))).toEqual([
      null,
      null,
    ]);
  });

  it("prefers the copy launched from the dispatcher and refuses an ambiguous id", () => {
    const resolved = presentRemoteLaunches({
      dispatcherEnvironmentId: dispatcher,
      launches: [launch()],
      shells: [shell(copy, "remote-thread"), shell(builder, "remote-thread", dispatcher)],
    });
    expect(resolved[0]?.launches[0]?.ref).toEqual(
      scopeThreadRef(builder, ThreadId.make("remote-thread")),
    );

    const ambiguous = presentRemoteLaunches({
      dispatcherEnvironmentId: dispatcher,
      launches: [launch()],
      shells: [shell(copy, "remote-thread"), shell(builder, "remote-thread")],
    });
    expect(ambiguous[0]?.launches[0]?.ref).toBeNull();
  });

  it("never resolves a remote thread to the dispatcher itself", () => {
    const [group] = presentRemoteLaunches({
      dispatcherEnvironmentId: dispatcher,
      launches: [launch()],
      shells: [shell(dispatcher, "remote-thread")],
    });
    expect(group?.launches[0]?.ref).toBeNull();
  });

  it("refuses a lone copy that records another launcher, unless the launch is a watch", () => {
    const elsewhere = shell(builder, "remote-thread", copy);
    const otherLauncher: RemoteLaunchShell = {
      ...shell(builder, "remote-thread", dispatcher),
      source: {
        launchedBy: {
          kind: "launch",
          threadId: ThreadId.make("another-launcher"),
          environmentId: dispatcher,
          environmentLabel: "Dispatcher",
          threadTitle: "Another",
        },
      },
    };
    const refs = (
      launches: ReadonlyArray<RemoteLaunch>,
      shells: ReadonlyArray<RemoteLaunchShell>,
    ) =>
      presentRemoteLaunches({ dispatcherEnvironmentId: dispatcher, launches, shells }).flatMap(
        (group) => group.launches.map((entry) => entry.ref),
      );
    expect(refs([launch()], [elsewhere])).toEqual([null]);
    expect(refs([launch()], [otherLauncher])).toEqual([null]);
    expect(refs([launch({ source: "watch", state: null })], [elsewhere])).toEqual([
      scopeThreadRef(builder, ThreadId.make("remote-thread")),
    ]);
    // Two copies launched from the dispatcher: only the one from this launcher thread opens.
    expect(refs([launch()], [otherLauncher, shell(copy, "remote-thread", dispatcher)])).toEqual([
      scopeThreadRef(copy, ThreadId.make("remote-thread")),
    ]);
  });

  it("names the provider and model of a resolved thread", () => {
    const resolved: RemoteLaunchShell = {
      ...shell(builder, "remote-thread", dispatcher),
      providerInstanceId: "codex",
      modelSelection: { model: "gpt-6-sol" },
    };
    const labels = (providerName?: (environmentId: EnvironmentId, id: string) => string | null) =>
      presentRemoteLaunches({
        dispatcherEnvironmentId: dispatcher,
        launches: [launch(), launch({ host: "laptop", threadId: null, state: "launching" })],
        shells: [resolved],
        ...(providerName ? { providerName } : {}),
      }).flatMap((group) => group.launches.map((entry) => entry.providerLabel));
    expect(labels((environmentId) => (environmentId === builder ? "Codex" : null))).toEqual([
      "Codex · gpt-6-sol",
      null,
    ]);
    expect(labels()).toEqual(["codex · gpt-6-sol", null]);
  });
});
