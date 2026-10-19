/**
 * Model fallback for fleet work (docs/internals/agentic-k8s.md, "Fallback chains"). The
 * resources work provides the real layer; fleet/defaults.ts always answers Exhausted, so usage
 * limits wait for the reset as they do today.
 */
import type {
  ModelSelection,
  OrchestrationV2ProviderFailureClass,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type FallbackFailure = OrchestrationV2ProviderFailureClass | "unavailable";

export type FallbackStep =
  | { readonly _tag: "SwitchInThread"; readonly selection: ModelSelection; readonly hop: number }
  | { readonly _tag: "Relaunch"; readonly selection: ModelSelection; readonly hop: number }
  | { readonly _tag: "Exhausted"; readonly reason: string };

export class Fallback extends Context.Service<
  Fallback,
  {
    readonly next: (input: {
      readonly chain: string | null;
      readonly selection: ModelSelection;
      readonly failure: FallbackFailure;
      readonly tried: ReadonlyArray<ModelSelection>;
      readonly host: string | null;
      readonly threadId: ThreadId | null;
    }) => Effect.Effect<FallbackStep>;
    /** Starts the step's cooldown. */
    readonly reportFailure: (
      selection: ModelSelection,
      failure: FallbackFailure,
    ) => Effect.Effect<void>;
  }
  // @effect-diagnostics-next-line deterministicKeys:off -- the key is the T1/T2/T3 agreement in docs/internals/agentic-k8s.md.
>()("goat/fleet/Fallback") {}
