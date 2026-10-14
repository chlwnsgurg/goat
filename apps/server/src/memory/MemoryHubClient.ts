import * as M from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Settings from "../serverSettings.ts";

export type HubConnection = Extract<M.MemoryHubSettings, { mode: "member" }> & {
  readonly epoch: number;
};
export type HubClientFailure =
  | M.MemoryHubError
  | M.MemoryHubUnauthorizedError
  | M.MemoryHubForbiddenError;
const REQUEST_TIMEOUT_MS = 15000;
const RESPONSE_MAX_BYTES = 1048576;
const retrySchedule = Schedule.exponential("250 millis").pipe(Schedule.upTo({ times: 2 }));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEndpoint = Schema.decodeUnknownEffect(M.MemoryHubEndpoint);
const decodeDescriptor = Schema.decodeUnknownEffect(M.ExecutionEnvironmentDescriptor);
const decodeDomainError = Schema.decodeUnknownEffect(M.MemoryHubError);

export class MemoryHubClient extends Context.Service<
  MemoryHubClient,
  {
    readonly preflight: (
      connection: HubConnection,
    ) => Effect.Effect<M.ExecutionEnvironmentDescriptor, HubClientFailure>;
    readonly join: (
      connection: HubConnection,
      input: M.MemoryHubJoinInput,
    ) => Effect.Effect<M.MemoryHubJoinResult, HubClientFailure>;
    readonly push: (
      connection: HubConnection,
      input: M.MemoryHubPushInput,
    ) => Effect.Effect<M.MemoryHubPushResult, HubClientFailure>;
    readonly pull: (
      connection: HubConnection,
      input: M.MemoryHubPullInput,
    ) => Effect.Effect<M.MemoryHubPullResult, HubClientFailure>;
    readonly claim: (
      connection: HubConnection,
      input: M.MemoryHubClaimInput,
    ) => Effect.Effect<M.MemoryResolutionLease, HubClientFailure>;
    readonly renew: (
      connection: HubConnection,
      input: M.MemoryHubRenewInput,
    ) => Effect.Effect<M.MemoryResolutionLease, HubClientFailure>;
    readonly applyResolution: (
      connection: HubConnection,
      input: M.MemoryHubApplyResolutionInput,
    ) => Effect.Effect<M.MemoryHubReceipt, HubClientFailure>;
    readonly release: (
      connection: HubConnection,
      input: M.MemoryHubReleaseInput,
    ) => Effect.Effect<M.MemoryHubReleaseResult, HubClientFailure>;
    readonly sourceReadRequest: (
      connection: HubConnection,
      input: M.MemoryHubSourceReadRequestInput,
    ) => Effect.Effect<M.MemoryHubSourceReadRequestResult, HubClientFailure>;
    readonly sourceReadCollect: (
      connection: HubConnection,
      input: M.MemoryHubSourceReadCollectInput,
    ) => Effect.Effect<M.MemoryHubSourceReadCollectResult, HubClientFailure>;
    readonly sourceReadRespond: (
      connection: HubConnection,
      input: M.MemoryHubSourceReadRespondInput,
    ) => Effect.Effect<M.MemoryHubSourceReadRespondResult, HubClientFailure>;
    readonly sourceReadResult: (
      connection: HubConnection,
      input: M.MemoryHubSourceReadResultInput,
    ) => Effect.Effect<M.MemoryHubSourceReadResultResult, HubClientFailure>;
  }
