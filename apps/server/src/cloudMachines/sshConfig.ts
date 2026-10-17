import { CloudMachineError, isCloudMachineAlias } from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import * as ProcessRunner from "../processRunner.ts";
import type { BoatSshEndpoint } from "./BoatClient.ts";

/**
 * This computer's OpenSSH files for cloud machines. Each machine gets
 * ~/.ssh/goat-cloud/<alias>.conf and a pinned <alias>.known_hosts, reached through one Include
 * line at the top of ~/.ssh/config. Everything else in ~/.ssh/config is left byte for byte.
 */

export const CLOUD_SSH_INCLUDE = "Include ~/.ssh/goat-cloud/*.conf";
const INCLUDE_LINE = /^\s*Include\s+\S*goat-cloud\/\*\.conf\s*$/imu;

/** Puts the Include first, because OpenSSH keeps the first value it reads for each option. */
export function insertCloudInclude(source: string): string {
  if (INCLUDE_LINE.test(source)) return source;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return source.length === 0 ? CLOUD_SSH_INCLUDE + newline : CLOUD_SSH_INCLUDE + newline + source;
}

const quote = (value: string) => `"${value.replaceAll('"', "")}"`;

export function renderCloudHost(input: {
  readonly alias: string;
  readonly endpoint: BoatSshEndpoint;
  readonly identityFile: string;
  readonly knownHostsFile: string;
}): string {
  if (!isCloudMachineAlias(input.alias)) throw new Error("Invalid cloud machine alias");
  return [
    `Host ${input.alias}`,
    `  HostName ${input.endpoint.host}`,
    `  Port ${input.endpoint.port}`,
    `  User ${input.endpoint.user}`,
    `  IdentityFile ${quote(input.identityFile)}`,
    "  IdentitiesOnly yes",
    `  HostKeyAlias ${input.alias}`,
    `  UserKnownHostsFile ${quote(input.knownHostsFile)}`,
    "  StrictHostKeyChecking yes",
    "",
  ].join("\n");
}

/**
 * Checks `ssh -G <alias>` output: the pinned known_hosts file, strict checking and the host key
 * alias must be what GOAT wrote, or an earlier option in the user's config would win.
 */
export function effectiveSettingsMatch(
  output: string,
  expected: {
    readonly alias: string;
    readonly endpoint: BoatSshEndpoint;
    readonly knownHostsFile: string;
    readonly identityFile: string;
  },
): boolean {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const [key, ...rest] = line.trim().split(/\s+/u);
    if (key && rest.length > 0 && !values.has(key.toLowerCase()))
      values.set(key.toLowerCase(), rest.join(" "));
  }
  const strict = values.get("stricthostkeychecking");
  return (
    (strict === "true" || strict === "yes") &&
    values.get("identitiesonly") === "yes" &&
    values.get("hostkeyalias") === expected.alias &&
    values.get("userknownhostsfile")?.split(" ")[0] === expected.knownHostsFile &&
    values.get("hostname") === expected.endpoint.host &&
    values.get("port") === String(expected.endpoint.port) &&
    values.get("identityfile") === expected.identityFile
  );
}

/** Whether the user's own config already names this alias in a Host line. */
export function definesHostAlias(config: string, alias: string): boolean {
  return config
    .split(/\r?\n/u)
    .some(
      (line) => /^\s*Host\s/iu.test(line) && line.trim().split(/\s+/u).slice(1).includes(alias),
    );
}

export class CloudMachineSsh extends Context.Service<
  CloudMachineSsh,
  {
    /** Adds the Include line to ~/.ssh/config once; the caller has the user's consent. */
    readonly installInclude: Effect.Effect<void, CloudMachineError>;
    /** GOAT's own key pair, created on first use; returns the public key. */
    readonly ensureKey: Effect.Effect<
      { readonly identityFile: string; readonly publicKey: string },
      CloudMachineError
    >;
    /**
     * Writes the alias's conf and pinned known_hosts, each atomically and private, then checks
     * that OpenSSH really uses them. Always rewrites, so the conf's mtime says when it was last
     * confirmed. `changed` is whether the address or host key differs from before.
     */
    readonly writeHost: (
      alias: string,
      endpoint: BoatSshEndpoint,
    ) => Effect.Effect<{ readonly changed: boolean }, CloudMachineError>;
    readonly removeHost: (alias: string) => Effect.Effect<void, CloudMachineError>;
  }
>()("goat/cloudMachines/sshConfig/CloudMachineSsh") {}

const failed = () => new CloudMachineError({ reason: "ssh_config_failed" });

