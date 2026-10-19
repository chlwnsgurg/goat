/**
 * ChannelReceptionService - reads one channel input and answers it right away.
 *
 * Each input gets its own pass with its own reception id; nothing waits on another input or on
 * a provider session. The model (a tool-free one-shot text generation) proposes a reply and an
 * action; this service checks the action against the ledger and the requester's permissions,
 * then commits the reply, any new task, and their deliveries in one transaction.
 *
 * The same service words task updates for the requester (`narrate`) when the ledger records a
 * result, failure, or question.
 *
 * @module ChannelReceptionService
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- reception ids only need a random UUID.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  CHANNEL_HOST_WORKSPACE_LABEL,
  type ChannelInputId,
  type ChannelConversationId,
  type ChannelReceptionHostFact,
  type ChannelReceptionInput,
  type ChannelReceptionRead,
  type ChannelReceptionReadResult,
  type ChannelReceptionResult,
  type ChannelReplyAddress,
  type ChannelRequester,
  type ChannelTask,
  ChannelReceptionId,
  CHANNEL_RECEPTION_TAIL_LIMITS,
  type ChannelOutboundKind,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { countHostThreads } from "../mcp/hostStatusModel.ts";
import * as MemoryAccess from "../memory/MemoryAccess.ts";
import * as MemoryService from "../memory/MemoryService.ts";
import * as MemorySyncService from "../memory/MemorySyncService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ChannelBotTimeline from "./ChannelBotTimeline.ts";
import { lowerRuntimeMode, mayAnswerFor } from "./ChannelGateway.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import * as ChannelWake from "./ChannelWake.ts";
import {
  appendChannelBotNote,
  channelBotFilesFor,
  listChannelBotSkills,
  quotedFromInput,
  readChannelBotNotes,
} from "./channelBotNotes.ts";
import {
  boundRecall,
  canSeeTask,
  journalFor,
  matchMemoryLines,
  matchTasks,
  pullRequestLabel,
  RECALL_MEMORY_LINES,
  RECALL_RESULT_CHARS,
  RECALL_TASK_SCAN,
  RECALL_THREAD_RUNS,
  taskDigest,
  threadDigest,
} from "./channelBotRecall.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { isOpenItem, pendingDigest, workItemState } from "./channelWorkQueue.ts";
import { sameRequester, WORKERS_PER_REQUESTER } from "./ChannelDispatcher.ts";
import {
  answerForwardIdsFor,
  deliveryIdFor,
  taskEventIdFor,
  taskIdFor,
  turnSteerIdsFor,
} from "./channelIds.ts";
import { botAddress, chipDelivery, makeTaskEvent, prepareTransition } from "./channelTaskWrites.ts";

/** How long a reception pass may take before the sender gets a failure note instead. */
const CHANNEL_RECEPTION_TIMEOUT_MS = 45_000;
/** How many recently active threads a reception pass sees by title. */
const CHANNEL_RECEPTION_RECENT_THREADS = 20;
/** How long one read may take before the answer says so and goes on without it. */
const CHANNEL_READ_TIMEOUT_MS = 5_000;

const GIB = 1024 ** 3;
const gib = (bytes: number) => (bytes / GIB).toFixed(bytes < 10 * GIB ? 1 : 0) + " GB";

/** macOS reports a Darwin kernel release; its major number maps to the macOS version. */
const macOsVersion = (release: string) => {
  const major = Number.parseInt(release, 10);
  if (!Number.isFinite(major) || major < 20) return "macOS (Darwin " + release + ")";
  return "macOS " + (major >= 25 ? major + 1 : major - 9) + " (Darwin " + release + ")";
};

const duration = (seconds: number) => {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return days + "d " + hours + "h";
  return hours > 0 ? hours + "h " + minutes + "m" : minutes + "m";
};

