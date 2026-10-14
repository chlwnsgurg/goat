import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  captureMemoryGrantCeiling,
  effectiveMemoryGrant,
  memoryAccessPermit,
} from "./MemoryAccess.ts";
import { MemoryAccessError } from "./MemoryService.ts";

describe("memory authority intersection", () => {
  it("keeps managed defaults distinct from legacy task absence", () => {
    const base = { enableAgentMemoryAccess: true, policyReady: true, readOnly: false };
    expect(effectiveMemoryGrant({ ...base, memoryGrantCeiling: null })).toBe("read_write");
    expect(effectiveMemoryGrant({ ...base, memoryGrantCeiling: undefined })).toBe("none");
    for (const memoryGrantCeiling of ["none", "read", "read_write"] as const) {
      expect(effectiveMemoryGrant({ ...base, memoryGrantCeiling })).toBe(memoryGrantCeiling);
      expect(
        effectiveMemoryGrant({ ...base, memoryGrantCeiling, enableAgentMemoryAccess: false }),
      ).toBe("none");
      expect(effectiveMemoryGrant({ ...base, memoryGrantCeiling, policyReady: false })).toBe(
        "none",
      );
    }
    expect(
      effectiveMemoryGrant({ ...base, memoryGrantCeiling: "read_write", readOnly: true }),
    ).toBe("read");
    expect(
      effectiveMemoryGrant({ ...base, memoryGrantCeiling: "read_write", dispatchScopes: [] }),
    ).toBe("none");
    expect(
      effectiveMemoryGrant({
        ...base,
        memoryGrantCeiling: "read_write",
        dispatchScopes: ["memory:read"],
      }),
    ).toBe("read");
    expect(captureMemoryGrantCeiling(["orchestration:operate"], false)).toBe("none");
    expect(captureMemoryGrantCeiling(["memory:read"], false)).toBe("read");
    expect(captureMemoryGrantCeiling(["memory:read", "memory:write"], false)).toBe("read_write");
    expect(captureMemoryGrantCeiling(["memory:read", "memory:write"], true)).toBe("read");
  });
  it.effect("requires explicit source compound scopes and a repeatable live permit", () =>
    Effect.gen(function* () {
      let active = true;
      let checks = 0;
      const live = Effect.suspend(() => {
        checks++;
        return active ? Effect.void : Effect.fail(new MemoryAccessError({ code: "unavailable" }));
      });
      const permit = memoryAccessPermit(
        {
          readOnly: false,
          grantedScopes: ["memory:read", "orchestration:read"],
          reauthorize: (scopes) => {
            expect(scopes).toEqual(["memory:read", "orchestration:read"]);
            return live;
          },
        },
        "source",
      );
      yield* permit;
      active = false;
      expect((yield* Effect.flip(permit)).message).toBe("Memory access denied.");
      expect(checks).toBe(2);
      for (const input of [
        { readOnly: false },
        {
          readOnly: false,
          grantedScopes: ["memory:read" as const],
          reauthorize: () => Effect.void,
        },
      ])
        expect((yield* Effect.flip(memoryAccessPermit(input, "source"))).message).toBe(
          "Memory access denied.",
        );
    }),
  );
  it.effect("denies writes even with stored grants on a read-only caller", () =>
    Effect.gen(function* () {
      const denial = yield* Effect.flip(
        memoryAccessPermit(
          {
            readOnly: true,
            grantedScopes: ["memory:write"],
            reauthorize: () => Effect.void,
          },
          "write",
        ),
      );
      expect(denial.message).toBe("Memory access denied.");
      yield* memoryAccessPermit(
        { readOnly: false, grantedScopes: ["memory:write"], reauthorize: () => Effect.void },
        "write",
      );
    }),
  );
});
