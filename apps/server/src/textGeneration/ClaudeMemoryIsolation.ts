import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@goat/shared/HostProcess";
import { TextGenerationError } from "@goat/contracts";
import {
  MemoryGenerationRunnerError,
  type MemoryOperationName,
} from "@goat/provider-core/server/memoryGenerationRunner";

const ManagedSettings = Schema.Record(Schema.String, Schema.Unknown);
const decodeManagedSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(ManagedSettings));

/** --settings disableAllHooks cannot override managed hooks. Inspect every file/drop-in
 * before spawning; native registry policy and subscription-fetched policy are uncertified.
 * https://code.claude.com/docs/en/managed-settings
 */
export const verifyClaudeMemoryHooks = Effect.fn("Claude.verifyMemoryHooks")(function* (
  operation: MemoryOperationName,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const failure = new TextGenerationError({
    operation,
    detail: "Claude managed hooks could not be certified disabled for memory generation.",
    cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
  });
  return yield* Effect.gen(function* () {
    // Direct Anthropic credentials (including API keys) can fetch managed policy at startup.
    // Only API-key authentication to a non-Anthropic endpoint has documented skipped delivery.
    // https://code.claude.com/docs/en/server-managed-settings#platform-availability
    const endpoint = yield* Effect.try(() => new URL(environment.ANTHROPIC_BASE_URL ?? ""));
    if (
      !environment.ANTHROPIC_API_KEY ||
      environment.CLAUDE_CODE_OAUTH_TOKEN ||
      environment.ANTHROPIC_AUTH_TOKEN ||
      endpoint.hostname === "api.anthropic.com" ||
      (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
      environment.CLAUDE_CODE_USE_BEDROCK ||
      environment.CLAUDE_CODE_USE_VERTEX ||
      environment.CLAUDE_CODE_USE_FOUNDRY ||
      environment.WSL_DISTRO_NAME ||
      platform === "win32" ||
      (platform !== "darwin" && platform !== "linux")
    )
      return yield* failure;
    const system =
      platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";
    const files = [path.join(system, "managed-settings.json")];
    const dropins = path.join(system, "managed-settings.d");
    if (yield* fs.exists(dropins)) {
      for (const name of yield* fs.readDirectory(dropins))
        if (!name.startsWith(".") && name.endsWith(".json")) files.push(path.join(dropins, name));
    }
    for (const file of files) {
      if (!(yield* fs.exists(file))) continue;
      const settings = yield* decodeManagedSettings(yield* fs.readFileString(file));
      // Reject even disabled hooks: the requested certificate is absence, not a precedence guess.
      // Managed plugins or a policy helper can install hooks/settings beyond this file snapshot.
      if (
        settings.hooks !== undefined ||
        settings.policyHelper !== undefined ||
        settings.enabledPlugins !== undefined ||
        settings.extraKnownMarketplaces !== undefined ||
        settings.forceLoginGatewayUrl !== undefined ||
        settings.env !== undefined ||
        settings.apiKeyHelper !== undefined
      )
        return yield* failure;
    }
    if (platform === "darwin") {
      const managed = "/Library/Managed Preferences";
      const policies = [
        path.join(managed, "com.anthropic.claudecode.plist"),
        "/Library/Preferences/com.anthropic.claudecode.plist",
        path.join(home, "Library", "Preferences", "com.anthropic.claudecode.plist"),
      ];
      if (yield* fs.exists(managed))
        for (const name of yield* fs.readDirectory(managed))
          policies.push(path.join(managed, name, "com.anthropic.claudecode.plist"));
      for (const file of policies) if (yield* fs.exists(file)) return yield* failure;
    }
  }).pipe(Effect.mapError(() => failure));
});
