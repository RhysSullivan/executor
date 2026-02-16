import type { Doc } from "../../convex/_generated/dataModel.d.ts";
import type { AccountId, DbCtx, OrganizationId, WorkspaceMemberRole } from "./types";

type WorkspaceMemberStatus = Doc<"workspaceMembers">["status"];

type ProjectOrganizationMembershipArgs = {
  organizationId: OrganizationId;
  accountId: AccountId;
  role: WorkspaceMemberRole;
  status: WorkspaceMemberStatus;
  now: number;
  workosOrgMembershipId?: string;
};

async function upsertWorkspaceMembership(
  ctx: DbCtx,
  args: {
    workspaceId: Doc<"workspaces">["_id"];
    accountId: AccountId;
    role: WorkspaceMemberRole;
    status: WorkspaceMemberStatus;
    now: number;
    workosOrgMembershipId?: string;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_account", (q) => q.eq("workspaceId", args.workspaceId).eq("accountId", args.accountId))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      role: args.role,
      status: args.status,
      workosOrgMembershipId: args.workosOrgMembershipId,
      updatedAt: args.now,
    });
    return;
  }

  await ctx.db.insert("workspaceMembers", {
    workspaceId: args.workspaceId,
    accountId: args.accountId,
    role: args.role,
    status: args.status,
    workosOrgMembershipId: args.workosOrgMembershipId,
    createdAt: args.now,
    updatedAt: args.now,
  });
}

export async function projectOrganizationMembershipToWorkspaceMembers(
  ctx: DbCtx,
  args: ProjectOrganizationMembershipArgs,
): Promise<void> {
  const workspaces = await ctx.db
    .query("workspaces")
    .withIndex("by_organization_created", (q) => q.eq("organizationId", args.organizationId))
    .collect();

  for (const workspace of workspaces) {
    await upsertWorkspaceMembership(ctx, {
      workspaceId: workspace._id,
      accountId: args.accountId,
      role: args.role,
      status: args.status,
      now: args.now,
      workosOrgMembershipId: args.workosOrgMembershipId,
    });
  }
}

export async function projectAccountOrganizationMembershipsToWorkspaceMembers(
  ctx: DbCtx,
  args: { accountId: AccountId; now: number; mapRole: (role: Doc<"organizationMembers">["role"]) => WorkspaceMemberRole },
): Promise<void> {
  const memberships = await ctx.db
    .query("organizationMembers")
    .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
    .collect();

  for (const membership of memberships) {
    if (membership.status === "removed") {
      continue;
    }

    await projectOrganizationMembershipToWorkspaceMembers(ctx, {
      organizationId: membership.organizationId,
      accountId: membership.accountId,
      role: args.mapRole(membership.role),
      status: membership.status,
      now: args.now,
      workosOrgMembershipId: membership.workosOrgMembershipId,
    });
  }
}

export async function seedWorkspaceMembersFromOrganization(
  ctx: DbCtx,
  args: {
    organizationId: OrganizationId;
    workspaceId: Doc<"workspaces">["_id"];
    now: number;
    mapRole: (role: Doc<"organizationMembers">["role"]) => WorkspaceMemberRole;
  },
): Promise<void> {
  const orgMemberships = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
    .collect();

  for (const membership of orgMemberships) {
    if (membership.status === "removed") {
      continue;
    }

    await upsertWorkspaceMembership(ctx, {
      workspaceId: args.workspaceId,
      accountId: membership.accountId,
      role: args.mapRole(membership.role),
      status: membership.status,
      now: args.now,
      workosOrgMembershipId: membership.workosOrgMembershipId,
    });
  }
}
