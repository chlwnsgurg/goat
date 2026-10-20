// @effect-diagnostics globalDate:off - The page scripts store native Dates; the test feeds them in.
import { describe, expect, it } from "vite-plus/test";

import { originStorageImportScript, STORAGE_VALUE_CODEC } from "./rendererOriginStorage.ts";

const codec = new Function(`${STORAGE_VALUE_CODEC}; return { encode, decode };`)() as {
  encode: (value: unknown) => Promise<unknown>;
  decode: (value: unknown) => Promise<unknown>;
};
const roundTrip = async (value: unknown) =>
  codec.decode(JSON.parse(JSON.stringify(await codec.encode(value))));

it("imports missing localStorage keys while preserving current values, including empty strings", async () => {
  const items = new Map([
    ["connections", "current-connections"],
    ["dismissed", ""],
    ["current-only", "keep"],
  ]);
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
  const script = originStorageImportScript(
    JSON.stringify({
      localStorage: { connections: "legacy-connections", dismissed: "legacy-value", theme: "dark" },
      databases: [],
      skipped: 0,
    }),
  );
  const run = new Function("localStorage", `return ${script}`) as (
    localStorage: typeof storage,
  ) => Promise<string>;

  expect(JSON.parse(await run(storage))).toEqual({
    localStorageItems: 1,
    databases: 0,
    records: 0,
    skipped: 0,
  });
  expect(Object.fromEntries(items)).toEqual({
    connections: "current-connections",
    dismissed: "",
    "current-only": "keep",
    theme: "dark",
  });
  expect(JSON.parse(await run(storage)).localStorageItems).toBe(0);
});

it.each([null, "id"])(
  "preserves existing IndexedDB records with keyPath=%s and continues importing",
  async (keyPath) => {
    const records = new Map([
      ["shared", { id: "shared", value: "current" }],
      ["current-only", { id: "current-only", value: "keep" }],
    ]);
    type Pending = { onsuccess?: () => void; onerror?: (event: Event) => void };
    // Model IDB's duplicate-key request error and transaction cancellation at the page boundary.
    const indexedDB = {
      open: () => {
        const pending: Pending & { result: unknown } = {
          result: {
            objectStoreNames: { contains: (name: string) => name === "connections" },
            close: () => undefined,
            transaction: () => {
              let outstanding = 0;
              let aborted = false;
              const transaction = {
                oncomplete: undefined as (() => void) | undefined,
                onabort: undefined as (() => void) | undefined,
                objectStore: () => ({
                  keyPath,
                  add: (value: { id: string; value: string }, key?: string) => {
                    const request: Pending = {};
                    outstanding++;
                    queueMicrotask(() => {
                      const recordKey = keyPath === null ? key! : value.id;
                      if (records.has(recordKey)) {
                        const event = new Event("error", { cancelable: true });
                        request.onerror?.(event);
                        if (!event.defaultPrevented) {
                          aborted = true;
                          transaction.onabort?.();
                        }
                      } else {
                        records.set(recordKey, value);
                        request.onsuccess?.();
                      }
                      if (--outstanding === 0 && !aborted) transaction.oncomplete?.();
                    });
                    return request;
                  },
                }),
              };
              return transaction;
            },
          },
        };
        queueMicrotask(() => pending.onsuccess?.());
        return pending;
      },
    };
    const script = originStorageImportScript(
      JSON.stringify({
        localStorage: {},
        skipped: 0,
        databases: [
          {
            name: "app",
            version: 1,
            stores: [
              {
                name: "connections",
                keyPath,
                autoIncrement: false,
                indexes: [],
                records: [
                  ["shared", { id: "shared", value: "legacy" }],
                  ["legacy-only", { id: "legacy-only", value: "imported" }],
                ],
              },
            ],
          },
        ],
      }),
    );
    const run = new Function("indexedDB", `return ${script}`) as (
      database: typeof indexedDB,
    ) => Promise<string>;

    expect(JSON.parse(await run(indexedDB))).toEqual({
      localStorageItems: 0,
      databases: 1,
      records: 1,
      skipped: 0,
    });
    expect(Object.fromEntries(records)).toEqual({
      shared: { id: "shared", value: "current" },
      "current-only": { id: "current-only", value: "keep" },
      "legacy-only": { id: "legacy-only", value: "imported" },
    });
  },
);

describe("renderer origin storage codec", () => {
  it("round-trips structured-clone values through JSON", async () => {
    const value = {
      text: "hi",
      count: 3,
      odd: [Number.NaN, Number.POSITIVE_INFINITY, -0, undefined, null, 10n],
      when: new Date(1_700_000_000_000),
      buffer: new Uint8Array([0, 1, 255]).buffer,
      view: new Float64Array([1.5, -2]),
      map: new Map<unknown, unknown>([["a", new Set([1, 2])]]),
      pattern: /goat/gi,
      // A stored object may use the tag key itself.
      $goat: "not a tag",
    };
    const decoded = (await roundTrip(value)) as typeof value;
    expect(decoded.text).toBe("hi");
    expect(decoded.odd[0]).toBeNaN();
    expect(decoded.odd.slice(1)).toEqual([Number.POSITIVE_INFINITY, -0, undefined, null, 10n]);
    expect(Object.is(decoded.odd[2], -0)).toBe(true);
    expect(decoded.when.getTime()).toBe(1_700_000_000_000);
    expect([...new Uint8Array(decoded.buffer)]).toEqual([0, 1, 255]);
    expect(decoded.view).toBeInstanceOf(Float64Array);
    expect([...decoded.view]).toEqual([1.5, -2]);
    expect(decoded.map.get("a")).toEqual(new Set([1, 2]));
    expect(decoded.pattern.flags).toBe("gi");
    expect(decoded.$goat).toBe("not a tag");
  });

  it("carries an extractable DPoP key that still signs for the same public key", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const decoded = (await roundTrip({ privateKey: pair.privateKey })) as {
      privateKey: CryptoKey;
    };
    expect(decoded.privateKey.usages).toEqual(["sign"]);
    const data = new TextEncoder().encode("proof");
    const algorithm = { name: "ECDSA", hash: "SHA-256" };
    const signature = await crypto.subtle.sign(algorithm, decoded.privateKey, data);
    expect(await crypto.subtle.verify(algorithm, pair.publicKey, signature, data)).toBe(true);
  });

  it("rejects values it cannot carry, so the export skips that record", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    await expect(codec.encode({ key: pair.privateKey })).rejects.toThrow();
    await expect(codec.encode(new URL("goat://app/"))).rejects.toThrow(/Unsupported/);
  });
});
