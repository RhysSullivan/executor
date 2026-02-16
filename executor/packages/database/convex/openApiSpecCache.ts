import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Look up a cached OpenAPI spec by URL and cache version.
 * Returns the storageId + createdAt if found and not expired, null otherwise.
 */
export const getEntry = internalQuery({
  args: {
    specUrl: v.string(),
    version: v.string(),
    maxAgeMs: v.number(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("openApiSpecCache")
      .withIndex("by_spec_url_version", (q) =>
        q.eq("specUrl", args.specUrl).eq("version", args.version),
      )
      .unique();

    if (!entry) return null;

    const age = Date.now() - entry.createdAt;
    if (age > args.maxAgeMs) return null;

    return {
      storageId: entry.storageId,
      sizeBytes: entry.sizeBytes,
      createdAt: entry.createdAt,
    };
  },
});

/**
 * Write (or replace) a cache entry for a spec URL.
 * If an older entry exists, its storage blob is deleted.
 */
export const putEntry = internalMutation({
  args: {
    specUrl: v.string(),
    version: v.string(),
    storageId: v.id("_storage"),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("openApiSpecCache")
      .withIndex("by_spec_url_version", (q) =>
        q.eq("specUrl", args.specUrl).eq("version", args.version),
      )
      .unique();

    if (existing) {
      // Delete old blob (ignore if already deleted by a concurrent mutation)
      await ctx.storage.delete(existing.storageId).catch(() => {});
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("openApiSpecCache", {
      specUrl: args.specUrl,
      storageId: args.storageId,
      version: args.version,
      sizeBytes: args.sizeBytes,
      createdAt: Date.now(),
    });
  },
});
