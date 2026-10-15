import { AuthFilesystemWriteScope, type EnvironmentId } from "@goat/contracts";
import { createRef, useEffect, useMemo, useState } from "react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";

import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getUnsavedProjectFileQueryData,
  getProjectFileData,
  reloadProjectFileData,
} from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: FileSaveOptions) {
  const [status, setStatus] = useState<
    "saved" | "unsaved" | "saving" | "failed" | "changed" | "deleted" | "reloading" | "reloadFailed"
  >("saved");
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    const persistence = { blocked: false, overwrite: false, confirmed: true };
    return {
      retry: () => coordinatorRef.current?.retry(),
      overwrite: () => {
        if (!persistence.blocked) return;
        persistence.blocked = false;
        persistence.overwrite = true;
        coordinatorRef.current?.retry();
      },
      reload: async () => {
        if (!persistence.blocked) return;
        setStatus("reloading");
        const result = await reloadProjectFileData(environmentId, cwd, relativePath);
        if (result._tag === "Success") {
          coordinatorRef.current?.discard();
          persistence.blocked = false;
          setStatus("saved");
        } else {
          setStatus("reloadFailed");
        }
      },
      change: (contents: string) => coordinatorRef.current?.change(contents),
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          canPersist: () =>
            !persistence.blocked && readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
          onPendingChange: (pending) => {
            onPendingChange(relativePath, pending);
            if (!persistence.blocked) setStatus(pending ? "unsaved" : "saved");
          },
          persist: async (nextContents) => {
            const baseline = getProjectFileData(environmentId, cwd, relativePath);
            const expectedVersion = persistence.overwrite ? undefined : baseline?.version;
            persistence.overwrite = false;
            setStatus("saving");
            const result = await writeFile({
              environmentId,
              input: {
                cwd,
                relativePath,
                contents: nextContents,
                ...(expectedVersion !== undefined ? { expectedVersion } : {}),
                ...(baseline?.textFormat ? { textFormat: baseline.textFormat } : {}),
              },
            });
            if (result._tag === "Success") {
              // Advance the baseline before a serialized follow-up, including
              // when newer edits prevent this write from clearing the draft.
              persistence.confirmed =
                confirmProjectFileQueryData(
                  environmentId,
                  cwd,
                  relativePath,
                  nextContents,
                  result.value,
                ) !== false;
              if (!persistence.confirmed) setStatus("unsaved");
            } else {
              const failure = squashAtomCommandFailure(result);
              const kind =
                failure && typeof failure === "object" && "failure" in failure
                  ? failure.failure
                  : undefined;
              persistence.blocked = kind === "changed_on_disk" || kind === "deleted_on_disk";
              setStatus(
                kind === "changed_on_disk"
                  ? "changed"
                  : kind === "deleted_on_disk"
                    ? "deleted"
                    : "failed",
              );
            }
            return result;
          },
          onConfirmed: () => persistence.confirmed,
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [cwd, environmentId, onPendingChange, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  useEffect(() => {
    if (!canWriteFiles) return;
    let cancelled = false;
    // Replay must retire the first session before recovery queues a draft to flush.
    queueMicrotask(() => {
      if (cancelled) return;
      const unsaved = getUnsavedProjectFileQueryData(environmentId, cwd, relativePath);
      if (unsaved) session.change(unsaved.contents);
    });
    return () => {
      cancelled = true;
    };
  }, [canWriteFiles, cwd, environmentId, relativePath, session]);
  return { ...session, status, canWriteFiles };
}
