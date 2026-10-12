import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface GoatBotRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Where asking the server for its bot stands on the current connection. */
export type GoatBotEnsureState =
  | { readonly state: "idle" }
  | { readonly state: "pending" }
  | { readonly state: "confirmed"; readonly bot: GoatBotRef }
  | { readonly state: "legacy_active" }
  | { readonly state: "failed"; readonly message: string };
