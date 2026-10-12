import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  buildGoatBotTimeline,
  createGoatBotSendQueue,
  goatBotItemReaders,
  goatBotReplyingSince,
  initialGoatBotEnsure,
  retryGoatBotEnsure,
  settleGoatBotEnsure,
  startGoatBotEnsure,
  syncGoatBotEnsure,
  type GoatBotEnsureMachine,
  type GoatBotPendingInput,
} from "@t3tools/client-runtime/goatBot";
import { goatBotIngestInput } from "@t3tools/client-runtime/state/channels";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ChannelBotRef, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { environmentCatalog } from "../../connection/catalog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { pickMobileGoatBotEnvironment } from "./goatBotHomeMode";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import {
  settleMobileGoatBotEnsure,
  type MobileGoatBotEnsureDestination,
} from "./mobileGoatBotEnsure";

interface Session {
  readonly machine: GoatBotEnsureMachine;
  readonly bot: ChannelBotRef | null;
  readonly connected: boolean;
  readonly canOperate: boolean;
  readonly queue: ReturnType<typeof createGoatBotSendQueue>;
  readonly pending: ReadonlyArray<GoatBotPendingInput>;
}
type Availability =
  | "connecting"
  | "offline"
  | "unsupported"
  | "permission"
  | "legacy_active"
  | "error"
  | "ready";

const sessions = new Map<EnvironmentId, Session>();
const listeners = new Set<() => void>();
const EMPTY_PENDING: ReadonlyArray<GoatBotPendingInput> = [];
const NO_PERMISSION = Atom.make(false);
const NO_CONNECTION = Atom.make(null);
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function update(environmentId: EnvironmentId, session: Session) {
  sessions.set(environmentId, session);
  for (const listener of listeners) listener();
}

