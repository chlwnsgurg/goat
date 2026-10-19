// @vitest-environment jsdom
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({ usePrimarySettings: () => "system" }));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => <div>Work card</div> }));

import { GoatBotTimeline } from "./GoatBotTimeline";

let root: Root;
let container: HTMLDivElement;
const createdAt = "2026-10-12T09:40:00Z";
const user = (id: string): GoatBotRow => ({
  kind: "user",
  id,
  text: id,
  createdAt,
  firstInGroup: true,
  groupPosition: "single",
  delivery: { state: "sending" },
  showReceipt: false,
});
const bot: GoatBotRow = {
  kind: "bot",
  id: "bot",
  text: "Reply",
  createdAt,
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
};
const task: GoatBotRow = {
  kind: "task",
  id: "task",
  createdAt,
  firstInGroup: true,
  groupPosition: "single",
  card: {
    key: "task",
    revision: 1,
    updatedAt: createdAt,
    title: "Work",
    statusLabel: "Running",
    tone: "active",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: "Unavailable" },
  },
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("animates only the local pending send and keeps its keyed element on rerender", async () => {
  const rows = [user("pending:a"), user("committed"), bot, task];
  await act(() => root.render(<GoatBotTimeline rows={rows} onRetry={() => {}} />));
  const animated = container.querySelector("li.goat-arrive");
  expect(animated?.textContent).toContain("pending:a");
  expect(container.querySelectorAll("li.goat-arrive")).toHaveLength(1);
  await act(() => root.render(<GoatBotTimeline rows={[...rows]} onRetry={() => {}} />));
  expect(container.querySelector("li.goat-arrive")).toBe(animated);
  await act(() =>
    root.render(<GoatBotTimeline rows={[user("committed"), bot, task]} onRetry={() => {}} />),
  );
  expect(container.querySelector("li.goat-arrive")).toBeNull();
});
