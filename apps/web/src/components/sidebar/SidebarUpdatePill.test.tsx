import { EnvironmentId, type DesktopUpdateState } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleSidebarUpdateReleaseNotesPopoverOpenChange,
  openSidebarUpdateReleaseNotesPopoverOnForwardTab,
  resolveSidebarUpdateHeading,
  shouldUseSidebarUpdateReleaseNotesPopover,
} from "./SidebarUpdatePill";
import type { UpdateRunMachine } from "./updateEverything.logic";

const nightlyState: DesktopUpdateState = {
  installPolicy: "restart-when-idle",
  pendingRestartReason: null,
  pendingUpdate: null,
  recoveryStatus: null,
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.36-nightly.3",
  downloadedVersion: null,
  releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Newest change"], totalItems: 1 }],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("sidebar update release notes popover", () => {
  it("uses the popover only for visible nightly release notes", () => {
    expect(shouldUseSidebarUpdateReleaseNotesPopover(true, nightlyState)).toBe(true);
    expect(shouldUseSidebarUpdateReleaseNotesPopover(false, nightlyState)).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        channel: "latest",
      }),
    ).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        releaseNotes: [],
      }),
    ).toBe(false);
  });

  it("cancels trigger presses without canceling other open reasons", () => {
    const cancelTriggerPress = vi.fn();
    const cancelHover = vi.fn();

    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-press",
      cancel: cancelTriggerPress,
    });
    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-hover",
      cancel: cancelHover,
    });

    expect(cancelTriggerPress).toHaveBeenCalledOnce();
    expect(cancelHover).not.toHaveBeenCalled();
  });

  it("promotes forward Tab without preventing native navigation", () => {
    const open = vi.fn();
    const preventDefault = vi.fn();
    const event = { key: "Tab", shiftKey: false, preventDefault };

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(event, { open }, "nightly-release-notes");

    expect(open).toHaveBeenCalledWith("nightly-release-notes");
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not promote backward Tab", () => {
    const open = vi.fn();

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(
      { key: "Tab", shiftKey: true },
      { open },
      "nightly-release-notes",
    );

    expect(open).not.toHaveBeenCalled();
  });
});
function runMachine(updatesProviders: boolean, updatesServer: boolean): UpdateRunMachine {
  const environmentId = EnvironmentId.make("environment-1");
  return {
    environmentId,
    label: "mini",
    updatesProviders,
    server: updatesServer
      ? { environmentId, serverLabel: "mini", selfUpdate: "boot-service", targetVersion: "0.0.50" }
      : null,
    handedOffVersion: null,
    startedAt: 0,
    result: null,
    failure: null,
    providerFailure: null,
  };
}

describe("sidebar update heading", () => {
  const idle = { local: false, remote: null, run: null, checking: false } as const;

  it("names this app when only its own update is waiting", () => {
    expect(resolveSidebarUpdateHeading({ ...idle, local: true })).toBe("GOAT app update");
  });

  it("names the kinds of remote work that are behind", () => {
    expect(
      resolveSidebarUpdateHeading({ ...idle, remote: { providers: true, servers: false } }),
    ).toBe("Provider updates");
    expect(
      resolveSidebarUpdateHeading({ ...idle, remote: { providers: false, servers: true } }),
    ).toBe("Server updates");
    expect(
      resolveSidebarUpdateHeading({ ...idle, remote: { providers: true, servers: true } }),
    ).toBe("Provider and server updates");
  });

  it("says everything when this app updates along with remote work", () => {
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        local: true,
        remote: { providers: true, servers: false },
      }),
    ).toBe("Update everything");
  });

  it("names a running pass from the machines it started with", () => {
    // Providers leave the candidate list once queued, so the run decides the heading.
    const remote = { providers: false, servers: false };
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        remote,
        run: { localVersion: null, machines: [runMachine(true, false)] },
      }),
    ).toBe("Updating providers");
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        run: { localVersion: null, machines: [runMachine(false, true)] },
      }),
    ).toBe("Updating servers");
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        run: { localVersion: null, machines: [runMachine(true, false), runMachine(false, true)] },
      }),
    ).toBe("Updating providers and servers");
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        local: true,
        run: { localVersion: "0.0.52", machines: [runMachine(true, false)] },
      }),
    ).toBe("Updating everything");
  });

  it("offers an app update check when nothing is waiting, including after a failed check", () => {
    expect(resolveSidebarUpdateHeading(idle)).toBe("Check for GOAT app updates");
    expect(resolveSidebarUpdateHeading({ ...idle, checking: true })).toBe(
      "Checking for GOAT app updates…",
    );
  });
});
