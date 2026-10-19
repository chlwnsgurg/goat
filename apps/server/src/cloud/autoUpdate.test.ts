import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ServerSelfUpdateError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HttpClientError from "effect/http/HttpClientError";
import { TestClock } from "effect/testing";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import type { ServiceUpdateRecord } from "./serviceProtocol.ts";
import * as AutoUpdate from "./autoUpdate.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const publishedAt = "2026-10-01T00:00:00Z";
const published = Date.parse(publishedAt);
const stable = "1.1.0";
const nightly = "1.1.0-nightly.20261001.2";
const release = (version: string, date: string | undefined = publishedAt) => ({
  tag_name: `v${version}`,
  ...(date === undefined ? {} : { published_at: date }),
});

it.each(["stable", "nightly"] as const)(
  "rollout %s includes bucket edges exactly at the deadline",
  (channel) => {
    for (const bucket of [0, 99]) {
      const deadline =
        published +
        (channel === "stable" ? 48 : 0) * HOUR +
        (bucket / 100) * (channel === "stable" ? 72 : 12) * HOUR;
      expect(
        AutoUpdate.isRolloutEligible({ channel, bucket, publishedAt, now: deadline - 1 }),
      ).toBe(false);
      expect(AutoUpdate.isRolloutEligible({ channel, bucket, publishedAt, now: deadline })).toBe(
        true,
      );
      expect(
        AutoUpdate.isRolloutEligible({ channel, bucket, publishedAt, now: deadline + 1 }),
      ).toBe(true);
    }
  },
);

it("stable soaks for 48 hours while nightly has no soak", () => {
  expect(
    AutoUpdate.isRolloutEligible({
      channel: "stable",
      bucket: 0,
      publishedAt,
      now: published + 48 * HOUR - 1,
    }),
  ).toBe(false);
  expect(
    AutoUpdate.isRolloutEligible({
      channel: "nightly",
      bucket: 99,
      publishedAt,
      now: published + 12 * HOUR,
    }),
  ).toBe(true);
});

it.each([undefined, "", "invalid-date"])("never rolls out a release with date %s", (date) => {
  for (const channel of ["stable", "nightly"] as const) {
    expect(
      AutoUpdate.isRolloutEligible({
        channel,
        bucket: 0,
        publishedAt: date,
        now: published + 1_000 * HOUR,
      }),
    ).toBe(false);
  }
});

