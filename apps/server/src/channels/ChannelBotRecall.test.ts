import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChannelConversationId,
  type ChannelReceptionInput,
  type ChannelReceptionReadResult,
  type ChannelRequester,
  type ChannelTask,
  ChannelTaskId,
  type ThreadPullRequestLink,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  appendChannelBotJournal,
  channelBotFilesFor,
  JOURNAL_MAX_CHARS,
  readChannelBotJournal,
} from "./channelBotNotes.ts";
import { canSeeTask, matchMemoryLines, matchTasks, taskDigest } from "./channelBotRecall.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  makeHarness,
  onlyTask,
  owner,
  ownerId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const conversation = ChannelConversationId.make("conversation:here");
const elsewhere = ChannelConversationId.make("conversation:elsewhere");

const person = (overrides: Partial<ChannelRequester> = {}): ChannelRequester => ({
  ownerId,
  principalId: "alice",
  displayName: "Alice",
  originKind: "slack",
  runtimeModeCeiling: "auto-accept-edits",
  grantedScopes: ["orchestration:operate"],
  ...overrides,
});

const task = (overrides: Partial<ChannelTask> = {}): ChannelTask =>
  ({
    taskId: ChannelTaskId.make("task:1"),
    conversationId: elsewhere,
    requester: person({ principalId: "bob", displayName: "Bob" }),
    title: "Fix the login page",
    instruction: "The login button does nothing on Safari.",
    status: "completed",
    version: 3,
    generation: 1,
    openQuestions: [],
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T01:00:00.000Z",
    ...overrides,
  }) as ChannelTask;

describe("who may see a task", () => {
  it("shows the conversation's own work to anyone in it, and other work by person and scope", () => {
    const bobs = task();
    assert.isTrue(canSeeTask(person(), { ...bobs, conversationId: conversation }, conversation));
    assert.isFalse(canSeeTask(person(), bobs, conversation));
    assert.isTrue(canSeeTask(person({ principalId: "bob" }), bobs, conversation));
    assert.isTrue(
      canSeeTask(
        person({ grantedScopes: ["orchestration:read", "orchestration:operate"] }),
        bobs,
        conversation,
      ),
    );
  });

  it("keeps agents to their own conversation and owners to their own work", () => {
    const agent = person({
      originKind: "mcp",
      principalId: "bob",
      grantedScopes: ["orchestration:read"],
    });
    assert.isFalse(canSeeTask(agent, task(), conversation));
    assert.isTrue(canSeeTask(agent, task({ conversationId: conversation }), conversation));
    assert.isFalse(
      canSeeTask(
        person({ ownerId: "someone-else", grantedScopes: ["orchestration:read"] }),
        task({ conversationId: conversation }),
        conversation,
      ),
    );
  });
});

describe("finding the work a question means", () => {
  const login = task();
  const docs = task({
    taskId: ChannelTaskId.make("task:2"),
    title: "Update the docs",
    instruction: "Describe the new settings page.",
    observed: {
      pullRequests: [
        {
          repository: "goat-si/goat",
          number: 457,
          url: "https://github.com/goat-si/goat/pull/457",
          state: "merged",
          watching: false,
        },
      ],
      needsYou: [],
    },
  });
  const tasks = [docs, login];

  it("matches a task id, a pull request number or URL, then shared words", () => {
    assert.deepStrictEqual(matchTasks(tasks, "task:1"), [login]);
    assert.deepStrictEqual(matchTasks(tasks, "is #457 merged?"), [docs]);
    assert.deepStrictEqual(matchTasks(tasks, "https://github.com/goat-si/goat/pull/457"), [docs]);
    assert.deepStrictEqual(matchTasks(tasks, "what happened with the login fix"), [login]);
    assert.deepStrictEqual(matchTasks(tasks, "unrelated words"), []);
  });

  it("reads a task back with its pull requests and their state", () => {
    const digest = taskDigest(docs);
    assert.include(digest, "task:2 [completed] Update the docs");
    assert.include(digest, "goat-si/goat#457 (merged)");
  });

  it("finds memory lines sharing a word, newest first and bounded", () => {
    const lines = Array.from({ length: 30 }, (_, index) => "- deploy note " + index).join("\n");
    const found = matchMemoryLines("# header\n- prefers Korean\n" + lines, "deploy");
    assert.lengthOf(found, 12);
    assert.strictEqual(found[0], "- deploy note 29");
    assert.deepStrictEqual(matchMemoryLines("- prefers Korean", "korean"), ["- prefers Korean"]);
  });
});

