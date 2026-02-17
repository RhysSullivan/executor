import type { DbCtx } from "./types";

export async function getAccountByWorkosId(ctx: DbCtx, workosUserId: string) {
  return await ctx.db
    .query("accounts")
    .withIndex("by_provider", (q) => q.eq("provider", "workos").eq("providerAccountId", workosUserId))
    .unique();
}

export async function getOrganizationByWorkosOrgId(ctx: DbCtx, workosOrgId: string) {
  return await ctx.db
    .query("organizations")
    .withIndex("by_workos_org_id", (q) => q.eq("workosOrgId", workosOrgId))
    .unique();
}
