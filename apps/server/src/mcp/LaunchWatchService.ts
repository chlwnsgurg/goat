import {
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitResult,
  type ProjectId,
  type RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import {
  addPendingRun,
  EXCERPT_MAX_CHARS,
  finishedWake,
  goneWake,
  isTerminalStatus,
  type LaunchWatch,
  LaunchWatchDocument,
  launchWatchId,
  type LaunchWatchTerminalStatus,
  type LaunchWatchWake,
  newLaunchWatch,
  normalizeHost,
  outageWake,
  questionKey,
  questionWake,
  recordContact,
  recordFailure,
  recordQuestion,
  settleRun,
} from "./launchWatch.ts";

/**
 * Wakes a thread when a thread it launched finishes, so orchestrators do not
 * poll. The launcher's server records a watch at launch time and follows each
 * pending run over the connection it already has: this environment's
 * projections, or the SSH-dispatched MCP session of the target's host,
 * authorized as the launcher. A followed run that ends, a question the thread
 * waits on, and a host that stays unreachable each queue one message on the
 * launcher. Watches live in a JSON file under the state directory, so they
 * survive restarts without a database migration.
 */

/** How long one local wait lasts before the follower looks for pending questions. */
const LOCAL_TICK_MS = 30_000;
/** The same for a remote thread; each tick is one long-poll over SSH. */
const REMOTE_TICK_MS = 2 * 60_000;
/** Extra time a remote wait gets to answer after its own timeout. */
const REMOTE_ANSWER_MARGIN_MS = 60_000;
/** Bound on one whole remote step, including SSH setup. */
const REMOTE_STEP_LIMIT_MS = REMOTE_TICK_MS + 3 * 60_000;
const REMOTE_READ_TIMEOUT_MS = 60_000;
/** A watch with nothing left to report is dropped this long after its last change. */
const DORMANT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Pause before retrying after a changed caller, an unqueued wake or an unsaved state. */
const RETRY_MS = 30_000;
const TAIL_WINDOW = 40;
const TAIL_PAGE = 20;
const TAIL_PAGES = 3;

export class LaunchWatchStoreError extends Data.TaggedError("LaunchWatchStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface LaunchWatchTarget {
  readonly launcherThreadId: ThreadId;
  readonly host: string | null | undefined;
  readonly threadId: ThreadId;
}

export interface LaunchWatchServiceShape {
  /**
   * Starts watching, or adds a run to an existing watch. A null run leaves a
   * new watch dormant until the launcher's next send to the thread.
   */
  readonly register: (
    input: LaunchWatchTarget & {
      readonly projectId: ProjectId | null;
      readonly title: string | null;
      readonly runId: RunId | null;
    },
  ) => Effect.Effect<LaunchWatch, LaunchWatchStoreError>;
  /** Adds a run to an existing watch; without a watch it does nothing. */
  readonly rearm: (
    input: LaunchWatchTarget & { readonly runId: RunId },
  ) => Effect.Effect<void, LaunchWatchStoreError>;
  readonly unwatch: (input: LaunchWatchTarget) => Effect.Effect<boolean, LaunchWatchStoreError>;
  readonly list: (launcherThreadId: ThreadId) => Effect.Effect<ReadonlyArray<LaunchWatch>>;
}

export class LaunchWatchService extends Context.Service<
  LaunchWatchService,
  LaunchWatchServiceShape
>()("t3/mcp/LaunchWatchService") {}

export const LAUNCH_WATCH_FILE = "thread-launch-watches.json";

/** What one follower step learned about the run it follows. */
type StepResult =
  | { readonly _tag: "Terminal"; readonly status: LaunchWatchTerminalStatus }
  | {
      readonly _tag: "Running";
      readonly questions: ReadonlyArray<{ readonly id: string; readonly kind: string | null }>;
    }
  | { readonly _tag: "RunMissing" }
  | { readonly _tag: "Gone"; readonly reason: string }
  | { readonly _tag: "LauncherGone" }
  | { readonly _tag: "CallerChanged" }
  | { readonly _tag: "Unreachable"; readonly error: string };

interface Details {
  readonly title: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly excerpt: string | null;
}

const noDetails: Details = { title: null, branch: null, worktreePath: null, excerpt: null };

class LauncherGone extends Data.TaggedError("LauncherGone")<{}> {}

/** Orchestrator refusals that a retry of the same command cannot change. */
const PERMANENT_DISPATCH_ERRORS = new Set([
  "OrchestratorCommandPreviouslyRejectedError",
  "OrchestratorCommandRejectedError",
  "OrchestratorSubagentThreadReadOnlyError",
  "OrchestratorThreadAboveModeLimitError",
]);

const isPermanentDispatchFailure = (cause: Cause.Cause<unknown>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      PERMANENT_DISPATCH_ERRORS.has(String(error._tag)),
  });

