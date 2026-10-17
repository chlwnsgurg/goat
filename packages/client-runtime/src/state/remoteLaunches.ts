import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadShell,
  RemoteLaunch,
  ScopedThreadRef,
  ThreadId,
} from "@goat/contracts";

import { scopeThreadRef } from "../environment/scoped.ts";

export interface RemoteLaunchShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly source: Pick<OrchestrationV2ThreadShell, "launchedBy">;
  readonly providerInstanceId?: string | undefined;
  readonly modelSelection?: Pick<ModelSelection, "model"> | undefined;
}

export interface PresentedRemoteLaunch {
  readonly launch: RemoteLaunch;
  /** The thread in an environment this client is connected to, when it is loaded. */
  readonly ref: ScopedThreadRef | null;
  readonly title: string | null;
  /** "<provider> · <model>" from the loaded remote thread; null while unresolved. */
  readonly providerLabel: string | null;
}

export interface RemoteLaunchHostGroup {
  /** SSH alias on the dispatching environment. */
  readonly host: string;
  /** The host's environment, learned from a thread this client has loaded there. */
  readonly environmentId: EnvironmentId | null;
  readonly launches: ReadonlyArray<PresentedRemoteLaunch>;
}

/**
 * Finds a remote thread among the shells this client holds. Thread ids are
 * random, but a copied database can repeat one. A shell that records a
 * different launcher is never this launch's thread, except for a watch, which
 * follows a thread someone else started. Among the rest, a shell launched by
 * this launcher wins, and an id that stays ambiguous resolves to nothing.
 */
function findRemoteShell(
  sameId: ReadonlyArray<RemoteLaunchShell>,
  dispatcherEnvironmentId: EnvironmentId,
  launch: RemoteLaunch & { readonly threadId: ThreadId },
): RemoteLaunchShell | null {
  const launchedHere = (shell: RemoteLaunchShell) => {
    const launchedBy = shell.source.launchedBy;
    return (
      launchedBy?.environmentId === dispatcherEnvironmentId &&
      launchedBy.threadId === launch.launcherThreadId
    );
  };
  const candidates = sameId.filter(
    (shell) =>
      shell.environmentId !== dispatcherEnvironmentId &&
      (launch.source === "watch" || shell.source.launchedBy == null || launchedHere(shell)),
  );
  if (candidates.length <= 1) return candidates[0] ?? null;
  const matching = candidates.filter(launchedHere);
  return matching.length === 1 ? matching[0]! : null;
}

function providerLabel(
  shell: RemoteLaunchShell,
  providerName: ((environmentId: EnvironmentId, instanceId: string) => string | null) | undefined,
): string | null {
  if (shell.providerInstanceId === undefined) return null;
  const name =
    providerName?.(shell.environmentId, shell.providerInstanceId) ?? shell.providerInstanceId;
  const model = shell.modelSelection?.model;
  return model ? `${name} · ${model}` : name;
}

/**
 * Groups a dispatching environment's remote launches by host, in the order
 * the server listed them (newest first), and resolves each one this client can
 * open. A host whose threads none resolve is one the client is not connected to.
 */
export function presentRemoteLaunches(input: {
  readonly dispatcherEnvironmentId: EnvironmentId;
  readonly launches: ReadonlyArray<RemoteLaunch>;
  readonly shells: ReadonlyArray<RemoteLaunchShell>;
  /** A provider instance's display name in the environment that runs it. */
  readonly providerName?: (environmentId: EnvironmentId, instanceId: string) => string | null;
}): ReadonlyArray<RemoteLaunchHostGroup> {
  const groups = new Map<
    string,
    { environmentId: EnvironmentId | null; launches: Array<PresentedRemoteLaunch> }
  >();
  // Shells change with every streamed event; index them once instead of per launch.
  const shellsById = new Map<ThreadId, Array<RemoteLaunchShell>>();
  if (input.launches.some((launch) => launch.threadId !== null)) {
    for (const shell of input.shells) {
      const sameId = shellsById.get(shell.id);
      if (sameId === undefined) shellsById.set(shell.id, [shell]);
      else sameId.push(shell);
    }
  }
  for (const launch of input.launches) {
    const shell =
      launch.threadId === null
        ? null
        : findRemoteShell(shellsById.get(launch.threadId) ?? [], input.dispatcherEnvironmentId, {
            ...launch,
            threadId: launch.threadId,
          });
    const group = groups.get(launch.host) ?? { environmentId: null, launches: [] };
    groups.set(launch.host, group);
    group.environmentId ??= shell?.environmentId ?? null;
    group.launches.push({
      launch,
      ref: shell === null ? null : scopeThreadRef(shell.environmentId, shell.id),
      title: shell?.title ?? launch.title,
      providerLabel: shell === null ? null : providerLabel(shell, input.providerName),
    });
  }
  return [...groups].map(([host, group]) => ({ host, ...group }));
}
