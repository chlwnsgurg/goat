import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as MemorySettingsService from "../../../memory/MemorySettingsService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { invocationPermit, memoryError } from "../memory/handlers.ts";
import { MemoryAdministrationToolkit } from "./tools.ts";
const decode = Schema.decodeUnknownEffect(M.MemoryHubDisableInput);
const disabled = Schema.decodeUnknownEffect(M.MemoryHubDisableResult);
const decodeSettingsUpdate = Schema.decodeUnknownEffect(M.MemorySettingsUpdateInput);
export const layer = McpToolAccess.toLayer(MemoryAdministrationToolkit, {
  memory_settings_get: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const service = yield* MemorySettingsService.MemorySettingsService;
      return yield* service.get(yield* invocationPermit("read"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_settings_update: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const value = yield* decodeSettingsUpdate(input);
      const service = yield* MemorySettingsService.MemorySettingsService;
      return yield* service.update(value, yield* invocationPermit("settings"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_hub_disable: McpToolAccess.destructive(
    McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const value = yield* decode(input);
        const service = yield* MemorySyncService.MemorySyncService;
        return yield* service
          .updateHubSettings(
            { ...value, action: "configure", settings: { mode: "disabled" } },
            yield* invocationPermit("settings"),
          )
          .pipe(
            Effect.flatMap((result) =>
              disabled({ settings: result.view.settings, version: result.view.version }),
            ),
          );
      }).pipe(Effect.mapError(memoryError)),
    ),
  ),
});
