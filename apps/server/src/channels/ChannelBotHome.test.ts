import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ServerSettingsError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";

const self = EnvironmentId.make("environment:self");
const other = EnvironmentId.make("environment:other");
const claim = (environmentId: EnvironmentId) => ({ environmentId, claimedAt: 1, claimId: "claim" });
const identity = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(self),
});

describe("ChannelBotHome", () => {
  it("recognizes unset, self and another home", () => {
    assert.isTrue(ChannelBotHome.isGoatBotHome(null, self));
    assert.isTrue(ChannelBotHome.isGoatBotHome(claim(self), self));
    assert.isFalse(ChannelBotHome.isGoatBotHome(claim(other), self));
  });
  it.effect("reads settings on every call and maps read failures to persistence_failed", () => {
    let reads = 0;
    const settings = Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.suspend(() => {
        reads++;
        return reads === 1
          ? Effect.succeed(DEFAULT_SERVER_SETTINGS)
          : Effect.fail(
              new ServerSettingsError({
                settingsPath: "/test/settings.json",
                operation: "read-file",
                cause: new Error("unreadable"),
              }),
            );
      }),
    });
    return Effect.gen(function* () {
      const home = yield* ChannelBotHome.ChannelBotHome;
      yield* home.requireHome;
      assert.strictEqual((yield* Effect.flip(home.requireHome)).reason, "persistence_failed");
      assert.strictEqual(reads, 2);
    }).pipe(
      Effect.provide(ChannelBotHome.layer.pipe(Layer.provide(Layer.mergeAll(settings, identity)))),
    );
  });
});

describe("ChannelBotHome.claimHere", () => {
  const layer = ChannelBotHome.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(ServerSettings.layerTest(), identity)),
  );
  it.effect.each([
    { name: "an older claim", claimedAt: 5, expected: 1_000 },
    // A claim stamped by a fast clock still loses: the new claim advances past it.
    { name: "a claim from the future", claimedAt: 9_000, expected: 9_001 },
  ])("takes the home over $name for another machine", ({ claimedAt, expected }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        goatBotHome: { environmentId: other, claimedAt, claimId: "x" },
      });
      const home = yield* ChannelBotHome.ChannelBotHome;
      assert.isFalse((yield* home.read).isHome);
      const result = yield* home.claimHere(Effect.void);
      assert.isTrue(result.claimed);
      assert.deepInclude(result.home, { environmentId: self, claimedAt: expected });
      assert.deepStrictEqual(yield* home.read, {
        home: result.home,
        environmentId: self,
        isHome: true,
      });
      yield* home.requireHome;
    }).pipe(Effect.provide(layer)),
  );
});
