import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { organizationMutation, organizationQuery } from "../lib/functionBuilders";

const workosEnabled = Boolean(process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY);
const workosClient = process.env.WORKOS_API_KEY ? new WorkOS(process.env.WORKOS_API_KEY) : null;
type OrganizationRole = "owner" | "admin" | "member" | "billing_admin";

const organizationRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("billing_admin"),
);

type WorkosInvitationResponse = {
  id: string;
  state: string;
  expires_at?: string;
};

function requireWorkosClient(): WorkOS {
  if (!workosClient) {
    throw new Error("WORKOS_API_KEY is required for WorkOS invite operations");
  }
  return workosClient;
}

async function sendWorkosInvitation(args: {
  email: string;
  workosOrgId: string;
  inviterWorkosUserId: string;
  expiresInDays?: number;
  roleSlug?: string;
}): Promise<WorkosInvitationResponse> {
  const workos = requireWorkosClient();
  const invitation = await workos.userManagement.sendInvitation({
    email: args.email,
    organizationId: args.workosOrgId,
    inviterUserId: args.inviterWorkosUserId,
    expiresInDays: args.expiresInDays,
    roleSlug: args.roleSlug,
  });

  return {
    id: invitation.id,
    state: invitation.state,
    expires_at: invitation.expiresAt ?? undefined,
  };
}

async function createWorkosOrganization(name: string): Promise<{ id: string }> {
  const workos = requireWorkosClient();
  const organization = await workos.organizations.createOrganization({ name });
  return {
    id: organization.id,
  };
}

async function updateWorkosOrganizationName(workosOrgId: string, name: string): Promise<void> {
  const workos = requireWorkosClient();
  await workos.organizations.updateOrganization({
    organization: workosOrgId,
    name,
  });
}

function isDuplicateWorkosMembershipError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("already") && (message.includes("membership") || message.includes("organization"));
}

async function ensureWorkosOrganizationMembership(args: { workosOrgId: string; workosUserId: string }): Promise<void> {
  const workos = requireWorkosClient();

  try {
    await workos.userManagement.createOrganizationMembership({
      organizationId: args.workosOrgId,
      userId: args.workosUserId,
    });
  } catch (error) {
    if (isDuplicateWorkosMembershipError(error)) {
      return;
    }
    throw error;
  }
}

async function revokeWorkosInvitation(invitationId: string): Promise<void> {
  const workos = requireWorkosClient();
  await workos.userManagement.revokeInvitation(invitationId);
}

function mapRoleToWorkosRoleSlug(role: OrganizationRole): string | undefined {
  if (role === "admin" || role === "owner") {
    return "admin";
  }
  if (role === "member") {
    return "member";
  }
  return undefined;
}

function normalizePersonalOrganizationName(name: string): string {
  const match = name.match(/^(.*)'s Workspace$/i);
  if (!match) {
    return name;
  }
  const ownerName = match[1]?.trim();
  if (!ownerName) {
    return name;
  }
  return `${ownerName}'s Organization`;
}

export const list = organizationQuery({
  requireAdmin: true,
  args: {},
  handler: async (ctx) => {
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.organizationId))
      .order("desc")
      .take(200);

    return {
      items: invites.map((invite) => ({
        id: invite._id,
        organizationId: invite.organizationId,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
      })),
    };
  },
});

export const create = organizationMutation({
  requireAdmin: true,
  args: {
    email: v.string(),
    role: organizationRoleValidator,
    workspaceId: v.optional(v.id("workspaces")),
    expiresInDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!workosEnabled) {
      throw new Error("Invites require WorkOS auth to be enabled");
    }

    const now = Date.now();
    const organization = await ctx.db.get(ctx.organizationId);
    if (!organization) {
      throw new Error("Organization not found");
    }

    const normalizedOrganizationName = normalizePersonalOrganizationName(organization.name);
    if (normalizedOrganizationName !== organization.name) {
      await ctx.db.patch(ctx.organizationId, {
        name: normalizedOrganizationName,
        updatedAt: now,
      });
    }

    const expiresAt = now + (args.expiresInDays ?? 7) * 24 * 60 * 60 * 1000;
    const normalizedEmail = args.email.toLowerCase().trim();

    if (args.workspaceId) {
      const workspace = await ctx.db.get(args.workspaceId);
      if (workspace?.organizationId !== ctx.organizationId) {
        throw new Error("Workspace does not belong to this organization");
      }
    }

    if (ctx.account.provider !== "workos") {
      throw new Error("Inviter is not linked to WorkOS");
    }
    const inviterWorkosUserId = ctx.account.providerAccountId;

    const provider = "workos";

    const inviteId = await ctx.db.insert("invites", {
      organizationId: ctx.organizationId,
      workspaceId: args.workspaceId,
      email: normalizedEmail,
      role: args.role,
      status: "pending",
      provider,
      invitedByAccountId: ctx.account._id,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.invites.deliverWorkosInvite, {
      inviteId,
      inviterWorkosUserId,
      expiresInDays: args.expiresInDays,
      roleSlug: mapRoleToWorkosRoleSlug(args.role),
    });

    const invite = await ctx.db.get(inviteId);
    if (!invite) {
      throw new Error("Failed to create invite");
    }

    return {
      invite: {
        id: invite._id,
        organizationId: invite.organizationId,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expiresAt,
      },
      delivery: {
        provider,
        providerInviteId: invite.providerInviteId ?? null,
        state: "queued",
      },
    };
  },
});

