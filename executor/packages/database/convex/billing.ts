import { StripeSubscriptions } from "@convex-dev/stripe";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action } from "./_generated/server";
import { organizationMutation, organizationQuery } from "../../core/src/function-builders";
import {
  createCustomerPortalHandler,
  createSubscriptionCheckoutHandler,
  getBillingSummaryHandler,
  retrySeatSyncHandler,
} from "../src/billing/public-handlers";

const stripeClient = new StripeSubscriptions(components.stripe, {});

export const getSummary = organizationQuery({
  args: {},
  handler: async (ctx) => {
    return await getBillingSummaryHandler(ctx, components);
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
    return await createSubscriptionCheckoutHandler(ctx, stripeClient, internal, args);
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
    return await createCustomerPortalHandler(ctx, stripeClient, internal, components, args);
  },
});

export const retrySeatSync = organizationMutation({
  requireBillingAdmin: true,
  args: {},
  handler: async (ctx) => {
    return await retrySeatSyncHandler(ctx, internal);
  },
});
