"use node";

import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { actorIdForAccount } from "../../core/src/identity";

export async function requireCanonicalActor(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    sessionId?: string;
    actorId?: string;
  },
): Promise<string> {
  const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
  });
  const canonicalActorId = actorIdForAccount({
    _id: access.accountId,
    provider: access.provider,
    providerAccountId: access.providerAccountId,
  });
  if (args.actorId && args.actorId !== canonicalActorId) {
    throw new Error("actorId must match the authenticated workspace actor");
  }
  return canonicalActorId;
}
