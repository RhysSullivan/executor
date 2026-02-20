import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { vv } from "./typedV";

export const getState = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("workspaceToolRegistryState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    if (!entry) return null;

    const stateEntry = entry as Record<string, unknown>;
    const sourceStates = Array.isArray(stateEntry.sourceStates)
      ? stateEntry.sourceStates.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
      : [];

    return {
      signature: entry.signature,
      lastRefreshCompletedAt: entry.lastRefreshCompletedAt,
      lastRefreshFailedAt: entry.lastRefreshFailedAt,
      lastRefreshError: entry.lastRefreshError,
      typesStorageId: entry.typesStorageId,
      warnings: entry.warnings ?? [],
      toolCount: entry.toolCount,
      sourceToolCounts: entry.sourceToolCounts ?? [],
      sourceStates,
      sourceQuality: entry.sourceQuality ?? [],
      sourceAuthProfiles: entry.sourceAuthProfiles ?? [],
      openApiRefHintTables: Array.isArray(stateEntry.openApiRefHintTables) ? stateEntry.openApiRefHintTables : [],
      updatedAt: entry.updatedAt,
    };
  },
});

export const putToolsBatch = internalMutation({
  args: {
    workspaceId: vv.id("workspaces"),
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
      // Enforce a single active row per tool path for the workspace.
      while (true) {
        const existingEntries = await ctx.db
          .query("workspaceToolRegistry")
          .withIndex("by_workspace_path", (q) =>
            q.eq("workspaceId", args.workspaceId).eq("path", tool.path),
          )
          .take(20);

        if (existingEntries.length === 0) {
          break;
        }

        for (const entry of existingEntries) {
          await ctx.db.delete(entry._id);
        }
      }

      while (true) {
        const existingPayloads = await ctx.db
          .query("workspaceToolRegistryPayloads")
          .withIndex("by_workspace_path", (q) =>
            q.eq("workspaceId", args.workspaceId).eq("path", tool.path),
          )
          .take(20);

        if (existingPayloads.length === 0) {
          break;
        }

        for (const payload of existingPayloads) {
          await ctx.db.delete(payload._id);
        }
      }

      await ctx.db.insert("workspaceToolRegistry", {
        workspaceId: args.workspaceId,
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
        createdAt: now,
      });

      await ctx.db.insert("workspaceToolRegistryPayloads", {
        workspaceId: args.workspaceId,
        path: tool.path,
        serializedToolJson: tool.serializedToolJson,
        createdAt: now,
      });
    }
  },
});

export const putNamespacesBatch = internalMutation({
  args: {
    workspaceId: vv.id("workspaces"),
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
        namespace: ns.namespace,
        toolCount: ns.toolCount,
        samplePaths: ns.samplePaths,
        createdAt: now,
      });
    }
  },
});

export const updateRegistryMetadata = internalMutation({
  args: {
    workspaceId: vv.id("workspaces"),
    typesStorageId: v.optional(v.id("_storage")),
    warnings: v.array(v.string()),
    toolCount: v.number(),
    sourceToolCounts: v.array(v.object({
      sourceName: v.string(),
      toolCount: v.number(),
    })),
    sourceQuality: v.array(v.object({
      sourceKey: v.string(),
      toolCount: v.number(),
      unknownArgsCount: v.number(),
      unknownReturnsCount: v.number(),
      partialUnknownArgsCount: v.number(),
      partialUnknownReturnsCount: v.number(),
      argsQuality: v.number(),
      returnsQuality: v.number(),
      overallQuality: v.number(),
    })),
    sourceAuthProfiles: v.array(v.object({
      sourceKey: v.string(),
      type: v.union(v.literal("none"), v.literal("bearer"), v.literal("apiKey"), v.literal("basic"), v.literal("mixed")),
      mode: v.optional(v.union(v.literal("account"), v.literal("organization"), v.literal("workspace"))),
      header: v.optional(v.string()),
      inferred: v.boolean(),
    })),
    openApiRefHintTables: v.optional(v.array(v.object({
      sourceKey: v.string(),
      refs: v.array(v.object({
        key: v.string(),
        hint: v.string(),
      })),
    }))),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("workspaceToolRegistryState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (!state) {
      await ctx.db.insert("workspaceToolRegistryState", {
        workspaceId: args.workspaceId,
        signature: undefined,
        lastRefreshCompletedAt: Date.now(),
        lastRefreshFailedAt: undefined,
        lastRefreshError: undefined,
        typesStorageId: args.typesStorageId,
        warnings: args.warnings,
        toolCount: args.toolCount,
        sourceToolCounts: args.sourceToolCounts,
        sourceStates: [],
        sourceQuality: args.sourceQuality,
        sourceAuthProfiles: args.sourceAuthProfiles,
        openApiRefHintTables: args.openApiRefHintTables,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
      return;
    }

    await ctx.db.patch(state._id, {
      typesStorageId: args.typesStorageId,
      warnings: args.warnings,
      toolCount: args.toolCount,
      sourceToolCounts: args.sourceToolCounts,
      sourceQuality: args.sourceQuality,
      sourceAuthProfiles: args.sourceAuthProfiles,
      openApiRefHintTables: args.openApiRefHintTables,
      lastRefreshCompletedAt: Date.now(),
      lastRefreshError: undefined,
      updatedAt: Date.now(),
    } as never);
  },
});

const sourceStateValidator = v.any();

export const setSourceStates = internalMutation({
  args: {
    workspaceId: vv.id("workspaces"),
    sourceStates: v.array(sourceStateValidator),
    signature: v.optional(v.string()),
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
        signature: args.signature,
        lastRefreshCompletedAt: undefined,
        lastRefreshFailedAt: undefined,
        lastRefreshError: undefined,
        typesStorageId: undefined,
        warnings: [],
        toolCount: 0,
        sourceToolCounts: [],
        sourceStates: args.sourceStates,
        sourceQuality: [],
        sourceAuthProfiles: [],
        openApiRefHintTables: [],
        createdAt: now,
        updatedAt: now,
      } as never);
      return;
    }

    await ctx.db.patch(state._id, {
      ...(args.signature ? { signature: args.signature } : {}),
      sourceStates: args.sourceStates,
      updatedAt: now,
    });
  },
});

