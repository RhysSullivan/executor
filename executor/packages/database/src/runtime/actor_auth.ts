"use node";

import type { ActionCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { internal } from "../../convex/_generated/api";
import {
  assertMatchesCanonicalActorId,
  canonicalActorIdForWorkspaceAccess,
} from "../auth/actor_identity";

export async function requireCanonicalActor(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    sessionId?: string;
    actorId?: string;
  },
): Promise<{ accountId: Id<"accounts">; actorId: string }> {
  const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
  });
  const canonicalActorId = canonicalActorIdForWorkspaceAccess(access);
  assertMatchesCanonicalActorId(args.actorId, canonicalActorId);
  return {
    accountId: access.accountId,
    actorId: canonicalActorId,
  };
}
