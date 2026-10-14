import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Fixture from "../memory/handlers.testkit.ts";
const decodeDisabled = Schema.decodeUnknownEffect(M.MemoryHubDisableResult);
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
