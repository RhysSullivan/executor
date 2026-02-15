import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { workspaceMutation, workspaceQuery } from "../core/src/function-builders";
import { isAnonymousIdentity } from "./auth/anonymous";
import { safeRunAfter } from "./lib/scheduler";

const policyDecisionValidator = v.union(v.literal("allow"), v.literal("require_approval"), v.literal("deny"));
const credentialScopeValidator = v.union(v.literal("workspace"), v.literal("actor"));
const credentialProviderValidator = v.union(v.literal("local-convex"), v.literal("workos-vault"));
const toolSourceTypeValidator = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));

function redactCredential<T extends { secretJson: Record<string, unknown> }>(credential: T): T {
  return {
    ...credential,
    secretJson: {},
  };
}

export const bootstrapAnonymousSession = mutation({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Anonymous auth token is required");
    }

    if (!isAnonymousIdentity(identity)) {
      throw new Error("Anonymous auth token is required");
    }

    const actorId = identity.subject;
    if (!actorId.startsWith("anon_")) {
      throw new Error("Anonymous token subject must use anon_* actor ids");
    }
    const stableSessionId = `anon_session_${actorId}`;
    return await ctx.runMutation(internal.database.bootstrapAnonymousSession, {
      sessionId: stableSessionId,
      actorId,
      clientId: "web",
    });
  },
});

export const listRuntimeTargets = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listRuntimeTargets, {});
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
    overridesJson: v.optional(v.any()),
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
    const source = await ctx.runMutation(internal.database.upsertToolSource, {
      workspaceId: ctx.workspaceId,
      ...args,
    });

    try {
      await safeRunAfter(ctx.scheduler, 0, internal.executorNode.listToolsWithWarningsInternal, {
        workspaceId: ctx.workspaceId,
      });
    } catch {
      // Best effort prewarm only.
    }

    return source;
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
    const deleted = await ctx.runMutation(internal.database.deleteToolSource, {
      workspaceId: ctx.workspaceId,
      sourceId: args.sourceId,
    });

    try {
      await safeRunAfter(ctx.scheduler, 0, internal.executorNode.listToolsWithWarningsInternal, {
        workspaceId: ctx.workspaceId,
      });
    } catch {
      // Best effort prewarm only.
    }

    return deleted;
  },
});
