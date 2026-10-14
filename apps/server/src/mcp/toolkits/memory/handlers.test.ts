import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as Store from "../../../memory/MemoryStore.ts";
import { MemoryToolkit, MemoryReadSourceToolkit } from "./tools.ts";
import { memoryError } from "./handlers.ts";
import * as Fixture from "./handlers.testkit.ts";

const decodeReceipt = Schema.decodeUnknownEffect(M.MemoryMutationReceipt);
const decodePage = Schema.decodeUnknownEffect(M.MemoryPage);
const decodeHistory = Schema.decodeUnknownEffect(M.MemoryHistoryPage);
const encodeError = Schema.encodeSync(M.MemoryRpcError);

it("stages exactly eight core tools and defines source separately", () => {
  expect(Object.keys(MemoryToolkit.tools)).toEqual(
    M.MEMORY_MCP_TOOLS.filter((name) => name !== "memory_read_source"),
  );
  expect(Object.keys(MemoryReadSourceToolkit.tools)).toEqual(["memory_read_source"]);
  for (const tool of Object.values(MemoryToolkit.tools))
    expect(Tool.getJsonSchema(tool).type).toBe("object");
});
it.effect(
  "real toolkit writes, reads, searches with service cursor, lists, histories, forgets and refuses invalid revert",
  () =>
    Effect.gen(function* () {
      const created = yield* Fixture.call("memory_upsert", Fixture.upsert());
      expect((yield* decodeReceipt(created.body)).outcome).toBe("accepted");
      const service = yield* MemoryService.MemoryService;
      const query = {
        memorySpaceId: Fixture.space,
        query: "synthetic",
        mode: "substring" as const,
        limit: 1,
      };
      const direct = yield* service.search(query, Effect.void);
      expect((yield* Fixture.call("memory_search", query)).body).toEqual(direct);
      expect(
        (yield* decodePage(
          (yield* Fixture.call("memory_list", {
            memorySpaceId: Fixture.space,
            includeQuarantined: false,
            limit: 1,
          })).body,
        )).items,
      ).toHaveLength(1);
      expect(
        (yield* Fixture.call("memory_read", {
          memorySpaceId: Fixture.space,
          memoryId: Fixture.memoryId,
        })).body,
      ).toMatchObject({ status: "active", payload: { text: "synthetic memory" } });
      expect(
        (yield* decodeHistory(
          (yield* Fixture.call("memory_history", {
            memorySpaceId: Fixture.space,
            memoryId: Fixture.memoryId,
            limit: 1,
          })).body,
        )).revisions,
      ).toHaveLength(1);
      const read = yield* service.read(
        { memorySpaceId: Fixture.space, memoryId: Fixture.memoryId },
        Effect.void,
      );
      expect(
        (yield* Fixture.call("memory_forget", {
          memorySpaceId: Fixture.space,
          memoryId: Fixture.memoryId,
          operationId: M.MemoryOperationId.make(Fixture.id(4)),
          expectedHeads: read.status === "active" ? [read.revision.revisionId] : [],
        })).result.isError,
      ).not.toBe(true);
      expect(
        (yield* Fixture.call("memory_revert_resolution", {
          memorySpaceId: Fixture.space,
          operationId: M.MemoryOperationId.make(Fixture.id(5)),
          memoryId: Fixture.memoryId,
          resolutionId: M.MemoryResolutionId.make(Fixture.id(6)),
          restoredRevisionId: M.MemoryRevisionId.make(Fixture.id(7)),
          expectedHeads: [M.MemoryRevisionId.make(Fixture.id(8))],
        })).result.isError,
      ).toBe(true);
      expect((yield* Fixture.call("memory_sync_status", {})).body).toMatchObject({
        code: "hub_disabled",
      });
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each(M.MEMORY_MCP_TOOLS.filter((name) => name !== "memory_read_source"))(
  "denies ungranted %s at the registered toolkit",
  (name) =>
    Effect.gen(function* () {
      const input =
        name === "memory_upsert"
          ? Fixture.upsert()
          : name === "memory_list"
            ? { memorySpaceId: Fixture.space, includeQuarantined: false }
            : name === "memory_search"
              ? { memorySpaceId: Fixture.space, query: "synthetic" }
              : name === "memory_sync_status"
                ? {}
                : name === "memory_forget"
                  ? {
                      memorySpaceId: Fixture.space,
                      memoryId: Fixture.memoryId,
                      operationId: M.MemoryOperationId.make(Fixture.id(4)),
                      expectedHeads: [],
                    }
                  : name === "memory_revert_resolution"
                    ? {
                        memorySpaceId: Fixture.space,
                        memoryId: Fixture.memoryId,
                        operationId: M.MemoryOperationId.make(Fixture.id(5)),
                        resolutionId: M.MemoryResolutionId.make(Fixture.id(6)),
                        restoredRevisionId: M.MemoryRevisionId.make(Fixture.id(7)),
                        expectedHeads: [M.MemoryRevisionId.make(Fixture.id(8))],
                      }
                    : { memorySpaceId: Fixture.space, memoryId: Fixture.memoryId };
      expect((yield* Fixture.call(name, input, Fixture.scope([]))).body).toMatchObject({
        code: "unavailable",
      });
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect(
  "read-only refuses upsert despite stored write; a non-read-only explicit writer succeeds",
  () =>
    Effect.gen(function* () {
      const granted = Fixture.scope();
      expect(
        (yield* Fixture.call("memory_upsert", Fixture.upsert(), {
          ...granted,
          client: { ...granted.client!, access: "read-only" },
        })).result.isError,
      ).toBe(true);
      expect(
        (yield* Fixture.call("memory_upsert", Fixture.upsert(), { ...granted, readOnly: true }))
          .result.isError,
      ).toBe(true);
      expect(
        (yield* Fixture.call("memory_upsert", Fixture.upsert(), granted)).result.isError,
      ).not.toBe(true);
    }).pipe(Effect.provide(Fixture.layer)),
);

it("maps safe code and capacity without exposing causes or undefined", () => {
  for (const error of [
    new Store.MemoryStorageError({ stage: "test", cause: "synthetic private detail" }),
    new MemoryService.MemoryAccessError({ code: "fenced" }),
    new Store.MemoryCapacityError({ dimension: "body", current: 3, limit: 2 }),
  ]) {
    const safe = memoryError(error);
    expect(Object.values(safe).some((value) => value === undefined)).toBe(false);
    const encoded = encodeError(safe);
    expect(JSON.stringify(encoded)).not.toContain("synthetic private detail");
  }
  expect(
    memoryError(new Store.MemoryCapacityError({ dimension: "body", current: 3, limit: 2 }))
      .capacity,
  ).toMatchObject({ current: 3, limit: 2 });
});

it.effect("strict contract decoding rejects extra keys before persisting a raw MCP request", () =>
  Effect.gen(function* () {
    const result = yield* Fixture.call("memory_upsert", {
      ...Fixture.upsert(),
      unexpected: "synthetic",
    });
    expect(result.result.isError).toBe(true);
    const service = yield* MemoryService.MemoryService;
    expect(
      (yield* service.list(
        { memorySpaceId: Fixture.space, includeQuarantined: false, limit: 20 },
        Effect.void,
      )).items,
    ).toHaveLength(0);
  }).pipe(Effect.provide(Fixture.layer)),
);
