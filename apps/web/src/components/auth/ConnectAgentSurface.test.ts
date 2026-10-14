import { AuthMcpApprovalDecisionRequest, type AuthMcpApprovalDetails } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const calls = vi.hoisted(() => ({
  details: {} as AuthMcpApprovalDetails,
  requests: [] as Array<typeof AuthMcpApprovalDecisionRequest.Type>,
}));
vi.mock("~/environments/primary/httpClient", () => ({
  PrimaryEnvironmentHttpClient: Context.Service("test/oauth-client"),
}));
vi.mock("~/lib/runtime", async () => {
  const { PrimaryEnvironmentHttpClient } = await import("~/environments/primary/httpClient");
  const decodeDecision = Schema.decodeUnknownEffect(AuthMcpApprovalDecisionRequest);
  return {
    runPrimaryHttp: (effect: Effect.Effect<unknown, Error, never>) =>
      // eslint-disable-next-line goat/no-manual-effect-runtime-in-tests -- Mock the production Promise bridge; React drives the actual consent state machine.
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(PrimaryEnvironmentHttpClient, {
            mcpOAuth: {
              approval: () => Effect.succeed(calls.details),
              decision: ({ payload }: { payload: unknown }) =>
                decodeDecision(payload).pipe(
                  Effect.map((decoded) => {
                    calls.requests.push(decoded);
                    return { redirectTo: "https://agent.example/callback" };
                  }),
                ),
            },
          } as unknown as Context.Service.Shape<typeof PrimaryEnvironmentHttpClient>),
        ),
      ),
  };
});
vi.mock("./AuthSurfaceShell", () => ({ AuthSurfaceShell: "auth-shell" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/radio-group", () => ({ RadioGroup: "radio-group" }));
vi.mock("@base-ui/react/radio", () => ({ Radio: { Root: "radio" } }));
vi.mock("../ui/spinner", () => ({ Spinner: "spinner" }));
vi.mock("../ui/alert", () => ({ Alert: "alert", AlertDescription: "alert-description" }));

import { ConnectAgentSurface } from "./ConnectAgentSurface";

let renderer: ReactTestRenderer;
const replace = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    location: { href: "https://host/connect-agent?client_id=synthetic", replace },
  });
  calls.requests = [];
  calls.details = {
    clientName: "Synthetic agent",
    redirectHost: "agent.example",
    environmentHost: "host",
  };
  replace.mockClear();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(createElement(ConnectAgentSurface));
  });
}
async function select(index: number, checked: boolean) {
  const checkbox = renderer.root.findAllByProps({ type: "checkbox" })[index]!;
  await act(() => checkbox.props.onChange({ currentTarget: { checked } }));
}
async function pair() {
  await act(() =>
    renderer.root
      .findByProps({ id: "connect-agent-pairing-code" })
      .props.onChange({ currentTarget: { value: "synthetic-pairing-code" } }),
  );
}
async function approve() {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

describe("ConnectAgentSurface memory consent", () => {
  it.each([false, true])(
    "keeps default memory scopes empty (browser-session=%s)",
    async (browser) => {
      if (browser)
        calls.details = {
          ...calls.details,
          csrfToken: "synthetic-csrf",
          oneClickAccess: ["read-only", "full-access"],
          oneClickMemoryScopes: ["memory:read", "memory:write"],
        };
      await mount();
      await act(() =>
        renderer.root
          .findByProps({ "aria-labelledby": "connect-agent-access-label" })
          .props.onValueChange("full-access"),
      );
      expect(
        renderer.root
          .findAllByProps({ type: "checkbox" })
          .map((checkbox) => checkbox.props.checked),
      ).toEqual([false, false]);
      if (!browser) await pair();
      await approve();
      expect(calls.requests[0]?.decision).toMatchObject({
        _tag: browser ? "browser-session" : "pairing-code",
        access: "full-access",
        memoryScopes: [],
      });
      expect(replace).toHaveBeenCalledWith("https://agent.example/callback");
    },
  );
  it.each([false, true])(
    "grants only explicit final selection (browser-session=%s)",
    async (browser) => {
      if (browser)
        calls.details = {
          ...calls.details,
          csrfToken: "synthetic-csrf",
          oneClickAccess: ["read-only"],
          oneClickMemoryScopes: ["memory:read", "memory:write"],
        };
      await mount();
      await select(0, true);
      await select(1, true);
      await select(0, false);
      if (!browser) await pair();
      await approve();
      expect(calls.requests[0]?.decision).toMatchObject({
        _tag: browser ? "browser-session" : "pairing-code",
        memoryScopes: ["memory:write"],
      });
    },
  );
  it("requires pairing when any selected scope is outside the browser's full union", async () => {
    calls.details = {
      ...calls.details,
      csrfToken: "synthetic-csrf",
      oneClickAccess: ["read-only"],
      oneClickMemoryScopes: ["memory:read"],
    };
    await mount();
    await select(0, true);
    await select(1, true);
    await approve();
    expect(calls.requests).toHaveLength(0);
    await pair();
    await approve();
    expect(calls.requests[0]?.decision).toMatchObject({
      _tag: "pairing-code",
      memoryScopes: ["memory:read", "memory:write"],
    });
  });
  it("restores one-click eligibility when an ungrantable selection is cleared", async () => {
    calls.details = {
      ...calls.details,
      csrfToken: "synthetic-csrf",
      oneClickAccess: ["read-only"],
    };
    await mount();
    await select(1, true);
    expect(renderer.root.findAllByProps({ id: "connect-agent-pairing-code" })).toHaveLength(1);
    await select(1, false);
    expect(renderer.root.findAllByProps({ id: "connect-agent-pairing-code" })).toHaveLength(0);
    await approve();
    expect(calls.requests[0]?.decision).toMatchObject({
      _tag: "browser-session",
      memoryScopes: [],
    });
  });
  it("requires pairing when thread access is outside the full union even if memory scopes are held", async () => {
    calls.details = {
      ...calls.details,
      csrfToken: "synthetic-csrf",
      oneClickAccess: ["read-only"],
      oneClickMemoryScopes: ["memory:read", "memory:write"],
    };
    await mount();
    await select(0, true);
    await act(() =>
      renderer.root
        .findByProps({ "aria-labelledby": "connect-agent-access-label" })
        .props.onValueChange("full-access"),
    );
    await approve();
    expect(calls.requests).toHaveLength(0);
    await pair();
    await approve();
    expect(calls.requests[0]?.decision).toMatchObject({
      _tag: "pairing-code",
      access: "full-access",
      memoryScopes: ["memory:read"],
    });
  });
  it("denies without granting selected scopes", async () => {
    await mount();
    await select(0, true);
    await act(async () =>
      renderer.root.findByProps({ type: "button", variant: "outline" }).props.onClick(),
    );
    expect(calls.requests[0]?.decision).toEqual({ _tag: "deny" });
  });
});
