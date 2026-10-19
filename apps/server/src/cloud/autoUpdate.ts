import { cliReleaseChannelOf, isPublishableCliReleaseVersion } from "@goat/shared/cliRelease";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import packageJson from "../../package.json" with { type: "json" };
import { resolveNewestRelease } from "../cli/update.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { compareExactServiceVersions } from "./serviceProtocol.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CHECK_INTERVAL = 6 * HOUR;
const ACTIVATION_INTERVAL = 10 * MINUTE;

export const rolloutBucket = Effect.fn("server.auto_update.rollout_bucket")(function* (
  environmentId: string,
  targetVersion: string,
) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(`${environmentId}:${targetVersion}`),
  );
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) % 100;
});

export function isRolloutEligible(input: {
  readonly channel: "stable" | "nightly";
  readonly bucket: number;
  readonly publishedAt: string | undefined;
  readonly now: number;
}): boolean {
  const publishedAt = input.publishedAt === undefined ? NaN : Date.parse(input.publishedAt);
  const soak = input.channel === "stable" ? 48 * HOUR : 0;
  const window = input.channel === "stable" ? 72 * HOUR : 12 * HOUR;
  return (
    Number.isFinite(publishedAt) && input.now >= publishedAt + soak + (input.bucket / 100) * window
  );
}

export class ServerAutoUpdate extends Context.Service<
  ServerAutoUpdate,
  { readonly run: Effect.Effect<void> }
>()("goat/cloud/autoUpdate/ServerAutoUpdate") {}

export const make = Effect.fn("server.auto_update.make")(function* (options?: {
  readonly ownVersion?: string;
}) {
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const ownVersion = options?.ownVersion ?? packageJson.version;
  const channel = cliReleaseChannelOf(ownVersion);
  const skipped = (reason: string, targetVersion?: string) =>
    Effect.logInfo("server.auto_update.skipped", { reason, targetVersion });
  const blocked = (targetVersion: string) =>
    (launcher.lastUpdate?.status === "failed" || launcher.lastUpdate?.status === "rolled-back") &&
    launcher.lastUpdate.targetVersion === targetVersion;
  const enabled = settings.getSettings.pipe(Effect.map((value) => value.automaticServerUpdates));

  const run = Effect.gen(function* () {
    if (selfUpdate.capability !== "boot-service") return yield* skipped("not-boot-service");
    if (!isPublishableCliReleaseVersion(ownVersion) || channel === "preview") {
      return yield* skipped("unpublished-or-preview-build");
    }
    const environmentId = yield* identity.getEnvironmentId;
    let pending: string | undefined;
    let nextCheck = (yield* Clock.currentTimeMillis) + ACTIVATION_INTERVAL;
    let nextActivation = nextCheck;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(
        Math.max(0, Math.min(nextCheck, pending === undefined ? nextCheck : nextActivation) - now),
      );
      const tick = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* () {
        if (!(yield* enabled)) {
          pending = undefined;
          nextCheck = tick + CHECK_INTERVAL;
          return yield* skipped("disabled");
        }
        if (yield* selfUpdate.isUpdating) {
          nextCheck = tick + CHECK_INTERVAL;
          nextActivation = tick + ACTIVATION_INTERVAL;
          return yield* skipped("update-in-flight");
        }
        if (tick >= nextCheck) {
          nextCheck = tick + CHECK_INTERVAL;
          const release = yield* resolveNewestRelease({ channel, baseDir: config.baseDir }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
          const targetVersion = release.version;
          yield* Effect.logInfo("server.auto_update.checked", { channel, targetVersion });
          if (
            !isPublishableCliReleaseVersion(targetVersion) ||
            cliReleaseChannelOf(targetVersion) !== channel
          ) {
            yield* skipped("wrong-channel-or-unpublished", targetVersion);
          } else if (compareExactServiceVersions(targetVersion, ownVersion) <= 0) {
            yield* skipped("not-newer", targetVersion);
          } else if (blocked(targetVersion)) {
            yield* skipped("previous-launcher-failure", targetVersion);
          } else if (
            !isRolloutEligible({
              channel,
              bucket: yield* rolloutBucket(environmentId, targetVersion).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
              ),
              publishedAt: release.publishedAt,
              now: tick,
            })
          ) {
            yield* skipped("rollout-not-eligible", targetVersion);
          } else if (pending !== targetVersion) {
            yield* selfUpdate.prepare(targetVersion);
            pending = targetVersion;
            nextActivation = tick;
            yield* Effect.logInfo("server.auto_update.prepared", { targetVersion });
          }
        }
        if (pending === undefined || tick < nextActivation) return;
        if (!(yield* enabled)) {
          pending = undefined;
          return yield* skipped("disabled");
        }
        if (yield* selfUpdate.isUpdating) {
          nextActivation = (yield* Clock.currentTimeMillis) + ACTIVATION_INTERVAL;
          return yield* skipped("update-in-flight", pending);
        }
        const targetVersion = pending;
        yield* selfUpdate
          .update({ targetVersion }, undefined, undefined, { kind: "auto-update" })
          .pipe(
            Effect.tap(() => Effect.logInfo("server.auto_update.requested", { targetVersion })),
            Effect.tap(() =>
              Effect.sync(() => {
                pending = undefined;
              }),
            ),
            Effect.catchTags({
              ServerSelfUpdateError: (error) => {
                if (error.reason === ServerSelfUpdate.SERVER_UPDATE_BUSY_REASON) {
                  return Clock.currentTimeMillis.pipe(
                    Effect.flatMap((now) => {
                      nextActivation = now + ACTIVATION_INTERVAL;
                      return Effect.logInfo("server.auto_update.deferred-busy", { targetVersion });
                    }),
                  );
                }
                pending = undefined;
                return Effect.logWarning("server.auto_update.failed", {
                  stage: "activation",
                  error,
                });
              },
            }),
          );
      }).pipe(Effect.catch((error) => Effect.logWarning("server.auto_update.failed", { error })));
    }
  });
  return ServerAutoUpdate.of({ run });
});

export const layer = Layer.effect(ServerAutoUpdate, make());
