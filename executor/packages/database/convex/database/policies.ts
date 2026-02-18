import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { listRuntimeTargets as listAvailableRuntimeTargets } from "../../../core/src/runtimes/runtime-catalog";
import type {
  AccessPolicyRecord,
  ToolRoleBindingRecord,
  ToolRoleRecord,
  ToolRoleRuleRecord,
  ToolRoleSelectorType,
} from "../../../core/src/types";
import {
  argumentConditionValidator,
  policyApprovalModeValidator,
  policyEffectValidator,
  policyMatchTypeValidator,
  policyResourceTypeValidator,
  policyScopeTypeValidator,
  toolRoleBindingStatusValidator,
  toolRoleSelectorTypeValidator,
} from "../../src/database/validators";

type PolicyResourceType = AccessPolicyRecord["resourceType"];
type DbContext = Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">;

function normalizeArgumentConditions(
  argumentConditions: AccessPolicyRecord["argumentConditions"] | undefined,
): AccessPolicyRecord["argumentConditions"] | undefined {
  if (!argumentConditions || argumentConditions.length === 0) {
    return undefined;
  }

  const normalized = argumentConditions
    .map((condition) => ({
      key: condition.key.trim(),
      operator: condition.operator,
      value: condition.value,
    }))
    .filter((condition) => condition.key.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function selectorTypeFromResourceType(resourceType: PolicyResourceType): ToolRoleSelectorType {
  if (resourceType === "all_tools") {
    return "all";
  }

  if (resourceType === "source") {
    return "source";
  }

  if (resourceType === "namespace") {
    return "namespace";
  }

  return "tool_path";
}

function resourceTypeFromSelectorType(selectorType: ToolRoleSelectorType): PolicyResourceType {
  if (selectorType === "all") {
    return "all_tools";
  }

  if (selectorType === "source") {
    return "source";
  }

  if (selectorType === "namespace") {
    return "namespace";
  }

  return "tool_path";
}

function normalizePolicyResourceInput(args: {
  resourceType?: PolicyResourceType;
  resourcePattern: string;
}): {
  resourceType: PolicyResourceType;
  resourcePattern: string;
} {
  const trimmedPattern = args.resourcePattern.trim();
  const inferredType = trimmedPattern === "*" ? "all_tools" : "tool_path";
  const resourceType = args.resourceType ?? inferredType;

  if (resourceType === "all_tools") {
    return {
      resourceType,
      resourcePattern: "*",
    };
  }

  if (trimmedPattern.length === 0) {
    throw new Error("resourcePattern is required");
  }

  return {
    resourceType,
    resourcePattern: trimmedPattern,
  };
}

function selectorFieldsFromResource(
  resourceType: PolicyResourceType,
  resourcePattern: string,
): {
  selectorType: ToolRoleSelectorType;
  sourceKey?: string;
  namespacePattern?: string;
  toolPathPattern?: string;
} {
  if (resourceType === "all_tools") {
    return {
      selectorType: "all",
    };
  }

  if (resourceType === "source") {
    return {
      selectorType: "source",
      sourceKey: resourcePattern,
    };
  }

  if (resourceType === "namespace") {
    return {
      selectorType: "namespace",
      namespacePattern: resourcePattern,
    };
  }

  return {
    selectorType: "tool_path",
    toolPathPattern: resourcePattern,
  };
}

function resourcePatternFromRule(rule: {
  selectorType: ToolRoleSelectorType;
  sourceKey?: string;
  namespacePattern?: string;
  toolPathPattern?: string;
}): string {
  if (rule.selectorType === "all") {
    return "*";
  }
  if (rule.selectorType === "source") {
    return rule.sourceKey ?? "";
  }
  if (rule.selectorType === "namespace") {
    return rule.namespacePattern ?? "";
  }
  return rule.toolPathPattern ?? "";
}

function mapToolRole(doc: {
  roleId: string;
  organizationId: Id<"organizations">;
  name: string;
  description?: string;
  createdByAccountId?: Id<"accounts">;
  createdAt: number;
  updatedAt: number;
}): ToolRoleRecord {
  return {
    id: doc.roleId,
    organizationId: doc.organizationId,
    name: doc.name,
    description: doc.description,
    createdByAccountId: doc.createdByAccountId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mapToolRoleRule(doc: {
  ruleId: string;
  roleId: string;
  organizationId: Id<"organizations">;
  selectorType: ToolRoleSelectorType;
  sourceKey?: string;
  namespacePattern?: string;
  toolPathPattern?: string;
  matchType: AccessPolicyRecord["matchType"];
  effect: AccessPolicyRecord["effect"];
  approvalMode: AccessPolicyRecord["approvalMode"];
  argumentConditions?: AccessPolicyRecord["argumentConditions"];
  priority: number;
  createdAt: number;
  updatedAt: number;
}): ToolRoleRuleRecord {
  return {
    id: doc.ruleId,
    roleId: doc.roleId,
    organizationId: doc.organizationId,
    selectorType: doc.selectorType,
    sourceKey: doc.sourceKey,
    namespacePattern: doc.namespacePattern,
    toolPathPattern: doc.toolPathPattern,
    matchType: doc.matchType,
    effect: doc.effect,
    approvalMode: doc.approvalMode,
    argumentConditions: doc.argumentConditions,
    priority: doc.priority,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mapToolRoleBinding(doc: {
  bindingId: string;
  roleId: string;
  organizationId: Id<"organizations">;
  scopeType: AccessPolicyRecord["scopeType"];
  workspaceId?: Id<"workspaces">;
  targetAccountId?: Id<"accounts">;
  clientId?: string;
  status: "active" | "disabled";
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}): ToolRoleBindingRecord {
  return {
    id: doc.bindingId,
    roleId: doc.roleId,
    organizationId: doc.organizationId,
    scopeType: doc.scopeType,
    workspaceId: doc.workspaceId,
    targetAccountId: doc.targetAccountId,
    clientId: doc.clientId,
    status: doc.status,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function derivedPolicyId(roleId: string, ruleId: string, bindingId: string): string {
  const rolePrefix = "policy_role_";
  const rulePrefix = "policy_rule_";
  const bindingPrefix = "policy_binding_";
  if (
    roleId.startsWith(rolePrefix)
    && ruleId.startsWith(rulePrefix)
    && bindingId.startsWith(bindingPrefix)
  ) {
    const roleTail = roleId.slice(rolePrefix.length);
    const ruleTail = ruleId.slice(rulePrefix.length);
    const bindingTail = bindingId.slice(bindingPrefix.length);
    if (roleTail === ruleTail && roleTail === bindingTail) {
      return roleTail;
    }
  }

  return `${ruleId}:${bindingId}`;
}

function mapFlattenedPolicy(doc: {
  policyId: string;
  scopeType: AccessPolicyRecord["scopeType"];
  organizationId: Id<"organizations">;
  workspaceId?: Id<"workspaces">;
  targetAccountId?: Id<"accounts">;
  clientId?: string;
  resourceType: PolicyResourceType;
  resourcePattern: string;
  matchType: AccessPolicyRecord["matchType"];
  effect: AccessPolicyRecord["effect"];
  approvalMode: AccessPolicyRecord["approvalMode"];
  argumentConditions?: AccessPolicyRecord["argumentConditions"];
  priority: number;
  roleId: string;
  ruleId: string;
  bindingId: string;
  createdAt: number;
  updatedAt: number;
}): AccessPolicyRecord {
  return {
    id: doc.policyId,
    scopeType: doc.scopeType,
    organizationId: doc.organizationId,
    workspaceId: doc.workspaceId,
    targetAccountId: doc.targetAccountId,
    clientId: doc.clientId,
    resourceType: doc.resourceType,
    resourcePattern: doc.resourcePattern,
    matchType: doc.matchType,
    effect: doc.effect,
    approvalMode: doc.approvalMode,
    argumentConditions: doc.argumentConditions,
    priority: doc.priority,
    roleId: doc.roleId,
    ruleId: doc.ruleId,
    bindingId: doc.bindingId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function requireWorkspaceWithOrganization(
  ctx: DbContext,
  workspaceId: Id<"workspaces">,
) {
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const organization = await ctx.db.get(workspace.organizationId);
  if (!organization || organization.status !== "active") {
    throw new Error("Workspace organization is inactive");
  }

  return workspace;
}

async function assertActiveOrgMember(
  ctx: DbContext,
  args: {
    organizationId: Id<"organizations">;
    accountId: Id<"accounts">;
    fieldLabel: string;
  },
): Promise<void> {
  const membership = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_account", (q) => q.eq("organizationId", args.organizationId).eq("accountId", args.accountId))
    .unique();
  if (!membership || membership.status !== "active") {
    throw new Error(`${args.fieldLabel} must be an active member of this organization`);
  }
}

async function getRoleInOrganization(
  ctx: DbContext,
  args: {
    roleId: string;
    organizationId: Id<"organizations">;
  },
) {
  const role = await ctx.db
    .query("toolRoles")
    .withIndex("by_role_id", (q) => q.eq("roleId", args.roleId))
    .unique();
  if (!role || role.organizationId !== args.organizationId) {
    return null;
  }
  return role;
}

async function listEffectiveBindings(
  ctx: DbContext,
  args: {
    workspaceId: Id<"workspaces">;
    organizationId: Id<"organizations">;
    accountId?: Id<"accounts">;
  },
) {
  const now = Date.now();
  const [workspaceBindings, organizationBindings] = await Promise.all([
    ctx.db
      .query("toolRoleBindings")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .collect(),
    ctx.db
      .query("toolRoleBindings")
      .withIndex("by_org_created", (q) => q.eq("organizationId", args.organizationId))
      .collect(),
  ]);

  const merged = [...workspaceBindings, ...organizationBindings].filter((binding, index, entries) => {
    return entries.findIndex((candidate) => candidate.bindingId === binding.bindingId) === index;
  });

  return merged.filter((binding) => {
    if (binding.organizationId !== args.organizationId) {
      return false;
    }
    if (binding.status !== "active") {
      return false;
    }
    if (binding.expiresAt !== undefined && binding.expiresAt <= now) {
      return false;
    }

    if (binding.scopeType === "workspace" && binding.workspaceId !== args.workspaceId) {
      return false;
    }

    if (binding.scopeType === "organization" && binding.workspaceId) {
      return false;
    }

    if (binding.scopeType === "account") {
      if (!binding.targetAccountId) {
        return false;
      }

      if (!args.accountId || binding.targetAccountId !== args.accountId) {
        return false;
      }
    }

    return true;
  });
}

function selectorInputToResource(
  rule: Pick<ToolRoleRuleRecord, "selectorType" | "sourceKey" | "namespacePattern" | "toolPathPattern">,
): { resourceType: PolicyResourceType; resourcePattern: string } {
  const resourceType = resourceTypeFromSelectorType(rule.selectorType);
  const resourcePattern = resourcePatternFromRule(rule);

  return {
    resourceType,
    resourcePattern,
  };
}

export const listRuntimeTargets = internalQuery({
  args: {},
  handler: async () => {
    return listAvailableRuntimeTargets();
  },
});

export const upsertToolRole = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    id: v.optional(v.string()),
    name: v.string(),
    description: v.optional(v.string()),
    createdByAccountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const roleId = args.id?.trim() || `trole_${crypto.randomUUID()}`;
    const name = args.name.trim();
    if (!name) {
      throw new Error("Role name is required");
    }

    const existingByName = await ctx.db
      .query("toolRoles")
      .withIndex("by_org_name", (q) => q.eq("organizationId", workspace.organizationId).eq("name", name))
      .unique();
    if (existingByName && existingByName.roleId !== roleId) {
      throw new Error("A tool role with this name already exists");
    }

    const existing = await ctx.db
      .query("toolRoles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();

    if (existing) {
      if (existing.organizationId !== workspace.organizationId) {
        throw new Error("Tool role does not belong to this organization");
      }

      await ctx.db.patch(existing._id, {
        name,
        description: args.description?.trim() || undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("toolRoles", {
        roleId,
        organizationId: workspace.organizationId,
        name,
        description: args.description?.trim() || undefined,
        createdByAccountId: args.createdByAccountId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updated = await ctx.db
      .query("toolRoles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (!updated) {
      throw new Error(`Failed to read tool role ${roleId}`);
    }

    return mapToolRole(updated);
  },
});

export const listToolRoles = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const roles = await ctx.db
      .query("toolRoles")
      .withIndex("by_org_created", (q) => q.eq("organizationId", workspace.organizationId))
      .order("desc")
      .collect();

    return roles.map(mapToolRole);
  },
});

export const deleteToolRole = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    roleId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const role = await getRoleInOrganization(ctx, {
      roleId: args.roleId,
      organizationId: workspace.organizationId,
    });
    if (!role) {
      throw new Error(`Tool role not found: ${args.roleId}`);
    }

    const [rules, bindings] = await Promise.all([
      ctx.db
        .query("toolRoleRules")
        .withIndex("by_role_created", (q) => q.eq("roleId", role.roleId))
        .collect(),
      ctx.db
        .query("toolRoleBindings")
        .withIndex("by_role_created", (q) => q.eq("roleId", role.roleId))
        .collect(),
    ]);

    await Promise.all(rules.map(async (rule) => await ctx.db.delete(rule._id)));
    await Promise.all(bindings.map(async (binding) => await ctx.db.delete(binding._id)));
    await ctx.db.delete(role._id);
    return { ok: true as const };
  },
});

export const upsertToolRoleRule = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    roleId: v.string(),
    id: v.optional(v.string()),
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
    const now = Date.now();
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const role = await getRoleInOrganization(ctx, {
      roleId: args.roleId,
      organizationId: workspace.organizationId,
    });
    if (!role) {
      throw new Error(`Tool role not found: ${args.roleId}`);
    }

    const selectorType = args.selectorType;
    const resourcePattern = args.resourcePattern?.trim() || "";
    const sourceKey = args.sourceKey?.trim() || "";

    if (selectorType === "source" && !sourceKey) {
      throw new Error("sourceKey is required when selectorType is 'source'");
    }
    if ((selectorType === "namespace" || selectorType === "tool_path") && !resourcePattern) {
      throw new Error("resourcePattern is required for namespace and tool_path selectors");
    }

    const ruleId = args.id?.trim() || `trule_${crypto.randomUUID()}`;
    const existing = await ctx.db
      .query("toolRoleRules")
      .withIndex("by_rule_id", (q) => q.eq("ruleId", ruleId))
      .unique();

    const payload = {
      roleId: role.roleId,
      organizationId: workspace.organizationId,
      selectorType,
      sourceKey: selectorType === "source" ? sourceKey : undefined,
      namespacePattern: selectorType === "namespace" ? resourcePattern : undefined,
      toolPathPattern: selectorType === "tool_path" ? resourcePattern : undefined,
      matchType: args.matchType ?? "glob",
      effect: args.effect ?? "allow",
      approvalMode: args.approvalMode ?? "required",
      argumentConditions: normalizeArgumentConditions(args.argumentConditions),
      priority: args.priority ?? 100,
      updatedAt: now,
    };

    if (existing) {
      if (existing.organizationId !== workspace.organizationId || existing.roleId !== role.roleId) {
        throw new Error("Tool role rule does not belong to this organization role");
      }
      await ctx.db.patch(existing._id, payload);
    } else {
      await ctx.db.insert("toolRoleRules", {
        ruleId,
        ...payload,
        createdAt: now,
      });
    }

    const updated = await ctx.db
      .query("toolRoleRules")
      .withIndex("by_rule_id", (q) => q.eq("ruleId", ruleId))
      .unique();
    if (!updated) {
      throw new Error(`Failed to read tool role rule ${ruleId}`);
    }

    return mapToolRoleRule(updated);
  },
});

export const listToolRoleRules = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    roleId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const role = await getRoleInOrganization(ctx, {
      roleId: args.roleId,
      organizationId: workspace.organizationId,
    });
    if (!role) {
      return [];
    }

    const rules = await ctx.db
      .query("toolRoleRules")
      .withIndex("by_role_created", (q) => q.eq("roleId", role.roleId))
      .collect();

    return rules
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt - b.createdAt;
      })
      .map(mapToolRoleRule);
  },
});

