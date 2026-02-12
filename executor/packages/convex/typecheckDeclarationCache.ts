import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const getEntry = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    cacheKey: v.string(),
    maxAgeMs: v.number(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("typecheckDeclarationCache")
      .withIndex("by_workspace_cache_key", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("cacheKey", args.cacheKey),
      )
      .unique();

    if (!entry) return null;

    const ageMs = Date.now() - entry.createdAt;
    if (ageMs > args.maxAgeMs) return null;

    return {
      storageId: entry.storageId,
      sizeBytes: entry.sizeBytes,
      createdAt: entry.createdAt,
    };
  },
});

export const putEntry = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    cacheKey: v.string(),
    storageId: v.id("_storage"),
    sizeBytes: v.number(),
    maxEntriesPerWorkspace: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("typecheckDeclarationCache")
      .withIndex("by_workspace_cache_key", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("cacheKey", args.cacheKey),
      )
      .unique();

    if (existing) {
      await ctx.storage.delete(existing.storageId).catch(() => {});
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("typecheckDeclarationCache", {
      workspaceId: args.workspaceId,
      cacheKey: args.cacheKey,
      storageId: args.storageId,
      sizeBytes: args.sizeBytes,
      createdAt: Date.now(),
    });

    const maxEntries = Math.max(1, Math.floor(args.maxEntriesPerWorkspace ?? 64));
    const entries = await ctx.db
      .query("typecheckDeclarationCache")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .collect();

    if (entries.length <= maxEntries) {
      return;
    }

    for (const stale of entries.slice(maxEntries)) {
      await ctx.storage.delete(stale.storageId).catch(() => {});
      await ctx.db.delete(stale._id);
    }
  },
});
