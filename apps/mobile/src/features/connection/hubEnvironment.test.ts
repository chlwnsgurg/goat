import { EnvironmentId } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Preferences } from "../../persistence/mobile-preferences";
import { finishHubPairing } from "./connectHubIntent";

const storage = vi.hoisted(() => ({ json: "{}" }));
vi.mock("../../persistence/imperative", () => ({
  loadPreferences: async () => JSON.parse(storage.json) as Preferences,
  updatePreferences: async (transform: (current: Preferences) => Partial<Preferences>) => {
    const current = JSON.parse(storage.json) as Preferences;
    storage.json = JSON.stringify({ ...current, ...transform(current) });
  },
}));

import {
  loadHubEnvironmentId,
  rememberHubEnvironment,
  selectHubEnvironmentId,
} from "./hubEnvironment";

const a = EnvironmentId.make("hub-a");
const b = EnvironmentId.make("advanced-b");
const c = EnvironmentId.make("hub-c");

describe("persisted hub identity", () => {
  beforeEach(() => {
    storage.json = "{}";
  });

  it("migrates old preferences to the first saved local environment", async () => {
    expect(
      selectHubEnvironmentId(
        [{ environmentId: a }, { environmentId: b }],
        await loadHubEnvironmentId(),
      ),
    ).toBe(a);
    expect(selectHubEnvironmentId([], await loadHubEnvironmentId())).toBeNull();
  });

  it("keeps C as the hub after A→C while Advanced server B remains, including restart", async () => {
    const environments = [{ environmentId: a }, { environmentId: b }];
    await rememberHubEnvironment({ intent: "hub", pairedEnvironmentId: a });
    await rememberHubEnvironment({ intent: "add-server", pairedEnvironmentId: b });
    expect(await loadHubEnvironmentId()).toBe(a);
    environments.push({ environmentId: c });
    await rememberHubEnvironment({ intent: "change-hub", pairedEnvironmentId: c });
    await finishHubPairing({
      pairedEnvironmentId: c,
      intent: "change-hub",
      replaceEnvironmentId: a,
      removeEnvironment: async (id) => {
        environments.splice(
          environments.findIndex((environment) => environment.environmentId === id),
          1,
        );
        return AsyncResult.success(undefined);
      },
    });
    expect(environments.map((environment) => environment.environmentId)).toEqual([b, c]);
    expect(selectHubEnvironmentId(environments, await loadHubEnvironmentId())).toBe(c);
    vi.resetModules();
    const restarted = await import("./hubEnvironment");
    expect(
      restarted.selectHubEnvironmentId(environments, await restarted.loadHubEnvironmentId()),
    ).toBe(c);
  });

  it("falls back to the first local environment when the stored hub was removed", async () => {
    await rememberHubEnvironment({ intent: "hub", pairedEnvironmentId: a });
    expect(
      selectHubEnvironmentId(
        [{ environmentId: b }, { environmentId: c }],
        await loadHubEnvironmentId(),
      ),
    ).toBe(b);
    expect(selectHubEnvironmentId([], await loadHubEnvironmentId())).toBeNull();
  });

  it.each(["add-server", "add-route"] as const)(
    "does not change the hub for %s",
    async (intent) => {
      await rememberHubEnvironment({ intent: "hub", pairedEnvironmentId: a });
      await rememberHubEnvironment({ intent, pairedEnvironmentId: b });
      expect(await loadHubEnvironmentId()).toBe(a);
    },
  );

  it("preserves unrelated preferences", async () => {
    storage.json = JSON.stringify({ themeMode: "dark" });
    await rememberHubEnvironment({ intent: "hub", pairedEnvironmentId: c });
    expect(JSON.parse(storage.json)).toEqual({ themeMode: "dark", hubEnvironmentId: c });
  });
});