export class ChannelReceptionService extends Context.Service<
  ChannelReceptionService,
  {
    /** Answers one input. Does nothing when the input already finished or another pass owns it. */
    readonly receive: (
      inputId: ChannelInputId,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    /** Words one task update for the requester and commits its deliveries. */
    readonly narrate: (
      pending: ChannelLedger.ChannelPendingEvent,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
  }
>()("goat/channels/ChannelReceptionService") {}

const replyDelivery = (input: {
  readonly causeKey: string;
  readonly destination: ChannelReplyAddress;
  readonly kind: ChannelOutboundKind;
  readonly text: string;
  readonly inputId?: ChannelInputId | undefined;
  readonly task?: ChannelTask | undefined;
  readonly mentionActorId?: string | undefined;
  readonly options?: ReadonlyArray<string> | undefined;
}): ChannelLedger.ChannelOutboxInsert => {
  const deliveryId = deliveryIdFor(input.causeKey);
  const options = input.options === undefined || input.options.length === 0 ? [] : input.options;
  // The GOAT bot shows choices as buttons; other transports read them as a list.
  const buttons = input.destination.kind === "goat" && options.length > 0;
  const text =
    buttons || options.length === 0
      ? input.text
      : input.text + "\n" + options.map((option) => "• " + option).join("\n");
  return {
    deliveryId,
    causeKey: input.causeKey,
    ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
    ...(input.task === undefined ? {} : { taskId: input.task.taskId }),
    message: {
      deliveryId,
      destination: input.destination,
      kind: input.kind,
      text,
      ...(input.inputId === undefined ? {} : { inReplyToInputId: input.inputId }),
      ...(input.task === undefined
        ? {}
        : { taskId: input.task.taskId, taskVersion: input.task.version }),
      ...(input.mentionActorId === undefined ? {} : { mentionActorId: input.mentionActorId }),
      ...(buttons ? { options } : {}),
    },
  };
};

/** Slack replies tag the person; the GOAT bot and MCP do not. */
const mentionFor = (address: ChannelReplyAddress, externalActorId: string | undefined) =>
  address.kind === "slack" ? externalActorId : undefined;

/** Keeps the newest tail entries that fit the byte budget. */
const boundTail = (
  entries: ReadonlyArray<ChannelReceptionInput["tail"][number]>,
): ChannelReceptionInput["tail"] => {
  const kept: Array<ChannelReceptionInput["tail"][number]> = [];
  let bytes = 0;
  for (const entry of entries.toReversed()) {
    bytes += entry.text.length;
    if (bytes > CHANNEL_RECEPTION_TAIL_LIMITS.bytes) break;
    kept.unshift(entry);
  }
  return kept;
};

/**
 * The GOAT Bot turn a follow-up in this conversation steers: the newest turn whose coding thread
 * is running here. Messages in other conversations, or when no turn runs, start their own.
 */
export const turnToSteer = (tasks: ReadonlyArray<ChannelTask>): ChannelTask | undefined =>
  tasks
    .filter(
      (task) =>
        task.kind === "turn" &&
        task.status === "running" &&
        task.worker !== undefined &&
        task.worker.host === undefined &&
        task.target !== undefined,
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const timeline = yield* ChannelBotTimeline.ChannelBotTimeline;
  const wake = yield* ChannelWake.ChannelWake;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const remoteWorkers = yield* ChannelRemoteWorkers.ChannelRemoteWorkers;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const botFiles = channelBotFilesFor(path, serverConfig.stateDir);
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  // Absent in embeddings without memory; the bot then reads only its notes and the ledger.
  const memoryService = yield* Effect.serviceOption(MemoryService.MemoryService);
  const memorySync = yield* Effect.serviceOption(MemorySyncService.MemorySyncService);

  // Facts that do not change while the server runs.
  const linuxName =
    platform === "linux"
      ? yield* fileSystem.readFileString("/etc/os-release").pipe(
          Effect.map((text) => /^PRETTY_NAME="?([^"\n]+)"?/mu.exec(text)?.[1]),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
  const osName =
    platform === "darwin"
      ? macOsVersion(NodeOS.release())
      : platform === "win32"
        ? NodeOS.version()
        : (linuxName ?? NodeOS.type()) + " (kernel " + NodeOS.release() + ")";
  const cpus = NodeOS.cpus();
  const cpu = (cpus[0]?.model.trim() || "unknown CPU") + ", " + cpus.length + " cores";

  /** What reception knows about this machine, read fresh for each message. */
  const hostFacts = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ): Effect.Effect<ReadonlyArray<ChannelReceptionHostFact>> =>
    Effect.gen(function* () {
      const descriptor = yield* environment.getDescriptor;
      const hostname = NodeOS.hostname();
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const counts = countHostThreads(shells);
      const facts: Array<ChannelReceptionHostFact> = [
        {
          label: "Machine",
          value:
            descriptor.label === hostname
              ? hostname
              : descriptor.label + " (hostname " + hostname + ")",
        },
        { label: "Operating system", value: osName },
        { label: "Architecture", value: architecture },
        { label: "CPU", value: cpu },
        {
          label: "Memory",
          value: gib(NodeOS.totalmem()) + " total, " + gib(NodeOS.freemem()) + " free",
        },
        { label: "Up for", value: duration(NodeOS.uptime()) },
        { label: "GOAT version", value: packageJson.version },
        {
          label: "Local time",
          value:
            now.toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" }) +
            " (" +
            timeZone +
            ")",
        },
        {
          label: "Threads",
          value:
            counts.running +
            " running, " +
            counts.waiting +
            " waiting on a person, " +
            counts.queued +
            " queued",
        },
      ];
      return facts;
    }).pipe(Effect.orElseSucceed(() => []));

  /** Every project, with the bot's own workspace offered as the place for host-level work. */
  const allowedTargets = (botProjectId: string | undefined) =>
    Effect.gen(function* () {
      const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
      return shells.map((shell) => ({
        projectId: shell.id,
        label: shell.id === botProjectId ? CHANNEL_HOST_WORKSPACE_LABEL : shell.title,
      }));
    });

  const listThreads = threads
    .listProjectThreads({ projectId: undefined, includeSubagents: false })
    .pipe(Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2ThreadShell> => []));

  /** Newest first, leaving out the bot's own thread. Titles only; contents stay private. */
  const recentThreads = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    targets: ReadonlyArray<{ readonly projectId: string; readonly label: string }>,
    botThreadId: string | undefined,
  ) => {
    const labels = new Map(targets.map((target) => [target.projectId, target.label]));
    return shells
      .filter(
        (shell) =>
          shell.id !== botThreadId && shell.archivedAt === null && shell.title.trim() !== "",
      )
      .slice(0, CHANNEL_RECEPTION_RECENT_THREADS)
      .map((shell) => {
        const project = labels.get(shell.projectId)?.trim();
        return {
          title: shell.title.trim(),
          ...(project ? { project } : {}),
          working: shell.activeRunId !== null,
        };
      });
  };

  const generate = (input: ChannelReceptionInput) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      const generateReception = textGeneration.generateChannelReception;
      if (Option.isNone(settings) || generateReception === undefined) {
        return Option.none<ChannelReceptionResult>();
      }
      return yield* generateReception({
        cwd: serverConfig.stateDir,
        input,
        modelSelection: settings.value.textGenerationModelSelection,
      }).pipe(
        Effect.timeoutOption(CHANNEL_RECEPTION_TIMEOUT_MS),
        Effect.tapError((cause) => Effect.logWarning("channel reception failed", { cause })),
        Effect.orElseSucceed(() => Option.none<ChannelReceptionResult>()),
      );
    });

  /** Work that holds one of a person's worker slots. */
  const busyWork = ledger
    .listTasksByStatus(["dispatching", "running", "waiting_input"])
    .pipe(Effect.map((stored) => stored.map((entry) => entry.task)));

  /** The owner's newest tasks this requester may see. */
  const visibleTasks = (viewer: ChannelRequester, conversationId: ChannelConversationId) =>
    ledger
      .listTasks({ ownerId: viewer.ownerId, limit: RECALL_TASK_SCAN })
      .pipe(
        Effect.map((page) => page.tasks.filter((task) => canSeeTask(viewer, task, conversationId))),
      );

  /**
   * The scopes a requester holds now. A Slack or iMessage link is read again, so a link removed
   * or narrowed since the message arrived counts; an in-app requester keeps the scopes its
   * session had. Agents over MCP read GOAT memory with their own memory tools, not through the bot.
   */
  const scopesNow = (viewer: ChannelRequester, connectionId: string) =>
    Effect.gen(function* () {
      if (viewer.originKind === "mcp") return [];
      if (viewer.originKind !== "slack" && viewer.originKind !== "imessage") {
        return viewer.grantedScopes;
      }
      if (viewer.externalActorId === undefined) return [];
      const linked = yield* ledger.findIdentity({
        connectionId,
        externalActorId: viewer.externalActorId,
      });
      return linked === undefined || linked.principalId !== viewer.principalId
        ? []
        : viewer.grantedScopes.filter((scope) => linked.grantedScopes.includes(scope));
    });

  /**
   * The requester as reads judge them now. A Slack or iMessage link removed or moved to another
   * person since the message arrived leaves only this conversation's work visible.
   */
  const viewerNow = (requester: ChannelRequester, connectionId: string) =>
    Effect.gen(function* () {
      const scopes = yield* scopesNow(requester, connectionId).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );
      const external = requester.originKind === "slack" || requester.originKind === "imessage";
      const linkedNow =
        !external ||
        (requester.externalActorId !== undefined &&
          (yield* ledger
            .findIdentity({ connectionId, externalActorId: requester.externalActorId })
            .pipe(Effect.orElseSucceed(() => undefined)))?.principalId === requester.principalId);
      return {
        ...requester,
        grantedScopes: requester.grantedScopes.filter((scope) => scopes.includes(scope)),
        ...(linkedNow ? {} : { principalId: "unlinked:" + (requester.externalActorId ?? "") }),
      } satisfies ChannelRequester;
    });

  /**
   * GOAT memory items for a query, under the requester's memory access as it stands now. Empty
   * when memory is off, not set up, or the requester may not read it.
   */
  const searchGoatMemory = (viewer: ChannelRequester, connectionId: string, query: string) =>
    Effect.gen(function* () {
      if (Option.isNone(memoryService) || Option.isNone(memorySync)) return [];
      const live = scopesNow(viewer, connectionId);
      if (!(yield* live).includes("memory:read")) return [];
      const settings = yield* serverSettings.getSettings;
      if (!settings.memoryEnabled) return [];
      const readiness = yield* memorySync.value.readLocalReadiness();
      if (readiness.bootstrap !== "ready" || readiness.memorySpaceId === null) return [];
      const page = yield* memoryService.value.search(
        {
          memorySpaceId: readiness.memorySpaceId,
          query: query.trim().normalize("NFC"),
          limit: RECALL_MEMORY_LINES,
          mode: "fts",
        },
        MemoryAccess.memoryAccessPermit(
          {
            grantedScopes: viewer.grantedScopes,
            // Each permit check reads the link again and fails when it no longer allows reading.
            reauthorize: (required) =>
              live.pipe(
                Effect.orElseSucceed((): ReadonlyArray<string> => []),
                Effect.flatMap((scopes) =>
                  required.every((scope) => scopes.includes(scope))
                    ? Effect.void
                    : Effect.fail(new MemoryService.MemoryAccessError({ code: "unavailable" })),
                ),
              ),
            readOnly: true,
          },
          "read",
        ),
      );
      return page.items.flatMap((item) =>
        item.status === "active" ? ["- " + item.payload.text.replace(/\s+/gu, " ").trim()] : [],
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logInfo("GOAT Bot memory search skipped", { cause }).pipe(Effect.as([])),
      ),
    );

  const runRead = (
    read: ChannelReceptionRead,
    viewer: ChannelRequester,
    conversationId: ChannelConversationId,
    connectionId: string,
    inputId: ChannelInputId,
  ) =>
    Effect.gen(function* () {
      switch (read.kind) {
        case "memory": {
          const notes = yield* readChannelBotNotes(fileSystem, botFiles);
          // The whole visible journal is searched; only the prompt's copy is cut to size.
          const journal = journalFor(
            yield* visibleTasks(viewer, conversationId),
            RECALL_TASK_SCAN,
            Number.POSITIVE_INFINITY,
          );
          // Oldest first, as the notes are, so the newest matches survive the limit.
          const local = matchMemoryLines(
            notes + "\n" + journal.split("\n").toReversed().join("\n"),
            read.query,
          );
          const goat = yield* searchGoatMemory(viewer, connectionId, read.query);
          if (local.length === 0 && goat.length === 0) return "Nothing in memory matches.";
          return [
            ...(local.length === 0 ? [] : ["GOAT Bot notes and journal:", ...local]),
            ...(goat.length === 0 ? [] : ["GOAT memory:", ...goat]),
          ].join("\n");
        }
        case "work": {
          const matched = matchTasks(yield* visibleTasks(viewer, conversationId), read.query);
          return matched.length === 0
            ? "No work this person may see matches."
            : matched.map(taskDigest).join("\n\n");
        }
        case "thread": {
          const task = matchTasks(yield* visibleTasks(viewer, conversationId), read.query, 1)[0];
          if (task === undefined) return "No work this person may see matches.";
          const worker = task.worker;
          if (worker === undefined) {
            return taskDigest(task) + "\nIts coding thread has not started.";
          }
          if (worker.host !== undefined) {
            // Remote threads are read through their reports, which the ledger already holds.
            return (
              taskDigest(task) +
              "\nIts thread runs on " +
              worker.host +
              "; only its reports reach this machine."
            );
          }
          // Only the newest runs' messages are loaded; a long thread is never read whole.
          const { runs } = yield* threads.getThreadRecords(worker.threadId, ["runs"]);
          const recentRuns = runs.slice(-RECALL_THREAD_RUNS).map((run) => run.id);
          const records = yield* threads.getThreadRecords(worker.threadId, ["messages"], {
            messageRunIds: recentRuns,
          });
          const digest = taskDigest(task);
          return (
            digest +
            "\n" +
            threadDigest(
              records.thread.title || task.title,
              records.messages.map((message) => ({
                role: message.role,
                text: message.text,
                createdAt: DateTime.formatIso(message.createdAt),
              })),
              RECALL_RESULT_CHARS - digest.length - 1,
            )
          );
        }
        case "pending": {
          const visible = yield* visibleTasks(viewer, conversationId);
          const deliveries = yield* ledger.outcomeDeliveries(visible.map((task) => task.taskId));
          const items = visible.map((task) => ({
            task,
            state: workItemState(task, deliveries.get(task.taskId)),
          }));
          const open = items.filter((item) => isOpenItem(item.state));
          const runs = yield* ledger.listWorkerRuns(open.map((item) => item.task.taskId));
          const busy = yield* busyWork;
          return pendingDigest(
            open.map((item) => ({
              ...item,
              runs: runs.filter((run) => run.taskId === item.task.taskId),
              ...(item.state === "queued" &&
              busy.filter((other) => sameRequester(other.requester, item.task.requester)).length >=
                WORKERS_PER_REQUESTER
                ? {
                    note:
                      "waiting for one of the " +
                      WORKERS_PER_REQUESTER +
                      " running for " +
                      item.task.requester.displayName +
                      " to finish",
                  }
                : {}),
            })),
            DateTime.toEpochMillis(yield* DateTime.now),
          );
        }
        case "conversation": {
          const found = yield* ledger.searchConversation(conversationId, read.query, 5, inputId);
          return found.length === 0
            ? "No earlier message in this conversation matches."
            : found
                .map(
                  (entry) =>
                    "- " +
                    entry.receivedAt.slice(0, 16) +
                    " Person: " +
                    entry.text +
                    (entry.replyText === undefined ? "" : "\n  GOAT: " + entry.replyText),
                )
                .join("\n");
        }
      }
    });

  /** Runs one pass's reads. A read that fails says so instead of failing the reply. */
  const runReads = (
    reads: ReadonlyArray<ChannelReceptionRead>,
    viewer: ChannelRequester,
    conversationId: ChannelConversationId,
    connectionId: string,
    inputId: ChannelInputId,
  ): Effect.Effect<ReadonlyArray<ChannelReceptionReadResult>> =>
    Effect.forEach(
      reads,
      (read) =>
        runRead(read, viewer, conversationId, connectionId, inputId).pipe(
          Effect.timeoutOption(CHANNEL_READ_TIMEOUT_MS),
          Effect.map((text) => ({
            kind: read.kind,
            query: read.query,
            text: Option.match(text, {
              onNone: () => "(took too long to read)",
              onSome: boundRecall,
            }),
          })),
          Effect.catch((cause) =>
            Effect.logWarning("GOAT Bot read failed", { kind: read.kind, cause }).pipe(
              Effect.as({ kind: read.kind, query: read.query, text: "(could not be read)" }),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );

  const receive: ChannelReceptionService["Service"]["receive"] = (inputId, owner) =>
    Effect.gen(function* () {
      const isHome = yield* home.requireHome.pipe(
        Effect.as(true),
        Effect.catchTags({
          ChannelGatewayError: (error) =>
            error.reason === "not_home"
              ? Effect.succeed(false)
              : Effect.fail(
                  new ChannelLedger.ChannelLedgerError({
                    reason: "persistence",
                    detail: "GOAT Bot home settings could not be read.",
                  }),
                ),
        }),
      );
      const receptionId = ChannelReceptionId.make("channel-reception:" + NodeCrypto.randomUUID());
      const readAt = DateTime.formatIso(yield* DateTime.now);
      const stored = yield* ledger.beginReception({ owner, inputId, receptionId, readAt });
      if (stored === undefined || stored.requester === undefined) return;
      const message = stored.message;
      const requester = stored.requester;
      const conversationId = stored.snapshot.conversationId;
      const origin = message.replyAddress;
      const mention = mentionFor(origin, message.actor.externalActorId);

      if (!isHome) {
        yield* ledger.failReception({
          owner,
          inputId,
          receptionId,
          failure: { reason: "reception_failed", message: CHANNEL_COPY.botMoved },
          deliveries: [
            replyDelivery({
              causeKey: "reply:" + inputId,
              destination: origin,
              kind: "failure",
              text: CHANNEL_COPY.botMoved,
              inputId,
              mentionActorId: mention,
            }),
          ],
          now: readAt,
        });
        yield* wake.wake;
        return;
      }

      // The bot's copy of the message shows when reception started reading it.
      if (origin.kind === "goat") {
        yield* timeline
          .record({
            threadId: origin.threadId,
            record: {
              recordKey: "input:" + inputId,
              entry: {
                type: "message",
                role: "user",
                text: message.text,
                meta: {
                  conversationId,
                  originKind: "goat",
                  kind: "inbound",
                  inputId,
                  readAt: stored.snapshot.readAt ?? readAt,
                },
              },
            },
            revision: "read",
          })
          .pipe(Effect.ignore);
      }

      const tasks = yield* ledger.listConversationTasks(conversationId);
      const hosts = yield* remoteWorkers.knownHosts;
      const bot = (yield* ledger.getBot(stored.ownerId))?.bot;
      const targets = yield* allowedTargets(bot?.projectId);
      const decision: ChannelReceptionResult | undefined =
        message.intent === "answer" &&
        message.taskId !== undefined &&
        message.questionId !== undefined
          ? {
              replyText: CHANNEL_COPY.answerForwarded,
              action: {
                type: "answer_question",
                taskId: message.taskId,
                questionId: message.questionId,
                answer: message.text.trim() === "" ? "(no answer)" : message.text,
              },
            }
          : Option.getOrUndefined(
              yield* Effect.gen(function* () {
                const tail = yield* ledger.readConversationTail(
                  conversationId,
                  CHANNEL_RECEPTION_TAIL_LIMITS.messages,
                );
                const shells = yield* listThreads;
                const recent = recentThreads(shells, targets, bot?.threadId);
                const facts = yield* hostFacts(shells);
                const notes = yield* readChannelBotNotes(fileSystem, botFiles);
                // Everything this pass sees about other work is judged with the link as it is now.
                const viewer = yield* viewerNow(requester, message.connectionId);
                const journal = journalFor(
                  yield* visibleTasks(viewer, conversationId).pipe(
                    Effect.orElseSucceed((): ReadonlyArray<ChannelTask> => []),
                  ),
                );
                const skills = yield* listChannelBotSkills(fileSystem, path, botFiles);
                const base: ChannelReceptionInput = {
                  mode: "input",
                  conversationId,
                  originKind: message.kind,
                  inputText: message.text,
                  tail: boundTail(
                    tail.flatMap((entry) =>
                      entry.inputId === inputId
                        ? []
                        : [
                            { role: "user" as const, text: entry.text, at: entry.receivedAt },
                            ...(entry.replyText === undefined
                              ? []
                              : [
                                  {
                                    role: "assistant" as const,
                                    text: entry.replyText,
                                    at: entry.receivedAt,
                                  },
                                ]),
                          ],
                    ),
                  ),
                  tasks: tasks.map((task) => ({
                    taskId: task.taskId,
                    ...(task.kind === undefined ? {} : { kind: task.kind }),
                    title: task.title,
                    status: task.status,
                    ...(task.resultSummary === undefined
                      ? {}
                      : { resultSummary: task.resultSummary }),
                    ...((task.worker?.host ?? task.host) === undefined
                      ? {}
                      : { host: task.worker?.host ?? task.host }),
                    ...((task.observed?.pullRequests ?? []).length === 0
                      ? {}
                      : { pullRequests: task.observed!.pullRequests.map(pullRequestLabel) }),
                    openQuestions: task.openQuestions.map((question) => ({
                      questionId: question.questionId,
                      text: question.text,
                    })),
                  })),
                  allowedTargets: targets,
                  ...(hosts.length === 0 ? {} : { allowedHosts: hosts }),
                  ...(recent.length === 0 ? {} : { recentThreads: recent }),
                  ...(facts.length === 0 ? {} : { hostFacts: facts }),
                  ...(notes === "" ? {} : { notes }),
                  ...(journal === "" ? {} : { journal }),
                  ...(skills.length === 0 ? {} : { skills }),
                  requester,
                };
                const first = yield* generate({ ...base, readsAllowed: true });
                if (Option.isNone(first) || first.value.action.type !== "read") return first;
                // One round of reads, then the answer. Reads run within what this requester
                // may see; a second request to read is answered with what the pass wrote.
                // The first pass can take most of a minute; judge the link again before reading.
                const reader = yield* viewerNow(requester, message.connectionId);
                const results = yield* runReads(
                  first.value.action.reads,
                  reader,
                  conversationId,
                  message.connectionId,
                  inputId,
                );
                // The first pass wrote its queries from what it could see then. When the link
                // narrowed since, a query may quote work the person can no longer see.
                const narrowed =
                  reader.principalId !== viewer.principalId ||
                  viewer.grantedScopes.some((scope) => !reader.grantedScopes.includes(scope));
                const readResults = narrowed
                  ? results.map((result) => ({ ...result, query: "(withheld)" }))
                  : results;
                const journalNow = journalFor(
                  yield* visibleTasks(reader, conversationId).pipe(
                    Effect.orElseSucceed((): ReadonlyArray<ChannelTask> => []),
                  ),
                );
                const { journal: _journal, ...rest } = base;
                const second = yield* generate({
                  ...rest,
                  ...(journalNow === "" ? {} : { journal: journalNow }),
                  readsAllowed: false,
                  readResults,
                });
                // A pass that asks to read again found nothing to answer from; say so plainly.
                return Option.map(second, (result): ChannelReceptionResult =>
                  result.action.type === "read"
                    ? { replyText: CHANNEL_COPY.readFoundNothing, action: { type: "report_only" } }
                    : result,
                );
              }),
            );

      const now = DateTime.formatIso(yield* DateTime.now);
      if (decision === undefined) {
        yield* ledger.failReception({
          owner,
          inputId,
          receptionId,
          failure: { reason: "reception_failed", message: CHANNEL_COPY.receptionFailed },
          deliveries: [
            replyDelivery({
              causeKey: "reply:" + inputId,
              destination: origin,
              kind: "failure",
              text: CHANNEL_COPY.receptionFailed,
              inputId,
              mentionActorId: mention,
            }),
          ],
          now,
        });
        yield* wake.wake;
        return;
      }

      // Notes shape every later reply, so a note is kept only when a person asked for it in this
      // input: the quote the model returns must occur in the message itself, never in the tail.
      // This records the request; it does not prove intent, and it fails closed.
      const rememberRefusal =
        decision.remember === undefined
          ? undefined
          : requester.originKind === "mcp"
            ? "not_a_person"
            : decision.rememberQuote === undefined
              ? "missing_quote"
              : !quotedFromInput(decision.rememberQuote, message.text)
                ? "quote_not_in_input"
                : undefined;
      if (decision.remember !== undefined && rememberRefusal !== undefined) {
        yield* Effect.logInfo("GOAT Bot note dropped", { inputId, reason: rememberRefusal });
      }
      // Saved before the result commits so a restart re-runs this input and saves it then; the note
      // names its input, so a second pass for the same input does not add it twice.
      if (decision.remember !== undefined && rememberRefusal === undefined) {
        yield* appendChannelBotNote(fileSystem, botFiles, decision.remember, readAt, inputId).pipe(
          Effect.catch((cause) => Effect.logWarning("GOAT Bot note was not saved", { cause })),
        );
      }

      let replyText = decision.replyText;
      let finalDecision = decision;
      let createdTask:
        | { readonly task: ChannelTask; readonly event: ReturnType<typeof makeTaskEvent> }
        | undefined;
      const taskEvents: Array<ChannelLedger.ChannelTaskEventWrite> = [];
      const deliveries: Array<ChannelLedger.ChannelOutboxInsert> = [];
      const action = decision.action;

      let joining: ChannelTask | undefined;
      if (action.type === "create_task" || action.type === "run_turn") {
        // People start work; agents may only report on or answer existing work.
        const mayStart =
          requester.originKind !== "mcp" &&
          requester.grantedScopes.includes("orchestration:operate");
        // Busy input: asking for a turn while this conversation's turn runs joins that turn.
        joining = mayStart && action.type === "run_turn" ? turnToSteer(tasks) : undefined;
        // The task list was read before the model answered; join only a turn still running now.
        if (joining !== undefined) {
          const now = yield* ledger.getTask(joining.taskId);
          if (now?.task.status !== "running") joining = undefined;
        }
        if (!mayStart) {
          replyText = CHANNEL_COPY.agentCannotCreateWork;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else if (joining === undefined) {
          const taskId = taskIdFor(inputId, 0);
          // Only a task the person asked, in this input, to change or forget a note may edit them.
          const notesChangeRequested =
            action.notesChangeRequested !== undefined &&
            quotedFromInput(action.notesChangeRequested, message.text)
              ? action.notesChangeRequested
              : undefined;
          const task: ChannelTask = {
            taskId,
            ...(action.type === "run_turn" ? { kind: "turn" as const } : {}),
            conversationId,
            originBindingId: stored.snapshot.bindingId,
            originAddress: origin,
            originInputId: inputId,
            requester,
            title: action.title,
            instruction: action.instruction,
            status: "received",
            version: 1,
            generation: 1,
            ...(action.type !== "create_task" || action.projectId === undefined
              ? {}
              : { projectId: action.projectId }),
            // The dispatcher checks the host again before anything runs there.
            ...(action.type !== "create_task" || action.host === undefined
              ? {}
              : { host: action.host }),
            ...(notesChangeRequested === undefined ? {} : { notesChangeRequested }),
            openQuestions: [],
            createdAt: now,
            updatedAt: now,
          };
          createdTask = {
            task,
            event: makeTaskEvent(
              { ...task, version: 0 },
              {
                type: "task.created",
                payload: {
                  title: task.title,
                  instruction: task.instruction,
                  originInputId: inputId,
                  ...(notesChangeRequested === undefined ? {} : { notesChangeRequested }),
                },
              },
              now,
              { eventId: taskEventIdFor(taskId, 1) },
            ),
          };
          if (bot !== undefined) deliveries.push(chipDelivery(task, bot));
          const running = (yield* busyWork).filter((other) =>
            sameRequester(other.requester, requester),
          ).length;
          if (running >= WORKERS_PER_REQUESTER) {
            replyText +=
              " It's queued: " +
              running +
              " of your things are running, and it starts when one finishes.";
          }
        }
      }

      // The person as they stand now: a Slack link removed or narrowed since the message
      // arrived counts.
      const judgedNow = Effect.gen(function* () {
        if (message.kind !== "slack" && message.kind !== "imessage") return requester;
        const linked =
          requester.externalActorId === undefined
            ? undefined
            : yield* ledger.findIdentity({
                connectionId: message.connectionId,
                externalActorId: requester.externalActorId,
              });
        if (linked === undefined) return undefined;
        return {
          ...requester,
          runtimeModeCeiling: lowerRuntimeMode(
            requester.runtimeModeCeiling,
            linked.runtimeModeCeiling,
          ),
          grantedScopes: requester.grantedScopes.filter((scope) =>
            linked.grantedScopes.includes(scope),
          ),
        };
      });

      // A follow-up joins its workstream through the ledger: recorded here with the reply, then sent
      // by the dispatcher, which binds the task to the run that took it. Completion waits for that.
      const followTaskId = action.type === "follow_up" ? action.taskId : joining?.taskId;
      if (followTaskId !== undefined) {
        const storedTask = yield* ledger.getTask(followTaskId);
        const sender = requester.originKind === "mcp" ? undefined : yield* judgedNow;
        const running =
          storedTask !== undefined &&
          storedTask.task.conversationId === conversationId &&
          storedTask.task.status === "running" &&
          storedTask.task.worker !== undefined &&
          storedTask.task.worker.host === undefined;
        if (!running) {
          // The turn this message was joining ended after the check above. Retrying the input
          // starts the turn it asked for instead of dropping it.
          if (action.type === "run_turn") {
            return yield* new ChannelLedger.ChannelLedgerError({
              reason: "version_conflict",
              detail: "The turn this message was joining ended; reading it again.",
            });
          }
          replyText =
            action.type === "follow_up"
              ? "That work isn't running anymore. Tell me what you'd like done and I'll start it."
              : replyText;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else if (sender === undefined || !mayAnswerFor(sender, storedTask.task.requester)) {
          replyText = CHANNEL_COPY.answerNotAllowed;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else {
          const prepared = prepareTransition(
            storedTask,
            {
              type: "task.followup.received",
              payload: {
                inputId,
                text: message.text,
                from: sender.displayName,
                generation: storedTask.task.generation,
              },
            },
            now,
            bot,
            {
              actor: "user",
              eventId: taskEventIdFor(storedTask.task.taskId, storedTask.task.version + 1),
              forward: true,
              pendingAnswerMessageId: turnSteerIdsFor(inputId).messageId,
            },
          );
          if (prepared.ok) {
            taskEvents.push(prepared.write);
            deliveries.push(...prepared.deliveries);
            finalDecision = { replyText, action: { type: "follow_up", taskId: followTaskId } };
          } else {
            finalDecision = { replyText, action: { type: "report_only" } };
          }
        }
      }

      // Stopping records each stop with the reply; the dispatcher then stops the worker and its
      // subagents from the ledger, so a crash after the reply still stops them.
      if (action.type === "stop_work") {
        const sender = requester.originKind === "mcp" ? undefined : yield* judgedNow;
        const viewer = yield* viewerNow(requester, message.connectionId);
        const candidates =
          action.taskId === undefined
            ? yield* visibleTasks(viewer, conversationId)
            : (yield* visibleTasks(viewer, conversationId)).filter(
                (task) => task.taskId === action.taskId,
              );
        const stoppable = candidates.filter(
          (task) =>
            (task.status === "received" ||
              task.status === "dispatching" ||
              task.status === "running" ||
              task.status === "waiting_input") &&
            sender !== undefined &&
            mayAnswerFor(sender, task.requester),
        );
        const stopped: Array<string> = [];
        for (const task of stoppable) {
          const storedTask = yield* ledger.getTask(task.taskId);
          if (storedTask === undefined) continue;
          const prepared = prepareTransition(
            storedTask,
            {
              type: "task.cancelled",
              payload: { reason: "Stopped by " + sender!.displayName + "." },
            },
            now,
            bot,
            {
              actor: "user",
              eventId: taskEventIdFor(storedTask.task.taskId, storedTask.task.version + 1),
              narrate: true,
              forward: true,
            },
          );
          if (!prepared.ok) continue;
          taskEvents.push(prepared.write);
          deliveries.push(...prepared.deliveries);
          stopped.push(storedTask.task.title);
        }
        replyText =
          sender === undefined
            ? CHANNEL_COPY.agentCannotStopWork
            : stopped.length === 0
              ? "There's nothing running that you can stop."
              : "Stopping " + stopped.join(", ") + ".";
        finalDecision = { replyText, action };
      }

      if (action.type === "move_task") {
        const storedTask = yield* ledger.getTask(action.taskId);
        // Moving restarts work under the asker's ceiling, so the mover needs what an answerer needs.
        const mover = requester.originKind === "mcp" ? undefined : yield* judgedNow;
        if (requester.originKind === "mcp") {
          // Agents move work through channel_task_move, which checks their own ceiling.
          replyText = CHANNEL_COPY.agentCannotMoveWork;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else if (storedTask === undefined || storedTask.task.conversationId !== conversationId) {
          replyText = "I couldn’t match that to work in this conversation. Which task do you mean?";
          finalDecision = { replyText, action: { type: "clarify", question: replyText } };
        } else if (mover === undefined || !mayAnswerFor(mover, storedTask.task.requester)) {
          replyText = CHANNEL_COPY.agentCannotMoveWork;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else {
          finalDecision = yield* remoteWorkers
            .move({
              taskId: action.taskId,
              host: action.host,
              actor: "user",
              owner,
              callerCeiling: mover.runtimeModeCeiling,
            })
            .pipe(
              Effect.map((moved) => ({
                // The task's own narration explains the move; the reply only acknowledges it.
                replyText: "Moving it to " + moved.host + ".",
                action,
              })),
              Effect.catchTags({
                ChannelTaskMoveError: (error) =>
                  Effect.succeed({
                    replyText: error.message,
                    action: { type: "report_only" as const },
                  }),
              }),
            );
          replyText = finalDecision.replyText;
        }
      }

      if (action.type === "answer_question") {
        const answerer = yield* judgedNow;
        const stored = yield* ledger.getTask(action.taskId);
        const open =
          stored !== undefined &&
          stored.task.conversationId === conversationId &&
          stored.task.openQuestions.some((question) => question.questionId === action.questionId);
        if (stored === undefined || !open) {
          replyText = "I couldn't match that to an open question. Which task do you mean?";
          finalDecision = { replyText, action: { type: "clarify", question: replyText } };
        } else if (answerer === undefined || !mayAnswerFor(answerer, stored.task.requester)) {
          replyText = CHANNEL_COPY.answerNotAllowed;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else {
          const eventId = taskEventIdFor(stored.task.taskId, stored.task.version + 1);
          const hasWorker = stored.task.worker !== undefined;
          // A dispatcher question picks the project: match the answer to a project name or id.
          const answerText = action.answer.toLowerCase();
          // The longest matching name wins, so "goat-si" is not read as "goat".
          const matched = hasWorker
            ? undefined
            : (targets.find((target) => target.projectId === action.answer.trim()) ??
              targets
                .filter((target) => answerText.includes(target.label.toLowerCase()))
                .toSorted((left, right) => right.label.length - left.label.length)[0]);
          const prepared = prepareTransition(
            stored,
            {
              type: "task.question.answered",
              payload: { questionId: action.questionId, answer: action.answer },
            },
            now,
            bot,
            {
              actor: "user",
              eventId,
              ...(hasWorker
                ? { forward: true, pendingAnswerMessageId: answerForwardIdsFor(eventId).messageId }
                : {}),
              // A dispatcher question picks the project and may pick the machine: a known
              // host, or this one.
              ...(hasWorker
                ? {}
                : {
                    amend: (next: ChannelTask) => {
                      const machine = ChannelRemoteWorkers.meansThisMachine(action.answer)
                        ? null
                        : hosts
                            .filter((host) => answerText.includes(host.toLowerCase()))
                            .toSorted((left, right) => right.length - left.length)[0];
                      const { host: _host, ...rest } = next;
                      const placed =
                        machine === null
                          ? rest
                          : machine === undefined
                            ? next
                            : { ...rest, host: machine };
                      return matched === undefined
                        ? placed
                        : { ...placed, projectId: matched.projectId };
                    },
                  }),
            },
          );
          if (prepared.ok) {
            taskEvents.push(prepared.write);
            deliveries.push(...prepared.deliveries);
          }
        }
      }

      const relatedTask = createdTask?.task;
      deliveries.unshift(
        replyDelivery({
          causeKey: "reply:" + inputId,
          destination: origin,
          kind: finalDecision.action.type === "clarify" ? "question" : "receipt",
          text: replyText,
          inputId,
          task: relatedTask,
          mentionActorId: mention,
          options:
            finalDecision.action.type === "clarify" ? finalDecision.action.options : undefined,
        }),
      );

      const committed = yield* ledger.completeReception({
        owner,
        inputId,
        receptionId,
        replyText,
        decision: finalDecision,
        ...(createdTask === undefined ? {} : { createdTask }),
        taskEvents,
        deliveries,
        now,
      });
      if (!committed) {
        yield* Effect.logDebug("channel reception result dropped; a newer pass owns the input", {
          inputId,
          receptionId,
        });
      }
      yield* wake.wake;
    });

  const narrationFor = (task: ChannelTask, event: ChannelLedger.ChannelPendingEvent["event"]) => {
    switch (event.type) {
      case "task.completed":
        // A turn's summary is GOAT Bot's own answer, written for the person on the bot's model.
        if (task.kind === "turn") {
          return {
            kind: "result" as const,
            text: event.payload.summary.trim() === "" ? "Done." : event.payload.summary,
          };
        }
        return {
          kind: "result" as const,
          text:
            "Done: " +
            task.title +
            (event.payload.summary.trim() === "" ? "" : "\n" + event.payload.summary),
        };
      case "task.failed":
        return {
          kind: "failure" as const,
          text:
            "Couldn't finish: " +
            task.title +
            " — " +
            (event.payload.summary ?? event.payload.reason),
        };
      case "task.moved":
        return {
          kind: "receipt" as const,
          text:
            event.payload.fromHost +
            " stopped answering, so this continues on " +
            event.payload.host +
            " from the copy of its work taken at " +
            event.payload.replicaCapturedAt +
            ". Whatever it does on " +
            event.payload.fromHost +
            " after that stays there.",
        };
      case "task.cancelled":
        return { kind: "failure" as const, text: "Stopped: " + task.title };
      case "task.question.opened":
        return {
          kind: "question" as const,
          text: event.payload.question.text,
          options: event.payload.question.options,
        };
      default:
        return undefined;
    }
  };

  const narrate: ChannelReceptionService["Service"]["narrate"] = (pending, owner) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getTask(pending.event.taskId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const base = stored === undefined ? undefined : narrationFor(stored.task, pending.event);
      if (stored === undefined || base === undefined) {
        yield* ledger.completeNarration({ owner, sequence: pending.sequence, deliveries: [], now });
        return;
      }
      const task = stored.task;
      // The requester's own words set the reply's language; the worker's summary may use another.
      const request = yield* ledger.getInput(task.originInputId);
      const requestTail =
        request === undefined
          ? []
          : [{ role: "user" as const, text: request.message.text, at: request.message.receivedAt }];
      // Questions and a turn's answer keep their exact words; other results and failures may be
      // phrased by the model.
      const worded =
        base.kind === "question" || (task.kind === "turn" && base.kind === "result")
          ? base.text
          : Option.match(
              yield* generate({
                mode: "task_event",
                conversationId: task.conversationId,
                originKind: task.requester.originKind,
                taskEvent: { taskId: task.taskId, type: pending.event.type, summary: base.text },
                tail: requestTail,
                tasks: [],
                allowedTargets: [],
                requester: task.requester,
              }),
              { onNone: () => base.text, onSome: (result) => result.replyText },
            );
      const origin = task.originAddress;
      const deliveries = [
        replyDelivery({
          causeKey: "narration:" + pending.event.eventId + ":origin",
          destination: origin,
          kind: base.kind,
          text: worded,
          task,
          mentionActorId: mentionFor(origin, task.requester.externalActorId),
          options: "options" in base ? base.options : undefined,
        }),
      ];
      // Work started elsewhere shows up in the bot as its chip and its final result only.
      const bot = (yield* ledger.getBot(stored.ownerId))?.bot;
      if (bot !== undefined && origin.kind !== "goat" && base.kind !== "question") {
        deliveries.push(
          replyDelivery({
            causeKey: "narration:" + pending.event.eventId + ":bot",
            destination: botAddress(bot),
            kind: base.kind,
            text: worded,
            task,
          }),
        );
      }
      yield* ledger.completeNarration({ owner, sequence: pending.sequence, deliveries, now });
      yield* wake.wake;
    });

  return ChannelReceptionService.of({ receive, narrate });
});

export const layer = Layer.effect(ChannelReceptionService, make);
