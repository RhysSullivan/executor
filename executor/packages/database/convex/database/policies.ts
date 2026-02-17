import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { listRuntimeTargets as listAvailableRuntimeTargets } from "../../../core/src/runtimes/runtime-catalog";
import { mapPolicy } from "../../src/database/mappers";
import {
  argumentConditionValidator,
  policyApprovalModeValidator,
  policyEffectValidator,
  policyMatchTypeValidator,
  policyScopeTypeValidator,
} from "../../src/database/validators";

export const listRuntimeTargets = internalQuery({
  args: {},
  handler: async () => {
    return listAvailableRuntimeTargets();
  },
});

export const upsertAccessPolicy = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    scopeType: v.optional(policyScopeTypeValidator),
    targetAccountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
    resourcePattern: v.string(),
    matchType: v.optional(policyMatchTypeValidator),
    effect: v.optional(policyEffectValidator),
    approvalMode: v.optional(policyApprovalModeValidator),
    argumentConditions: v.optional(v.array(argumentConditionValidator)),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const policyId = args.id ?? `policy_${crypto.randomUUID()}`;
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${args.workspaceId}`);
    }

    const scopeType = args.scopeType ?? "workspace";
    const resourcePattern = args.resourcePattern.trim() || "*";
    const matchType = args.matchType ?? "glob";
    const effect = args.effect ?? "allow";
    const approvalMode = args.approvalMode ?? "required";

    if (scopeType === "account" && !args.targetAccountId) {
      throw new Error("targetAccountId is required for account-scoped policies");
    }

    const organizationId = scopeType === "organization" || scopeType === "workspace"
      ? workspace.organizationId
      : undefined;
    const workspaceId = scopeType === "workspace" ? args.workspaceId : undefined;

    // Normalize argument conditions: drop empty entries, store undefined if empty array.
    const argumentConditions = args.argumentConditions && args.argumentConditions.length > 0
      ? args.argumentConditions.filter((c) => c.key.trim().length > 0)
      : undefined;

    const existing = await ctx.db
      .query("accessPolicies")
      .withIndex("by_policy_id", (q) => q.eq("policyId", policyId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        scopeType,
        organizationId,
        workspaceId,
        targetAccountId: args.targetAccountId,
        clientId: args.clientId?.trim() || undefined,
        resourceType: "tool_path",
        resourcePattern,
        matchType,
        effect,
        approvalMode,
        argumentConditions,
        priority: args.priority ?? 100,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("accessPolicies", {
        policyId,
        scopeType,
        organizationId,
        workspaceId,
        targetAccountId: args.targetAccountId,
        clientId: args.clientId?.trim() || undefined,
        resourceType: "tool_path",
        resourcePattern,
        matchType,
        effect,
        approvalMode,
        argumentConditions,
        priority: args.priority ?? 100,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updated = await ctx.db
      .query("accessPolicies")
      .withIndex("by_policy_id", (q) => q.eq("policyId", policyId))
      .unique();
    if (!updated) {
      throw new Error(`Failed to read policy ${policyId}`);
    }
    return mapPolicy(updated);
  },
});

export const deleteAccessPolicy = internalMutation({
  args: {
    policyId: v.string(),
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("accessPolicies")
      .withIndex("by_policy_id", (q) => q.eq("policyId", args.policyId))
      .unique();
    if (!existing) {
      throw new Error(`Policy not found: ${args.policyId}`);
    }
    // Verify the policy belongs to this workspace or its organization.
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${args.workspaceId}`);
    }
    const belongsToWorkspace = existing.workspaceId === args.workspaceId;
    const belongsToOrg = existing.organizationId === workspace.organizationId;
    if (!belongsToWorkspace && !belongsToOrg) {
      throw new Error("Policy does not belong to this workspace or organization");
    }
    await ctx.db.delete(existing._id);
  },
});

export const listAccessPolicies = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return [];
    }

    const workspaceDocs = await ctx.db
      .query("accessPolicies")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    const organizationDocs = await ctx.db
      .query("accessPolicies")
      .withIndex("by_organization_created", (q) => q.eq("organizationId", workspace.organizationId))
      .collect();

    const accountDocs = args.accountId
      ? await ctx.db
        .query("accessPolicies")
        .withIndex("by_target_account_created", (q) => q.eq("targetAccountId", args.accountId))
        .collect()
      : [];

    const all = [...workspaceDocs, ...organizationDocs, ...accountDocs].filter((doc, index, entries) => {
      return entries.findIndex((candidate) => candidate.policyId === doc.policyId) === index;
    });

    return all
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt - b.createdAt;
      })
      .map(mapPolicy);
  },
});