it.effect("uses the first four SHA256 bytes with a colon separator", () =>
  Effect.gen(function* () {
    // SHA256('env:1.1.0') starts with 4d87eb7e, whose uint32 big endian value is bucket 78.
    expect(yield* AutoUpdate.rolloutBucket("env", "1.1.0")).toBe(78);
    expect(yield* AutoUpdate.rolloutBucket("env", "1.1.0")).not.toBe(
      yield* AutoUpdate.rolloutBucket("env", "1.1.1"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const makeHarness = Effect.fn("test.auto_update.harness")(function* (
  options: {
    readonly ownVersion?: string;
    readonly capability?: "boot-service" | "desktop-managed" | null;
    readonly lastUpdate?: ServiceUpdateRecord;
    readonly activated?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-auto-update-" });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const events = yield* Queue.unbounded<ReadonlyArray<unknown>>();
  const logs: ReadonlyArray<unknown>[] = [];
  const state = {
    enabled: true,
    updating: false,
    busy: false,
    failedPreparation: false,
    activationError: false,
    reply: "ok" as "ok" | "invalid" | "network",
    releases: [release("99.0.0-preview.20261001.9"), release(nightly), release(stable)],
    requests: 0,
    prepared: [] as string[],
    updates: [] as Parameters<ServerSelfUpdate.ServerSelfUpdate["Service"]["update"]>[],
  };
  const prepareStarted = yield* Deferred.make<void>();
  const preparationGate = yield* Deferred.make<void>();
  let holdPreparation = false;
  const selfUpdate = ServerSelfUpdate.ServerSelfUpdate.of({
    capability: options.capability === undefined ? "boot-service" : options.capability,
    isUpdating: Effect.sync(() => state.updating),
    prepare: (targetVersion) =>
      Effect.gen(function* () {
        state.prepared.push(targetVersion);
        yield* Deferred.succeed(prepareStarted, undefined);
        if (holdPreparation) yield* Deferred.await(preparationGate);
        if (state.failedPreparation)
          return yield* new ServerSelfUpdateError({ reason: "checksum mismatch" });
      }),
    update: (...args) =>
      Effect.gen(function* () {
        state.updates.push(args);
        if (state.busy)
          return yield* new ServerSelfUpdateError({
            reason: ServerSelfUpdate.SERVER_UPDATE_BUSY_REASON,
          });
        if (state.activationError)
          return yield* new ServerSelfUpdateError({ reason: "launcher unavailable" });
        state.updating = true;
        return {
          method: "boot-service" as const,
          targetVersion: args[0].targetVersion,
          updateId: "update-1",
        };
      }),
    commitDesktopUpdate: () => Effect.never,
  });
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      state.requests++;
      if (state.reply === "network")
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("offline") }),
        });
      return HttpClientResponse.fromWeb(
        request,
        Response.json(state.reply === "invalid" ? { bad: true } : state.releases),
      );
    }),
  );
  const logger = Logger.make(({ message }) => {
    const parts: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message];
    logs.push(parts);
    Queue.offerUnsafe(events, parts);
  });
  const autoUpdate = yield* AutoUpdate.make({ ownVersion: options.ownVersion ?? "1.0.0" }).pipe(
    Effect.provideService(ServerSelfUpdate.ServerSelfUpdate, selfUpdate),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, {
      managed: true,
      ...(options.lastUpdate === undefined ? {} : { lastUpdate: options.lastUpdate }),
      requestUpdate: () => Effect.die("scheduler bypassed self-update"),
      prepareTrial: Effect.undefined,
    }),
    Effect.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          automaticServerUpdates: state.enabled,
        })),
      }),
    ),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    }),
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );
  const activation = yield* Deferred.make<void>();
  if (options.activated !== false) yield* Deferred.succeed(activation, undefined);
  const fiber = yield* ServerActivation.forkParkedFiber(
    autoUpdate.run.pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
  ).pipe(Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)));
  const awaitEvent = Effect.fn("test.auto_update.await_event")(function* (name: string) {
    while (true) {
      const event = yield* Queue.take(events);
      if (event[0] === `server.auto_update.${name}`) return event;
    }
  });
  return {
    state,
    logs,
    fiber,
    activation,
    awaitEvent,
    prepareStarted,
    preparationGate,
    holdPreparation: () => {
      holdPreparation = true;
    },
  };
});

