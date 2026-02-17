import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import {
  requireWorkspaceAccessForAccount,
  resolveAccountForRequest,
  resolveWorkosAccountBySubject,
} from "../../core/src/identity";
import type { Id } from "./_generated/dataModel.d.ts";

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
      role: access.workspaceMembership.role,
    };
  },
});

export const getWorkspaceAccessForAnonymousSubject = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.string(),
  },
  handler: async (ctx, args) => {
    const accountId = args.accountId.trim();
    if (!accountId) {
      throw new Error("Anonymous accountId is required");
    }

    const account = await ctx.db.get(accountId as Id<"accounts">);
    if (!account || account.provider !== "anonymous") {
      throw new Error("Anonymous account is not recognized");
    }

    const access = await requireWorkspaceAccessForAccount(ctx, args.workspaceId, account);

    return {
      workspaceId: args.workspaceId,
      accountId: account._id,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      role: access.workspaceMembership.role,
    };
  },
});

export const getWorkspaceAccessForAccount = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.id("accounts"),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error("Account is not recognized");
    }

    const access = await requireWorkspaceAccessForAccount(ctx, args.workspaceId, account);

    return {
      workspaceId: args.workspaceId,
      accountId: account._id,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      role: access.workspaceMembership.role,
    };
  },
});
