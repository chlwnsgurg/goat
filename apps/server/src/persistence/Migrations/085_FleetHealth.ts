import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Self-healing state (docs/internals/agentic-k8s.md "Persistence"): host cordons and replicas. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fleet_host_states (
    host TEXT PRIMARY KEY,
    cordoned INTEGER NOT NULL CHECK(cordoned IN (0,1)),
    draining INTEGER NOT NULL CHECK(draining IN (0,1)),
    reason TEXT,
    changed_by TEXT,
    changed_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE fleet_replicas (
    owner_key TEXT NOT NULL,
    generation INTEGER NOT NULL,
    ref TEXT NOT NULL,
    file TEXT NOT NULL,
    commit_oid TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, generation)
  )`;
});
