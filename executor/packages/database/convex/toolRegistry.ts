import { v } from "convex/values";
import { internal } from "./_generated/api";
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

const PRUNE_DELETE_PAGE_SIZE = 100;
const PRUNE_NAMESPACE_SCAN_PAGE_SIZE = 250;

export const scanNamespaceBuildsForPrune = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("workspaceToolNamespaces")
      .withIndex("by_workspace_build", (q) => q.eq("workspaceId", args.workspaceId))
      .paginate({ numItems: PRUNE_NAMESPACE_SCAN_PAGE_SIZE, cursor: args.cursor ?? null });

    return {
      items: page.page.map((entry) => ({
        buildId: entry.buildId,
        createdAt: entry.createdAt,
      })),
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const deleteToolRegistryToolsPage = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace_build", (q) => q.eq("workspaceId", args.workspaceId).eq("buildId", args.buildId))
      .paginate({ numItems: PRUNE_DELETE_PAGE_SIZE, cursor: args.cursor ?? null });

    for (const entry of page.page) {
      await ctx.db.delete(entry._id);
    }

    return { continueCursor: page.isDone ? null : page.continueCursor };
  },
});

export const deleteToolRegistryNamespacesPage = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("workspaceToolNamespaces")
      .withIndex("by_workspace_build", (q) => q.eq("workspaceId", args.workspaceId).eq("buildId", args.buildId))
      .paginate({ numItems: PRUNE_DELETE_PAGE_SIZE, cursor: args.cursor ?? null });

    for (const entry of page.page) {
      await ctx.db.delete(entry._id);
    }

    return { continueCursor: page.isDone ? null : page.continueCursor };
  },
});

export const pruneBuilds = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    maxRetainedBuilds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const maxRetainedBuilds = Math.max(1, Math.min(10, Math.floor(args.maxRetainedBuilds ?? 2)));
    const state = await ctx.db
      .query("workspaceToolRegistryState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    const protectedBuildIds = new Set<string>();
    if (state?.readyBuildId) protectedBuildIds.add(state.readyBuildId);
    if (state?.buildingBuildId) protectedBuildIds.add(state.buildingBuildId);

    const latestCreatedAtByBuild = new Map<string, number>();
    let namespaceCursor: string | undefined = undefined;

    while (true) {
      const namespacePage: {
        continueCursor: string | null;
        items: Array<{ buildId: string; createdAt: number }>;
      } = await ctx.runMutation(internal.toolRegistry.scanNamespaceBuildsForPrune, {
        workspaceId: args.workspaceId,
        cursor: namespaceCursor,
      });

      for (const item of namespacePage.items) {
        const current = latestCreatedAtByBuild.get(item.buildId) ?? 0;
        if (item.createdAt > current) {
          latestCreatedAtByBuild.set(item.buildId, item.createdAt);
        }
      }

      if (namespacePage.continueCursor === null) {
        break;
      }

      namespaceCursor = namespacePage.continueCursor;
    }

    const buildIdsByRecency = [...latestCreatedAtByBuild.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([buildId]) => buildId);

    const retained = new Set<string>(buildIdsByRecency.slice(0, maxRetainedBuilds));
    for (const protectedBuildId of protectedBuildIds) {
      retained.add(protectedBuildId);
    }

    for (const buildId of buildIdsByRecency) {
      if (retained.has(buildId)) {
        continue;
      }

      let cursor: string | undefined = undefined;
      while (true) {
        const page: { continueCursor: string | null } = await ctx.runMutation(
          internal.toolRegistry.deleteToolRegistryToolsPage,
          {
            workspaceId: args.workspaceId,
            buildId,
            cursor,
          },
        );

        if (page.continueCursor === null) {
          break;
        }

        cursor = page.continueCursor;
      }

      let namespacePageCursor: string | undefined = undefined;
      while (true) {
        const namespaceDeletePage: { continueCursor: string | null } = await ctx.runMutation(
          internal.toolRegistry.deleteToolRegistryNamespacesPage,
          {
            workspaceId: args.workspaceId,
            buildId,
            cursor: namespacePageCursor,
          },
        );

        if (namespaceDeletePage.continueCursor === null) {
          break;
        }

        namespacePageCursor = namespaceDeletePage.continueCursor;
      }
    }
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
