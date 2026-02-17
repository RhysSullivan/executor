import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel.d.ts";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { organizationMutation, organizationQuery } from "../../core/src/function-builders";
import {
  createWorkosOrganization,
  ensureWorkosOrganizationMembership,
  mapRoleToWorkosRoleSlug,
  revokeWorkosInvitation,
  sendWorkosInvitation,
  updateWorkosOrganizationName,
  workosEnabled,
} from "../src/invites/workos";
import { normalizePersonalOrganizationName } from "../src/invites/normalize";
import { safeRunAfter } from "../src/lib/scheduler";

const organizationRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("billing_admin"),
);

export const list = organizationQuery({
  method: "GET",
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
  method: "POST",
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

    const normalizedOrganizationName = normalizePersonalOrganizationName(String(organization.name));
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

    const inviteId = await ctx.db.insert("invites", {
      organizationId: ctx.organizationId,
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      email: normalizedEmail,
      role: args.role,
      status: "pending",
      invitedByAccountId: ctx.account._id,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    await safeRunAfter(ctx.scheduler, 0, internal.invites.deliverWorkosInvite, {
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
    let workosOrgId = context.organization.workosOrgId ?? null;
    let createdWorkosOrganization = false;

    try {
      if (!workosOrgId) {
        const created = await createWorkosOrganization(organizationName);
        workosOrgId = created.id;
        createdWorkosOrganization = true;

        await ctx.runMutation(internal.invites.linkOrganizationToWorkos, {
          organizationId: context.organization._id,
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
  method: "POST",
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
      await safeRunAfter(ctx.scheduler, 0, internal.invites.revokeWorkosInvite, {
        inviteId: invite._id as Id<"invites">,
        providerInviteId: String(invite.providerInviteId),
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
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.organizationId, {
      workosOrgId: args.workosOrgId,
      updatedAt: Date.now(),
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
