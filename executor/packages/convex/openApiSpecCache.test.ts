import { expect, test, describe } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

function setup() {
  return convexTest(schema, {
    "./openApiSpecCache.ts": () => import("./openApiSpecCache"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });
}

describe("openApiSpecCache table operations", () => {
  test("getEntry returns null on empty cache", async () => {
    const t = setup();

    const result = await t.query(internal.openApiSpecCache.getEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v2",
      maxAgeMs: 5 * 60 * 60_000,
    });

    expect(result).toBeNull();
  });

  test("putEntry stores and getEntry retrieves", async () => {
    const t = setup();

    // Store a blob using the run() escape hatch for storage access
    const storageId = await t.run(async (ctx) => {
      const blob = new Blob(['{"servers":[],"paths":{},"warnings":[]}'], {
        type: "application/json",
      });
      return await ctx.storage.store(blob);
    });

    await t.mutation(internal.openApiSpecCache.putEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v2",
      storageId,
      sizeBytes: 40,
    });

    const entry = await t.query(internal.openApiSpecCache.getEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v2",
      maxAgeMs: 5 * 60 * 60_000,
    });

    expect(entry).not.toBeNull();
    expect(entry!.storageId).toBe(storageId);
    expect(entry!.sizeBytes).toBe(40);
    expect(typeof entry!.createdAt).toBe("number");
  });

  test("getEntry returns null for wrong version", async () => {
    const t = setup();

    const storageId = await t.run(async (ctx) => {
      const blob = new Blob(["{}"], { type: "application/json" });
      return await ctx.storage.store(blob);
    });

    await t.mutation(internal.openApiSpecCache.putEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v1",
      storageId,
      sizeBytes: 2,
    });

    const result = await t.query(internal.openApiSpecCache.getEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v2",
      maxAgeMs: 5 * 60 * 60_000,
    });

    expect(result).toBeNull();
  });

  test("getEntry returns null for expired entry", async () => {
    const t = setup();

    const storageId = await t.run(async (ctx) => {
      const blob = new Blob(["{}"], { type: "application/json" });
      return await ctx.storage.store(blob);
    });

    await t.mutation(internal.openApiSpecCache.putEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v2",
      storageId,
      sizeBytes: 2,
    });

    // Wait a tiny bit so the entry is guaranteed to be older than 1ms
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Ask for entries younger than 1ms — everything should be expired
    const result = await t.query(internal.openApiSpecCache.getEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v2",
      maxAgeMs: 1,
    });

    expect(result).toBeNull();
  });

  test("putEntry replaces existing entry for same specUrl+version", async () => {
    const t = setup();

    const storageId1 = await t.run(async (ctx) => {
      const blob = new Blob(['{"version":1}'], { type: "application/json" });
      return await ctx.storage.store(blob);
    });

    await t.mutation(internal.openApiSpecCache.putEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v2",
      storageId: storageId1,
      sizeBytes: 14,
    });

    const storageId2 = await t.run(async (ctx) => {
      const blob = new Blob(['{"version":2}'], { type: "application/json" });
      return await ctx.storage.store(blob);
    });

    await t.mutation(internal.openApiSpecCache.putEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v2",
      storageId: storageId2,
      sizeBytes: 14,
    });

    const entry = await t.query(internal.openApiSpecCache.getEntry, {
      specUrl: "https://example.com/spec.yaml",
      version: "v2",
      maxAgeMs: 5 * 60 * 60_000,
    });

    expect(entry).not.toBeNull();
    expect(entry!.storageId).toBe(storageId2);

    // Old blob should be deleted
    const oldBlob = await t.run(async (ctx) => {
      return await ctx.storage.get(storageId1);
    });
    expect(oldBlob).toBeNull();
  });

  test("different specUrls have independent cache entries", async () => {
    const t = setup();

    const storageIdA = await t.run(async (ctx) => {
      const blob = new Blob(['{"source":"a"}'], { type: "application/json" });
      return await ctx.storage.store(blob);
    });

    const storageIdB = await t.run(async (ctx) => {
      const blob = new Blob(['{"source":"b"}'], { type: "application/json" });
      return await ctx.storage.store(blob);
    });

    await t.mutation(internal.openApiSpecCache.putEntry, {
      specUrl: "https://api.stripe.com/spec.yaml",
      version: "v2",
      storageId: storageIdA,
      sizeBytes: 14,
    });

    await t.mutation(internal.openApiSpecCache.putEntry, {
      specUrl: "https://api.github.com/spec.yaml",
      version: "v2",
      storageId: storageIdB,
      sizeBytes: 14,
    });

    const entryA = await t.query(internal.openApiSpecCache.getEntry, {
      specUrl: "https://api.stripe.com/spec.yaml",
      version: "v2",
      maxAgeMs: 5 * 60 * 60_000,
    });

    const entryB = await t.query(internal.openApiSpecCache.getEntry, {
      specUrl: "https://api.github.com/spec.yaml",
      version: "v2",
      maxAgeMs: 5 * 60 * 60_000,
    });

    expect(entryA!.storageId).toBe(storageIdA);
    expect(entryB!.storageId).toBe(storageIdB);
  });
});
