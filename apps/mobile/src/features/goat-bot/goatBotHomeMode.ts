import type { ChannelBotRef, EnvironmentId } from "@t3tools/contracts";

export type MobileHomeMode = "thread" | "bot";

export interface MobileGoatBotEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly supportsChannelLedger: boolean;
  readonly connecting: boolean;
}

export function mobileGoatBotKnown(
  environments: ReadonlyArray<Pick<MobileGoatBotEnvironment, "supportsChannelLedger">>,
  botRef: ChannelBotRef | null,
): boolean {
  return botRef !== null || environments.some((environment) => environment.supportsChannelLedger);
}

export function effectiveHomeMode(
  preference: MobileHomeMode | undefined,
  botKnown: boolean,
): MobileHomeMode {
  return botKnown && preference === "bot" ? "bot" : "thread";
}

/** A saved bot owns its environment even while that computer is unavailable. */
export function pickMobileGoatBotEnvironment(
  environments: ReadonlyArray<MobileGoatBotEnvironment>,
  botRef: ChannelBotRef | null,
): MobileGoatBotEnvironment | null {
  if (botRef !== null) {
    return (
      environments.find((environment) => environment.environmentId === botRef.environmentId) ?? null
    );
  }
  return (
    [...environments]
      .filter((environment) => environment.connected && environment.supportsChannelLedger)
      .sort(
        (left, right) =>
          left.label.localeCompare(right.label) ||
          left.environmentId.localeCompare(right.environmentId),
      )[0] ?? null
  );
}

/** Child detail pages still belong to the workspace stack above Home. */
export function mobileGoatBotDetailOpen(state: {
  readonly index: number;
  readonly routes: ReadonlyArray<{ readonly name: string }>;
}): boolean {
  const homeIndex = state.routes.findIndex((route) => route.name === "Home");
  return homeIndex < 0 ? state.routes[state.index] !== undefined : state.index > homeIndex;
}

/** A sheet's card descendants share its presentation envelope. */
export function mobileGoatBotWorkspaceVisible(presentations: ReadonlyArray<string | undefined>) {
  return presentations.every(
    (presentation) =>
      presentation === "formSheet" ||
      presentation === "transparentModal" ||
      presentation === "containedTransparentModal",
  );
}
