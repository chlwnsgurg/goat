import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2CloudTask } from "@goat/contracts";

import { cloudTaskResultText } from "./cloudTask.ts";

const task = (overrides: Partial<OrchestrationV2CloudTask>) =>
  ({
    taskId: "task-1",
    status: "succeeded",
    tracking: "live",
    source: { repository: "https://github.com/acme/app", branch: "main" },
    localChangesExcluded: false,
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  }) as OrchestrationV2CloudTask;

describe("cloudTaskResultText", () => {
  it("separates the summary from one link per line", () => {
    assert.strictEqual(
      cloudTaskResultText(
        task({
          summary: "Added min.",
          prUrl: "https://github.com/acme/app/pull/7",
          branch: "cursor/add-min",
          url: "https://cursor.com/agents/bc-1",
        }),
      ),
      "Added min.\n\n- Pull request: https://github.com/acme/app/pull/7\n- Branch: `cursor/add-min`\n- Cloud task: https://cursor.com/agents/bc-1",
    );
  });

  it("does not repeat a pull request the summary already links", () => {
    const text = cloudTaskResultText(
      task({
        summary: "Opened https://github.com/acme/app/pull/7",
        prUrl: "https://github.com/acme/app/pull/7",
        branch: "cursor/add-min",
      }),
    );
    assert.strictEqual(text.split("https://github.com/acme/app/pull/7").length, 2);
    assert.include(text, "- Branch: `cursor/add-min`");
  });

  it("falls back to the task status when there is no summary or link", () => {
    assert.strictEqual(cloudTaskResultText(task({ status: "failed" })), "Cloud task failed");
  });

  it("keeps the pull request link when the summary only links a longer URL", () => {
    const text = cloudTaskResultText(
      task({
        summary: "Superseded https://github.com/acme/app/pull/70.",
        prUrl: "https://github.com/acme/app/pull/7",
      }),
    );
    assert.include(text, "- Pull request: https://github.com/acme/app/pull/7");
  });

  it("treats a linked pull request followed by punctuation as already present", () => {
    const text = cloudTaskResultText(
      task({
        summary: "Opened (https://github.com/acme/app/pull/7).",
        prUrl: "https://github.com/acme/app/pull/7",
      }),
    );
    assert.notInclude(text, "- Pull request:");
  });
});