describe("GOAT Bot journal", () => {
  it.effect("writes each event once and drops the oldest lines past its bound", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = channelBotFilesFor(path, yield* fs.makeTempDirectoryScoped());
      yield* appendChannelBotJournal(fs, files, "Done: first", "2026-10-12T00:00:00Z", "event:1");
      yield* appendChannelBotJournal(fs, files, "Done: again", "2026-10-12T00:00:00Z", "event:1");
      assert.strictEqual(
        yield* readChannelBotJournal(fs, files),
        "- 2026-10-12 00:00 Done: first [event:1]",
      );
      for (let index = 2; index < 400; index += 1) {
        yield* appendChannelBotJournal(
          fs,
          files,
          "Done: task " + index + " " + "x".repeat(300),
          "2026-10-12T00:00:00Z",
          "event:" + index,
        );
      }
      const whole = yield* readChannelBotJournal(fs, files, { whole: true });
      assert.isAtMost(whole.length, JOURNAL_MAX_CHARS);
      assert.notInclude(whole, "Done: first");
      assert.include(whole, "[event:399]");
      const recent = yield* readChannelBotJournal(fs, files);
      assert.isAtMost(recent.length, 3_000);
      assert.isTrue(recent.startsWith("- "));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const mergedLink: ThreadPullRequestLink = {
  host: "github.com",
  repository: "goat-si/goat",
  number: 123,
  url: "https://github.com/goat-si/goat/pull/123",
  source: "created",
  linkedAt: "2026-10-12T00:00:00.000Z",
  snapshot: { state: "merged" } as never,
  stack: null,
};

describe("GOAT Bot reads its memory and work before answering", () => {
  it.effect("carries notes and the journal into every pass, and journals how work ended", () => {
    const harness = makeHarness();
    const seen: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      if (input.mode === "input") seen.push(input);
      const text = input.inputText ?? "";
      if (text.startsWith("remember")) {
        return Effect.succeed({
          replyText: "I'll keep that.",
          action: { type: "report_only" },
          remember: "Deploys happen on Fridays.",
          rememberQuote: text,
        });
      }
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("remember deploys happen on Fridays", "m1"), rpcContext);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("do: fix the build", "m2"), rpcContext);
      yield* runtime.drain;
      const started = yield* onlyTask;
      harness.world.setStatus(started.worker!.threadId, 1, "completed", "The build is green.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("anything new?", "m3"), rpcContext);
      yield* runtime.drain;

      const last = seen.at(-1)!;
      assert.include(last.notes ?? "", "Deploys happen on Fridays.");
      assert.include(last.journal ?? "", "Started for Owner: fix the build");
      assert.include(last.journal ?? "", "Done: fix the build");
      assert.isTrue(last.readsAllowed);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers whether a pull request merged and what its thread said, in one reply", () => {
    const harness = makeHarness();
    const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
    harness.script.current = (input) => {
      if (input.mode !== "input" || !(input.inputText ?? "").includes("merge")) {
        return defaultScript(input);
      }
      if (input.readsAllowed === true) {
        return Effect.succeed({
          replyText: "Checking.",
          action: {
            type: "read",
            reads: [
              { kind: "work", query: "#123" },
              { kind: "thread", query: "login fix" },
            ],
          },
        });
      }
      results.push(input.readResults ?? []);
      return Effect.succeed({ replyText: "Yes, #123 merged.", action: { type: "report_only" } });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: ship the login fix", "p1"), rpcContext);
      yield* runtime.drain;
      const started = yield* onlyTask;
      const threadId = started.worker!.threadId;
      harness.world.pullRequests.set(threadId, [mergedLink]);
      harness.world.setStatus(threadId, 1, "completed", "Opened and merged the login fix.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const providerCallsBefore = harness.world.launches.length;

      yield* gateway.ingest(goatInput("did the login PR merge?", "p2"), rpcContext);
      yield* runtime.drain;

      assert.lengthOf(results, 1);
      const [work, thread] = results[0]!;
      assert.include(work!.text, "ship the login fix");
      assert.include(work!.text, "goat-si/goat#123 (merged)");
      assert.include(thread!.text, "Opened and merged the login fix.");
      // Reading started no worker, and the person got one reply: the answer.
      assert.strictEqual(harness.world.launches.length, providerCallsBefore);
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.strictEqual(texts.filter((text) => text === "Yes, #123 merged.").length, 1);
      assert.notInclude(texts, "Checking.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("finds older messages and remembered notes", () => {
    const harness = makeHarness();
    const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
    harness.script.current = (input) => {
      const text = input.inputText ?? "";
      if (text.startsWith("remember")) {
        return Effect.succeed({
          replyText: "Kept.",
          action: { type: "report_only" },
          remember: "The staging password rotates monthly.",
          rememberQuote: text,
        });
      }
      if (text.startsWith("when")) {
        if (input.readsAllowed === true) {
          return Effect.succeed({
            replyText: "",
            action: {
              type: "read",
              reads: [
                { kind: "memory", query: "staging" },
                { kind: "conversation", query: "lighthouse" },
              ],
            },
          });
        }
        results.push(input.readResults ?? []);
      }
      return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("the lighthouse score dropped to 61", "c1"), rpcContext);
      yield* gateway.ingest(goatInput("remember staging rotates monthly", "c2"), rpcContext);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("when did I mention that score?", "c3"), rpcContext);
      yield* runtime.drain;
      const [memory, older] = results[0]!;
      assert.include(memory!.text, "The staging password rotates monthly.");
      assert.include(older!.text, "the lighthouse score dropped to 61");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not show a linked person work they may not see", () => {
    const harness = makeHarness();
    const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
    harness.script.current = (input) => {
      if ((input.inputText ?? "").startsWith("what happened")) {
        if (input.readsAllowed === true) {
          return Effect.succeed({
            replyText: "",
            action: { type: "read", reads: [{ kind: "work", query: "payroll" }] },
          });
        }
        results.push(input.readResults ?? []);
        return Effect.succeed({ replyText: "Nothing I can see.", action: { type: "report_only" } });
      }
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      yield* gateway.ingest(goatInput("do: fix payroll export", "v1"), rpcContext);
      yield* runtime.drain;
      // A teammate, linked under their own name, who may start work but not read GOAT's threads.
      const { code } = yield* identities.createLink(
        {
          connectionId: "slack-1",
          runtimeModeCeiling: "auto-accept-edits",
          grantedScopes: ["orchestration:operate"],
        },
        { ...owner, principalId: "teammate", displayName: "Teammate" },
      );
      yield* gateway.linkIdentity(
        {
          connectionId: "slack-1",
          externalActorId: "U2",
          code,
          idempotencyKey: "link-U2",
          replyAddress: slackInput("", "unused").replyAddress,
        },
        slackContext,
      );
      yield* gateway.ingest(
        slackInput("what happened with payroll?", "Ev-v2", "1760000000.000200", "U2"),
        slackContext,
      );
      yield* runtime.drain;
      assert.strictEqual(results[0]?.[0]?.text, "No work this person may see matches.");
    }).pipe(Effect.provide(harness.layer));
  });
});
