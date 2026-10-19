import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HubNodesError,
  ProviderInstanceId,
  type HubNode,
  type SavedConnection,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool } from "effect/ai";
import * as Schema from "effect/Schema";

import * as Broker from "../../../connections/ConnectionCatalogBroker.ts";
import * as HubNodes from "../../../hubNodes/HubNodes.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ConnectionToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:connections");
const threadId = ThreadId.make("thread:connections");
const node: HubNode = {
  nodeId: environmentId,
  environmentId,
  label: "Remote",
  kind: "ssh",
  status: "online",
  lastSeenAt: null,
  addedBy: null,
  routes: [
    {
      routeId: "ssh:build-host",
      source: "registered",
      target: { kind: "ssh", alias: "build-host", hostname: null, username: null, port: null },
      status: "online",
      checkedAt: null,
      lastSeenAt: null,
      lastError: null,
    },
  ],
};
const saved: SavedConnection = {
  environmentId,
  label: "Remote",
  enabled: true,
  routes: [{ kind: "ssh", host: "build-host", hostname: "build-host", username: null, port: null }],
};
const outsideCaller = (
  access: "read-only" | "full-access" | "approval-required",
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:connections",
  thread: undefined,
  client: { sessionId: "client:connections", label: "Test agent", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const threadCaller: McpInvocationContext.McpInvocationScope = {
  ...outsideCaller("full-access"),
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "provider:connections",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

const testLayer = (
  caller = outsideCaller("full-access"),
  hub: Partial<HubNodes.HubNodes["Service"]> = {},
  broker: Partial<Broker.ConnectionCatalogBroker["Service"]> = {},
) =>
  McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, caller)),
    Layer.provideMerge(liveThreadsLayer),
    Layer.provideMerge(Layer.mock(HubNodes.HubNodes)(hub)),
    Layer.provideMerge(
      Layer.mock(Broker.ConnectionCatalogBroker)({ hasHost: Effect.succeed(false), ...broker }),
    ),
  );

const call = <N extends keyof typeof ConnectionToolkit.tools>(
  name: N,
  input: Tool.Parameters<(typeof ConnectionToolkit.tools)[N]>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* ConnectionToolkit;
    const result = yield* toolkit.handle(name, input).pipe(Stream.unwrap, Stream.runCollect);
    return result.at(-1)?.result;
  });

it.effect("goat serve alone lists nodes and notices without any desktop broker host", () =>
  call("goat_connection_list", {}).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        expect(result).toEqual({
          connections: [saved],
          nodes: [node, { ...node, environmentId: null, nodeId: "route:ssh:new" }],
          notices: [{ id: "desktop-import-locked", at: "2026-10-20T00:00:00.000Z" }],
        }),
      ),
    ),
    Effect.provide(
      testLayer(
        outsideCaller("read-only"),
        {
          snapshot: Effect.succeed({
            hubEnvironmentId: environmentId,
            nodes: [node, { ...node, environmentId: null, nodeId: "route:ssh:new" }],
            notices: [{ id: "desktop-import-locked", at: "2026-10-20T00:00:00.000Z" }],
          }),
        },
        {
          hasHost: Effect.die("List consulted desktop host"),
          invoke: () => Effect.die("List reached desktop"),
        },
      ),
    ),
  ),
);

it.effect("projects SSH, linked and cloud routes without credentials", () => {
  const routes: HubNode["routes"] = [
    {
      ...node.routes[0]!,
      target: { kind: "ssh", alias: "custom", hostname: "host.test", username: "jun", port: 2222 },
    },
    {
      ...node.routes[0]!,
      routeId: "linked:test",
      source: "linked-host",
      target: {
        kind: "linked",
        name: "test",
        baseUrl: "https://host.test",
        access: "read-only",
        expiresAt: "2026-10-21T00:00:00.000Z",
      },
    },
    {
      ...node.routes[0]!,
      routeId: "cloud:boat-bx_23456789",
      source: "cloud-machine",
      target: { kind: "cloud", alias: "boat-bx_23456789" },
    },
  ];
  return call("goat_connection_list", {}).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        expect(result).toMatchObject({
          connections: [
            {
              routes: [
                { kind: "ssh", host: "custom", hostname: "host.test", username: "jun", port: 2222 },
                { kind: "direct", httpBaseUrl: "https://host.test" },
                {
                  kind: "ssh",
                  host: "boat-bx_23456789",
                  hostname: "boat-bx_23456789",
                  username: null,
                  port: null,
                },
              ],
            },
          ],
        }),
      ),
    ),
    Effect.provide(
      testLayer(undefined, {
        snapshot: Effect.succeed({
          hubEnvironmentId: environmentId,
          nodes: [{ ...node, routes }],
          notices: [],
        }),
      }),
    ),
  );
});

