import type { Doc, Id } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { getOrganizationMembership, slugify } from "../../../core/src/identity";
import { ensureUniqueSlug } from "../../../core/src/slug";

type WorkspaceResult = {
  id: Id<"workspaces">;
  organizationId: Id<"organizations">;
  organizationName: string;
  organizationSlug: string;
  name: string;
  slug: string;
  iconUrl: string | null;
  createdAt: number;
};

type OptionalAccountCtx = QueryCtx & {
  account: Doc<"accounts"> | null;
};

type AuthedCtx = MutationCtx & {
  account: Doc<"accounts">;
};

async function workspaceHasActivity(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  const [
    task,
    approval,
    policy,
    credential,
    toolSource,
    member,
  ] = await Promise.all([
    ctx.db.query("tasks").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("approvals").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("accessPolicies").withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId))
      .first(),
    ctx.db.query("toolSources").withIndex("by_workspace_updated", (q) => q.eq("workspaceId", workspaceId)).first(),
    ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first(),
  ]);

  return Boolean(task || approval || policy || credential || toolSource || member);
}

async function filterDisplayWorkspaces(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  workspaces: Doc<"workspaces">[],
): Promise<Doc<"workspaces">[]> {
  if (workspaces.length <= 1) {
    return workspaces;
  }

  const starterWorkspace = workspaces.find((workspace) => workspace.name === "Default Workspace");
  if (!starterWorkspace) {
    return workspaces;
  }

  const hasActivity = await workspaceHasActivity(ctx, starterWorkspace._id);
  if (hasActivity) {
    return workspaces;
  }

  return workspaces.filter((workspace) => workspace._id !== starterWorkspace._id);
}

async function cleanupEmptyStarterWorkspace(
  ctx: Pick<MutationCtx, "db">,
  organizationId: Id<"organizations">,
  preserveWorkspaceId: Id<"workspaces">,
): Promise<void> {
  const docs = await ctx.db
    .query("workspaces")
    .withIndex("by_organization_created", (q) => q.eq("organizationId", organizationId))
    .collect();

  if (docs.length <= 1) {
    return;
  }

  const starterWorkspace = docs.find(
    (workspace) => workspace.name === "Default Workspace" && workspace._id !== preserveWorkspaceId,
  );
  if (!starterWorkspace) {
    return;
  }

  const hasActivity = await workspaceHasActivity(ctx, starterWorkspace._id);
  if (hasActivity) {
    return;
  }

  await ctx.db.delete(starterWorkspace._id);
}

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

async function ensureUniqueWorkspaceSlug(
  ctx: Pick<MutationCtx, "db">,
  organizationId: Id<"organizations">,
  baseName: string,
): Promise<string> {
  const baseSlug = slugify(baseName);
  return await ensureUniqueSlug(baseSlug, async (candidate) => {
    const collision = await ctx.db
      .query("workspaces")
      .withIndex("by_organization_slug", (q) => q.eq("organizationId", organizationId).eq("slug", candidate))
      .unique();
    return collision !== null;
  });
}

async function toWorkspaceResult(
  ctx: Pick<QueryCtx, "db" | "storage"> | Pick<MutationCtx, "db" | "storage">,
  workspace: Doc<"workspaces">,
): Promise<WorkspaceResult> {
  const organization = await ctx.db.get(workspace.organizationId);
  if (!organization) {
    throw new Error("Workspace organization not found");
  }

  const iconUrl = workspace.iconStorageId ? await ctx.storage.getUrl(workspace.iconStorageId) : null;
  return {
    id: workspace._id,
    organizationId: workspace.organizationId,
    organizationName: organization.name,
    organizationSlug: organization.slug,
    name: workspace.name,
    slug: workspace.slug,
    iconUrl,
    createdAt: workspace.createdAt,
  };
}

export async function createWorkspaceHandler(
  ctx: unknown,
  args: { name: string; organizationId?: Id<"organizations">; iconStorageId?: Id<"_storage"> },
) {
  const typedCtx = ctx as AuthedCtx;
  const account = typedCtx.account;
  const name = args.name.trim();
  if (name.length < 2) {
    throw new Error("Workspace name must be at least 2 characters");
  }

  let organizationId = args.organizationId;
  if (organizationId) {
    const membership = await getOrganizationMembership(typedCtx, organizationId, account._id);
    if (!membership || membership.status !== "active") {
      throw new Error("You are not a member of this organization");
    }
  } else {
    const now = Date.now();
    const organizationSlug = await ensureUniqueOrganizationSlug(typedCtx, name);
    organizationId = await typedCtx.db.insert("organizations", {
      slug: organizationSlug,
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
  }

  if (!organizationId) {
    throw new Error("Organization is required to create workspace");
  }

  const now = Date.now();
  const slug = await ensureUniqueWorkspaceSlug(typedCtx, organizationId, name);

  const workspaceId = await typedCtx.db.insert("workspaces", {
    organizationId,
    slug,
    name,
    iconStorageId: args.iconStorageId,
    createdByAccountId: account._id,
    createdAt: now,
    updatedAt: now,
  });

  const workspace = await typedCtx.db.get(workspaceId);
  if (!workspace) {
    throw new Error("Failed to create workspace");
  }

  await cleanupEmptyStarterWorkspace(typedCtx, organizationId, workspaceId);

  return await toWorkspaceResult(typedCtx, workspace);
}

export async function listWorkspacesHandler(ctx: unknown, args: { organizationId?: Id<"organizations"> }) {
  const typedCtx = ctx as OptionalAccountCtx;
  const account = typedCtx.account;
  if (!account) {
    return [];
  }

  const organizationId = args.organizationId;
  if (organizationId) {
    const membership = await getOrganizationMembership(typedCtx, organizationId, account._id);
    if (!membership || membership.status !== "active") {
      return [];
    }

    const docs = await typedCtx.db
      .query("workspaces")
      .withIndex("by_organization_created", (q) => q.eq("organizationId", organizationId))
      .collect();
    const filteredDocs = await filterDisplayWorkspaces(typedCtx, docs);
    return await Promise.all(filteredDocs.map(async (workspace) => await toWorkspaceResult(typedCtx, workspace)));
  }

  const memberships = await typedCtx.db
    .query("organizationMembers")
    .withIndex("by_account", (q) => q.eq("accountId", account._id))
    .collect();

  const activeMemberships = memberships.filter((membership) => membership.status === "active");
  const allWorkspaces: WorkspaceResult[] = [];

  for (const membership of activeMemberships) {
    const docs = await typedCtx.db
      .query("workspaces")
      .withIndex("by_organization_created", (q) => q.eq("organizationId", membership.organizationId))
      .collect();
    const filteredDocs = await filterDisplayWorkspaces(typedCtx, docs);
    for (const workspace of filteredDocs) {
      allWorkspaces.push(await toWorkspaceResult(typedCtx, workspace));
    }
  }

  return Array.from(new Map(allWorkspaces.map((workspace) => [workspace.id, workspace])).values());
}

export async function generateWorkspaceIconUploadUrlHandler(ctx: unknown) {
  const typedCtx = ctx as AuthedCtx;
  void typedCtx.account;
  return await typedCtx.storage.generateUploadUrl();
}
