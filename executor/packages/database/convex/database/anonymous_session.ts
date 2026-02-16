import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.d.ts";
import { internalMutation } from "../_generated/server";
import { ensureAnonymousIdentity } from "../../src/database/anonymous";
import { mapAnonymousContext } from "../../src/database/readers";

export const bootstrapAnonymousSession = internalMutation({
  args: {
    sessionId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const requestedSessionId = args.sessionId?.trim() || "";
    const requestedAccountId = args.accountId?.trim() || "";
    const clientId = args.clientId?.trim() || "web";

    const allowRequestedSessionId = requestedSessionId.startsWith("mcp_")
      || requestedSessionId.startsWith("anon_session_");

    if (requestedSessionId) {
      const sessionId = requestedSessionId;
      const existing = await ctx.db
        .query("anonymousSessions")
        .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
        .unique();
      if (existing) {
        const identity = await ensureAnonymousIdentity(ctx, {
          sessionId,
          workspaceId: existing.workspaceId,
          accountId: requestedAccountId || existing.accountId,
          timestamp: now,
        });

        await ctx.db.patch(existing._id, {
          clientId,
          workspaceId: identity.workspaceId,
          accountId: identity.accountId,
          lastSeenAt: now,
        });

        const refreshed = await ctx.db
          .query("anonymousSessions")
          .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
          .unique();
        if (!refreshed) {
          throw new Error("Failed to refresh anonymous session");
        }
        return mapAnonymousContext(refreshed);
      }
    }

    const generatedSessionId = allowRequestedSessionId
      ? (requestedSessionId.startsWith("mcp_") ? `mcp_${crypto.randomUUID()}` : `anon_session_${crypto.randomUUID()}`)
      : `anon_session_${crypto.randomUUID()}`;
    const sessionId = allowRequestedSessionId
      ? requestedSessionId as string
      : generatedSessionId;

    const identity = await ensureAnonymousIdentity(ctx, {
      sessionId,
      accountId: requestedAccountId || undefined,
      timestamp: now,
    });

    await ctx.db.insert("anonymousSessions", {
      sessionId,
      workspaceId: identity.workspaceId,
      clientId,
      accountId: identity.accountId,
      createdAt: now,
      lastSeenAt: now,
    });

    const created = await ctx.db
      .query("anonymousSessions")
      .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (!created) {
      throw new Error("Failed to create anonymous session");
    }

    return mapAnonymousContext(created);
  },
});
