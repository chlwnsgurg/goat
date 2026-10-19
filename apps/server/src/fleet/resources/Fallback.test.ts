import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type FleetSettings,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Fallback from "./Fallback.ts";

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const LATER = "2026-10-20T05:00:00.000Z";
const codex = ProviderInstanceId.make("codex");
const claudeAgent = ProviderInstanceId.make("claudeAgent");
const opus = { instanceId: codex, model: "anthropic/claude-opus-5-5" };
const opus2 = { instanceId: codex, model: "anthropic2/claude-opus-5-5" };
const sol = { instanceId: codex, model: "gpt-6.1-sol" };
const claude = { instanceId: claudeAgent, model: "claude-opus-5-5" };
const threadId = ThreadId.make("thread:fleet");
const runId = RunId.make("run:2");
const GENERATION = Math.floor(NOW / (15 * 60_000));

const shell = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: threadId,
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: LATER,
    latestRunId: runId,
    providerInstanceId: codex,
    modelSelection: opus,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const run = (ordinal: number, status: string, modelSelection: typeof opus) => ({
  id: RunId.make("run:" + ordinal),
  ordinal,
  status,
  startedAt: ordinal,
  modelSelection,
});

interface World {
  shell: OrchestrationV2ThreadShell;
  runs: ReadonlyArray<ReturnType<typeof run>>;
  refuse: ReadonlySet<string>;
  disabledForProject: ReadonlySet<string>;
  readonly receipts: Set<string>;
  readonly commands: Array<OrchestrationV2ServerCommand>;
}
const makeWorld = (overrides: Partial<World> = {}): World => ({
  shell: shell(),
  runs: [run(1, "completed", opus), run(2, "failed", opus)],
  refuse: new Set(),
  disabledForProject: new Set(),
  receipts: new Set(),
  commands: [],
  ...overrides,
});

const provider = (
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<string>,
  exhausted = false,
) =>
  ({
    instanceId,
    enabled: true,
    models: models.map((slug) => ({ slug, name: slug })),
    usageLimits: {
      checkedAt: "2026-10-19T23:00:00.000Z",
      windows: [
        {
          id: "w",
          kind: "weekly",
          label: "Weekly",
          usedPercent: exhausted ? 100 : 10,
          resetsAt: LATER,
        },
      ],
    },
  }) as unknown as ServerProvider;

const threadChain: FleetSettings = {
  fallbackChains: { claude: { steps: [opus, opus2, sol, claude], scope: "goals_and_threads" } },
};

const layer = (world: World, fleet: FleetSettings, claudeExhausted = false) =>
  Layer.mergeAll(Fallback.layer, Fallback.layerChains).pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.sync(() => world.shell),
        getThreadRecords: (() => Effect.sync(() => ({ runs: world.runs }))) as never,
        hasReceipt: (commandId) => Effect.sync(() => world.receipts.has(commandId)),
        isProviderInstanceEnabledForProject: ({ instanceId }) =>
          Effect.sync(() => !world.disabledForProject.has(instanceId)),
        dispatch: (command) =>
          Effect.suspend(() => {
            const target = "modelSelection" in command ? command.modelSelection : undefined;
            if (target !== undefined && world.refuse.has(target.model))
              return Effect.die("selection refused");
            world.commands.push(command);
            world.receipts.add(command.commandId);
            if ("modelSelection" in command && command.modelSelection !== undefined)
              world.shell = { ...world.shell, modelSelection: command.modelSelection };
            return Effect.succeed({ sequence: world.commands.length } as never);
          }),
      }),
    ),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest({ fleet })),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([
          provider(codex, [opus.model, opus2.model, sol.model]),
          provider(claudeAgent, [claude.model], claudeExhausted),
        ]),
      }),
    ),
  );

const summary = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.map((command) =>
    command.type === "thread.notice.record"
      ? "notice: " + command.message
      : "modelSelection" in command && command.modelSelection !== undefined
        ? command.type + " " + command.modelSelection.model
        : command.type,
  );

const withClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(NOW).pipe(Effect.andThen(effect));

