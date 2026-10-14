import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Service from "./MemoryService.ts";

export type MemoryPermit = Effect.Effect<void, Service.MemoryAccessError>;
export type MemoryAccessRequirement = "read" | "write" | "source";

/** All callbacks must read live, committed SQL-free authority; the Effect is repeatable. */
export function memoryAccessPermit(
  input: {
    readonly grantedScopes?: ReadonlyArray<M.AuthEnvironmentScope>;
    readonly reauthorize?: (scopes: ReadonlyArray<M.AuthEnvironmentScope>) => MemoryPermit;
    readonly readOnly: boolean;
    readonly liveCaller?: MemoryPermit;
  },
  requirement: MemoryAccessRequirement,
): MemoryPermit {
  const scopes: ReadonlyArray<M.AuthEnvironmentScope> =
    requirement === "source"
      ? ["memory:read", "orchestration:read"]
      : [requirement === "write" ? "memory:write" : "memory:read"];
  return Effect.suspend(() => {
    const reauthorize = input.reauthorize;
    if (
      !reauthorize ||
      !input.grantedScopes ||
      (requirement === "write" && input.readOnly) ||
      scopes.some((scope) => !input.grantedScopes?.includes(scope))
    )
      return Effect.fail(new Service.MemoryAccessError({ code: "unavailable" }));
    return Effect.gen(function* () {
      if (input.liveCaller) yield* input.liveCaller;
      yield* reauthorize(scopes);
    });
  });
}

/** A captured ceiling can only narrow destination policy and authenticated dispatch scopes. */
export function effectiveMemoryGrant(input: {
  readonly enableAgentMemoryAccess: boolean;
  readonly policyReady: boolean;
  readonly readOnly: boolean;
  // Null is an ordinary user start; undefined is legacy task metadata and denies.
  readonly memoryGrantCeiling: M.MemoryTaskGrantCeiling | null | undefined;
  readonly dispatchScopes?: ReadonlyArray<M.AuthEnvironmentScope>;
}): M.MemoryTaskGrantCeiling {
  if (!input.policyReady || !input.enableAgentMemoryAccess) return "none";
  const ceiling =
    input.memoryGrantCeiling === null ? "read_write" : (input.memoryGrantCeiling ?? "none");
  const canRead =
    ceiling !== "none" &&
    (input.dispatchScopes === undefined || input.dispatchScopes.includes("memory:read"));
  if (!canRead) return "none";
  const canWrite =
    ceiling === "read_write" &&
    !input.readOnly &&
    (input.dispatchScopes === undefined || input.dispatchScopes.includes("memory:write"));
  return canWrite ? "read_write" : "read";
}

/** Capture actual memory grants, never infer them from orchestration or runtime mode. */
export function captureMemoryGrantCeiling(
  scopes: ReadonlyArray<M.AuthEnvironmentScope>,
): M.MemoryTaskGrantCeiling {
  return !scopes.includes("memory:read")
    ? "none"
    : scopes.includes("memory:write")
      ? "read_write"
      : "read";
}
