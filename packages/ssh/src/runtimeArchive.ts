import { cliArchiveFileName, type CliArchivePlatformKey } from "@t3tools/shared/cliRelease";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { SshLaunchError } from "./errors.ts";

const MAX_LOCAL_ARCHIVE_BYTES = 256n * 1024n * 1024n;

export const readLocalRuntimeArchive = Effect.fn("ssh.runtimeArchive.read")(function* (
  directory: string,
  version: string,
  platformKey: CliArchivePlatformKey,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const fileName = cliArchiveFileName(version, platformKey);
  const filePath = path.join(directory, fileName);
  if (!(yield* fs.exists(filePath))) return null;
  const stat = yield* fs.stat(filePath);
  if (stat.type !== "File" || stat.size > MAX_LOCAL_ARCHIVE_BYTES) {
    return yield* new SshLaunchError({
      message: "Local SSH runtime archive must be a file no larger than 256 MiB.",
      stdout: "",
    });
  }
  const bytes = yield* fs.readFile(filePath);
  // A file can change between stat and read; hash only the size we validated.
  if (
    BigInt(bytes.byteLength) > MAX_LOCAL_ARCHIVE_BYTES ||
    BigInt(bytes.byteLength) !== stat.size
  ) {
    return yield* new SshLaunchError({
      message: "Local SSH runtime archive size changed while reading.",
      stdout: "",
    });
  }
  const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes));
  return { fileName, bytes, sha256 };
});
