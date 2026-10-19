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

The gaps are narrower: what happens in the first seconds after wake, how many
SSH handshakes one reconnect costs, how a blocked state recovers when its cause
is fixed outside GOAT, and whether recovery from a stalled (not closed) link is
covered by automated tests.

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

| Concern                      | GOAT today                                                                                                               | Best reference practice                                         | Gap                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------- |
| Backoff and jitter           | 1 s→5 min, upper-half jitter, 30 s stable reset                                                                          | cmux full jitter; herdr resets on 60 s _ready_                  | none                  |
| Post-wake retries            | ladder resets on wake, then doubles (1–2, 2–4, 4–8 s…)                                                                   | herdr caps at 2 s for 30 s after wake                           | P1                    |
| Suspend                      | only timestamps the sleep (`apps/desktop/src/app/DesktopSystemWake.ts:48`)                                               | herdr cancels in-flight attempts; cmux cancels timers           | P2                    |
| Blocked recovery             | waits for wake, network change, or click (`supervisor.ts:972`)                                                           | herdr re-checks every 30 s                                      | P1 (local proxy only) |
| SSH handshakes per reconnect | every step spawns its own ssh (11 `runSshCommand` sites in `tunnel.ts`); the forward disables sharing (`tunnel.ts:3372`) | one scoped master per host in cmux, herdr, herdr-web-ui (POSIX) | P1, measure first     |
| Stalled link                 | ServerAlive + RPC silence budget; one manual frozen-relay run in #378; no automated stall test                           | cmux blocked-write and carrier-cut fixtures                     | P0                    |
| Abandoned server sockets     | 60 s inbound idle timeout; clients ping every 5 s (`apps/server/src/wsIdleTimeout.ts`)                                   | herdr bridge idles out at 60 s; cmux lease evicts older bridges | none                  |
| Git over SSH                 | `GIT_SSH_COMMAND` has no keepalive; 120 s transfer cap (`apps/server/src/sshRemote/SshWorkspaceSync.ts:116`)             | every other SSH path carries ServerAlive                        | P2                    |
| Error detail                 | tooltip; menu copies a trace ID only (`ConnectionEnvironmentsSection.tsx:675`)                                           | cmux Copy SSH Error; herdr-web-ui last 8 lines                  | P2                    |
| Frozen timers (web, mobile)  | long-resume path replaces the session                                                                                    | herdr-web-ui treats a late deadline as a freeze                 | P2, verify            |
| Archive pinning              | SHA-256 locally and on the host                                                                                          | same                                                            | none                  |
| Session resume               | server owns turns and state; subscriptions replay from cursor; mutations never replayed                                  | cmux keeps replay state 120 s; herdr keeps panes running        | none                  |
| Forward lifetime             | owner-death fence on POSIX, 2 s bounded teardown (#378); Windows unfenced                                                | herdr-web-ui and Codex kill by captured PID                     | none on POSIX         |
| Roaming transport (Mosh)     | none                                                                                                                     | cmux uses it for the terminal only                              | non-goal              |

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

### P0

**P0-1. Automate half-open detection against a stalled link.**
Problem: #378 recorded one manual frozen-relay run (HTTP check hit its 20 s
limit; ssh exited after 59 s), but no automated test keeps a forward alive
while it stops carrying bytes, which is what sleep, roaming, and a dropped NAT
entry produce. The supervisor's recovery and the visible banner have never
been measured against such a link.
Evidence: no stall fixture in `packages/ssh` or `packages/client-runtime`;
revalidation is covered only with mocked processes
(`packages/ssh/src/tunnel.core.test.ts:735`); cmux tests a blocked heartbeat
write (`cmux-tui/crates/cmux-remote/src/connection.rs:2034`) and a carrier cut
proxy (`pty_reconnect_e2e.rs:72`); herdr-web-ui kills a forward under a live
socket (`server/ssh.test.ts:183`).
Change: add a loopback TCP relay fixture that can pass, stall (hold both
sockets open, forward nothing), or reset. Run the RPC session through it and
assert the supervisor leaves `connected` within the ping budget; run
`revalidateTunnels` against a stalled forward and assert it is closed and its
port reused.
Files: new `packages/client-runtime/src/rpc/stalledTransport.test.ts`, new
`packages/ssh/src/tunnel.stall.test.ts`, a shared fixture beside
`packages/ssh/src/tunnel.fixture.ts`.
Test: Effect `TestClock` for the ping budget; the relay is real sockets, so no
sleeps.
Real app: route `mac-studio` through the stall relay, connect, stall the
relay, and record seconds until the banner shows and until reconnection after
releasing it. Repeat with `pmset sleepnow` for 60 s on the direct route.
Record the numbers in the PR; they become the baseline for P1-1 and P1-3.

