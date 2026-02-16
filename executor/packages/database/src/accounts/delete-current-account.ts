import type { Id } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx } from "../../convex/_generated/server";

type DeleteCurrentAccountCtx = Pick<MutationCtx, "db" | "storage"> & {
  account: {
    _id: Id<"accounts">;
  };
};

async function deleteWorkspaceData(
  ctx: Pick<MutationCtx, "db" | "storage">,
  workspaceId: Id<"workspaces">,
) {
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) {
    return false;
  }

  const taskDocs = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const task of taskDocs) {
    const taskEvents = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_sequence", (q) => q.eq("taskId", task.taskId))
      .collect();
    for (const event of taskEvents) {
      await ctx.db.delete(event._id);
    }
    await ctx.db.delete(task._id);
  }

  const approvalDocs = await ctx.db
    .query("approvals")
    .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const approval of approvalDocs) {
    await ctx.db.delete(approval._id);
  }

  const policyDocs = await ctx.db
    .query("accessPolicies")
    .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const policy of policyDocs) {
    await ctx.db.delete(policy._id);
  }

  const credentialDocs = await ctx.db
    .query("sourceCredentials")
    .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const credential of credentialDocs) {
    await ctx.db.delete(credential._id);
  }

  const toolSources = await ctx.db
    .query("toolSources")
    .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const source of toolSources) {
    await ctx.db.delete(source._id);
  }

  const cachedToolsets = await ctx.db
    .query("workspaceToolCache")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const cacheEntry of cachedToolsets) {
    await ctx.storage.delete(cacheEntry.storageId).catch(() => {});
    if (cacheEntry.typesStorageId) {
      await ctx.storage.delete(cacheEntry.typesStorageId).catch(() => {});
    }
    await ctx.db.delete(cacheEntry._id);
  }

  const workspaceMembers = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const member of workspaceMembers) {
    await ctx.db.delete(member._id);
  }

  const anonymousSessions = await ctx.db
    .query("anonymousSessions")
    .withIndex("by_workspace_actor", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const session of anonymousSessions) {
    await ctx.db.delete(session._id);
  }

  if (workspace.iconStorageId) {
    await ctx.storage.delete(workspace.iconStorageId).catch(() => {});
  }

  await ctx.db.delete(workspace._id);
  return true;
}

async function deleteOrganizationData(
  ctx: Pick<MutationCtx, "db" | "storage">,
  organizationId: Id<"organizations">,
) {
  const invites = await ctx.db
    .query("invites")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .collect();
  for (const invite of invites) {
    await ctx.db.delete(invite._id);
  }

  const billingCustomers = await ctx.db
    .query("billingCustomers")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .collect();
  for (const customer of billingCustomers) {
    await ctx.db.delete(customer._id);
  }

  const billingSubscriptions = await ctx.db
    .query("billingSubscriptions")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .collect();
  for (const subscription of billingSubscriptions) {
    await ctx.db.delete(subscription._id);
  }

  const seatStateDocs = await ctx.db
    .query("billingSeatState")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .collect();
  for (const seatState of seatStateDocs) {
    await ctx.db.delete(seatState._id);
  }

  const workspaces = await ctx.db
    .query("workspaces")
    .withIndex("by_organization_created", (q) => q.eq("organizationId", organizationId))
    .collect();
  for (const workspace of workspaces) {
    await deleteWorkspaceData(ctx, workspace._id);
  }

  const orgMembers = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .collect();
  for (const membership of orgMembers) {
    await ctx.db.delete(membership._id);
  }

  await ctx.db.delete(organizationId);
}

export async function deleteCurrentAccountHandler(ctx: DeleteCurrentAccountCtx) {
  const accountId = ctx.account._id;

  const organizationIdsToDelete = new Set<Id<"organizations">>();

  const organizationsByStatus = await Promise.all([
    ctx.db
      .query("organizations")
      .withIndex("by_status_created", (q) => q.eq("status", "active"))
      .collect(),
    ctx.db
      .query("organizations")
      .withIndex("by_status_created", (q) => q.eq("status", "deleted"))
      .collect(),
  ]);

  for (const organization of organizationsByStatus.flat()) {
    if (organization.createdByAccountId === accountId) {
      organizationIdsToDelete.add(organization._id);
    }
  }

  for (const organizationId of organizationIdsToDelete) {
    await deleteOrganizationData(ctx, organizationId);
  }

  const workspaceMemberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();
  for (const membership of workspaceMemberships) {
    await ctx.db.delete(membership._id);
  }

  const organizationMemberships = await ctx.db
    .query("organizationMembers")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();
  for (const membership of organizationMemberships) {
    await ctx.db.delete(membership._id);
  }

  const invitedRecords = await ctx.db.query("invites").collect();
  for (const invite of invitedRecords) {
    if (invite.invitedByAccountId === accountId) {
      await ctx.db.delete(invite._id);
    }
  }

  const anonymousSessions = await ctx.db
    .query("anonymousSessions")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();
  for (const session of anonymousSessions) {
    await ctx.db.delete(session._id);
  }

  await ctx.db.delete(accountId);

  return {
    organizationsDeleted: organizationIdsToDelete.size,
  };
}
