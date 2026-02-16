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

    return {
      isFresh: entry.signature === args.signature,
      storageId: entry.storageId,
      typesStorageId: entry.typesStorageId,
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
    typesStorageId: v.optional(v.id("_storage")),
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
      if (existing.typesStorageId) {
        await ctx.storage.delete(existing.typesStorageId).catch(() => {});
      }
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("workspaceToolCache", {
      workspaceId: args.workspaceId,
      signature: args.signature,
      storageId: args.storageId,
      typesStorageId: args.typesStorageId,
      toolCount: args.toolCount,
      sizeBytes: args.sizeBytes,
      createdAt: Date.now(),
    });
  },
});
