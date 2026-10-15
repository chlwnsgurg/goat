import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PreviewAutomationHistoryInput,
  PreviewAutomationReloadInput,
} from "./previewAutomation.ts";

const decodeHistory = Schema.decodeSync(PreviewAutomationHistoryInput);
const decodeReload = Schema.decodeSync(PreviewAutomationReloadInput);
const decodeUnknownReload = Schema.decodeUnknownSync(PreviewAutomationReloadInput);

it("accepts default history readiness and opt-in reload cache bypass", () => {
  expect(decodeHistory({})).toEqual({});
  expect(
    decodeReload({
      tabId: "tab-1",
      ignoreCache: true,
      readiness: "domContentLoaded",
      timeoutMs: 2_000,
    }),
  ).toEqual({
    tabId: "tab-1",
    ignoreCache: true,
    readiness: "domContentLoaded",
    timeoutMs: 2_000,
  });
});

it("rejects immediate history responses, unbounded timeouts and non-boolean cache bypass", () => {
  for (const input of [
    { readiness: "none" },
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { ignoreCache: "true" },
  ])
    expect(() => decodeUnknownReload(input)).toThrow();
});
