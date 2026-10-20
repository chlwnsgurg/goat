import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ConnectionBlockedError, ConnectionTransientError } from "@goat/client-runtime/connection";

import {
  desktopOwnsSshHostConfig,
  networkPathChangesFrom,
  readDesktopSshRuntime,
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  isRejectedBootstrapCredentialError,
  isRejectedSecondaryBootstrap,
  nextRejectedSecondaryBootstrap,
  primaryRegistrationToRetainAfterTopologyRead,
  prepareDesktopSshEnvironment,
  provisionDesktopSshEnvironment,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
  secondsUntil,
  type SshPairingGrants,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

function makeBridge(
  calls: string[],
  options?: {
    readonly failDescriptor?: boolean;
    readonly savedTokenRejected?: boolean;
    readonly savedTokenPermissions?: ReadonlyArray<string>;
    readonly instanceId?: string;
    readonly pairedScopes?: ReadonlyArray<string>;
    readonly resolvedTarget?: DesktopSshEnvironmentTarget;
  },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (
      target: DesktopSshEnvironmentTarget,
      ensureOptions?: { issuePairingToken?: boolean },
    ) => {
      calls.push("ensure");
      return {
        target: options?.resolvedTarget ?? target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: ensureOptions?.issuePairingToken === true ? "pairing-token" : null,
      };
    },
    fetchSshSessionState: async () => {
      calls.push("session");
      return {
        authenticated: options?.savedTokenRejected !== true,
        permissions: options?.savedTokenPermissions ?? AuthStandardClientScopes,
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        ...(options?.instanceId === undefined ? {} : { instanceId: options.instanceId }),
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: (options?.pairedScopes ?? AuthStandardClientScopes).join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

// What a runtime from before access and relay management joined the standard scopes grants.
const OLDER_RUNTIME_SCOPES = AuthStandardClientScopes.filter(
  (scope) => !["access:read", "access:write", "relay:write"].includes(scope),
);

describe("desktop SSH pairing", () => {
  it.effect("forwards key-only authentication to the desktop bridge", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const bridge = makeBridge(calls);
      const ensure = bridge.ensureSshEnvironment;
      let received: Parameters<DesktopBridge["ensureSshEnvironment"]>[1];
      bridge.ensureSshEnvironment = (target, options) => {
        received = options;
        return ensure(target, options);
      };
      yield* provisionDesktopSshEnvironment(bridge, TARGET, undefined, { keyOnly: true });
      expect(received).toEqual({ issuePairingToken: true, keyOnly: true });
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const provisioned = yield* provisionDesktopSshEnvironment(makeBridge(calls), TARGET);

      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when adding a route to a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls),
        TARGET,
        EnvironmentId.make("some-other-machine"),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(error.message).toContain("a different machine");
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failDescriptor: true }),
        TARGET,
      ).pipe(Effect.flip);

      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect.each([undefined, "saved-token"])(
    "reports SSH answering before preparation completes (%s)",
    (bearerToken) =>
      Effect.gen(function* () {
        const answered = yield* Deferred.make<void>();
        let reply: (() => void) | undefined;
        let finish: (() => void) | undefined;
        const ensureStarted = yield* Deferred.make<void>();
        const calls: string[] = [];
        const base = makeBridge(calls);
        const bridge: DesktopBridge = {
          ...base,
          supportsSshEnvironmentProgress: true,
          ensureSshEnvironment: (target, options) =>
            new Promise((resolve) => {
              reply = options?.onHostAnswered;
              finish = () => {
                void base.ensureSshEnvironment(target, options).then(resolve);
              };
              Deferred.doneUnsafe(ensureStarted, Effect.void);
            }),
        };
        const fiber = yield* prepareDesktopSshEnvironment(bridge, {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          ...(bearerToken === undefined ? {} : { bearerToken }),
          onHostAnswered: Deferred.succeed(answered, undefined),
        }).pipe(Effect.forkChild);
        yield* Deferred.await(ensureStarted);
        expect(reply).toBeDefined();
        reply!();
        yield* Deferred.await(answered);
        expect(calls).toEqual([]);
        finish!();
        yield* Fiber.join(fiber);
        expect(calls[0]).toBe("ensure");
      }),
  );

  it.effect.each([undefined, "saved-token"])(
    "keeps options serializable for an older preload (%s)",
    (bearerToken) =>
      Effect.gen(function* () {
        const base = makeBridge([]);
        const bridge: DesktopBridge = {
          ...base,
          ensureSshEnvironment: (target, options) => {
            structuredClone(options);
            return base.ensureSshEnvironment(target, options);
          },
        };
        const prepared = yield* prepareDesktopSshEnvironment(bridge, {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          ...(bearerToken === undefined ? {} : { bearerToken }),
          onHostAnswered: Effect.die("An older preload must not receive a callback."),
        });
        expect(prepared.bootstrap.target).toEqual(TARGET);
      }),
  );

  it.effect("reconnects with the saved token while it holds every standard scope", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const prepared = yield* prepareDesktopSshEnvironment(makeBridge(calls), {
        target: TARGET,
        expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
        bearerToken: "saved-token",
      });

      expect(prepared.bearerToken).toBe("saved-token");
      expect(prepared.verifiedEndpoint).toMatchObject({
        httpBaseUrl: prepared.bootstrap.httpBaseUrl,
        descriptor: { environmentId: EnvironmentId.make("environment-ssh") },
      });
      expect(calls).toEqual(["ensure", "descriptor", "session"]);
    }),
  );

  it.effect("pairs again when the host no longer accepts the saved token", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const prepared = yield* prepareDesktopSshEnvironment(
        makeBridge(calls, { savedTokenRejected: true }),
        {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          bearerToken: "saved-token",
        },
      );

      expect(prepared.bearerToken).toBe("bearer-token");
      expect(calls).toEqual(["ensure", "descriptor", "session", "ensure", "descriptor", "token"]);
    }),
  );

  it.effect("pairs again when the saved token predates a standard scope", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const prepared = yield* prepareDesktopSshEnvironment(
        makeBridge(calls, {
          savedTokenPermissions: ["orchestration:read", "orchestration:operate"],
        }),
        {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          bearerToken: "saved-token",
        },
      );

      expect(prepared.bearerToken).toBe("bearer-token");
      expect(calls).toEqual(["ensure", "descriptor", "session", "ensure", "descriptor", "token"]);
    }),
  );

  it.effect("stops before sending the saved token or pairing on a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* prepareDesktopSshEnvironment(makeBridge(calls), {
        target: TARGET,
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
        bearerToken: "saved-token",
      }).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(error.message).toContain("a different machine");
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  describe("on a runtime older than this app's standard scopes", () => {
    const reconnect = (
      grants: SshPairingGrants,
      bridge: Parameters<typeof makeBridge>[1],
      bearerToken: string,
      target: DesktopSshEnvironmentTarget = TARGET,
    ) =>
      Effect.suspend(() => {
        const calls: string[] = [];
        return prepareDesktopSshEnvironment(
          makeBridge(calls, bridge),
          {
            target,
            expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
            bearerToken,
          },
          undefined,
          grants,
        ).pipe(Effect.map((prepared) => ({ ...prepared, calls })));
      });
    const older = {
      instanceId: "server-start-1",
      pairedScopes: OLDER_RUNTIME_SCOPES,
      savedTokenPermissions: OLDER_RUNTIME_SCOPES,
    };

    it.effect("pairs once, then reuses the token that pairing issued", () =>
      Effect.gen(function* () {
        const grants: SshPairingGrants = new Map();

        const first = yield* reconnect(grants, older, "token-from-an-earlier-launch");
        expect(first.bearerToken).toBe("bearer-token");
        expect(first.calls).toContain("token");

        const second = yield* reconnect(grants, older, first.bearerToken);
        expect(second.bearerToken).toBe("bearer-token");
        expect(second.calls).toEqual(["ensure", "descriptor", "session"]);
      }),
    );

    it.effect("pairs again once the host's server restarted or was upgraded", () =>
      Effect.gen(function* () {
        const grants: SshPairingGrants = new Map();
        yield* reconnect(grants, older, "token-from-an-earlier-launch");

        const upgraded = yield* reconnect(
          grants,
          { ...older, instanceId: "server-start-2" },
          "bearer-token",
        );
        expect(upgraded.calls).toContain("token");
      }),
    );

    it.effect("finds the record under the target the saved profile keeps after resolution", () =>
      Effect.gen(function* () {
        const grants: SshPairingGrants = new Map();
        const typed = { ...TARGET, hostname: "devbox", username: null, port: null };
        yield* reconnect(
          grants,
          { ...older, resolvedTarget: TARGET },
          "token-from-an-earlier-launch",
          typed,
        );

        const saved = yield* reconnect(grants, older, "bearer-token", TARGET);
        expect(saved.calls).toEqual(["ensure", "descriptor", "session"]);
      }),
    );

    it.effect("never accepts any token when a pairing granted no standard scope", () =>
      Effect.gen(function* () {
        const grants: SshPairingGrants = new Map();
        const odd = { ...older, pairedScopes: ["memory:sync"], savedTokenPermissions: [] };
        yield* reconnect(grants, odd, "token-from-an-earlier-launch");

        const again = yield* reconnect(grants, odd, "bearer-token");
        expect(again.calls).toContain("token");
      }),
    );

    it.effect("keeps another SSH host claiming this environment from lowering the bar", () =>
      Effect.gen(function* () {
        const grants: SshPairingGrants = new Map();
        yield* reconnect(grants, older, "token-from-an-earlier-launch", {
          ...TARGET,
          alias: "impostor",
          hostname: "impostor.example.test",
        });

        const genuine = yield* reconnect(grants, older, "bearer-token");
        expect(genuine.calls).toContain("token");
      }),
    );

    it.effect("pairs again when the host revoked or expired the token", () =>
      Effect.gen(function* () {
        const grants: SshPairingGrants = new Map();
        yield* reconnect(grants, older, "token-from-an-earlier-launch");

        const rejected = yield* reconnect(
          grants,
          { ...older, savedTokenRejected: true },
          "bearer-token",
        );
        expect(rejected.calls).toContain("token");
      }),
    );

    it.effect("pairs again when the token lacks a scope this runtime's pairing granted", () =>
      Effect.gen(function* () {
        const grants: SshPairingGrants = new Map();
        yield* reconnect(grants, older, "token-from-an-earlier-launch");

        const narrower = yield* reconnect(
          grants,
          { ...older, savedTokenPermissions: ["orchestration:read"] },
          "bearer-token",
        );
        expect(narrower.calls).toContain("token");
      }),
    );

    it.effect("requires every standard scope when the server names no instance", () =>
      Effect.gen(function* () {
        const grants: SshPairingGrants = new Map();
        const unnamed = {
          pairedScopes: OLDER_RUNTIME_SCOPES,
          savedTokenPermissions: OLDER_RUNTIME_SCOPES,
        };
        yield* reconnect(grants, unnamed, "token-from-an-earlier-launch");

        const again = yield* reconnect(grants, unnamed, "bearer-token");
        expect(again.calls).toContain("token");
        expect(grants.size).toBe(0);
      }),
    );
  });
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("caches a desktop-issued bearer until just before its own expiry", () => {
    const now = Date.parse("2026-10-12T10:00:00.000Z");
    const expiresIn = secondsUntil("2026-10-12T10:01:00.000Z", now);
    expect(expiresIn).toBe(60);
    expect(secondaryBearerRefreshAtEpochMs(now, expiresIn)).toBe(now + 55_000);
    // An unreadable or past expiry is never cached, so the next poll asks again.
    expect(secondsUntil(undefined, now)).toBe(0);
    expect(secondsUntil("not a date", now)).toBe(0);
    expect(secondsUntil("2026-10-12T09:00:00.000Z", now)).toBe(0);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("rejected desktop-local bootstrap tokens", () => {
  it("backs off on a rejected signature and retries it on a growing, capped delay", () => {
    const signature = "http://a|ws://a|old-token";
    const first = nextRejectedSecondaryBootstrap(undefined, signature, 0);

    expect(isRejectedSecondaryBootstrap(first, signature, 59_999)).toBe(true);
    expect(isRejectedSecondaryBootstrap(first, signature, 60_000)).toBe(false);

    const second = nextRejectedSecondaryBootstrap(first, signature, 60_000);
    expect(second.retryAtEpochMs).toBe(180_000);

    let backoff = second;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      backoff = nextRejectedSecondaryBootstrap(backoff, signature, 0);
    }
    expect(backoff.delayMs).toBe(30 * 60_000);
  });

  it("retries at once when the token or endpoint changes", () => {
    const rejected = nextRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 0);

    expect(isRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(rejected, "http://b|ws://b|old-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 1)).toBe(false);
    expect(nextRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1).delayMs).toBe(
      60_000,
    );
  });

  it("treats only authentication rejections as a dead credential", () => {
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionBlockedError({ reason: "authentication", detail: "invalid" }),
      ),
    ).toBe(true);
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionTransientError({ reason: "endpoint-unavailable", detail: "booting" }),
      ),
    ).toBe(false);
  });
});

