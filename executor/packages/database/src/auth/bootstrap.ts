import type { MutationCtx } from "../../convex/_generated/server";
import { upsertWorkosAccount } from "./accounts";
import { getOrganizationByWorkosOrgId } from "./db_queries";
import { getAuthKitUserProfile, resolveIdentityProfile } from "./identity";
import { activateOrganizationMembershipFromInviteHint } from "./memberships";
import { getOrCreatePersonalWorkspace, refreshGeneratedPersonalWorkspaceNames } from "./personal_workspace";
import type { AccountId } from "./types";

async function seedHintedOrganizationMembership(
  ctx: MutationCtx,
  args: {
    accountId: AccountId;
    hintedWorkosOrgId?: string;
    email?: string;
    now: number;
  },
) {
  if (!args.hintedWorkosOrgId) {
    return;
  }

  const hintedOrganization = await getOrganizationByWorkosOrgId(ctx, args.hintedWorkosOrgId);
  if (!hintedOrganization) {
    return;
  }

  await activateOrganizationMembershipFromInviteHint(ctx, {
    organizationId: hintedOrganization._id,
    accountId: args.accountId,
    email: args.email,
    now: args.now,
    fallbackRole: "member",
    billable: true,
  });
}

async function hasActiveWorkspaceMembership(ctx: MutationCtx, args: { accountId: AccountId }) {
  const activeWorkspaceMembership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
    .filter((q) => q.eq(q.field("status"), "active"))
    .first();

  return Boolean(activeWorkspaceMembership);
}

export async function bootstrapCurrentWorkosAccountImpl(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const now = Date.now();
  const subject = identity.subject;
  const authKitProfile = await getAuthKitUserProfile(ctx, subject);
  const identityProfile = resolveIdentityProfile({
    identity: { ...identity, subject },
    authKitProfile,
  });

  const account = await upsertWorkosAccount(ctx, {
    workosUserId: subject,
    email: identityProfile.email,
    fullName: identityProfile.fullName,
    firstName: identityProfile.firstName,
    lastName: identityProfile.lastName,
    avatarUrl: identityProfile.avatarUrl,
    now,
    includeLastLoginAt: true,
  });
  if (!account) return null;

  await refreshGeneratedPersonalWorkspaceNames(ctx, account._id, {
    email: identityProfile.email,
    firstName: identityProfile.firstName,
    fullName: identityProfile.fullName,
    workosUserId: subject,
    now,
  });

  await seedHintedOrganizationMembership(ctx, {
    accountId: account._id,
    hintedWorkosOrgId: identityProfile.hintedWorkosOrgId,
    email: identityProfile.email,
    now,
  });

  let hasWorkspaceMembership = await hasActiveWorkspaceMembership(ctx, {
    accountId: account._id,
  });

  if (!hasWorkspaceMembership) {
    await getOrCreatePersonalWorkspace(ctx, account._id, {
      email: identityProfile.email,
      firstName: identityProfile.firstName,
      fullName: identityProfile.fullName,
      workosUserId: subject,
      now,
    });

    hasWorkspaceMembership = await hasActiveWorkspaceMembership(ctx, {
      accountId: account._id,
    });

    if (!hasWorkspaceMembership) {
      throw new Error("Account bootstrap did not produce an active workspace membership");
    }
  }

  return account;
}
