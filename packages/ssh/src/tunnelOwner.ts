import { ChildProcess } from "effect/process";

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
