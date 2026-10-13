import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { isPendingUserInputOptionSelected } from "../../lib/threadActivity";
import type { PendingUserInputCardProps } from "./PendingUserInputCard";

type BodyProps = Pick<
  PendingUserInputCardProps,
  "pendingUserInput" | "drafts" | "respondingUserInputId" | "onSelectOption"
> & {
  readonly disabled?: boolean;
  readonly renderCustomAnswer: (
    question: PendingUserInputCardProps["pendingUserInput"]["questions"][number],
    draft: PendingUserInputCardProps["drafts"][string] | undefined,
    disabled: boolean,
  ) => ReactNode;
};

export function PendingUserInputBody(props: BodyProps) {
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const responseDisabled =
    Boolean(props.disabled) ||
    !canRespond ||
    props.respondingUserInputId === props.pendingUserInput.requestId;
  return (
    <View className="gap-2.5">
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {props.pendingUserInput.questions.map((question) => {
        const draft = props.drafts[question.id];
        return (
          <View key={question.id} className="gap-2 pt-1">
            <Text className="font-goat-bold text-xs uppercase tracking-[1px] text-foreground-muted">
              {question.header}
            </Text>
            <Text className="font-sans text-base leading-snug text-foreground">
              {question.question}
            </Text>
            <View className="gap-2">
              {question.options.map((option) => {
                const optionValue = option.value ?? option.label.trim();
                const selected = isPendingUserInputOptionSelected(question, draft, optionValue);
                const description =
                  option.description !== option.label ? option.description : undefined;
                return (
                  <Pressable
                    key={optionValue}
                    accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                    accessibilityState={{ checked: selected, disabled: responseDisabled }}
                    disabled={responseDisabled}
                    className={cn(
                      "min-h-12 w-full rounded-2xl border px-3.5 py-3",
                      selected ? "border-primary bg-primary/10" : "border-border bg-input",
                    )}
                    onPress={() =>
                      props.onSelectOption(props.pendingUserInput.requestId, question, optionValue)
                    }
                  >
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text
                        className={cn(
                          "font-goat-bold text-sm",
                          selected ? "text-foreground" : "text-foreground-secondary",
                        )}
                      >
                        {option.label}
                      </Text>
                      {description ? (
                        <Text className="font-sans text-sm leading-5 text-foreground-muted">
                          {description}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {question.allowCustomAnswer !== false
              ? props.renderCustomAnswer(question, draft, responseDisabled)
              : null}
          </View>
        );
      })}
    </View>
  );
}
