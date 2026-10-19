# Self-healing

Self-healing keeps opted-in work running when a thread stalls, fails, or loses its machine. It
covers threads launched with `goat_ssh_thread_launch` and `selfHeal: true`, and, once the goal
controller lands, goal workers. Nothing changes for any other thread. The code lives in
[`apps/server/src/fleet/health`](../../apps/server/src/fleet/health); `Health` and `Rescheduler`
are the `Context.Service` tags the goal controller consumes.

## Host conditions

`Health` derives Kubernetes-style conditions for each SSH host from `goat_host_status` samples
and launch-watch outages: Ready, Unreachable, Cordoned, Draining, VersionMismatch, and
QuotaExhausted per provider instance. `goat_host_status` returns them as the additive
`conditions` field. Only Unreachable, Cordoned and Draining block placement; a version mismatch
or an exhausted quota is a warning, as `markVersionMismatch` already treats versions.

Hosts are sampled once a minute, and only while a worker or a cordon exists. A host becomes
Unreachable after three failed contacts (the launch watch's `OUTAGE_NOTICE_FAILURES`) spread over
at least five minutes, and its work moves only when the outage is fifteen minutes old. Kubernetes
uses the same two steps, a 50 s [node monitor grace period](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/)
and then a 300 s [unreachable toleration](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/).
GOAT's bounds are longer because its hosts are laptops on Wi-Fi and the SSH reconnect path
([ssh-reconnect.md](ssh-reconnect.md)) needs time after a wake.

Sleep on this machine is never evidence about another host. A gap of two minutes or more between
our own ticks, or a suspended power snapshot, marks a wake: every failure counted so far is
dropped, and failures in the next five minutes are ignored. A launch-watch outage that began
before that grace ended is ignored too. A Mac that wakes after a night therefore evicts nothing.

## Stalls

A worker's thread is read with `goat_thread_status` every 30 s. It is stalled when it is running
with no recorded activity for 20 minutes, starting for 10 minutes, waiting on a question or
approval for an hour, or failed with `transport_error` or `provider_error`. Older hosts that do
not send `lastErrorClass` are classified from the error text. `usage_limit` is left to
`UsageLimitRecoveryWorker` and the fallback chains. Only the agent's own reply or a completed run
counts as progress, so GOAT's nudges never reset an episode.

## Decision table

[`reschedulePolicy.ts`](../../apps/server/src/fleet/health/reschedulePolicy.ts) holds this table;
its tests list every row.

| Reason                            | Host answers | Action                                                  |
| --------------------------------- | ------------ | ------------------------------------------------------- |
| No progress                       | yes          | steer once, then restart once, then give up             |
| No progress                       | no           | wait for the host verdict                               |
| Unanswered request                | either       | wait; requests are never answered on the owner's behalf |
| Transport or provider failure     | yes          | restart once, then move                                 |
| Transport or provider failure     | no           | move once evictable, otherwise wait                     |
| Host unreachable                  | no           | move once evictable, otherwise wait                     |
| Host draining                     | yes          | move when the turn ends, or now with `force`            |
| Manual (`goat_thread_reschedule`) | either       | move                                                    |

Work never moves while its host answers unless the thread itself failed, the host is drained, or
a full-access caller asked. Restarts and moves spend one budget of three attempts; steering is
free but happens once per episode. Automatic attempts wait for an exponential backoff with
[full jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/), from
one minute up to thirty, close to Nomad's [service reschedule defaults](https://developer.hashicorp.com/nomad/docs/job-specification/reschedule).
A worker that spends its budget stays `exhausted` until someone moves it by hand.

## Moving work

A move resumes from a branch on origin. Self-healing launches ask the agent to push its worktree
branch at the end of every turn. When the old host still answers, its thread is first asked to
push and given ten minutes. The new thread starts on the target host in a worktree from
`origin/<branch>` on a new branch `<root branch>-r<generation>`, with the original prompt and a
note to check `git log` and `git status`. Work after the last push is lost; the resume prompt says
so.

The target comes from `channelPlacement.choosePlacement` over Ready, uncordoned hosts, scored by
the worker's provider quota and running threads. The project is matched on the target by
repository key, falling back to the same folder path.

Every launch is recorded before it starts. If the answer is lost, as when SSH drops mid-call or
the server restarts, the next attempt first looks for the new thread by its title on the target
and adopts it. Ticks and manual moves share one lock, so a move is decided once.

Each generation fences the last. The old binding is kept, and when its host answers again its
thread is interrupted and told where the work went. Its later pushes cannot clobber the new
worker, which is on a different branch.

## Limits

- Workers whose host dies before their last push lose that work. Channel tasks avoid this with
  replica bundles ([`channelReplica.ts`](../../apps/server/src/channels/channelReplica.ts)); a
  shared replica for any watched thread is future work and would not change channel behavior.
- `GOAT_FLEET_SELF_HEAL=off` stops every self-healing action; cordons stay visible. A settings
  switch can replace it once the fleet controllers have a settings home.
- Cordon and drain apply to SSH hosts. This machine is never a move target.
