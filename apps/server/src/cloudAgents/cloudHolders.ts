import type {
  CloudAgentProvider,
  CloudHolder,
  CloudHolderName,
  ProviderDiagnosis,
} from "@goat/contracts";

/**
 * Pure decisions for cloud credential holders: what one environment's provider diagnosis says
 * about holding a provider's runs, and which holder a launch goes to.
 *
 * @module cloudAgents/cloudHolders
 */

export const CLOUD_AGENT_LABELS: Record<CloudAgentProvider, string> = {
  claudeCloud: "Claude Cloud",
  cursorCloud: "Cursor Cloud",
  devinCloud: "Devin Cloud",
};

/** What a person runs, on the machine that should hold the login. */
export const CLOUD_AGENT_LOGIN_STEP: Record<CloudAgentProvider, string> = {
  claudeCloud: "run `claude auth login --claudeai`",
  cursorCloud: "sign in to Cursor in GOAT Settings and enable Cursor Cloud",
  devinCloud: "sign in to Devin (`devin auth login`) and enable Devin Cloud",
};

/**
 * Whether a run started outside GOAT can be followed through the holder's sign-in. Devin's CLI
 * binds sessions to the sign-in that created them, so registered Devin sessions stay link-only.
 */
export const CAN_FOLLOW_REGISTERED: Record<CloudAgentProvider, boolean> = {
  claudeCloud: true,
  cursorCloud: true,
  devinCloud: false,
};

/** The provider's best instance on one environment, reduced to the holder's answer. */
export function holderFromDiagnoses(input: {
  readonly provider: CloudAgentProvider;
  readonly host: string | null;
  readonly diagnoses: ReadonlyArray<ProviderDiagnosis>;
  readonly runtime: CloudHolder["runtime"];
  readonly accountLabel?: (instanceId: string) => string | undefined;
  readonly activeRuns?: number;
}): CloudHolder {
  const ofProvider = input.diagnoses.filter((diagnosis) => diagnosis.driver === input.provider);
  const chosen =
    ofProvider.find((diagnosis) => diagnosis.ready) ??
    ofProvider.find((diagnosis) => diagnosis.configured) ??
    ofProvider[0];
  const base = {
    provider: input.provider,
    host: input.host,
    runtime: input.runtime,
    ...(input.activeRuns === undefined ? {} : { activeRuns: input.activeRuns }),
  } as const;
  if (chosen === undefined)
    return {
      ...base,
      ready: false,
      reason: `No ${CLOUD_AGENT_LABELS[input.provider]} instance here.`,
    };
  const failed = chosen.checks.find((check) => check.status === "fail");
  const label = chosen.ready ? input.accountLabel?.(chosen.instanceId) : undefined;
  return {
    ...base,
    instanceId: chosen.instanceId,
    ready: chosen.ready,
    ...(label === undefined ? {} : { accountLabel: label.slice(0, 200) }),
    ...(failed === undefined ? {} : { reason: failed.summary.slice(0, 1000) }),
    ...(failed?.fix?.command === undefined ? {} : { command: failed.fix.command.slice(0, 300) }),
  };
}

/** A holder that answered for a host which cannot take routed launches is shown, not used. */
const usable = (holder: CloudHolder) => holder.ready && holder.runtime === "current";

const nameOf = (holder: CloudHolder) => holder.host ?? "local";

export type HolderChoice =
  | { readonly ok: true; readonly holder: CloudHolder }
  | { readonly ok: false; readonly message: string };

/**
 * Explicit preference first; otherwise a ready holder whose runtime takes routed calls, the
 * least loaded, then this environment, then hosts by name, so the same table always picks the
 * same holder.
 */
export function chooseHolder(
  provider: CloudAgentProvider,
  holders: ReadonlyArray<CloudHolder>,
  preference: CloudHolderName | undefined,
): HolderChoice {
  const label = CLOUD_AGENT_LABELS[provider];
  const candidates = holders.filter((holder) => holder.provider === provider);
  if (preference !== undefined) {
    const wanted = candidates.find((holder) => nameOf(holder) === preference);
    if (wanted === undefined)
      return {
        ok: false,
        message: `${preference} is not a connected holder for ${label}. goat_cloud_holders lists them.`,
      };
    if (wanted.runtime === "update_required")
      return {
        ok: false,
        message: `Update GOAT on ${preference}: it cannot take routed ${label} launches yet.`,
      };
    if (wanted.runtime === "unreachable")
      return {
        ok: false,
        message: `${preference} is unreachable: ${wanted.reason ?? "no answer"}`,
      };
    if (!wanted.ready)
      return {
        ok: false,
        message: `${preference} holds no usable ${label} login: ${wanted.reason ?? "not ready"}`,
      };
    return { ok: true, holder: wanted };
  }
  const ready = candidates
    .filter(usable)
    .toSorted(
      (left, right) =>
        (left.activeRuns ?? 0) - (right.activeRuns ?? 0) ||
        (left.host === null ? -1 : right.host === null ? 1 : left.host.localeCompare(right.host)),
    );
  if (ready[0] !== undefined) return { ok: true, holder: ready[0] };
  const outdated = candidates.filter(
    (holder) => holder.ready && holder.runtime === "update_required",
  );
  const names = candidates.map(nameOf);
  return {
    ok: false,
    message:
      outdated.length > 0
        ? `${label} logins exist on ${outdated.map(nameOf).join(", ")}, but GOAT there is too old to take routed launches. Update GOAT on one of them.`
        : `No connected host holds a ${label} login; ${CLOUD_AGENT_LOGIN_STEP[provider]} on one of: ${names.length === 0 ? "this machine" : names.join(", ")}.`,
  };
}
