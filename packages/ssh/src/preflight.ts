import {
  SSH_PREFLIGHT_STEP_ORDER,
  buildSshKeyAuthInstructions,
  SshHostProbeError,
  type SshPreflightInput,
  type SshPreflightReport,
  type SshPreflightStep,
} from "@goat/contracts";
import { cliArchivePlatformKey } from "@goat/shared/cliRelease";
import { parseSshDestination } from "@goat/shared/sshDestination";
import { sshFailureDiagnostic, sshLocalProxyFailure } from "@goat/shared/sshFailure";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveSshCommand } from "./command.ts";
import { probeHostKey } from "./hostKey.ts";
import { runPreflightProcess } from "./preflightProcess.ts";
import { checkRuntimeAvailability } from "./runtimeAvailability.ts";
import type { RemoteGoatRunnerOptions } from "./tunnel.ts";

const FACTS = String.raw`printf 'GOAT_OS=%s\n' "$(uname -s)"
printf 'GOAT_ARCH=%s\n' "$(uname -m)"
df -Pk "$HOME" | awk 'END { print "GOAT_FREE_KIB=" $4 }'
for dir in "$HOME"/.goat/runtime/goat/versions/*; do
  [ -d "$dir" ] && [ -x "$dir/goat" ] && [ "$(cat "$dir/.install-complete" 2>/dev/null)" = "$(basename "$dir")" ] && printf 'GOAT_INSTALLED=%s\n' "$(basename "$dir")"
done
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    command -v cygpath >/dev/null 2>&1 && printf 'GOAT_CYGPATH=yes\n'
    root="$(cygpath -u "$SystemRoot" 2>/dev/null)"
    [ -x "$root/System32/tar.exe" ] && printf 'GOAT_SYSTEM_TAR=yes\n'
    ;;
esac
printf 'GOAT_FACTS_DONE=yes\n'
`;
const commonArgs = [
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "BatchMode=yes",
  "-o",
  "LogLevel=VERBOSE",
  "-o",
  "ConnectTimeout=10",
];
const methodList = (stderr: string) => {
  const denied = [...stderr.matchAll(/Permission denied\s*\(([^)]+)\)/giu)].at(-1)?.[1];
  return (
    denied ??
    [...stderr.matchAll(/Authentications that can continue:\s*([a-z0-9,-]+)/giu)].at(-1)?.[1] ??
    ""
  );
};
const safeLine = (text: string) =>
  text
    // SSH and local proxy stderr can contain terminal escape sequences.
    // oxlint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.slice(0, 1000) ?? "SSH command failed.";
const tailscaleHost = (hostname: string) =>
  /\.ts\.net$/iu.test(hostname) ||
  (!hostname.includes(".") && !hostname.includes(":")) ||
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(hostname);

