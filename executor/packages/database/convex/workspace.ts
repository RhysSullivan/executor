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
  storageDurabilityValidator,
  storageScopeTypeValidator,
  toolRoleBindingStatusValidator,
  toolRoleSelectorTypeValidator,
  toolSourceScopeTypeValidator,
  toolSourceTypeValidator,
} from "../src/database/validators";
import { safeRunAfter } from "../src/lib/scheduler";
import {
  getWorkspaceInventoryProgressForContext,
  listToolDetailsForContext,
} from "../src/runtime/workspace_tools";
import {
  issueMcpApiKey,
  isMcpApiKeyConfigured,
  MCP_API_KEY_ENV_NAME,
} from "../src/auth/mcp_api_key";

function sanitizeSourceConfig(config: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    ...config,
  };

  const authRaw = sanitized.auth;
  if (authRaw && typeof authRaw === "object" && !Array.isArray(authRaw)) {
    const auth = authRaw as Record<string, unknown>;
    const authSanitized: Record<string, unknown> = {};
    if (typeof auth.type === "string") {
      authSanitized.type = auth.type;
    }
    if (typeof auth.mode === "string") {
      authSanitized.mode = auth.mode;
    }
    if (typeof auth.header === "string") {
      authSanitized.header = auth.header;
    }
    sanitized.auth = authSanitized;
  }

  return sanitized;
}

export const bootstrapAnonymousSession = customMutation({
  method: "POST",
  args: {
    sessionId: v.optional(v.string()),
    accountId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.bootstrapAnonymousSession, args);
  },
});

export const getMcpApiKey = workspaceQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    if (ctx.account.provider !== "anonymous") {
      return {
        enabled: false,
        envVar: MCP_API_KEY_ENV_NAME,
        apiKey: null,
        error: "MCP API keys are currently enabled for anonymous accounts only",
      };
    }

    if (!isMcpApiKeyConfigured()) {
      return {
        enabled: false,
        envVar: MCP_API_KEY_ENV_NAME,
        apiKey: null,
        error: "MCP API key signing is not configured",
      };
    }

    const apiKey = await issueMcpApiKey({
      workspaceId: ctx.workspaceId,
      accountId: ctx.account._id,
    });

    if (!apiKey) {
      return {
        enabled: false,
        envVar: MCP_API_KEY_ENV_NAME,
        apiKey: null,
        error: "Failed to issue MCP API key",
      };
    }

    return {
      enabled: true,
      envVar: MCP_API_KEY_ENV_NAME,
      apiKey,
    };
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

export const listToolPolicies = workspaceQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listToolPolicies, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.account._id,
    });
  },
});

export const upsertToolPolicySet = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.upsertToolPolicySet, {
      ...args,
      workspaceId: ctx.workspaceId,
      createdByAccountId: ctx.account._id,
    });
  },
});

export const listToolPolicySets = workspaceQuery({
  method: "GET",
  requireAdmin: true,
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.database.listToolPolicySets, {
      workspaceId: ctx.workspaceId,
    });
  },
});

export const deleteToolPolicySet = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    roleId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.deleteToolPolicySet, {
      workspaceId: ctx.workspaceId,
      roleId: args.roleId,
    });
  },
});

export const upsertToolPolicyRule = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    roleId: v.string(),
    selectorType: toolRoleSelectorTypeValidator,
    sourceKey: v.optional(v.string()),
    resourcePattern: v.optional(v.string()),
    matchType: v.optional(policyMatchTypeValidator),
    effect: v.optional(policyEffectValidator),
    approvalMode: v.optional(policyApprovalModeValidator),
    argumentConditions: v.optional(v.array(v.object({
      key: v.string(),
      operator: v.union(v.literal("equals"), v.literal("contains"), v.literal("starts_with"), v.literal("not_equals")),
      value: v.string(),
    }))),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.upsertToolPolicyRule, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listToolPolicyRules = workspaceQuery({
  method: "GET",
  requireAdmin: true,
  args: {
    roleId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.runQuery(internal.database.listToolPolicyRules, {
      workspaceId: ctx.workspaceId,
      roleId: args.roleId,
    });
  },
});

