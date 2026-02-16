import type { StripeSubscriptions } from "@convex-dev/stripe";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import type { ActionCtx, MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { canManageBilling, isAdminRole } from "../../../core/src/identity";

type Internal = typeof import("../../convex/_generated/api").internal;
type Components = typeof import("../../convex/_generated/api").components;

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

function canAccessBilling(role: string): boolean {
  return isAdminRole(role) || canManageBilling(role);
}

async function getBillableSeatCount(ctx: DbCtx, organizationId: Id<"organizations">): Promise<number> {
  const members = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_billable_status", (q) =>
      q.eq("organizationId", organizationId).eq("billable", true).eq("status", "active"),
    )
    .collect();
  return members.length;
}

async function getSeatState(ctx: DbCtx, organizationId: Id<"organizations">) {
  return await ctx.db
    .query("billingSeatState")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .unique();
}

export async function getBillingSummaryHandler(
  ctx: unknown,
  components: Components,
) {
  const typedCtx = ctx as QueryCtx & {
    organizationId: Id<"organizations">;
    runQuery: QueryCtx["runQuery"];
  };

  const billableMembers = await getBillableSeatCount(typedCtx, typedCtx.organizationId);
  const seatState = await getSeatState(typedCtx, typedCtx.organizationId);
  const customer = await typedCtx.db
    .query("billingCustomers")
    .withIndex("by_org", (q) => q.eq("organizationId", typedCtx.organizationId))
    .unique();

  const subscription = await typedCtx.runQuery(components.stripe.public.getSubscriptionByOrgId, {
    orgId: String(typedCtx.organizationId),
  });

  const syncStatus = seatState?.syncError ? "error" : seatState?.lastSyncAt ? "ok" : "pending";

  return {
    organizationId: String(typedCtx.organizationId),
    customer: customer
      ? {
          stripeCustomerId: customer.stripeCustomerId,
        }
      : null,
    subscription: subscription
      ? {
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          stripePriceId: subscription.priceId,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null,
    seats: {
      billableMembers,
      desiredSeats: seatState?.desiredSeats ?? billableMembers,
      lastAppliedSeats: seatState?.lastAppliedSeats ?? null,
    },
    sync: {
      status: syncStatus,
      lastSyncAt: seatState?.lastSyncAt ?? null,
      error: seatState?.syncError ?? null,
    },
  };
}

export async function createSubscriptionCheckoutHandler(
  ctx: ActionCtx,
  stripeClient: Pick<StripeSubscriptions, "createCustomer" | "createCheckoutSession">,
  internal: Internal,
  args: {
    organizationId: Id<"organizations">;
    priceId: string;
    successUrl?: string;
    cancelUrl?: string;
    sessionId?: string;
  },
) {
  const access = await ctx.runQuery(internal.billingInternal.getBillingAccessForRequest, {
    organizationId: args.organizationId,
    sessionId: args.sessionId,
  });

  if (!access || !canAccessBilling(access.role)) {
    throw new Error("Only organization admins can manage billing");
  }

  let customerId = access.customerId;
  if (!customerId) {
    const created = await stripeClient.createCustomer(ctx, {
      email: access.email ?? undefined,
      name: access.organizationName,
      metadata: {
        orgId: String(args.organizationId),
      },
      idempotencyKey: `org:${String(args.organizationId)}`,
    });
    customerId = created.customerId;

    await ctx.runMutation(internal.billingInternal.upsertCustomerLink, {
      organizationId: args.organizationId,
      stripeCustomerId: customerId,
    });
  }

  const quantity = Math.max(1, access.billableMembers);
  const successUrl =
    args.successUrl
    ?? process.env.BILLING_SUCCESS_URL
    ?? "http://localhost:4312/organization?tab=billing&success=true";
  const cancelUrl =
    args.cancelUrl
    ?? process.env.BILLING_CANCEL_URL
    ?? "http://localhost:4312/organization?tab=billing&canceled=true";

  const session = await stripeClient.createCheckoutSession(ctx, {
    priceId: args.priceId,
    customerId,
    mode: "subscription",
    quantity,
    successUrl,
    cancelUrl,
    subscriptionMetadata: {
      orgId: String(args.organizationId),
    },
  });

  await ctx.runMutation(internal.billingInternal.upsertSeatState, {
    organizationId: args.organizationId,
    desiredSeats: quantity,
    lastAppliedSeats: null,
    syncError: null,
    bumpVersion: true,
  });

  return session;
}

export async function createCustomerPortalHandler(
  ctx: ActionCtx,
  stripeClient: Pick<StripeSubscriptions, "createCustomerPortalSession">,
  internal: Internal,
  components: Components,
  args: {
    organizationId: Id<"organizations">;
    returnUrl?: string;
    sessionId?: string;
  },
): Promise<{ url: string }> {
  const access = await ctx.runQuery(internal.billingInternal.getBillingAccessForRequest, {
    organizationId: args.organizationId,
    sessionId: args.sessionId,
  });
  if (!access || !canAccessBilling(access.role)) {
    throw new Error("Only organization admins can manage billing");
  }

  let customerId = access.customerId;
  if (!customerId) {
    const subscription = await ctx.runQuery(components.stripe.public.getSubscriptionByOrgId, {
      orgId: String(args.organizationId),
    });
    customerId = subscription?.stripeCustomerId ?? null;

    if (customerId) {
      await ctx.runMutation(internal.billingInternal.upsertCustomerLink, {
        organizationId: args.organizationId,
        stripeCustomerId: customerId,
      });
    }
  }

  if (!customerId) {
    throw new Error("No Stripe customer found for this organization");
  }

  return await stripeClient.createCustomerPortalSession(ctx, {
    customerId,
    returnUrl: args.returnUrl ?? process.env.BILLING_RETURN_URL ?? "http://localhost:4312/organization?tab=billing",
  });
}

export async function retrySeatSyncHandler(
  ctx: unknown,
  internal: Internal,
) {
  const typedCtx = ctx as MutationCtx & {
    organizationId: Id<"organizations">;
    scheduler: MutationCtx["scheduler"];
  };

  const nextVersion = await typedCtx.runMutation(internal.billingInternal.bumpSeatSyncVersion, {
    organizationId: typedCtx.organizationId,
  });

  await typedCtx.scheduler.runAfter(0, internal.billingSync.syncSeatQuantity, {
    organizationId: typedCtx.organizationId,
    expectedVersion: nextVersion,
  });

  return { ok: true, queued: true };
}