function newSession(environmentId: EnvironmentId): Session {
  const queue = createGoatBotSendQueue({
    makeKey: uuidv4,
    onChange: () => {
      const current = sessions.get(environmentId);
      if (current) update(environmentId, { ...current, pending: current.queue.pendingInputs() });
    },
    canDispatch: (bot) => {
      const current = sessions.get(environmentId);
      return (
        current?.connected === true &&
        current.canOperate &&
        current.machine.ensure.state === "confirmed" &&
        current.bot?.environmentId === bot.environmentId &&
        current.bot.threadId === bot.threadId
      );
    },
    send: async ({ clientKey, text, receivedAt, bot }) => {
      const fullBot = sessions.get(environmentId)?.bot;
      if (
        !fullBot ||
        fullBot.threadId !== bot.threadId ||
        fullBot.environmentId !== bot.environmentId
      ) {
        throw new Error("GOAT Bot isn't available");
      }
      const result = await runAtomCommand(appAtomRegistry, channelEnvironment.ingest, {
        environmentId,
        input: goatBotIngestInput({ bot: fullBot, text, clientMessageId: clientKey, receivedAt }),
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return {
        requestKey: result.value.inputId,
        ...(result.value.state === "rejected"
          ? { rejected: "GOAT Bot did not accept this message" }
          : {}),
      };
    },
  });
  return {
    machine: initialGoatBotEnsure,
    bot: null,
    connected: false,
    canOperate: false,
    queue,
    pending: EMPTY_PENDING,
  };
}

/** A stable snapshot and a single ensure/send queue per destination environment. */
export function useMobileGoatBotSession(visible: boolean) {
  const home = useMobileGoatBotHomeMode();
  const environment = pickMobileGoatBotEnvironment(home.environments, home.botRef);
  const environmentId = environment?.environmentId ?? null;
  const connection = useAtomValue(
    environmentId === null ? NO_CONNECTION : environmentCatalog.stateAtom(environmentId),
  );
  const generation =
    connection !== null && AsyncResult.isSuccess(connection) ? connection.value.generation : null;
  const canEnsure = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.ensureBot.permissionAtom(environmentId),
  );
  const canIngest = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.ingest.permissionAtom(environmentId),
  );
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const getSnapshot = useCallback(
    () => (environmentId === null ? undefined : sessions.get(environmentId)),
    [environmentId],
  );
  const session = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const connected = environment?.connected === true;
  const capable = environment?.supportsChannelLedger === true;
  const connectionKey =
    connected && capable && generation !== null ? `${environmentId}:${generation}:channel` : null;
  const canOperate = canEnsure && canIngest;
  const selectedDestination = useRef<MobileGoatBotEnsureDestination | null>(null);
  useLayoutEffect(() => {
    selectedDestination.current = { environmentId, connectionKey };
    return () => {
      selectedDestination.current = null;
      if (environmentId === null) return;
      const previous = sessions.get(environmentId);
      // Returning to this environment must start a fresh request, even if the
      // old connection generation has not changed.
      if (previous && previous.machine.pending !== null) {
        update(environmentId, {
          ...previous,
          machine: retryGoatBotEnsure(previous.machine),
        });
      }
    };
  }, [environmentId, connectionKey]);

  useEffect(() => {
    if (environmentId === null) return;
    const previous = sessions.get(environmentId) ?? session ?? newSession(environmentId);
    const machine = syncGoatBotEnsure(previous.machine, connectionKey);
    let current = previous;
    if (
      !sessions.has(environmentId) ||
      machine !== previous.machine ||
      previous.connected !== connected ||
      previous.canOperate !== canOperate
    ) {
      current = {
        ...previous,
        machine,
        connected,
        canOperate,
        bot: machine === previous.machine ? previous.bot : null,
      };
      update(environmentId, current);
    }
    if (
      !visible ||
      !home.loaded ||
      connectionKey === null ||
      !canEnsure ||
      current.machine.ensure.state !== "idle"
    )
      return;
    const request = startGoatBotEnsure(current.machine);
    update(environmentId, { ...current, machine: request.machine });
    const settle = (
      result: Parameters<typeof settleGoatBotEnsure>[2],
      bot: ChannelBotRef | null = null,
    ) => {
      const latest = sessions.get(environmentId);
      if (!latest) return;
      const liveConnection = appAtomRegistry.get(environmentCatalog.stateAtom(environmentId));
      const liveConnectionKey =
        AsyncResult.isSuccess(liveConnection) && liveConnection.value.phase === "connected"
          ? `${environmentId}:${liveConnection.value.generation}:channel`
          : null;
      const selected = selectedDestination.current;
      const settled = settleMobileGoatBotEnsure(
        latest.machine,
        request.token,
        result,
        { environmentId, connectionKey },
        selected && {
          environmentId: selected.environmentId,
          connectionKey: selected.connectionKey === liveConnectionKey ? liveConnectionKey : null,
        },
      );
      if (settled === latest.machine) return;
      update(environmentId, { ...latest, machine: settled, bot });
      if (bot) savePreferences({ goatBotRef: bot });
    };
    void (async () => {
      try {
        const result = await runAtomCommand(appAtomRegistry, channelEnvironment.ensureBot, {
          environmentId,
          input: {},
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        settle({ kind: "confirmed", bot: result.value }, result.value);
      } catch (error) {
        const legacy =
          typeof error === "object" &&
          error !== null &&
          "reason" in error &&
          error.reason === "legacy_active";
        settle(
          legacy
            ? { kind: "legacy_active" }
            : {
                kind: "failed",
                message: error instanceof Error ? error.message : "Couldn't reach GOAT Bot",
              },
        );
      }
    })();
  }, [
    environmentId,
    connected,
    connectionKey,
    canOperate,
    canEnsure,
    home.loaded,
    visible,
    savePreferences,
    session,
  ]);

  const ensure =
    session?.machine.generation === connectionKey
      ? session.machine.ensure
      : initialGoatBotEnsure.ensure;
  const confirmedBot = ensure.state === "confirmed" ? (session?.bot ?? null) : null;
  const bot = confirmedBot ?? home.botRef;
  const threadRef = useMemo(
    () => (visible && bot ? scopeThreadRef(bot.environmentId, bot.threadId) : null),
    [visible, bot],
  );
  const shell = useThreadShell(threadRef);
  const shellReadiness = useEnvironmentShellReadiness(
    visible ? (bot?.environmentId ?? null) : null,
  );
  const seenBot = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !confirmedBot || shellReadiness.status !== "live") return;
    const key = `${confirmedBot.environmentId}:${confirmedBot.threadId}`;
    if (shell !== null && shell.deletedAt == null) {
      seenBot.current = key;
      return;
    }
    // A live snapshot can precede the bot-creation event. Re-ensure only a
    // deleted shell or a bot we already observed before it disappeared.
    if (shell?.deletedAt == null && seenBot.current !== key) return;
    const current = sessions.get(confirmedBot.environmentId);
    if (current?.machine.ensure.state === "confirmed") {
      seenBot.current = null;
      update(confirmedBot.environmentId, {
        ...current,
        bot: null,
        machine: retryGoatBotEnsure(current.machine),
      });
    }
  }, [visible, confirmedBot, shell, shellReadiness.status]);
  const visibleTurnItems = useThreadVisibleTurnItems({
    environmentId: visible ? (bot?.environmentId ?? null) : null,
    threadId: visible ? (bot?.threadId ?? null) : null,
  });
  const queue = session?.queue;
  useEffect(() => {
    if (!visible || !queue) return;
    const keys = new Set<string>();
    for (const { item } of visibleTurnItems) {
      if (item.type !== "user_message") continue;
      const presentation = goatBotItemReaders.message(item);
      if (presentation?.requestKey) keys.add(presentation.requestKey);
      if (presentation?.clientKey) keys.add(presentation.clientKey);
    }
    queue.acknowledge(keys);
  }, [visible, queue, visibleTurnItems]);
  const pendingInputs = session?.pending ?? EMPTY_PENDING;
  const rows = useMemo(
    () => buildGoatBotTimeline({ visibleTurnItems, pendingInputs, readers: goatBotItemReaders }),
    [visibleTurnItems, pendingInputs],
  );
  const replyingSince = useMemo(
    () => goatBotReplyingSince({ visibleTurnItems, readers: goatBotItemReaders }),
    [visibleTurnItems],
  );
  const ready = connected && capable && connectionKey !== null && confirmedBot !== null;
  const canSend = visible && ready && canOperate;
  const connecting =
    environment?.connecting === true ||
    (home.botRef === null &&
      home.environments.some((entry) => entry.supportsChannelLedger && entry.connecting));
  const availability: Availability = connecting
    ? "connecting"
    : !connected
      ? "offline"
      : !capable
        ? "unsupported"
        : !canEnsure || !canIngest
          ? "permission"
          : ensure.state === "legacy_active"
            ? "legacy_active"
            : ensure.state === "failed"
              ? "error"
              : ready
                ? "ready"
                : "connecting";
  const onSend = useCallback(
    (text: string) => {
      if (!canSend || !confirmedBot || !text.trim()) return false;
      queue?.submit(text.trim(), confirmedBot);
      return true;
    },
    [canSend, confirmedBot, queue],
  );
  const onRetryInput = useCallback(
    (key: string) => {
      if (canSend) queue?.retry(key);
    },
    [canSend, queue],
  );
  const onRetryAvailability = useCallback(() => {
    if (environmentId === null) return;
    const current = sessions.get(environmentId);
    if (current)
      update(environmentId, {
        ...current,
        bot: null,
        machine: retryGoatBotEnsure(current.machine),
      });
  }, [environmentId]);
  return {
    rows,
    replyingSince,
    canSend,
    availability,
    error: ensure.state === "failed" ? ensure.message : null,
    onSend,
    onRetryInput,
    onRetryAvailability,
  };
}
