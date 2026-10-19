import { useAtomValue } from "@effect/atom-react";
import { connectionRoutes, formatConnectionDiagnostic } from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import type { EnvironmentPresentation } from "~/state/environments";
import { sshRuntime } from "~/state/sshRuntime";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "./useCopyToClipboard";

const noRuntimeStatus = Atom.make(null);

export function useCopyConnectionDiagnostic(environment: EnvironmentPresentation | null) {
  const sshProfile = environment
    ? connectionRoutes(environment.entry).flatMap(({ profile }) =>
        Option.isSome(profile) && profile.value._tag === "SshConnectionProfile"
          ? [profile.value]
          : [],
      )[0]
    : undefined;
  const runtime = useAtomValue(
    environment && sshProfile && window.desktopBridge !== undefined
      ? sshRuntime.statusAtom({
          environmentId: environment.environmentId,
          target: sshProfile.target,
        })
      : noRuntimeStatus,
  );
  const { copyToClipboard } = useCopyToClipboard({
    target: "connection diagnostic",
    onCopy: () => toastManager.add({ type: "success", title: "Diagnostic copied" }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy diagnostic",
          description: error.message,
        }),
      ),
  });
  return () => {
    if (!environment) return;
    copyToClipboard(
      formatConnectionDiagnostic({
        label: environment.label,
        hostAlias: sshProfile?.target.alias,
        connection: environment.connection,
        diagnosticTail:
          runtime?.status?.detail ??
          environment.connection.failure?.detail ??
          environment.connection.error ??
          undefined,
        appVersion: APP_VERSION,
      }),
      undefined,
    );
  };
}
