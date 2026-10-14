import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Config from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as Identity from "./environment/ServerEnvironment.ts";
import * as Secrets from "./auth/ServerSecretStore.ts";
import * as Persistence from "./persistence/Sqlite.ts";

const owner = M.EnvironmentId.make("fixture-owner");
const requester = M.EnvironmentId.make("fixture-requester");
const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const decodePersistedSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(M.ServerSettings));
const requestId = M.MemoryOperationId.make("00000000-0000-4000-8000-000000000002");
const identity = Layer.succeed(Identity.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(owner),
});
const fixture = () =>
  Settings.layer.pipe(
    Layer.provide(Secrets.layer),
    Layer.provide(identity),
    Layer.provideMerge(Layer.fresh(Persistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(Config.layerTest(process.cwd(), { prefix: "goat-owner-policy-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
const initialize = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* Config.ServerConfig;
  yield* fs.writeFileString(
    config.settingsPath,
    JSON.stringify({ memoryHub: { mode: "hub", memorySpaceId: space } }),
  );
  const settings = yield* Settings.ServerSettingsService;
  yield* settings.getSettings;
  return {
    settings,
    fs,
    config,
    policy: yield* Settings.MemoryOwnerSourceReadCommittedPolicy,
    admin: yield* Settings.MemoryOwnerSourceReadPolicyAdministration,
  };
});
const update = (
  admin: Settings.MemoryOwnerSourceReadPolicyAdministration["Service"],
  version: number,
  ids: ReadonlyArray<M.EnvironmentId>,
) =>
  admin.update(
    { requestId, expectedVersion: version, allowedRequesterEnvironmentIds: ids },
    Effect.void,
  );

it.effect("default denies and owner administration requires its settings permit", () =>
  Effect.gen(function* () {
    const { policy, admin } = yield* initialize;
    expect(yield* policy.read).toEqual({
      policy: M.DEFAULT_MEMORY_OWNER_SOURCE_READ_POLICY,
      version: 0,
    });
    const deny = Effect.fail(new M.MemoryRpcError({ code: "unavailable" }));
    expect((yield* Effect.flip(admin.get(deny))).code).toBe("unavailable");
    expect(
      (yield* Effect.flip(
        admin.update(
          { requestId, expectedVersion: 0, allowedRequesterEnvironmentIds: [requester] },
          deny,
        ),
      ))._tag,
    ).toBe("MemoryRpcError");
    expect((yield* policy.read).version).toBe(0);
  }).pipe(Effect.provide(fixture())),
);

it.effect("CAS rejects a stale write without changing policy or version", () =>
  Effect.gen(function* () {
    const { policy, admin } = yield* initialize;
    const granted = yield* update(admin, 0, [requester]);
    expect(granted.policy.enrollments).toEqual([
      {
        memorySpaceId: space,
        ownerEnvironmentId: owner,
        requesterEnvironmentId: requester,
        ownerPolicyEpoch: 1,
        state: "active",
      },
    ]);
    expect(yield* Effect.flip(update(admin, 0, []))).toMatchObject({ code: "revision_changed" });
    expect(yield* policy.read).toEqual({ policy: granted.policy, version: 1 });
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "removal persists the pair and barrier; only a matching ack activates a newer enrollment",
  () =>
    Effect.gen(function* () {
      const { policy, admin, fs, config } = yield* initialize;
      const granted = yield* update(admin, 0, [requester]);
      const removed = yield* update(admin, granted.version, []);
      expect(removed.policy.ownerPolicyEpoch).toBeGreaterThan(granted.policy.ownerPolicyEpoch);
      expect(removed.revocationPropagation).toBe("pending");
      const removal = removed.policy.removals[0]!;
      expect(removal).toMatchObject({
        memorySpaceId: space,
        ownerEnvironmentId: owner,
        requesterEnvironmentId: requester,
        state: "pending",
      });
      const pending = yield* update(admin, removed.version, [requester]);
      expect(pending.policy.allowedRequesterEnvironmentIds).toEqual([]);
      expect(pending.policy.enrollments[0]?.state).toBe("pending");
      const ack = {
        memorySpaceId: space,
        ownerEnvironmentId: owner,
        requesterEnvironmentId: requester,
        removalEpoch: removal.removalEpoch,
        revokedThroughEpoch: removal.removalEpoch + 10,
      };
      expect(
        yield* policy.recordRevokeAck({
          ...ack,
          requesterEnvironmentId: M.EnvironmentId.make("fixture-other"),
        }),
      ).toEqual({ policy: pending.policy, version: pending.version });
      expect(
        yield* policy.recordRevokeAck({ ...ack, removalEpoch: removal.removalEpoch - 1 }),
      ).toEqual({ policy: pending.policy, version: pending.version });
      const settled = yield* policy.recordRevokeAck(ack);
      expect(settled.policy.removals[0]?.state).toBe("acknowledged");
      expect(settled.policy.enrollments[0]?.state).toBe("active");
      expect(settled.policy.enrollments[0]?.ownerPolicyEpoch).toBeGreaterThan(
        ack.revokedThroughEpoch,
      );
      expect(settled.policy.allowedRequesterEnvironmentIds).toEqual([requester]);
      expect((yield* admin.get(Effect.void)).revocationPropagation).toBe("acknowledged");
      expect(yield* policy.recordRevokeAck(ack)).toBe(settled);
      const saved = yield* decodePersistedSettings(yield* fs.readFileString(config.settingsPath));
      expect(saved.memoryOwnerSourceReadPolicy).toEqual(settled.policy);
      expect(saved.memoryOwnerSourceReadPolicyVersion).toBe(settled.version);
      expect(Object.isFrozen(settled.policy.enrollments)).toBe(true);
      expect(Object.isFrozen(settled.policy.removals[0])).toBe(true);
    }).pipe(Effect.provide(fixture())),
);

it.effect("removing a pending reenrollment keeps the revocation closed after its ack", () =>
  Effect.gen(function* () {
    const { policy, admin } = yield* initialize;
    yield* update(admin, 0, [requester]);
    const removed = yield* update(admin, 1, []);
    yield* update(admin, 2, [requester]);
    yield* update(admin, 3, []);
    const r = removed.policy.removals[0]!;
    const settled = yield* policy.recordRevokeAck({ ...r, revokedThroughEpoch: r.removalEpoch });
    expect(settled.policy.allowedRequesterEnvironmentIds).toEqual([]);
    expect(settled.policy.enrollments).toEqual([]);
  }).pipe(Effect.provide(fixture())),
);

it.effect("unbound policy cannot enroll; duplicate requesters and invalid ack are rejected", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    yield* settings.getSettings;
    const admin = yield* Settings.MemoryOwnerSourceReadPolicyAdministration;
    const policy = yield* Settings.MemoryOwnerSourceReadCommittedPolicy;
    expect(yield* Effect.flip(update(admin, 0, [requester]))).toMatchObject({
      code: "bootstrap_required",
    });
    expect(yield* Effect.flip(update(admin, 0, [requester, requester]))).toMatchObject({
      code: "invalid_output",
    });
    expect(
      yield* Effect.flip(
        policy.recordRevokeAck({
          memorySpaceId: space,
          ownerEnvironmentId: owner,
          requesterEnvironmentId: requester,
          removalEpoch: 2,
          revokedThroughEpoch: 1,
        }),
      ),
    ).toMatchObject({ code: "invalid_output" });
    expect((yield* policy.read).version).toBe(0);
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "changes retain only the latest committed value and unrelated settings do not publish",
  () =>
    Effect.gen(function* () {
      const { settings, policy, admin } = yield* initialize;
      const changes = yield* policy.changes;
      yield* update(admin, 0, [requester]);
      const removed = yield* update(admin, 1, []);
      yield* settings.updateSettings({ standingInstructions: "fixture" });
      const observations = yield* Stream.runCollect(changes.pipe(Stream.take(2)));
      expect(observations.map((v) => v.version)).toEqual([0, 2]);
      expect(observations[1]?.policy).toEqual(removed.policy);
    }).pipe(Effect.provide(fixture())),
);

it.effect("a settings write failure cannot publish an enrollment", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let failRename = false;
    const failingFs = {
      ...fs,
      rename: (from: string, to: string) =>
        failRename
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
              }),
            )
          : fs.rename(from, to),
    };
    yield* Effect.gen(function* () {
      const { policy, admin } = yield* initialize;
      const before = yield* policy.read;
      failRename = true;
      expect((yield* Effect.flip(update(admin, 0, [requester])))._tag).toBe("ServerSettingsError");
      expect(yield* policy.read).toBe(before);
    }).pipe(
      Effect.provide(
        Settings.layer.pipe(
          Layer.provide(Secrets.layer),
          Layer.provide(identity),
          Layer.provideMerge(Layer.fresh(Persistence.layerMemory)),
          Layer.provideMerge(
            Layer.fresh(Config.layerTest(process.cwd(), { prefix: "goat-owner-failure-test-" })),
          ),
          Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFs)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
