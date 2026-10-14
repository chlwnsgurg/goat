import { expect, it } from "@effect/vitest";
import { WS_METHODS } from "@goat/contracts";
import { WsRpcGroup } from "./protocol.ts";

it("activates the 14 implemented core routes and two owner administration routes", () => {
  const methods = [...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("memory."));
  expect(methods).toHaveLength(16);
  expect(methods).toContain(WS_METHODS.memoryOwnerSourceReadPolicyGet);
  expect(methods).toContain(WS_METHODS.memoryOwnerSourceReadPolicyUpdate);
  expect(methods).toContain(WS_METHODS.memoryChanges);
  expect(methods).not.toContain(WS_METHODS.memoryImportProvider);
});