it.effect.each(["saved", "not_attached", "failed", "refused", "mismatched"] as const)(
  "saves through the hub with identity required, desktop result %s",
  (desktop) => {
    let persisted = false;
    return call("goat_connection_add_ssh", { host: "build-host", label: "Build" }).pipe(
      Effect.tap((result) =>
        Effect.sync(() =>
          expect(result).toEqual({
            created: true,
            node,
            connection: saved,
            desktopCatalog: desktop === "refused" || desktop === "mismatched" ? "failed" : desktop,
          }),
        ),
      ),
      Effect.provide(
        testLayer(
          threadCaller,
          {
            add: (input, options) =>
              Effect.gen(function* () {
                expect(input).toEqual({
                  kind: "ssh",
                  alias: "build-host",
                  hostname: null,
                  username: null,
                  port: null,
                  label: "Build",
                });
                expect(options.requireIdentity).toBe(true);
                expect(options.addedBy).toMatchObject({ kind: "agent", threadId });
                expect(options.addedBy.client).toBeUndefined();
                expect(options.addedBy.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
                yield* options.beforeSave;
                persisted = true;
                return { created: true, node };
              }),
          },
          {
            hasHost: Effect.succeed(desktop !== "not_attached"),
            invoke: (operation, timeoutMs) => {
              expect(persisted).toBe(true);
              expect(timeoutMs).toBe(600_000);
              expect(operation).toMatchObject({
                type: "add_ssh",
                host: "build-host",
                label: "Build",
                addedBy: { kind: "agent", threadId },
              });
              return desktop === "failed"
                ? Effect.fail(new Broker.ConnectionCatalogTimeout({ timeoutMs }))
                : Effect.succeed(
                    desktop === "refused"
                      ? { type: "failure", reason: "refused", message: "Locked" }
                      : desktop === "mismatched"
                        ? { type: "list", connections: [] }
                        : { type: "add_ssh", created: true, connection: saved },
                  );
            },
          },
        ),
      ),
    );
  },
);

it.effect("awaits the desktop answer synchronously after the hub save", () =>
  Effect.gen(function* () {
    const invoked = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    let completed = false;
    const fiber = yield* call("goat_connection_add_ssh", { host: "build-host" }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          completed = true;
        }),
      ),
      Effect.provide(
        testLayer(
          undefined,
          { add: (_input, options) => options.beforeSave.pipe(Effect.as({ created: true, node })) },
          {
            hasHost: Effect.succeed(true),
            invoke: () =>
              Deferred.succeed(invoked, undefined).pipe(
                Effect.andThen(Deferred.await(answer)),
                Effect.as({ type: "add_ssh", created: true, connection: saved }),
              ),
          },
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(invoked);
    expect(completed).toBe(false);
    yield* Deferred.succeed(answer, undefined);
    expect(yield* Fiber.join(fiber)).toMatchObject({ desktopCatalog: "saved" });
    expect(completed).toBe(true);
  }),
);

it.effect("attributes an outside client and preserves created:false", () =>
  call("goat_connection_add_ssh", { host: "build-host" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        expect(result).toMatchObject({ created: false, desktopCatalog: "not_attached" }),
      ),
    ),
    Effect.provide(
      testLayer(undefined, {
        add: (_input, options) => {
          expect(options.addedBy).toMatchObject({ kind: "agent", client: "Test agent" });
          expect(options.addedBy.threadId).toBeUndefined();
          return options.beforeSave.pipe(Effect.as({ created: false, node }));
        },
      }),
    ),
  ),
);

it.effect.each(["read-only", "approval-required"] as const)(
  "refuses writes by %s callers before hub calls",
  (access) =>
    Effect.gen(function* () {
      for (const result of [
        yield* call("goat_connection_add_ssh", { host: "build-host" }),
        yield* call("goat_connection_remove", { environmentId }),
      ]) {
        expect(result).toMatchObject({ code: "capability_denied" });
      }
    }).pipe(Effect.provide(testLayer(outsideCaller(access)))),
);

it.effect("refuses add without orchestration capability", () =>
  call("goat_connection_add_ssh", { host: "build-host" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => expect(result).toMatchObject({ code: "capability_denied" })),
    ),
    Effect.provide(testLayer({ ...outsideCaller("full-access"), capabilities: new Set() })),
  ),
);

it.effect("rechecks caller authority immediately before saving", () => {
  const caller = outsideCaller("full-access");
  return call("goat_connection_add_ssh", { host: "build-host" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => expect(result).toMatchObject({ code: "capability_denied" })),
    ),
    Effect.provide(
      testLayer(caller, {
        add: (_input, options) =>
          Effect.gen(function* () {
            Object.assign(caller.client!, { access: "read-only" });
            yield* options.beforeSave;
            return yield* Effect.die("Revoked caller saved a node");
          }),
      }),
    ),
  );
});

