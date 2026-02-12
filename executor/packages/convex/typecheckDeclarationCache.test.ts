import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

function setup() {
  return convexTest(schema, {
    "./typecheckDeclarationCache.ts": () => import("./typecheckDeclarationCache"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });
}

describe("typecheckDeclarationCache table operations", () => {
  test("getEntry returns null for empty cache", async () => {
    const t = setup();
    const workspaceId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        slug: "org",
        name: "Org",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("workspaces", {
        organizationId: orgId,
        slug: "ws",
        name: "Workspace",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const result = await t.query(internal.typecheckDeclarationCache.getEntry, {
      workspaceId,
      cacheKey: "cache:a",
      maxAgeMs: 10_000,
    });

    expect(result).toBeNull();
  });

  test("putEntry stores and getEntry retrieves", async () => {
    const t = setup();
    const workspaceId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        slug: "org2",
        name: "Org 2",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("workspaces", {
        organizationId: orgId,
        slug: "ws2",
        name: "Workspace 2",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["declare const tools: {};"], { type: "text/plain" }));
    });

    await t.mutation(internal.typecheckDeclarationCache.putEntry, {
      workspaceId,
      cacheKey: "cache:b",
      storageId,
      sizeBytes: 24,
    });

    const entry = await t.query(internal.typecheckDeclarationCache.getEntry, {
      workspaceId,
      cacheKey: "cache:b",
      maxAgeMs: 10_000,
    });

    expect(entry).not.toBeNull();
    expect(entry!.storageId).toBe(storageId);
    expect(entry!.sizeBytes).toBe(24);
  });

  test("putEntry replaces existing key and deletes stale blob", async () => {
    const t = setup();
    const workspaceId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        slug: "org3",
        name: "Org 3",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("workspaces", {
        organizationId: orgId,
        slug: "ws3",
        name: "Workspace 3",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const firstStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["first"], { type: "text/plain" }));
    });

    await t.mutation(internal.typecheckDeclarationCache.putEntry, {
      workspaceId,
      cacheKey: "cache:c",
      storageId: firstStorageId,
      sizeBytes: 5,
    });

    const secondStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["second"], { type: "text/plain" }));
    });

    await t.mutation(internal.typecheckDeclarationCache.putEntry, {
      workspaceId,
      cacheKey: "cache:c",
      storageId: secondStorageId,
      sizeBytes: 6,
    });

    const entry = await t.query(internal.typecheckDeclarationCache.getEntry, {
      workspaceId,
      cacheKey: "cache:c",
      maxAgeMs: 10_000,
    });
    expect(entry!.storageId).toBe(secondStorageId);

    const staleBlob = await t.run(async (ctx) => await ctx.storage.get(firstStorageId));
    expect(staleBlob).toBeNull();
  });

  test("putEntry prunes old rows when maxEntriesPerWorkspace is set", async () => {
    const t = setup();
    const workspaceId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        slug: "org4",
        name: "Org 4",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("workspaces", {
        organizationId: orgId,
        slug: "ws4",
        name: "Workspace 4",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    for (const key of ["cache:1", "cache:2", "cache:3"]) {
      const storageId = await t.run(async (ctx) => {
        return await ctx.storage.store(new Blob([key], { type: "text/plain" }));
      });
      await t.mutation(internal.typecheckDeclarationCache.putEntry, {
        workspaceId,
        cacheKey: key,
        storageId,
        sizeBytes: key.length,
        maxEntriesPerWorkspace: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const oldest = await t.query(internal.typecheckDeclarationCache.getEntry, {
      workspaceId,
      cacheKey: "cache:1",
      maxAgeMs: 10_000,
    });
    const newestA = await t.query(internal.typecheckDeclarationCache.getEntry, {
      workspaceId,
      cacheKey: "cache:2",
      maxAgeMs: 10_000,
    });
    const newestB = await t.query(internal.typecheckDeclarationCache.getEntry, {
      workspaceId,
      cacheKey: "cache:3",
      maxAgeMs: 10_000,
    });

    expect(oldest).toBeNull();
    expect(newestA).not.toBeNull();
    expect(newestB).not.toBeNull();
  });
});
