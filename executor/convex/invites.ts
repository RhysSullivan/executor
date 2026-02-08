import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { getOrganizationMembership } from "./lib/identity";
import { authedMutation, organizationMutation, organizationQuery } from "./lib/functionBuilders";

const workosEnabled = Boolean(process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY);

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

type WorkosInvitationResponse = {
  id: string;
  state: string;
  expires_at?: string;
};

async function revokeWorkosInvitation(invitationId: string): Promise<void> {
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey) {
    throw new Error("WORKOS_API_KEY is required to revoke invites");
  }

  const response = await fetch(`https://api.workos.com/user_management/invitations/${invitationId}/revoke`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`WorkOS invitation revoke failed: ${response.status} ${message}`);
  }
}

async function sendWorkosInvitation(args: {
  email: string;
  workosOrgId: string;
  inviterWorkosUserId: string;
  expiresInDays?: number;
  roleSlug?: string;
}): Promise<WorkosInvitationResponse> {
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey) {
    throw new Error("WORKOS_API_KEY is required to send invites");
  }

  const payload: {
    email: string;
    organization_id: string;
    inviter_user_id: string;
    expires_in_days?: number;
    role_slug?: string;
  } = {
    email: args.email,
    organization_id: args.workosOrgId,
    inviter_user_id: args.inviterWorkosUserId,
  };
  if (args.expiresInDays !== undefined) {
    payload.expires_in_days = args.expiresInDays;
  }
  if (args.roleSlug) {
    payload.role_slug = args.roleSlug;
  }

  const response = await fetch("https://api.workos.com/user_management/invitations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`WorkOS invitation failed: ${response.status} ${message}`);
  }

  return (await response.json()) as WorkosInvitationResponse;
}

function mapRoleToWorkosRoleSlug(role: string): string | undefined {
  if (role === "admin" || role === "owner") {
    return "admin";
  }
  if (role === "member") {
    return "member";
  }
  return undefined;
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
        organizationId: String(invite.organizationId),
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
    role: v.string(),
    workspaceId: v.optional(v.id("workspaces")),
    expiresInDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!workosEnabled) {
      throw new Error("Invites require WorkOS auth to be enabled");
    }

    const now = Date.now();
    const expiresAt = now + (args.expiresInDays ?? 7) * 24 * 60 * 60 * 1000;
    const normalizedEmail = args.email.toLowerCase().trim();

    const organization = await ctx.db.get(ctx.organizationId);
    if (!organization) {
      throw new Error("Organization not found");
    }

    let workosOrgId = organization.workosOrgId;
    if (!workosOrgId && args.workspaceId) {
      const workspace = await ctx.db.get(args.workspaceId);
      if (workspace?.organizationId !== ctx.organizationId) {
        throw new Error("Workspace does not belong to this organization");
      }

      if (workspace.workosOrgId) {
        workosOrgId = workspace.workosOrgId;
        await ctx.db.patch(ctx.organizationId, {
          workosOrgId,
          updatedAt: now,
        });
      }
    }

    if (!workosOrgId) {
      throw new Error("Organization is not linked to WorkOS yet");
    }

    const inviterWorkosUserId = ctx.account.provider === "workos"
      ? ctx.account.providerAccountId
      : (await ctx.db
          .query("accountIdentities")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.account._id))
          .filter((q) => q.eq(q.field("provider"), "workos"))
          .first())?.providerUserId;

    if (!inviterWorkosUserId) {
      throw new Error("Inviter is not linked to WorkOS");
    }

    const token = `invite_${crypto.randomUUID()}`;
    const tokenHash = await sha256Hex(token);
    const provider = "workos";

    const inviteId = await ctx.db.insert("invites", {
      organizationId: ctx.organizationId,
      workspaceId: args.workspaceId,
      email: normalizedEmail,
      role: args.role,
      status: "pending",
      tokenHash,
      provider,
      invitedByAccountId: ctx.account._id,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.invites.deliverWorkosInvite, {
      inviteId,
      email: normalizedEmail,
      workosOrgId,
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
        id: String(invite._id),
        organizationId: String(invite.organizationId),
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expiresAt,
        token,
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
    email: v.string(),
    workosOrgId: v.string(),
    inviterWorkosUserId: v.string(),
    expiresInDays: v.optional(v.number()),
    roleSlug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.runQuery(internal.invites.getInviteById, {
      inviteId: args.inviteId,
    });
    if (!invite || invite.status !== "pending") {
      return;
    }

    try {
      const response = await sendWorkosInvitation({
        email: args.email,
        workosOrgId: args.workosOrgId,
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

export const accept = authedMutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);

    const invite = await ctx.db
      .query("invites")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();

    if (!invite || invite.status !== "pending") {
      throw new Error("Invite is invalid or expired");
    }
    if (invite.expiresAt < Date.now()) {
      await ctx.db.patch(invite._id, {
        status: "expired",
        updatedAt: Date.now(),
      });
      throw new Error("Invite has expired");
    }

    const existing = await getOrganizationMembership(ctx, invite.organizationId, ctx.account._id);
    if (existing) {
      await ctx.db.patch(existing._id, {
        role: invite.role,
        status: "active",
        joinedAt: existing.joinedAt ?? Date.now(),
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("organizationMembers", {
        organizationId: invite.organizationId,
        accountId: ctx.account._id,
        role: invite.role,
        status: "active",
        billable: true,
        invitedByAccountId: invite.invitedByAccountId,
        joinedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(invite._id, {
      status: "accepted",
      acceptedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const nextVersion = await ctx.runMutation(internal.billingInternal.bumpSeatSyncVersion, {
      organizationId: invite.organizationId,
    });
    await ctx.scheduler.runAfter(0, internal.billingSync.syncSeatQuantity, {
      organizationId: invite.organizationId,
      expectedVersion: nextVersion,
    });

    return {
      ok: true,
      organizationId: String(invite.organizationId),
    };
  },
});
