import { describe, expect, it } from "vite-plus/test";

import { buildMobilePairingLink, MOBILE_PAIRING_URL_PARAM } from "./mobilePairingLink.ts";

describe("buildMobilePairingLink", () => {
  it("wraps the pairing URL, fragment token included, in a goat://pair link", () => {
    const pairingUrl = "https://hub.tail1234.ts.net/pair#token=abc+def/1";
    const link = buildMobilePairingLink(pairingUrl);

    expect(link.startsWith("goat://pair?")).toBe(true);
    expect(new URL(link).hash).toBe("");
    expect(new URL(link).searchParams.get(MOBILE_PAIRING_URL_PARAM)).toBe(pairingUrl);
  });
});