describe("desktop-local bearer cache across token changes", () => {
  it("keeps a live bearer when only the bootstrap token rotates", () => {
    const cached = {
      signature: "http://a|ws://a",
      registration: {} as never,
      expiresAtEpochMs: 20_000,
      refreshAtEpochMs: 15_000,
    };

    expect(canReuseCachedPlatformRegistration(cached, "http://a|ws://a", 10_000)).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, "http://a|ws://a", 16_000),
    ).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, "http://b|ws://b", 10_000)).toBe(false);
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});

describe("cloud machine SSH preflight", () => {
  const CLOUD: DesktopSshEnvironmentTarget = {
    alias: "boat-bx_23456789",
    hostname: "203.0.113.10",
    username: "user",
    port: 22,
  };
  const ready = (calls: string[], failure?: ConnectionBlockedError) => (alias: string) =>
    Effect.sync(() => void calls.push(`ready:${alias}`)).pipe(
      Effect.andThen(failure === undefined ? Effect.void : Effect.fail(failure)),
    );
  const prepareInput = (target: DesktopSshEnvironmentTarget) => ({
    target,
    expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
  });

  it.effect("readies a cloud machine through its server before the desktop dials it", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* provisionDesktopSshEnvironment(
        makeBridge(calls),
        CLOUD,
        undefined,
        undefined,
        ready(calls),
      );
      yield* prepareDesktopSshEnvironment(makeBridge(calls), prepareInput(CLOUD), ready(calls));
      expect(calls).toEqual([
        "ready:boat-bx_23456789",
        "ensure",
        "descriptor",
        "token",
        "ready:boat-bx_23456789",
        "ensure",
        "descriptor",
        "token",
      ]);
    }),
  );

  it.effect("never dials a cloud machine its server could not ready", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const stopped = new ConnectionBlockedError({ reason: "configuration", detail: "stopped" });
      const error = yield* prepareDesktopSshEnvironment(
        makeBridge(calls),
        prepareInput(CLOUD),
        ready(calls, stopped),
      ).pipe(Effect.flip);
      expect(error).toBe(stopped);
      expect(calls).toEqual(["ready:boat-bx_23456789"]);
    }),
  );

  it.effect("leaves ordinary SSH hosts alone", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* prepareDesktopSshEnvironment(makeBridge(calls), prepareInput(TARGET), ready(calls));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );
});

