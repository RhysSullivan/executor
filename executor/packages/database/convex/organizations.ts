import { v } from "convex/values";
import { optionalAccountQuery, authedMutation } from "../../core/src/function-builders";
import {
  createOrganizationHandler,
  getNavigationStateHandler,
  getOrganizationAccessHandler,
  listOrganizationsMineHandler,
  resolveWorkosOrganizationIdHandler,
} from "../src/organizations/handlers";

export const create = authedMutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    return await createOrganizationHandler(ctx, args);
  },
});

export const listMine = optionalAccountQuery({
  args: {},
  handler: async (ctx) => {
    return await listOrganizationsMineHandler(ctx);
  },
});

export const getNavigationState = optionalAccountQuery({
  args: {},
  handler: async (ctx) => {
    return await getNavigationStateHandler(ctx);
  },
});

export const getOrganizationAccess = optionalAccountQuery({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    return await getOrganizationAccessHandler(ctx, args);
  },
});

export const resolveWorkosOrganizationId = optionalAccountQuery({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    return await resolveWorkosOrganizationIdHandler(ctx, args);
  },
});
