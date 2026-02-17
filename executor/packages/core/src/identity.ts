import type { Doc, Id } from "../../database/convex/_generated/dataModel.d.ts";
import type { MutationCtx, QueryCtx } from "../../database/convex/_generated/server";
import { isAnonymousIdentity } from "../../database/src/auth/anonymous";

type IdentityCtx = Pick<QueryCtx, "auth" | "db"> | Pick<MutationCtx, "auth" | "db">;
type MembershipCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

type WorkspaceAccessMembership = Pick<Doc<"workspaceMembers">, "role" | "status">;

export type WorkspaceAccess = {
  account: Doc<"accounts">;
  workspace: Doc<"workspaces">;
  workspaceMembership: WorkspaceAccessMembership;
};

export function slugify(input: string, fallback = "team"): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}

export async function resolveAccountForRequest(
  ctx: IdentityCtx,
  sessionId?: string,
): Promise<Doc<"accounts"> | null> {
  const normalizedSessionId = sessionId?.trim() || "";
  const identity = await ctx.auth.getUserIdentity();
  const hasNonAnonymousIdentity = Boolean(identity && !isAnonymousIdentity(identity));

  if (identity && hasNonAnonymousIdentity) {
    const workosAccount = await ctx.db
      .query("accounts")
      .withIndex("by_provider", (q) => q.eq("provider", "workos").eq("providerAccountId", identity.subject))
      .unique();
    if (workosAccount) {
      return workosAccount;
    }
  }

  if (normalizedSessionId.startsWith("anon_session_") || normalizedSessionId.startsWith("mcp_")) {
    const anonymousSession = await ctx.db
      .query("anonymousSessions")
      .withIndex("by_session_id", (q) => q.eq("sessionId", normalizedSessionId))
      .unique();
    if (anonymousSession) {
      const anonymousAccount = await ctx.db.get(anonymousSession.accountId);
      if (anonymousAccount) {
        return anonymousAccount;
      }
    }
  }

  if (identity) {
    if (!hasNonAnonymousIdentity) {
      let anonymousById: Doc<"accounts"> | null = null;
      try {
        anonymousById = await ctx.db.get(identity.subject as Id<"accounts">);
      } catch {
        anonymousById = null;
      }
      if (anonymousById?.provider === "anonymous") {
        return anonymousById;
      }

      const anonymousAccount = await ctx.db
        .query("accounts")
        .withIndex("by_provider", (q) => q.eq("provider", "anonymous").eq("providerAccountId", identity.subject))
        .unique();
      if (anonymousAccount) {
        return anonymousAccount;
      }
    }
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
  workspaceId: Id<"workspaces">,
  account: Doc<"accounts">,
): Promise<WorkspaceAccess> {
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found");
  }

  const workspaceMembership = await getWorkspaceMembership(ctx, workspace._id, account._id);
  if (!workspaceMembership || workspaceMembership.status !== "active") {
    throw new Error("You are not a member of this workspace");
  }

  return {
    account,
    workspace,
    workspaceMembership,
  };
}

export async function requireWorkspaceAccessForRequest(
  ctx: IdentityCtx,
  workspaceId: Id<"workspaces">,
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

export function accountIdForAccount(account: { _id: string; provider: string; providerAccountId: string }): string {
  return account.provider === "anonymous" ? account.providerAccountId : account._id;
}
