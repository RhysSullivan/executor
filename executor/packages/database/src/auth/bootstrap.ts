import type { MutationCtx } from "../../convex/_generated/server";
import { upsertWorkosAccount } from "./accounts";
import { getOrganizationByWorkosOrgId } from "./db_queries";
import { getAuthKitUserProfile, resolveIdentityProfile } from "./identity";
import {
  ensureWorkspaceMembership,
  mapOrganizationRoleToWorkspaceRole,
  markPendingInvitesAcceptedByEmail,
  upsertOrganizationMembership,
} from "./memberships";
import { ensurePersonalWorkspace, refreshGeneratedPersonalWorkspaceNames } from "./personal_workspace";
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
  const activeOrgMembership = await ctx.db
    .query("organizationMembers")
    .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
    .filter((q) => q.eq(q.field("status"), "active"))
    .first();

  if (activeOrgMembership || !args.hintedWorkosOrgId) {
    return;
  }

  const hintedOrganization = await getOrganizationByWorkosOrgId(ctx, args.hintedWorkosOrgId);
  if (!hintedOrganization) {
    return;
  }

  await upsertOrganizationMembership(ctx, {
    organizationId: hintedOrganization._id,
    accountId: args.accountId,
    role: "member",
    status: "active",
    billable: true,
    now: args.now,
  });

  await markPendingInvitesAcceptedByEmail(ctx, {
    organizationId: hintedOrganization._id,
    email: args.email,
    acceptedAt: args.now,
  });
}

async function syncWorkspaceMembershipsForOrganizations(ctx: MutationCtx, args: { accountId: AccountId; now: number }) {
  const activeOrganizationMemberships = await ctx.db
    .query("organizationMembers")
    .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
    .filter((q) => q.eq(q.field("status"), "active"))
    .collect();

  for (const membership of activeOrganizationMemberships) {
    const orgWorkspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_organization_created", (q) => q.eq("organizationId", membership.organizationId))
      .collect();

    const workspaceRole = mapOrganizationRoleToWorkspaceRole(membership.role);
    for (const workspace of orgWorkspaces) {
      await ensureWorkspaceMembership(ctx, {
        workspaceId: workspace._id,
        accountId: args.accountId,
        role: workspaceRole,
        now: args.now,
      });
    }
  }
}

async function ensureAtLeastOneWorkspaceMembership(ctx: MutationCtx, args: { accountId: AccountId }) {
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
    identity: identity as Record<string, unknown> & { subject: string },
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

  await syncWorkspaceMembershipsForOrganizations(ctx, {
    accountId: account._id,
    now,
  });

  const hasActiveWorkspaceMembership = await ensureAtLeastOneWorkspaceMembership(ctx, {
    accountId: account._id,
  });

  if (!hasActiveWorkspaceMembership) {
    await ensurePersonalWorkspace(ctx, account._id, {
      email: identityProfile.email,
      firstName: identityProfile.firstName,
      fullName: identityProfile.fullName,
      workosUserId: subject,
      now,
    });
  }

  return account;
}
