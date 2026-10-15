import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  EnvironmentAuthorizationError,
  type AuthSessionId,
  type SecretRequestAnswerInput,
  SecretRequestError,
  CommandId,
  Handoff,
  HandoffError,
  HandoffHuman,
  handoffSummary,
  isHandoffPending,
  TurnItemId,
  type HandoffReadInput,
  type HandoffRespondInput,
  type HandoffSummary,
  type NodeId,
  type RunId,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- AEAD encrypts human-only instructions outside the event log.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { itemHandoff } from "../orchestration-v2/handoffState.ts";

const PrivatePayload = Schema.fromJsonString(
  Schema.Struct({ human: HandoffHuman, args: Schema.Record(Schema.String, Schema.Unknown) }),
);
const encodePrivatePayload = Schema.encodeEffect(PrivatePayload);
const decodePrivatePayload = Schema.decodeUnknownEffect(PrivatePayload);
const decodeAddress = Schema.decodeUnknownEffect(
  Schema.Struct({ threadId: Handoff.fields.requestedBy.fields.threadId, handoffId: TurnItemId }),
);
const storeName = (id: string) =>
  `handoff-${NodeCrypto.createHash("sha256").update(id).digest("hex")}`;
const unavailable = (cause: unknown) => new HandoffError({ reason: "unavailable", cause });
const targetKey = (args: Readonly<Record<string, unknown>>) =>
  JSON.stringify(args, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );

