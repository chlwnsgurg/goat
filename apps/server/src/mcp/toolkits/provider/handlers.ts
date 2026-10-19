import * as HomeRequests from "../../../provider/CodexHomeRequests.ts";
import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Routing from "../../../provider/ProviderDiagnosisRouting.ts";
import * as HostSync from "../../../provider/ProviderHostSync.ts";
import * as Onboarding from "../../../provider/ProviderOnboarding.ts";
import * as McpInvocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProviderToolkit } from "./tools.ts";

const toMcpFailure = (error: {
  readonly _tag: string;
  readonly message: string;
  readonly code?: string;
}) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "EnvironmentAuthorizationError"
        ? "capability_denied"
        : error._tag === "ProviderHostSyncError" &&
            (error.code === "not_found" || error.code === "invalid_request")
          ? "invalid_request"
          : "orchestration_error",
    message: error.message,
  });

const withHostSync = <A, E extends { readonly _tag: string; readonly message: string }>(
  run: (
    service: HostSync.ProviderHostSync["Service"],
    caller: { readonly kind: "mcp"; readonly scope: McpInvocation.McpInvocationScope },
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocation.McpInvocationContext;
    const service = yield* HostSync.ProviderHostSync;
    return yield* run(service, { kind: "mcp", scope }).pipe(Effect.mapError(toMcpFailure));
  });

const onboarding = <A>(
  run: (
    service: Onboarding.ProviderOnboarding["Service"],
    scope: McpInvocation.McpInvocationScope,
  ) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocation.McpInvocationContext;
    return yield* run(yield* Onboarding.ProviderOnboarding, scope);
  });

export const layer = McpToolAccess.toLayer(ProviderToolkit, {
  goat_provider_host_matrix: McpToolAccess.readsOrReachesHost(
    (input) => input.localOnly !== true,
    (input) => withHostSync((service, caller) => service.matrix(input, caller)),
  ),
  goat_provider_sync: McpToolAccess.writes((input) =>
    withHostSync((service, caller) => service.sync(input, caller)),
  ),
  goat_provider_sync_status: McpToolAccess.reads((input) =>
    withHostSync((service, caller) => service.status(input, caller)),
  ),
  goat_provider_sync_cancel: McpToolAccess.writes((input) =>
    withHostSync((service, caller) => service.cancel(input, caller)),
  ),
  goat_provider_addable_list: McpToolAccess.reads(() => onboarding((service) => service.list)),
  goat_provider_setup_open: McpToolAccess.writes((input) =>
    onboarding((service, scope) => service.setupOpen(input, scope)),
  ),
  goat_provider_login_start: McpToolAccess.writes((input) =>
    onboarding((service, scope) => service.loginStart(input, scope)),
  ),
  goat_provider_login_status: McpToolAccess.reads((input) =>
    onboarding((service, scope) => service.loginStatus(input, scope)),
  ),
  goat_provider_login_cancel: McpToolAccess.writes((input) =>
    onboarding((service, scope) => service.loginCancel(input, scope)),
  ),
  goat_provider_home_request: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocation.McpInvocationContext;
      const requests = yield* HomeRequests.CodexHomeRequests;
      return yield* requests.request(input, scope);
    }),
  ),
  goat_provider_diagnose: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocation.McpInvocationContext;
      const routing = yield* Routing.ProviderDiagnosisRouting;
      return yield* routing.diagnose(input, { kind: "mcp", scope }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error._tag === "EnvironmentAuthorizationError"
                  ? "capability_denied"
                  : error._tag === "OrchestratorMcpFailure"
                    ? error.code
                    : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
});