export const deleteToolRoleRule = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    roleId: v.string(),
    ruleId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const role = await getRoleInOrganization(ctx, {
      roleId: args.roleId,
      organizationId: workspace.organizationId,
    });
    if (!role) {
      throw new Error("Tool role not found");
    }

    const rule = await ctx.db
      .query("toolRoleRules")
      .withIndex("by_rule_id", (q) => q.eq("ruleId", args.ruleId))
      .unique();
    if (!rule || rule.roleId !== role.roleId || rule.organizationId !== workspace.organizationId) {
      throw new Error("Tool role rule not found");
    }

    await ctx.db.delete(rule._id);
    return { ok: true as const };
  },
});

export const upsertToolRoleBinding = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    roleId: v.string(),
    id: v.optional(v.string()),
    scopeType: v.optional(policyScopeTypeValidator),
    targetAccountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
    status: v.optional(toolRoleBindingStatusValidator),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const role = await getRoleInOrganization(ctx, {
      roleId: args.roleId,
      organizationId: workspace.organizationId,
    });
    if (!role) {
      throw new Error(`Tool role not found: ${args.roleId}`);
    }

    const scopeType = args.scopeType ?? "organization";
    const workspaceId = scopeType === "workspace" ? args.workspaceId : undefined;
    const targetAccountId = scopeType === "account" ? args.targetAccountId : undefined;
    if (scopeType === "account" && !targetAccountId) {
      throw new Error("targetAccountId is required for account-scoped bindings");
    }
    if (targetAccountId) {
      await assertActiveOrgMember(ctx, {
        organizationId: workspace.organizationId,
        accountId: targetAccountId,
        fieldLabel: "targetAccountId",
      });
    }

    const bindingId = args.id?.trim() || `trbind_${crypto.randomUUID()}`;
    const existing = await ctx.db
      .query("toolRoleBindings")
      .withIndex("by_binding_id", (q) => q.eq("bindingId", bindingId))
      .unique();

    const payload = {
      roleId: role.roleId,
      organizationId: workspace.organizationId,
      scopeType,
      workspaceId,
      targetAccountId,
      clientId: args.clientId?.trim() || undefined,
      status: args.status ?? "active",
      expiresAt: args.expiresAt,
      updatedAt: now,
    };

    if (existing) {
      if (existing.organizationId !== workspace.organizationId || existing.roleId !== role.roleId) {
        throw new Error("Tool role binding does not belong to this organization role");
      }
      await ctx.db.patch(existing._id, payload);
    } else {
      await ctx.db.insert("toolRoleBindings", {
        bindingId,
        ...payload,
        createdAt: now,
      });
    }

    const updated = await ctx.db
      .query("toolRoleBindings")
      .withIndex("by_binding_id", (q) => q.eq("bindingId", bindingId))
      .unique();
    if (!updated) {
      throw new Error(`Failed to read tool role binding ${bindingId}`);
    }

    return mapToolRoleBinding(updated);
  },
});

