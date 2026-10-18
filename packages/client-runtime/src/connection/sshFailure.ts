import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

// Mirrors isSshAuthFailure in @goat/ssh/auth, which is Node-only.
const AUTH_FAILURE_RE =
  /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)|authentication failed|too many authentication failures/iu;
const HOST_KEY_FAILURE_RE =
  /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for \S+ has changed/iu;
// `describeSshConnectionFailure` in @goat/ssh/command: ssh never reached the host.
const UNREACHABLE_RE = /\bCannot reach .+ over SSH \(/u;
// The remote runtime refused this client and will keep refusing until someone
// updates this app or stops the remote server (see the launch script in
// @goat/ssh/tunnel). Retrying on a timer cannot fix it.
const RUNTIME_REFUSAL_RE =
  /runs a newer GOAT|Remote runtime is newer than this app|is incompatible; it was left running|cannot be ordered against this app|cannot drain for a replacement|can only be replaced by a GOAT release/u;

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
  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({ reason: "authentication", detail: message });
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
  if (UNREACHABLE_RE.test(message)) {
    return new ConnectionTransientError({ reason: "host-unreachable", detail: message });
  }
  if (AUTH_FAILURE_RE.test(message)) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: `The SSH host rejected the login. Check your SSH key or ssh-agent, then reconnect. (${message})`,
    });
  }
  if (HOST_KEY_FAILURE_RE.test(message)) {
    return new ConnectionBlockedError({
      reason: "configuration",
      detail: `SSH could not verify this host's key. Forget the host and add it again to review its fingerprint. (${message})`,
    });
  }
  if (RUNTIME_REFUSAL_RE.test(message)) {
    return new ConnectionBlockedError({ reason: "configuration", detail: message });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}
