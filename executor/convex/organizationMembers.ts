import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getOrganizationMembership } from "../lib/identity";
import { organizationMutation, organizationQuery } from "../lib/functionBuilders";

const organizationRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("billing_admin"),
);

export const list = organizationQuery({
  args: {},
  handler: async (ctx) => {
    const members = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.organizationId))
      .collect();

    const results = await Promise.all(
      members.map(async (member) => {
        const profile = await ctx.db.get(member.accountId);
        return {
          id: member._id,
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

export const updateRole = organizationMutation({
  args: {
    accountId: v.id("accounts"),
    role: organizationRoleValidator,
  },
  requireAdmin: true,
  handler: async (ctx, args) => {
    const membership = await getOrganizationMembership(ctx, ctx.organizationId, args.accountId);
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

export const updateBillable = organizationMutation({
  args: {
    accountId: v.id("accounts"),
    billable: v.boolean(),
  },
  requireBillingAdmin: true,
  handler: async (ctx, args) => {
    const membership = await getOrganizationMembership(ctx, ctx.organizationId, args.accountId);
    if (!membership) {
      throw new Error("Organization member not found");
    }

    await ctx.db.patch(membership._id, {
      billable: args.billable,
      updatedAt: Date.now(),
    });

    const nextVersion = await ctx.runMutation(internal.billingInternal.bumpSeatSyncVersion, {
      organizationId: ctx.organizationId,
    });
    await ctx.scheduler.runAfter(0, internal.billingSync.syncSeatQuantity, {
      organizationId: ctx.organizationId,
      expectedVersion: nextVersion,
    });

    return { ok: true };
  },
});

export const remove = organizationMutation({
  args: {
    accountId: v.id("accounts"),
  },
  requireAdmin: true,
  handler: async (ctx, args) => {
    const membership = await getOrganizationMembership(ctx, ctx.organizationId, args.accountId);
    if (!membership) {
      throw new Error("Organization member not found");
    }

    await ctx.db.patch(membership._id, {
      status: "removed",
      updatedAt: Date.now(),
    });

    const nextVersion = await ctx.runMutation(internal.billingInternal.bumpSeatSyncVersion, {
      organizationId: ctx.organizationId,
    });
    await ctx.scheduler.runAfter(0, internal.billingSync.syncSeatQuantity, {
      organizationId: ctx.organizationId,
      expectedVersion: nextVersion,
    });

    return {
      ok: true,
      newStatus: "removed",
    };
  },
});
