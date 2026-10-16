import { scopedThreadKey } from "@goat/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/session", () => ({ readPreparedConnection: () => null }));

import {
  type BrowserHistoryEntry,
  recordVisitForThread,
  resetBrowserHistoryForTests,
  useBrowserHistoryStore,
  useThreadRecentHistory,
} from "../browserHistoryStore";
import type { Project } from "../types";
import { useBrowserHistoryProject } from "./useBrowserHistoryProject";

const environmentId = EnvironmentId.make("env-primary");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const repositoryIdentity = {
  canonicalKey: "github.com/example/browser-history",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/browser-history.git",
  },
};
const project: Project = {
  id: ProjectId.make("project-1"),
  environmentId,
  title: "browser-history",
  workspaceRoot: "/tmp/browser-history",
  repositoryIdentity,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};
const input: Parameters<typeof useBrowserHistoryProject>[0] = {
  threadRef,
  project,
  projects: [project],
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: environmentId,
  clientSettingsHydrated: true,
};

let renderer: ReactTestRenderer | null = null;
let recent: ReadonlyArray<BrowserHistoryEntry> = [];

function Probe(props: typeof input) {
  useBrowserHistoryProject(props);
  const entries = useThreadRecentHistory(props.threadRef ?? threadRef, 10);
  useEffect(() => {
    recent = entries;
  }, [entries]);
  return null;
}

async function render(overrides: Partial<typeof input> = {}) {
  await act(() => {
    const element = <Probe {...input} {...overrides} />;
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

beforeEach(() => {
  resetBrowserHistoryForTests();
  recent = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  resetBrowserHistoryForTests();
  vi.unstubAllGlobals();
});

describe("useBrowserHistoryProject", () => {
  it.each(["server-thread", "draft-thread"])(
    "makes queued and subsequent visits visible and persistent for a %s",
    async (threadId) => {
      const ref = { environmentId, threadId: ThreadId.make(threadId) };
      recordVisitForThread(ref, "https://example.com/queued", 1);
      await render({ threadRef: ref });
      expect(recent).toEqual([{ url: "https://example.com/queued", lastVisitedAt: 1 }]);
      expect(useBrowserHistoryStore.getState().pendingVisitsByThreadKey).toEqual({});

      await act(() => recordVisitForThread(ref, "https://example.com/next", 2));
      expect(recent.map((entry) => entry.url)).toEqual([
        "https://example.com/next",
        "https://example.com/queued",
      ]);
      const storage = useBrowserHistoryStore.persist.getOptions().storage;
      expect((await storage?.getItem("goat:browser-history:v1"))?.state).toMatchObject({
        byProjectKey: { [repositoryIdentity.canonicalKey]: recent },
        projectKeyByThreadKey: { [scopedThreadKey(ref)]: repositoryIdentity.canonicalKey },
      });
    },
  );

  it("waits for client settings hydration before assigning or flushing history", async () => {
    recordVisitForThread(threadRef, "https://example.com/", 1);
    await render({ clientSettingsHydrated: false });
    expect(recent).toEqual([]);
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey).toEqual({});
    expect(
      useBrowserHistoryStore.getState().pendingVisitsByThreadKey[scopedThreadKey(threadRef)],
    ).toHaveLength(1);

    await render();
    expect(recent).toEqual([{ url: "https://example.com/", lastVisitedAt: 1 }]);
  });

  it("uses the sidebar identity borrowed from a duplicate physical project's sibling", async () => {
    const staleProject = {
      ...project,
      id: ProjectId.make("stale-project"),
      repositoryIdentity: null,
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    recordVisitForThread(threadRef, "https://example.com/", 1);
    await render({ project: staleProject, projects: [staleProject, project] });
    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({
      [repositoryIdentity.canonicalKey]: [{ url: "https://example.com/", lastVisitedAt: 1 }],
    });
    expect(recent).toHaveLength(1);
  });

  it("derives the project key when a draft's project is not in the project list yet", async () => {
    recordVisitForThread(threadRef, "https://example.com/", 1);
    await render({ projects: [] });
    expect(recent).toEqual([{ url: "https://example.com/", lastVisitedAt: 1 }]);
    expect(
      useBrowserHistoryStore.getState().projectKeyByThreadKey[scopedThreadKey(threadRef)],
    ).toBe(repositoryIdentity.canonicalKey);
  });

  it("leaves a projectless thread queued and binds once its project resolves", async () => {
    recordVisitForThread(threadRef, "https://example.com/", 1);
    await render({ project: null });
    expect(recent).toEqual([]);
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey).toEqual({});

    await render();
    expect(recent).toEqual([{ url: "https://example.com/", lastVisitedAt: 1 }]);
  });

  it("does not bind without an active thread", async () => {
    await render({ threadRef: null });
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey).toEqual({});
  });

  it("rebinds when grouping settings change and isolates the same thread id on another host", async () => {
    recordVisitForThread(threadRef, "https://example.com/local", 1);
    await render();
    const separateSettings = { ...input.settings, sidebarProjectGroupingMode: "separate" as const };
    await render({ settings: separateSettings });
    await act(() => recordVisitForThread(threadRef, "https://example.com/separate", 2));
    expect(recent).toEqual([{ url: "https://example.com/separate", lastVisitedAt: 2 }]);
    const remoteRef = { ...threadRef, environmentId: EnvironmentId.make("env-remote") };
    const remoteProject = { ...project, environmentId: remoteRef.environmentId };
    recordVisitForThread(remoteRef, "https://example.com/remote", 3);
    await render({
      threadRef: remoteRef,
      project: remoteProject,
      projects: [project, remoteProject],
      settings: separateSettings,
      primaryEnvironmentId: null,
    });
    expect(recent).toEqual([{ url: "https://example.com/remote", lastVisitedAt: 3 }]);
    expect(
      useBrowserHistoryStore.getState().projectKeyByThreadKey[scopedThreadKey(threadRef)],
    ).toBe("env-primary:/tmp/browser-history");
    expect(
      useBrowserHistoryStore.getState().projectKeyByThreadKey[scopedThreadKey(remoteRef)],
    ).toBe("env-remote:/tmp/browser-history");
  });
});