describe("managed SSH host trust boundary", () => {
  it("only allows the native primary backend belonging to this Desktop", () => {
    const primary = {
      id: PRIMARY_LOCAL_ENVIRONMENT_ID,
      label: "This machine",
      httpBaseUrl: "http://127.0.0.1:3000",
      wsBaseUrl: "ws://127.0.0.1:3000",
      bootstrapToken: "local-bootstrap",
    };
    const bridge = { getLocalEnvironmentBootstraps: () => [primary] };
    expect(desktopOwnsSshHostConfig(bridge, primary.httpBaseUrl)).toBe(true);
    expect(desktopOwnsSshHostConfig(undefined, primary.httpBaseUrl)).toBe(false);
    expect(desktopOwnsSshHostConfig(bridge, "https://remote.test")).toBe(false);
    expect(
      desktopOwnsSshHostConfig(
        { getLocalEnvironmentBootstraps: () => [{ ...primary, runningDistro: "Ubuntu" }] },
        primary.httpBaseUrl,
      ),
    ).toBe(false);
    expect(
      desktopOwnsSshHostConfig(
        { getLocalEnvironmentBootstraps: () => [{ ...primary, bootstrapToken: "" }] },
        primary.httpBaseUrl,
      ),
    ).toBe(false);
  });
  it.effect(
    "enforces key-only for managed hosts even when a caller requests password prompts",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const bridge = makeBridge(calls);
        const ensure = bridge.ensureSshEnvironment;
        let options: Parameters<DesktopBridge["ensureSshEnvironment"]>[1];
        bridge.ensureSshEnvironment = (target, input) => {
          options = input;
          return ensure(target, input);
        };
        yield* provisionDesktopSshEnvironment(bridge, { ...TARGET, alias: "goat-box" }, undefined, {
          keyOnly: false,
        });
        expect(options).toEqual({ issuePairingToken: true, keyOnly: true });
      }),
  );
  it.effect.each(["2001:db8::1", "host-" + "a".repeat(100)])(
    "decodes the Desktop owner's unrestricted hostname %s",
    (hostname) =>
      Effect.gen(function* () {
        const status = {
          host: hostname,
          state: "auth_failed" as const,
          runtimeVersion: null,
          requestedVersion: "0.4.2",
          publicKey: "ssh-ed25519 public-test-key",
        };
        const result = yield* readDesktopSshRuntime(
          {
            getSshHostStatus: async () => ({ kind: "ok", status }),
            updateSshRuntime: async () => ({ kind: "ok", status }),
          },
          { ...TARGET, hostname, alias: hostname },
        );
        if (result.kind !== "ok") throw new Error("Expected decoded owner status");
        expect(result.status.host).toBe(hostname);
        expect(result.status.publicKey).toBe(status.publicKey);
      }),
  );
  it.effect("rejects malformed IPC success envelopes with a useful retry instruction", () =>
    Effect.gen(function* () {
      const malformed = {
        getSshHostStatus: async () => ({ kind: "ok", status: { host: "box", state: "preparing" } }),
      } as unknown as Pick<DesktopBridge, "getSshHostStatus" | "updateSshRuntime">;
      expect(yield* readDesktopSshRuntime(malformed, TARGET)).toEqual({
        kind: "error",
        code: "operation_failed",
        message: "Could not read or update GOAT on devbox. Try again.",
        fix: { actor: "human", instruction: "Try again" },
      });
    }),
  );
});

