import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { listRuntimeTargets as listAvailableRuntimeTargets } from "../../../core/src/runtimes/runtime-catalog";
import { mapPolicy } from "../../src/database/mappers";
import { policyDecisionValidator } from "../../src/database/validators";

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
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
    toolPathPattern: v.string(),
    decision: policyDecisionValidator,
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const policyId = args.id ?? `policy_${crypto.randomUUID()}`;
    const existing = await ctx.db
      .query("accessPolicies")
      .withIndex("by_policy_id", (q) => q.eq("policyId", policyId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        workspaceId: args.workspaceId,
        actorId: args.actorId?.trim() || undefined,
        clientId: args.clientId?.trim() || undefined,
        toolPathPattern: args.toolPathPattern,
        decision: args.decision,
        priority: args.priority ?? 100,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("accessPolicies", {
        policyId,
        workspaceId: args.workspaceId,
        actorId: args.actorId?.trim() || undefined,
        clientId: args.clientId?.trim() || undefined,
        toolPathPattern: args.toolPathPattern,
        decision: args.decision,
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

export const listAccessPolicies = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("accessPolicies")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    return docs
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt - b.createdAt;
      })
      .map(mapPolicy);
  },
});
