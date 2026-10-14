import {
  type EnvironmentId,
  type MemoryChangeSignal,
  type MemoryId,
  type MemorySpaceId,
  WS_METHODS,
  supportsMemoryProtocol,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  subscribe,
  requestMemoryQuery,
  type MemoryBodyRpcTag,
  type EnvironmentRpcInput,
  type EnvironmentUnaryRpcTag,
  type EnvironmentRpcSuccess,
} from "../rpc/client.ts";
import { createEnvironmentCatalogAtoms } from "./connections.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import {
  createEnvironmentRpcCommand,
  environmentRpcKey,
  followStreamInEnvironment,
} from "./runtime.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

export interface MemoryExposure {
  readonly ready: boolean;
  readonly epoch: object;
  readonly versions: ReadonlyMap<MemoryId, object>;
  readonly forgotten: ReadonlySet<MemoryId>;
}

/** Body-free state. Epoch identity also fences replies from a prior subscription. */
export function emptyMemoryExposure(): MemoryExposure {
  return { ready: false, epoch: {}, versions: new Map(), forgotten: new Set() };
}

export function applyMemoryChange(
  state: MemoryExposure,
  signal: MemoryChangeSignal,
): MemoryExposure {
  if (signal.kind === "reset") {
    return { ...state, ready: true, epoch: {}, versions: new Map() };
  }
  const versions = new Map(state.versions);
  versions.set(signal.memoryId, {});
  const forgotten = new Set(state.forgotten);
  if (signal.kind === "forget") forgotten.add(signal.memoryId);
  return { ...state, versions, forgotten };
}

/** A later upsert/watermark cannot undo a tombstone observed by this consumer. */
export function memoryExposureMatches(
  before: MemoryExposure,
  after: MemoryExposure,
  memoryIds: ReadonlyArray<MemoryId>,
): boolean {
  return (
    before.ready &&
    after.ready &&
    before.epoch === after.epoch &&
    memoryIds.every(
      (id) => !after.forgotten.has(id) && before.versions.get(id) === after.versions.get(id),
    )
  );
}

function containsForgottenMemory(value: unknown, forgotten: ReadonlySet<MemoryId>): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (
    "memoryId" in value &&
    typeof value.memoryId === "string" &&
    forgotten.has(value.memoryId as MemoryId)
  )
    return true;
  return Object.values(value).some((nested) => containsForgottenMemory(nested, forgotten));
}

interface MemoryTarget {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly memorySpaceId: MemorySpaceId };
}

// Bodies are ephemeral, including source text and snippets. Expiry removes the
// displayed value; a consumer must explicitly refresh to request it again.
const BODY_TTL = "1 minute";

