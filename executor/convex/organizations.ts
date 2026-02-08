import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getOrganizationMembership, requireAccountForRequest, resolveAccountForRequest, slugify } from "./lib/identity";

type WorkspaceSummary = {
  id: string;
  organizationId: string | null;
  name: string;
  slug: string;
  kind: string;
  iconUrl: string | null;
  runtimeWorkspaceId: string;
};

async function ensureUniqueOrganizationSlug(ctx: Pick<MutationCtx, "db">, baseName: string): Promise<string> {
  const baseSlug = slugify(baseName);
  const existing = await ctx.db
    .query("organizations")
    .withIndex("by_slug", (q) => q.eq("slug", baseSlug))
    .unique();
  if (!existing) {
    return baseSlug;
  }

  for (let i = 0; i < 20; i += 1) {
    const candidate = `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
    const collision = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();
    if (!collision) {
      return candidate;
    }
  }

  return `${baseSlug}-${Date.now()}`;
}

async function mapWorkspaceWithIcon(
  ctx: Pick<QueryCtx, "storage"> | Pick<MutationCtx, "storage">,
  workspace: Doc<"workspaces">,
): Promise<WorkspaceSummary> {
  const iconUrl = workspace.iconStorageId ? await ctx.storage.getUrl(workspace.iconStorageId) : null;
  return {
    id: String(workspace._id),
    organizationId: workspace.organizationId ? String(workspace.organizationId) : null,
    name: workspace.name,
    slug: workspace.slug,
    kind: workspace.kind,
    iconUrl,
    runtimeWorkspaceId: workspace.legacyWorkspaceId ?? `ws_${String(workspace._id)}`,
  };
}

export const create = mutation({
  args: {
    name: v.string(),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await requireAccountForRequest(ctx, args.sessionId);
    const name = args.name.trim();
    if (name.length < 2) {
      throw new Error("Organization name must be at least 2 characters");
    }

    const now = Date.now();
    const slug = await ensureUniqueOrganizationSlug(ctx, name);
    const organizationId = await ctx.db.insert("organizations", {
      slug,
      name,
      status: "active",
      createdByAccountId: account._id,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("organizationMembers", {
      organizationId,
      accountId: account._id,
      role: "owner",
      status: "active",
      billable: true,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      slug: "default",
      name: "Default Workspace",
      kind: "organization",
      visibility: "organization",
      plan: "free",
      legacyWorkspaceId: `ws_${crypto.randomUUID()}`,
      createdByAccountId: account._id,
      createdAt: now,
      updatedAt: now,
    });

    const organization = await ctx.db.get(organizationId);
    const workspace = await ctx.db.get(workspaceId);
    if (!organization || !workspace) {
      throw new Error("Failed to create organization");
    }

    return {
      organization: {
        id: String(organization._id),
        slug: organization.slug,
        name: organization.name,
        status: organization.status,
        createdAt: organization.createdAt,
      },
      workspace: await mapWorkspaceWithIcon(ctx, workspace),
    };
  },
});

export const listMine = query({
  args: {
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    if (!account) {
      return [];
    }

    const memberships = await ctx.db
      .query("organizationMembers")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();

    const organizations = await Promise.all(
      memberships
        .filter((membership) => membership.status === "active")
        .map(async (membership) => {
          const org = await ctx.db.get(membership.organizationId);
          if (!org) {
            return null;
          }

          return {
            id: String(org._id),
            name: org.name,
            slug: org.slug,
            status: org.status,
            role: membership.role,
          };
        }),
    );

    return organizations.filter((org): org is NonNullable<typeof org> => org !== null);
  },
});

export const getNavigationState = query({
  args: {
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    const organizations: Array<{ id: string; name: string; slug: string; status: string; role: string }> = [];
    const workspaces: WorkspaceSummary[] = [];

    if (!account) {
      if (args.sessionId) {
        const sessionId = args.sessionId;
        const anonymousSession = await ctx.db
          .query("anonymousSessions")
          .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
          .unique();
        if (anonymousSession?.workspaceDocId) {
          const workspace = await ctx.db.get(anonymousSession.workspaceDocId);
          if (workspace) {
            workspaces.push(await mapWorkspaceWithIcon(ctx, workspace));
          }
        }
      }

      return {
        currentOrganizationId: null,
        currentWorkspaceId: workspaces[0]?.runtimeWorkspaceId ?? null,
        organizations,
        workspaces,
      };
    }

    const memberships = await ctx.db
      .query("organizationMembers")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();

    const activeMemberships = memberships.filter((membership) => membership.status === "active");

    for (const membership of activeMemberships) {
      const org = await ctx.db.get(membership.organizationId);
      if (!org) {
        continue;
      }

      organizations.push({
        id: String(org._id),
        name: org.name,
        slug: org.slug,
        status: org.status,
        role: membership.role,
      });

      const orgWorkspaces = await ctx.db
        .query("workspaces")
        .withIndex("by_organization_created", (q) => q.eq("organizationId", org._id))
        .collect();
      for (const workspace of orgWorkspaces) {
        workspaces.push(await mapWorkspaceWithIcon(ctx, workspace));
      }
    }

    const personalWorkspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_creator_created", (q) => q.eq("createdByAccountId", account._id))
      .collect();
    for (const workspace of personalWorkspaces) {
      if (workspace.organizationId) {
        continue;
      }
      workspaces.push(await mapWorkspaceWithIcon(ctx, workspace));
    }

    const uniqueWorkspaces = Array.from(
      new Map(workspaces.map((workspace) => [workspace.runtimeWorkspaceId, workspace])).values(),
    );

    return {
      currentOrganizationId: organizations[0]?.id ?? null,
      currentWorkspaceId: uniqueWorkspaces[0]?.runtimeWorkspaceId ?? null,
      organizations,
      workspaces: uniqueWorkspaces,
    };
  },
});

export const getOrganizationAccess = query({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await resolveAccountForRequest(ctx, args.sessionId);
    if (!account) {
      return null;
    }

    const membership = await getOrganizationMembership(ctx, args.organizationId, account._id);
    if (!membership || membership.status !== "active") {
      return null;
    }

    return {
      accountId: String(account._id),
      role: membership.role,
      status: membership.status,
      billable: membership.billable,
    };
  },
});
