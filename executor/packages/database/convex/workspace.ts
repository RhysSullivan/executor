import { v } from "convex/values";
import { internal } from "./_generated/api";
import { customMutation, workspaceMutation, workspaceQuery } from "../../core/src/function-builders";
import { getOrganizationMembership, isAdminRole } from "../../core/src/identity";
import {
  credentialProviderValidator,
  credentialScopeTypeValidator,
  jsonObjectValidator,
  policyApprovalModeValidator,
  policyEffectValidator,
  policyMatchTypeValidator,
  policyScopeTypeValidator,
  toolSourceScopeTypeValidator,
  toolSourceTypeValidator,
} from "../src/database/validators";

export const bootstrapAnonymousSession = customMutation({
  method: "POST",
  args: {
    sessionId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.bootstrapAnonymousSession, args);
  },
});

export const listTasks = workspaceQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listTasks, {
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listPendingApprovals = workspaceQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listPendingApprovals, {
      workspaceId: ctx.workspaceId,
    });
  },
});

export const upsertAccessPolicy = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    scopeType: v.optional(policyScopeTypeValidator),
    targetAccountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
    resourcePattern: v.string(),
    matchType: v.optional(policyMatchTypeValidator),
    effect: v.optional(policyEffectValidator),
    approvalMode: v.optional(policyApprovalModeValidator),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.scopeType === "organization") {
      const organizationMembership = await getOrganizationMembership(ctx, ctx.workspace.organizationId, ctx.account._id);
      if (!organizationMembership || !isAdminRole(organizationMembership.role)) {
        throw new Error("Only organization admins can create organization-level policies");
      }
    }

    return await ctx.runMutation(internal.database.upsertAccessPolicy, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listAccessPolicies = workspaceQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listAccessPolicies, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.account._id,
    });
  },
});

export const upsertCredential = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    scopeType: v.optional(credentialScopeTypeValidator),
    sourceKey: v.string(),
    accountId: v.optional(v.id("accounts")),
    provider: v.optional(credentialProviderValidator),
    secretJson: jsonObjectValidator,
    overridesJson: v.optional(jsonObjectValidator),
  },
  handler: async (ctx, args) => {
    if (args.scopeType === "organization") {
      const organizationMembership = await getOrganizationMembership(ctx, ctx.workspace.organizationId, ctx.account._id);
      if (!organizationMembership || !isAdminRole(organizationMembership.role)) {
        throw new Error("Only organization admins can manage organization-level credentials");
      }
    }

    return await ctx.runMutation(internal.database.upsertCredential, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listCredentials = workspaceQuery({
  method: "GET",
  requireAdmin: true,
  args: {},
  handler: async (ctx) => {
    const credentials = await ctx.runQuery(internal.database.listCredentials, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.account._id,
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
  method: "GET",
  requireAdmin: true,
  args: {
    sourceKey: v.string(),
    scopeType: credentialScopeTypeValidator,
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    return await ctx.runQuery(internal.database.resolveCredential, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const upsertToolSource = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    scopeType: v.optional(toolSourceScopeTypeValidator),
    name: v.string(),
    type: toolSourceTypeValidator,
    config: jsonObjectValidator,
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.scopeType === "organization") {
      const organizationMembership = await getOrganizationMembership(ctx, ctx.workspace.organizationId, ctx.account._id);
      if (!organizationMembership || !isAdminRole(organizationMembership.role)) {
        throw new Error("Only organization admins can manage organization-level tool sources");
      }
    }

    return await ctx.runMutation(internal.database.upsertToolSource, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listToolSources = workspaceQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listToolSources, {
      workspaceId: ctx.workspaceId,
    });
  },
});

export const deleteToolSource = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    sourceId: v.string(),
  },
  handler: async (ctx, args) => {
    const sources = await ctx.runQuery(internal.database.listToolSources, {
      workspaceId: ctx.workspaceId,
    });
    let source: { id: string; scopeType?: "organization" | "workspace" } | undefined;
    for (const entry of sources as Array<{ id: string; scopeType?: "organization" | "workspace" }>) {
      if (entry.id === args.sourceId) {
        source = entry;
        break;
      }
    }
    if (source?.scopeType === "organization") {
      const organizationMembership = await getOrganizationMembership(ctx, ctx.workspace.organizationId, ctx.account._id);
      if (!organizationMembership || !isAdminRole(organizationMembership.role)) {
        throw new Error("Only organization admins can delete organization-level tool sources");
      }
    }

    return await ctx.runMutation(internal.database.deleteToolSource, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});
