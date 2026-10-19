import { parseSshDestination } from "@goat/shared/sshDestination";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const readOnlySshArgs = [
  "-T",
  ...[
    "ControlMaster=no",
    "ControlPath=none",
    "UpdateHostKeys=no",
    "PermitLocalCommand=no",
    "BatchMode=yes",
    "RemoteCommand=none",
    "RequestTTY=no",
    "ClearAllForwardings=yes",
    "ForwardAgent=no",
    "ForwardX11=no",
    "LogLevel=VERBOSE",
    "ConnectTimeout=10",
  ].flatMap((option) => ["-o", option]),
];

export function readOnlyProxyJumpArgs(ssh: string, settings: ReadonlyMap<string, string>) {
  const jump = settings.get("proxyjump");
  if (!jump || jump === "none") return [];
  // Windows OpenSSH spawns ProxyCommand directly; POSIX passes it to the shell.
  const quoteArg = ssh.endsWith(".exe")
    ? (value: string) => `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`
    : quote;
  let proxy: string | undefined;
  for (const hop of jump.split(",")) {
    const args = [ssh, ...readOnlySshArgs, "-o", "StrictHostKeyChecking=yes"];
    if (proxy) args.push("-o", `ProxyCommand=${proxy}`);
    const parsed = hop.startsWith("ssh://") ? undefined : parseSshDestination({ host: hop });
    const destination = parsed?.ok ? parsed.destination : undefined;
    if (destination?.user) args.push("-l", destination.user);
    if (destination?.port) args.push("-p", String(destination.port));
    // Each SSH process expands its own forwarding target; nested commands survive one expansion.
    const literal = args.map((arg) => quoteArg(arg.replaceAll("%", "%%")));
    proxy = [
      ...literal,
      "-W",
      quoteArg("[%h]:%p"),
      "--",
      quoteArg((destination?.hostname ?? hop).replaceAll("%", "%%")),
    ].join(" ");
  }
  return ["-o", `ProxyCommand=${proxy}`];
}
