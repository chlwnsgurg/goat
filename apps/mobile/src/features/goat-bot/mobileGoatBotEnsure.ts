import {
  settleGoatBotEnsure,
  type GoatBotEnsureMachine,
  type GoatBotEnsureResult,
} from "@t3tools/client-runtime/goatBot";
import type { EnvironmentId } from "@t3tools/contracts";

export interface MobileGoatBotEnsureDestination {
  readonly environmentId: EnvironmentId | null;
  readonly connectionKey: string | null;
}

/** Per-environment tokens cannot authorize an obsolete selected destination. */
export function settleMobileGoatBotEnsure(
  machine: GoatBotEnsureMachine,
  token: number,
  result: GoatBotEnsureResult,
  request: MobileGoatBotEnsureDestination,
  live: MobileGoatBotEnsureDestination | null,
): GoatBotEnsureMachine {
  if (
    request.environmentId === null ||
    request.connectionKey === null ||
    live?.environmentId !== request.environmentId ||
    live.connectionKey !== request.connectionKey ||
    machine.generation !== request.connectionKey ||
    (result.kind === "confirmed" && result.bot.environmentId !== request.environmentId)
  ) {
    return machine;
  }
  return settleGoatBotEnsure(machine, token, result);
}
