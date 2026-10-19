import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

// Mirrors isSshAuthFailure in @goat/ssh/auth, which is Node-only, plus the
// sentence @goat/ssh/tunnel writes when a key-only (agent) login is rejected.
const AUTH_FAILURE_RE =
  /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)|authentication failed|too many authentication failures|Key-based login failed for /iu;
const HOST_KEY_FAILURE_RE =
  /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for \S+ has changed|Managed SSH host key changed|No \S+ host key is known for .+ and you have requested strict checking/iu;
// ssh never reached the host. `describeSshConnectionFailure` in @goat/ssh/command
// rewrites these as "Cannot reach …"; the tunnel step passes ssh's own stderr.
const UNREACHABLE_RE =
  /SSH connection to .+ timed out after \d+ms before authentication began|Connection closed by UNKNOWN port 65535|(?:kex_exchange_identification|ssh_exchange_identification): Connection (?:closed|reset) by remote host|(?:Dial\([^\n]+|dial tcp: lookup [^\n]+): no such host|\bCannot reach .+ over SSH \(|ssh: connect to host \S+ port \d+: |ssh: Could not resolve hostname |Connection timed out during banner exchange|Connection to \S+ port \d+ timed out/u;
// The desktop's own prompt endings (DesktopSshPasswordPrompts): dismissed,
// timed out, expired, the window closed, or the prompt service stopped; and an
// ensure superseded by a newer one. Retrying on a timer would reopen the prompt.
const CANCELLED_RE =
  /^SSH (?:authentication|connection|setup)(?: was)? cancel|^SSH authentication timed out for |^SSH password prompt (?:service stopped|expired)/iu;
// Runtime acquisition happens after SSH login. Download diagnostics can quote
// gh/network stderr inside launch wrappers; they must not read as an SSH login
// or host reachability failure.
const RUNTIME_ACQUISITION_RE =
  /Local gh (?:release download failed \(exit |SSH runtime download timed out)|Public HTTPS (?:release download|SSH runtime archive)/u;
// The remote runtime refused this client and will keep refusing until someone
// updates this app or stops the remote server (see the launch script in
// @goat/ssh/tunnel). Retrying on a timer cannot fix it.
const RUNTIME_REFUSAL_RE =
  /runs a newer GOAT|Remote runtime is newer than this app|is incompatible; it was left running|cannot be ordered against this app|cannot drain for a replacement|can only be replaced by a GOAT release|Cannot verify remote version ordering/u;

function cleanMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^(?:Ssh[A-Za-z]*Error|Error):\s*/u, "")
    .trim();
}

/**
 * Classifies a failure from preparing a desktop SSH connection. The bridge
 * carries only the message across IPC, so this reads the sentences
 * `@goat/ssh` writes.
 *
 * - An unreachable host (asleep, off the network, VPN down) is
 *   `host-unreachable`. It retries quietly on the normal backoff.
 * - Rejected credentials, an unverifiable host key, and a runtime that refuses
 *   this client are blocked. They wait for the user, a wake, or a network change
 *   instead of retrying on a timer.
 * - Anything else is a transient failure of the remote side.
 */
export function sshPreparationFailure(cause: unknown): ConnectionAttemptError {
  const message = cleanMessage(cause);
  if (CANCELLED_RE.test(message)) {
    return new ConnectionBlockedError({ reason: "authentication", detail: message });
  }
  // A proxy runs on the SSH client machine. Its actionable diagnostic must win
  // over OpenSSH's subsequent generic UNKNOWN-port closure.
  const acquisition = RUNTIME_ACQUISITION_RE.test(message);
  const proxyClosed =
    /Connection closed by UNKNOWN port 65535|(?:kex_exchange_identification|ssh_exchange_identification):/iu.test(
      message,
    );
  const tailscaleStopped =
    /failed to connect to local Tailscale(?:d| daemon)|is Tailscale running\?|tailscale(?:d)?(?: is)? (?:not running|stopped)|tailscale.*(?:state: Stopped|not connected)/iu.test(
      message,
    );
  const tailscaleLoggedOut = /tailscale.*(?:logged out|not logged in|NeedsLogin)/iu.test(message);
  const proxyMissing =
    /posix_spawn: No such file or directory/iu.test(message) ||
    (proxyClosed && /no such file or directory|command not found|not found/iu.test(message));
  const tailscaleApproval =
    /Tailscale proxy status: Machine is not yet approved by tailnet admin\./u.test(message);
  if (
    !acquisition &&
    (tailscaleStopped || tailscaleLoggedOut || tailscaleApproval || proxyMissing)
  ) {
    const fix = tailscaleLoggedOut
      ? "Sign in to Tailscale on this machine, then reconnect."
      : tailscaleApproval
        ? "Ask your Tailscale administrator to approve this machine, then reconnect."
        : tailscaleStopped
          ? "Tailscale is not running on this machine. Start Tailscale, then reconnect."
          : "The local SSH ProxyCommand could not start. Install its executable or fix its path in SSH configuration, then reconnect.";
    return new ConnectionBlockedError({ reason: "configuration", detail: `${fix} (${message})` });
  }
  if (!acquisition && HOST_KEY_FAILURE_RE.test(message)) {
    return new ConnectionBlockedError({
      reason: "configuration",
      detail: `SSH could not verify this host's key. Forget the host and add it again to review its fingerprint. (${message})`,
    });
  }
  if (!acquisition && AUTH_FAILURE_RE.test(message)) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: `The SSH host rejected the login. Check your SSH key or ssh-agent, then reconnect. (${message})`,
    });
  }
  // The tunnel opened but the server answered too late; say so instead of
  // reading like a stopped server.
  if (message.includes("(high latency)")) {
    return new ConnectionTransientError({
      reason: "network",
      detail:
        "The SSH host is reachable, but the network to it is too slow (high latency) for GOAT to finish connecting. Retrying.",
    });
  }
  if (!acquisition && UNREACHABLE_RE.test(message)) {
    return new ConnectionTransientError({ reason: "host-unreachable", detail: message });
  }
  if (RUNTIME_REFUSAL_RE.test(message)) {
    return new ConnectionBlockedError({ reason: "configuration", detail: message });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}