>()("goat/memory/MemoryHubClient") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* Secrets.ServerSecretStore;
  const settings = yield* Settings.ServerSettingsService;

  const ensureEpoch = Effect.fnUntraced(function* (connection: HubConnection) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
    );
    const configured = current.memoryHub;
    if (
      configured.mode !== "member" ||
      current.memoryHubVersion !== connection.epoch ||
      configured.endpoint !== connection.endpoint ||
      configured.hubEnvironmentId !== connection.hubEnvironmentId ||
      configured.secretName !== connection.secretName ||
      configured.memorySpaceId !== connection.memorySpaceId
    ) {
      return yield* new M.MemoryHubError({ code: "fenced" });
    }
  });

  const readJson = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
    const declared = response.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_MAX_BYTES)
    )
      return yield* new M.MemoryHubError({ code: "payload_too_large" });
    let size = 0;
    const chunks = yield* response.stream.pipe(
      Stream.mapError(() => new M.MemoryHubError({ code: "unavailable" })),
      Stream.mapEffect((chunk) => {
        size += chunk.length;
        return size > RESPONSE_MAX_BYTES
          ? Effect.fail(new M.MemoryHubError({ code: "payload_too_large" }))
          : Effect.succeed(chunk);
      }),
      Stream.runCollect,
    );
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return yield* decodeJson(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
    );
  });

  const checkResponse = Effect.fnUntraced(function* (
    response: HttpClientResponse.HttpClientResponse,
  ) {
    if (response.status >= 300 && response.status < 400)
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    if (response.status === 401) return yield* new M.MemoryHubUnauthorizedError({});
    if (response.status === 403) return yield* new M.MemoryHubForbiddenError({});
    if (response.status === 404 || response.status === 405)
      return yield* new M.MemoryHubError({ code: "route_unavailable" });
    if (response.status === 426)
      return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
    if (response.status === 413) return yield* new M.MemoryHubError({ code: "payload_too_large" });
    if (response.status === 429 || response.status >= 500)
      return yield* new M.MemoryHubError({ code: "unavailable" });
    const raw = yield* readJson(response);
    if (response.status < 200 || response.status >= 300) {
      const error = yield* decodeDomainError(raw).pipe(
        Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
      );
      return yield* error;
    }
    return raw;
  });

  // This service owns a fetch-backed transport with redirects and cookies disabled.
  // The caller cannot replace it with a cookie-preferred environment client.
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
      }),
      Effect.mapError(() => new M.MemoryHubError({ code: "unavailable" })),
      Effect.flatMap(checkResponse),
    );

  const preflightOnce = Effect.fnUntraced(function* (connection: HubConnection) {
    yield* ensureEpoch(connection);
    const endpoint = yield* decodeEndpoint(connection.endpoint).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "identity_mismatch" })),
    );
    const raw = yield* execute(
      HttpClientRequest.get(new URL(GOAT_ENVIRONMENT_PATH, endpoint).href),
    );
    const descriptor = yield* decodeDescriptor(raw).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
    );
    if (descriptor.environmentId !== connection.hubEnvironmentId)
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    if (descriptor.capabilities.memoryHubProtocolVersion !== 1)
      return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
    yield* ensureEpoch(connection);
    return descriptor;
  });

  const bounded = <A>(effect: Effect.Effect<A, HubClientFailure>) =>
    effect.pipe(
      Effect.retry({
        schedule: retrySchedule,
        while: (error) => error._tag === "MemoryHubError" && error.code === "unavailable",
      }),
      Effect.timeout(REQUEST_TIMEOUT_MS),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new M.MemoryHubError({ code: "unavailable" })),
      }),
    );

  const call = <I, IE, O, OE>(
    path: string,
    inputSchema: Schema.Codec<I, IE>,
    outputSchema: Schema.Codec<O, OE>,
  ) => {
    const encode = Schema.encodeEffect(Schema.fromJsonString(inputSchema));
    const decode = Schema.decodeUnknownEffect(outputSchema);
    return (connection: HubConnection, input: I) =>
      bounded(
        Effect.gen(function* () {
          const body = yield* encode(input).pipe(
            Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
          );
          if (new TextEncoder().encode(body).length > RESPONSE_MAX_BYTES)
            return yield* new M.MemoryHubError({ code: "payload_too_large" });
          yield* preflightOnce(connection);
          const credential = yield* secrets
            .get(connection.secretName)
            .pipe(Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })));
          if (Option.isNone(credential)) return yield* new M.MemoryHubUnauthorizedError({});
          const token = new TextDecoder().decode(credential.value);
          if (!/^[A-Za-z0-9_-]{43}$/.test(token))
            return yield* new M.MemoryHubUnauthorizedError({});
          yield* ensureEpoch(connection);
          const raw = yield* execute(
            HttpClientRequest.post(new URL(path, connection.endpoint).href).pipe(
              HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
              HttpClientRequest.bodyText(body, "application/json"),
            ),
          );
          const output = yield* decode(raw).pipe(
            Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
          );
          yield* ensureEpoch(connection);
          return output;
        }),
      );
  };

  return MemoryHubClient.of({
    preflight: (connection) => bounded(preflightOnce(connection)),
    join: call(M.MEMORY_HUB_PATHS.join, M.MemoryHubJoinInput, M.MemoryHubJoinResult),
    push: call(M.MEMORY_HUB_PATHS.push, M.MemoryHubPushInput, M.MemoryHubPushResult),
    pull: call(M.MEMORY_HUB_PATHS.pull, M.MemoryHubPullInput, M.MemoryHubPullResult),
    claim: call(M.MEMORY_HUB_PATHS.claim, M.MemoryHubClaimInput, M.MemoryResolutionLease),
    renew: call(M.MEMORY_HUB_PATHS.renew, M.MemoryHubRenewInput, M.MemoryResolutionLease),
    applyResolution: call(
      M.MEMORY_HUB_PATHS.applyResolution,
      M.MemoryHubApplyResolutionInput,
      M.MemoryHubReceipt,
    ),
    release: call(M.MEMORY_HUB_PATHS.release, M.MemoryHubReleaseInput, M.MemoryHubReleaseResult),
    sourceReadRequest: call(
      M.MEMORY_HUB_PATHS.sourceReadRequest,
      M.MemoryHubSourceReadRequestInput,
      M.MemoryHubSourceReadRequestResult,
    ),
    sourceReadCollect: call(
      M.MEMORY_HUB_PATHS.sourceReadCollect,
      M.MemoryHubSourceReadCollectInput,
      M.MemoryHubSourceReadCollectResult,
    ),
    sourceReadRespond: call(
      M.MEMORY_HUB_PATHS.sourceReadRespond,
      M.MemoryHubSourceReadRespondInput,
      M.MemoryHubSourceReadRespondResult,
    ),
    sourceReadResult: call(
      M.MEMORY_HUB_PATHS.sourceReadResult,
      M.MemoryHubSourceReadResultInput,
      M.MemoryHubSourceReadResultResult,
    ),
  });
});

export const layer = Layer.effect(MemoryHubClient, make).pipe(Layer.provide(FetchHttpClient.layer));
