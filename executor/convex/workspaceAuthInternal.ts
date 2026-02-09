import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import {
  requireWorkspaceAccessForAccount,
  resolveAccountForRequest,
  resolveWorkosAccountBySubject,
} from "../lib/identity";

function actorIdForAccount(account: { _id: string; provider: string; providerAccountId: string }): string {
  return account.provider === "anonymous" ? account.providerAccountId : account._id;
}

export const getWorkspaceAccessForRequest = internalQuery({
  args: {
    workspaceId: v.string(),
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
    workspaceId: v.string(),
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
