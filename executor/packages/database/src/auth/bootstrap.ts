import type { MutationCtx } from "../../convex/_generated/server";
import { upsertWorkosAccount } from "./accounts";
import { getOrganizationByWorkosOrgId } from "./db_queries";
import { getAuthKitUserProfile, resolveIdentityProfile } from "./identity";
import { activateOrganizationMembershipFromInviteHint } from "./memberships";
import { claimAnonymousSessionToWorkosAccount } from "./account_links";
import { getOrCreatePersonalWorkspace, refreshGeneratedPersonalWorkspaceNames } from "./personal_workspace";
import type { AccountId } from "./types";

function readNonEmptyTrimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function isGeneratedWorkosLabel(value: string, workosUserId: string): boolean {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return false;
  }

  const fallbackSuffix = workosUserId.trim().slice(-6);
  if (fallbackSuffix && normalizedValue.toLowerCase() === `user ${fallbackSuffix}`.toLowerCase()) {
    return true;
  }

  return /^user\s+[a-z0-9]{6,}$/i.test(normalizedValue);
}

function withProfileNameHint(
  identityProfile: ReturnType<typeof resolveIdentityProfile>,
  workosUserId: string,
  profileNameHint: string | undefined,
): ReturnType<typeof resolveIdentityProfile> {
  const profileName = readNonEmptyTrimmed(profileNameHint);
  if (!profileName) {
    return identityProfile;
  }

  if (!isGeneratedWorkosLabel(identityProfile.fullName, workosUserId)) {
    return identityProfile;
  }

  const [hintFirstName, ...hintRest] = profileName.split(/\s+/);
  const hintLastName = hintRest.length > 0 ? hintRest.join(" ") : undefined;

  return {
    ...identityProfile,
    fullName: profileName,
    firstName: identityProfile.firstName ?? hintFirstName,
    lastName: identityProfile.lastName ?? hintLastName,
  };
}

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

async function hasActiveWorkspaceAccess(ctx: MutationCtx, args: { accountId: AccountId }) {
  const activeOrganizationMembership = await ctx.db
    .query("organizationMembers")
    .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
    .filter((q) => q.eq(q.field("status"), "active"))
    .first();

  if (!activeOrganizationMembership) {
    return false;
  }

  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_organization_created", (q) => q.eq("organizationId", activeOrganizationMembership.organizationId))
    .first();

  return Boolean(workspace);
}

export async function bootstrapCurrentWorkosAccountImpl(
  ctx: MutationCtx,
  args?: { sessionId?: string; profileName?: string },
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const now = Date.now();
  const subject = identity.subject;
  const authKitProfile = await getAuthKitUserProfile(ctx, subject);
  const resolvedIdentityProfile = withProfileNameHint(
    resolveIdentityProfile({
      identity: { ...identity, subject },
      authKitProfile,
    }),
    subject,
    args?.profileName,
  );

  const account = await upsertWorkosAccount(ctx, {
    workosUserId: subject,
    email: resolvedIdentityProfile.email,
    fullName: resolvedIdentityProfile.fullName,
    firstName: resolvedIdentityProfile.firstName,
    lastName: resolvedIdentityProfile.lastName,
    avatarUrl: resolvedIdentityProfile.avatarUrl,
    now,
    includeLastLoginAt: true,
  });
  if (!account) return null;

  await claimAnonymousSessionToWorkosAccount(ctx, {
    sessionId: args?.sessionId,
    targetAccountId: account._id,
    now,
  });

  await refreshGeneratedPersonalWorkspaceNames(ctx, account._id, {
    email: resolvedIdentityProfile.email,
    firstName: resolvedIdentityProfile.firstName,
    fullName: resolvedIdentityProfile.fullName,
    workosUserId: subject,
    now,
  });

  await seedHintedOrganizationMembership(ctx, {
    accountId: account._id,
    hintedWorkosOrgId: resolvedIdentityProfile.hintedWorkosOrgId,
    email: resolvedIdentityProfile.email,
    now,
  });

  let hasWorkspaceMembership = await hasActiveWorkspaceAccess(ctx, {
    accountId: account._id,
  });

  if (!hasWorkspaceMembership) {
    await getOrCreatePersonalWorkspace(ctx, account._id, {
      email: resolvedIdentityProfile.email,
      firstName: resolvedIdentityProfile.firstName,
      fullName: resolvedIdentityProfile.fullName,
      workosUserId: subject,
      now,
    });

    hasWorkspaceMembership = await hasActiveWorkspaceAccess(ctx, {
      accountId: account._id,
    });

    if (!hasWorkspaceMembership) {
      throw new Error("Account bootstrap did not produce an active workspace access");
    }
  }

  return account;
}
