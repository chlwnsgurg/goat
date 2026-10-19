import * as Schema from "effect/Schema";

import {
  AuthHubProxyScope,
  AuthOrchestrationReadScope,
  AuthEnvironmentScopes,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2ShellSnapshot } from "./orchestrationV2.ts";

/**
 * A client paired only to a hub reaches a node's own HTTP and WebSocket API below
 * `/hub/nodes/<nodeId>/`. The hub authenticates the client, holds the node session itself and
 * forwards only what the policy below admits, so node credentials never reach the client.
 */
export const HUB_PROXY_ROUTE_PREFIX = "/hub/nodes";

export const hubProxyNodePath = (nodeId: string): string =>
  `${HUB_PROXY_ROUTE_PREFIX}/${encodeURIComponent(nodeId)}`;

export const HubProxyNodeId = TrimmedNonEmptyString.check(Schema.isMaxLength(320));
export type HubProxyNodeId = typeof HubProxyNodeId.Type;

/**
 * The most a hub ever asks of a node for a proxied client. A client's rights on a node are its
 * own hub scopes intersected with this, so widening it is the one switch for new proxied actions.
 */
export const HUB_PROXY_NODE_SCOPE_CEILING: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
];

/** The client's rights on a node: none without `hub:proxy`, otherwise its scopes within the ceiling. */
export const hubProxyEffectiveScopes = (
  clientScopes: ReadonlyArray<AuthEnvironmentScope>,
  limit: ReadonlyArray<AuthEnvironmentScope> = HUB_PROXY_NODE_SCOPE_CEILING,
): ReadonlyArray<AuthEnvironmentScope> =>
  clientScopes.includes(AuthHubProxyScope)
    ? limit.filter((scope, index) => clientScopes.includes(scope) && limit.indexOf(scope) === index)
    : [];

/**
 * Read-only calls pass on their scope alone. Anything that needs more must be listed here with a
 * payload check, because one scope (`orchestration:operate`) covers far more than the hub offers.
 */
const HUB_PROXY_METHOD_POLICY: Readonly<Record<string, (payload: unknown) => boolean>> = {};

/** Whether the hub forwards a call that already passed the scope check for these required scopes. */
export const hubProxyAdmitsMethod = (
  method: string,
  payload: unknown,
  requiredScopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean => {
  if (requiredScopes.every((scope) => scope === AuthOrchestrationReadScope)) return true;
  const admits = Object.hasOwn(HUB_PROXY_METHOD_POLICY, method)
    ? HUB_PROXY_METHOD_POLICY[method]
    : undefined;
  return admits !== undefined && admits(payload);
};

/** The hub's last copy of a node's shell, served while the node is unreachable. */
export const HubProxySnapshot = Schema.Struct({
  nodeId: HubProxyNodeId,
  capturedAt: IsoDateTime,
  shell: OrchestrationV2ShellSnapshot,
});
export type HubProxySnapshot = typeof HubProxySnapshot.Type;

/** Body of a 503 from a proxied path when the hub cannot reach the node. */
export const HubProxyUnavailable = Schema.Struct({
  code: Schema.Literal("hub_node_unavailable"),
  message: Schema.String,
});
export type HubProxyUnavailable = typeof HubProxyUnavailable.Type;

export const HubProxyNodeInput = Schema.Struct({ nodeId: HubProxyNodeId });
export type HubProxyNodeInput = typeof HubProxyNodeInput.Type;

/** Lets the hub open client sessions on a linked node, by spending a pairing link that node issued. */
export const HubProxyEnrollInput = Schema.Struct({
  nodeId: HubProxyNodeId,
  pairingUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
export type HubProxyEnrollInput = typeof HubProxyEnrollInput.Type;
export const HubProxyEnrollResult = Schema.Struct({ scopes: AuthEnvironmentScopes });
export type HubProxyEnrollResult = typeof HubProxyEnrollResult.Type;
export const HubProxyUnenrollResult = Schema.Struct({ removed: Schema.Boolean });
export type HubProxyUnenrollResult = typeof HubProxyUnenrollResult.Type;

/** Safe to show: never carries a token or a raw node response. */
export class HubProxyRpcError extends Schema.TaggedError<HubProxyRpcError>()("HubProxyRpcError", {
  reason: Schema.Literals(["not_found", "unavailable", "enrollment_required", "refused"]),
  detail: Schema.String.check(Schema.isMaxLength(2000)),
}) {
  override get message(): string {
    return this.detail;
  }
}
