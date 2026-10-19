import { expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  handoffSummary,
  SSH_PREFLIGHT_STEP_ORDER,
  type SshPreflightReport,
  type SshHostResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Broker from "../connections/ConnectionCatalogBroker.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Setup from "./SshHostSetup.ts";
import * as DeviceAdd from "./SshDeviceAdd.ts";

const threadId = ThreadId.make("caller");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("owner"),
  requestNamespace: "test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  client: undefined,
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "provider",
  },
  grantedScopes: ["settings:write", "environment:maintain"],
  reauthorize: () => Effect.void,
};
const readyPreflight: SshPreflightReport = {
  host: "build",
  destination: { alias: "build", hostname: "build.example", user: "deploy", port: 22 },
  ready: true,
  platformKey: "linux-arm64",
  steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({ id, state: "passed", summary: `${id} passed.` })),
};
const prepared: SshHostResult = {
  kind: "ok",
  status: { host: "build", state: "preparing", runtimeVersion: null, requestedVersion: "0.1.0" },
};
const fixture = (
  options: {
    blocked?: "failed" | "needs_review";
    catalog?: "absent" | "detached" | "timeout";
    limited?: boolean;
    revoke?: boolean;
    authority?: boolean;
    typed?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let pinned = !options.typed;
    let checks = 0;
    let saves = 0;
    const report = options.blocked
      ? {
          ...readyPreflight,
          ready: false,
          steps: readyPreflight.steps.map((step) =>
            step.id === "host_key" ? { ...step, state: options.blocked! } : step,
          ),
        }
      : readyPreflight;
    const handoff = handoffSummary({
      handoffId: TurnItemId.make("approval"),
      kind: "approval",
      title: "Trust build?",
      reason: "Review key",
      requestedBy: {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        path: "ssh.host_add",
      },
      target: { environmentId: scope.environmentId, path: "ssh.host_add" },
      dedupeKey: "test",
      state: "pending",
      expiresAt: null,
      createdAt: DateTime.makeUnsafe(0),
      actor: { type: "agent", threadId },
    });
    const layer = DeviceAdd.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Sessions.SessionStore)({ cookieName: "test", legacyCookieName: undefined }),
          Layer.mock(Threads.ThreadManagementService)({
            getThreadShell: () =>
              Effect.sync(() => {
                checks++;
                return liveThreadShell(threadId, {
                  runtimeMode:
                    options.limited || (options.revoke && checks >= 2)
                      ? "approval-required"
                      : "full-access",
                });
              }),
          }),
          Layer.mock(Setup.SshHostSetup)({
            resolveDestination: (input) =>
              Effect.succeed({ input, ...(pinned ? { host: "build" } : {}) }),
            preflight: () =>
              Effect.sync(() => {
                calls.push("preflight");
                return pinned && options.typed ? readyPreflight : report;
              }),
            add: () =>
              Effect.sync(() => {
                calls.push("approval");
                return {
                  kind: "needs_human",
                  handoff,
                  next: { after: "approval", call: "goat_ssh_host_status" },
                  status: {
                    host: "build",
                    state: "untrusted",
                    runtimeVersion: null,
                    requestedVersion: "0.1.0",
                  },
                };
              }),
            prepare: () =>
              Effect.sync(() => {
                calls.push("prepare");
                return prepared;
              }),
          }),
          Layer.mock(Broker.ConnectionCatalogBroker)({
            invoke: (operation, timeout) =>
              Effect.gen(function* () {
                calls.push("broker");
                expect(operation.type).toBe("add_ssh");
                expect(timeout).toBe(600_000);
                if (options.catalog === "absent")
                  return yield* new Broker.ConnectionCatalogHostUnavailable();
                if (options.catalog === "detached")
                  return yield* new Broker.ConnectionCatalogHostDetached();
                if (options.catalog === "timeout")
                  return yield* new Broker.ConnectionCatalogTimeout({ timeoutMs: timeout });
                expect(operation).toMatchObject({ host: "build", addedBy: { threadId } });
                return {
                  type: "add_ssh",
                  created: saves++ === 0,
                  connection: {
                    environmentId: EnvironmentId.make("build"),
                    label: "Build",
                    enabled: true,
                    routes: [],
                  },
                };
              }),
          }),
        ),
      ),
    );
    const service = Context.get(yield* Layer.build(layer), DeviceAdd.SshDeviceAdd);
    const call = (callerScope = scope) =>
      service.addDevice(
        { host: "build" },
        {
          kind: "mcp",
          scope: options.authority === false ? { ...callerScope, grantedScopes: [] } : callerScope,
        },
      );
    return {
      call,
      calls,
      approve: () => {
        pinned = true;
      },
    };
  });
it.effect("failed preflight creates no handoff and never dispatches", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ blocked: "failed" });
    expect(yield* f.call()).toMatchObject({ outcome: "failed" });
    expect(f.calls).toEqual(["preflight"]);
  }),
);
it.effect("review requests approval; a repeat after pinning saves only once", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ typed: true, blocked: "needs_review" });
    expect(yield* f.call()).toMatchObject({
      outcome: "needs_human",
      next: { call: "goat_ssh_host_add", host: "build" },
    });
    expect(f.calls).toEqual(["preflight", "approval"]);
    f.approve();
    expect(yield* f.call()).toMatchObject({ outcome: "connected", created: true });
    expect(yield* f.call()).toMatchObject({ outcome: "connected", created: false });
    expect(f.calls.filter((call) => call === "prepare")).toEqual([]);
  }),
);
it.effect("an absent catalog returns the real preparation result", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ catalog: "absent" });
    expect(yield* f.call()).toMatchObject({ ...prepared, saved: false });
    expect(f.calls).toEqual(["preflight", "broker", "prepare"]);
  }),
);
it.effect.each(["detached", "timeout"] as const)(
  "a dispatched %s does not fall back or provision again",
  (catalog) =>
    Effect.gen(function* () {
      const f = yield* fixture({ catalog });
      expect(yield* f.call().pipe(Effect.flip)).toMatchObject({ code: "host_unavailable" });
      expect(f.calls).toEqual(["preflight", "broker"]);
    }),
);
it.effect("a limited caller prepares without writing the desktop catalog", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ limited: true });
    expect(yield* f.call()).toMatchObject({ ...prepared, saved: false });
    expect(f.calls).toEqual(["preflight", "prepare"]);
  }),
);
it.effect("full access revoked before dispatch stops the catalog write", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ revoke: true });
    expect(yield* f.call().pipe(Effect.flip)).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(f.calls).toEqual(["preflight"]);
  }),
);
it.effect("missing settings authority stops before preflight", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ authority: false });
    expect(yield* f.call().pipe(Effect.flip)).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(f.calls).toEqual([]);
  }),
);
it.effect("outside-thread callers get the Settings instruction", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      yield* f.call({
        ...scope,
        thread: undefined,
        client: { sessionId: "client", label: "Client", access: "full-access" },
      }),
    ).toMatchObject({
      saved: false,
      kind: "error",
      message: "Add this host in Settings → Connections.",
    });
    expect(f.calls).toEqual([]);
  }),
);

const isAddInput = Schema.is(DeviceAdd.SshDeviceAddInput);
it.each([
  { input: { host: "build" }, accepted: true },
  { input: { address: "deploy@build.example:2222" }, accepted: true },
  { input: {}, accepted: false },
  { input: { host: "build", address: "build.example" }, accepted: false },
])("requires exactly one host or address: $input", ({ input, accepted }) => {
  expect(isAddInput(input)).toBe(accepted);
});
