import type {
  AccountId,
  DbCtx,
  OrganizationId,
  OrganizationMemberStatus,
  OrganizationRole,
  WorkspaceMemberRole,
} from "./types";
import { projectOrganizationMembershipToWorkspaceMembers } from "./workspace_membership_projection";

export function mapOrganizationRoleToWorkspaceRole(role: OrganizationRole): WorkspaceMemberRole {
  if (role === "owner") {
    return "owner";
  }
  if (role === "admin") {
    return "admin";
  }
  return "member";
}

export async function upsertOrganizationMembership(
  ctx: DbCtx,
  args: {
    organizationId: OrganizationId;
    accountId: AccountId;
    role: OrganizationRole;
    status: OrganizationMemberStatus;
    billable: boolean;
    invitedByAccountId?: AccountId;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_account", (q) => q.eq("organizationId", args.organizationId).eq("accountId", args.accountId))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      role: args.role,
      status: args.status,
      billable: args.billable,
      invitedByAccountId: args.invitedByAccountId,
      joinedAt: args.status === "active" ? (existing.joinedAt ?? args.now) : existing.joinedAt,
      updatedAt: args.now,
    });
  } else {
    await ctx.db.insert("organizationMembers", {
      organizationId: args.organizationId,
      accountId: args.accountId,
      role: args.role,
      status: args.status,
      billable: args.billable,
      invitedByAccountId: args.invitedByAccountId,
      joinedAt: args.status === "active" ? args.now : undefined,
      createdAt: args.now,
      updatedAt: args.now,
    });
  }

  await projectOrganizationMembershipToWorkspaceMembers(ctx, {
    organizationId: args.organizationId,
    accountId: args.accountId,
    role: mapOrganizationRoleToWorkspaceRole(args.role),
    status: args.status,
    now: args.now,
  });
}

async function getLatestPendingInviteRoleForEmail(
  ctx: DbCtx,
  args: {
    organizationId: OrganizationId;
    email?: string;
  },
): Promise<OrganizationRole | null> {
  if (!args.email) {
    return null;
  }

  const normalizedEmail = args.email.toLowerCase();
  const pendingInvites = await ctx.db
    .query("invites")
    .withIndex("by_org_email_status", (q) =>
      q.eq("organizationId", args.organizationId).eq("email", normalizedEmail).eq("status", "pending"),
    )
    .collect();

  if (pendingInvites.length === 0) {
    return null;
  }

  pendingInvites.sort((a, b) => b.createdAt - a.createdAt);
  return pendingInvites[0]!.role;
}

export async function activateOrganizationMembershipFromInviteHint(
  ctx: DbCtx,
  args: {
    organizationId: OrganizationId;
    accountId: AccountId;
    email?: string;
    now: number;
    fallbackRole?: OrganizationRole;
    billable?: boolean;
  },
): Promise<void> {
  const existingMembership = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_account", (q) => q.eq("organizationId", args.organizationId).eq("accountId", args.accountId))
    .unique();

  if (existingMembership?.status === "active") {
    await markPendingInvitesAcceptedByEmail(ctx, {
      organizationId: args.organizationId,
      email: args.email,
      acceptedAt: args.now,
    });
    return;
  }

  const inviteRole = await getLatestPendingInviteRoleForEmail(ctx, {
    organizationId: args.organizationId,
    email: args.email,
  });

  await upsertOrganizationMembership(ctx, {
    organizationId: args.organizationId,
    accountId: args.accountId,
    role: inviteRole ?? existingMembership?.role ?? args.fallbackRole ?? "member",
    status: "active",
    billable: args.billable ?? true,
    invitedByAccountId: existingMembership?.invitedByAccountId,
    now: args.now,
  });

  await markPendingInvitesAcceptedByEmail(ctx, {
    organizationId: args.organizationId,
    email: args.email,
    acceptedAt: args.now,
  });
}

export async function markPendingInvitesAcceptedByEmail(
  ctx: DbCtx,
  args: {
    organizationId: OrganizationId;
    email?: string;
    acceptedAt: number;
  },
) {
  if (!args.email) {
    return;
  }

  const normalizedEmail = args.email.toLowerCase();
  const pendingInvites = await ctx.db
    .query("invites")
    .withIndex("by_org_email_status", (q) =>
      q.eq("organizationId", args.organizationId).eq("email", normalizedEmail).eq("status", "pending"),
    )
    .collect();

  for (const invite of pendingInvites) {
    await ctx.db.patch(invite._id, {
      status: "accepted",
      acceptedAt: args.acceptedAt,
      updatedAt: args.acceptedAt,
    });
  }
}
