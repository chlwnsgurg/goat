import type { FleetHostCondition, GoatHostStatusResult, HostStatusEntry } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostStatusMcpService from "../../mcp/HostStatusMcpService.ts";
import * as LaunchWatchService from "../../mcp/LaunchWatchService.ts";
import * as FleetHealthStore from "./FleetHealthStore.ts";
import {
  deriveConditions,
  emptyContact,
  forgetFailures,
  HOST_HEALTH_THRESHOLDS,
  initialClock,
  isEvictable,
  isSchedulable,
  isUnreachable,
  observeTick,
  recordOutage,
  recordSample,
  type HostContact,
  type HostHealthThresholds,
  type MonitorClock,
} from "./hostHealthModel.ts";

/** Launch watches scanned for outages on each sample. */
const OUTAGE_SCAN_LIMIT = 200;

export interface HealthShape {
  /** Records the entries' contacts and adds this machine's conditions to each SSH host. */
  readonly annotate: (result: GoatHostStatusResult) => Effect.Effect<GoatHostStatusResult>;
  readonly conditions: (host: string) => Effect.Effect<ReadonlyArray<FleetHostCondition>>;
  readonly schedulable: (host: string) => Effect.Effect<boolean>;
  readonly unreachable: (host: string) => Effect.Effect<boolean>;
  readonly evictable: (host: string) => Effect.Effect<boolean>;
  readonly draining: (host: string) => Effect.Effect<{ readonly force: boolean } | null>;
  /** Hosts with a recent answer, with their last sample, for placement. */
  readonly candidates: Effect.Effect<
    ReadonlyArray<{ readonly host: string; readonly sample: HostStatusEntry | null }>
  >;
  readonly cordon: (host: string, reason: string | null) => Effect.Effect<void>;
  readonly uncordon: (host: string) => Effect.Effect<void>;
  readonly drain: (host: string, force: boolean) => Effect.Effect<void>;
  /** One monitor step: notices sleep, and samples hosts when sampling is due. */
  readonly tick: Effect.Effect<void>;
}

/** Host conditions for the goal controller and the rescheduler. */
export class Health extends Context.Service<Health, HealthShape>()(
  "goat/fleet/health/HostHealthMonitor/Health",
) {}

