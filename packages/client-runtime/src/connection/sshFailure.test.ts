import { describe, expect, it } from "@effect/vitest";

import { sshPreparationFailure } from "./sshFailure.ts";

const IPC = "Error invoking remote method 'desktop:ensure-ssh-environment': ";

describe("sshPreparationFailure", () => {
  it.each([
    "Cannot reach mbp over SSH (192.168.1.20:22: Operation timed out). Check the network or VPN connection to that host.",
    "Cannot reach mbp over SSH (could not resolve mbp.local: nodename nor servname provided, or not known). Check the network or VPN connection to that host.",
    "Cannot reach mbp over SSH (Connection timed out during banner exchange). Check the network or VPN connection to that host.",
  ])("treats a host ssh never reached as unreachable: %s", (message) => {
    const error = sshPreparationFailure(new Error(`${IPC}SshCommandError: ${message}`));
    expect(error).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "host-unreachable",
      detail: message,
    });
  });

  it("blocks a rejected login instead of retrying it on a timer", () => {
    const error = sshPreparationFailure(
      new Error(`${IPC}julius@100.65.180.100: Permission denied (publickey,password).`),
    );
    expect(error._tag).toBe("ConnectionBlockedError");
    expect(error.reason).toBe("authentication");
    expect(error.detail).toContain("Permission denied (publickey,password)");
  });

  it("blocks a host key that no longer verifies", () => {
    const error = sshPreparationFailure(
      new Error(
        "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.",
      ),
    );
    expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
    expect(error.detail).toContain("Forget the host");
  });

  it.each([
    "mbp runs a newer GOAT (0.3.0). Update this app from the update button above Settings.",
    "Live GOAT PID=812 port=3773 is incompatible; it was left running. Upgrade with the owning client or reconnect.",
    "Remote runtime GOAT 0.1.0-dev.abc cannot be ordered against this app (GOAT 0.1.0-dev.def); it was left running. Stop it on the remote host when its work is done, then reconnect.",
  ])("blocks a runtime that refuses this client without disabling it: %s", (message) => {
    // "unsupported" would switch the environment off; this needs a person instead.
    expect(sshPreparationFailure(new Error(message))).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "configuration",
      detail: message,
    });
  });

  it("keeps a cancelled password prompt blocked until the user reconnects", () => {
    expect(sshPreparationFailure(new Error("SSH password prompt cancelled."))).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
    });
  });

  it("explains a slow tunnel as high latency", () => {
    const error = sshPreparationFailure(
      new Error(
        `${IPC}The SSH tunnel is open, but the GOAT server answered none of 9 checks within 5000ms. The network to this host is too slow (high latency); GOAT will keep retrying.`,
      ),
    );
    expect(error).toMatchObject({ _tag: "ConnectionTransientError", reason: "network" });
  });

  it("retries other failures as a remote problem, without the IPC prefix", () => {
    expect(sshPreparationFailure(new Error(`${IPC}mkdir: Permission denied`))).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "remote-unavailable",
      detail: "Could not prepare the SSH environment: mkdir: Permission denied",
    });
  });
});