export function createMemoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  const { catalogValueAtom } = createEnvironmentCatalogAtoms(runtime);
  const readPermissions = createCommandPermissions(runtime, WS_METHODS.memoryRead);
  const exposureFamily = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, MemoryTarget["input"]];
    const unavailable = emptyMemoryExposure();
    const streamAtom = runtime
      .atom((get) => {
        const allowed = get(readPermissions.permissionAtom(environmentId));
        const prepared = get(sessions.preparedConnectionValueAtom(environmentId));
        const config = get(sessions.initialConfigValueAtom(environmentId));
        if (
          !get(catalogValueAtom).entries.get(environmentId)?.enabled ||
          !allowed ||
          Option.isNone(prepared) ||
          !config ||
          !supportsMemoryProtocol(config.environment.capabilities)
        ) {
          return Stream.succeed(emptyMemoryExposure());
        }
        return followStreamInEnvironment(
          environmentId,
          Stream.unwrap(
            EnvironmentSupervisor.pipe(
              Effect.map((supervisor) =>
                SubscriptionRef.changes(supervisor.session).pipe(
                  Stream.switchMap((session) => {
                    const closed = emptyMemoryExposure();
                    if (Option.isNone(session)) return Stream.succeed(closed);
                    return subscribe(WS_METHODS.memoryChanges, input).pipe(
                      Stream.scan(() => closed, applyMemoryChange),
                      Stream.catchCause(() => Stream.succeed(emptyMemoryExposure())),
                      (stream) => Stream.concat(Stream.succeed(closed), stream),
                    );
                  }),
                ),
              ),
            ),
          ),
        );
      })
      .pipe(Atom.setIdleTTL(0));
    return Atom.make((get) => {
      // Do not expose AsyncResult's previous value during a reconnect/error.
      const result = get(streamAtom);
      return result._tag === "Success" && !result.waiting ? result.value : unavailable;
    }).pipe(Atom.setIdleTTL(0));
  });
  const exposureAtom = (target: MemoryTarget) => exposureFamily(environmentRpcKey(target));

  function command<T extends EnvironmentUnaryRpcTag>(tag: T) {
    const result = createEnvironmentRpcCommand(runtime, { label: `memory:${tag}`, tag });
    const availability = Atom.family((key: string) => {
      const [environmentId, input] = JSON.parse(key) as [
        EnvironmentId | null,
        EnvironmentRpcInput<T>,
      ];
      return Atom.make((get) => {
        if (
          environmentId === null ||
          !get(catalogValueAtom).entries.get(environmentId)?.enabled ||
          !get(result.permissionAtom(environmentId, input))
        )
          return false;
        const config = get(sessions.initialConfigValueAtom(environmentId));
        return (
          Option.isSome(get(sessions.preparedConnectionValueAtom(environmentId))) &&
          config !== null &&
          supportsMemoryProtocol(config.environment.capabilities) &&
          (tag !== WS_METHODS.memoryImportProvider ||
            config.environment.capabilities.memory?.importProvider === true)
        );
      });
    });
    return {
      ...result,
      permissionAtom: (environmentId: EnvironmentId | null, input?: EnvironmentRpcInput<T>) =>
        availability(JSON.stringify([environmentId, input])),
    };
  }

  function bodyQuery<T extends MemoryBodyRpcTag>(tag: T) {
    const read = command(tag);
    const family = Atom.family((key: string) => {
      const [environmentId, input] = JSON.parse(key) as [
        EnvironmentId,
        EnvironmentRpcInput<T> & {
          readonly memorySpaceId: MemorySpaceId;
          readonly memoryId?: MemoryId;
        },
      ];
      const state = exposureAtom({ environmentId, input: { memorySpaceId: input.memorySpaceId } });
      const raw = runtime
        .atom((get) => {
          const before = get(state);
          const permitted = get(read.permissionAtom(environmentId, input));
          const ids = input.memoryId === undefined ? [] : [input.memoryId];
          if (!permitted || !memoryExposureMatches(before, before, ids)) {
            return Stream.succeed({ before, value: Option.none<EnvironmentRpcSuccess<T>>() });
          }
          return Stream.fromEffect(
            requestMemoryQuery(runtime, get.registry, environmentId, tag, input),
          ).pipe(
            Stream.map((value) => ({ before, value: Option.some(value) })),
            (stream) =>
              Stream.concat(
                Stream.succeed({ before, value: Option.none<EnvironmentRpcSuccess<T>>() }),
                stream,
              ),
            Stream.concat(
              Stream.fromEffect(Effect.sleep(BODY_TTL)).pipe(
                Stream.map(() => ({ before, value: Option.none() })),
              ),
            ),
          );
        })
        .pipe(Atom.setIdleTTL(0));
      return Atom.make((get) => {
        const current = get(state);
        const allowed = get(read.permissionAtom(environmentId, input));
        const result = get(raw);
        if (allowed && current.ready && result._tag === "Failure")
          return AsyncResult.map(result, () => Option.none<EnvironmentRpcSuccess<T>>());
        if (
          !allowed ||
          result._tag !== "Success" ||
          result.waiting ||
          // Page/search output is invalidated by any body-free signal.
          result.value.before !== current
        )
          return AsyncResult.success(Option.none<EnvironmentRpcSuccess<T>>());
        if (
          Option.isSome(result.value.value) &&
          containsForgottenMemory(result.value.value.value, current.forgotten)
        )
          return AsyncResult.success(Option.none<EnvironmentRpcSuccess<T>>());
        return AsyncResult.success(result.value.value);
      }).pipe(Atom.setIdleTTL(0));
    });
    return (target: {
      readonly environmentId: EnvironmentId;
      readonly input: EnvironmentRpcInput<T>;
    }) => family(environmentRpcKey(target));
  }

  const drafts = Atom.family((key: string) => {
    const [environmentId, input, draftId] = JSON.parse(key) as [
      EnvironmentId,
      MemoryTarget["input"],
      string,
    ];
    const state = exposureAtom({ environmentId, input });
    const stored = Atom.make<{
      readonly text: string;
      readonly memoryIds: ReadonlyArray<MemoryId>;
      readonly exposure: MemoryExposure;
    } | null>(null).pipe(Atom.setIdleTTL(0));
    return Atom.writable(
      (get) => {
        const draft = get(stored);
        if (draft === null || draft.memoryIds.length === 0) return draft?.text ?? null;
        if (!memoryExposureMatches(draft.exposure, get(state), draft.memoryIds)) {
          // Purge the retained text, rather than only hiding it from the view.
          get.set(stored, null);
          return null;
        }
        return draft.text;
      },
      (
        ctx,
        draft: { readonly text: string; readonly memoryIds: ReadonlyArray<MemoryId> } | null,
      ) => {
        ctx.set(stored, draft === null ? null : { ...draft, exposure: ctx.get(state) });
      },
    ).pipe(Atom.withLabel(`memory-draft:${draftId}`), Atom.setIdleTTL(0));
  });

  return {
    exposureAtom,
    list: bodyQuery(WS_METHODS.memoryList),
    search: bodyQuery(WS_METHODS.memorySearch),
    read: bodyQuery(WS_METHODS.memoryRead),
    history: bodyQuery(WS_METHODS.memoryHistory),
    readSource: bodyQuery(WS_METHODS.memoryReadSource),
    upsert: command(WS_METHODS.memoryUpsert),
    forget: command(WS_METHODS.memoryForget),
    revertResolution: command(WS_METHODS.memoryRevertResolution),
    projectBindingGet: command(WS_METHODS.memoryProjectBindingGet),
    projectBindingUpdate: command(WS_METHODS.memoryProjectBindingUpdate),
    hubSettingsGet: command(WS_METHODS.memoryHubSettingsGet),
    hubSettingsUpdate: command(WS_METHODS.memoryHubSettingsUpdate),
    ownerSourceReadPolicyGet: command(WS_METHODS.memoryOwnerSourceReadPolicyGet),
    ownerSourceReadPolicyUpdate: command(WS_METHODS.memoryOwnerSourceReadPolicyUpdate),
    syncStatus: command(WS_METHODS.memorySyncStatus),
    importProvider: command(WS_METHODS.memoryImportProvider),
    draftAtom: (target: MemoryTarget & { readonly draftId: string }) =>
      drafts(JSON.stringify([target.environmentId, target.input, target.draftId])),
  };
}