export const make = (
  options: {
    readonly thresholds?: HostHealthThresholds;
    /** Samples hosts; the live layer fans goat_host_status out over SSH. */
    readonly sample?: Effect.Effect<GoatHostStatusResult>;
  } = {},
) =>
  Effect.gen(function* () {
    const thresholds = options.thresholds ?? HOST_HEALTH_THRESHOLDS;
    const store = yield* FleetHealthStore.FleetHealthStore;
    const power = yield* Effect.serviceOption(HostPowerMonitor.HostPowerMonitor);
    const watches = yield* Effect.serviceOption(LaunchWatchService.LaunchWatchService);
    const contacts = yield* Ref.make(new Map<string, HostContact>());
    const clock = yield* Ref.make<MonitorClock>(initialClock);
    const lastSampleAt = yield* Ref.make(Number.NEGATIVE_INFINITY);

    const contactOf = (host: string) =>
      Ref.get(contacts).pipe(Effect.map((all) => all.get(host) ?? emptyContact));

    const record = (entries: ReadonlyArray<HostStatusEntry>, now: number) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(clock);
        yield* Ref.update(contacts, (all) => {
          const next = new Map(all);
          for (const entry of entries) {
            if (entry.host === null) continue;
            next.set(
              entry.host,
              recordSample(next.get(entry.host) ?? emptyContact, entry, now, current),
            );
          }
          return next;
        });
      });

    const conditions: HealthShape["conditions"] = (host) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const document = yield* store.read;
        return deriveConditions({
          contact: yield* contactOf(host),
          scheduling: document.hosts.find((state) => state.host === host),
          now,
          thresholds,
        });
      });

    const annotate: HealthShape["annotate"] = (result) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* record(result.hosts, now);
        const hosts = yield* Effect.forEach(result.hosts, (entry) =>
          entry.host === null
            ? Effect.succeed(entry)
            : conditions(entry.host).pipe(Effect.map((list) => ({ ...entry, conditions: list }))),
        );
        return { ...result, hosts };
      });

    const setHost = (
      host: string,
      change: (state: FleetHostStateLike) => FleetHostStateLike | null,
    ) =>
      store.update((document) => {
        const existing = document.hosts.find((state) => state.host === host) ?? {
          host,
          cordonedAt: null,
          cordonReason: null,
          drainingAt: null,
          drainForce: false,
        };
        const changed = change(existing);
        const others = document.hosts.filter((state) => state.host !== host);
        return [
          undefined,
          { ...document, hosts: changed === null ? others : [...others, changed] },
        ];
      });

    const tick = Effect.gen(function* () {
      const document = yield* store.read;
      // Opt-in: nothing to heal and nothing cordoned means no SSH traffic at all.
      const active =
        document.workers.some((worker) => worker.phase !== "exhausted") ||
        document.hosts.length > 0;
      if (!active) return;
      const now = yield* Clock.currentTimeMillis;
      const suspended = power._tag === "Some" ? (yield* power.value.snapshot).suspended : false;
      const observed = observeTick(yield* Ref.get(clock), now, suspended, thresholds);
      yield* Ref.set(clock, observed.clock);
      if (observed.woke) {
        yield* Ref.update(
          contacts,
          (all) => new Map([...all].map(([host, c]) => [host, forgetFailures(c)])),
        );
      }
      if (suspended || options.sample === undefined) return;
      if (now - (yield* Ref.get(lastSampleAt)) < thresholds.sampleIntervalMs) return;
      yield* Ref.set(lastSampleAt, now);
      const sampled = yield* options.sample;
      yield* record(sampled.hosts, now);
      if (watches._tag === "Some") {
        const remote = yield* watches.value
          .listRemote(OUTAGE_SCAN_LIMIT)
          .pipe(Effect.orElseSucceed(() => []));
        const current = yield* Ref.get(clock);
        yield* Ref.update(contacts, (all) => {
          const next = new Map(all);
          for (const watch of remote) {
            if (watch.host === null || watch.outage === null) continue;
            next.set(
              watch.host,
              recordOutage(next.get(watch.host) ?? emptyContact, watch.outage, current),
            );
          }
          return next;
        });
      }
    });

    return Health.of({
      annotate,
      conditions,
      schedulable: (host) => conditions(host).pipe(Effect.map(isSchedulable)),
      unreachable: (host) =>
        Effect.all([contactOf(host), Clock.currentTimeMillis]).pipe(
          Effect.map(([contact, now]) => isUnreachable(contact, now, thresholds)),
        ),
      evictable: (host) =>
        Effect.all([contactOf(host), Clock.currentTimeMillis]).pipe(
          Effect.map(([contact, now]) => isEvictable(contact, now, thresholds)),
        ),
      draining: (host) =>
        store.read.pipe(
          Effect.map((document) => {
            const state = document.hosts.find((candidate) => candidate.host === host);
            return state?.drainingAt == null ? null : { force: state.drainForce };
          }),
        ),
      candidates: Ref.get(contacts).pipe(
        Effect.map((all) => [...all].map(([host, contact]) => ({ host, sample: contact.sample }))),
      ),
      cordon: (host, reason) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            setHost(host, (state) => ({
              ...state,
              cordonedAt: state.cordonedAt ?? now,
              cordonReason: reason ?? state.cordonReason,
            })),
          ),
        ),
      uncordon: (host) => setHost(host, () => null),
      drain: (host, force) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            setHost(host, (state) => ({
              ...state,
              cordonedAt: state.cordonedAt ?? now,
              cordonReason: state.cordonReason ?? "Draining.",
              drainingAt: state.drainingAt ?? now,
              drainForce: state.drainForce || force,
            })),
          ),
        ),
      tick,
    });
  });

type FleetHostStateLike = FleetHealthStore.FleetHostState;

/** Samples every connected host the way the Hosts panel does: reads only, this machine's keys. */
const liveSample = Effect.gen(function* () {
  const status = yield* HostStatusMcpService.HostStatusMcpService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  return status
    .readForClient({
      environmentId: descriptor.environmentId,
      sessionId: "fleet-health",
      reachHosts: true,
    })
    .pipe(Effect.orElseSucceed((): GoatHostStatusResult => ({ hosts: [] })));
});

export const layer = Layer.effect(
  Health,
  Effect.gen(function* () {
    const sample = yield* liveSample;
    return yield* make({ sample });
  }),
);
