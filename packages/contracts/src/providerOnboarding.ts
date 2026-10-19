/**
 * Adding a provider from a client or an agent: which drivers can be added on an
 * environment, their install and sign-in state, and the redacted view of a
 * sign-in flow that MCP tools may return.
 *
 * Kept apart from providerSetup.ts so host-aware callers (a provider x host
 * matrix) can import these shapes and add an optional host without pulling in
 * the client RPC types. Nothing here may carry API keys, OAuth tokens,
 * authorization codes, callback URLs, terminal output, or credential values.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HandoffSummary } from "./handoff.ts";
import { ProviderDiagnosisFix } from "./providerDiagnosis.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import type { ProviderAuthState } from "./providerSetup.ts";
import { ServerProviderAuthStatus, ServerProviderState } from "./server.ts";

/** The handoff target path that asks a person to finish provider setup in the app. */
export const PROVIDER_SETUP_HANDOFF_PATH = "provider.setup";

/**
 * How a person signs in. `inApp` methods finish inside the add-provider popup;
 * `command` means the provider only signs in from its own terminal command,
 * and `environment` means it reads a key from the instance's environment.
 */
export const ProviderSignInKind = Schema.Literals([
  "browser",
  "deviceCode",
  "terminal",
  "credentials",
  "agent",
  "command",
  "environment",
  "linked",
  "none",
]);
export type ProviderSignInKind = typeof ProviderSignInKind.Type;

export const ProviderAddableInstance = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  status: ServerProviderState,
  auth: ServerProviderAuthStatus,
});
export type ProviderAddableInstance = typeof ProviderAddableInstance.Type;

export const ProviderAddableDriver = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  install: Schema.Struct({
    state: Schema.Literals(["installed", "missing", "unknown"]),
    /** GOAT can download and install this CLI from the add-provider popup. */
    inApp: Schema.Boolean,
    version: Schema.NullOr(TrimmedNonEmptyString),
  }),
  signIn: Schema.Struct({
    kind: ProviderSignInKind,
    inApp: Schema.Boolean,
    /** The provider's own command when sign-in cannot finish in the app. */
    command: Schema.NullOr(TrimmedNonEmptyString),
  }),
  instances: Schema.Array(ProviderAddableInstance),
});
export type ProviderAddableDriver = typeof ProviderAddableDriver.Type;

export const ProviderAddableListResult = Schema.Struct({
  environmentId: EnvironmentId,
  drivers: Schema.Array(ProviderAddableDriver),
});
export type ProviderAddableListResult = typeof ProviderAddableListResult.Type;

/**
 * A sign-in flow as an agent may see it. A device code and its verification
 * URL are meant to be shown to a person; everything else a flow carries
 * (authorization and callback URLs, terminal output, credential fields) stays
 * with the client that owns the flow.
 */
export const ProviderLoginFlow = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: Schema.NullOr(TrimmedNonEmptyString),
  phase: Schema.Literals([
    "idle",
    "starting",
    "waiting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  /** Where the person continues: a device code page, or the GOAT app (browser, terminal, or form). */
  continueIn: Schema.NullOr(Schema.Literals(["device", "app"])),
  deviceCode: Schema.NullOr(
    Schema.Struct({ url: TrimmedNonEmptyString, userCode: TrimmedNonEmptyString }),
  ),
  expiresAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String),
});
export type ProviderLoginFlow = typeof ProviderLoginFlow.Type;

const isHttpsUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** Projects a flow state onto the fields an agent may read. */
export const redactProviderAuthState = (state: ProviderAuthState): ProviderLoginFlow => {
  const interaction = state.interaction ?? null;
  const deviceCode =
    interaction?.type === "deviceCode" && isHttpsUrl(interaction.url)
      ? { url: interaction.url, userCode: interaction.userCode }
      : null;
  const active =
    state.phase === "starting" || state.phase === "waiting" || state.phase === "verifying";
  return {
    instanceId: state.instanceId,
    flowId: state.flowId,
    phase: state.phase,
    continueIn: deviceCode ? "device" : active && interaction !== null ? "app" : null,
    deviceCode,
    expiresAt: state.expiresAt,
    message: state.message,
  };
};

const ProviderOnboardingError = Schema.Struct({
  kind: Schema.Literal("error"),
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  fix: Schema.optionalKey(ProviderDiagnosisFix),
});

const NeedsHuman = Schema.Struct({
  kind: Schema.Literal("needs_human"),
  handoff: HandoffSummary,
  next: Schema.Struct({
    after: Schema.Literal("approval"),
    call: Schema.Literal("goat_provider_addable_list"),
  }),
});

export const ProviderLoginStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  methodId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type ProviderLoginStartInput = typeof ProviderLoginStartInput.Type;

export const ProviderLoginFlowInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type ProviderLoginFlowInput = typeof ProviderLoginFlowInput.Type;

export const ProviderLoginResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("flow"), flow: ProviderLoginFlow }),
  NeedsHuman,
  ProviderOnboardingError,
]);
export type ProviderLoginResult = typeof ProviderLoginResult.Type;
export const ProviderLoginResultJson = Schema.toCodecJson(ProviderLoginResult);

/** Asks a person to open the add-provider popup, preselecting a driver or an instance to sign in. */
export const ProviderSetupOpenInput = Schema.Struct({
  driver: Schema.optionalKey(ProviderDriverKind),
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ProviderSetupOpenInput = typeof ProviderSetupOpenInput.Type;

export const ProviderSetupOpenResult = Schema.Union([NeedsHuman, ProviderOnboardingError]);
export type ProviderSetupOpenResult = typeof ProviderSetupOpenResult.Type;
export const ProviderSetupOpenResultJson = Schema.toCodecJson(ProviderSetupOpenResult);

/** What the popup opens to; delivered only through an authenticated handoff open. */
export const ProviderSetupIntent = Schema.Struct({
  driver: Schema.optionalKey(ProviderDriverKind),
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ProviderSetupIntent = typeof ProviderSetupIntent.Type;
