import { type AuthKit } from "@convex-dev/workos-authkit";
import type { DataModel, Doc } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx } from "../../convex/_generated/server";
import { upsertWorkosAccount } from "./accounts";
import {
  getAccountByWorkosId,
  getFirstWorkspaceByOrganizationId,
  getOrganizationByWorkosOrgId,
  getWorkspaceByWorkosOrgId,
} from "./db_queries";
import {
  deriveOrganizationMembershipState,
  deriveWorkspaceMembershipRole,
  markPendingInvitesAcceptedByEmail,
  upsertOrganizationMembership,
} from "./memberships";
import { ensureUniqueOrganizationSlug } from "./naming";

type WorkosMembershipEventData = {
  id: string;
  user_id?: string;
  userId?: string;
  organization_id?: string;
  organizationId?: string;
  role?: { slug?: string };
  status?: string;
};

async function resolveMembershipRecord(
  ctx: Pick<MutationCtx, "db">,
  data: WorkosMembershipEventData,
) {
  let membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workos_membership_id", (q) => q.eq("workosOrgMembershipId", data.id))
    .unique();

  let account: Doc<"accounts"> | null = null;
  let workspace: Doc<"workspaces"> | null = null;

  if (!membership) {
    const workosUserId = data.user_id ?? data.userId;
    const workosOrgId = data.organization_id ?? data.organizationId;
    if (!workosUserId || !workosOrgId) {
      return { membership: null, account: null, workspace: null };
    }

    [account, workspace] = await Promise.all([
      getAccountByWorkosId(ctx, workosUserId),
      getWorkspaceByWorkosOrgId(ctx, workosOrgId),
    ]);
    if (!account || !workspace) {
      return { membership: null, account: null, workspace: null };
    }

    const workspaceId = workspace._id;
    const accountId = account._id;

    membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_account", (q) => q.eq("workspaceId", workspaceId).eq("accountId", accountId))
      .unique();
    if (!membership) {
      return { membership: null, account: null, workspace: null };
    }
  } else {
    account = await ctx.db.get(membership.accountId);
    workspace = await ctx.db.get(membership.workspaceId);
  }

  if (!account || !workspace) {
    return { membership: null, account: null, workspace: null };
  }

  return { membership, account, workspace };
}

