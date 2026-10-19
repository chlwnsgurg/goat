import {
  type ConnectionCatalogOperation,
  type HubNode,
  type HubNodesError,
  type SavedConnection,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ConnectionCatalogBroker from "../../../connections/ConnectionCatalogBroker.ts";
import * as HubNodes from "../../../hubNodes/HubNodes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ConnectionToolkit } from "./tools.ts";

const legacyConnection = (node: HubNode): SavedConnection | undefined =>
  node.environmentId === null
    ? undefined
    : {
        environmentId: node.environmentId,
        label: node.label,
        enabled: true,
        routes: node.routes.map(({ target }) => {
          switch (target.kind) {
            case "ssh":
              return {
                kind: "ssh",
                host: target.alias,
                hostname: target.hostname ?? target.alias,
                username: target.username,
                port: target.port,
              };
            case "linked":
              return { kind: "direct", httpBaseUrl: target.baseUrl };
            case "cloud":
              return {
                kind: "ssh",
                host: target.alias,
                hostname: target.alias,
                username: null,
                port: null,
              };
          }
        }),
        ...(node.addedBy?.kind === "agent"
          ? { addedBy: { ...node.addedBy, kind: "agent" as const } }
          : {}),
      };

const hubFailure = (error: HubNodesError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "host_unavailable"
        ? "host_unavailable"
        : error.reason === "storage_failed"
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });

const forward = (operation: ConnectionCatalogOperation, timeoutMs: number) =>
  Effect.gen(function* () {
    const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
    if (!(yield* broker.hasHost)) return "not_attached" as const;
    return yield* broker.invoke(operation, timeoutMs).pipe(
      Effect.map((result) =>
        result.type === operation.type ? ("saved" as const) : ("failed" as const),
      ),
      Effect.catch(() => Effect.succeed("failed" as const)),
    );
  });

export const layer = McpToolAccess.toLayer(ConnectionToolkit, {
  goat_connection_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const hub = yield* HubNodes.HubNodes;
      const { nodes, notices } = yield* hub.snapshot.pipe(Effect.mapError(hubFailure));
      return {
        connections: nodes.flatMap((node) => {
          const connection = legacyConnection(node);
          return connection === undefined ? [] : [connection];
        }),
        nodes,
        notices,
      };
    }),
  ),
  goat_connection_add_ssh: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("orchestration")) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot reach other machines.",
        });
      }
      const hub = yield* HubNodes.HubNodes;
      const addedBy = {
        kind: "agent" as const,
        ...(scope.thread === undefined ? {} : { threadId: scope.thread.threadId }),
        ...(scope.client === undefined ? {} : { client: scope.client.label }),
        at: DateTime.formatIso(yield* DateTime.now),
      };
      const result = yield* hub
        .add(
          {
            kind: "ssh",
            alias: input.host,
            hostname: null,
            username: null,
            port: null,
            ...(input.label === undefined ? {} : { label: input.label }),
          },
          { addedBy, beforeSave: check.pipe(Effect.asVoid), requireIdentity: true },
        )
        .pipe(Effect.catchTags({ HubNodesError: (error) => Effect.fail(hubFailure(error)) }));
      const connection = legacyConnection(result.node);
      if (connection === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The hub did not identify the saved SSH node.",
        });
      }
      const desktopCatalog = yield* forward(
        {
          type: "add_ssh",
          host: input.host,
          ...(input.label === undefined ? {} : { label: input.label }),
          addedBy,
        },
        10 * 60_000,
      );
      return { ...result, connection, desktopCatalog };
    }),
  ),
  goat_connection_remove: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const hub = yield* HubNodes.HubNodes;
        const { removed: node } = yield* hub
          .remove({ nodeId: input.nodeId ?? input.environmentId! })
          .pipe(Effect.mapError(hubFailure));
        const removed = legacyConnection(node);
        const desktopCatalog =
          node.environmentId === null
            ? ("not_attached" as const)
            : yield* forward({ type: "remove", environmentId: node.environmentId }, 30_000);
        return { node, ...(removed === undefined ? {} : { removed }), desktopCatalog };
      }),
    ),
  ),
});
