import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type IdentityCtx = Pick<QueryCtx, "auth" | "db"> | Pick<MutationCtx, "auth" | "db">;
type MembershipCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

type WorkspaceAccessMembership = Pick<Doc<"workspaceMembers">, "role" | "status">;

function mapOrganizationRoleToWorkspaceRole(
  role: Doc<"organizationMembers">["role"],
): Doc<"workspaceMembers">["role"] {
  if (role === "owner") {
    return "owner";
  }
  if (role === "admin") {
    return "admin";
  }
  return "member";
}

export type WorkspaceAccess = {
  account: Doc<"accounts">;
  workspace: Doc<"workspaces">;
  workspaceMembership: WorkspaceAccessMembership;
};

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "team";
}

export async function resolveAccountForRequest(
  ctx: IdentityCtx,
  sessionId?: string,
): Promise<Doc<"accounts"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    const fromAccounts = await ctx.db
      .query("accounts")
      .withIndex("by_provider", (q) => q.eq("provider", "workos").eq("providerAccountId", identity.subject))
      .unique();
    if (fromAccounts) {
      return fromAccounts;
    }
  }

  if (!sessionId) {
    return null;
  }

  const anonymous = await ctx.db
    .query("anonymousSessions")
    .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
    .unique();
  if (anonymous?.accountId) {
    return await ctx.db.get(anonymous.accountId);
  }

  return null;
}

export async function resolveWorkosAccountBySubject(
  ctx: MembershipCtx,
  subject: string,
): Promise<Doc<"accounts"> | null> {
  if (!subject.trim()) {
    return null;
  }

  return await ctx.db
    .query("accounts")
    .withIndex("by_provider", (q) => q.eq("provider", "workos").eq("providerAccountId", subject))
    .unique();
}

export async function getOrganizationMembership(
  ctx: MembershipCtx,
  organizationId: Id<"organizations">,
  accountId: Id<"accounts">,
) {
  return await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_account", (q) => q.eq("organizationId", organizationId).eq("accountId", accountId))
    .unique();
}

export async function getWorkspaceMembership(
  ctx: MembershipCtx,
  workspaceId: Id<"workspaces">,
  accountId: Id<"accounts">,
) {
  return await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_account", (q) => q.eq("workspaceId", workspaceId).eq("accountId", accountId))
    .unique();
}

export async function requireWorkspaceAccessForAccount(
  ctx: MembershipCtx,
  workspaceId: string,
  account: Doc<"accounts">,
): Promise<WorkspaceAccess> {
  const workspace = await ctx.db.get(workspaceId as Id<"workspaces">);
  if (!workspace) {
    throw new Error("Workspace not found");
  }

  const workspaceMembership = await getWorkspaceMembership(ctx, workspace._id, account._id);
  if (workspaceMembership) {
    if (workspaceMembership.status !== "active") {
      throw new Error("You are not a member of this workspace");
    }

    return {
      account,
      workspace,
      workspaceMembership,
    };
  }

  const organizationMembership = await getOrganizationMembership(ctx, workspace.organizationId, account._id);
  if (!organizationMembership || organizationMembership.status !== "active") {
    throw new Error("You are not a member of this workspace");
  }

  const derivedWorkspaceMembership: WorkspaceAccessMembership = {
    role: mapOrganizationRoleToWorkspaceRole(organizationMembership.role),
    status: "active",
  };

  return {
    account,
    workspace,
    workspaceMembership: derivedWorkspaceMembership,
  };
}

export async function requireWorkspaceAccessForRequest(
  ctx: IdentityCtx,
  workspaceId: string,
  sessionId?: string,
): Promise<WorkspaceAccess> {
  const account = await resolveAccountForRequest(ctx, sessionId);
  if (!account) {
    throw new Error("Must be signed in");
  }

  return await requireWorkspaceAccessForAccount(ctx, workspaceId, account);
}

export function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function canManageBilling(role: string): boolean {
  return role === "owner" || role === "billing_admin";
}
