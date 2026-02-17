import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getOrganizationMembership } from "../../core/src/identity";
import { organizationMutation, organizationQuery } from "../../core/src/function-builders";
import { upsertOrganizationMembership } from "../src/auth/memberships";
import { safeRunAfter } from "../src/lib/scheduler";

const organizationRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("billing_admin"),
);

export const list = organizationQuery({
  method: "GET",
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
  method: "POST",
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

    await upsertOrganizationMembership(ctx, {
      organizationId: ctx.organizationId,
      accountId: args.accountId,
      role: args.role,
      status: membership.status,
      billable: membership.billable,
      invitedByAccountId: membership.invitedByAccountId,
      now: Date.now(),
    });

    return { ok: true };
  },
});

export const updateBillable = organizationMutation({
  method: "POST",
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
    await safeRunAfter(ctx.scheduler, 0, internal.billingSync.syncSeatQuantity, {
      organizationId: ctx.organizationId,
      expectedVersion: nextVersion,
    });

    return { ok: true };
  },
});

export const remove = organizationMutation({
  method: "POST",
  args: {
    accountId: v.id("accounts"),
  },
  requireAdmin: true,
  handler: async (ctx, args) => {
    const membership = await getOrganizationMembership(ctx, ctx.organizationId, args.accountId);
    if (!membership) {
      throw new Error("Organization member not found");
    }

    await upsertOrganizationMembership(ctx, {
      organizationId: ctx.organizationId,
      accountId: args.accountId,
      role: membership.role,
      status: "removed",
      billable: false,
      invitedByAccountId: membership.invitedByAccountId,
      now: Date.now(),
    });

    const nextVersion = await ctx.runMutation(internal.billingInternal.bumpSeatSyncVersion, {
      organizationId: ctx.organizationId,
    });
    await safeRunAfter(ctx.scheduler, 0, internal.billingSync.syncSeatQuantity, {
      organizationId: ctx.organizationId,
      expectedVersion: nextVersion,
    });

    return {
      ok: true,
      newStatus: "removed",
    };
  },
});
