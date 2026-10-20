import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as CommandReceipts from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventStore.layer,
      ProjectionStore.layer,
      CommandReceipts.layer,
      EffectOutbox.layer,
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect(
  "effect-only recovery commits a receipt and outbox once at the thread high-water mark",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:effect-only");
      const thread = idleThreadProjection(liveThreadShell(threadId)).thread;
      const stored = yield* sink.write({
        events: [
          {
            id: EventId.make("event:effect-only"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      const otherThreadId = ThreadId.make("thread:other-sequence");
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:other-sequence"),
            type: "thread.created",
            threadId: otherThreadId,
            occurredAt: now,
            payload: { ...thread, id: otherThreadId },
          },
        ],
      });
      const sequence = yield* sink.latestSequence();
      const commandId = CommandId.make("command:effect-only");
      const runId = RunId.make("run:effect-only");
      yield* outbox.enqueue([
        {
          id: "effect:obsolete-start",
          commandId: CommandId.make("command:obsolete-start"),
          threadId,
          request: { type: "provider-turn.start", runId },
        },
      ]);
      const input = {
        commandId,
        threadId,
        commandType: "provider-runtime.reconcile",
        acceptedAt: now,
        events: [],
        allowEffectOnly: true,
        effects: [
          {
            id: "effect:reattach",
            commandId,
            threadId,
            request: { type: "provider-turn.reattach" as const, runId },
          },
        ],
        cancelUnsettledEffects: {
          effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
          reason: "Process lost",
        },
      };
      const committed = yield* sink.commitCommand(input);
      assert.isTrue(committed.committed);
      assert.deepEqual(committed.storedEvents, []);
      assert.equal(committed.receipt.resultSequence, stored[0]!.sequence);
      assert.equal(committed.cancelledEffectCount, 1);
      assert.deepEqual(
        Option.getOrThrow(yield* receipts.getByCommandId(commandId)),
        committed.receipt,
      );
      assert.equal(
        Option.getOrThrow(yield* outbox.get("effect:obsolete-start")).status,
        "cancelled",
      );
      const duplicate = yield* sink.commitCommand({
        ...input,
        effects: [{ ...input.effects[0]!, id: "effect:must-not-enqueue" }],
      });
      assert.isFalse(duplicate.committed);
      assert.deepEqual(duplicate.receipt, committed.receipt);
      assert.deepEqual(duplicate.storedEvents, []);
      assert.equal(duplicate.cancelledEffectCount, 0);
      assert.equal((yield* outbox.listByCommandId(commandId)).length, 1);
      assert.isTrue(Option.isNone(yield* outbox.get("effect:must-not-enqueue")));
      assert.equal(yield* sink.latestSequence(), sequence);
      assert.deepEqual(yield* sink.readByCommandId({ commandId }).pipe(Stream.runCollect), []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { allowEffectOnly: false, hasEffect: true },
  { allowEffectOnly: true, hasEffect: false },
])(
  "rejects empty-event commits allowEffectOnly=$allowEffectOnly hasEffect=$hasEffect",
  ({ allowEffectOnly, hasEffect }) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:invalid-effect-only");
      const threadId = ThreadId.make("thread:invalid-effect-only");
      const result = yield* sink
        .commitCommand({
          commandId,
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: yield* DateTime.now,
          events: [],
          allowEffectOnly,
          effects: hasEffect
            ? [
                {
                  id: "effect:invalid",
                  commandId,
                  threadId,
                  request: { type: "provider-turn.reattach", runId: RunId.make("run:invalid") },
                },
              ]
            : [],
        })
        .pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
      assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rolls back the effect-only receipt and outbox together when enqueue fails", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER reject_reattach BEFORE INSERT ON orchestration_v2_effect_outbox
      WHEN NEW.effect_id = 'effect:rejected-reattach'
      BEGIN SELECT RAISE(ABORT, 'Injected enqueue failure'); END`;
    const commandId = CommandId.make("command:rollback-effect-only");
    const threadId = ThreadId.make("thread:rollback-effect-only");
    const result = yield* sink
      .commitCommand({
        commandId,
        threadId,
        commandType: "provider-runtime.reconcile",
        acceptedAt: yield* DateTime.now,
        events: [],
        allowEffectOnly: true,
        effects: ["effect:first-reattach", "effect:rejected-reattach"].map((id) => ({
          id,
          commandId,
          threadId,
          request: { type: "provider-turn.reattach" as const, runId: RunId.make("run:rollback") },
        })),
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
    assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
    assert.equal(yield* sink.latestSequence(), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("onSubscribed runs after acquisition and retains replay/live overlap", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:subscription");
    const instanceId = ProviderInstanceId.make("codex");
    const thread = {
      id: threadId,
      projectId: ProjectId.make("project:subscription"),
      title: "Subscription",
      createdBy: "user" as const,
      creationSource: "web" as const,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const replay = yield* sink.write({
      events: [
        {
          id: EventId.make("subscription:replay"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    const acquired = yield* Deferred.make<void>();
    const releaseReplay = yield* Deferred.make<void>();
    const listener = yield* sink
      .stream({
        eventType: "thread.created",
        onSubscribed: Deferred.succeed(acquired, undefined).pipe(
          Effect.andThen(Deferred.await(releaseReplay)),
        ),
      })
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
    yield* Deferred.await(acquired);
    // This commit happens after subscription but before replay is allowed to start.
    const liveId = ThreadId.make("thread:subscription:live");
    const live = yield* sink.write({
      events: [
        {
          id: EventId.make("subscription:live"),
          type: "thread.created",
          threadId: liveId,
          occurredAt: now,
          payload: { ...thread, id: liveId },
        },
      ],
    });
    yield* Deferred.succeed(releaseReplay, undefined);
    const received = yield* Fiber.join(listener);
    assert.deepEqual(
      received.map((stored) => stored.sequence),
      [...replay, ...live].map((e) => e.sequence),
    );
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