export const workosEventHandlers = {
  "user.created": async (ctx, event) => {
    const now = Date.now();
    const data = event.data;
    const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ") || data.email;

    await upsertWorkosAccount(ctx, {
      workosUserId: data.id,
      email: data.email,
      fullName,
      firstName: data.firstName ?? undefined,
      lastName: data.lastName ?? undefined,
      avatarUrl: data.profilePictureUrl ?? undefined,
      now,
      includeLastLoginAt: true,
    });
  },

  "user.updated": async (ctx, event) => {
    const account = await getAccountByWorkosId(ctx, event.data.id);
    if (!account) return;

    const fullName = [event.data.firstName, event.data.lastName].filter(Boolean).join(" ") || event.data.email;
    await ctx.db.patch(account._id, {
      email: event.data.email,
      name: fullName,
      firstName: event.data.firstName ?? undefined,
      lastName: event.data.lastName ?? undefined,
      avatarUrl: event.data.profilePictureUrl ?? undefined,
      status: "active",
      updatedAt: Date.now(),
    });
  },

  "user.deleted": async (ctx, event) => {
    const account = await getAccountByWorkosId(ctx, event.data.id);
    if (!account) return;

    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();
    for (const membership of memberships) {
      await ctx.db.delete(membership._id);
    }

    await ctx.db.delete(account._id);
  },

  "organization.created": async (ctx, event) => {
    const now = Date.now();
    let organization = await getOrganizationByWorkosOrgId(ctx, event.data.id);
    if (organization) {
      await ctx.db.patch(organization._id, {
        name: event.data.name,
        status: "active",
        updatedAt: now,
      });
      organization = await ctx.db.get(organization._id);
    } else {
      const slug = await ensureUniqueOrganizationSlug(ctx, event.data.name);
      const organizationId = await ctx.db.insert("organizations", {
        workosOrgId: event.data.id,
        slug,
        name: event.data.name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      organization = await ctx.db.get(organizationId);
    }

    if (!organization) {
      return;
    }

    const existingWorkspace = await getWorkspaceByWorkosOrgId(ctx, event.data.id);
    if (existingWorkspace) {
      await ctx.db.patch(existingWorkspace._id, {
        organizationId: organization._id,
        workosOrgId: event.data.id,
        updatedAt: now,
      });
      return;
    }

    const organizationWorkspace = await getFirstWorkspaceByOrganizationId(ctx, organization._id);
    if (organizationWorkspace) {
      await ctx.db.patch(organizationWorkspace._id, {
        workosOrgId: event.data.id,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("workspaces", {
      workosOrgId: event.data.id,
      organizationId: organization._id,
      slug: "default",
      name: "Default Workspace",
      createdByAccountId: organization.createdByAccountId,
      createdAt: now,
      updatedAt: now,
    });
  },

  "organization.updated": async (ctx, event) => {
    const organization = await getOrganizationByWorkosOrgId(ctx, event.data.id);
    if (organization) {
      await ctx.db.patch(organization._id, {
        name: event.data.name,
        updatedAt: Date.now(),
      });
    }
  },

  "organization.deleted": async (ctx, event) => {
    const organization = await getOrganizationByWorkosOrgId(ctx, event.data.id);
    if (organization) {
      await ctx.db.patch(organization._id, {
        status: "deleted",
        updatedAt: Date.now(),
      });
    }

    const workspace = await getWorkspaceByWorkosOrgId(ctx, event.data.id);
    if (!workspace) return;

    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    for (const member of members) {
      await ctx.db.delete(member._id);
    }

    await ctx.db.delete(workspace._id);
  },

  "organization_membership.created": async (ctx, event) => {
    const now = Date.now();
    const data = event.data as WorkosMembershipEventData;
    const workosUserId = data.user_id ?? data.userId;
    const workosOrgId = data.organization_id ?? data.organizationId;
    if (!workosUserId || !workosOrgId) return;

    const [account, workspace] = await Promise.all([
      getAccountByWorkosId(ctx, workosUserId),
      getWorkspaceByWorkosOrgId(ctx, workosOrgId),
    ]);
    if (!account || !workspace) return;

    const existing = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_account", (q) => q.eq("workspaceId", workspace._id).eq("accountId", account._id))
      .unique();

    const role = deriveWorkspaceMembershipRole(data.role?.slug);
    const status = deriveOrganizationMembershipState(data.status);

    await upsertOrganizationMembership(ctx, {
      organizationId: workspace.organizationId,
      accountId: account._id,
      role,
      status,
      billable: status === "active",
      now,
    });

    if (status === "active") {
      await markPendingInvitesAcceptedByEmail(ctx, {
        organizationId: workspace.organizationId,
        email: account.email,
        acceptedAt: now,
      });
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        workosOrgMembershipId: event.data.id,
        role,
        status,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("workspaceMembers", {
      workspaceId: workspace._id,
      accountId: account._id,
      workosOrgMembershipId: event.data.id,
      role,
      status,
      createdAt: now,
      updatedAt: now,
    });
  },

  "organization_membership.updated": async (ctx, event) => {
    const now = Date.now();
    const data = event.data as WorkosMembershipEventData;
    const { membership, account, workspace } = await resolveMembershipRecord(ctx, data);

    if (!membership || !account || !workspace) {
      return;
    }

    const role = deriveWorkspaceMembershipRole(data.role?.slug);
    const status = deriveOrganizationMembershipState(data.status);

    await upsertOrganizationMembership(ctx, {
      organizationId: workspace.organizationId,
      accountId: account._id,
      role,
      status,
      billable: status === "active",
      now,
    });

    if (status === "active") {
      await markPendingInvitesAcceptedByEmail(ctx, {
        organizationId: workspace.organizationId,
        email: account.email,
        acceptedAt: now,
      });
    }

    await ctx.db.patch(membership._id, {
      workosOrgMembershipId: data.id,
      role,
      status,
      updatedAt: now,
    });
  },

  "organization_membership.deleted": async (ctx, event) => {
    const now = Date.now();
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workos_membership_id", (q) => q.eq("workosOrgMembershipId", event.data.id))
      .unique();
    if (!membership) return;

    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace?.organizationId) {
      await upsertOrganizationMembership(ctx, {
        organizationId: workspace.organizationId,
        accountId: membership.accountId,
        role: membership.role,
        status: "removed",
        billable: false,
        now,
      });
    }

    await ctx.db.delete(membership._id);
  },
} satisfies Partial<Parameters<AuthKit<DataModel>["events"]>[0]>;