export const deleteToolPolicyRule = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    roleId: v.string(),
    ruleId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.deleteToolPolicyRule, {
      workspaceId: ctx.workspaceId,
      roleId: args.roleId,
      ruleId: args.ruleId,
    });
  },
});

export const upsertToolPolicyAssignment = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    roleId: v.string(),
    scopeType: v.optional(policyScopeTypeValidator),
    targetAccountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
    status: v.optional(toolRoleBindingStatusValidator),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.upsertToolPolicyAssignment, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listToolPolicyAssignments = workspaceQuery({
  method: "GET",
  requireAdmin: true,
  args: {
    roleId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.runQuery(internal.database.listToolPolicyAssignments, {
      workspaceId: ctx.workspaceId,
      roleId: args.roleId,
    });
  },
});

export const deleteToolPolicyAssignment = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    bindingId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.deleteToolPolicyAssignment, {
      workspaceId: ctx.workspaceId,
      bindingId: args.bindingId,
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

    if (args.scopeType === "account") {
      if (!args.accountId) {
        throw new Error("accountId is required for account-scoped credentials");
      }

      const targetMembership = await getOrganizationMembership(ctx, ctx.workspace.organizationId, args.accountId);
      if (!targetMembership || targetMembership.status !== "active") {
        throw new Error("accountId must be an active member of this organization");
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
    const sources = await ctx.runQuery(internal.database.listToolSources, {
      workspaceId: ctx.workspaceId,
    });

    if (isAdminRole(ctx.organizationMembership.role)) {
      return sources;
    }

    return (sources as Array<Record<string, unknown> & { config: Record<string, unknown> }>).map((source) => ({
      ...source,
      config: sanitizeSourceConfig(source.config),
    }));
  },
});

export const openStorageInstance = workspaceMutation({
  method: "POST",
  args: {
    instanceId: v.optional(v.string()),
    scopeType: v.optional(storageScopeTypeValidator),
    durability: v.optional(storageDurabilityValidator),
    purpose: v.optional(v.string()),
    ttlHours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const scopeType = args.scopeType ?? "scratch";
    if (scopeType === "organization" || scopeType === "workspace") {
      if (!isAdminRole(ctx.organizationMembership.role)) {
        throw new Error("Only organization admins can open workspace or organization storage instances");
      }
    }

    return await ctx.runMutation(internal.database.openStorageInstance, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.account._id,
      ...args,
    });
  },
});

export const listStorageInstances = workspaceQuery({
  method: "GET",
  args: {
    scopeType: v.optional(storageScopeTypeValidator),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await ctx.runQuery(internal.database.listStorageInstances, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.account._id,
      ...args,
    });
  },
});

export const closeStorageInstance = workspaceMutation({
  method: "POST",
  args: {
    instanceId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.closeStorageInstance, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.account._id,
      instanceId: args.instanceId,
    });
  },
});

export const deleteStorageInstance = workspaceMutation({
  method: "POST",
  args: {
    instanceId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(internal.database.deleteStorageInstance, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.account._id,
      instanceId: args.instanceId,
    });
  },
});

export const getToolInventoryProgress = workspaceQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    return await getWorkspaceInventoryProgressForContext(ctx, ctx.workspaceId);
  },
});

export const getToolDetails = workspaceMutation({
  method: "POST",
  args: {
    toolPaths: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    return await listToolDetailsForContext(
      ctx,
      {
        workspaceId: ctx.workspaceId,
        accountId: ctx.account._id,
        clientId: "web",
      },
      {
        toolPaths: args.toolPaths,
      },
    );
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

export const regenerateToolInventory = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {},
  handler: async (ctx) => {
    const scheduled = await safeRunAfter(ctx.scheduler, 0, internal.executorNode.rebuildToolInventoryInternal, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.account._id,
    });

    return {
      queued: true as const,
      scheduled,
      workspaceId: ctx.workspaceId,
    };
  },
});
