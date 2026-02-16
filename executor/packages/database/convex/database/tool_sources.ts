import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import {
  computeSourceSpecHash,
  mapSource,
  normalizeSourceAuthFingerprint,
} from "../../src/database/mappers";
import { toolSourceTypeValidator } from "../../src/database/validators";
import { asRecord } from "../../src/lib/object";

export const upsertToolSource = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    name: v.string(),
    type: toolSourceTypeValidator,
    config: v.any(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const sourceId = args.id ?? `src_${crypto.randomUUID()}`;
    const config = asRecord(args.config);
    const specHash = computeSourceSpecHash(args.type, config);
    const authFingerprint = normalizeSourceAuthFingerprint(config.auth);
    const [existing, conflict] = await Promise.all([
      ctx.db
        .query("toolSources")
        .withIndex("by_source_id", (q) => q.eq("sourceId", sourceId))
        .unique(),
      ctx.db
        .query("toolSources")
        .withIndex("by_workspace_name", (q) => q.eq("workspaceId", args.workspaceId).eq("name", args.name))
        .unique(),
    ]);

    if (conflict && conflict.sourceId !== sourceId) {
      throw new Error(`Tool source name '${args.name}' already exists in workspace ${args.workspaceId}`);
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        workspaceId: args.workspaceId,
        name: args.name,
        type: args.type,
        config,
        specHash,
        authFingerprint,
        enabled: args.enabled !== false,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("toolSources", {
        sourceId,
        workspaceId: args.workspaceId,
        name: args.name,
        type: args.type,
        config,
        specHash,
        authFingerprint,
        enabled: args.enabled !== false,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updated = await ctx.db
      .query("toolSources")
      .withIndex("by_source_id", (q) => q.eq("sourceId", sourceId))
      .unique();
    if (!updated) {
      throw new Error(`Failed to read tool source ${sourceId}`);
    }
    return mapSource(updated);
  },
});

export const listToolSources = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("toolSources")
      .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .collect();
    return docs.map(mapSource);
  },
});

export const deleteToolSource = internalMutation({
  args: { workspaceId: v.id("workspaces"), sourceId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("toolSources")
      .withIndex("by_source_id", (q) => q.eq("sourceId", args.sourceId))
      .unique();

    if (!doc || doc.workspaceId !== args.workspaceId) {
      return false;
    }

    const sourceKey = `source:${args.sourceId}`;
    const bindings = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_source_scope_actor", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("sourceKey", sourceKey),
      )
      .collect();

    for (const binding of bindings) {
      await ctx.db.delete(binding._id);
    }

    await ctx.db.delete(doc._id);
    return true;
  },
});
