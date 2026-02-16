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
  mapOrganizationRoleToWorkspaceRole,
  markPendingInvitesAcceptedByEmail,
  upsertOrganizationMembership,
} from "./memberships";
import { ensureUniqueOrganizationSlug } from "./naming";
import { seedWorkspaceMembersFromOrganization } from "./workspace_membership_projection";

type WorkosMembershipEventData = {
  id: string;
  user_id?: string;
  userId?: string;
  organization_id?: string;
  organizationId?: string;
  role?: { slug?: string };
  status?: string;
};

function deriveOrganizationRoleFromWorkosSlug(workosRoleSlug?: string): Doc<"organizationMembers">["role"] {
  return workosRoleSlug === "admin" ? "admin" : "member";
}

async function resolveMembershipAccountAndOrganization(
  ctx: Pick<MutationCtx, "db">,
  data: WorkosMembershipEventData,
) {
  const workosUserId = data.user_id ?? data.userId;
  const workosOrgId = data.organization_id ?? data.organizationId;

  if (workosUserId && workosOrgId) {
    const [account, organization] = await Promise.all([
      getAccountByWorkosId(ctx, workosUserId),
      getOrganizationByWorkosOrgId(ctx, workosOrgId),
    ]);

    if (account && organization) {
      return {
        account,
        organization,
        fallbackRole: undefined as Doc<"workspaceMembers">["role"] | undefined,
      };
    }
  }

  const linkedMemberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workos_membership_id", (q) => q.eq("workosOrgMembershipId", data.id))
    .collect();
  if (linkedMemberships.length === 0) {
    return {
      account: null,
      organization: null,
      fallbackRole: undefined as Doc<"workspaceMembers">["role"] | undefined,
    };
  }

  const linkedMembership = linkedMemberships[0]!;
  const [account, workspace] = await Promise.all([
    ctx.db.get(linkedMembership.accountId),
    ctx.db.get(linkedMembership.workspaceId),
  ]);
  if (!account || !workspace) {
    return {
      account: null,
      organization: null,
      fallbackRole: linkedMembership.role,
    };
  }

  const organization = await ctx.db.get(workspace.organizationId);
  return {
    account,
    organization,
    fallbackRole: linkedMembership.role,
  };
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

      await seedWorkspaceMembersFromOrganization(ctx, {
        organizationId: organization._id,
        workspaceId: existingWorkspace._id,
        now,
        mapRole: mapOrganizationRoleToWorkspaceRole,
      });
      return;
    }

    const organizationWorkspace = await getFirstWorkspaceByOrganizationId(ctx, organization._id);
    if (organizationWorkspace) {
      await ctx.db.patch(organizationWorkspace._id, {
        workosOrgId: event.data.id,
        updatedAt: now,
      });

      await seedWorkspaceMembersFromOrganization(ctx, {
        organizationId: organization._id,
        workspaceId: organizationWorkspace._id,
        now,
        mapRole: mapOrganizationRoleToWorkspaceRole,
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

    const createdWorkspace = await getWorkspaceByWorkosOrgId(ctx, event.data.id);
    if (createdWorkspace) {
      await seedWorkspaceMembersFromOrganization(ctx, {
        organizationId: organization._id,
        workspaceId: createdWorkspace._id,
        now,
        mapRole: mapOrganizationRoleToWorkspaceRole,
      });
    }
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
    const { account, organization } = await resolveMembershipAccountAndOrganization(ctx, data);
    if (!account || !organization) return;

    const role = deriveOrganizationRoleFromWorkosSlug(data.role?.slug);
    const status = deriveOrganizationMembershipState(data.status);

    await upsertOrganizationMembership(ctx, {
      organizationId: organization._id,
      accountId: account._id,
      role,
      status,
      billable: status === "active",
      workosOrgMembershipId: data.id,
      now,
    });

    if (status === "active") {
      await markPendingInvitesAcceptedByEmail(ctx, {
        organizationId: organization._id,
        email: account.email,
        acceptedAt: now,
      });
    }
  },

  "organization_membership.updated": async (ctx, event) => {
    const now = Date.now();
    const data = event.data as WorkosMembershipEventData;
    const { account, organization } = await resolveMembershipAccountAndOrganization(ctx, data);

    if (!account || !organization) {
      return;
    }

    const role = deriveOrganizationRoleFromWorkosSlug(data.role?.slug);
    const status = deriveOrganizationMembershipState(data.status);

    await upsertOrganizationMembership(ctx, {
      organizationId: organization._id,
      accountId: account._id,
      role,
      status,
      billable: status === "active",
      workosOrgMembershipId: data.id,
      now,
    });

    if (status === "active") {
      await markPendingInvitesAcceptedByEmail(ctx, {
        organizationId: organization._id,
        email: account.email,
        acceptedAt: now,
      });
    }
  },

  "organization_membership.deleted": async (ctx, event) => {
    const now = Date.now();
    const data = event.data as WorkosMembershipEventData;
    const { account, organization, fallbackRole } = await resolveMembershipAccountAndOrganization(ctx, data);
    if (!account || !organization) {
      return;
    }

    const existingOrgMembership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_account", (q) => q.eq("organizationId", organization._id).eq("accountId", account._id))
      .unique();

    await upsertOrganizationMembership(ctx, {
      organizationId: organization._id,
      accountId: account._id,
      role: existingOrgMembership?.role ?? (fallbackRole === "admin" ? "admin" : "member"),
      status: "removed",
      billable: false,
      workosOrgMembershipId: data.id,
      now,
    });
  },
} satisfies Partial<Parameters<AuthKit<DataModel>["events"]>[0]>;
