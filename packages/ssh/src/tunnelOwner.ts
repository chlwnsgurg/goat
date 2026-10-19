import { ChildProcess } from "effect/process";

// The scoped temp directory auth.ts creates for one forward's askpass helper.
const OWNED_AUTH_DIRECTORY = /^(.*\/goat-ssh-runtime-[^/]+)\/t3code-ssh-askpass\/[^/]+$/u;

/**
 * The directory the supervisor may delete when the owner dies. Anything other than GOAT's
 * own per-forward temp directory yields "", so a crash can never remove a shared directory.
 */
export function ownedAuthDirectory(askpassPath: string | undefined): string {
  return askpassPath === undefined ? "" : (OWNED_AUTH_DIRECTORY.exec(askpassPath)?.[1] ?? "");
}

// ssh -N ignores stdin EOF. A separate reader keeps the owner's pipe alive and
// kills only this dedicated process group if the owner disappears without cleanup.
const OWNER_PIPE_SUPERVISOR = `auth_directory=$1
shift
(
  while IFS= read -r ignored; do :; done
  if [ -n "$auth_directory" ]; then rm -rf -- "$auth_directory"; fi
  kill -KILL "-$$"
) <&0 &
watcher=$!
"$@" </dev/null &
ssh_pid=$!
trap 'kill -TERM "$ssh_pid" 2>/dev/null' TERM INT HUP
wait "$ssh_pid"
status=$?
if kill -0 "$ssh_pid" 2>/dev/null; then
  wait "$ssh_pid"
  status=$?
fi
kill -KILL "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
exit "$status"
`;

export function makeOwnedSshTunnelCommand(
  platform: NodeJS.Platform,
  executable: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions,
  authDirectory: string = "",
) {
  if (platform === "win32") return ChildProcess.make(executable, args, options);
  return ChildProcess.make(
    "/bin/sh",
    ["-c", OWNER_PIPE_SUPERVISOR, "goat-ssh-forward", authDirectory, executable, ...args],
    {
      ...options,
      // $$ must identify a group exclusively owned by this supervisor.
      detached: true,
      stdin: { stream: "pipe", endOnDone: false },
    },
  );
}
