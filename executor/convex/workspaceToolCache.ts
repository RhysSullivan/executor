import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Look up a cached workspace tool snapshot by workspace ID.
 * Returns the storageId if the signature matches (sources haven't changed).
 */
export const getEntry = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    signature: v.string(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("workspaceToolCache")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    if (!entry) return null;
    if (entry.signature !== args.signature) return null;

    return {
      storageId: entry.storageId,
      dtsStorageIds: entry.dtsStorageIds,
      toolCount: entry.toolCount,
      sizeBytes: entry.sizeBytes,
      createdAt: entry.createdAt,
    };
  },
});

/**
 * Write (or replace) a workspace tool cache entry.
 * Deletes old blobs (main snapshot + .d.ts blobs) if replacing.
 */
export const putEntry = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    signature: v.string(),
    storageId: v.id("_storage"),
    dtsStorageIds: v.array(v.object({
      sourceKey: v.string(),
      storageId: v.id("_storage"),
    })),
    toolCount: v.number(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workspaceToolCache")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    if (existing) {
      // Delete old main snapshot blob
      await ctx.storage.delete(existing.storageId).catch(() => {});
      // Delete old .d.ts blobs
      for (const entry of existing.dtsStorageIds) {
        await ctx.storage.delete(entry.storageId).catch(() => {});
      }
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("workspaceToolCache", {
      workspaceId: args.workspaceId,
      signature: args.signature,
      storageId: args.storageId,
      dtsStorageIds: args.dtsStorageIds,
      toolCount: args.toolCount,
      sizeBytes: args.sizeBytes,
      createdAt: Date.now(),
    });
  },
});

/**
 * Look up .d.ts storage IDs for a workspace (used to generate download URLs).
 */
export const getDtsStorageIds = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("workspaceToolCache")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    if (!entry) return [];
    return entry.dtsStorageIds;
  },
});
