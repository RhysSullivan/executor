import { describe, expect, it } from "@effect/vitest";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import { wrapD1WithR2Offload } from "./r2-blob-offload";

// ---------------------------------------------------------------------------
// Round-trip tests for the D1 -> R2 large-value offload. Minimal in-memory
// mocks for the D1 binding (captures the params actually bound; returns canned
// rows on read) and R2 (a Map). Exercises the public D1 surface the wrapper
// presents to drizzle: prepare -> bind -> run/all.
// ---------------------------------------------------------------------------

const makeMemR2 = () => {
  const store = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, value: ArrayBuffer | ArrayBufferView | string) => {
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      store.set(key, bytes);
    },
    get: async (key: string) => {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => new TextDecoder().decode(bytes),
      };
    },
  };
  // oxlint-disable-next-line executor/no-double-cast -- test mock: in-memory stand-in for the R2 binding
  return { bucket: bucket as unknown as R2Bucket, store };
};

// A fake D1 that records the params bound to the most recent statement and, on
// read, returns whatever rows the test stages.
const makeMockD1 = () => {
  const state: { boundParams: unknown[]; rows: Record<string, unknown>[] } = {
    boundParams: [],
    rows: [],
  };
  const db = {
    prepare: (_sql: string) => {
      const stmt: Record<string, unknown> = {
        bind: (...params: unknown[]) => {
          state.boundParams = params;
          return stmt;
        },
        run: async () => ({ success: true, meta: {}, results: state.rows }),
        all: async () => ({ success: true, meta: {}, results: state.rows }),
        first: async () => state.rows[0] ?? null,
        raw: async () => state.rows.map((r) => Object.values(r)),
      };
      return stmt;
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  };
  // oxlint-disable-next-line executor/no-double-cast -- test mock: in-memory stand-in for the D1 binding
  return { db: db as unknown as D1Database, state };
};

const big = "x".repeat(1_000_000); // > 800KB byte threshold

describe("wrapD1WithR2Offload", () => {
  it("offloads an oversized string param to R2 and binds a short pointer", async () => {
    const r2 = makeMemR2();
    const mock = makeMockD1();
    const wrapped = wrapD1WithR2Offload(mock.db, r2.bucket);

    await wrapped.prepare("insert into t (a, b) values (?, ?)").bind("small", big).run();

    expect(mock.state.boundParams[0]).toBe("small"); // small value untouched
    const pointer = mock.state.boundParams[1];
    expect(typeof pointer).toBe("string");
    expect(pointer).not.toBe(big);
    expect(String(pointer).length).toBeLessThan(200); // a short pointer, not 1MB
    expect(r2.store.size).toBe(1); // exactly one blob written
  });

  it("leaves small params inline (no R2 write)", async () => {
    const r2 = makeMemR2();
    const mock = makeMockD1();
    const wrapped = wrapD1WithR2Offload(mock.db, r2.bucket);

    await wrapped.prepare("insert into t (a) values (?)").bind("just small").run();

    expect(mock.state.boundParams).toEqual(["just small"]);
    expect(r2.store.size).toBe(0);
  });

  it("rehydrates a pointer back to the original value on read", async () => {
    const r2 = makeMemR2();
    const mock = makeMockD1();
    const wrapped = wrapD1WithR2Offload(mock.db, r2.bucket);

    // Write to populate R2 + capture the pointer the column would store.
    await wrapped.prepare("insert into t (b) values (?)").bind(big).run();
    const pointer = mock.state.boundParams[0];

    // Now a read returns that pointer in the row; the wrapper must restore `big`.
    mock.state.rows = [{ b: pointer }];
    const result = await wrapped.prepare("select b from t").all();

    expect(result.results[0]!.b).toBe(big);
  });

  it("fails loud when an offloaded blob is missing (no silent corruption)", async () => {
    const r2 = makeMemR2();
    const mock = makeMockD1();
    const wrapped = wrapD1WithR2Offload(mock.db, r2.bucket);

    // Write to mint a real pointer, then simulate R2 losing the object.
    await wrapped.prepare("insert into t (b) values (?)").bind(big).run();
    const pointer = mock.state.boundParams[0];
    r2.store.clear();

    mock.state.rows = [{ b: pointer }];
    await expect(wrapped.prepare("select b from t").all()).rejects.toThrow(/R2 blob lost/);
  });
});
