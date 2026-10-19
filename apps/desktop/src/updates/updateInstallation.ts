export type DesktopUpdateInstallationReason = "translocated" | "read-only-volume" | "needs-admin";

export function classifyDesktopUpdateInstallation(input: {
  readonly platform: string;
  readonly appBundlePath: string;
  readonly bundleWritable: boolean;
  readonly parentWritable: boolean;
  readonly readOnlyVolume: boolean;
}): DesktopUpdateInstallationReason | null {
  if (input.platform !== "darwin") return null;
  if (input.appBundlePath.includes("/AppTranslocation/")) return "translocated";
  if (input.readOnlyVolume) return "read-only-volume";
  if (!input.bundleWritable || !input.parentWritable) return "needs-admin";
  return null;
}

const SERVER_UPDATE_NOTICE =
  "Servers this app connects to, including this Mac's SSH runtime, can still update independently of this app.";

export function getDesktopUpdateInstallationMessage(
  reason: DesktopUpdateInstallationReason,
): string {
  switch (reason) {
    case "translocated":
      return `GOAT cannot update itself while running from App Translocation. Move GOAT to Applications and reopen it. ${SERVER_UPDATE_NOTICE}`;
    case "read-only-volume":
      return `GOAT cannot update itself on a read-only volume. Move GOAT to Applications and reopen it. ${SERVER_UPDATE_NOTICE}`;
    case "needs-admin":
      return `GOAT or its containing folder is not writable by your user. Ask an administrator to install the update or make GOAT and its containing folder writable. ${SERVER_UPDATE_NOTICE}`;
  }
}
