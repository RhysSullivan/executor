import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.d.ts";
import { internalMutation } from "../_generated/server";
import { ensureAnonymousIdentity } from "../../src/database/anonymous";
import { mapAnonymousContext } from "../../src/database/readers";

type TrustedClientId = "web" | "mcp";

function parseTrustedClientId(value: string | undefined): TrustedClientId | undefined {
  const candidate = value?.trim();
  if (!candidate) {
    return undefined;
  }

  if (candidate === "web" || candidate === "mcp") {
    return candidate;
  }

  throw new Error("clientId must be one of: web, mcp");
}

function parseStoredTrustedClientId(value: string | undefined): TrustedClientId | undefined {
  const candidate = value?.trim();
  if (!candidate) {
    return undefined;
  }

  if (candidate === "web" || candidate === "mcp") {
    return candidate;
  }

  return undefined;
}

function defaultClientIdForSessionId(sessionId: string): TrustedClientId {
  if (sessionId.startsWith("mcp_")) {
    return "mcp";
  }

  return "web";
}

function resolveTrustedClientId(args: {
  sessionId: string;
  requestedClientId?: TrustedClientId;
  existingClientId?: string;
}): TrustedClientId {
  if (args.requestedClientId) {
    return args.requestedClientId;
  }

  const existingClientId = parseStoredTrustedClientId(args.existingClientId);
  if (existingClientId) {
    return existingClientId;
  }

  return defaultClientIdForSessionId(args.sessionId);
}

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
    const requestedClientId = parseTrustedClientId(args.clientId);

    const allowRequestedSessionId = requestedSessionId.startsWith("mcp_")
      || requestedSessionId.startsWith("anon_session_");

    if (requestedSessionId) {
      const sessionId = requestedSessionId;
      const existing = await ctx.db
        .query("anonymousSessions")
        .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
        .unique();
      if (existing) {
        const clientId = resolveTrustedClientId({
          sessionId,
          requestedClientId,
          existingClientId: existing.clientId,
        });
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
    const clientId = resolveTrustedClientId({
      sessionId,
      requestedClientId,
    });

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
