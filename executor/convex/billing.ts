import { StripeSubscriptions } from "@convex-dev/stripe";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { components, internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, mutation, query } from "./_generated/server";
import { canManageBilling, getOrganizationMembership, isAdminRole, requireAccountForRequest } from "./lib/identity";

const stripeClient = new StripeSubscriptions(components.stripe, {});

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

export const getSummary = query({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await requireAccountForRequest(ctx, args.sessionId);
    const membership = await getOrganizationMembership(ctx, args.organizationId, account._id);
    if (!membership || membership.status !== "active") {
      throw new Error("You are not a member of this organization");
    }

    const billableMembers = await getBillableSeatCount(ctx, args.organizationId);
    const seatState = await getSeatState(ctx, args.organizationId);
    const customer = await ctx.db
      .query("billingCustomers")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .unique();

    const subscription = await ctx.runQuery(components.stripe.public.getSubscriptionByOrgId, {
      orgId: String(args.organizationId),
    });

    const syncStatus = seatState?.syncError ? "error" : seatState?.lastSyncAt ? "ok" : "pending";

    return {
      organizationId: String(args.organizationId),
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
  },
});

export const createSubscriptionCheckout = action({
  args: {
    organizationId: v.id("organizations"),
    priceId: v.string(),
    successUrl: v.optional(v.string()),
    cancelUrl: v.optional(v.string()),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
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
    const successUrl = args.successUrl ?? process.env.BILLING_SUCCESS_URL ?? "http://localhost:3000/billing?success=true";
    const cancelUrl = args.cancelUrl ?? process.env.BILLING_CANCEL_URL ?? "http://localhost:3000/billing?canceled=true";

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
  },
});

export const createCustomerPortal = action({
  args: {
    organizationId: v.id("organizations"),
    returnUrl: v.optional(v.string()),
    sessionId: v.optional(v.string()),
  },
  returns: v.object({
    url: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const access: {
      role: string;
      email: string;
      organizationName: string;
      billableMembers: number;
      customerId: string | null;
    } | null = await ctx.runQuery(internal.billingInternal.getBillingAccessForRequest, {
      organizationId: args.organizationId,
      sessionId: args.sessionId,
    });
    if (!access || !canAccessBilling(access.role)) {
      throw new Error("Only organization admins can manage billing");
    }

    let customerId: string | null = access.customerId;
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
      returnUrl: args.returnUrl ?? process.env.BILLING_RETURN_URL ?? "http://localhost:3000/billing",
    });
  },
});

export const retrySeatSync = mutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await requireAccountForRequest(ctx, args.sessionId);
    const membership = await getOrganizationMembership(ctx, args.organizationId, account._id);
    if (!membership || membership.status !== "active" || !canAccessBilling(membership.role)) {
      throw new Error("Only organization admins can manage billing");
    }

    const nextVersion = await ctx.runMutation(internal.billingInternal.bumpSeatSyncVersion, {
      organizationId: args.organizationId,
    });

    await ctx.scheduler.runAfter(0, internal.billingSync.syncSeatQuantity, {
      organizationId: args.organizationId,
      expectedVersion: nextVersion,
    });

    return { ok: true, queued: true };
  },
});
