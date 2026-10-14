import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as MemoryAccess from "../../../memory/MemoryAccess.ts";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const isMemoryError = Schema.is(M.MemoryRpcError);
const isCapacityDimension = Schema.is(M.MemoryCapacityDimension);
const isFailureCode = Schema.is(M.MemoryFailureCode);

/** Only safe typed fields cross MCP; optional fields are absent, never undefined. */
export const memoryError = (error: unknown): M.MemoryRpcError => {
  if (isMemoryError(error)) return error;
  if (typeof error !== "object" || error === null)
    return new M.MemoryRpcError({ code: "storage_failed" });
  if (
    "_tag" in error &&
    error._tag === "MemoryCapacityError" &&
    "dimension" in error &&
    isCapacityDimension(error.dimension) &&
    "current" in error &&
    typeof error.current === "number" &&
    "limit" in error &&
    typeof error.limit === "number"
  )
    return new M.MemoryRpcError({
      code: "capacity_exceeded",
      capacity: {
        code: "capacity_exceeded",
        dimension: error.dimension,
        current: error.current,
        limit: error.limit,
        reclaimable: 0,
      },
    });
  if ("code" in error && isFailureCode(error.code) && error.code !== "capacity_exceeded")
    return new M.MemoryRpcError({ code: error.code });
  return new M.MemoryRpcError({ code: "storage_failed" });
};

export const invocationPermit = (requirement: MemoryAccess.MemoryAccessRequirement | "settings") =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const deny = () => new MemoryService.MemoryAccessError({ code: "unavailable" });
    if (requirement === "settings")
      return Effect.suspend(() => {
        if (
          scope.readOnly ||
          scope.client?.access === "read-only" ||
          !scope.grantedScopes?.includes("settings:write") ||
          !scope.reauthorize
        )
          return Effect.fail(deny());
        return scope.reauthorize(["settings:write"]).pipe(Effect.mapError(deny));
      });
    return MemoryAccess.memoryAccessPermit(
      {
        ...(scope.grantedScopes === undefined ? {} : { grantedScopes: scope.grantedScopes }),
        ...(scope.reauthorize === undefined
          ? {}
          : {
              reauthorize: (required) => scope.reauthorize!(required).pipe(Effect.mapError(deny)),
            }),
        readOnly: scope.readOnly === true || scope.client?.access === "read-only",
        liveCaller: scope.capabilities.has("memory") ? Effect.void : Effect.fail(deny()),
      },
      requirement,
    );
  });

const receipt = Schema.decodeUnknownEffect(M.MemoryMutationReceipt);
const handlers = {
  memory_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.search(input, yield* invocationPermit("read"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.list(input, yield* invocationPermit("read"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.read(input, yield* invocationPermit("read"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_history: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.history(input, yield* invocationPermit("read"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_sync_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemorySyncService.MemorySyncService;
      return yield* service.syncStatus(input, yield* invocationPermit("read"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_upsert: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service
        .upsert(input, yield* invocationPermit("write"))
        .pipe(Effect.flatMap((stored) => receipt(stored.receipt)));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_forget: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service
        .forget(input, yield* invocationPermit("write"))
        .pipe(Effect.flatMap((stored) => receipt(stored.receipt)));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_revert_resolution: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.revertResolution(input, yield* invocationPermit("write"));
    }).pipe(Effect.mapError(memoryError)),
  ),
} satisfies McpToolAccess.Handlers<typeof MemoryToolkit.tools>;
export const layer = McpToolAccess.toLayer(MemoryToolkit, handlers);