**P0-2. Count what one reconnect costs.**
Problem: P1-3 (connection sharing) is the largest change on this list, and
its value depends on how many SSH handshakes and auth round trips one
reconnect performs today, which nobody has measured.
Evidence: 11 `runSshCommand` call sites in `packages/ssh/src/tunnel.ts`; the
forward sets `ControlMaster=no`/`ControlPath=none` (`tunnel.ts:3372`);
`baseSshArgs` leaves sharing to the user's config (`command.ts:103`).
Change: log one `ssh.reconnect.cost` line per preparation with the number of
ssh processes spawned, the DEBUG1 `Authenticated to` count already parsed for
timeout staging, and wall time per step.
Files: `packages/ssh/src/command.ts`, `packages/ssh/src/tunnel.ts`.
Test: extend `command.diagnostics.test.ts` to assert the counter from real
DEBUG1 fixtures.
Real app: reconnect `mac-studio` and `macmini-cf` five times each (Retry now
and after a 60 s sleep); report median spawns, authentications, and seconds.

### P1

**P1-1. A short wake window with a flat retry.**
Problem: after a long sleep the replacement attempt often fails because Wi-Fi
or Tailscale is not back yet. The reset ladder waits 1–2, 2–4, 4–8, then
8–16 s, so attempts land near 0, 2, 6, and 14 s after wake when each fails
at once; a route that returns at 15 s without a network-change event can wait
up to 16 s more.
Evidence: herdr caps delays at 2 s for 30 s after interactive wake
(`herdr:src/client/endpoint/supervisor.rs:16`, `supervisor.rs:297`); cmux wakes
on a 2 s base (`RemoteSessionCoordinator+SystemPower.swift:24`); GOAT resets
and doubles (`supervisor.ts:128`, `wakeups.ts:20`).
Change: on a long-resume wakeup, cap retry delays at 2 s for the next 30 s.
Unlike herdr, failures inside the window do not advance `failureCount`, so a
host that is still down after the window starts the ladder from the bottom.
Files: `packages/client-runtime/src/connection/supervisor.ts`,
`wakeups.ts`, `docs/internals/ssh-reconnect.md` (Backoff).
Test: `supervisor.test.ts` with `TestClock`: long resume, failures in the
first 30 s each scheduled at ≤2 s, the first one after the window back on the
ladder's first step.
Real app: sleep 2 min with Wi-Fi off at wake (toggle it 10 s after wake);
compare seconds to "Connected" for `mac-studio` before and after.

**P1-2. Re-check a blocked local proxy quietly.**
Problem: "Tailscale is not running on this machine" and a missing
ProxyCommand block until wake, network change, or Reconnect
(`supervisor.ts:972`). Starting Tailscale does not reliably produce a
`network-changed` event in the renderer, so the host stays blocked after the
user fixed it.
Evidence: herdr re-checks `Attention` every 30 s
(`herdr:src/client/endpoint/supervisor.rs:280`); cmux re-checks reported,
non-permanent restore failures every 30 s
(`cmux:Sources/RemoteTui/SSHTuiAttachRetry.swift:16`).
Change: for the local-proxy subset of `configuration` only, schedule a quiet
re-check every 60 s while blocked. Login rejection and host key stay
signal-only: repeating a rejected key can trip fail2ban, and a host key needs
review.
Files: `packages/client-runtime/src/connection/sshFailure.ts` (mark the
subset), `supervisor.ts`, `ssh-reconnect.md` (States table).
Test: `supervisor.test.ts`: local-proxy block re-attempts after 60 s;
`authentication` block does not.
Real app: quit Tailscale, reconnect `mac-studio` over its Tailscale alias,
confirm the blocked message, start Tailscale, and confirm recovery within
about 60 s without a click.

