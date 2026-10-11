import {
  WS_METHODS,
  type ConnectionCatalogOperation,
  type ConnectionCatalogResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { subscribeDynamicWithSession } from "./client.ts";

/** Replies on the receiving socket; one operation completes before the next starts. */
export function serveConnectionCatalog<R>(
  handle: (
    operation: ConnectionCatalogOperation,
  ) => Effect.Effect<ConnectionCatalogResult, never, R>,
) {
  return subscribeDynamicWithSession(WS_METHODS.connectionCatalogServe, () => Effect.succeed({}), {
    onExpectedFailure: (cause) =>
      Effect.logDebug("Connection catalog host subscription stopped.", { cause }),
  }).pipe(
    Stream.runForEach(([session, request]) =>
      handle(request.operation).pipe(
        Effect.flatMap((result) =>
          session.client[WS_METHODS.connectionCatalogRespond]({
            requestId: request.requestId,
            result,
          }).pipe(
            Effect.catch((cause) =>
              Effect.logDebug("Connection catalog host response failed.", { cause }),
            ),
          ),
        ),
      ),
    ),
  );
}
