import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation } from "./_generated/server";
import { workspaceMutation, workspaceQuery } from "../../core/src/function-builders";
import {
  credentialProviderValidator,
  credentialScopeValidator,
  policyDecisionValidator,
  toolSourceTypeValidator,
} from "../src/database/validators";

export const bootstrapAnonymousSession = mutation({
  args: {
    sessionId: v.optional(v.string()),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.bootstrapAnonymousSession, args);
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

export const listPendingApprovals = workspaceQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listPendingApprovals, {
      workspaceId: ctx.workspaceId,
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
      ...args,
      workspaceId: ctx.workspaceId,
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
    overridesJson: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.upsertCredential, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listCredentials = workspaceQuery({
  requireAdmin: true,
  args: {},
  handler: async (ctx) => {
    const credentials = await ctx.runQuery(internal.database.listCredentials, {
      workspaceId: ctx.workspaceId,
    });
    const sanitized = [] as Array<Record<string, unknown>>;
    for (const credential of credentials) {
      sanitized.push({
        ...credential,
        secretJson: {},
      });
    }
    return sanitized;
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
    return await ctx.runQuery(internal.database.resolveCredential, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
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
      ...args,
      workspaceId: ctx.workspaceId,
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
  args: {
    sourceId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.deleteToolSource, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});
