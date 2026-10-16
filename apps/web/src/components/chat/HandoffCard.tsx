import { useAtomValue } from "@effect/atom-react";
import {
  isHandoffPending,
  type EnvironmentId,
  type Handoff,
  type HandoffHuman,
} from "@goat/contracts";
import { useRef, useState } from "react";
import * as DateTime from "effect/DateTime";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

/** Human instructions are fetched only on review; they never enter the thread transcript. */
export function HandoffCard(props: {
  environmentId: EnvironmentId;
  handoff: Handoff;
  inherited: boolean;
}) {
  const { handoff } = props;
  const canOpen = useAtomValue(serverEnvironment.openHandoff.permissionAtom(props.environmentId));
  const canRespond = useAtomValue(
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const pending = isHandoffPending(handoff.state);
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
        else
          setError(
            "Could not open this handoff. It may have expired or require additional permissions.",
          );
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
    <section
      aria-label={handoff.title}
      data-v2-item-type="human_handoff"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">{handoff.title}</h3>
        <p className="text-sm text-muted-foreground">{handoff.reason}</p>
        <p className="text-xs text-muted-foreground">
          {handoff.kind.replaceAll("_", " ")} · {handoff.state}
          {handoff.expiresAt && pending
            ? ` · Expires ${DateTime.toDate(handoff.expiresAt).toLocaleTimeString()}`
            : ""}
        </p>
      </div>
      {!pending ? (
        <p className="text-sm text-muted-foreground">
          {handoff.resolvedBy ? `${handoff.state} by ${handoff.resolvedBy}` : handoff.state}
        </p>
      ) : props.inherited ? (
        <p className="text-sm text-muted-foreground">Review this request in its original thread.</p>
      ) : (
        <>
          {human === null ? (
            <div>
              <Button disabled={busy || !canOpen} onClick={() => void act("opened")}>
                Review request
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-2 text-sm">
              <p className="text-foreground">Where: {human.location}</p>
              {human.url ? (
                <a
                  className="break-all text-primary underline"
                  href={human.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open sign-in page
                </a>
              ) : null}
              {human.userCode ? (
                <p>
                  Enter code: <code className="select-all font-mono">{human.userCode}</code>
                </p>
              ) : null}
              {human.command ? (
                <>
                  <p>Run this command in your own terminal:</p>
                  <pre className="overflow-x-auto rounded-md bg-muted p-3">
                    <code>{human.command}</code>
                  </pre>
                </>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Sign-in details stay private and are never sent to the agent.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {human !== null ? (
              <Button disabled={busy || !canRespond} onClick={() => void act("completed")}>
                {handoff.kind === "approval" ? "Approve" : "I've completed this step"}
              </Button>
            ) : null}
            <Button
              variant="ghost-muted"
              disabled={busy || !canRespond}
              onClick={() => void act("declined")}
            >
              Decline
            </Button>
            <Button
              variant="ghost-muted"
              disabled={busy || !canRespond}
              onClick={() => void act("cancelled")}
            >
              Cancel request
            </Button>
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
