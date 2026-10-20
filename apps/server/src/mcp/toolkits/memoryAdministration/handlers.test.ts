import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Fixture from "../memory/handlers.testkit.ts";
const decodeDisabled = Schema.decodeUnknownEffect(M.MemoryHubDisableResult);
const decodeSettings = Schema.decodeUnknownEffect(M.MemorySettingsView);
it.effect(
  "reads defaults and updates generation, model and hub sharing with settings authority",
  () =>
    Effect.gen(function* () {
      const initial = yield* Fixture.call("memory_settings_get", {});
      const defaults = yield* decodeSettings(initial.body);
      expect(defaults).toMatchObject({
        enabled: true,
        hub: { mode: "disabled" },
        model: { selection: { instanceId: "codex", model: "gpt-6-luna" }, automatic: true },
      });
      expect(
        (yield* Fixture.call("memory_settings_update", {
          requestId: Fixture.id(21),
          enabled: false,
        })).body,
      ).toMatchObject({ code: "unavailable" });
      const granted = Fixture.scope(["memory:read", "settings:write"]);
      const selection = { instanceId: "codex", model: "gpt-6-sol" };
      const updated = yield* Fixture.call(
        "memory_settings_update",
        {
          requestId: Fixture.id(22),
          enabled: false,
          modelSelection: selection,
        },
        granted,
      );
      expect(yield* decodeSettings(updated.body)).toMatchObject({
        enabled: false,
        model: { selection, automatic: false },
      });
      const enabled = yield* Fixture.call(
        "memory_settings_update",
        {
          requestId: Fixture.id(23),
          hubSync: { enabled: true, expectedVersion: defaults.hub.version },
        },
        granted,
      );
      const hub = yield* decodeSettings(enabled.body);
      expect(hub.hub.mode).toBe("hub");
      const disabled = yield* Fixture.call(
        "memory_settings_update",
        {
          requestId: Fixture.id(24),
          hubSync: { enabled: false, expectedVersion: hub.hub.version },
          enabled: true,
          modelSelection: null,
        },
        granted,
      );
      expect(yield* decodeSettings(disabled.body)).toMatchObject({
        enabled: true,
        hub: { mode: "disabled" },
        model: { selection: { instanceId: "codex", model: "gpt-6-luna" }, automatic: true },
      });
    }).pipe(Effect.provide(Fixture.layer)),
);
it.effect("disable uses explicit settings grant and CAS, returns only the disabled view", () =>
  Effect.gen(function* () {
    const input = { requestId: M.MemoryOperationId.make(Fixture.id(10)), expectedVersion: 0 };
    expect((yield* Fixture.call("memory_hub_disable", input)).body).toMatchObject({
      code: "unavailable",
    });
    const granted = Fixture.scope(["settings:write"]);
    const result = yield* Fixture.call("memory_hub_disable", input, granted);
    expect(result.result.isError).not.toBe(true);
    const view = yield* decodeDisabled(result.body);
    expect(view.settings.mode).toBe("disabled");
    expect(result.body).not.toHaveProperty("credential");
    expect(result.body).not.toHaveProperty("members");
    expect(Object.keys(result.body as object).sort()).toEqual(["settings", "version"]);
    expect(
      (yield* Fixture.call(
        "memory_hub_disable",
        { requestId: M.MemoryOperationId.make(Fixture.id(11)), expectedVersion: 0 },
        granted,
      )).result.isError,
    ).toBe(true);
    expect(
      (yield* Fixture.call(
        "memory_hub_disable",
        { requestId: M.MemoryOperationId.make(Fixture.id(12)), expectedVersion: view.version },
        { ...granted, readOnly: true },
      )).result.isError,
    ).toBe(true);
  }).pipe(Effect.provide(Fixture.layer)),
);
