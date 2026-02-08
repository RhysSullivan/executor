import { StripeSubscriptions } from "@convex-dev/stripe";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const stripeClient = new StripeSubscriptions(components.stripe, {});

export const syncSeatQuantity = internalAction({
  args: {
    organizationId: v.id("organizations"),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const snapshot = await ctx.runQuery(internal.billingInternal.getSeatSyncSnapshot, {
      organizationId: args.organizationId,
    });

    if (!snapshot || snapshot.syncVersion !== args.expectedVersion) {
      return null;
    }

    const subscription = await ctx.runQuery(components.stripe.public.getSubscriptionByOrgId, {
      orgId: String(args.organizationId),
    });

    if (!subscription) {
      await ctx.runMutation(internal.billingInternal.upsertSeatState, {
        organizationId: args.organizationId,
        desiredSeats: snapshot.desiredSeats,
        lastAppliedSeats: snapshot.lastAppliedSeats,
        syncError: "No Stripe subscription linked to organization",
        bumpVersion: false,
      });
      return null;
    }

    const quantity = Math.max(1, snapshot.desiredSeats);
    await stripeClient.updateSubscriptionQuantity(ctx, {
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      quantity,
    });

    await ctx.runMutation(internal.billingInternal.upsertSeatState, {
      organizationId: args.organizationId,
      desiredSeats: quantity,
      lastAppliedSeats: quantity,
      syncError: null,
      bumpVersion: false,
    });

    return null;
  },
});