describe("Fallback.continueThread", () => {
  it.effect(
    "switches a usage-limited thread to the next step with a notice and a continuation",
    () => {
      const world = makeWorld();
      return withClock(
        Effect.gen(function* () {
          const fallback = yield* Fallback.Fallback;
          assert.isTrue(yield* fallback.continueThread(threadId));
          assert.deepStrictEqual(summary(world.commands), [
            "thread.model-selection.set anthropic2/claude-opus-5-5",
            "notice: Switched to codex/anthropic2/claude-opus-5-5 after usage_limit on codex/anthropic/claude-opus-5-5; that limit resets at " +
              LATER +
              " (fallback chain claude).",
            "message.dispatch",
          ]);
          assert.deepStrictEqual(
            world.commands.map((command) => command.commandId),
            [
              "fleet-fallback:thread:fleet:run:2:codex/anthropic2/claude-opus-5-5:" + GENERATION,
              "fleet-fallback-notice:switch:run:2",
              "fleet-fallback:thread:fleet:run:2:continue",
            ],
          );
          // The failed model now cools down.
          assert.deepStrictEqual(
            (yield* fallback.cooldowns).map((entry) => [entry.model, entry.failure]),
            [[opus.model, "usage_limit"]],
          );
        }).pipe(Effect.provide(layer(world, threadChain))),
      );
    },
  );

  it.effect(
    "finishes a hop whose selection landed before a restart, even if that account ran out since",
    () => {
      const world = makeWorld({
        shell: shell({ modelSelection: opus2 }),
        receipts: new Set([
          "fleet-fallback:thread:fleet:run:2:codex/anthropic2/claude-opus-5-5:" + GENERATION,
        ]),
      });
      return withClock(
        Effect.gen(function* () {
          const fallback = yield* Fallback.Fallback;
          assert.isTrue(yield* fallback.continueThread(threadId));
          assert.deepStrictEqual(
            world.commands.map((command) => command.commandId),
            ["fleet-fallback-notice:switch:run:2", "fleet-fallback:thread:fleet:run:2:continue"],
          );
        }).pipe(Effect.provide(layer(world, threadChain))),
      );
    },
  );

  it.effect("follows the failed tail and crosses to another driver with a provider switch", () => {
    const world = makeWorld({
      shell: shell({ modelSelection: sol }),
      runs: [run(1, "failed", opus), run(2, "failed", sol)],
    });
    return withClock(
      Effect.gen(function* () {
        const fallback = yield* Fallback.Fallback;
        assert.isTrue(yield* fallback.continueThread(threadId));
        assert.strictEqual(summary(world.commands)[0], "provider.switch claude-opus-5-5");
      }).pipe(Effect.provide(layer(world, threadChain))),
    );
  });

  it.effect(
    "tries the next step when a selection is refused and cools the refused one down",
    () => {
      const world = makeWorld({ refuse: new Set([opus2.model]) });
      return withClock(
        Effect.gen(function* () {
          const fallback = yield* Fallback.Fallback;
          assert.isTrue(yield* fallback.continueThread(threadId));
          assert.strictEqual(summary(world.commands)[0], "thread.model-selection.set gpt-6.1-sol");
          assert.include(
            (yield* fallback.cooldowns).map((entry) => entry.model + ":" + entry.failure),
            opus2.model + ":unavailable",
          );
        }).pipe(Effect.provide(layer(world, threadChain))),
      );
    },
  );

  it.effect("waits for the reset when no step is left, telling the thread once", () => {
    const world = makeWorld();
    return withClock(
      Effect.gen(function* () {
        const fallback = yield* Fallback.Fallback;
        assert.isFalse(yield* fallback.continueThread(threadId));
        assert.isFalse(yield* fallback.continueThread(threadId));
        assert.deepStrictEqual(summary(world.commands), [
          "notice: Fallback chain short did not switch models: no step is available (claudeAgent/claude-opus-5-5 is at its usage limit).",
        ]);
      }).pipe(
        Effect.provide(
          layer(
            world,
            { fallbackChains: { short: { steps: [opus, claude], scope: "goals_and_threads" } } },
            true,
          ),
        ),
      ),
    );
  });

  it.effect("leaves goal threads, goal-only chains and unchained threads alone", () => {
    const world = makeWorld();
    return withClock(
      Effect.gen(function* () {
        assert.isFalse(
          yield* Effect.flatMap(Fallback.Fallback, (fallback) =>
            fallback.continueThread(threadId),
          ).pipe(
            Effect.provideService(Fallback.GoalThreadOwnership, {
              isGoalThread: () => Effect.succeed(true),
            }),
            Effect.provide(layer(world, threadChain)),
          ),
        );
        assert.isFalse(
          yield* Effect.flatMap(Fallback.Fallback, (fallback) =>
            fallback.continueThread(threadId),
          ).pipe(
            Effect.provide(layer(world, { fallbackChains: { claude: { steps: [opus, opus2] } } })),
          ),
        );
        assert.isFalse(
          yield* Effect.flatMap(Fallback.Fallback, (fallback) =>
            fallback.continueThread(threadId),
          ).pipe(Effect.provide(layer(world, {}))),
        );
        assert.deepStrictEqual(world.commands, []);
      }),
    );
  });
  it.effect("leaves a thread whose model the user changed by hand after the failure", () => {
    const world = makeWorld({ shell: shell({ modelSelection: sol }) });
    return withClock(
      Effect.gen(function* () {
        const fallback = yield* Fallback.Fallback;
        assert.isFalse(yield* fallback.continueThread(threadId));
        assert.deepStrictEqual(world.commands, []);
      }).pipe(Effect.provide(layer(world, threadChain))),
    );
  });

  it.effect("skips a step whose instance this project disabled", () => {
    const world = makeWorld({
      shell: shell({ modelSelection: sol }),
      runs: [run(1, "failed", opus), run(2, "failed", sol)],
      disabledForProject: new Set(["claudeAgent"]),
    });
    return withClock(
      Effect.gen(function* () {
        const fallback = yield* Fallback.Fallback;
        assert.isTrue(yield* fallback.continueThread(threadId));
        assert.strictEqual(
          summary(world.commands)[0],
          "thread.model-selection.set anthropic2/claude-opus-5-5",
        );
      }).pipe(Effect.provide(layer(world, threadChain))),
    );
  });
});

