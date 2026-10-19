import { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live",
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

function Questions({
  initialIndex = 0,
  responseCapability = "live",
}: {
  initialIndex?: number;
  responseCapability?: PendingUserInput["responseCapability"];
}) {
  const [questionIndex, setQuestionIndex] = useState(initialIndex);
  const [disabled, setDisabled] = useState(false);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const advance = () => setQuestionIndex(questionIndex + 1);
  return (
    <>
      <output>{questionIndex}</output>
      <button onClick={() => setDisabled(true)}>Revoke</button>
      <button onClick={() => setDisabled(false)}>Grant</button>
      <button onClick={advance}>Next</button>
      <button onClick={() => setQuestionIndex(questionIndex - 1)}>Previous</button>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[{ ...prompt, responseCapability }]}
        cwd="/repo"
        threadRef={threadRef}
        disabled={disabled}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={questionIndex}
        onAdvance={advance}
        onToggleOption={(questionId, value) => {
          const question = prompt.questions.find((entry) => entry.id === questionId)!;
          setAnswers((existing) => ({
            ...existing,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[questionId],
              value,
            ),
          }));
        }}
        onDismiss={() => {}}
      />
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function buttonWithText(text: string) {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(text),
  );
  expect(button, `button ${text}`).toBeDefined();
  return button!;
}

async function chooseOption() {
  await act(async () => buttonWithText("Incremental").click());
}

async function navigate(label: string) {
  await act(async () => buttonWithText(label).click());
}

function activeIndex() {
  return container.querySelector("output")!.textContent;
}

it("does not skip the next unanswered question after manual advance", async () => {
  await act(async () => root.render(<Questions />));
  await chooseOption();
  await navigate("Next");
  expect(activeIndex()).toBe("1");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");

  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("2");
});

it("does not undo previous-question navigation with a stale timer", async () => {
  await act(async () => root.render(<Questions initialIndex={1} />));
  await chooseOption();
  await navigate("Previous");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
});

it("still auto-advances once after the answer draft rerenders the same question", async () => {
  await act(async () => root.render(<Questions />));
  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
});

it("cancels progression on revocation and resumes only after a new selection under a grant", async () => {
  await act(async () => root.render(<Questions />));
  await chooseOption();
  await navigate("Revoke");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
  await navigate("Grant");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
});

it("blocks native option mutation and progression for a nonresumable request", async () => {
  await act(async () => root.render(<Questions responseCapability="not_resumable" />));
  const option = buttonWithText("Incremental");
  expect(option.disabled).toBe(true);
  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
  expect(option.querySelectorAll("svg")).toHaveLength(0);
});

it("cancels an existing timer when the provider capability becomes nonresumable", async () => {
  await act(async () => root.render(<Questions />));
  await chooseOption();
  await act(async () => root.render(<Questions responseCapability="not_resumable" />));
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
});

it("preserves digit selection and ignores shortcuts in editable fields", async () => {
  await act(async () => root.render(<Questions />));
  const input = document.createElement("input");
  document.body.append(input);
  try {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(200));
    expect(activeIndex()).toBe("0");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(200));
    expect(activeIndex()).toBe("1");
  } finally {
    input.remove();
  }
});
