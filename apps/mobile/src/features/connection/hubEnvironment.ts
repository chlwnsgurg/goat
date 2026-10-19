import type { EnvironmentId } from "@goat/contracts";
import { loadPreferences, updatePreferences } from "../../persistence/imperative";
import type { ConnectHubIntent } from "./connectHubIntent";

export { selectHubEnvironmentId } from "./connectHubIntent";

export async function loadHubEnvironmentId() {
  const preferences = await loadPreferences();
  return preferences.hubEnvironmentId ?? null;
}

export async function rememberHubEnvironment(input: {
  readonly intent: ConnectHubIntent;
  readonly pairedEnvironmentId: EnvironmentId;
}) {
  if (input.intent === "hub" || input.intent === "change-hub") {
    await updatePreferences(() => ({ hubEnvironmentId: input.pairedEnvironmentId }));
  }
}