describe("Fallback.next", () => {
  it.effect("walks the named or default chain and reports exhaustion without one", () => {
    const world = makeWorld();
    return withClock(
      Effect.gen(function* () {
        const fallback = yield* Fallback.Fallback;
        const base = {
          selection: opus,
          failure: "usage_limit" as const,
          tried: [],
          threadId: null,
        };
        assert.deepStrictEqual(yield* fallback.next({ ...base, chain: null, host: null }), {
          _tag: "SwitchInThread",
          selection: opus2,
          hop: 1,
        });
        yield* fallback.reportFailure(opus2, "usage_limit");
        assert.deepStrictEqual(yield* fallback.next({ ...base, chain: "claude", host: null }), {
          _tag: "SwitchInThread",
          selection: sol,
          hop: 1,
        });
        // A remote host's providers are unknown here; placement checks them.
        assert.deepStrictEqual(
          (yield* fallback.next({ ...base, chain: "claude", host: "lidge-ai", tried: [sol] }))._tag,
          "SwitchInThread",
        );
        assert.deepStrictEqual(yield* fallback.next({ ...base, chain: "missing", host: null }), {
          _tag: "Exhausted",
          reason: "fallback chain missing is not configured",
        });
      }).pipe(Effect.provide(layer(world, { ...threadChain, defaultFallbackChain: "claude" }))),
    );
  });
});

describe("FallbackChains", () => {
  it.effect("validates instances, warns on unlisted models, and keeps the default in step", () => {
    const world = makeWorld();
    return withClock(
      Effect.gen(function* () {
        const chains = yield* Fallback.FallbackChains;
        const refused = yield* Effect.flip(
          chains.set({
            id: "x",
            chain: { steps: [{ instanceId: ProviderInstanceId.make("nope"), model: "m" }] },
          }),
        );
        assert.include(refused.message, "Provider instance nope is not configured here");
        const saved = yield* chains.set({
          id: "claude",
          chain: { steps: [opus, { instanceId: codex, model: "made-up" }] },
          makeDefault: true,
        });
        assert.deepStrictEqual(saved.warnings, ["codex does not list model made-up."]);
        assert.strictEqual(saved.defaultFallbackChain, "claude");
        yield* chains.set({ id: "other", chain: { steps: [sol] } });
        const removed = yield* chains.set({ id: "claude", chain: null });
        assert.deepStrictEqual(Object.keys(removed.chains), ["other"]);
        assert.isNull(removed.defaultFallbackChain);
      }).pipe(Effect.provide(layer(world, {}))),
    );
  });
});
