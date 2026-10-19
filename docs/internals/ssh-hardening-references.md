# SSH hardening references

This page compares GOAT's SSH connection layer with four tools that solve the
same problem, then lists what to change next. It is a working backlog: when an
item ships, remove it here and update [SSH reconnect](ssh-reconnect.md) if the
behavior it describes changed.

The references were read from pinned checkouts. Nothing in them was built, run,
or connected; values are configured timers, not measured recovery times.
Citations are `repo:path:line` at these commits:

| Short name   | Source                                                                       | Commit     | What it is                                                    |
| ------------ | ---------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| cmux         | [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)                      | `42048bdd` | macOS terminal; `cmux ssh` with a remote daemon, relay, Mosh  |
| herdr        | [herdrdev/herdr](https://github.com/herdrdev/herdr)                          | `143bf5fd` | Rust agent multiplexer with saved SSH machines                |
| herdr-web-ui | [devswha/herdr-web-ui](https://github.com/devswha/herdr-web-ui)              | `a8f2b038` | Browser and phone client that reaches PCs over SSH            |
| Codex        | [openai/codex](https://github.com/openai/codex) and the Codex desktop bundle | `816fa702` | `codex-rs` source; desktop paths are a beautified local build |

Longer per-reference notes, with every topic and its "not present" results,
live outside this repository in the maintainer's analysis corpus
(`213_cmux-herdr-ssh-analysis/`).

## Where GOAT stands

GOAT is already at or ahead of the references on most axes. Its retry ladder
is jittered (1 s base, 5 min cap, upper-half jitter) and resets only after
30 s of stable connection
(`packages/client-runtime/src/connection/supervisor.ts:40`,
`supervisor.ts:128`). Remote commands run through `runSshCommand` and SSH
forwards carry
`ServerAliveInterval=15`/`ServerAliveCountMax=3`
(`packages/ssh/src/command.ts:122`), and the RPC session has a 15 s silence
budget, so a dead link is noticed in about 15–20 s
(`packages/client-runtime/src/rpc/protocol.ts:21`). Failures are classified
into quiet, retrying, and blocked states (#361, #379); on macOS and Linux,
forwards die with their owner process (#378; Windows still lacks that fence,
`packages/ssh/src/tunnelOwner.ts:57`); duplicate wakes collapse and network
path changes after a drop are seen (#381); one reconnect runs one SSH
preparation (#382). Runtime archives are SHA-256 checked locally
(`packages/ssh/src/runtimeArchiveHttp.ts:113`) and again on the host
(`packages/ssh/src/tunnel.ts:884`). Turns and committed state live on the
remote server, so a dropped transport stops neither; subscriptions replay
from their cursor, and an in-flight mutation fails rather than replaying.

The gaps are narrower: how many SSH handshakes one reconnect costs, what the
remote server does with sockets a sleeping client abandoned, and whether
recovery from a stalled (not closed) link is covered by automated tests.

## What the references do

**cmux** has three generations of remote code; the Rust `cmux-tui` carrier is
now the default for interactive `cmux ssh` (`cmux:CLI/cmux.swift:14085`).

- Carrier recovery retries immediately, then full jitter under ceilings of
  100 ms doubling to 5 s, with a 15 s per-attempt deadline and no attempt or
  duration limit (`cmux:cmux-tui/crates/cmux-remote/src/connection.rs:63`,
  `connection.rs:803`). An application heartbeat (5 s interval, 15 s timeout)
  covers a blocked write as well as a missing reply (`connection.rs:943`).
- The older daemon coordinator parks a session after three identical bootstrap
  failures, eight total, or an authentication block, and parks if no proxy is
  ready 60 s after the first daemon hello
  (`cmux:Packages/macOS/CmuxRemoteSession/Sources/CmuxRemoteSession/Reachability/RemoteBootstrapRetryPolicy.swift:27`,
  `.../Session/RemoteSessionCoordinator+Readiness.swift:16`). On sleep it cancels
  scheduled retries and the readiness deadline and ignores late reachability
  callbacks; wake clears suspension and retries unhealthy transports on a 2 s
  base (`.../Session/RemoteSessionCoordinator+SystemPower.swift:24`,
  `SystemPower.swift:28`).
- Connection sharing is on by default for cmux-managed sockets:
  `ControlMaster=auto`, `ControlPersist=600`, a private `ControlPath`, and a
  route-specific socket when proxy or identity settings differ. A ControlPath
  the user configured is left alone
  (`cmux:Packages/macOS/CmuxFoundation/Sources/CmuxFoundation/SSHConnectionSharingOptions.swift:236`,
  `SSHConnectionSharingOptions.swift:274`). The reverse relay is added to the
  master with `ssh -O forward` and removed with the exact spec on teardown
  (`.../Session/RemoteSessionCoordinator+ReverseRelayControlMaster.swift:45`,
  `ReverseRelayControlMaster.swift:101`).
- A new stdio bridge claims its slot with a fresh lease ID and closes every
  older bridge, including half-open ones, without waiting for TCP to notice
  (`cmux:daemon/remote/cmd/cmuxd-remote/persistent_bridge_lease.go:54`).
- Transient retries publish "reconnecting" with no detail, so the sidebar does
  not flash red; the error appears when the session parks, and a context menu
  offers **Copy SSH Error**
  (`.../Session/RemoteSessionCoordinator.swift:389`,
  `cmux:Sources/TabItemView+WorkspaceContextMenu.swift:204`).
- Mosh carries only the interactive terminal; bootstrap, RPC, relay, and
  uploads stay on SSH, and blocked-UDP recovery is deferred
  (`cmux:docs/remote-daemon-spec.md:37`, `remote-daemon-spec.md:39`).
- Tests block the heartbeat write, wedge a daemon behind live pipes, and cut
  or delay a carrier through a TCP proxy
  (`cmux:cmux-tui/crates/cmux-remote/src/connection.rs:2034`,
  `cmux:Packages/macOS/CmuxRemoteDaemon/Tests/CmuxRemoteDaemonTests/RemoteDaemonRPCClientKeepaliveTests.swift:109`,
  `cmux:cmux-tui/crates/cmux-remote/tests/pty_reconnect_e2e.rs:72`).

**herdr** keeps one supervisor per saved machine.

- Deterministic ladder 0.5 s doubling to 120 s, no jitter; the ladder resets
  only after the connection has been _ready_ (initial snapshot received) for
  60 s, so a handshake during a maintenance wake does not count
  (`herdr:src/client/endpoint/supervisor.rs:11`, `supervisor.rs:291`,
  `supervisor.rs:563`).
- Sleep cancels in-flight attempts (`supervisor.rs:325`). For 30 s after an
  interactive wake every failed attempt waits at most 2 s, so Wi-Fi can
  reassociate quickly; failures still count, so the ladder resumes from its
  advanced position after the window (`supervisor.rs:16`, `supervisor.rs:297`).
  Live connections are probed on wake, not replaced.
- Failures that need a person (`Attention`: auth, host key, version) are
  re-checked quietly every 30 s, so an `ssh-add` or a fix on the host
  recovers without a click (`supervisor.rs:280`,
  `herdr:docs/preview/website/src/content/docs/connecting-machines.mdx:14`).
- On POSIX with the managed SSH config (the default), the generated config
  includes the user's config before its keepalive fallbacks, and commands ride
  a scoped master (`-S <private path>`, `ControlMaster=auto`,
  `ControlPersist=600`). Background commands also pass
  `ServerAliveInterval=15`/`ServerAliveCountMax=4`,
  `NumberOfPasswordPrompts=0`, and `ConnectionAttempts=1` on the command line
  (`herdr:src/remote/attach.rs:1402`, `attach.rs:1433`, `attach.rs:3171`). The
  transport is a remote command over SSH stdio, so there is no port forward to
  manage.
- When both ends support it, the remote bridge exits after 60 s with no
  traffic in either direction, measured on a clock that counts sleep, so a
  client that vanished does not leave a bridge behind
  (`herdr:src/platform/remote_bridge.rs:8`, `connecting-machines.mdx:94`).
- Background reconnects only discover installed packages; installing or
  updating the remote needs an explicit, interactive setup
  (`connecting-machines.mdx:28`).

**herdr-web-ui** reaches each PC from a local Bun server.

- On Linux and macOS, one private master per PC (`ssh -M -N -T -S <tmp>/control`),
  with forwards added through it by `-O forward`; Windows uses standalone
  connections (`herdr-web-ui:server/ssh.ts:203`, `server/ssh.ts:324`). Host
  disconnect bumps a generation, clears timers, closes relays, and kills the
  master and its children (`server/machines.ts:817`, `server/ssh.ts:379`).
- The browser socket probes after 20 s of silence with a correlated
  ping/pong; ordinary frames cannot satisfy a probe, and two misses replace the
  socket. A deadline that fires more than 2 s late is treated as a frozen page
  and restarted instead of counted as a miss
  (`herdr-web-ui:src/lib/ws.ts:35`, `src/lib/ws.ts:446`, `src/lib/ws.ts:484`).
- Setup shows the last 8 sanitized lines of SSH output while a prompt waits
  (`herdr-web-ui:server/ssh.ts:46`).
- Tests use fake timers for flapping and frozen deadlines, and a fake SSH that
  kills a forward after its second TCP connection
  (`herdr-web-ui:src/lib/ws.test.ts:875`, `src/lib/ws.test.ts:1312`,
  `server/ssh.test.ts:183`).

**Codex** desktop runs WebSocket over the stdio of `ssh ... codex app-server
proxy`, so it needs no local `-L` port for the main transport. Desktop paths
are relative to the bundle's `snapshots/vite-build-beautified/`.

- Ladder 1 s doubling to 20 s, with per-host deterministic jitter of up to
  500 ms (`bootstrap-yYZ8rgHq.js:62449`, `bootstrap-yYZ8rgHq.js:65988`). SSH
  uses `ServerAliveInterval=15`/`ServerAliveCountMax=12`
  (`main-C3nRcJ3D.js:1076`) plus a WebSocket ping every 10 s with a 60 s pong
  budget (`application-network-startup-DN7Ktmlk.js:9334`).
- When this machine's network was offline for at least 5 s and comes back, a
  connected SSH session is replaced even if its socket still claims to be open
  (`bootstrap-yYZ8rgHq.js:66036`).
- After reconnect, conversations are resumed at most two at a time
  (`bootstrap-yYZ8rgHq.js:49659`).
- Forward cleanup kills the child and also sends `ssh -O cancel -L ...`, in
  case the user's own config multiplexed it (`bootstrap-yYZ8rgHq.js:63173`).

## Gap table

| Concern                      | GOAT today                                                                                                           | Best reference practice                                         | Gap               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------- |
| Backoff and jitter           | 1 s→5 min, upper-half jitter, 30 s stable reset                                                                      | cmux full jitter; herdr resets on 60 s _ready_                  | none              |
| Post-wake retries            | flat 2 s for 30 s after long resume, failure count held at zero                                                      | herdr caps at 2 s for 30 s after wake                           | none              |
| Suspend                      | cancels establishment and retry timers until wake                                                                    | herdr cancels in-flight attempts; cmux cancels timers           | none              |
| Blocked recovery             | local proxy re-checks every 60 s while staying blocked; other blocks wait for a signal                               | herdr re-checks every 30 s                                      | none              |
| SSH handshakes per reconnect | 4 standalone ssh processes per reconnect direct, 5 behind `cloudflared` (3.3 s each); `ssh.reconnect.cost` logs them | one scoped master per host in cmux, herdr, herdr-web-ui (POSIX) | P1                |
| Setup deadline               | launch plus runtime probe take 17–25 s, so every reconnect's first attempt times out at 15 s                         | none of the references probe a runtime on each reconnect        | P0                |
| Stalled link                 | ServerAlive + RPC silence budget; real loopback stall tests cover RPC timeout and forward revalidation               | cmux blocked-write and carrier-cut fixtures                     | none              |
| Abandoned server sockets     | not measured; the server sets no idle option (`apps/server/src/ws.ts:3430`)                                          | herdr bridge idles out at 60 s; cmux lease evicts older bridges | P1, measure first |
| Git over SSH                 | `GIT_SSH_COMMAND` has no keepalive; 120 s transfer cap (`apps/server/src/sshRemote/SshWorkspaceSync.ts:116`)         | every other SSH path carries ServerAlive                        | P2                |
| Error detail                 | tooltip; connection menu and thread banner copy a sanitized public diagnostic                                        | cmux Copy SSH Error; herdr-web-ui last 8 lines                  | none              |
| Frozen timers (web, mobile)  | long resume replaces the session; timers over 2 s late restart the RPC silence budget                                | herdr-web-ui treats a late deadline as a freeze                 | none              |
| Archive pinning              | SHA-256 locally and on the host                                                                                      | same                                                            | none              |
| Session resume               | server owns turns and state; subscriptions replay from cursor; mutations never replayed                              | cmux keeps replay state 120 s; herdr keeps panes running        | none              |
| Forward lifetime             | owner-death fence on POSIX, 2 s bounded teardown (#378); Windows unfenced                                            | herdr-web-ui and Codex kill by captured PID                     | none on POSIX     |
| Roaming transport (Mosh)     | none                                                                                                                 | cmux uses it for the terminal only                              | non-goal          |

Two reference behaviors are deliberately not adopted. cmux's older coordinator
parks a session after a bounded number of failures; GOAT never gives up on a
host that may simply be asleep, and the long cap keeps that cheap. herdr
installs only during interactive setup; GOAT's owning client installs its
release on first connection by design
([SSH upgrades](../../structure/ssh.md#upgrades)). Mosh roams a terminal, but
GOAT's transport is HTTP and WebSocket to a server that already outlives the
link, so reconnect plus cursor replay covers the same need.

## Backlog

Each item names what to verify on the real app. The test hosts are
`mac-studio` (direct), `macmini-cf` (behind `cloudflared access ssh`), and the
saved `jun-macbookpro` connection, which is offline and therefore the
unreachable case. Drive the installed app with
`aside exec --permission full-access "<task>"` on this Mac and have it report
the visible banner, Connections status, and timestamps; take host-side
evidence over plain `ssh`. A stalled link is simulated with a loopback relay
in the path (for example a `ProxyCommand` through a relay that can stop
forwarding), never by stopping ssh itself: a stopped ssh also stops its
keepalive.

Baseline from 2026-10-19, measured with a development desktop at `466596748`
attached to each host's existing runtime. Each reconnect was triggered by
killing the app's forward:

| Host         | Handshake | Reconnect (median of 5) | ssh spawns | First attempt     |
| ------------ | --------- | ----------------------- | ---------- | ----------------- |
| `mac-studio` | 0.17 s    | 26.5 s                  | 4          | times out at 15 s |
| `macmini-cf` | 3.3 s     | 57.5 s                  | 5          | times out at 15 s |

Through the stall relay, the Connections row left `Connected` a median 20.5 s
after the stall (15.4–20.7 s) and was back a median 34 s after the relay
resumed (26–47 s).

### P0

**P0-3. Keep one reconnect inside the setup deadline.**
Problem: on both hosts the launch step (`sh -l -s`, 6–10 s) and the runtime
probe (`sh -l -s -- runtime`, 11–15 s) together exceed the supervisor's 15 s
establishment timeout (`supervisor.ts:44`), so the first attempt of every
reconnect fails with "did not respond during connection setup" and the next
attempt joins the preparation that is still running.
Evidence: every measured reconnect above. Each `goat` start on the host costs
about 0.42 s, and the probe starts it repeatedly (`binary_json`,
`build_commit_time`, `lacks_memory_scopes`, `__ssh-helper protocol` and
`compat`) and hashes the runner and executables
(`packages/ssh/src/tunnel.ts:2273`, `tunnel.ts:2316`).
Change: answer the probe with one helper invocation, or skip it when the live
server the client last attached to still reports the same identity. Do not
raise the timeout, which also bounds a dead host.
Test: a preparation-timing test in `packages/ssh`.
Real app: rerun the reconnect baseline; the first attempt no longer times out.

### P1

**P1-3. One scoped master per host.**
Problem: when cost logs show several handshakes per reconnect, each one repeats
ProxyCommand startup, key exchange, and authentication; behind
`cloudflared` that is seconds each, and an askpass prompt can repeat.
Evidence: on POSIX, cmux, herdr, and herdr-web-ui each run one private master
per host or route (`SSHConnectionSharingOptions.swift:274`,
`herdr:src/remote/attach.rs:1433`, `herdr-web-ui:server/ssh.ts:203`). cmux and
herdr-web-ui add forwards to it with `-O forward`
(`ReverseRelayControlMaster.swift:45`, `herdr-web-ui:server/ssh.ts:324`); herdr
pins the control socket before `-O stop` so it never stops a newer master
(`herdr:src/platform/unix_common.rs:768`, `herdr:src/remote/attach.rs:953`).
Change: on POSIX, start a GOAT-owned master per resolved target under the
owner fence from #378 (`-M -N -S <private dir>/<hash>`,
`ControlPersist=no`), run commands with `-S` and `ControlMaster=no`, add the
forward with `-O forward` and remove it with `-O cancel`. A failed master falls
back to today's standalone processes. Keepalive moves to the master; the
existing RPC ping still detects a dead master within its budget. Windows keeps
standalone processes.
Files: `packages/ssh/src/command.ts`, `tunnel.ts`, `tunnelOwner.ts`,
`structure/ssh.md`.
Test: fake-ssh tests that commands carry `-S`; teardown cancels the forward
and kills the master; a master that dies mid-session falls back.
Real app: rerun cost and stalled-link measurements; the PR states spawn and auth counts before and
after, and that killing the master by its captured PID reconnects within the
stalled-link baseline.

**P1-4. Find out whether the server keeps abandoned sockets.**
Problem: when a laptop sleeps with a forward open, sshd on the host may hold
the forwarded connection to GOAT's port until TCP keepalive gives up, by
default hours. Each wake opens a new session, so stale sockets and their
subscriptions may accumulate on the host.
Evidence: when both ends support it, herdr's remote bridge exits after 60 s of
silence (`herdr:src/platform/remote_bridge.rs:8`); cmux evicts older bridges by
lease (`persistent_bridge_lease.go:54`); GOAT's RPC server sets no idle option
(`apps/server/src/ws.ts:3430`) and relies on client pings.
Change: measure first. If sockets accumulate, close a WebSocket that has sent
no frame for 60 s; client pings every 5 s keep healthy sessions alive.
Files: `apps/server/src/ws.ts` if needed.
Test: a server test that a silent socket is closed and a pinging one is not.
Real app: on `mac-studio`, `lsof -nP -iTCP:<goat port> -sTCP:ESTABLISHED`
before and after five sleep/wake cycles of this Mac; report the counts.

### P2

**P2-2. Keepalive for Git over SSH.** `GIT_SSH_COMMAND` omits ServerAlive
(`SshWorkspaceSync.ts:116`), so a stalled fetch waits out the 120 s transfer
cap. Add `SSH_KEEPALIVE_ARGS`. Test in `SshWorkspaceSync.test.ts`. Real app:
during agent dispatch to `mac-studio` over the stall relay, stall it mid-fetch
and record how long the failure takes before and after.

## Bundles

Each remaining bundle is one PR. Use the loopback stall fixture and
`ssh.reconnect.cost` logs to collect real-host baseline numbers before
changing reconnect policy or connection sharing.

3. **Scoped SSH master** (P1-3, P2-2). `packages/ssh` only, plus
   `SshWorkspaceSync` keepalive; land after the cost logs show the real-host baseline.
4. **Server socket hygiene** (P1-4). Measurement, then the idle close if the
   counts justify it.
5. **Probe cost** (P0-3). The `packages/ssh` runtime probe; rerun the baseline.
