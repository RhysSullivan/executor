import { v } from "convex/values";
import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { internalQuery, mutation, query } from "../convex/_generated/server";
import {
  canManageBilling,
  getOrganizationMembership,
  isAdminRole,
  requireWorkspaceAccessForRequest,
  resolveAccountForRequest,
} from "./identity";

type WorkspaceAccessOptions = {
  requireAdmin?: boolean;
};

type OrganizationAccessOptions = {
  requireAdmin?: boolean;
  requireBillingAdmin?: boolean;
};

function ensureOrganizationRole(role: string, options: OrganizationAccessOptions): void {
  if (options.requireAdmin && !isAdminRole(role)) {
    throw new Error("Only organization admins can perform this action");
  }

  if (options.requireBillingAdmin && !isAdminRole(role) && !canManageBilling(role)) {
    throw new Error("Only organization billing admins can perform this action");
  }
}

function ensureWorkspaceRole(role: string, options: WorkspaceAccessOptions): void {
  if (options.requireAdmin && !isAdminRole(role)) {
    throw new Error("Only workspace admins can perform this action");
  }
}

async function requireAccountFromSession(
  ctx: Parameters<typeof resolveAccountForRequest>[0],
  sessionId?: string,
) {
  const account = await resolveAccountForRequest(ctx, sessionId);
  if (!account) {
    throw new Error("Must be signed in");
  }
  return account;
}

export const authedQuery = customQuery(query, {
  args: {
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    return {
      ctx: { account },
      args: {},
    };
  },
});

export const optionalAccountQuery = customQuery(query, {
  args: {
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    return {
      ctx: { account, sessionId: args.sessionId },
      args: {},
    };
  },
});

export const authedMutation = customMutation(mutation, {
  args: {
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    return {
      ctx: { account },
      args: {},
    };
  },
});

export const organizationQuery = customQuery(query, {
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: OrganizationAccessOptions = {}) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    const actorMembership = await getOrganizationMembership(ctx, args.organizationId, account._id);

    if (!actorMembership || actorMembership.status !== "active") {
      throw new Error("You are not a member of this organization");
    }

    ensureOrganizationRole(actorMembership.role, options);

    return {
      ctx: {
        account,
        actorMembership,
        organizationId: args.organizationId,
      },
      args: {},
    };
  },
});

export const organizationMutation = customMutation(mutation, {
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: OrganizationAccessOptions = {}) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    const actorMembership = await getOrganizationMembership(ctx, args.organizationId, account._id);

    if (!actorMembership || actorMembership.status !== "active") {
      throw new Error("You are not a member of this organization");
    }

    ensureOrganizationRole(actorMembership.role, options);

    return {
      ctx: {
        account,
        actorMembership,
        organizationId: args.organizationId,
      },
      args: {},
    };
  },
});

export const workspaceQuery = customQuery(query, {
  args: {
    workspaceId: v.string(),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: WorkspaceAccessOptions = {}) => {
    const access = await requireWorkspaceAccessForRequest(ctx, args.workspaceId, args.sessionId);

    ensureWorkspaceRole(access.workspaceMembership.role, options);

    return {
      ctx: {
        ...access,
        workspaceId: args.workspaceId,
      },
      args: {},
    };
  },
});

export const workspaceMutation = customMutation(mutation, {
  args: {
    workspaceId: v.string(),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: WorkspaceAccessOptions = {}) => {
    const access = await requireWorkspaceAccessForRequest(ctx, args.workspaceId, args.sessionId);

    ensureWorkspaceRole(access.workspaceMembership.role, options);

    return {
      ctx: {
        ...access,
        workspaceId: args.workspaceId,
      },
      args: {},
    };
  },
});

export const internalOrganizationQuery = customQuery(internalQuery, {
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: OrganizationAccessOptions = {}) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    const actorMembership = await getOrganizationMembership(ctx, args.organizationId, account._id);

    if (!actorMembership || actorMembership.status !== "active") {
      throw new Error("You are not a member of this organization");
    }

    ensureOrganizationRole(actorMembership.role, options);

    return {
      ctx: {
        account,
        actorMembership,
        organizationId: args.organizationId,
      },
      args: {},
    };
  },
});