export const runSshPreflight = Effect.fn("ssh/preflight.run")(function* (
  input: SshPreflightInput,
  options: {
    readonly ownerLabel: string;
    readonly runner: RemoteGoatRunnerOptions;
    readonly alias?: string;
  },
) {
  const parsed = parseSshDestination(input);
  if (
    !parsed.ok ||
    [input.host, input.user, input.identityFile].some(
      (value) => value !== undefined && /[\r\n\0]/u.test(value),
    )
  )
    return yield* new SshHostProbeError({
      host: input.host,
      reason: "invalid_request",
      message: parsed.ok ? "Invalid SSH identity file." : parsed.message,
    });
  const target = parsed.destination;
  const overrides = [
    ...(target.user ? ["-l", target.user] : []),
    ...(target.port ? ["-p", String(target.port)] : []),
    ...(input.identityFile ? ["-i", input.identityFile] : []),
  ];
  const ssh = yield* resolveSshCommand;
  const resolved = yield* runPreflightProcess(ssh, [
    "-G",
    ...commonArgs,
    ...overrides,
    target.hostname,
  ]);
  const settings = new Map<string, string>();
  const identities: string[] = [];
  for (const line of resolved.stdout.split(/\r?\n/u)) {
    const [key = "", ...rest] = line.trim().split(/\s+/u);
    if (!settings.has(key)) settings.set(key, rest.join(" "));
    if (key === "identityfile") identities.push(rest.join(" "));
  }
  const destination = {
    ...(options.alias ? { alias: options.alias } : {}),
    hostname: settings.get("hostname") || target.hostname,
    user: settings.get("user") || target.user || "unknown",
    port: Number(settings.get("port")) || target.port || 22,
  };
  const steps: SshPreflightStep[] = [];
  let platformKey: string | undefined;
  const finish = (): SshPreflightReport => {
    const blocker = steps.find((step) => step.state === "failed" || step.state === "needs_review");
    const ordered = SSH_PREFLIGHT_STEP_ORDER.map(
      (id) =>
        steps.find((step) => step.id === id) ?? {
          id,
          state: "skipped" as const,
          summary: `Waiting on ${blocker?.id ?? "SSH checks"}.`,
        },
    );
    return {
      host: input.host,
      destination,
      steps: ordered,
      ready: !blocker,
      ...(platformKey ? { platformKey } : {}),
    };
  };
  const reachabilityFailure = (stderr: string) => {
    const hop = /(?:^|\n)([^\s@]+)@([^\s:]+):/u.exec(stderr)?.[2];
    const diagnostic = sshFailureDiagnostic(`Cannot reach ${input.host}.`, stderr);
    const proxy = sshLocalProxyFailure(stderr);
    const instruction =
      proxy?.fix ??
      (/connection refused/iu.test(stderr)
        ? "Enable Remote Login (macOS) or start sshd on the host, then check again."
        : tailscaleHost(destination.hostname) || /tailscale/iu.test(stderr)
          ? "Check that Tailscale is running and signed in on both machines, then check the host name and SSH access."
          : "Check the host name, network and SSH port, then check again.");
    steps.push({
      id: "reachability",
      state: "failed",
      summary:
        hop && hop !== destination.hostname && hop !== target.hostname
          ? `SSH jump hop ${hop} failed: ${diagnostic}`
          : diagnostic,
      fix: { actor: "human", instruction },
    });
  };
  if (resolved.exitCode !== 0) {
    reachabilityFailure(resolved.stderr);
    return finish();
  }
  const run = (authentication: string, command: ReadonlyArray<string> = []) =>
    runPreflightProcess(ssh, [
      ...commonArgs,
      ...overrides,
      "-o",
      `PreferredAuthentications=${authentication}`,
      "-o",
      "StrictHostKeyChecking=yes",
      target.hostname,
      ...command,
    ]);
  const handshake = yield* run("none");
  const wrongHop = /(?:^|\n)[^\s@]+@([^\s:]+):/u.exec(handshake.stderr)?.[1];
  if (wrongHop && wrongHop !== destination.hostname && wrongHop !== target.hostname) {
    reachabilityFailure(handshake.stderr);
    return finish();
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(handshake.stderr)) {
    steps.push(
      { id: "reachability", state: "passed", summary: `Reached ${destination.hostname}.` },
      {
        id: "host_key",
        state: "failed",
        summary: "The SSH host key changed.",
        fix: {
          actor: "human",
          instruction:
            "Verify the new fingerprint with the host's owner before changing the saved host key.",
        },
      },
    );
    return finish();
  }
  const unknownKey = /No .*host key is known|Host key verification failed/iu.test(handshake.stderr);
  const methods = methodList(handshake.stderr);
  if (handshake.exitCode !== 0 && !methods && !unknownKey) {
    reachabilityFailure(handshake.stderr);
    return finish();
  }
  steps.push({ id: "reachability", state: "passed", summary: `Reached ${destination.hostname}.` });
  if (unknownKey || !options.alias) {
    const key = yield* probeHostKey({
      target: target.hostname,
      ...(target.user ? { user: target.user } : {}),
      ...(target.port ? { port: target.port } : {}),
      resolvedSettings: settings,
    }).pipe(Effect.option);
    steps.push({
      id: "host_key",
      state: key._tag === "Some" ? "needs_review" : "failed",
      summary:
        key._tag === "Some"
          ? "Review and pin this host's SSH fingerprint."
          : "Could not collect this host's negotiated SSH fingerprint. Check again.",
      detail: unknownKey
        ? "This key is not trusted by known_hosts."
        : "known_hosts already matches; GOAT still needs a managed alias and pin for this address.",
      ...(key._tag === "Some" ? { fingerprint: key.value.fingerprint } : {}),
    });
    return finish();
  }
  steps.push({ id: "host_key", state: "passed", summary: "The SSH host key matches." });
  const facts = yield* run(handshake.exitCode === 0 ? "none,publickey" : "publickey", [
    "sh",
    "-c",
    `'${FACTS.replaceAll("'", "'\\''")}'`,
  ]);
  if (
    facts.exitCode !== 0 &&
    !/Authenticated .* using ["']?(?:publickey|none)/iu.test(facts.stderr)
  ) {
    const offered = /Offering public key: (.+?)(?: SHA256:|$)/mu.exec(facts.stderr)?.[1];
    const authMethods = methodList(facts.stderr) || methods;
    const partial = /with partial success/iu.test(facts.stderr);
    const denied = /Permission denied/iu.test(facts.stderr);
    const fs = yield* FileSystem.FileSystem;
    const home = yield* HostProcess.HomeDirectory;
    let publicKeyPath = offered ? `${offered}.pub` : undefined;
    if (!publicKeyPath) {
      for (const identity of identities) {
        const candidate = `${identity.replace(/^~(?=\/)/u, home)}.pub`;
        if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
          publicKeyPath = candidate;
          break;
        }
      }
    }
    const guidance = buildSshKeyAuthInstructions({
      originLabel: options.ownerLabel,
      host: destination.hostname,
      user: destination.user,
      port: destination.port,
      ...(publicKeyPath ? { publicKeyPath } : {}),
    });
    steps.push({
      id: "key_auth",
      state: "failed",
      summary: partial
        ? `The key was accepted, but this host also requires ${authMethods || "another authentication method"}.`
        : denied
          ? authMethods.includes("publickey")
            ? /password|keyboard-interactive/u.test(authMethods)
              ? `${input.host} refused ${options.ownerLabel}'s SSH keys; it would ask for a password, and GOAT signs in only with keys.`
              : `${input.host} refused ${options.ownerLabel}'s SSH keys. Add an authorized public key.`
            : `${input.host} offers only ${authMethods || "non-key authentication"}.`
          : safeLine(facts.stderr),
      fix: {
        actor: "human",
        instruction: partial
          ? "Set AuthenticationMethods publickey for this user in sshd_config."
          : !authMethods.includes("publickey") && denied
            ? "Enable PubkeyAuthentication yes in sshd_config, then add your public key."
            : publicKeyPath
              ? guidance.instruction
              : `Create an SSH key on ${options.ownerLabel}, then install its public key on ${input.host} and check again.`,
        ...(partial
          ? {}
          : guidance.command
            ? { command: guidance.command }
            : { command: "ssh-keygen -t ed25519" }),
      },
    });
    return finish();
  }
  const authenticatedKey = /Authenticated .* using ["']?publickey["']?/iu.test(facts.stderr);
  steps.push({
    id: "key_auth",
    state: "passed",
    summary: authenticatedKey
      ? `Signed in using ${/Offering public key: (.+?)(?: SHA256:|$)/mu.exec(facts.stderr)?.[1] ?? `${options.ownerLabel}'s SSH key`}.`
      : handshake.exitCode === 0
        ? "Signed in without authentication (none)."
        : "Signed in using an SSH key.",
  });
  const values = new Map(
    facts.stdout.split(/\r?\n/u).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)] as const;
    }),
  );
  const os = values.get("GOAT_OS") ?? "";
  const windows = /^(MINGW|MSYS|CYGWIN)/u.test(os);
  const platform =
    os === "Darwin" ? "darwin" : os === "Linux" ? "linux" : windows ? "win32" : undefined;
  const arch = values.get("GOAT_ARCH");
  const key = platform
    ? cliArchivePlatformKey(
        platform,
        arch === "aarch64" || arch === "arm64"
          ? "arm64"
          : arch === "x86_64" || arch === "amd64"
            ? "x64"
            : (arch ?? ""),
      )
    : undefined;
  if (
    !values.has("GOAT_FACTS_DONE") ||
    !key ||
    (windows && (!values.has("GOAT_CYGPATH") || !values.has("GOAT_SYSTEM_TAR")))
  ) {
    steps.push({
      id: "platform",
      state: "failed",
      summary: !values.has("GOAT_FACTS_DONE")
        ? "SSH needs a POSIX default shell."
        : windows && !values.has("GOAT_CYGPATH")
          ? "Windows is missing cygpath."
          : windows && !values.has("GOAT_SYSTEM_TAR")
            ? "Windows is missing System32 tar."
            : `GOAT does not support ${os || "this OS"}/${arch ?? "unknown architecture"}.`,
      fix: {
        actor: "human",
        instruction:
          windows || !os
            ? "Install Git for Windows and set OpenSSH DefaultShell to its bash; ensure cygpath and Windows System32 tar are available."
            : "Use a supported GOAT host platform.",
      },
    });
    return finish();
  }
  platformKey = key;
  steps.push({ id: "platform", state: "passed", summary: `Supports ${key}.` });
  const runtime = yield* checkRuntimeAvailability({
    runner: options.runner,
    ownerLabel: options.ownerLabel,
    platformKey: key,
    installedVersions: facts.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("GOAT_INSTALLED="))
      .map((line) => line.slice(15)),
  });
  steps.push(runtime.step);
  const freeKiB = Number(values.get("GOAT_FREE_KIB"));
  steps.push({
    id: "disk",
    state: !Number.isFinite(freeKiB)
      ? "warning"
      : freeKiB < 512 * 1024 && runtime.needsTransfer
        ? "failed"
        : "passed",
    summary: !Number.isFinite(freeKiB)
      ? "Could not check free space in the home directory."
      : freeKiB < 512 * 1024 && runtime.needsTransfer
        ? `Only ${Math.floor(freeKiB / 1024)} MiB free; installing GOAT needs 512 MiB for the archive, extracted runtime and retained previous version.`
        : `${Math.floor(freeKiB / 1024)} MiB free in the home directory.`,
    ...(freeKiB < 512 * 1024 && runtime.needsTransfer
      ? {
          fix: {
            actor: "human" as const,
            instruction: "Free at least 512 MiB in the host's home directory, then check again.",
          },
        }
      : {}),
  });
  return finish();
});
