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
  method: "POST",
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    return await createOrganizationHandler(ctx, args);
  },
});

export const listMine = optionalAccountQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    return await listOrganizationsMineHandler(ctx);
  },
});

export const getNavigationState = optionalAccountQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => {
    return await getNavigationStateHandler(ctx);
  },
});

export const getOrganizationAccess = optionalAccountQuery({
  method: "GET",
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    return await getOrganizationAccessHandler(ctx, args);
  },
});

export const resolveWorkosOrganizationId = optionalAccountQuery({
  method: "GET",
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    return await resolveWorkosOrganizationIdHandler(ctx, args);
  },
});