it.effect.each(["environmentId", "nodeId"] as const)(
  "removes using %s and forwards the identified environment",
  (key) =>
    call("goat_connection_remove", { [key]: environmentId }).pipe(
      Effect.tap((result) =>
        Effect.sync(() =>
          expect(result).toEqual({ node, removed: saved, desktopCatalog: "saved" }),
        ),
      ),
      Effect.provide(
        testLayer(
          undefined,
          {
            remove: (input) => {
              expect(input).toEqual({ nodeId: environmentId });
              return Effect.succeed({ removed: node });
            },
          },
          {
            hasHost: Effect.succeed(true),
            invoke: (operation, timeoutMs) => {
              expect(operation).toEqual({ type: "remove", environmentId });
              expect(timeoutMs).toBe(30_000);
              return Effect.succeed({ type: "remove", removed: saved });
            },
          },
        ),
      ),
    ),
);

it.effect.each(["not_attached", "failed"] as const)(
  "keeps hub removal successful when desktop is %s",
  (desktop) =>
    call("goat_connection_remove", { nodeId: environmentId }).pipe(
      Effect.tap((result) =>
        Effect.sync(() =>
          expect(result).toMatchObject({ node, removed: saved, desktopCatalog: desktop }),
        ),
      ),
      Effect.provide(
        testLayer(
          undefined,
          { remove: () => Effect.succeed({ removed: node }) },
          {
            hasHost: Effect.succeed(desktop === "failed"),
            invoke: () => Effect.fail(new Broker.ConnectionCatalogHostDetached()),
          },
        ),
      ),
    ),
);

it.effect("removes unidentified nodes without a legacy projection or desktop forward", () => {
  const unknown = { ...node, environmentId: null, nodeId: "route:ssh:build-host" };
  return call("goat_connection_remove", { nodeId: unknown.nodeId }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => expect(result).toEqual({ node: unknown, desktopCatalog: "not_attached" })),
    ),
    Effect.provide(
      testLayer(
        undefined,
        { remove: () => Effect.succeed({ removed: unknown }) },
        { hasHost: Effect.die("Unidentified remove reached desktop") },
      ),
    ),
  );
});

it.effect.each([
  "not_found",
  "invalid_request",
  "refused",
  "host_unavailable",
  "storage_failed",
] as const)("maps hub %s failures on all operations", (reason) =>
  Effect.gen(function* () {
    const failure = Effect.fail(new HubNodesError({ reason, detail: "Hub failure" }));
    yield* Effect.gen(function* () {
      for (const result of [
        yield* call("goat_connection_list", {}),
        yield* call("goat_connection_add_ssh", { host: "build-host" }),
        yield* call("goat_connection_remove", { nodeId: environmentId }),
      ]) {
        expect(result).toMatchObject({
          code:
            reason === "storage_failed"
              ? "orchestration_error"
              : reason === "host_unavailable"
                ? reason
                : "invalid_request",
          message: "Hub failure",
        });
      }
    }).pipe(
      Effect.provide(
        testLayer(undefined, { snapshot: failure, add: () => failure, remove: () => failure }),
      ),
    );
  }),
);

it("requires exactly one remove identifier", () => {
  const decode = Schema.decodeUnknownSync(
    ConnectionToolkit.tools.goat_connection_remove.parametersSchema,
  );
  expect(() => decode({})).toThrow();
  expect(() => decode({ nodeId: "node", environmentId })).toThrow();
  expect(decode({ nodeId: "node" })).toEqual({ nodeId: "node" });
  expect(decode({ environmentId })).toEqual({ environmentId });
});

it.effect("production registration refuses undeclared arguments before invoking the broker", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "goat_connection_list", arguments: { host: "wrong-machine" } })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          outsideCaller("read-only"),
        ),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: {},
            clientInfo: { name: "connections", version: "1" },
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "connections", version: "1" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject([
      { type: "text", text: expect.stringContaining("invalid_request") },
    ]);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerConnectionToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(liveThreadsLayer),
        Layer.provide(Layer.mock(HubNodes.HubNodes)({})),
        Layer.provide(
          Layer.mock(Broker.ConnectionCatalogBroker)({
            invoke: () => Effect.die("Unknown arguments reached broker"),
          }),
        ),
      ),
    ),
  ),
);

const decodeAdd = Schema.decodeUnknownSync(
  ConnectionToolkit.tools.goat_connection_add_ssh.parametersSchema,
);
it("rejects SSH aliases and labels beyond the hub contract before saving", () => {
  expect(() => decodeAdd({ host: "x".repeat(256) })).toThrow();
  expect(() => decodeAdd({ host: "build-host", label: "x".repeat(121) })).toThrow();
  expect(decodeAdd({ host: "build-host", label: "x".repeat(120) })).toHaveProperty(
    "host",
    "build-host",
  );
});
