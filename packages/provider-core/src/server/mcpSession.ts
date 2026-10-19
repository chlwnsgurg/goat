import type {
  AuthEnvironmentScope,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";

export interface McpProviderSessionConfig {
  readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

/** Native tool claims are derived from the issued credential, never runtime mode. */
export interface MemoryToolAvailability {
  readonly read: boolean;
  readonly write: boolean;
  readonly source: boolean;
}

export function memoryToolAvailability(
  config: Pick<McpProviderSessionConfig, "grantedScopes"> | undefined,
): MemoryToolAvailability {
  const scopes = config?.grantedScopes ?? [];
  const read = scopes.includes("memory:read");
  return {
    read,
    write: read && scopes.includes("memory:write"),
    source: read && scopes.includes("orchestration:read"),
  };
}
