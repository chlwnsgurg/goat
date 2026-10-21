import type {
  CuaDriverMcpConfiguration,
  ProviderDriverKind,
  ProviderInteractionMode,
  ThreadId,
} from "@goat/contracts";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as CuaDriver from "./CuaDriver.ts";

/**
 * Providers whose agent process runs on this host and can spawn the driver's
 * stdio MCP server. Cloud providers run elsewhere, and the driver would
 * operate this host's desktop on their behalf; Muse only accepts HTTP session
 * servers. See ADR-0020 for the per-adapter table.
 */
const COMPUTER_USE_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "antigravity",
  "acpRegistry",
  "opencode",
  "pi",
]);

export type ComputerUseRefusal =
  | "unsupported-provider"
  | "disabled"
  | "plan"
  | "read-only"
  | "unavailable";

/**
 * Every provider session's computer use comes from this one decision, so a
 * policy that gates some threads (such as unattended origins) changes it here
 * without touching adapters. A future gated branch hands adapters its own
 * stdio descriptor through the same session field.
 */
export type ComputerUseAttachment =
  | { readonly _tag: "none"; readonly reason: ComputerUseRefusal }
  | {
      readonly _tag: "direct";
      readonly mcp: CuaDriverMcpConfiguration;
      /** The managed server replaces a `cua-driver` the user configured for the provider. */
      readonly overrideUserConfig: boolean;
    };

export interface ComputerUseAttachmentInput {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind | undefined;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly readOnly: boolean;
}

const none = (reason: ComputerUseRefusal): ComputerUseAttachment => ({ _tag: "none", reason });

/**
 * Starting the driver is the last step: a thread that cannot use it never
 * starts the daemon.
 */
export const computerUseAttachment = Effect.fn("ComputerUse.attachment")(function* (
  cua: Option.Option<CuaDriver.CuaDriver["Service"]>,
  input: ComputerUseAttachmentInput,
) {
  if (input.driver === undefined || !COMPUTER_USE_PROVIDER_DRIVERS.has(input.driver))
    return none("unsupported-provider");
  if (Option.isNone(cua) || !(yield* cua.value.enabled)) return none("disabled");
  if (input.interactionMode === "plan") return none("plan");
  if (input.readOnly) return none("read-only");
  const mcp = yield* cua.value.acquire;
  return Option.isSome(mcp)
    ? ({ _tag: "direct", mcp: mcp.value, overrideUserConfig: false } as const)
    : none("unavailable");
});

/** The session config adapters read, carrying exactly this decision's driver. */
export function withComputerUse(
  config: McpProviderSessionConfig,
  attachment: ComputerUseAttachment,
): McpProviderSessionConfig {
  const { cuaDriver: _previous, cuaDriverOverridesUserConfig: _previousOverride, ...rest } = config;
  return attachment._tag === "none"
    ? rest
    : {
        ...rest,
        cuaDriver: attachment.mcp,
        ...(attachment.overrideUserConfig ? { cuaDriverOverridesUserConfig: true } : {}),
      };
}
