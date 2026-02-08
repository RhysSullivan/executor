import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type IdentityCtx = Pick<QueryCtx, "auth" | "db"> | Pick<MutationCtx, "auth" | "db">;
type MembershipCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

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

    const fromIdentity = await ctx.db
      .query("accountIdentities")
      .withIndex("by_provider_user", (q) => q.eq("provider", "workos").eq("providerUserId", identity.subject))
      .unique();
    if (fromIdentity?.accountId) {
      return await ctx.db.get(fromIdentity.accountId);
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

export function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function canManageBilling(role: string): boolean {
  return role === "owner" || role === "billing_admin";
}
