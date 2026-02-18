import type { ActionCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { internal } from "../../convex/_generated/api";
import {
  assertMatchesCanonicalAccountId,
  canonicalAccountIdForWorkspaceAccess,
  canonicalClientIdForWorkspaceAccess,
} from "../auth/account_identity";

export async function requireCanonicalAccount(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    sessionId?: string;
    accountId?: Id<"accounts">;
  },
): Promise<{ accountId: Id<"accounts">; clientId: "web" | "mcp" }> {
  const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
  });
  const canonicalAccountId = canonicalAccountIdForWorkspaceAccess(access);
  const canonicalClientId = canonicalClientIdForWorkspaceAccess({
    provider: access.provider,
    sessionId: args.sessionId,
  });
  assertMatchesCanonicalAccountId(args.accountId, canonicalAccountId);
  return {
    accountId: canonicalAccountId,
    clientId: canonicalClientId,
  };
}
