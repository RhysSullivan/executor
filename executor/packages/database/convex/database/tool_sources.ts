import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  computeSourceSpecHash,
  mapSource,
  normalizeSourceAuthFingerprint,
} from "../../src/database/mappers";
import { normalizeToolSourceConfig } from "../../src/database/tool_source_config";
import { safeRunAfter } from "../../src/lib/scheduler";
import { jsonObjectValidator, toolSourceScopeTypeValidator, toolSourceTypeValidator } from "../../src/database/validators";

export const upsertToolSource = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    scopeType: v.optional(toolSourceScopeTypeValidator),
    name: v.string(),
    type: toolSourceTypeValidator,
    config: jsonObjectValidator,
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const sourceId = args.id ?? `src_${crypto.randomUUID()}`;
    const scopeType = args.scopeType ?? "workspace";
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${args.workspaceId}`);
    }
    const organizationId = workspace.organizationId;
    const scopedWorkspaceId = scopeType === "workspace" ? args.workspaceId : undefined;

    const configResult = normalizeToolSourceConfig(args.type, args.config);
    if (configResult.isErr()) {
      throw new Error(configResult.error.message);
    }
    const config = configResult.value;
    const specHash = computeSourceSpecHash(args.type, config);
    const authFingerprint = normalizeSourceAuthFingerprint(config.auth);
    const [existing, conflict] = await Promise.all([
      ctx.db
        .query("toolSources")
        .withIndex("by_source_id", (q) => q.eq("sourceId", sourceId))
        .unique(),
      scopeType === "workspace"
        ? ctx.db
          .query("toolSources")
          .withIndex("by_workspace_name", (q) => q.eq("workspaceId", args.workspaceId).eq("name", args.name))
          .unique()
        : ctx.db
          .query("toolSources")
          .withIndex("by_organization_scope_name", (q) =>
            q.eq("organizationId", organizationId).eq("scopeType", "organization").eq("name", args.name),
          )
          .unique(),
    ]);

    if (conflict && conflict.sourceId !== sourceId) {
      throw new Error(`Tool source name '${args.name}' already exists in this scope`);
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        scopeType,
        organizationId,
        workspaceId: scopedWorkspaceId,
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
        scopeType,
        organizationId,
        workspaceId: scopedWorkspaceId,
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

    await safeRunAfter(ctx.scheduler, 0, internal.executorNode.listToolsWithWarningsInternal, {
      workspaceId: args.workspaceId,
    });

    return mapSource(updated);
  },
});

export const listToolSources = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return [];
    }

    const [workspaceDocs, organizationDocs] = await Promise.all([
      ctx.db
        .query("toolSources")
        .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", args.workspaceId))
        .order("desc")
        .collect(),
      ctx.db
        .query("toolSources")
        .withIndex("by_organization_scope_updated", (q) =>
          q.eq("organizationId", workspace.organizationId).eq("scopeType", "organization"),
        )
        .order("desc")
        .collect(),
    ]);

    const docs = [...workspaceDocs, ...organizationDocs]
      .filter((doc, index, entries) => entries.findIndex((candidate) => candidate.sourceId === doc.sourceId) === index)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return docs.map(mapSource);
  },
});

export const deleteToolSource = internalMutation({
  args: { workspaceId: v.id("workspaces"), sourceId: v.string() },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return false;
    }

    const doc = await ctx.db
      .query("toolSources")
      .withIndex("by_source_id", (q) => q.eq("sourceId", args.sourceId))
      .unique();

    if (!doc || doc.organizationId !== workspace.organizationId) {
      return false;
    }

    if (doc.scopeType === "workspace" && doc.workspaceId !== args.workspaceId) {
      return false;
    }

    const sourceKey = `source:${args.sourceId}`;
    const bindings = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_source", (q) => q.eq("sourceKey", sourceKey))
      .collect();

    for (const binding of bindings) {
      await ctx.db.delete(binding._id);
    }

    await ctx.db.delete(doc._id);

    await safeRunAfter(ctx.scheduler, 0, internal.executorNode.listToolsWithWarningsInternal, {
      workspaceId: args.workspaceId,
    });

    return true;
  },
});
