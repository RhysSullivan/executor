import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { workspaceMutation, workspaceQuery } from "./lib/functionBuilders";

const approvalStatusValidator = v.union(v.literal("pending"), v.literal("approved"), v.literal("denied"));
const policyDecisionValidator = v.union(v.literal("allow"), v.literal("require_approval"), v.literal("deny"));
const credentialScopeValidator = v.union(v.literal("workspace"), v.literal("actor"));
const credentialProviderValidator = v.union(v.literal("managed"), v.literal("workos-vault"));
const toolSourceTypeValidator = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));

function redactCredential<T extends { secretJson: Record<string, unknown> }>(credential: T): T {
  return {
    ...credential,
    secretJson: {},
  };
}

export const bootstrapAnonymousSession = mutation({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.bootstrapAnonymousSession, args);
  },
});

export const listRuntimeTargets = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listRuntimeTargets, {});
  },
});

export const getTask = workspaceQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.runQuery(internal.database.getTaskInWorkspace, {
      taskId: args.taskId,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const getTaskInWorkspace = workspaceQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.runQuery(internal.database.getTaskInWorkspace, {
      taskId: args.taskId,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listTasks = workspaceQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listTasks, {
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listApprovals = workspaceQuery({
  args: {
    status: v.optional(approvalStatusValidator),
  },
  handler: async (ctx, args) => {
    return await ctx.runQuery(internal.database.listApprovals, {
      workspaceId: ctx.workspaceId,
      status: args.status,
    });
  },
});

export const listPendingApprovals = workspaceQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listPendingApprovals, {
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listTaskEvents = workspaceQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.runQuery(internal.database.getTaskInWorkspace, {
      taskId: args.taskId,
      workspaceId: ctx.workspaceId,
    });
    if (!task) {
      return [];
    }

    return await ctx.runQuery(internal.database.listTaskEvents, {
      taskId: args.taskId,
    });
  },
});

export const upsertAccessPolicy = workspaceMutation({
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
    toolPathPattern: v.string(),
    decision: policyDecisionValidator,
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.upsertAccessPolicy, {
      workspaceId: ctx.workspaceId,
      ...args,
    });
  },
});

export const listAccessPolicies = workspaceQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listAccessPolicies, {
      workspaceId: ctx.workspaceId,
    });
  },
});

export const upsertCredential = workspaceMutation({
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    sourceKey: v.string(),
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
    provider: v.optional(credentialProviderValidator),
    secretJson: v.any(),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.upsertCredential, {
      workspaceId: ctx.workspaceId,
      ...args,
    });
  },
});

export const listCredentials = workspaceQuery({
  args: {},
  handler: async (ctx) => {
    const credentials = await ctx.runQuery(internal.database.listCredentials, {
      workspaceId: ctx.workspaceId,
    });

    return credentials.map(redactCredential);
  },
});

export const listCredentialProviders = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listCredentialProviders, {});
  },
});

export const resolveCredential = workspaceQuery({
  requireAdmin: true,
  args: {
    sourceKey: v.string(),
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const credential = await ctx.runQuery(internal.database.resolveCredential, {
      workspaceId: ctx.workspaceId,
      sourceKey: args.sourceKey,
      scope: args.scope,
      actorId: args.actorId,
    });

    return credential ? redactCredential(credential) : null;
  },
});

export const upsertToolSource = workspaceMutation({
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    name: v.string(),
    type: toolSourceTypeValidator,
    config: v.any(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.upsertToolSource, {
      workspaceId: ctx.workspaceId,
      ...args,
    });
  },
});

export const listToolSources = workspaceQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listToolSources, {
      workspaceId: ctx.workspaceId,
    });
  },
});

export const deleteToolSource = workspaceMutation({
  requireAdmin: true,
  args: { sourceId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.deleteToolSource, {
      workspaceId: ctx.workspaceId,
      sourceId: args.sourceId,
    });
  },
});
