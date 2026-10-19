import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Cordon and drain per host, in fleet_host_states. Draining implies cordoned. This machine is
 * stored as "local". Read on demand: the table holds one row per host anyone cordoned.
 */
export const LOCAL_HOST = "local";

export interface FleetHostState {
  readonly host: string;
  readonly cordoned: boolean;
  readonly draining: boolean;
  readonly reason: string | null;
  readonly changedBy: string | null;
  readonly changedAt: string;
}

export interface FleetHostStatesShape {
  readonly get: (host: string) => Effect.Effect<FleetHostState | null>;
  readonly cordon: (input: {
    readonly host: string;
    readonly draining: boolean;
    readonly reason: string | null;
    readonly changedBy: string | null;
  }) => Effect.Effect<FleetHostState>;
  readonly uncordon: (host: string) => Effect.Effect<void>;
}

export class FleetHostStates extends Context.Service<FleetHostStates, FleetHostStatesShape>()(
  "goat/fleet/health/FleetHostStates",
) {}

interface Row {
  readonly host: string;
  readonly cordoned: number;
  readonly draining: number;
  readonly reason: string | null;
  readonly changed_by: string | null;
  readonly changed_at: string;
}

const fromRow = (row: Row): FleetHostState => ({
  host: row.host,
  cordoned: row.cordoned === 1,
  draining: row.draining === 1,
  reason: row.reason,
  changedBy: row.changed_by,
  changedAt: row.changed_at,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A store that cannot be read must not look like "nothing cordoned" to placement.
  const get: FleetHostStatesShape["get"] = (host) =>
    sql<Row>`SELECT * FROM fleet_host_states WHERE host = ${host}`.pipe(
      Effect.orDie,
      Effect.map((rows) => (rows[0] === undefined ? null : fromRow(rows[0]))),
    );

  return FleetHostStates.of({
    get,
    cordon: (input) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        // A drain stays a drain when someone cordons again; uncordon clears both.
        yield* sql`
          INSERT INTO fleet_host_states (host, cordoned, draining, reason, changed_by, changed_at)
          VALUES (${input.host}, 1, ${input.draining ? 1 : 0}, ${input.reason}, ${input.changedBy}, ${at})
          ON CONFLICT(host) DO UPDATE SET
            cordoned = 1,
            draining = MAX(fleet_host_states.draining, excluded.draining),
            reason = COALESCE(excluded.reason, fleet_host_states.reason),
            changed_by = excluded.changed_by,
            changed_at = excluded.changed_at
        `.pipe(Effect.orDie);
        return (yield* get(input.host))!;
      }),
    uncordon: (host) =>
      sql`DELETE FROM fleet_host_states WHERE host = ${host}`.pipe(Effect.orDie, Effect.asVoid),
  });
});

export const layer = Layer.effect(FleetHostStates, make);
