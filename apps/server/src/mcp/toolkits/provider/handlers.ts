import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ProviderDiagnosisService from "../../../provider/ProviderDiagnosisService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ProviderToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ProviderToolkit, {
  goat_provider_diagnose: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const diagnosis = yield* ProviderDiagnosisService.ProviderDiagnosisService;
      return yield* diagnosis.diagnose(input).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not read this environment's provider settings.",
            }),
        ),
      );
    }),
  ),
});