it.layer(NodeServices.layer)("server auto-update", (it) => {
  it.effect(
    "waits for activation, then ten minutes, and requests an unconfirmed update with its actor",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness({ activated: false });
        yield* TestClock.adjust(24 * HOUR);
        expect(h.state.requests).toBe(0);
        yield* Deferred.succeed(h.activation, undefined);
        yield* TestClock.adjust(10 * MINUTE - 1);
        expect(h.state.requests).toBe(0);
        yield* TestClock.adjust(1);
        yield* h.awaitEvent("requested");
        expect(h.state.prepared).toEqual([stable]);
        expect(h.state.updates).toEqual([
          [{ targetVersion: stable }, undefined, undefined, { kind: "auto-update" }],
        ]);
        expect(h.logs.map((event) => event[0])).toEqual([
          "server.auto_update.checked",
          "server.auto_update.prepared",
          "server.auto_update.requested",
        ]);
      }),
  );

  it.effect.each(["desktop-managed", null] as const)("never runs on capability %s", (capability) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ capability });
      yield* Fiber.join(h.fiber);
      yield* TestClock.adjust(12 * HOUR);
      expect(h.state.requests).toBe(0);
      expect(h.state.prepared).toEqual([]);
      expect(h.state.updates).toEqual([]);
    }),
  );

  it.effect.each(["1.0.0-dev.123.gabc", "1.0.0-pr.123.1", "1.0.0-preview.20261001.1"])(
    "never updates own build %s",
    (ownVersion) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ ownVersion });
        yield* Fiber.join(h.fiber);
        yield* TestClock.adjust(12 * HOUR);
        expect(h.state.requests).toBe(0);
        expect(h.state.updates).toEqual([]);
      }),
  );

  it.effect.each([
    { ownVersion: "1.0.0", target: stable },
    { ownVersion: "1.0.0-nightly.20260930.1", target: nightly },
  ] as const)(
    "$ownVersion follows only its own channel despite a newer preview",
    ({ ownVersion, target }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness({ ownVersion });
        yield* TestClock.adjust(10 * MINUTE);
        yield* h.awaitEvent("requested");
        expect(h.state.prepared).toEqual([target]);
        expect(h.state.updates[0]?.[0].targetVersion).toBe(target);
      }),
  );

  it.effect("does no discovery or preparation when disabled and observes later opt-in", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.enabled = false;
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "disabled" });
      expect(h.state.requests).toBe(0);
      h.state.enabled = true;
      yield* TestClock.adjust(6 * HOUR);
      yield* h.awaitEvent("requested");
      expect(h.state.prepared).toEqual([stable]);
    }),
  );

  it.effect.each(["1.0.0", "0.9.0"])("refuses target %s that is not strictly newer", (target) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.releases = [release(target)];
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "not-newer" });
      expect(h.state.prepared).toEqual([]);
      expect(h.state.updates).toEqual([]);
    }),
  );

  it.effect.each(["failed", "rolled-back"] as const)(
    "skips the launcher's last %s target",
    (status) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          lastUpdate: { id: "failed-1", fromVersion: "1.0.0", targetVersion: stable, status },
        });
        h.state.releases = [release(stable), release("1.0.1")];
        yield* TestClock.adjust(10 * MINUTE);
        expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({
          reason: "previous-launcher-failure",
        });
        expect(h.state.prepared).toEqual([]);
      }),
  );

  it.effect("allows a different target after a launcher failure", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness({
        lastUpdate: {
          id: "failed-1",
          fromVersion: "1.0.0",
          targetVersion: "1.0.1",
          status: "failed",
        },
      });
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("requested");
      expect(h.state.prepared).toEqual([stable]);
    }),
  );

  it.effect.each(["missing", "invalid", "soaking"])(
    "does not prepare a release whose publication is %s",
    (date) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published);
        const h = yield* makeHarness();
        h.state.releases =
          date === "missing"
            ? [{ tag_name: `v${stable}` }]
            : [release(stable, date === "invalid" ? "bad-date" : publishedAt)];
        yield* TestClock.adjust(10 * MINUTE);
        expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({
          reason: "rollout-not-eligible",
        });
        expect(h.state.prepared).toEqual([]);
      }),
  );

  it.effect("checks every six hours after the first check", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.releases = [release("1.0.0")];
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("skipped");
      yield* TestClock.adjust(6 * HOUR - 1);
      expect(h.state.requests).toBe(1);
      yield* TestClock.adjust(1);
      yield* h.awaitEvent("skipped");
      expect(h.state.requests).toBe(2);
    }),
  );

  it.effect(
    "busy activation retries every ten minutes without another prepare or release request",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness();
        h.state.busy = true;
        yield* TestClock.adjust(10 * MINUTE);
        yield* h.awaitEvent("deferred-busy");
        yield* TestClock.adjust(10 * MINUTE - 1);
        expect(h.state.updates).toHaveLength(1);
        yield* TestClock.adjust(1);
        yield* h.awaitEvent("deferred-busy");
        h.state.busy = false;
        yield* TestClock.adjust(10 * MINUTE);
        yield* h.awaitEvent("requested");
        expect(h.state.requests).toBe(1);
        expect(h.state.prepared).toEqual([stable]);
        expect(h.state.updates).toHaveLength(3);
        for (const [input] of h.state.updates) expect(input.confirmReplacement).toBeUndefined();
      }),
  );

  it.effect("busy retries start ten minutes after a long preparation finishes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.holdPreparation();
      h.state.busy = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* Deferred.await(h.prepareStarted);
      yield* TestClock.adjust(31 * MINUTE);
      yield* Deferred.succeed(h.preparationGate, undefined);
      yield* h.awaitEvent("deferred-busy");
      yield* TestClock.adjust(10 * MINUTE - 1);
      expect(h.state.updates).toHaveLength(1);
      yield* TestClock.adjust(1);
      yield* h.awaitEvent("deferred-busy");
      expect(h.state.updates).toHaveLength(2);
      expect(h.state.prepared).toEqual([stable]);
    }),
  );

  it.effect("a non-busy activation failure waits for the next six-hour check", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.activationError = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("failed");
      yield* TestClock.adjust(10 * MINUTE);
      expect(h.state.updates).toHaveLength(1);
      h.state.activationError = false;
      yield* TestClock.adjust(6 * HOUR - 10 * MINUTE);
      yield* h.awaitEvent("requested");
      expect(h.state.updates).toHaveLength(2);
    }),
  );

  it.effect("a manual update in flight suppresses a prepared target's busy retry", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.busy = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("deferred-busy");
      h.state.updating = true;
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "update-in-flight" });
      expect(h.state.updates).toHaveLength(1);
      expect(h.state.prepared).toEqual([stable]);
      h.state.updating = false;
      h.state.busy = false;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("requested");
      expect(h.state.prepared).toEqual([stable]);
    }),
  );

  it.effect("disabling a prepared busy update prevents activation retries", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.busy = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("deferred-busy");
      h.state.enabled = false;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("skipped");
      expect(h.state.updates).toHaveLength(1);
    }),
  );

  it.effect("does not call prepare or update while another update is in flight", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.updating = true;
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "update-in-flight" });
      expect(h.state.requests).toBe(0);
      expect(h.state.prepared).toEqual([]);
      expect(h.state.updates).toEqual([]);
    }),
  );

  it.effect("does not overlap long preparation and rechecks opt-out before activation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.holdPreparation();
      yield* TestClock.adjust(10 * MINUTE);
      yield* Deferred.await(h.prepareStarted);
      yield* TestClock.adjust(12 * HOUR);
      expect(h.state.prepared).toHaveLength(1);
      expect(h.state.updates).toEqual([]);
      h.state.enabled = false;
      yield* Deferred.succeed(h.preparationGate, undefined);
      yield* h.awaitEvent("skipped");
      expect(h.state.updates).toEqual([]);
    }),
  );

  it.effect.each(["invalid", "network"] as const)(
    "logs %s release discovery failures and retries at the next cadence",
    (reply) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness();
        h.state.reply = reply;
        yield* TestClock.adjust(10 * MINUTE);
        if (reply === "network") yield* TestClock.adjust(3_000);
        yield* h.awaitEvent("failed");
        expect(h.state.prepared).toEqual([]);
        h.state.reply = "ok";
        yield* TestClock.adjust(6 * HOUR);
        yield* h.awaitEvent("requested");
        expect(h.state.prepared).toEqual([stable]);
      }),
  );

  it.effect("preparation failure never activates and retries at the next cadence", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.failedPreparation = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("failed");
      expect(h.state.updates).toEqual([]);
      h.state.failedPreparation = false;
      yield* TestClock.adjust(6 * HOUR);
      yield* h.awaitEvent("requested");
      expect(h.state.prepared).toHaveLength(2);
    }),
  );
});