export class Handoffs extends Context.Service<
  Handoffs,
  {
    /** Internal domain API: adapters supply human instructions, agents receive only the summary. */
    readonly create: (input: {
      readonly kind: Handoff["kind"];
      readonly title: string;
      readonly reason: string;
      readonly requestedBy: Handoff["requestedBy"];
      readonly target: Handoff["target"];
      readonly runId: RunId;
      readonly nodeId: NodeId;
      readonly human: HandoffHuman;
      readonly args: Readonly<Record<string, unknown>>;
      readonly expiresAt?: DateTime.Utc;
    }) => Effect.Effect<HandoffSummary, HandoffError>;
    readonly read: (input: HandoffReadInput) => Effect.Effect<Handoff, HandoffError>;
    /** Client-only; caller supplies an authenticated, server-resolved label. */
    readonly open: (
      input: HandoffReadInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<
      { handoff: Handoff; human: HandoffHuman | null },
      HandoffError | EnvironmentAuthorizationError
    >;
    readonly respond: (
      input: HandoffRespondInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<Handoff, HandoffError | EnvironmentAuthorizationError>;
    readonly answerSecret: (
      input: SecretRequestAnswerInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, HandoffError | SecretRequestError | EnvironmentAuthorizationError>;
    readonly sweep: Effect.Effect<void, HandoffError>;
  }
>()("goat/handoffs/Handoffs") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const sessions = yield* SessionStore.SessionStore;
  const secrets = yield* SecretRequests.SecretRequests;
  const key = yield* store
    .getOrCreateRandom("handoff-encryption-key", 32)
    .pipe(Effect.mapError(unavailable));
  const lock = yield* Semaphore.make(1);
  const read = Effect.fn("Handoffs.read")(function* (input: HandoffReadInput) {
    const records = yield* threads
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["human_handoff", "secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError(unavailable));
    const item = records.turnItems.find((item) => item.id === input.handoffId);
    const handoff = item && itemHandoff(item);
    if (!handoff) return yield* new HandoffError({ reason: "not_found" });
    return handoff;
  });
  const transition = Effect.fn("Handoffs.transition")(function* (
    input: HandoffReadInput,
    state: Handoff["state"],
    actor: Handoff["actor"],
  ) {
    yield* threads
      .dispatch({
        type: "handoff.transition",
        // Reopening must recheck expiry even when an earlier open has a receipt.
        commandId: CommandId.make(
          `handoff:${input.handoffId}:${state}${state === "opened" ? `:${NodeCrypto.randomUUID()}` : ""}`,
        ),
        threadId: input.threadId,
        handoffId: input.handoffId,
        state,
        actor,
      })
      .pipe(Effect.mapError(unavailable));
    const handoff = yield* read(input);
    // Completed payloads retain continuation arguments until the next rollout consumes them.
    if (!isHandoffPending(handoff.state) && handoff.state !== "completed")
      yield* store.remove(storeName(input.handoffId)).pipe(Effect.mapError(unavailable));
    return handoff;
  });
  const clientLabel = Effect.fn("Handoffs.clientLabel")(function* (
    input: HandoffReadInput,
    sessionId: AuthSessionId,
  ) {
    const record = yield* read(input);
    const requiredScope = record.target.path.startsWith("provider.")
      ? ("providers:manage" as const)
      : ("orchestration:operate" as const);
    const active = yield* sessions.listActive().pipe(Effect.mapError(unavailable));
    const session = active.find((session) => session.sessionId === sessionId);
    if (!session || !(session.permissions ?? session.scopes).includes(requiredScope))
      return yield* new EnvironmentAuthorizationError({
        requiredScope,
        message: "This client cannot act on this handoff.",
      });
    return session.client.label ?? "GOAT client";
  });
  const respond = Effect.fn("Handoffs.respond")(function* (
    input: HandoffRespondInput,
    sessionId: AuthSessionId,
  ) {
    const label = yield* clientLabel(input, sessionId);
    const result = yield* transition(input, input.action, { type: "client", label });
    if (result.state === "expired") return yield* new HandoffError({ reason: "expired" });
    if (result.state !== input.action) return yield* new HandoffError({ reason: "conflict" });
    return result;
  });
  const open = Effect.fn("Handoffs.open")(function* (
    input: HandoffReadInput,
    sessionId: AuthSessionId,
  ) {
    yield* clientLabel(input, sessionId);
    const existing = yield* read(input);
    if (!isHandoffPending(existing.state)) return { handoff: existing, human: null };
    const handoff = yield* respond({ ...input, action: "opened" }, sessionId);
    if (handoff.kind === "secret") return { handoff, human: null };
    const stored = yield* store.get(storeName(input.handoffId)).pipe(Effect.mapError(unavailable));
    if (Option.isNone(stored)) return yield* new HandoffError({ reason: "unavailable" });
    const plain = yield* Effect.try({
      try: () => {
        const bytes = Buffer.from(stored.value);
        const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
          "utf8",
        );
      },
      catch: unavailable,
    });
    const payload = yield* decodePrivatePayload(plain).pipe(Effect.mapError(unavailable));
    return { handoff, human: payload.human };
  });
  const create: Handoffs["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      yield* sweepUnlocked;
      // Serializes private-payload ownership, including duplicate calls with different request IDs.
      const records = yield* threads
        .getThreadRecords(input.requestedBy.threadId, ["turnItems"], {
          turnItemTypes: ["human_handoff", "secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError(unavailable));
      const dedupeKey = NodeCrypto.createHmac("sha256", key)
        .update(targetKey(input.args))
        .digest("hex");
      const pending = records.turnItems.flatMap((item) => {
        const handoff = itemHandoff(item);
        return handoff && isHandoffPending(handoff.state) ? [handoff] : [];
      });
      const duplicate = pending.find(
        (handoff) =>
          handoff.kind === input.kind &&
          handoff.target.environmentId === input.target.environmentId &&
          handoff.target.path === input.target.path &&
          handoff.dedupeKey === dedupeKey,
      );
      if (duplicate) return handoffSummary(duplicate);
      if (pending.length >= 3) return yield* new HandoffError({ reason: "limit_reached" });
      if (input.kind === "secret") return yield* new HandoffError({ reason: "invalid_request" });
      if (input.human.url !== undefined) {
        const validUrl = yield* Effect.try({
          try: () => new URL(input.human.url!),
          catch: () => new HandoffError({ reason: "invalid_request" }),
        });
        if (
          !["https:", "http:"].includes(validUrl.protocol) ||
          validUrl.username ||
          validUrl.password
        )
          return yield* new HandoffError({ reason: "invalid_request" });
      }
      const now = yield* DateTime.now;
      const handoff: Handoff = {
        handoffId: TurnItemId.make(`handoff:${NodeCrypto.randomUUID()}`),
        kind: input.kind,
        title: input.title,
        reason: input.reason,
        requestedBy: input.requestedBy,
        target: input.target,
        dedupeKey,
        state: "pending",
        expiresAt:
          input.kind === "approval"
            ? null
            : (input.expiresAt ?? DateTime.add(now, { minutes: 15 })),
        createdAt: now,
        actor: { type: "agent", threadId: input.requestedBy.threadId },
      };
      const plain = yield* encodePrivatePayload({
        human: input.human,
        args: input.args,
      }).pipe(Effect.mapError(unavailable));
      const encrypted = yield* Effect.try({
        try: () => {
          const iv = NodeCrypto.randomBytes(12);
          const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
          const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
          return Buffer.concat([iv, cipher.getAuthTag(), body]);
        },
        catch: unavailable,
      });
      yield* store
        .create(storeName(handoff.handoffId), encrypted)
        .pipe(Effect.mapError(unavailable));
      yield* threads
        .dispatch({
          type: "handoff.create",
          commandId: CommandId.make(`handoff:${handoff.handoffId}:create`),
          threadId: input.requestedBy.threadId,
          runId: input.runId,
          nodeId: input.nodeId,
          handoff,
        })
        .pipe(Effect.mapError(unavailable));
      return handoffSummary(handoff);
    }).pipe(lock.withPermits(1));

  const sweepUnlocked = Effect.gen(function* () {
    // Narrow indexed projection read; no full thread snapshots on the scheduler's hot path.
    const rows = yield* sql<{
      thread_id: string;
      turn_item_id: string;
    }>`SELECT thread_id, turn_item_id FROM orchestration_v2_projection_turn_items WHERE type IN ('human_handoff', 'secret_request') AND status = 'waiting'`.pipe(
      Effect.mapError(unavailable),
    );
    for (const row of rows) {
      const input = yield* decodeAddress({
        threadId: row.thread_id,
        handoffId: row.turn_item_id,
      }).pipe(Effect.mapError(unavailable));
      const now = yield* DateTime.now;
      const request = yield* threads
        .getThreadRecords(input.threadId, ["turnItems", "runs"], {
          turnItemTypes: ["human_handoff", "secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError(unavailable));
      const item = request.turnItems.find((item) => item.id === input.handoffId);
      const handoff = item && itemHandoff(item);
      if (!handoff) continue;
      const run = request.runs.find((run) => run.id === item?.runId);
      if (
        (handoff.expiresAt !== null &&
          DateTime.toEpochMillis(handoff.expiresAt) <= DateTime.toEpochMillis(now)) ||
        (handoff.kind === "approval" && (!run || ThreadManagement.isTerminalRunStatus(run.status)))
      )
        yield* transition(input, "expired", { type: "server" });
    }
    if (store.directory !== undefined) {
      // Reconcile orphan writes and failed deletions after crashes. A single service lock
      // keeps a sweep from removing an in-flight create's unpublished payload.
      const retained = yield* sql<{
        turn_item_id: string;
      }>`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE type IN ('human_handoff', 'secret_request') AND type = 'human_handoff' AND (status = 'waiting' OR (status = 'completed' AND updated_at > ${DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 24 }))}))`.pipe(
        Effect.mapError(unavailable),
      );
      const keep = new Set(retained.map((row) => `${storeName(row.turn_item_id)}.bin`));
      for (const file of yield* fs
        .readDirectory(store.directory)
        .pipe(Effect.mapError(unavailable))) {
        if (/^handoff-[a-f0-9]{64}\.bin$/.test(file) && !keep.has(file))
          yield* store.remove(file.slice(0, -4)).pipe(Effect.mapError(unavailable));
      }
    }
  });
  const sweep = sweepUnlocked.pipe(lock.withPermits(1));
  const answerSecret = Effect.fn("Handoffs.answerSecret")(function* (
    input: SecretRequestAnswerInput,
    sessionId: AuthSessionId,
  ) {
    const active = yield* sessions.listActive().pipe(Effect.mapError(unavailable));
    const session = active.find((session) => session.sessionId === sessionId);
    if (!session || !(session.permissions ?? session.scopes).includes("orchestration:operate"))
      return yield* new EnvironmentAuthorizationError({
        requiredScope: "orchestration:operate",
        message: "This client cannot answer this request.",
      });
    yield* secrets.answer(input, { type: "client", label: session.client.label ?? "GOAT client" });
  });
  return Handoffs.of({ create, read, open, respond, sweep, answerSecret });
});
export const layer = Layer.effect(Handoffs, make);
