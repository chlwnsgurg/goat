import { describe, expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes, CLIENT_GUARDED_RPC_SCOPES } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
describe("memory client guards", () => {
  it("guards all three memory mutations", () => {
    for (const method of [
      WS_METHODS.memoryUpsert,
      WS_METHODS.memoryForget,
      WS_METHODS.memoryRevertResolution,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:write"]);
  });
  it("requires memory write and filesystem read for provider import", () =>
    expect(clientRpcRequiredScopes(WS_METHODS.memoryImportProvider, {})).toEqual([
      "memory:write",
      "filesystem:read",
    ]));
  it("guards hub settings update with settings write", () => {
    for (const method of [WS_METHODS.memoryHubSettingsGet, WS_METHODS.memoryHubSettingsUpdate])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["settings:write"]);
  });
  it("leaves existing compound guards unchanged", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.sshWorkspaceLaunch, {})).toEqual([
      "source-control:write",
      "orchestration:operate",
    ]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.gitPreparePullRequestThread, {
        mode: "worktree",
        cwd: "scratch",
        reference: "1",
        threadId: "t",
      }),
    ).toEqual(["source-control:write", "orchestration:operate"]);
  });
  it("requires explicit transcript permission for readSource and guards bindings", () => {
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.memoryReadSource)).toBe(true);
    expect(clientRpcRequiredScopes(WS_METHODS.memoryReadSource, {})).toEqual([
      "memory:read",
      "orchestration:read",
    ]);
    for (const method of [
      WS_METHODS.memoryProjectBindingGet,
      WS_METHODS.memoryProjectBindingUpdate,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:write"]);
  });
});
it("binding get and update require memory write", () => {
  for (const method of [WS_METHODS.memoryProjectBindingGet, WS_METHODS.memoryProjectBindingUpdate])
    expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:write"]);
});
it("source read needs explicit thread read", () =>
  expect(clientRpcRequiredScopes(WS_METHODS.memoryReadSource, {})).toEqual([
    "memory:read",
    "orchestration:read",
  ]));
it("memory write never implies source read", () => {
  expect(clientRpcRequiredScopes(WS_METHODS.memoryUpsert, {})).not.toContain("orchestration:read");
  expect(clientRpcRequiredScopes(WS_METHODS.memoryReadSource, {})).not.toContain("memory:write");
});

it("registers every core read and owner policy administration guard", () => {
  for (const method of [
    WS_METHODS.memorySearch,
    WS_METHODS.memoryList,
    WS_METHODS.memoryRead,
    WS_METHODS.memoryHistory,
    WS_METHODS.memoryChanges,
    WS_METHODS.memorySyncStatus,
  ]) {
    expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe("memory:read");
    expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:read"]);
  }
  for (const method of [
    WS_METHODS.memoryOwnerSourceReadPolicyGet,
    WS_METHODS.memoryOwnerSourceReadPolicyUpdate,
  ])
    expect(clientRpcRequiredScopes(method, {})).toEqual(["settings:write"]);
});

it("report retry reset is Settings-only", () =>
  expect(clientRpcRequiredScopes(WS_METHODS.memoryResetReportAttempts, {})).toEqual([
    "settings:write",
  ]));
