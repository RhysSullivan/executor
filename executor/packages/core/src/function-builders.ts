import { v } from "convex/values";
import {
  customAction as convexCustomAction,
  customMutation as convexCustomMutation,
  customQuery as convexCustomQuery,
} from "convex-helpers/server/customFunctions";
import { action, internalQuery, mutation, query } from "../../database/convex/_generated/server";
import {
  canManageBilling,
  getOrganizationMembership,
  isAdminRole,
  requireWorkspaceAccessForRequest,
  resolveAccountForRequest,
} from "./identity";

export type OpenApiMethod = "GET" | "POST";

type QueryMethodOptions = {
  method: "GET";
};

type MutationMethodOptions = {
  method: "POST";
};

type ActionMethodOptions = {
  method: "POST";
};

type WorkspaceAccessOptions = {
  method: OpenApiMethod;
  requireAdmin?: boolean;
};

type OrganizationAccessOptions = {
  method: OpenApiMethod;
  requireAdmin?: boolean;
  requireBillingAdmin?: boolean;
};

type InternalOrganizationAccessOptions = Omit<OrganizationAccessOptions, "method">;

function ensureOrganizationRole(
  role: string,
  options: Pick<OrganizationAccessOptions, "requireAdmin" | "requireBillingAdmin">,
): void {
  if (options.requireAdmin && !isAdminRole(role)) {
    throw new Error("Only organization admins can perform this action");
  }

  if (options.requireBillingAdmin && !isAdminRole(role) && !canManageBilling(role)) {
    throw new Error("Only organization billing admins can perform this action");
  }
}

function ensureWorkspaceRole(role: string, options: Pick<WorkspaceAccessOptions, "requireAdmin">): void {
  if (options.requireAdmin && !isAdminRole(role)) {
    throw new Error("Only organization admins can perform this action");
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

export const customQuery = convexCustomQuery(query, {
  args: {},
  input: async (_ctx, _args, _options: QueryMethodOptions) => ({
    ctx: {},
    args: {},
  }),
});

export const customMutation = convexCustomMutation(mutation, {
  args: {},
  input: async (_ctx, _args, _options: MutationMethodOptions) => ({
    ctx: {},
    args: {},
  }),
});

export const customAction = convexCustomAction(action, {
  args: {},
  input: async (_ctx, _args, _options: ActionMethodOptions) => ({
    ctx: {},
    args: {},
  }),
});

export const authedQuery = convexCustomQuery(query, {
  args: {
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, _options: QueryMethodOptions = { method: "GET" }) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    return {
      ctx: { account },
      args: {},
    };
  },
});

export const optionalAccountQuery = convexCustomQuery(query, {
  args: {
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, _options: QueryMethodOptions = { method: "GET" }) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    return {
      ctx: { account, sessionId: args.sessionId },
      args: {},
    };
  },
});

export const authedMutation = convexCustomMutation(mutation, {
  args: {
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, _options: MutationMethodOptions = { method: "POST" }) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    return {
      ctx: { account },
      args: {},
    };
  },
});

export const organizationQuery = convexCustomQuery(query, {
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: OrganizationAccessOptions = { method: "GET" }) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    const accountMembership = await getOrganizationMembership(ctx, args.organizationId, account._id);

    if (!accountMembership || accountMembership.status !== "active") {
      throw new Error("You are not a member of this organization");
    }

    const organization = await ctx.db.get(args.organizationId);
    if (!organization || organization.status !== "active") {
      throw new Error("Organization is inactive");
    }

    ensureOrganizationRole(accountMembership.role, options);

    return {
      ctx: {
        account,
        accountMembership,
        organizationId: args.organizationId,
      },
      args: {},
    };
  },
});

export const organizationMutation = convexCustomMutation(mutation, {
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: OrganizationAccessOptions = { method: "POST" }) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    const accountMembership = await getOrganizationMembership(ctx, args.organizationId, account._id);

    if (!accountMembership || accountMembership.status !== "active") {
      throw new Error("You are not a member of this organization");
    }

    const organization = await ctx.db.get(args.organizationId);
    if (!organization || organization.status !== "active") {
      throw new Error("Organization is inactive");
    }

    ensureOrganizationRole(accountMembership.role, options);

    return {
      ctx: {
        account,
        accountMembership,
        organizationId: args.organizationId,
      },
      args: {},
    };
  },
});

export const workspaceQuery = convexCustomQuery(query, {
  args: {
    workspaceId: v.id("workspaces"),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: WorkspaceAccessOptions = { method: "GET" }) => {
    const access = await requireWorkspaceAccessForRequest(ctx, args.workspaceId, args.sessionId);

    ensureWorkspaceRole(access.organizationMembership.role, options);

    return {
      ctx: {
        ...access,
        workspaceId: args.workspaceId,
      },
      args: {},
    };
  },
});

export const workspaceMutation = convexCustomMutation(mutation, {
  args: {
    workspaceId: v.id("workspaces"),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: WorkspaceAccessOptions = { method: "POST" }) => {
    const access = await requireWorkspaceAccessForRequest(ctx, args.workspaceId, args.sessionId);

    ensureWorkspaceRole(access.organizationMembership.role, options);

    return {
      ctx: {
        ...access,
        workspaceId: args.workspaceId,
      },
      args: {},
    };
  },
});

export const internalOrganizationQuery = convexCustomQuery(internalQuery, {
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  input: async (ctx, args, options: InternalOrganizationAccessOptions = {}) => {
    const account = await requireAccountFromSession(ctx, args.sessionId);
    const accountMembership = await getOrganizationMembership(ctx, args.organizationId, account._id);

    if (!accountMembership || accountMembership.status !== "active") {
      throw new Error("You are not a member of this organization");
    }

    const organization = await ctx.db.get(args.organizationId);
    if (!organization || organization.status !== "active") {
      throw new Error("Organization is inactive");
    }

    ensureOrganizationRole(accountMembership.role, options);

    return {
      ctx: {
        account,
        accountMembership,
        organizationId: args.organizationId,
      },
      args: {},
    };
  },
});
