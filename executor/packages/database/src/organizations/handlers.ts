import type { Doc, Id } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { getOrganizationMembership, slugify } from "../../../core/src/identity";
import { ensureUniqueSlug } from "../../../core/src/slug";

type WorkspaceSummary = {
  id: Id<"workspaces">;
  organizationId: Id<"organizations">;
  name: string;
  slug: string;
  iconUrl: string | null;
};

type OptionalAccountCtx = QueryCtx & {
  account: Doc<"accounts"> | null;
  sessionId?: string;
};

type AuthedCtx = MutationCtx & {
  account: Doc<"accounts">;
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

export async function createOrganizationHandler(ctx: unknown, args: { name: string }) {
  const typedCtx = ctx as AuthedCtx;
  const account = typedCtx.account;
  const name = args.name.trim();
  if (name.length < 2) {
    throw new Error("Organization name must be at least 2 characters");
  }

  const now = Date.now();
  const slug = await ensureUniqueOrganizationSlug(typedCtx, name);
  const organizationId = await typedCtx.db.insert("organizations", {
    slug,
    name,
    status: "active",
    createdByAccountId: account._id,
    createdAt: now,
    updatedAt: now,
  });

  await typedCtx.db.insert("organizationMembers", {
    organizationId,
    accountId: account._id,
    role: "owner",
    status: "active",
    billable: true,
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const workspaceId = await typedCtx.db.insert("workspaces", {
    organizationId,
    slug: "default",
    name: "Default Workspace",
    createdByAccountId: account._id,
    createdAt: now,
    updatedAt: now,
  });

  const organization = await typedCtx.db.get(organizationId);
  const workspace = await typedCtx.db.get(workspaceId);
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
    workspace: await mapWorkspaceWithIcon(typedCtx, workspace),
  };
}

export async function listOrganizationsMineHandler(ctx: unknown) {
  const typedCtx = ctx as OptionalAccountCtx;
  const account = typedCtx.account;
  if (!account) {
    return [];
  }

  const memberships = await typedCtx.db
    .query("organizationMembers")
    .withIndex("by_account", (q) => q.eq("accountId", account._id))
    .collect();

  const organizations = await Promise.all(
    memberships
      .filter((membership) => membership.status === "active")
      .map(async (membership) => {
        const org = await typedCtx.db.get(membership.organizationId);
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
}

export async function getNavigationStateHandler(ctx: unknown) {
  const typedCtx = ctx as OptionalAccountCtx;
  const account = typedCtx.account;
  const organizations: Array<{ id: Id<"organizations">; name: string; slug: string; status: string; role: string }> = [];
  const workspaces: WorkspaceSummary[] = [];

  if (!account) {
    if (typedCtx.sessionId) {
      const anonymousSession = await typedCtx.db
        .query("anonymousSessions")
        .withIndex("by_session_id", (q) => q.eq("sessionId", typedCtx.sessionId as string))
        .unique();
      if (anonymousSession?.workspaceId) {
        const workspace = await typedCtx.db.get(anonymousSession.workspaceId);
        if (workspace) {
          workspaces.push(await mapWorkspaceWithIcon(typedCtx, workspace));
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

  const memberships = await typedCtx.db
    .query("organizationMembers")
    .withIndex("by_account", (q) => q.eq("accountId", account._id))
    .collect();

  const activeMemberships = memberships.filter((membership) => membership.status === "active");

  for (const membership of activeMemberships) {
    const org = await typedCtx.db.get(membership.organizationId);
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

    const orgWorkspaces = await typedCtx.db
      .query("workspaces")
      .withIndex("by_organization_created", (q) => q.eq("organizationId", org._id))
      .collect();
    for (const workspace of orgWorkspaces) {
      workspaces.push(await mapWorkspaceWithIcon(typedCtx, workspace));
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
}

export async function getOrganizationAccessHandler(
  ctx: unknown,
  args: { organizationId: Id<"organizations"> },
) {
  const typedCtx = ctx as OptionalAccountCtx;
  const account = typedCtx.account;
  if (!account) {
    return null;
  }

  const membership = await getOrganizationMembership(typedCtx, args.organizationId, account._id);
  if (!membership || membership.status !== "active") {
    return null;
  }

  return {
    accountId: account._id,
    role: membership.role,
    status: membership.status,
    billable: membership.billable,
  };
}

export async function resolveWorkosOrganizationIdHandler(
  ctx: unknown,
  args: { organizationId: Id<"organizations"> },
) {
  const typedCtx = ctx as OptionalAccountCtx;
  const account = typedCtx.account;
  if (!account) {
    return null;
  }

  const membership = await getOrganizationMembership(typedCtx, args.organizationId, account._id);
  if (!membership || membership.status !== "active") {
    return null;
  }

  const organization = await typedCtx.db.get(args.organizationId);
  if (!organization || organization.status !== "active") {
    return null;
  }

  return organization.workosOrgId ?? null;
}
