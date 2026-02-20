import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { customMutation, workspaceAction, workspaceMutation, workspaceQuery } from "../../core/src/function-builders";
import { getOrganizationMembership, isAdminRole } from "../../core/src/identity";
import {
  argumentConditionValidator,
  credentialAdditionalHeadersValidator,
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
import { vv } from "./typedV";
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
import { upsertCredentialHandler } from "../src/credentials-node/upsert-credential";

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

type ToolSourceScope = "workspace" | "organization";

type ToolSourceCredentialSeed = {
  id?: string;
  scopeType?: "account" | "workspace" | "organization";
  accountId?: Id<"accounts">;
  provider?: "local-convex" | "workos-vault";
  secretJson: Record<string, unknown>;
  additionalHeaders?: Array<{ name: string; value: string }>;
};

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceScopeFallback(scopeType: ToolSourceScope): "workspace" | "organization" {
  return scopeType === "organization" ? "organization" : "workspace";
}

function resolveAuthModeForCredential(
  rawMode: string,
  scopeType: ToolSourceScope,
): "account" | "workspace" | "organization" | undefined {
  if (rawMode === "account" || rawMode === "workspace" || rawMode === "organization") {
    return rawMode;
  }
  if (rawMode === "static") {
    return sourceScopeFallback(scopeType);
  }
  return undefined;
}

function extractLegacyInlineCredential(
  config: Record<string, unknown>,
  scopeType: ToolSourceScope,
): { config: Record<string, unknown>; credential?: ToolSourceCredentialSeed } {
  const authRaw = config.auth;
  if (!authRaw || typeof authRaw !== "object" || Array.isArray(authRaw)) {
    return { config };
  }

  const auth = authRaw as Record<string, unknown>;
  const authType = trimmedString(auth.type);
  if (authType !== "bearer" && authType !== "apiKey" && authType !== "basic") {
    return { config };
  }

  const modeRaw = trimmedString(auth.mode);
  const normalizedMode = resolveAuthModeForCredential(modeRaw, scopeType);
  const modeForConfig = modeRaw === "static"
    ? sourceScopeFallback(scopeType)
    : (modeRaw || undefined);

  const sanitizedAuth: Record<string, unknown> = {
    type: authType,
    ...(modeForConfig ? { mode: modeForConfig } : {}),
  };
  if (authType === "apiKey") {
    const header = trimmedString(auth.header);
    if (header) {
      sanitizedAuth.header = header;
    }
  }

  const sanitizedConfig: Record<string, unknown> = {
    ...config,
    auth: sanitizedAuth,
  };

  if (authType === "bearer") {
    const token = trimmedString(auth.token);
    if (!token) {
      return { config: sanitizedConfig };
    }
    return {
      config: sanitizedConfig,
      credential: {
        scopeType: normalizedMode ?? sourceScopeFallback(scopeType),
        secretJson: { token },
      },
    };
  }

  if (authType === "apiKey") {
    const value = trimmedString(auth.value);
    if (!value) {
      return { config: sanitizedConfig };
    }
    return {
      config: sanitizedConfig,
      credential: {
        scopeType: normalizedMode ?? sourceScopeFallback(scopeType),
        secretJson: { value },
      },
    };
  }

  const username = trimmedString(auth.username);
  const password = trimmedString(auth.password);
  if (!username || !password) {
    return { config: sanitizedConfig };
  }

  return {
    config: sanitizedConfig,
    credential: {
      scopeType: normalizedMode ?? sourceScopeFallback(scopeType),
      secretJson: { username, password },
    },
  };
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
    // TODO(security): Revisit member-level visibility for task code/output
    // and provide redacted views by default outside admin contexts.
    return await ctx.runQuery(internal.database.listTasks, {
      workspaceId: ctx.workspaceId,
    });
  },
});

export const listPendingApprovals = workspaceQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    // TODO(security): Revisit member-level visibility for approval inputs,
    // which can include sensitive request payloads.
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
    argumentConditions: v.optional(v.array(argumentConditionValidator)),
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
    targetAccountId: v.optional(vv.id("accounts")),
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
    accountId: v.optional(vv.id("accounts")),
    provider: v.optional(credentialProviderValidator),
    secretJson: jsonObjectValidator,
    additionalHeaders: v.optional(credentialAdditionalHeadersValidator),
  },
  handler: async (ctx, args) => {
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
    accountId: v.optional(vv.id("accounts")),
  },
  handler: async (ctx, args) => {
    return await ctx.runQuery(internal.database.resolveCredential, {
      ...args,
      workspaceId: ctx.workspaceId,
    });
  },
});

export const upsertToolSource = workspaceAction({
  method: "POST",
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    scopeType: v.optional(toolSourceScopeTypeValidator),
    name: v.string(),
    type: toolSourceTypeValidator,
    config: jsonObjectValidator,
    enabled: v.optional(v.boolean()),
    credential: v.optional(v.object({
      id: v.optional(v.string()),
      scopeType: v.optional(credentialScopeTypeValidator),
      accountId: v.optional(vv.id("accounts")),
      provider: v.optional(credentialProviderValidator),
      secretJson: jsonObjectValidator,
      additionalHeaders: v.optional(credentialAdditionalHeadersValidator),
    })),
  },
  handler: async (ctx, args) => {
    const sourceScopeType: ToolSourceScope = args.scopeType === "organization" ? "organization" : "workspace";
    const normalized = extractLegacyInlineCredential(args.config, sourceScopeType);
    const sourceId = args.id ?? `src_${crypto.randomUUID()}`;
    const { credential: _credential, ...sourceArgs } = args;

    const source = await ctx.runMutation(internal.database.upsertToolSource, {
      ...sourceArgs,
      id: sourceId,
      config: normalized.config,
      workspaceId: ctx.workspaceId,
    });

    const credentialInput = args.credential ?? normalized.credential;
    if (credentialInput) {
      const scopeType = credentialInput.scopeType ?? sourceScopeFallback(sourceScopeType);
      const accountId = scopeType === "account"
        ? (credentialInput.accountId ?? ctx.accountId)
        : undefined;

      await upsertCredentialHandler(ctx, internal, {
        id: credentialInput.id,
        scopeType,
        sourceKey: `source:${source.id}`,
        accountId,
        provider: credentialInput.provider,
        secretJson: credentialInput.secretJson,
        additionalHeaders: credentialInput.additionalHeaders,
      });
    }

    return source;
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