export const deliverWorkosInvite = internalAction({
  args: {
    inviteId: v.id("invites"),
    inviterWorkosUserId: v.string(),
    expiresInDays: v.optional(v.number()),
    roleSlug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.invites.getInviteDeliveryContext, {
      inviteId: args.inviteId,
    });
    if (!context || context.invite.status !== "pending") {
      return;
    }

    const organizationName = normalizePersonalOrganizationName(context.organization.name);
    let workosOrgId = context.organization.workosOrgId ?? context.workspace?.workosOrgId ?? null;
    let createdWorkosOrganization = false;

    try {
      if (!workosOrgId) {
        const created = await createWorkosOrganization(organizationName);
        workosOrgId = created.id;
        createdWorkosOrganization = true;

        await ctx.runMutation(internal.invites.linkOrganizationToWorkos, {
          organizationId: context.organization._id,
          workspaceId: context.workspace?._id,
          workosOrgId,
        });
      }

      if (!workosOrgId) {
        throw new Error("Failed to resolve WorkOS organization");
      }

      if (createdWorkosOrganization) {
        await ensureWorkosOrganizationMembership({
          workosOrgId,
          workosUserId: args.inviterWorkosUserId,
        });
      }

      await updateWorkosOrganizationName(workosOrgId, organizationName);

      const response = await sendWorkosInvitation({
        email: context.invite.email,
        workosOrgId,
        inviterWorkosUserId: args.inviterWorkosUserId,
        expiresInDays: args.expiresInDays,
        roleSlug: args.roleSlug,
      });

      await ctx.runMutation(internal.invites.markInviteDelivered, {
        inviteId: args.inviteId,
        providerInviteId: response.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown WorkOS invite error";
      await ctx.runMutation(internal.invites.markInviteDeliveryFailed, {
        inviteId: args.inviteId,
        errorMessage: message,
      });
    }
  },
});

export const revoke = organizationMutation({
  requireAdmin: true,
  args: {
    inviteId: v.id("invites"),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.organizationId !== ctx.organizationId) {
      throw new Error("Invite not found");
    }

    if (invite.status !== "pending" && invite.status !== "failed") {
      throw new Error("Only pending invites can be removed");
    }

    await ctx.db.patch(args.inviteId, {
      status: "revoked",
      updatedAt: Date.now(),
    });

    if (invite.providerInviteId) {
      await ctx.scheduler.runAfter(0, internal.invites.revokeWorkosInvite, {
        inviteId: invite._id,
        providerInviteId: invite.providerInviteId,
      });
    }

    return { ok: true };
  },
});

export const revokeWorkosInvite = internalAction({
  args: {
    inviteId: v.id("invites"),
    providerInviteId: v.string(),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.runQuery(internal.invites.getInviteById, {
      inviteId: args.inviteId,
    });
    if (!invite || invite.status !== "revoked") {
      return;
    }

    await revokeWorkosInvitation(args.providerInviteId);
  },
});

export const getInviteDeliveryContext = internalQuery({
  args: {
    inviteId: v.id("invites"),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) {
      return null;
    }

    const organization = await ctx.db.get(invite.organizationId);
    if (!organization) {
      return null;
    }

    const workspace = invite.workspaceId ? await ctx.db.get(invite.workspaceId) : null;

    return {
      invite,
      organization,
      workspace,
    };
  },
});

export const linkOrganizationToWorkos = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    workspaceId: v.optional(v.id("workspaces")),
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    await ctx.db.patch(args.organizationId, {
      workosOrgId: args.workosOrgId,
      updatedAt: now,
    });

    const workspace = args.workspaceId
      ? await ctx.db.get(args.workspaceId)
      : await ctx.db
        .query("workspaces")
        .withIndex("by_organization_created", (q) => q.eq("organizationId", args.organizationId))
        .first();

    if (!workspace || workspace.organizationId !== args.organizationId) {
      return;
    }

    await ctx.db.patch(workspace._id, {
      workosOrgId: args.workosOrgId,
      updatedAt: now,
    });
  },
});

export const getInviteById = internalQuery({
  args: {
    inviteId: v.id("invites"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.inviteId);
  },
});

export const markInviteDelivered = internalMutation({
  args: {
    inviteId: v.id("invites"),
    providerInviteId: v.string(),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.status !== "pending") {
      return;
    }

    await ctx.db.patch(args.inviteId, {
      providerInviteId: args.providerInviteId,
      updatedAt: Date.now(),
    });
  },
});

export const markInviteDeliveryFailed = internalMutation({
  args: {
    inviteId: v.id("invites"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    void args.errorMessage;
    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.status !== "pending") {
      return;
    }

    await ctx.db.patch(args.inviteId, {
      status: "failed",
      updatedAt: Date.now(),
    });
  },
});
