import type { EnvironmentMachineKind, ExecutionEnvironmentPlatformOs } from "@goat/contracts";

const MAC_MODELS: Partial<Record<EnvironmentMachineKind, string>> = {
  laptop: "MacBook",
  "mac-mini": "Mac mini",
  "mac-studio": "Mac Studio",
  desktop: "iMac",
};

const KIND_NOUNS: Record<EnvironmentMachineKind, string | null> = {
  laptop: "laptop",
  desktop: "desktop",
  server: "server",
  cloud: "cloud VM",
  linux: null,
  "mac-mini": "mini PC",
  "mac-studio": "workstation",
};

const OS_NAMES: Partial<Record<ExecutionEnvironmentPlatformOs, string>> = {
  darwin: "Mac",
  linux: "Linux",
  windows: "Windows",
};

/**
 * Names a host by its OS and hardware shape, such as "MacBook", "Mac Studio", "Linux
 * server" or "Windows laptop". Null when the server has reported neither.
 */
export function describeMachine(
  os: ExecutionEnvironmentPlatformOs | null,
  kind: EnvironmentMachineKind | null,
): string | null {
  if (os === "darwin") return (kind && MAC_MODELS[kind]) ?? "Mac";
  const osName = os === null ? null : (OS_NAMES[os] ?? null);
  const noun = kind === null ? null : KIND_NOUNS[kind];
  if (osName !== null && noun !== null) return osName + " " + noun;
  if (osName !== null) return osName;
  if (kind === "linux") return "Linux";
  return noun === null ? null : noun.charAt(0).toUpperCase() + noun.slice(1);
}