**P1-3. One scoped master per host.**
Problem: if P0-2 shows several handshakes per reconnect, each one repeats
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
Real app: rerun P0-2 and P0-1; the PR states spawn and auth counts before and
after, and that killing the master by its captured PID reconnects within the
P0-1 baseline.

### P2

**P2-1. Cancel attempts on suspend.** herdr stops in-flight connects when the
machine sleeps (`herdr:src/client/endpoint/supervisor.rs:325`), and cmux
cancels its timers. GOAT only records the time (`DesktopSystemWake.ts:48`), so
an attempt that started just before sleep can finish against a dead link
after wake before the long-resume replacement runs. Forward `suspend` as a
wakeup kind that interrupts establishment. Files: `DesktopSystemWake.ts`,
`apps/web/src/connection/desktopWakeups.ts`, `wakeups.ts`, `supervisor.ts`.
Test in `supervisor.test.ts`. Real app: start Reconnect on `jun-macbookpro`
and sleep within 5 s; after wake, logs show one attempt, not two.

**P2-2. Keepalive for Git over SSH.** `GIT_SSH_COMMAND` omits ServerAlive
(`SshWorkspaceSync.ts:116`), so a stalled fetch waits out the 120 s transfer
cap. Add `SSH_KEEPALIVE_ARGS`. Test in `SshWorkspaceSync.test.ts`. Real app:
during agent dispatch to `mac-studio` over the stall relay, stall it mid-fetch
and record how long the failure takes before and after.

**P2-3. Copy the SSH diagnostic.** cmux offers Copy SSH Error
(`TabItemView+WorkspaceContextMenu.swift:204`); herdr-web-ui shows the last 8
sanitized lines (`server/ssh.ts:46`). GOAT's connection menu copies only a
trace ID. Add "Copy diagnostic" with the classified reason and the bounded
public diagnostic tail already kept for status. Files:
`apps/web/src/components/settings/ConnectionEnvironmentsSection.tsx`, the
thread banner in `ChatView.tsx`. Needs before/after screenshots. Real app:
against `jun-macbookpro`, copy and paste the diagnostic; it names the host and
the timeout and contains no askpass secret.

**P2-4. Late timers on web and mobile.** herdr-web-ui restarts a deadline that
fired more than 2 s late instead of counting it as a miss
(`herdr-web-ui:src/lib/ws.ts:484`). Verify whether the 15 s RPC ping budget
fires spuriously when a mobile app or background tab resumes; fix only if it
does. Real app: background the mobile app for 2 min with `mac-studio`
connected; one reconnect is expected, a reconnect followed by a second drop is
the bug.

## Bundles

Each bundle is one PR and can land in any order, except that bundle 1 provides
the baseline numbers the others report against.

1. **Stall proof and reconnect cost** (P0-1, P0-2). Tests and one log line;
   no behavior change.
2. **Wake and blocked recovery** (P1-1, P1-2, P2-1). Supervisor policy and the
   desktop wake source; updates the States and Backoff sections of
   [SSH reconnect](ssh-reconnect.md).
3. **Scoped SSH master** (P1-3, P2-2). `packages/ssh` only, plus
   `SshWorkspaceSync` keepalive; land after bundle 1 shows the cost.
4. **Diagnostic copy and late timers** (P2-3, P2-4). UI plus a verified-only
   mobile fix.
