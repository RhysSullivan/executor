import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { ensureAnonymousIdentity } from "./anonymous";
import { mapAnonymousContext } from "./readers";

export const bootstrapAnonymousSession = internalMutation({
  args: {
    sessionId: v.optional(v.string()),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const requestedSessionId = args.sessionId?.trim() || "";
    const requestedActorId = args.actorId?.trim() || "";
    const clientId = args.clientId?.trim() || "web";

    if (requestedActorId && !requestedActorId.startsWith("anon_")) {
      throw new Error("actorId must be an anonymous actor");
    }

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
          actorId: requestedActorId || existing.actorId,
          timestamp: now,
        });

        await ctx.db.patch(existing._id, {
          actorId: requestedActorId || existing.actorId,
          clientId,
          workspaceId: identity.workspaceId,
          accountId: identity.accountId,
          userId: identity.userId,
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
    const actorId = requestedActorId || `anon_${crypto.randomUUID()}`;

    const identity = await ensureAnonymousIdentity(ctx, {
      sessionId,
      actorId,
      timestamp: now,
    });

    await ctx.db.insert("anonymousSessions", {
      sessionId,
      workspaceId: identity.workspaceId,
      actorId,
      clientId,
      accountId: identity.accountId,
      userId: identity.userId,
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

export const ensureAnonymousMcpSession = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    const actorId = args.actorId.trim();
    if (!actorId.startsWith("anon_")) {
      throw new Error("Anonymous actorId is required");
    }

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_provider", (q) => q.eq("provider", "anonymous").eq("providerAccountId", actorId))
      .unique();
    if (!account) {
      throw new Error("Anonymous actor is not recognized");
    }

    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_account", (q) => q.eq("workspaceId", args.workspaceId).eq("accountId", account._id))
      .unique();
    if (!membership || membership.status !== "active") {
      throw new Error("Anonymous actor does not have workspace access");
    }

    const now = Date.now();
    const existingSessions = await ctx.db
      .query("anonymousSessions")
      .withIndex("by_workspace_actor", (q) => q.eq("workspaceId", args.workspaceId).eq("actorId", actorId))
      .collect();
    const existing = existingSessions.find((session) => session.sessionId.startsWith("mcp_"))
      ?? existingSessions[0]
      ?? null;

    if (existing) {
      await ctx.db.patch(existing._id, {
        accountId: account._id,
        userId: membership._id,
        clientId: "mcp",
        lastSeenAt: now,
      });

      const refreshed = await ctx.db
        .query("anonymousSessions")
        .withIndex("by_session_id", (q) => q.eq("sessionId", existing.sessionId))
        .unique();
      if (!refreshed) {
        throw new Error("Failed to refresh anonymous MCP session");
      }
      return mapAnonymousContext(refreshed);
    }

    const sessionId = `mcp_${crypto.randomUUID()}`;
    await ctx.db.insert("anonymousSessions", {
      sessionId,
      workspaceId: args.workspaceId,
      actorId,
      clientId: "mcp",
      accountId: account._id,
      userId: membership._id,
      createdAt: now,
      lastSeenAt: now,
    });

    const created = await ctx.db
      .query("anonymousSessions")
      .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (!created) {
      throw new Error("Failed to create anonymous MCP session");
    }

    return mapAnonymousContext(created);
  },
});
