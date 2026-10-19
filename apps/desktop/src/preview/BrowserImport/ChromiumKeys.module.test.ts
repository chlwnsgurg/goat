import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

vi.mock("@napi-rs/keyring", () => {
  throw new Error("Cannot find native binding");
});

import { ChromiumKeyError, resolveChromiumKeys } from "./ChromiumKeys.ts";

// Vitest wraps a throwing mock factory, so the binding error sits somewhere in the cause chain.
function causeMessages(cause: unknown): ReadonlyArray<string> {
  const messages: string[] = [];
  for (let current = cause; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  return messages;
}

it.effect("reports an unavailable keychain when the macOS binding cannot load", () =>
  Effect.gen(function* () {
    const error = yield* resolveChromiumKeys({
      platform: "darwin",
      keychainService: "Chrome Safe Storage",
      keychainAccount: "Chrome",
      linuxSecretApplication: undefined,
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(ChromiumKeyError);
    expect(error.reason).toBe("keychainUnavailable");
    expect(causeMessages(error.cause).join("\n")).toContain("Cannot find native binding");
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("must not spawn")),
    ),
  ),
);