export const make = (options: { readonly home: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const crypto = yield* Crypto.Crypto;
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const sshDir = path.join(options.home, ".ssh");
    const cloudDir = path.join(sshDir, "goat-cloud");
    const configPath = path.join(sshDir, "config");
    const keyPath = path.join(cloudDir, "id_ed25519");
    const confPath = (alias: string) => path.join(cloudDir, `${alias}.conf`);
    const knownHostsPath = (alias: string) => path.join(cloudDir, `${alias}.known_hosts`);

    const ensureDirectory = (directory: string) =>
      fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.andThen(fs.chmod(directory, 0o700)));

    const readOptional = (file: string) =>
      fs
        .exists(file)
        .pipe(
          Effect.flatMap((exists) => (exists ? fs.readFileString(file) : Effect.succeed(null))),
        );
    const isSymlink = (file: string) =>
      fs.readLink(file).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    // Checked before any chmod, so a link never makes GOAT change another directory.
    const ensureCloudDirectory = isSymlink(cloudDir).pipe(
      Effect.flatMap((linked) =>
        linked ? Effect.fail(failed()) : ensureDirectory(cloudDir).pipe(Effect.mapError(failed)),
      ),
    );

    /** Same-directory temp file, created exclusively with mode 0600, then renamed into place. */
    const writePrivate = (file: string, contents: string) =>
      Effect.gen(function* () {
        const temp = `${file}.${yield* crypto.randomUUIDv4()}.tmp`;
        yield* fs.writeFileString(temp, contents, { mode: 0o600, flag: "wx" }).pipe(
          Effect.andThen(fs.chmod(temp, 0o600)),
          Effect.andThen(fs.rename(temp, file)),
          Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore)),
        );
      });

    const run = (command: string, args: ReadonlyArray<string>) =>
      runner.run({ command, args, timeout: "20 seconds" }).pipe(
        Effect.flatMap((output) =>
          output.code === 0 ? Effect.succeed(output.stdout) : Effect.fail(failed()),
        ),
        Effect.mapError(failed),
      );

    const installInclude = Effect.gen(function* () {
      yield* ensureDirectory(sshDir);
      const existing = yield* readOptional(configPath);
      const next = insertCloudInclude(existing ?? "");
      if (next === existing) return;
      const mode = existing === null ? 0o600 : (yield* fs.stat(configPath)).mode & 0o777;
      // Resolves a symlinked config (dotfile managers) and rewrites its target in place.
      yield* writeFileStringAtomically({ filePath: configPath, contents: next }).pipe(
        Effect.provide(context),
      );
      yield* fs.chmod(configPath, mode);
    }).pipe(Effect.mapError(failed));

    const ensureKey = Effect.gen(function* () {
      yield* ensureCloudDirectory;
      const publicPath = `${keyPath}.pub`;
      // GOAT's key lives only here; a link could point SSH at some other identity.
      for (const file of [keyPath, publicPath]) if (yield* isSymlink(file)) return yield* failed();
      const [hasPrivate, hasPublic] = [yield* fs.exists(keyPath), yield* fs.exists(publicPath)];
      // Half a key pair is never completed or overwritten; the user has to look at it.
      if (hasPrivate !== hasPublic) return yield* failed();
      if (!hasPrivate)
        yield* run("ssh-keygen", [
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-C",
          "goat-cloud",
          "-f",
          keyPath,
        ]);
      const publicKey = (yield* fs.readFileString(publicPath)).trim();
      if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( .*)?$/u.test(publicKey)) return yield* failed();
      return { identityFile: keyPath, publicKey };
    }).pipe(Effect.mapError(failed));

    // The Include comes first, so a host the user already named this way would be shadowed.
    const refuseShadowedHost = (alias: string) =>
      readOptional(configPath).pipe(
        Effect.mapError(failed),
        Effect.flatMap((config) =>
          definesHostAlias(config ?? "", alias)
            ? Effect.fail(new CloudMachineError({ reason: "alias_conflict" }))
            : Effect.void,
        ),
      );

    const writeHost = (alias: string, endpoint: BoatSshEndpoint) =>
      refuseShadowedHost(alias).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (!isCloudMachineAlias(alias)) return yield* failed();
            yield* ensureCloudDirectory;
            const knownHostsFile = knownHostsPath(alias);
            const conf = renderCloudHost({
              alias,
              endpoint,
              identityFile: keyPath,
              knownHostsFile,
            });
            const knownHosts = `${alias} ${endpoint.hostKey}\n`;
            const changed =
              (yield* readOptional(confPath(alias))) !== conf ||
              (yield* readOptional(knownHostsFile)) !== knownHosts;
            // A crash between the two writes pairs an address with the other key, and SSH refuses it.
            yield* writePrivate(knownHostsFile, knownHosts);
            yield* writePrivate(confPath(alias), conf);
            return changed;
          }).pipe(
            Effect.mapError(failed),
            Effect.flatMap((changed) =>
              run("ssh", ["-G", alias]).pipe(
                Effect.flatMap((output) =>
                  effectiveSettingsMatch(output, {
                    alias,
                    endpoint,
                    knownHostsFile: knownHostsPath(alias),
                    identityFile: keyPath,
                  })
                    ? Effect.succeed({ changed })
                    : Effect.fail(new CloudMachineError({ reason: "ssh_config_overridden" })),
                ),
              ),
            ),
          ),
        ),
      );

    const removeHost = (alias: string) =>
      isCloudMachineAlias(alias)
        ? Effect.all([
            fs.remove(confPath(alias), { force: true }),
            fs.remove(knownHostsPath(alias), { force: true }),
          ]).pipe(Effect.asVoid, Effect.mapError(failed))
        : Effect.fail(failed());

    return CloudMachineSsh.of({ installInclude, ensureKey, writeHost, removeHost });
  });

export const layer = (options: { readonly home?: string } = {}) =>
  Layer.effect(CloudMachineSsh, make({ home: options.home ?? NodeOS.homedir() }));