export const setRefreshError = internalMutation({
  args: {
    workspaceId: vv.id("workspaces"),
    error: v.string(),
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
        signature: undefined,
        lastRefreshCompletedAt: undefined,
        lastRefreshFailedAt: now,
        lastRefreshError: args.error,
        typesStorageId: undefined,
        warnings: [],
        toolCount: 0,
        sourceToolCounts: [],
        sourceStates: [],
        sourceQuality: [],
        sourceAuthProfiles: [],
        openApiRefHintTables: [],
        createdAt: now,
        updatedAt: now,
      } as never);
      return;
    }

    await ctx.db.patch(state._id, {
      lastRefreshFailedAt: now,
      lastRefreshError: args.error,
      updatedAt: now,
    });
  },
});

export const deleteToolsBySourcePage = internalMutation({
  args: {
    workspaceId: vv.id("workspaces"),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const source = args.source.trim();
    if (!source) {
      return { removed: 0 };
    }

    const PAGE_SIZE = 100;
    let removed = 0;

    const entries = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace_source", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("source", source),
      )
      .take(PAGE_SIZE);

    for (const entry of entries) {
      await ctx.db.delete(entry._id);
      removed += 1;

      // Payload table is keyed by path; delete all matching payload rows in small slices.
      while (true) {
        const payloads = await ctx.db
          .query("workspaceToolRegistryPayloads")
          .withIndex("by_workspace_path", (q) =>
            q.eq("workspaceId", args.workspaceId).eq("path", entry.path),
          )
          .take(20);

        if (payloads.length === 0) {
          break;
        }

        for (const payload of payloads) {
          await ctx.db.delete(payload._id);
        }
      }
    }

    return {
      removed,
      hasMore: entries.length >= PAGE_SIZE,
    };
  },
});

export const deleteToolsBySource = internalAction({
  args: {
    workspaceId: vv.id("workspaces"),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    let removed = 0;

    while (true) {
      const page: { removed: number; hasMore: boolean } = await ctx.runMutation(
        internal.toolRegistry.deleteToolsBySourcePage,
        {
          workspaceId: args.workspaceId,
          source: args.source,
        },
      );

      removed += page.removed;
      if (!page.hasMore || page.removed === 0) {
        break;
      }
    }

    return { removed };
  },
});

export const listSerializedToolsPage = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
    cursor: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(250, Math.floor(args.limit)));
    const page = await ctx.db
      .query("workspaceToolRegistryPayloads")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .paginate({
        numItems: limit,
        cursor: args.cursor ?? null,
      });

    return {
      continueCursor: page.isDone ? null : page.continueCursor,
      items: page.page.map((entry) => ({
        path: entry.path,
        serializedToolJson: entry.serializedToolJson,
      })),
    };
  },
});

