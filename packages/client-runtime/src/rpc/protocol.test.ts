import { expect, it } from "@effect/vitest";
import { WS_METHODS } from "@goat/contracts";
import { WsRpcGroup } from "./protocol.ts";

it("activates the 14 core, two owner administration and one import route", () => {
  const methods = [...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("memory."));
  expect(methods).toHaveLength(17);
  expect(methods).toContain(WS_METHODS.memoryOwnerSourceReadPolicyGet);
  expect(methods).toContain(WS_METHODS.memoryOwnerSourceReadPolicyUpdate);
  expect(methods).toContain(WS_METHODS.memoryChanges);
  expect(methods).toContain(WS_METHODS.memoryImportProvider);
});
