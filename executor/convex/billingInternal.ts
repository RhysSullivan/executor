import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { internalOrganizationQuery } from "./lib/functionBuilders";

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

async function getBillableSeatCount(ctx: DbCtx, organizationId: Id<"organizations">): Promise<number> {
  const members = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_billable_status", (q) =>
      q.eq("organizationId", organizationId).eq("billable", true).eq("status", "active"),
    )
    .collect();
  return members.length;
}

async function getSeatState(
  ctx: DbCtx,
  organizationId: Id<"organizations">,
): Promise<Doc<"billingSeatState"> | null> {
  return await ctx.db
    .query("billingSeatState")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .unique();
}

export const getBillingAccessForRequest = internalOrganizationQuery({
  args: {},
  handler: async (ctx) => {
    const organization = await ctx.db.get(ctx.organizationId);
    if (!organization) {
      return null;
    }

    const billableMembers = await getBillableSeatCount(ctx, ctx.organizationId);
    const customer = await ctx.db
      .query("billingCustomers")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.organizationId))
      .unique();

    return {
      role: ctx.actorMembership.role,
      email: ctx.account.email,
      organizationName: organization.name,
      billableMembers,
      customerId: customer?.stripeCustomerId ?? null,
    };
  },
});

export const getSeatSyncSnapshot = internalQuery({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const desiredSeats = await getBillableSeatCount(ctx, args.organizationId);
    const seatState = await getSeatState(ctx, args.organizationId);
    if (!seatState) {
      return {
        desiredSeats,
        lastAppliedSeats: null,
        syncVersion: 1,
      };
    }

    return {
      desiredSeats,
      lastAppliedSeats: seatState.lastAppliedSeats ?? null,
      syncVersion: seatState.syncVersion,
    };
  },
});

export const upsertCustomerLink = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    stripeCustomerId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("billingCustomers")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .unique();
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        stripeCustomerId: args.stripeCustomerId,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("billingCustomers", {
      organizationId: args.organizationId,
      stripeCustomerId: args.stripeCustomerId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const bumpSeatSyncVersion = internalMutation({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const existing = await getSeatState(ctx, args.organizationId);
    const desiredSeats = await getBillableSeatCount(ctx, args.organizationId);
    const now = Date.now();

    if (existing) {
      const nextVersion = existing.syncVersion + 1;
      await ctx.db.patch(existing._id, {
        desiredSeats,
        syncVersion: nextVersion,
        syncError: undefined,
        updatedAt: now,
      });
      return nextVersion;
    }

    await ctx.db.insert("billingSeatState", {
      organizationId: args.organizationId,
      desiredSeats,
      lastAppliedSeats: undefined,
      syncVersion: 1,
      lastSyncAt: undefined,
      syncError: undefined,
      updatedAt: now,
    });

    return 1;
  },
});

export const upsertSeatState = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    desiredSeats: v.number(),
    lastAppliedSeats: v.union(v.number(), v.null()),
    syncError: v.union(v.string(), v.null()),
    bumpVersion: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await getSeatState(ctx, args.organizationId);
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        desiredSeats: args.desiredSeats,
        lastAppliedSeats: args.lastAppliedSeats ?? undefined,
        syncVersion: args.bumpVersion ? existing.syncVersion + 1 : existing.syncVersion,
        lastSyncAt: now,
        syncError: args.syncError ?? undefined,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("billingSeatState", {
      organizationId: args.organizationId,
      desiredSeats: args.desiredSeats,
      lastAppliedSeats: args.lastAppliedSeats ?? undefined,
      syncVersion: 1,
      lastSyncAt: now,
      syncError: args.syncError ?? undefined,
      updatedAt: now,
    });
  },
});
