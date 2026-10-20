import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import { useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

/** Installs a provider CLI that the environment can download itself (setup.canInstall). */
export function ProviderInstallRow({
  environmentId,
  instanceId,
  label,
  disabled = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly disabled?: boolean;
}) {
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, commandOptions);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, commandOptions);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const installation = query.data;
  const active =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);
  const installedVersion = installation?.installedVersion ?? null;
  const updateAvailable =
    installedVersion && installation?.version && installation.version !== installedVersion
      ? ` ${installation.version} is available.`
      : "";
  const status =
    installation?.phase === "downloading"
      ? `Downloading ${megabytes(installation.downloadedBytes)} MB${installation.totalBytes === null ? "" : ` of ${megabytes(installation.totalBytes)} MB`}.`
      : installation?.phase === "extracting"
        ? (installation.message ?? `Extracting ${label}.`)
        : installation?.phase === "verifying"
          ? (installation.message ?? "Checking the download.")
          : installation?.phase === "succeeded"
            ? "Installed. Checking the provider…"
            : installation?.phase === "failed"
              ? (installation.message ?? "Installation failed.")
              : installedVersion
                ? `Installed · v${installedVersion}.${updateAvailable}`
                : installation?.totalBytes
                  ? `Not installed. ${Math.ceil(installation.totalBytes / 1_000_000)} MB download.`
                  : `${label} isn't installed on this environment.`;

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await command();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Installation failed. Try again.");
      }
    } catch {
      setError("Installation failed. Try again.");
    }
    pendingRef.current = false;
    setPending(false);
  }

  return (
    <SettingsRow
      title="Install"
      description={<span role="status">{status}</span>}
      status={
        error || query.error ? (
          <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
            {error ?? query.error}
          </p>
        ) : undefined
      }
      control={
        active && installation.operationId ? (
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={pending}
            onClick={() => {
              const operationId = installation.operationId;
              if (operationId)
                void run(() =>
                  cancelInstall({ environmentId, input: { instanceId, operationId } }),
                );
            }}
          >
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || pending || active || !installation || query.error !== null}
            onClick={() => void run(() => startInstall(target))}
          >
            {installedVersion
              ? installation?.version && installation.version !== installedVersion
                ? `Update ${label}`
                : `Reinstall ${label}`
              : installation?.phase === "failed" || installation?.phase === "cancelled"
                ? "Retry install"
                : `Install ${label}`}
          </Button>
        )
      }
    >
      {installation?.phase === "downloading" &&
      installation.totalBytes !== null &&
      installation.totalBytes > 0 ? (
        <progress
          aria-label={`${label} download`}
          className="block h-1 w-full accent-foreground"
          value={installation.downloadedBytes}
          max={installation.totalBytes}
        />
      ) : null}
    </SettingsRow>
  );
}
