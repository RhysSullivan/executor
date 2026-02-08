import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { canManageBilling, getOrganizationMembership, isAdminRole, requireAccountForRequest } from "./lib/identity";

async function requireActiveMembership(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  organizationId: Id<"organizations">,
  accountId: Id<"accounts">,
) {
  const membership = await getOrganizationMembership(ctx, organizationId, accountId);
  if (!membership || membership.status !== "active") {
    throw new Error("You are not a member of this organization");
  }
  return membership;
}

export const list = query({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await requireAccountForRequest(ctx, args.sessionId);
    await requireActiveMembership(ctx, args.organizationId, account._id);

    const members = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    const results = await Promise.all(
      members.map(async (member) => {
        const profile = await ctx.db.get(member.accountId);
        return {
          id: String(member._id),
          organizationId: member.organizationId,
          accountId: member.accountId,
          email: profile?.email ?? null,
          displayName: profile?.name ?? "Unknown User",
          avatarUrl: profile?.avatarUrl ?? null,
          role: member.role,
          status: member.status,
          billable: member.billable,
          joinedAt: member.joinedAt ?? null,
        };
      }),
    );

    return { items: results };
  },
});

export const updateRole = mutation({
  args: {
    organizationId: v.id("organizations"),
    accountId: v.id("accounts"),
    role: v.string(),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await requireAccountForRequest(ctx, args.sessionId);
    const actorMembership = await requireActiveMembership(ctx, args.organizationId, account._id);
    if (!isAdminRole(actorMembership.role)) {
      throw new Error("Only organization admins can update member roles");
    }

    const membership = await getOrganizationMembership(ctx, args.organizationId, args.accountId);
    if (!membership) {
      throw new Error("Organization member not found");
    }

    await ctx.db.patch(membership._id, {
      role: args.role,
      updatedAt: Date.now(),
    });

    return { ok: true };
  },
});

export const updateBillable = mutation({
  args: {
    organizationId: v.id("organizations"),
    accountId: v.id("accounts"),
    billable: v.boolean(),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await requireAccountForRequest(ctx, args.sessionId);
    const actorMembership = await requireActiveMembership(ctx, args.organizationId, account._id);
    if (!isAdminRole(actorMembership.role) && !canManageBilling(actorMembership.role)) {
      throw new Error("Only organization admins can update billing flags");
    }

    const membership = await getOrganizationMembership(ctx, args.organizationId, args.accountId);
    if (!membership) {
      throw new Error("Organization member not found");
    }

    await ctx.db.patch(membership._id, {
      billable: args.billable,
      updatedAt: Date.now(),
    });

    const nextVersion = await ctx.runMutation(internal.billingInternal.bumpSeatSyncVersion, {
      organizationId: args.organizationId,
    });
    await ctx.scheduler.runAfter(0, internal.billingSync.syncSeatQuantity, {
      organizationId: args.organizationId,
      expectedVersion: nextVersion,
    });

    return { ok: true };
  },
});

export const remove = mutation({
  args: {
    organizationId: v.id("organizations"),
    accountId: v.id("accounts"),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await requireAccountForRequest(ctx, args.sessionId);
    const actorMembership = await requireActiveMembership(ctx, args.organizationId, account._id);
    if (!isAdminRole(actorMembership.role)) {
      throw new Error("Only organization admins can remove members");
    }

    const membership = await getOrganizationMembership(ctx, args.organizationId, args.accountId);
    if (!membership) {
      throw new Error("Organization member not found");
    }

    await ctx.db.patch(membership._id, {
      status: "removed",
      updatedAt: Date.now(),
    });

    const nextVersion = await ctx.runMutation(internal.billingInternal.bumpSeatSyncVersion, {
      organizationId: args.organizationId,
    });
    await ctx.scheduler.runAfter(0, internal.billingSync.syncSeatQuantity, {
      organizationId: args.organizationId,
      expectedVersion: nextVersion,
    });

    return {
      ok: true,
      newStatus: "removed",
    };
  },
});
