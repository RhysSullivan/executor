import type { Doc, Id } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";

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

export async function getBillingAccessForRequestHandler(ctx: unknown) {
  const typedCtx = ctx as QueryCtx & {
    account: Doc<"accounts">;
    actorMembership: Doc<"organizationMembers">;
    organizationId: Id<"organizations">;
  };

  const organization = await typedCtx.db.get(typedCtx.organizationId);
  if (!organization) {
    return null;
  }

  const billableMembers = await getBillableSeatCount(typedCtx, typedCtx.organizationId);
  const customer = await typedCtx.db
    .query("billingCustomers")
    .withIndex("by_org", (q) => q.eq("organizationId", typedCtx.organizationId))
    .unique();

  return {
    role: typedCtx.actorMembership.role,
    email: typedCtx.account.email,
    organizationName: organization.name,
    billableMembers,
    customerId: customer?.stripeCustomerId ?? null,
  };
}

export async function getSeatSyncSnapshotHandler(
  ctx: QueryCtx,
  args: { organizationId: Id<"organizations"> },
) {
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
}

export async function upsertCustomerLinkHandler(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; stripeCustomerId: string },
) {
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
}

export async function bumpSeatSyncVersionHandler(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations"> },
) {
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
}

export async function upsertSeatStateHandler(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    desiredSeats: number;
    lastAppliedSeats: number | null;
    syncError: string | null;
    bumpVersion: boolean;
  },
) {
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
}
