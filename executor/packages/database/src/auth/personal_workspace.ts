import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { upsertOrganizationMembership } from "./memberships";
import {
  buildPersonalWorkspaceSlugSeed,
  derivePersonalNames,
  generateUniqueOrganizationSlug,
  isGeneratedPersonalOrganizationName,
  isGeneratedPersonalWorkspaceName,
} from "./naming";
import type { AccountId, DbCtx } from "./types";

type PersonalWorkspaceOptions = {
  email?: string;
  firstName?: string;
  fullName?: string;
  workosUserId: string;
  now: number;
};

async function renameGeneratedPersonalWorkspaceArtifacts(
  ctx: DbCtx,
  args: {
    accountId: AccountId;
    workspaceId: Id<"workspaces">;
    organizationId: Id<"organizations">;
    workspaceName: string;
    organizationName: string;
    workosUserId: string;
    now: number;
  },
) {
  const workspace = await ctx.db.get(args.workspaceId);
  if (!workspace || workspace.createdByAccountId !== args.accountId) {
    return;
  }

  const organization = await ctx.db.get(args.organizationId);
  if (!organization || organization.createdByAccountId !== args.accountId) {
    return;
  }

  if (
    isGeneratedPersonalOrganizationName(organization.name, args.workosUserId)
    && organization.name !== args.organizationName
  ) {
    await ctx.db.patch(organization._id, {
      name: args.organizationName,
      updatedAt: args.now,
    });
  }

  if (isGeneratedPersonalWorkspaceName(workspace.name, args.workosUserId) && workspace.name !== args.workspaceName) {
    await ctx.db.patch(workspace._id, {
      name: args.workspaceName,
      updatedAt: args.now,
    });
  }
}

export async function getOrCreatePersonalWorkspace(ctx: DbCtx, accountId: AccountId, opts: PersonalWorkspaceOptions) {
  const personalNames = derivePersonalNames({
    firstName: opts.firstName,
    fullName: opts.fullName,
    email: opts.email,
    workosUserId: opts.workosUserId,
  });

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();

  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId);
    if (!workspace || workspace.createdByAccountId !== accountId) {
      continue;
    }

    await renameGeneratedPersonalWorkspaceArtifacts(ctx, {
      accountId,
      workspaceId: workspace._id,
      organizationId: workspace.organizationId,
      workspaceName: personalNames.workspaceName,
      organizationName: personalNames.organizationName,
      workosUserId: opts.workosUserId,
      now: opts.now,
    });

    await upsertOrganizationMembership(ctx, {
      organizationId: workspace.organizationId,
      accountId,
      role: "owner",
      status: "active",
      billable: true,
      now: opts.now,
    });

    return {
      workspace: await ctx.db.get(workspace._id),
      membership,
    };
  }

  const organizationSlug = await generateUniqueOrganizationSlug(ctx, personalNames.organizationName);
  const organizationId = await ctx.db.insert("organizations", {
    slug: organizationSlug,
    name: personalNames.organizationName,
    status: "active",
    createdByAccountId: accountId,
    createdAt: opts.now,
    updatedAt: opts.now,
  });

  const workspaceId = await ctx.db.insert("workspaces", {
    organizationId,
    slug: buildPersonalWorkspaceSlugSeed(opts.email, opts.workosUserId),
    name: personalNames.workspaceName,
    createdByAccountId: accountId,
    createdAt: opts.now,
    updatedAt: opts.now,
  });

  await upsertOrganizationMembership(ctx, {
    organizationId,
    accountId,
    role: "owner",
    status: "active",
    billable: true,
    now: opts.now,
  });

  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_account", (q) => q.eq("workspaceId", workspaceId).eq("accountId", accountId))
    .unique();
  if (!membership || membership.status !== "active") {
    throw new Error("Failed to project personal workspace membership");
  }

  return {
    workspace: await ctx.db.get(workspaceId),
    membership,
  };
}

export async function refreshGeneratedPersonalWorkspaceNames(
  ctx: DbCtx,
  accountId: AccountId,
  opts: PersonalWorkspaceOptions,
) {
  const personalNames = derivePersonalNames({
    firstName: opts.firstName,
    fullName: opts.fullName,
    email: opts.email,
    workosUserId: opts.workosUserId,
  });

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();

  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId);
    if (!workspace) {
      continue;
    }

    await renameGeneratedPersonalWorkspaceArtifacts(ctx, {
      accountId,
      workspaceId: workspace._id,
      organizationId: workspace.organizationId,
      workspaceName: personalNames.workspaceName,
      organizationName: personalNames.organizationName,
      workosUserId: opts.workosUserId,
      now: opts.now,
    });
  }
}
