import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { optionalAccountQuery, authedMutation } from "./lib/functionBuilders";
import { getOrganizationMembership, slugify } from "./lib/identity";
import { ensureUniqueSlug } from "./lib/slug";

type WorkspaceSummary = {
  id: Id<"workspaces">;
  organizationId: Id<"organizations">;
  name: string;
  slug: string;
  iconUrl: string | null;
};

async function ensureUniqueOrganizationSlug(ctx: Pick<MutationCtx, "db">, baseName: string): Promise<string> {
  const baseSlug = slugify(baseName);
  return await ensureUniqueSlug(baseSlug, async (candidate) => {
    const collision = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();
    return collision !== null;
  });
}

async function mapWorkspaceWithIcon(
  ctx: Pick<QueryCtx, "storage"> | Pick<MutationCtx, "storage">,
  workspace: Doc<"workspaces">,
): Promise<WorkspaceSummary> {
  const iconUrl = workspace.iconStorageId ? await ctx.storage.getUrl(workspace.iconStorageId) : null;
  return {
    id: workspace._id,
    organizationId: workspace.organizationId,
    name: workspace.name,
    slug: workspace.slug,
    iconUrl,
  };
}

export const create = authedMutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const account = ctx.account;
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
      plan: "free",
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
        id: organization._id,
        slug: organization.slug,
        name: organization.name,
        status: organization.status,
        createdAt: organization.createdAt,
      },
      workspace: await mapWorkspaceWithIcon(ctx, workspace),
    };
  },
});

export const listMine = optionalAccountQuery({
  args: {},
  handler: async (ctx) => {
    const account = ctx.account;
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
            id: org._id,
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

export const getNavigationState = optionalAccountQuery({
  args: {},
  handler: async (ctx) => {
    const account = ctx.account;
    const organizations: Array<{ id: Id<"organizations">; name: string; slug: string; status: string; role: string }> = [];
    const workspaces: WorkspaceSummary[] = [];

    if (!account) {
      if (ctx.sessionId) {
        const sessionId = ctx.sessionId;
        const anonymousSession = await ctx.db
          .query("anonymousSessions")
          .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
          .unique();
        if (anonymousSession?.workspaceId) {
          const workspace = await ctx.db.get(anonymousSession.workspaceId);
          if (workspace) {
            workspaces.push(await mapWorkspaceWithIcon(ctx, workspace));
          }
        }
      }

      return {
        currentOrganizationId: workspaces[0]?.organizationId ?? null,
        currentWorkspaceId: workspaces[0]?.id ?? null,
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
        id: org._id,
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

    const uniqueWorkspaces = Array.from(
      new Map(workspaces.map((workspace) => [workspace.id, workspace])).values(),
    );

    return {
      currentOrganizationId: organizations[0]?.id ?? null,
      currentWorkspaceId: uniqueWorkspaces[0]?.id ?? null,
      organizations,
      workspaces: uniqueWorkspaces,
    };
  },
});

export const getOrganizationAccess = optionalAccountQuery({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const account = ctx.account;
    if (!account) {
      return null;
    }

    const membership = await getOrganizationMembership(ctx, args.organizationId, account._id);
    if (!membership || membership.status !== "active") {
      return null;
    }

    return {
      accountId: account._id,
      role: membership.role,
      status: membership.status,
      billable: membership.billable,
    };
  },
});

export const resolveWorkosOrganizationId = optionalAccountQuery({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const account = ctx.account;
    if (!account) {
      return null;
    }

    const membership = await getOrganizationMembership(ctx, args.organizationId, account._id);
    if (!membership || membership.status !== "active") {
      return null;
    }

    const organization = await ctx.db.get(args.organizationId);
    if (!organization || organization.status !== "active") {
      return null;
    }

    return organization.workosOrgId ?? null;
  },
});
