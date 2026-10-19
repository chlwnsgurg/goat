import {
  FleetWorkerPhase,
  ModelSelection,
  RuntimeMode,
  ThreadId,
  type FleetWorkerView,
} from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";

/**
 * Cordons, drains and self-healing workers, kept in one JSON file in the state directory like
 * launch watches. It is small (one row per opted-in worker and per cordoned host) and only this
 * process writes it, so a file avoids a migration that every sibling PR would renumber.
 */
export const FLEET_HEALTH_FILE = "fleet-health.json";

export const FleetHostState = Schema.Struct({
  host: Schema.String,
  cordonedAt: Schema.NullOr(Schema.Number),
  cordonReason: Schema.NullOr(Schema.String),
  drainingAt: Schema.NullOr(Schema.Number),
  drainForce: Schema.Boolean,
});
export type FleetHostState = typeof FleetHostState.Type;

/** An old binding a move left behind; it is told to stop once its host answers. */
export const FleetFencedBinding = Schema.Struct({
  host: Schema.String,
  threadId: ThreadId,
  generation: Schema.Number,
  stoppedAt: Schema.NullOr(Schema.Number),
});
export type FleetFencedBinding = typeof FleetFencedBinding.Type;

export const FleetMove = Schema.Struct({
  /** The generation the move creates. */
  generation: Schema.Number,
  targetHost: Schema.NullOr(Schema.String),
  reason: Schema.String,
  requestedAt: Schema.Number,
  /** The run that was current when the old thread was asked to push. */
  pushAfterRunId: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  /** Set before the remote launch starts; a later tick looks for that thread before relaunching. */
  launchStartedAt: Schema.NullOr(Schema.Number),
});
export type FleetMove = typeof FleetMove.Type;

export const FleetWorker = Schema.Struct({
  workerId: Schema.String,
  /** The launcher thread whose runtime mode caps every action; null for an outside caller. */
  launcherThreadId: Schema.NullOr(ThreadId),
  /** The outside caller's approved runtime mode, used when there is no launcher thread. */
  ceiling: RuntimeMode,
  host: Schema.String,
  threadId: ThreadId,
  generation: Schema.Number,
  rootBranch: Schema.String,
  branch: Schema.String,
  cwd: Schema.String,
  canonicalKey: Schema.NullOr(Schema.String),
  title: Schema.String,
  message: Schema.NullOr(Schema.String),
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  phase: FleetWorkerPhase,
  attempts: Schema.Number,
  steersThisEpisode: Schema.Number,
  restartsThisEpisode: Schema.Number,
  lastProgressAt: Schema.NullOr(Schema.Number),
  nextAttemptAt: Schema.NullOr(Schema.Number),
  lastReason: Schema.NullOr(Schema.String),
  move: Schema.NullOr(FleetMove),
  fenced: Schema.Array(FleetFencedBinding),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type FleetWorker = typeof FleetWorker.Type;

export const FleetHealthDocument = Schema.Struct({
  version: Schema.Literal(1),
  hosts: Schema.Array(FleetHostState),
  workers: Schema.Array(FleetWorker),
});
export type FleetHealthDocument = typeof FleetHealthDocument.Type;

const emptyDocument: FleetHealthDocument = { version: 1, hosts: [], workers: [] };
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(FleetHealthDocument));
const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(FleetHealthDocument));

export const workerView = (worker: FleetWorker): FleetWorkerView => ({
  workerId: worker.workerId,
  host: worker.host,
  threadId: worker.threadId,
  generation: worker.generation,
  branch: worker.branch,
  phase: worker.phase,
  attempts: worker.attempts,
  lastReason: worker.lastReason,
  nextAttemptAt:
    worker.nextAttemptAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(worker.nextAttemptAt)),
});

export interface FleetHealthStoreShape {
  readonly read: Effect.Effect<FleetHealthDocument>;
  /** Applies f under one lock and persists the result before returning it. */
  readonly update: <A>(
    f: (document: FleetHealthDocument) => readonly [A, FleetHealthDocument],
  ) => Effect.Effect<A>;
}

export class FleetHealthStore extends Context.Service<FleetHealthStore, FleetHealthStoreShape>()(
  "goat/fleet/health/FleetHealthStore",
) {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, FLEET_HEALTH_FILE);
  const lock = yield* Semaphore.make(1);
  const initial = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeDocument),
    Effect.catch((error) =>
      fs.exists(filePath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((exists) =>
          exists
            ? Effect.logWarning("fleet health state unreadable; starting empty", {
                cause: String(error),
              })
            : Effect.void,
        ),
        Effect.as(emptyDocument),
      ),
    ),
  );
  const state = yield* Ref.make(initial);

  const persist = (document: FleetHealthDocument) =>
    encodeDocument(document).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath, contents: contents + "\n" }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      ),
      // The in-memory state stays authoritative; the next change retries the write.
      Effect.catch((error) =>
        Effect.logWarning("fleet health state not saved", { cause: String(error) }),
      ),
    );

  const update: FleetHealthStoreShape["update"] = (f) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const [result, next] = f(yield* Ref.get(state));
        yield* Ref.set(state, next);
        yield* persist(next);
        return result;
      }),
    );

  return FleetHealthStore.of({ read: Ref.get(state), update });
});

export const layer = Layer.effect(FleetHealthStore, make);
