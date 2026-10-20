import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each(["goat://", "goat:///", "goat-dev://", "goat-preview://"])(
    "ignores scheme-only URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );

  it.each([
    "goat://threads/env-1/thread-1",
    "goat://pair?pairingUrl=x",
    "goat-dev://settings/usage?tab=limits",
    // Another app's bare scheme is not ours to swallow.
    "t3code://",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each(["goat://expo-development-client/?url=x", "goat://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );
});
