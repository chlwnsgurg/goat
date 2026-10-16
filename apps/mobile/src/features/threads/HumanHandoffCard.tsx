import { useAtomValue } from "@effect/atom-react";
import {
  isHandoffPending,
  type EnvironmentId,
  type Handoff,
  type HandoffHuman,
} from "@goat/contracts";
import { useRef, useState } from "react";
import { Linking, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

export function HumanHandoffCard(props: {
  environmentId: EnvironmentId;
  handoff: Handoff;
  inherited: boolean;
}) {
  const { handoff } = props;
  const allowed = useAtomValue(
    serverEnvironment.respondHandoff.permissionAtom(props.environmentId),
  );
  const open = useAtomCommand(serverEnvironment.openHandoff, {
    label: "open handoff",
    reportFailure: false,
    reportDefect: false,
  });
  const respond = useAtomCommand(serverEnvironment.respondHandoff, {
    label: "respond to handoff",
    reportFailure: false,
    reportDefect: false,
  });
  const [human, setHuman] = useState<HandoffHuman | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const act = async (action: "opened" | "completed" | "declined" | "cancelled") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const input = { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId };
    try {
      if (action === "opened") {
        const result = await open({ environmentId: props.environmentId, input });
        if (result._tag === "Success") setHuman(result.value.human);
        else setError("Could not open this handoff. Check its status and your permissions.");
      } else {
        const result = await respond({
          environmentId: props.environmentId,
          input: { ...input, action },
        });
        if (result._tag === "Success") setHuman(null);
        else setError("Could not update this handoff. It may already be resolved or expired.");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-goat-bold text-base text-foreground">{handoff.title}</Text>
      <Text className="font-sans text-sm text-foreground-muted">{handoff.reason}</Text>
      <Text className="font-sans text-xs text-foreground-muted">
        {handoff.kind.replaceAll("_", " ")} · {handoff.state}
      </Text>
      {!isHandoffPending(handoff.state) ? (
        <Text className="font-sans text-sm text-foreground-muted">
          {handoff.resolvedBy ? `${handoff.state} by ${handoff.resolvedBy}` : handoff.state}
        </Text>
      ) : props.inherited ? (
        <Text className="font-sans text-sm text-foreground-muted">
          Review this request in its original thread.
        </Text>
      ) : (
        <>
          {human === null ? (
            <RequestActionButton
              label="Review request"
              disabled={busy || !allowed}
              onPress={() => void act("opened")}
            />
          ) : (
            <>
              <Text className="font-sans text-sm text-foreground">Where: {human.location}</Text>
              {human.url ? (
                <RequestActionButton
                  label="Open sign-in page"
                  onPress={() =>
                    void Linking.openURL(human.url!).catch(() =>
                      setError("Could not open the sign-in page."),
                    )
                  }
                />
              ) : null}
              {human.userCode ? (
                <Text selectable className="font-mono text-base text-foreground">
                  Code: {human.userCode}
                </Text>
              ) : null}
              {human.command ? (
                <>
                  <Text className="font-sans text-sm text-foreground-muted">
                    Run in your own terminal:
                  </Text>
                  <Text selectable className="font-mono text-sm text-foreground">
                    {human.command}
                  </Text>
                </>
              ) : null}
              <Text className="font-sans text-xs text-foreground-muted">
                Sign-in details stay private and are never sent to the agent.
              </Text>
              <RequestActionButton
                label={handoff.kind === "approval" ? "Approve" : "I've completed this step"}
                disabled={busy || !allowed}
                onPress={() => void act("completed")}
              />
            </>
          )}
          <RequestActionButton
            label="Decline"
            disabled={busy || !allowed}
            onPress={() => void act("declined")}
          />
          <RequestActionButton
            label="Cancel request"
            disabled={busy || !allowed}
            onPress={() => void act("cancelled")}
          />
        </>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
