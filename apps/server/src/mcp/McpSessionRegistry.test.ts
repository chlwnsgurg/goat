import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as MemoryFixture from "./toolkits/memory/handlers.testkit.ts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.grantedScopes).toEqual([]);
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "orchestration", "worktree", "pull-requests"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.thread.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect(
  "live authority denies epoch drift, unready policy, ended caller and revoked snapshot handles",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1000);
      let current: McpSessionRegistry.McpMemoryPolicy | undefined = {
        grant: "read_write",
        policyEpoch: 1,
      };
      let live = false;
      const issue = () =>
        registry.issue({
          threadId: ThreadId.make("thread-memory-epochs"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          grantedScopes: ["memory:read", "memory:write"],
          memoryPolicy: current!,
          readCurrentPolicy: () => Effect.sync(() => current),
          isLiveCaller: Effect.sync(() => live),
        });
      const first = yield* issue();
      const token = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const scope = yield* registry.resolve(token);
      expect(scope).toBeDefined();
      expect((yield* scope!.reauthorize!(["memory:read"]).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      live = true;
      yield* scope!.reauthorize!(["memory:read"]);
      current = undefined;
      expect(yield* registry.resolve(token)).toBeUndefined();
      expect(yield* registry.currentMemoryPolicy!(first.config.providerSessionId)).toBeUndefined();
      current = { grant: "read_write", policyEpoch: 4 };
      // The intermediate stream epochs need not be observed: the latest Ref is authoritative.
      expect(yield* registry.resolve(token)).toBeUndefined();
      expect((yield* scope!.reauthorize!(["memory:write"]).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      const last = yield* issue();
      expect(yield* registry.currentMemoryPolicy!(last.config.providerSessionId)).toEqual(current);
      yield* registry.revokeProviderSession(last.config.providerSessionId);
      expect(yield* registry.currentMemoryPolicy!(last.config.providerSessionId)).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("credential ID lookup follows refresh, thread revocation and revokeAll", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const policy = { grant: "read_write" as const, policyEpoch: 1 };
    const threadId = ThreadId.make("indexed-memory-credential");
    const issue = () =>
      registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        memoryPolicy: policy,
        readCurrentPolicy: () => Effect.succeed(policy),
        isLiveCaller: Effect.succeed(true),
      });
    const first = yield* issue();
    const token = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 100;
    expect(yield* registry.resolve(token)).toBeDefined();
    timestamp += 100;
    expect(yield* registry.currentMemoryPolicy!(first.config.providerSessionId)).toEqual(policy);
    yield* registry.touch(threadId);
    timestamp += 100;
    expect(yield* registry.currentMemoryPolicy!(first.config.providerSessionId)).toEqual(policy);
    yield* registry.revokeThread(threadId);
    expect(yield* registry.currentMemoryPolicy!(first.config.providerSessionId)).toBeUndefined();
    expect(yield* registry.resolve(token)).toBeUndefined();
    const second = yield* issue();
    expect(yield* registry.currentMemoryPolicy!(second.config.providerSessionId)).toEqual(policy);
    yield* registry.revokeAll;
    expect(yield* registry.currentMemoryPolicy!(second.config.providerSessionId)).toBeUndefined();
    expect(
      yield* registry.resolve(second.config.authorizationHeader.replace(/^Bearer\s+/, "")),
    ).toBeUndefined();
  }),
);

it.effect.each([
  "memoryPolicy",
  "readCurrentPolicy",
  "isLiveCaller",
  "all",
  "unready",
  "ended",
] as const)(
  "actual read toolkit refuses incomplete or inactive registry authority: %s",
  (missing) =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1000);
      let ready = true;
      let live = true;
      const policy = { grant: "read" as const, policyEpoch: 1 };
      const issued = yield* registry.issue({
        threadId: ThreadId.make("thread-memory-missing"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["memory"]),
        grantedScopes: ["memory:read"],
        ...(missing === "memoryPolicy" || missing === "all" ? {} : { memoryPolicy: policy }),
        ...(missing === "readCurrentPolicy" || missing === "all"
          ? {}
          : {
              readCurrentPolicy: () => Effect.sync(() => (ready ? policy : undefined)),
            }),
        ...(missing === "isLiveCaller" || missing === "all"
          ? {}
          : {
              isLiveCaller: Effect.sync(() => live),
            }),
      });
      const scope = yield* registry.resolve(
        issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      expect(scope).toBeDefined();
      if (missing === "unready") ready = false;
      if (missing === "ended") live = false;
      const result = yield* MemoryFixture.call(
        "memory_list",
        {
          memorySpaceId: MemoryFixture.space,
          includeQuarantined: false,
        },
        scope!,
      );
      expect(result.result.isError).toBe(true);
      expect(result.body).toMatchObject({ code: "unavailable" });
      if (["memoryPolicy", "readCurrentPolicy", "isLiveCaller", "all", "unready"].includes(missing))
        expect(
          yield* registry.currentMemoryPolicy!(issued.config.providerSessionId),
        ).toBeUndefined();
    }).pipe(Effect.provide(MemoryFixture.layer)),
);