describe("networkPathChangesFrom", () => {
  it.effect.each(["wifi", undefined])(
    "tracks interface switches and drop-reconnect with initial type %s",
    (initialType) =>
      Effect.gen(function* () {
        let currentType: string | undefined = initialType;
        const target = new EventTarget();
        const connection = Object.defineProperty(target, "type", {
          get: () => currentType,
        }) as EventTarget & { readonly type?: string };
        const seen: Array<"network-changed"> = [];
        const fiber = yield* networkPathChangesFrom(() => connection).pipe(
          Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
          Effect.forkChild,
        );
        yield* TestClock.adjust(0);

        // An initially unavailable type must still install the listener.
        currentType = "wifi";
        target.dispatchEvent(new Event("change"));
        // Same-type estimate updates do not count as a path change.
        target.dispatchEvent(new Event("change"));
        yield* TestClock.adjust(0);
        expect(seen).toEqual([]);

        // Wi-Fi -> Ethernet switch emits once.
        currentType = "ethernet";
        target.dispatchEvent(new Event("change"));
        yield* TestClock.adjust(0);
        expect(seen).toEqual(["network-changed"]);

        // Dropping to none/undefined and reconnecting to the same interface emits once on return.
        currentType = "none";
        target.dispatchEvent(new Event("change"));
        currentType = "unknown";
        target.dispatchEvent(new Event("change"));
        currentType = undefined;
        target.dispatchEvent(new Event("change"));
        yield* TestClock.adjust(0);
        expect(seen).toEqual(["network-changed"]);

        currentType = "ethernet";
        target.dispatchEvent(new Event("change"));
        yield* TestClock.adjust(0);
        expect(seen).toEqual(["network-changed", "network-changed"]);

        yield* Fiber.interrupt(fiber);
        currentType = "wifi";
        target.dispatchEvent(new Event("change"));
        expect(seen).toHaveLength(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );
});
