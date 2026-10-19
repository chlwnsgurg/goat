import { PRODUCTION_SCHEME } from "./mobileAppIdentity.ts";

/** Query parameter of a `goat://pair` link that carries the server's pairing URL. */
export const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

/**
 * Wraps a server pairing URL in the app's `goat://pair` link for phone QR codes. Every build
 * gets the production scheme: the in-app scanner unwraps any GOAT or legacy t3code scheme, and
 * the wrapped URL keeps its token in the fragment.
 */
export function buildMobilePairingLink(pairingUrl: string): string {
  const url = new URL(`${PRODUCTION_SCHEME}://pair`);
  url.searchParams.set(MOBILE_PAIRING_URL_PARAM, pairingUrl);
  return url.toString();
}
