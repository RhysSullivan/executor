import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const getState = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("workspaceToolRegistryState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    if (!entry) return null;

    return {
      signature: entry.signature,
      readyBuildId: entry.readyBuildId,
      buildingBuildId: entry.buildingBuildId,
      updatedAt: entry.updatedAt,
    };
  },
});

export const beginBuild = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    signature: v.string(),
    buildId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("workspaceToolRegistryState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        signature: args.signature,
        buildingBuildId: args.buildId,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("workspaceToolRegistryState", {
      workspaceId: args.workspaceId,
      signature: args.signature,
      readyBuildId: undefined,
      buildingBuildId: args.buildId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const putToolsBatch = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    tools: v.array(
      v.object({
        path: v.string(),
        preferredPath: v.string(),
        namespace: v.string(),
        normalizedPath: v.string(),
        aliases: v.array(v.string()),
        description: v.string(),
        approval: v.union(v.literal("auto"), v.literal("required")),
        source: v.optional(v.string()),
        searchText: v.string(),
        displayInput: v.optional(v.string()),
        displayOutput: v.optional(v.string()),
        requiredInputKeys: v.optional(v.array(v.string())),
        previewInputKeys: v.optional(v.array(v.string())),
        typedRef: v.optional(
          v.object({
            kind: v.literal("openapi_operation"),
            sourceKey: v.string(),
            operationId: v.string(),
          }),
        ),
        serializedToolJson: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const tool of args.tools) {
      await ctx.db.insert("workspaceToolRegistry", {
        workspaceId: args.workspaceId,
        buildId: args.buildId,
        path: tool.path,
        preferredPath: tool.preferredPath,
        namespace: tool.namespace,
        normalizedPath: tool.normalizedPath,
        aliases: tool.aliases,
        description: tool.description,
        approval: tool.approval,
        source: tool.source,
        searchText: tool.searchText,
        displayInput: tool.displayInput,
        displayOutput: tool.displayOutput,
        requiredInputKeys: tool.requiredInputKeys,
        previewInputKeys: tool.previewInputKeys,
        typedRef: tool.typedRef,
        serializedToolJson: tool.serializedToolJson,
        createdAt: now,
      });
    }
  },
});

export const putNamespacesBatch = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    namespaces: v.array(
      v.object({
        namespace: v.string(),
        toolCount: v.number(),
        samplePaths: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const ns of args.namespaces) {
      await ctx.db.insert("workspaceToolNamespaces", {
        workspaceId: args.workspaceId,
        buildId: args.buildId,
        namespace: ns.namespace,
        toolCount: ns.toolCount,
        samplePaths: ns.samplePaths,
        createdAt: now,
      });
    }
  },
});

export const finishBuild = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const state = await ctx.db
      .query("workspaceToolRegistryState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    if (!state) {
      await ctx.db.insert("workspaceToolRegistryState", {
        workspaceId: args.workspaceId,
        signature: "",
        readyBuildId: args.buildId,
        buildingBuildId: undefined,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }

    if (state.buildingBuildId !== args.buildId) {
      // Another build started; ignore finishing this one.
      return;
    }

    await ctx.db.patch(state._id, {
      readyBuildId: args.buildId,
      buildingBuildId: undefined,
      updatedAt: now,
    });
  },
});

export const getToolByPath = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace_build_path", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("buildId", args.buildId).eq("path", args.path),
      )
      .first();

    if (!entry) return null;

    return {
      path: entry.path,
      preferredPath: entry.preferredPath,
      approval: entry.approval,
      namespace: entry.namespace,
      aliases: entry.aliases,
      description: entry.description,
      source: entry.source,
      displayInput: entry.displayInput,
      displayOutput: entry.displayOutput,
      requiredInputKeys: entry.requiredInputKeys,
      previewInputKeys: entry.previewInputKeys,
      serializedToolJson: entry.serializedToolJson,
    };
  },
});

export const listToolsByNamespace = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    namespace: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const namespace = args.namespace.trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit)));
    if (!namespace) return [];

    const entries = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace_build_namespace", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("buildId", args.buildId).eq("namespace", namespace),
      )
      .take(limit);

    return entries.map((entry) => ({
      path: entry.path,
      preferredPath: entry.preferredPath,
      aliases: entry.aliases,
      description: entry.description,
      approval: entry.approval,
      source: entry.source,
      displayInput: entry.displayInput,
      displayOutput: entry.displayOutput,
      requiredInputKeys: entry.requiredInputKeys,
      previewInputKeys: entry.previewInputKeys,
    }));
  },
});

export const getToolsByNormalizedPath = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    normalizedPath: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const normalized = args.normalizedPath.trim().toLowerCase();
    if (!normalized) return [];
    const limit = Math.max(1, Math.min(10, Math.floor(args.limit)));

    const entries = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace_build_normalized", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("buildId", args.buildId).eq("normalizedPath", normalized),
      )
      .take(limit);

    return entries.map((entry) => ({
      path: entry.path,
      preferredPath: entry.preferredPath,
      approval: entry.approval,
      serializedToolJson: entry.serializedToolJson,
    }));
  },
});

export const searchTools = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    query: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const term = args.query.trim();
    if (!term) return [];

    const limit = Math.max(1, Math.min(50, Math.floor(args.limit)));
    const hits = await ctx.db
      .query("workspaceToolRegistry")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", term)
          .eq("workspaceId", args.workspaceId)
          .eq("buildId", args.buildId),
      )
      .take(limit);

    return hits.map((entry) => ({
      path: entry.path,
      preferredPath: entry.preferredPath,
      aliases: entry.aliases,
      description: entry.description,
      approval: entry.approval,
      source: entry.source,
      displayInput: entry.displayInput,
      displayOutput: entry.displayOutput,
      requiredInputKeys: entry.requiredInputKeys,
      previewInputKeys: entry.previewInputKeys,
    }));
  },
});

export const listNamespaces = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit)));
    const entries = await ctx.db
      .query("workspaceToolNamespaces")
      .withIndex("by_workspace_build", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("buildId", args.buildId),
      )
      .take(limit);

    return entries.map((entry) => ({
      namespace: entry.namespace,
      toolCount: entry.toolCount,
      samplePaths: entry.samplePaths,
    }));
  },
});
