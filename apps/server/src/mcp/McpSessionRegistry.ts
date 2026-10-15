import {
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
  type MemoryTaskGrantCeiling,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";

export interface McpMemoryPolicy {
  readonly grant: MemoryTaskGrantCeiling;
  readonly policyEpoch: number;
}

export interface McpCredentialRequest {
  readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly memoryPolicy?: McpMemoryPolicy;
  /** Reads only committed authority; never SQL or a settings lock. */
  readonly readCurrentPolicy?: () => Effect.Effect<McpMemoryPolicy | undefined>;
  readonly isLiveCaller?: Effect.Effect<boolean>;
  readonly readOnly?: boolean;

  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /**
   * When false, the credential is minted without the "preview" capability so
   * the user's choice to withhold agent browser access holds everywhere the
   * token is honored (#7083). Defaults to full access.
   */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig & {
    readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope>;
  };
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  /** SQL-free snapshot policy for an issued credential; stale handles deny. */
  readonly currentMemoryPolicy?: (
    providerSessionId: string,
  ) => Effect.Effect<McpMemoryPolicy | undefined>;
  /**
   * Records a sign of life for every credential bound to `threadId`. Provider
   * turns call this so that a session which is plainly alive keeps its
   * credential even when it goes a long time without touching an MCP tool.
   */
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("goat/mcp/McpSessionRegistry") {}

/** Registry credentials always belong to a provider session, so their scope has a thread. */
interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAliveAt: number;
  readonly memoryPolicy: McpMemoryPolicy | undefined;
  readonly readCurrentPolicy: (() => Effect.Effect<McpMemoryPolicy | undefined>) | undefined;
  readonly isLiveCaller: Effect.Effect<boolean> | undefined;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
  readonly recordsById: ReadonlyMap<string, CredentialRecord>;
}

// Both keys reference the same records and are published together, including
// after refresh, prune and revoke. No independent liveness state is retained.
const registryState = (records: ReadonlyMap<string, CredentialRecord>): RegistryState => ({
  records,
  recordsById: new Map(
    Array.from(records.values(), (record) => [record.scope.thread.providerSessionId, record]),
  ),
});

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * How long a credential outlives the last sign of life from its provider
 * session.
 *
 * Liveness is refreshed both by MCP traffic and by `touch` on every provider
 * turn, so a session that is still doing work never expires no matter how long
 * it goes between browser tool calls. This window therefore only bounds
 * credentials whose session died without a clean stop — the normal paths
 * (`stopSession`, `stopAll`) revoke eagerly and do not wait for it.
 *
 * The bound matters because `/mcp` is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the `goat` toolkits on a remote-reachable server.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

// A wildcard bind is reachable on loopback, which is where the provider
// subprocesses run; anything else is announced as the address it bound.
const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make(registryState(new Map()));
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) => timestamp - record.lastAliveAt <= livenessWindowMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const browserToolsAvailable = request.browserToolsAvailable ?? true;
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        ...(request.grantedScopes === undefined
          ? {}
          : { grantedScopes: [...request.grantedScopes] }),
        ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
        ...(request.memoryPolicy === undefined ? {} : { memoryPolicy: request.memoryPolicy }),
        reauthorize: (required) =>
          Effect.gen(function* () {
            const resolved = yield* resolveHash(tokenHash);
            if (
              !resolved ||
              (required.some((scope) => scope === "memory:read" || scope === "memory:write") &&
                (!request.memoryPolicy ||
                  !request.readCurrentPolicy ||
                  !request.isLiveCaller ||
                  request.memoryPolicy.grant === "none" ||
                  (required.includes("memory:write") &&
                    request.memoryPolicy.grant !== "read_write"))) ||
              (request.isLiveCaller && !(yield* request.isLiveCaller)) ||
              required.some((scope) => !resolved.grantedScopes?.includes(scope)) ||
              (request.readOnly && required.includes("memory:write"))
            )
              return yield* new EnvironmentAuthorizationError({
                message: "The provider credential no longer grants this operation.",
                requiredScope:
                  required.find((scope) => !resolved?.grantedScopes?.includes(scope)) ??
                  required[0] ??
                  "memory:read",
              });
          }),
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "orchestration",
          "worktree",
          "pull-requests",
          ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
        ]),
        issuedAt,
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(pruneDead(records, issuedAt));
        next.set(tokenHash, {
          tokenHash,
          scope,
          lastAliveAt: issuedAt,
          memoryPolicy: request.memoryPolicy,
          readCurrentPolicy: request.readCurrentPolicy,
          isLiveCaller: request.isLiveCaller,
        });
        return registryState(next);
      });
      return {
        config: {
          environmentId,
          grantedScopes: [...(request.grantedScopes ?? [])],
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
        },
      };
    },
  );

  const resolveHash = Effect.fn("McpSessionRegistry.resolveHash")(function* (
    tokenHash: string,
  ): Effect.fn.Return<McpInvocationContext.McpThreadInvocationScope | undefined> {
    const timestamp = yield* currentTimeMillis;
    const record = (yield* SynchronizedRef.get(state)).records.get(tokenHash);
    if (record?.readCurrentPolicy && record.memoryPolicy) {
      const current = yield* record.readCurrentPolicy();
      if (
        !current ||
        current.policyEpoch !== record.memoryPolicy?.policyEpoch ||
        current.grant !== record.memoryPolicy.grant
      )
        return undefined;
    }
    return yield* SynchronizedRef.modify(state, ({ records }) => {
      const current = pruneDead(records, timestamp);
      const record = current.get(tokenHash);
      if (!record) return [undefined, registryState(current)] as const;
      const next = new Map(current);
      next.set(tokenHash, { ...record, lastAliveAt: timestamp });
      return [record.scope, registryState(next)] as const;
    });
  });

  const resolve: McpSessionRegistryShape["resolve"] = (rawToken) =>
    rawToken.length === 0
      ? Effect.undefined
      : hashToken(rawToken).pipe(Effect.flatMap(resolveHash));

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const current = pruneDead(records, timestamp);
        const next = new Map(current);
        for (const [tokenHash, record] of current) {
          if (record.scope.thread.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return registryState(next);
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) =>
      registryState(new Map(Array.from(records).filter(([, record]) => !predicate(record)))),
    );

  return McpSessionRegistry.of({
    issue,
    resolve,
    currentMemoryPolicy: (providerSessionId) =>
      Effect.gen(function* () {
        const record = (yield* SynchronizedRef.get(state)).recordsById.get(providerSessionId);
        if (!record?.readCurrentPolicy || !record.memoryPolicy || !record.isLiveCaller)
          return undefined;
        if ((yield* currentTimeMillis) - record.lastAliveAt > livenessWindowMs) return undefined;
        const current = yield* record.readCurrentPolicy();
        const latest = (yield* SynchronizedRef.get(state)).records.get(record.tokenHash);
        return latest === record &&
          current?.policyEpoch === record.memoryPolicy.policyEpoch &&
          current.grant === record.memoryPolicy.grant
          ? current
          : undefined;
      }),
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread.threadId === threadId);
    }),
    revokeAll: SynchronizedRef.set(state, registryState(new Map())),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.undefined;

/**
 * Refreshes the liveness of a thread's MCP credential. Called on every provider
 * turn so an active session is never mistaken for an abandoned one.
 */
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