const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(LaunchWatchDocument));
const decodeWait = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);
const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeRequestIds = Schema.decodeUnknownEffect(
  Schema.Struct({ requestIds: Schema.Array(Schema.String) }),
);

const describe = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

const lastText = (texts: ReadonlyArray<string | null | undefined>) =>
  texts.findLast((text): text is string => typeof text === "string" && text.trim().length > 0) ??
  null;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const layerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const statePath = path.join(config.stateDir, LAUNCH_WATCH_FILE);

  let watches = new Map<string, LaunchWatch>();
  /** One follower per watch with runs to report; only touched while holding the lock. */
  const followers = new Map<
    string,
    { readonly incarnation: string; fiber: Fiber.Fiber<void> | undefined }
  >();

  const locked = lock.withPermits(1);

  const persist = (next: Map<string, LaunchWatch>) =>
    writeFileStringAtomically({
      filePath: statePath,
      contents: `${JSON.stringify({ version: 1, watches: [...next.values()] })}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new LaunchWatchStoreError({
            message: `Could not save launch watches: ${describe(cause)}`,
            cause,
          }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          watches = next;
        }),
      ),
    );

  /** Applies one change to the map and saves it; memory moves only after the write lands. */
  const save = (change: (current: Map<string, LaunchWatch>) => void) => {
    const next = new Map(watches);
    change(next);
    return persist(next);
  };

  const load = Effect.gen(function* () {
    const raw = yield* fs.readFileString(statePath).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(error),
      ),
    );
    if (Option.isNone(raw) || raw.value.trim().length === 0) return [];
    const decoded = yield* Effect.result(decodeDocument(raw.value));
    if (decoded._tag === "Success") return decoded.success.watches;
    // Keep the unreadable file for inspection instead of overwriting it.
    const aside = `${statePath}.corrupt-${yield* Clock.currentTimeMillis}`;
    yield* fs.rename(statePath, aside);
    yield* Effect.logWarning("launch watches: unreadable state file moved aside", {
      path: aside,
      cause: decoded.failure,
    });
    return [];
  });

  // ── following ────────────────────────────────────────────────────────

  /** The launcher's runtime mode; a remote call never asks for more. */
  const launcherCeiling = (watch: LaunchWatch) =>
    threads
      .getThreadShell(watch.launcherThreadId)
      .pipe(
        Effect.flatMap((shell): Effect.Effect<RuntimeMode, LauncherGone> =>
          shell === null || shell.deletedAt !== null || shell.archivedAt !== null
            ? Effect.fail(new LauncherGone())
            : Effect.succeed(shell.runtimeMode),
        ),
      );

  const callHost = (
    watch: LaunchWatch,
    host: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ) =>
    ssh.callHostTool(
      { host, tool, arguments: args, writes: false, timeoutMs },
      launcherCeiling(watch),
    );

  const localStep = (watch: LaunchWatch, runId: RunId) =>
    Effect.gen(function* () {
      yield* launcherCeiling(watch);
      const shell = yield* threads.getThreadShell(watch.threadId);
      if (shell === null || shell.deletedAt !== null) {
        return { _tag: "Gone", reason: "the thread was deleted." } satisfies StepResult;
      }
      if (shell.archivedAt !== null) {
        return { _tag: "Gone", reason: "the thread was archived." } satisfies StepResult;
      }
      const waited = yield* threads
        .waitForThread({
          projectId: watch.projectId ?? shell.projectId,
          threadId: watch.threadId,
          runId,
          timeoutMs: LOCAL_TICK_MS,
        })
        .pipe(
          Effect.map((result) => ({ _tag: "Waited", result }) as const),
          Effect.catchTags({
            ThreadManagementRunNotFoundError: () => Effect.succeed({ _tag: "RunMissing" } as const),
            ThreadManagementThreadNotFoundError: () =>
              Effect.succeed({ _tag: "ThreadMissing" } as const),
          }),
        );
      if (waited._tag === "RunMissing") return { _tag: "RunMissing" } satisfies StepResult;
      if (waited._tag === "ThreadMissing") {
        return { _tag: "Gone", reason: "the thread was deleted." } satisfies StepResult;
      }
      const status = waited.result.run?.status;
      if (status !== undefined && isTerminalStatus(status)) {
        return { _tag: "Terminal", status } satisfies StepResult;
      }
      const records = yield* threads.getThreadRecords(watch.threadId, ["runtimeRequests"]);
      const questions = records.runtimeRequests
        .filter((request) => request.status === "pending" && request.kind !== "dynamic_tool_call")
        .map((request) => ({ id: request.id as string, kind: request.kind as string }));
      return { _tag: "Running", questions } satisfies StepResult;
    }).pipe(
      Effect.catchTags({
        LauncherGone: () => Effect.succeed({ _tag: "LauncherGone" } satisfies StepResult),
      }),
      Effect.catch((error) =>
        Effect.succeed({ _tag: "Unreachable", error: describe(error) } satisfies StepResult),
      ),
    );

  const remoteFailure = (error: unknown): StepResult => {
    if (error instanceof LauncherGone) return { _tag: "LauncherGone" };
    if (error instanceof SshRemoteDispatch.SshRemoteDispatchError) {
      if (error.reason === "caller_changed") return { _tag: "CallerChanged" };
      if (error.reason === "remote_refused" && error.remoteCode === "thread_not_found") {
        return { _tag: "Gone", reason: `${error.message}` };
      }
      if (error.reason === "remote_refused" && error.remoteCode === "run_not_found") {
        return { _tag: "RunMissing" };
      }
    }
    return { _tag: "Unreachable", error: describe(error) };
  };

  const remoteStep = (watch: LaunchWatch, host: string, runId: RunId) =>
    Effect.gen(function* () {
      const waited = yield* callHost(
        watch,
        host,
        "goat_thread_wait",
        { threadId: watch.threadId, runId, timeoutMs: REMOTE_TICK_MS },
        REMOTE_TICK_MS + REMOTE_ANSWER_MARGIN_MS,
      ).pipe(Effect.flatMap(decodeWait));
      if (!waited.timedOut && isTerminalStatus(waited.status)) {
        return { _tag: "Terminal", status: waited.status } satisfies StepResult;
      }
      // Only user questions are listed remotely; approvals show up when the run ends.
      const questions = yield* callHost(
        watch,
        host,
        "goat_pending_request_list",
        { threadId: watch.threadId },
        REMOTE_READ_TIMEOUT_MS,
      ).pipe(
        Effect.flatMap(decodeRequestIds),
        Effect.map((listed) => listed.requestIds.map((id) => ({ id, kind: "user_input" }))),
        Effect.catch((error) =>
          error instanceof LauncherGone
            ? Effect.fail(error)
            : Effect.logDebug("launch watch: pending requests unreadable", {
                host,
                cause: error,
              }).pipe(Effect.as([])),
        ),
      );
      return { _tag: "Running", questions } satisfies StepResult;
    }).pipe(
      Effect.timeoutOption(REMOTE_STEP_LIMIT_MS),
      Effect.map((result) =>
        Option.getOrElse(result, (): StepResult => ({
          _tag: "Unreachable",
          error: `${host} did not answer in time.`,
        })),
      ),
      Effect.catch((error) => Effect.succeed(remoteFailure(error))),
    );

  const localDetails = (watch: LaunchWatch, runId: RunId) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(watch.threadId);
      const records = yield* threads.getThreadRecords(watch.threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [runId],
      });
      return {
        title: shell?.title ?? null,
        branch: shell?.branch ?? null,
        worktreePath: shell?.worktreePath ?? null,
        excerpt: lastText(records.messages.map((message) => message.text)),
      } satisfies Details;
    });

  /**
   * Reads the end of a remote transcript for the followed run's last answer.
   * Positions count every visible item while the messages view only filters,
   * so the read starts a fixed window before the end.
   */
  const remoteDetails = (watch: LaunchWatch, host: string, runId: RunId) =>
    Effect.gen(function* () {
      const read = (args: Record<string, unknown>) =>
        callHost(
          watch,
          host,
          "goat_thread_read",
          { threadId: watch.threadId, ...args },
          REMOTE_READ_TIMEOUT_MS,
        ).pipe(Effect.flatMap(decodeRead));
      const head = yield* read({ view: "messages", limit: 1, runLimit: 1 });
      const start = head.thread.itemCount - TAIL_WINDOW - 1;
      let afterPosition: number | undefined = start < 0 ? undefined : start;
      const texts: Array<string | null> = [];
      for (let page = 0; page < TAIL_PAGES; page++) {
        const result = yield* read({
          view: "messages",
          limit: TAIL_PAGE,
          maxCharsPerItem: EXCERPT_MAX_CHARS,
          ...(afterPosition === undefined ? {} : { afterPosition }),
        });
        for (const item of result.items) {
          if (item.type === "assistant_message" && item.runId === runId) texts.push(item.text);
        }
        if (!result.hasMore || result.nextPosition === null) break;
        afterPosition = result.nextPosition;
      }
      return {
        title: head.thread.title,
        branch: head.thread.branch,
        worktreePath: head.thread.worktreePath,
        excerpt: lastText(texts),
      } satisfies Details;
    });

  /** Details make a wake more useful but never hold it back. */
  const detailsFor = (watch: LaunchWatch, runId: RunId) =>
    (watch.host === null
      ? localDetails(watch, runId)
      : remoteDetails(watch, watch.host, runId)
    ).pipe(
      Effect.timeoutOption(REMOTE_READ_TIMEOUT_MS * 2),
      Effect.map(Option.getOrElse(() => noDetails)),
      Effect.catch((error) =>
        Effect.logDebug("launch watch: details unavailable", {
          watchId: watch.id,
          cause: error,
        }).pipe(Effect.as(noDetails)),
      ),
    );

  const wake = (watch: LaunchWatch, message: LaunchWatchWake) =>
    threads.dispatch({
      type: "message.dispatch",
      commandId: message.commandId,
      threadId: watch.launcherThreadId,
      messageId: message.messageId,
      text: message.text,
      notification: message.notification,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });

  /**
   * Sends a wake. A refusal the orchestrator will repeat counts as delivered,
   * with a warning; anything else (a storage failure) is reported as
   * undelivered so the obligation stays and is tried again.
   */
  const deliver = (watch: LaunchWatch, message: LaunchWatchWake) =>
    wake(watch, message).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : isPermanentDispatchFailure(cause)
            ? Effect.logWarning("launch watch: wake refused", {
                watchId: watch.id,
                commandId: message.commandId,
                cause,
              }).pipe(Effect.as(true))
            : Effect.logWarning("launch watch: wake failed, will retry", {
                watchId: watch.id,
                commandId: message.commandId,
                cause,
              }).pipe(Effect.as(false)),
      ),
    );

  const releaseSlot = (watchId: string, incarnation: string) => {
    if (followers.get(watchId)?.incarnation === incarnation) followers.delete(watchId);
  };

  /** Starts a follower when a watch has runs to report and none is running. Call with the lock held. */
  const ensureFollower = (watch: LaunchWatch) =>
    Effect.gen(function* () {
      if (watch.pendingRuns.length === 0 || followers.has(watch.id)) return;
      const slot: { readonly incarnation: string; fiber: Fiber.Fiber<void> | undefined } = {
        incarnation: watch.incarnation,
        fiber: undefined,
      };
      followers.set(watch.id, slot);
      slot.fiber = yield* follow(watch.id, watch.incarnation).pipe(Effect.forkIn(layerScope));
    });

  type Plan =
    | { readonly _tag: "Exit" }
    | { readonly _tag: "Sleep"; readonly ms: number }
    | { readonly _tag: "Follow"; readonly watch: LaunchWatch; readonly runId: RunId };

  const current = (watchId: string, incarnation: string) => {
    const watch = watches.get(watchId);
    return watch?.incarnation === incarnation ? watch : undefined;
  };

  /**
   * Applies a step result under the lock. Returns how long to pause before the
   * next step. A wake and the state recording it are not split by a shutdown:
   * stopping waits for both, so a restart does not repeat the wake.
   */
  const apply = (
    watchId: string,
    incarnation: string,
    runId: RunId,
    result: StepResult,
    details: Details,
  ) =>
    locked(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const watch = current(watchId, incarnation);
          if (watch === undefined || !watch.pendingRuns.includes(runId)) return 0;
          const now = yield* Clock.currentTimeMillis;
          switch (result._tag) {
            case "Terminal": {
              const delivered = yield* deliver(
                watch,
                finishedWake({ watch, runId, status: result.status, ...details }),
              );
              if (!delivered) return RETRY_MS;
              const title = details.title ?? watch.title;
              yield* save((map) =>
                map.set(watchId, { ...settleRun(recordContact(watch, now), runId, now), title }),
              );
              return 0;
            }
            case "Running": {
              let next = recordContact(watch, now);
              for (const question of result.questions) {
                const key = questionKey(runId, question.id);
                if (next.reportedQuestions.includes(key)) continue;
                const delivered = yield* deliver(
                  next,
                  questionWake({
                    watch: next,
                    runId,
                    requestId: question.id,
                    kind: question.kind,
                    title: null,
                  }),
                );
                if (delivered) next = recordQuestion(next, key, now);
              }
              if (next !== watch) yield* save((map) => map.set(watchId, next));
              return 0;
            }
            case "RunMissing":
              yield* Effect.logWarning("launch watch: followed run no longer exists", {
                watchId,
                runId,
              });
              yield* save((map) => map.set(watchId, settleRun(watch, runId, now)));
              return 0;
            case "Gone":
              yield* deliver(watch, goneWake({ watch, reason: result.reason }));
              yield* save((map) => map.delete(watchId));
              return 0;
            case "LauncherGone":
              yield* save((map) => map.delete(watchId));
              return 0;
            case "CallerChanged":
              return RETRY_MS;
            case "Unreachable":
              return yield* retryLater(watch, result.error);
          }
        }),
      ),
    );

  /** Records a failed contact, telling the launcher once per outage. Call with the lock held. */
  const retryLater = (watch: LaunchWatch, error: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { next, notify } = recordFailure(watch, now, error);
      let saved = next;
      if (notify && next.outage !== null) {
        const delivered = yield* deliver(next, outageWake({ watch: next, outage: next.outage }));
        if (!delivered) saved = { ...next, outage: { ...next.outage, notified: false } };
      }
      yield* save((map) => map.set(watch.id, saved));
      return Math.max(0, (saved.outage?.nextRetryAt ?? now) - now);
    });

  const plan = (watchId: string, incarnation: string) =>
    locked(
      Effect.gen(function* () {
        const watch = current(watchId, incarnation);
        const runId = watch?.pendingRuns[0];
        if (watch === undefined || runId === undefined) {
          releaseSlot(watchId, incarnation);
          return { _tag: "Exit" } satisfies Plan;
        }
        const now = yield* Clock.currentTimeMillis;
        if (watch.outage !== null && watch.outage.nextRetryAt > now) {
          return { _tag: "Sleep", ms: watch.outage.nextRetryAt - now } satisfies Plan;
        }
        return { _tag: "Follow", watch, runId } satisfies Plan;
      }),
    );

  /** Follows one watch's pending runs until none is left or the watch goes away. */
  const follow = (watchId: string, incarnation: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (true) {
        const next = yield* plan(watchId, incarnation);
        if (next._tag === "Exit") return;
        if (next._tag === "Sleep") {
          yield* Effect.sleep(next.ms);
          continue;
        }
        const { watch, runId } = next;
        const result =
          watch.host === null
            ? yield* localStep(watch, runId)
            : yield* remoteStep(watch, watch.host, runId);
        const details = result._tag === "Terminal" ? yield* detailsFor(watch, runId) : noDetails;
        const pause = yield* apply(watchId, incarnation, runId, result, details).pipe(
          Effect.catch((error) =>
            Effect.logWarning("launch watch: state not saved, will retry", {
              watchId,
              cause: error,
            }).pipe(Effect.as(RETRY_MS)),
          ),
        );
        if (pause > 0) yield* Effect.sleep(pause);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("launch watch follower stopped", { watchId, cause }).pipe(
              Effect.andThen(locked(Effect.sync(() => releaseSlot(watchId, incarnation)))),
            ),
      ),
    );

  // ── public operations ────────────────────────────────────────────────

  const keyOf = (input: LaunchWatchTarget) => {
    const host = normalizeHost(input.host);
    return { host, id: launchWatchId({ ...input, host }) };
  };

  const register: LaunchWatchServiceShape["register"] = (input) =>
    locked(
      Effect.gen(function* () {
        const { host, id } = keyOf(input);
        const now = yield* Clock.currentTimeMillis;
        const existing = watches.get(id);
        const base =
          existing ??
          newLaunchWatch({
            launcherThreadId: input.launcherThreadId,
            host,
            threadId: input.threadId,
            projectId: input.projectId,
            title: input.title,
            incarnation: yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) =>
                  new LaunchWatchStoreError({ message: "Could not start a watch.", cause }),
              ),
            ),
            now,
          });
        const withMeta = {
          ...base,
          projectId: base.projectId ?? input.projectId,
          title: input.title ?? base.title,
        };
        const watch = input.runId === null ? withMeta : addPendingRun(withMeta, input.runId, now);
        yield* save((map) => map.set(id, watch));
        yield* ensureFollower(watch);
        return watch;
      }),
    );

  const rearm: LaunchWatchServiceShape["rearm"] = (input) =>
    locked(
      Effect.gen(function* () {
        const { id } = keyOf(input);
        const existing = watches.get(id);
        if (existing === undefined) return;
        const watch = addPendingRun(existing, input.runId, yield* Clock.currentTimeMillis);
        if (watch === existing) return;
        yield* save((map) => map.set(id, watch));
        yield* ensureFollower(watch);
      }),
    );

  const unwatch: LaunchWatchServiceShape["unwatch"] = (input) =>
    Effect.gen(function* () {
      const detached = yield* locked(
        Effect.gen(function* () {
          const { id } = keyOf(input);
          if (!watches.has(id)) return { removed: false, fiber: undefined } as const;
          yield* save((map) => map.delete(id));
          const slot = followers.get(id);
          followers.delete(id);
          return { removed: true, fiber: slot?.fiber } as const;
        }),
      );
      if (detached.fiber !== undefined) yield* Fiber.interrupt(detached.fiber);
      return detached.removed;
    });

  const list: LaunchWatchServiceShape["list"] = (launcherThreadId) =>
    Effect.sync(() =>
      [...watches.values()]
        .filter((watch) => watch.launcherThreadId === launcherThreadId)
        .toSorted((left, right) => right.updatedAt - left.updatedAt),
    );

  // ── start ────────────────────────────────────────────────────────────

  const loaded = yield* load.pipe(
    Effect.catch((error) =>
      Effect.logWarning("launch watches: state file unreadable, starting empty", {
        path: statePath,
        cause: error,
      }).pipe(Effect.as([] as ReadonlyArray<LaunchWatch>)),
    ),
  );
  const bootedAt = yield* Clock.currentTimeMillis;
  // Keep only watches that still owe a report or changed recently.
  watches = new Map(
    loaded
      .filter(
        (watch) =>
          watch.pendingRuns.length > 0 ||
          watch.outage !== null ||
          bootedAt - watch.updatedAt < DORMANT_RETENTION_MS,
      )
      .map((watch) => [watch.id, watch]),
  );
  yield* forkParked(
    locked(Effect.forEach([...watches.values()], ensureFollower, { discard: true })),
  );

  return LaunchWatchService.of({ register, rearm, unwatch, list });
});

export const layer = Layer.effect(LaunchWatchService, make);