export const listToolRoleBindings = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    roleId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const bindings = await ctx.db
      .query("toolRoleBindings")
      .withIndex("by_org_created", (q) => q.eq("organizationId", workspace.organizationId))
      .collect();

    const filtered = bindings.filter((binding) => {
      if (args.roleId && binding.roleId !== args.roleId) {
        return false;
      }
      return true;
    });

    return filtered
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(mapToolRoleBinding);
  },
});

export const deleteToolRoleBinding = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    bindingId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const binding = await ctx.db
      .query("toolRoleBindings")
      .withIndex("by_binding_id", (q) => q.eq("bindingId", args.bindingId))
      .unique();
    if (!binding || binding.organizationId !== workspace.organizationId) {
      throw new Error("Tool role binding not found");
    }

    await ctx.db.delete(binding._id);
    return { ok: true as const };
  },
});

export const upsertAccessPolicy = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    scopeType: v.optional(policyScopeTypeValidator),
    targetAccountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
    resourceType: v.optional(policyResourceTypeValidator),
    resourcePattern: v.string(),
    matchType: v.optional(policyMatchTypeValidator),
    effect: v.optional(policyEffectValidator),
    approvalMode: v.optional(policyApprovalModeValidator),
    argumentConditions: v.optional(v.array(argumentConditionValidator)),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const policyId = args.id ?? `policy_${crypto.randomUUID()}`;
    const scopeType = args.scopeType ?? "workspace";
    const targetAccountId = scopeType === "account" ? args.targetAccountId : undefined;
    if (scopeType === "account" && !targetAccountId) {
      throw new Error("targetAccountId is required for account-scoped policies");
    }
    if (targetAccountId) {
      await assertActiveOrgMember(ctx, {
        organizationId: workspace.organizationId,
        accountId: targetAccountId,
        fieldLabel: "targetAccountId",
      });
    }

    const resourceInput = normalizePolicyResourceInput({
      resourceType: args.resourceType,
      resourcePattern: args.resourcePattern,
    });
    const selectorFields = selectorFieldsFromResource(resourceInput.resourceType, resourceInput.resourcePattern);

    const roleId = `policy_role_${policyId}`;
    const ruleId = `policy_rule_${policyId}`;
    const bindingId = `policy_binding_${policyId}`;

    const existingRole = await ctx.db
      .query("toolRoles")
      .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
      .unique();
    if (existingRole) {
      if (existingRole.organizationId !== workspace.organizationId) {
        throw new Error("Policy role does not belong to this organization");
      }
      await ctx.db.patch(existingRole._id, {
        name: `policy:${policyId}`,
        description: "Direct access policy",
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("toolRoles", {
        roleId,
        organizationId: workspace.organizationId,
        name: `policy:${policyId}`,
        description: "Direct access policy",
        createdAt: now,
        updatedAt: now,
      });
    }

    const normalizedConditions = normalizeArgumentConditions(args.argumentConditions);
    const existingRule = await ctx.db
      .query("toolRoleRules")
      .withIndex("by_rule_id", (q) => q.eq("ruleId", ruleId))
      .unique();
    const rulePayload = {
      roleId,
      organizationId: workspace.organizationId,
      selectorType: selectorFields.selectorType,
      sourceKey: selectorFields.sourceKey,
      namespacePattern: selectorFields.namespacePattern,
      toolPathPattern: selectorFields.toolPathPattern,
      matchType: args.matchType ?? "glob",
      effect: args.effect ?? "allow",
      approvalMode: args.approvalMode ?? "required",
      argumentConditions: normalizedConditions,
      priority: args.priority ?? 100,
      updatedAt: now,
    };
    if (existingRule) {
      await ctx.db.patch(existingRule._id, rulePayload);
    } else {
      await ctx.db.insert("toolRoleRules", {
        ruleId,
        ...rulePayload,
        createdAt: now,
      });
    }

    const existingBinding = await ctx.db
      .query("toolRoleBindings")
      .withIndex("by_binding_id", (q) => q.eq("bindingId", bindingId))
      .unique();
    const bindingPayload = {
      roleId,
      organizationId: workspace.organizationId,
      scopeType,
      workspaceId: scopeType === "workspace" ? args.workspaceId : undefined,
      targetAccountId,
      clientId: args.clientId?.trim() || undefined,
      status: "active" as const,
      expiresAt: undefined,
      updatedAt: now,
    };
    if (existingBinding) {
      await ctx.db.patch(existingBinding._id, bindingPayload);
    } else {
      await ctx.db.insert("toolRoleBindings", {
        bindingId,
        ...bindingPayload,
        createdAt: now,
      });
    }

    return mapFlattenedPolicy({
      policyId,
      scopeType,
      organizationId: workspace.organizationId,
      workspaceId: scopeType === "workspace" ? args.workspaceId : undefined,
      targetAccountId,
      clientId: args.clientId?.trim() || undefined,
      resourceType: resourceInput.resourceType,
      resourcePattern: resourceInput.resourcePattern,
      matchType: args.matchType ?? "glob",
      effect: args.effect ?? "allow",
      approvalMode: args.approvalMode ?? "required",
      argumentConditions: normalizedConditions,
      priority: args.priority ?? 100,
      roleId,
      ruleId,
      bindingId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const deleteAccessPolicy = internalMutation({
  args: {
    policyId: v.string(),
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const roleId = `policy_role_${args.policyId}`;
    const ruleId = `policy_rule_${args.policyId}`;
    const bindingId = `policy_binding_${args.policyId}`;

    const [role, rule, binding] = await Promise.all([
      ctx.db
        .query("toolRoles")
        .withIndex("by_role_id", (q) => q.eq("roleId", roleId))
        .unique(),
      ctx.db
        .query("toolRoleRules")
        .withIndex("by_rule_id", (q) => q.eq("ruleId", ruleId))
        .unique(),
      ctx.db
        .query("toolRoleBindings")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", bindingId))
        .unique(),
    ]);

    if (
      !role
      || role.organizationId !== workspace.organizationId
      || !rule
      || rule.organizationId !== workspace.organizationId
      || !binding
      || binding.organizationId !== workspace.organizationId
    ) {
      throw new Error(`Policy not found: ${args.policyId}`);
    }

    if (binding.scopeType === "workspace" && binding.workspaceId !== args.workspaceId) {
      throw new Error("Policy does not belong to this workspace");
    }

    await Promise.all([
      ctx.db.delete(rule._id),
      ctx.db.delete(binding._id),
      ctx.db.delete(role._id),
    ]);
    return { ok: true as const };
  },
});

export const listAccessPolicies = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspaceWithOrganization(ctx, args.workspaceId);
    const bindings = await listEffectiveBindings(ctx, {
      workspaceId: args.workspaceId,
      organizationId: workspace.organizationId,
      accountId: args.accountId,
    });

    const roleIds = Array.from(new Set(bindings.map((binding) => binding.roleId)));
    const roleRules = await Promise.all(roleIds.map(async (roleId) => {
      return await ctx.db
        .query("toolRoleRules")
        .withIndex("by_role_created", (q) => q.eq("roleId", roleId))
        .collect();
    }));
    const rulesByRole = new Map(roleIds.map((roleId, index) => [roleId, roleRules[index] ?? []]));

    const policies: AccessPolicyRecord[] = [];
    for (const binding of bindings) {
      const rules = rulesByRole.get(binding.roleId) ?? [];
      for (const rule of rules) {
        const resource = selectorInputToResource(rule);
        const policyId = derivedPolicyId(binding.roleId, rule.ruleId, binding.bindingId);
        policies.push(mapFlattenedPolicy({
          policyId,
          scopeType: binding.scopeType,
          organizationId: binding.organizationId,
          workspaceId: binding.workspaceId,
          targetAccountId: binding.targetAccountId,
          clientId: binding.clientId,
          resourceType: resource.resourceType,
          resourcePattern: resource.resourcePattern,
          matchType: rule.matchType,
          effect: rule.effect,
          approvalMode: rule.approvalMode,
          argumentConditions: rule.argumentConditions,
          priority: rule.priority,
          roleId: binding.roleId,
          ruleId: rule.ruleId,
          bindingId: binding.bindingId,
          createdAt: Math.max(rule.createdAt, binding.createdAt),
          updatedAt: Math.max(rule.updatedAt, binding.updatedAt),
        }));
      }
    }

    return policies.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.createdAt - b.createdAt;
    });
  },
});
