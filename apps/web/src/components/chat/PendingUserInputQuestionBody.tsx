import type { ScopedThreadRef, UserInputQuestion } from "@goat/contracts";
import ChatMarkdown from "../ChatMarkdown";
import { CheckIcon } from "../solar";
import { cn } from "../../lib/utils";

export function PendingUserInputQuestionBody({
  question,
  cwd,
  threadRef,
  selectedOptionValues,
  customAnswerActive,
  optimisticOptionValue,
  disabled,
  showShortcuts = false,
  onSelect,
}: {
  question: UserInputQuestion;
  /** Resolves file links in the question text. */
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  selectedOptionValues: readonly string[];
  customAnswerActive: boolean;
  optimisticOptionValue?: string | undefined;
  disabled: boolean;
  showShortcuts?: boolean;
  onSelect: (questionId: string, optionValue: string) => void;
}) {
  return (
    <>
      <ChatMarkdown
        text={question.question}
        cwd={cwd}
        threadRef={threadRef}
        className="text-foreground/85"
      />
      {question.multiSelect ? (
        <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
      ) : null}
      <div className="mt-2 space-y-0.5">
        {question.options.map((option, index) => {
          const optionValue = option.value ?? option.label;
          const isSelected =
            optimisticOptionValue === optionValue ||
            (!customAnswerActive && selectedOptionValues.includes(optionValue));
          const shortcutKey = showShortcuts && index < 9 ? index + 1 : null;
          return (
            <button
              key={`${question.id}:${optionValue}`}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(question.id, optionValue)}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
                isSelected
                  ? "bg-muted/55 text-foreground"
                  : "bg-transparent text-foreground/85 hover:bg-muted/30",
                disabled && "opacity-50 cursor-not-allowed",
                !disabled && "cursor-pointer",
              )}
            >
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="text-secondary-label text-2xs">{option.description}</span>
                ) : null}
              </div>
              {isSelected ? (
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              ) : shortcutKey !== null ? (
                <kbd className="flex size-5 shrink-0 items-center justify-center text-3xs font-medium text-muted-foreground tabular-nums">
                  {shortcutKey}
                </kbd>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
