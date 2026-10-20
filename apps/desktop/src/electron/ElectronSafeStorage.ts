import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import * as HostProcess from "@goat/shared/HostProcess";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { isIsolatedDesktopBaseDir } from "../app/DesktopStatePaths.ts";

const DEV_PLAINTEXT_SECRET_PREFIX = "goat-dev-plaintext:v1:";

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
// Distinct prefix so development-plaintext blobs cannot collide with OS-encrypted blobs.
const devPlaintextPrefixBytes = textEncoder.encode(DEV_PLAINTEXT_SECRET_PREFIX);

const hasDevPlaintextPrefix = (value: Uint8Array): boolean =>
  value.byteLength >= devPlaintextPrefixBytes.byteLength &&
  devPlaintextPrefixBytes.every((byte, index) => value[index] === byte);

const encodeDevPlaintextSecret = (value: string): Uint8Array =>
  textEncoder.encode(`${DEV_PLAINTEXT_SECRET_PREFIX}${Base64.encode(textEncoder.encode(value))}`);

const decodeDevPlaintextSecret = (
  value: Uint8Array,
): Effect.Effect<string, ElectronSafeStorageDecryptError> =>
  Effect.gen(function* () {
    const encodedPayload = yield* Effect.try({
      try: () => utf8Decoder.decode(value.subarray(devPlaintextPrefixBytes.byteLength)),
      catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
    });
    const decodedBytes = yield* Effect.fromResult(Base64.decode(encodedPayload)).pipe(
      Effect.mapError((cause) => new ElectronSafeStorageDecryptError({ cause })),
    );
    return yield* Effect.try({
      try: () => utf8Decoder.decode(decodedBytes),
      catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
    });
  });

const electronSafeStorageErrorFields = {
  cause: Schema.Defect(),
};

export class ElectronSafeStorageAvailabilityError extends Schema.TaggedError<ElectronSafeStorageAvailabilityError>()(
  "ElectronSafeStorageAvailabilityError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Schema.TaggedError<ElectronSafeStorageEncryptError>()(
  "ElectronSafeStorageEncryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Schema.TaggedError<ElectronSafeStorageDecryptError>()(
  "ElectronSafeStorageDecryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export const ElectronSafeStorageError = Schema.Union([
  ElectronSafeStorageAvailabilityError,
  ElectronSafeStorageEncryptError,
  ElectronSafeStorageDecryptError,
]);
export type ElectronSafeStorageError = typeof ElectronSafeStorageError.Type;

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  {
    readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
    readonly encryptString: (
      value: string,
    ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
    readonly decryptString: (
      value: Uint8Array,
    ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
    readonly selectedStorageBackend: Effect.Effect<Option.Option<string>>;
  }
>()("@goat/desktop/electron/ElectronSafeStorage") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const desktopEnvironment = yield* Effect.serviceOption(DesktopEnvironment.DesktopEnvironment);
  // Unsigned dev Electron launched from a shell or agent lacks OS keyring
  // access. Only an opted-in, unpackaged dev run in an isolated home may fall
  // back to plaintext-wrapped secrets; anything else keeps refusing to save.
  const allowInsecureDevFallback = Option.isNone(desktopEnvironment)
    ? false
    : yield* Effect.gen(function* () {
        const env = desktopEnvironment.value;
        if (env.isPackaged || !env.isDevelopment || env.insecureDevSecretStorage !== true)
          return false;
        return yield* isIsolatedDesktopBaseDir({
          homeDirectory: env.homeDirectory,
          baseDir: env.baseDir,
          platform: env.platform,
        });
      });
  const warnedRef = yield* Ref.make(false);
  const warnInsecureFallbackOnce = Ref.getAndSet(warnedRef, true).pipe(
    Effect.flatMap((alreadyWarned) =>
      alreadyWarned
        ? Effect.void
        : Effect.logWarning(
            "Desktop secure storage is unavailable; storing secrets with development-plaintext encoding because GOAT_DEV_INSECURE_SECRET_STORAGE is enabled for an isolated home.",
          ),
    ),
  );

  const checkNativeEncryptionAvailable = Effect.try({
    try: () => Electron.safeStorage.isEncryptionAvailable(),
    catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
  });

  return ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.gen(function* () {
      const available = yield* checkNativeEncryptionAvailable;
      if (available) {
        return true;
      }
      if (!allowInsecureDevFallback) {
        return false;
      }
      yield* warnInsecureFallbackOnce;
      return true;
    }),
    encryptString: (value) =>
      Effect.gen(function* () {
        if (allowInsecureDevFallback) {
          const available = yield* Effect.try({
            try: () => Electron.safeStorage.isEncryptionAvailable(),
            catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
          });
          if (!available) {
            yield* warnInsecureFallbackOnce;
            return encodeDevPlaintextSecret(value);
          }
        }
        return yield* Effect.try({
          try: () => Electron.safeStorage.encryptString(value),
          catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
        });
      }),
    decryptString: (value) =>
      Effect.gen(function* () {
        if (hasDevPlaintextPrefix(value)) {
          if (!allowInsecureDevFallback) {
            return yield* new ElectronSafeStorageDecryptError({
              cause: new Error(
                "Refusing to decrypt a development plaintext secret while insecure development secret storage is inactive.",
              ),
            });
          }
          yield* warnInsecureFallbackOnce;
          return yield* decodeDevPlaintextSecret(value);
        }
        return yield* Effect.try({
          try: () => Electron.safeStorage.decryptString(Buffer.from(value)),
          catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
        });
      }),
    selectedStorageBackend: Effect.sync(() => {
      if (platform !== "linux") {
        return Option.none();
      }
      try {
        return Option.fromNullishOr(Electron.safeStorage.getSelectedStorageBackend());
      } catch {
        return Option.none();
      }
    }),
  });
});

export const layer = Layer.effect(ElectronSafeStorage, make);
