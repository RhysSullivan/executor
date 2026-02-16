import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internalOrganizationQuery } from "../../core/src/function-builders";
import {
  bumpSeatSyncVersionHandler,
  getBillingAccessForRequestHandler,
  getSeatSyncSnapshotHandler,
  upsertCustomerLinkHandler,
  upsertSeatStateHandler,
} from "../src/billing/internal-handlers";

export const getBillingAccessForRequest = internalOrganizationQuery({
  args: {},
  handler: async (ctx) => {
    return await getBillingAccessForRequestHandler(ctx);
  },
});

export const getSeatSyncSnapshot = internalQuery({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    return await getSeatSyncSnapshotHandler(ctx, args);
  },
});

export const upsertCustomerLink = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    stripeCustomerId: v.string(),
  },
  handler: async (ctx, args) => {
    return await upsertCustomerLinkHandler(ctx, args);
  },
});

export const bumpSeatSyncVersion = internalMutation({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    return await bumpSeatSyncVersionHandler(ctx, args);
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
    return await upsertSeatStateHandler(ctx, args);
  },
});