export const deleteToolRegistryNamespacesPage = internalMutation({
  args: {
    workspaceId: vv.id("workspaces"),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("workspaceToolNamespaces")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .paginate({ numItems: 100, cursor: args.cursor ?? null });

    for (const entry of page.page) {
      await ctx.db.delete(entry._id);
    }

    return { continueCursor: page.isDone ? null : page.continueCursor };
  },
});

export const getToolByPath = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace_path", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("path", args.path),
      )
      .first();

    if (!entry) return null;

    const payload = await ctx.db
      .query("workspaceToolRegistryPayloads")
      .withIndex("by_workspace_path", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("path", entry.path),
      )
      .first();

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
      typedRef: entry.typedRef,
      serializedToolJson: payload?.serializedToolJson,
    };
  },
});

export const getSerializedToolsByPaths = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
    paths: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const paths = [...new Set(args.paths.map((path) => path.trim()).filter((path) => path.length > 0))]
      .slice(0, 500);
    if (paths.length === 0) {
      return [] as Array<{ path: string; serializedToolJson: string }>;
    }

    const payloads = await Promise.all(paths.map(async (path) => {
      const payload = await ctx.db
        .query("workspaceToolRegistryPayloads")
        .withIndex("by_workspace_path", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("path", path),
        )
        .first();

      if (!payload) return null;
      return {
        path: payload.path,
        serializedToolJson: payload.serializedToolJson,
      };
    }));

    return payloads.filter((entry): entry is { path: string; serializedToolJson: string } => Boolean(entry));
  },
});

export const listToolsByNamespace = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
    namespace: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const namespace = args.namespace.trim().toLowerCase();
    const limit = Math.max(1, Math.min(20_000, Math.floor(args.limit)));
    if (!namespace) return [];

    const entries = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace_namespace", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("namespace", namespace),
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
      typedRef: entry.typedRef,
    }));
  },
});

export const listToolsPage = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
    cursor: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(250, Math.floor(args.limit)));
    const page = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .paginate({
        numItems: limit,
        cursor: args.cursor ?? null,
      });

    return {
      continueCursor: page.isDone ? null : page.continueCursor,
      items: page.page.map((entry) => ({
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
        typedRef: entry.typedRef,
      })),
    };
  },
});

export const listToolsBySourcePage = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
    source: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const source = args.source.trim();
    if (!source) {
      return {
        continueCursor: null,
        items: [] as Array<{
          path: string;
          preferredPath: string;
          aliases: string[];
          description: string;
          approval: "auto" | "required";
          source?: string;
          displayInput?: string;
          displayOutput?: string;
          requiredInputKeys?: string[];
          previewInputKeys?: string[];
          typedRef?: {
            kind: "openapi_operation";
            sourceKey: string;
            operationId: string;
          };
        }>,
      };
    }

    const limit = Math.max(1, Math.min(250, Math.floor(args.limit)));
    const page = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace_source", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("source", source),
      )
      .paginate({
        numItems: limit,
        cursor: args.cursor ?? null,
      });

    return {
      continueCursor: page.isDone ? null : page.continueCursor,
      items: page.page.map((entry) => ({
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
        typedRef: entry.typedRef,
      })),
    };
  },
});

export const getToolsByNormalizedPath = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
    normalizedPath: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const normalized = args.normalizedPath.trim().toLowerCase();
    if (!normalized) return [];
    const limit = Math.max(1, Math.min(10, Math.floor(args.limit)));

    const entries = await ctx.db
      .query("workspaceToolRegistry")
      .withIndex("by_workspace_normalized", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("normalizedPath", normalized),
      )
      .take(limit);

    const payloads = await Promise.all(entries.map(async (entry) => {
      const payload = await ctx.db
        .query("workspaceToolRegistryPayloads")
        .withIndex("by_workspace_path", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("path", entry.path),
        )
        .first();
      if (!payload) return null;
      return {
        path: entry.path,
        preferredPath: entry.preferredPath,
        approval: entry.approval,
        serializedToolJson: payload.serializedToolJson,
      };
    }));

    return payloads.filter((entry): entry is {
      path: string;
      preferredPath: string;
      approval: "auto" | "required";
      serializedToolJson: string;
    } => Boolean(entry));
  },
});

export const searchTools = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
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
          .eq("workspaceId", args.workspaceId),
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
      typedRef: entry.typedRef,
    }));
  },
});

export const listNamespaces = internalQuery({
  args: {
    workspaceId: vv.id("workspaces"),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit)));
    const entries = await ctx.db
      .query("workspaceToolNamespaces")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(limit);

    return entries.map((entry) => ({
      namespace: entry.namespace,
      toolCount: entry.toolCount,
      samplePaths: entry.samplePaths,
    }));
  },
});
