import type { Doc } from "../../convex/_generated/dataModel.d.ts";
import type {
  AccountId,
  DbCtx,
  OrganizationId,
  OrganizationMemberStatus,
  OrganizationRole,
  WorkspaceId,
  WorkspaceMemberRole,
} from "./types";

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
    return;
  }

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

export async function ensureWorkspaceMembership(
  ctx: DbCtx,
  args: {
    workspaceId: WorkspaceId;
    accountId: AccountId;
    role: WorkspaceMemberRole;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_account", (q) => q.eq("workspaceId", args.workspaceId).eq("accountId", args.accountId))
    .unique();

  if (existing) {
    if (existing.status === "active") {
      await ctx.db.patch(existing._id, {
        role: args.role,
        updatedAt: args.now,
      });
    }
    return;
  }

  await ctx.db.insert("workspaceMembers", {
    workspaceId: args.workspaceId,
    accountId: args.accountId,
    role: args.role,
    status: "active",
    createdAt: args.now,
    updatedAt: args.now,
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

export function deriveWorkspaceMembershipRole(workosRoleSlug?: string): Doc<"workspaceMembers">["role"] {
  return workosRoleSlug === "admin" ? "admin" : "member";
}

export function deriveOrganizationMembershipState(status?: string): OrganizationMemberStatus {
  return status === "active" ? "active" : "pending";
}
