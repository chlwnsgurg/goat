import { describe, expect, it } from "vite-plus/test";
import { memoryToolAvailability, withAgentDeviceEnvironment } from "./mcpSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("memory tool availability", () => {
  it("fails closed for missing, cleared and unrelated grants", () => {
    for (const config of [
      undefined,
      {},
      { grantedScopes: [] },
      { grantedScopes: ["memory:write" as const] },
    ]) {
      expect(memoryToolAvailability(config)).toEqual({ read: false, write: false, source: false });
    }
  });
  it("requires independent source and write grants", () => {
    expect(memoryToolAvailability({ grantedScopes: ["memory:read"] })).toEqual({
      read: true,
      write: false,
      source: false,
    });
    expect(memoryToolAvailability({ grantedScopes: ["memory:read", "memory:write"] })).toEqual({
      read: true,
      write: true,
      source: false,
    });
    expect(
      memoryToolAvailability({ grantedScopes: ["memory:read", "orchestration:read"] }),
    ).toEqual({ read: true, write: false, source: true });
  });
});
