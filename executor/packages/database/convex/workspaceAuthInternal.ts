import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import {
  actorIdForAccount,
  requireWorkspaceAccessForAccount,
  resolveAccountForRequest,
  resolveWorkosAccountBySubject,
} from "../../core/src/identity";

export const getWorkspaceAccessForRequest = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    if (!account) {
      throw new Error("Must be signed in");
    }

    const access = await requireWorkspaceAccessForAccount(ctx, args.workspaceId, account);

    return {
      workspaceId: args.workspaceId,
      accountId: account._id,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      actorId: actorIdForAccount(account),
      role: access.workspaceMembership.role,
    };
  },
});

export const getWorkspaceAccessForWorkosSubject = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    subject: v.string(),
  },
  handler: async (ctx, args) => {
    const account = await resolveWorkosAccountBySubject(ctx, args.subject);
    if (!account) {
      throw new Error("Token subject is not linked to an account");
    }

    const access = await requireWorkspaceAccessForAccount(ctx, args.workspaceId, account);

    return {
      workspaceId: args.workspaceId,
      accountId: account._id,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      actorId: actorIdForAccount(account),
      role: access.workspaceMembership.role,
    };
  },
});

export const getWorkspaceAccessForAnonymousSubject = internalQuery({
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

    const access = await requireWorkspaceAccessForAccount(ctx, args.workspaceId, account);

    return {
      workspaceId: args.workspaceId,
      accountId: account._id,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      actorId: actorIdForAccount(account),
      role: access.workspaceMembership.role,
    };
  },
});
