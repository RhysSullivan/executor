import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { mapStorageInstance } from "../../src/database/mappers";
import {
  storageDurabilityValidator,
  storageInstanceStatusValidator,
  storageScopeTypeValidator,
  storageProviderValidator,
} from "../../src/database/validators";

const DEFAULT_EPHEMERAL_TTL_HOURS = 24;
const MAX_EPHEMERAL_TTL_HOURS = 24 * 30;
const STORAGE_TOUCH_DEBOUNCE_MS = 5_000;

function resolveStorageProvider(): "agentfs-local" | "agentfs-cloudflare" {
  const raw = (process.env.AGENT_STORAGE_PROVIDER ?? "").trim().toLowerCase();

  const isHostedConvexDeployment = [process.env.CONVEX_URL, process.env.CONVEX_SITE_URL]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .some((value) => {
      try {
        const hostname = new URL(value).hostname.trim().toLowerCase();
        return hostname.endsWith(".convex.cloud") || hostname.endsWith(".convex.site");
      } catch {
        return false;
      }
    });

  if (raw === "cloudflare" || raw === "agentfs-cloudflare") {
    return "agentfs-cloudflare";
  }

  if (isHostedConvexDeployment) {
    throw new Error(
      "agentfs-local is not supported on hosted Convex deployments because filesystem state is not shared across workers. Set AGENT_STORAGE_PROVIDER=agentfs-cloudflare.",
    );
  }

  return "agentfs-local";
}

function clampEphemeralTtlHours(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_EPHEMERAL_TTL_HOURS;
  }

  return Math.max(1, Math.min(MAX_EPHEMERAL_TTL_HOURS, Math.floor(value)));
}

function canAccessInstance(args: {
  workspaceId: Id<"workspaces">;
  organizationId: Id<"organizations">;
  accountId?: Id<"accounts">;
  doc: {
    scopeType: "scratch" | "account" | "workspace" | "organization";
    organizationId: Id<"organizations">;
    workspaceId?: Id<"workspaces">;
    accountId?: Id<"accounts">;
  };
}): boolean {
  if (args.doc.organizationId !== args.organizationId) {
    return false;
  }

  if (args.doc.scopeType === "workspace" || args.doc.scopeType === "scratch") {
    return args.doc.workspaceId === args.workspaceId;
  }

  if (args.doc.scopeType === "account") {
    return Boolean(args.accountId && args.doc.accountId && args.accountId === args.doc.accountId);
  }

  return true;
}

function isExpired(doc: { expiresAt?: number }, now = Date.now()): boolean {
  return typeof doc.expiresAt === "number" && Number.isFinite(doc.expiresAt) && doc.expiresAt <= now;
}

async function isOrganizationAdmin(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    accountId?: Id<"accounts">;
  },
): Promise<boolean> {
  if (!args.accountId) {
    return false;
  }

  const membership = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_account", (q) => q.eq("organizationId", args.organizationId).eq("accountId", args.accountId))
    .unique();

  if (!membership || membership.status !== "active") {
    return false;
  }

  return membership.role === "owner" || membership.role === "admin";
}

async function assertCanManageSharedScope(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    accountId?: Id<"accounts">;
    scopeType: "workspace" | "organization";
    action: "open" | "close" | "delete";
  },
) {
  const isAdmin = await isOrganizationAdmin(ctx, {
    organizationId: args.organizationId,
    accountId: args.accountId,
  });
  if (!isAdmin) {
    throw new Error(
      `Only organization admins can ${args.action} ${args.scopeType} storage instances`,
    );
  }
}

export const openStorageInstance = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    instanceId: v.optional(v.string()),
    scopeType: v.optional(storageScopeTypeValidator),
    durability: v.optional(storageDurabilityValidator),
    purpose: v.optional(v.string()),
    ttlHours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${args.workspaceId}`);
    }

    const now = Date.now();
    const organizationId = workspace.organizationId;
    const requestedInstanceId = args.instanceId?.trim() ?? "";
    if (requestedInstanceId.length > 0) {
      const existing = await ctx.db
        .query("storageInstances")
        .withIndex("by_instance_id", (q) => q.eq("instanceId", requestedInstanceId))
        .unique();
      if (!existing) {
        throw new Error(`Storage instance not found: ${requestedInstanceId}`);
      }

      if (!canAccessInstance({
        workspaceId: args.workspaceId,
        organizationId,
        accountId: args.accountId,
        doc: existing,
      })) {
        throw new Error("Storage instance is not accessible in this workspace context");
      }

      if (existing.status === "deleted") {
        throw new Error(`Storage instance has been deleted: ${requestedInstanceId}`);
      }

      if (isExpired(existing, now)) {
        await ctx.db.patch(existing._id, {
          status: "closed",
          closedAt: now,
          updatedAt: now,
        });
        throw new Error(`Storage instance has expired: ${requestedInstanceId}`);
      }

      const nextStatus = existing.status === "closed" ? "active" : existing.status;
      await ctx.db.patch(existing._id, {
        status: nextStatus,
        updatedAt: now,
        lastSeenAt: now,
      });

      const refreshed = await ctx.db
        .query("storageInstances")
        .withIndex("by_instance_id", (q) => q.eq("instanceId", requestedInstanceId))
        .unique();
      if (!refreshed) {
        throw new Error(`Failed to reopen storage instance: ${requestedInstanceId}`);
      }

      return mapStorageInstance(refreshed);
    }

    const scopeType = args.scopeType ?? "scratch";
    if (scopeType === "account" && !args.accountId) {
      throw new Error("accountId is required for account-scoped storage instances");
    }
    if (scopeType === "workspace" || scopeType === "organization") {
      await assertCanManageSharedScope(ctx, {
        organizationId,
        accountId: args.accountId,
        scopeType,
        action: "open",
      });
    }

    const durability = args.durability
      ?? (scopeType === "scratch" ? "ephemeral" : "durable");
    const ttlHours = clampEphemeralTtlHours(args.ttlHours);
    const expiresAt = durability === "ephemeral"
      ? now + ttlHours * 60 * 60 * 1000
      : undefined;
    const instanceId = `inst_${crypto.randomUUID()}`;
    const provider = resolveStorageProvider();
    const backendKey = `${organizationId}:${instanceId}`;
    const purpose = args.purpose?.trim();

    await ctx.db.insert("storageInstances", {
      instanceId,
      scopeType,
      durability,
      status: "active",
      provider,
      backendKey,
      organizationId,
      workspaceId: scopeType === "workspace" || scopeType === "scratch" ? args.workspaceId : undefined,
      accountId: scopeType === "account" || scopeType === "scratch" ? args.accountId : undefined,
      createdByAccountId: args.accountId,
      purpose: purpose && purpose.length > 0 ? purpose : undefined,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      expiresAt,
    });

    const created = await ctx.db
      .query("storageInstances")
      .withIndex("by_instance_id", (q) => q.eq("instanceId", instanceId))
      .unique();
    if (!created) {
      throw new Error("Failed to create storage instance");
    }

    return mapStorageInstance(created);
  },
});

export const getStorageInstance = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    instanceId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return null;
    }

    const doc = await ctx.db
      .query("storageInstances")
      .withIndex("by_instance_id", (q) => q.eq("instanceId", args.instanceId))
      .unique();
    if (!doc) {
      return null;
    }

    if (!canAccessInstance({
      workspaceId: args.workspaceId,
      organizationId: workspace.organizationId,
      accountId: args.accountId,
      doc,
    })) {
      return null;
    }

    if (doc.status === "deleted" || isExpired(doc)) {
      return null;
    }

    return mapStorageInstance(doc);
  },
});

export const listStorageInstances = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    scopeType: v.optional(storageScopeTypeValidator),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return [];
    }

    const organizationId = workspace.organizationId;
    const [workspaceDocs, organizationDocs, accountDocs] = await Promise.all([
      ctx.db
        .query("storageInstances")
        .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", args.workspaceId))
        .order("desc")
        .collect(),
      ctx.db
        .query("storageInstances")
        .withIndex("by_org_scope_updated", (q) => q.eq("organizationId", organizationId).eq("scopeType", "organization"))
        .order("desc")
        .collect(),
      args.accountId
        ? ctx.db
          .query("storageInstances")
          .withIndex("by_org_account_updated", (q) => q.eq("organizationId", organizationId).eq("accountId", args.accountId))
          .order("desc")
          .collect()
        : Promise.resolve([]),
    ]);

    const deduped = [...workspaceDocs, ...organizationDocs, ...accountDocs]
      .filter((doc, index, docs) => docs.findIndex((candidate) => candidate.instanceId === doc.instanceId) === index)
      .filter((doc) => canAccessInstance({
        workspaceId: args.workspaceId,
        organizationId,
        accountId: args.accountId,
        doc,
      }))
      .filter((doc) => args.scopeType ? doc.scopeType === args.scopeType : true)
      .filter((doc) => args.includeDeleted ? true : (doc.status !== "deleted" && !isExpired(doc)))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return deduped.map(mapStorageInstance);
  },
});

export const closeStorageInstance = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    instanceId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return null;
    }

    const doc = await ctx.db
      .query("storageInstances")
      .withIndex("by_instance_id", (q) => q.eq("instanceId", args.instanceId))
      .unique();
    if (!doc) {
      return null;
    }

    if (!canAccessInstance({
      workspaceId: args.workspaceId,
      organizationId: workspace.organizationId,
      accountId: args.accountId,
      doc,
    })) {
      throw new Error("Storage instance is not accessible in this workspace context");
    }

    if (doc.scopeType === "workspace" || doc.scopeType === "organization") {
      await assertCanManageSharedScope(ctx, {
        organizationId: workspace.organizationId,
        accountId: args.accountId,
        scopeType: doc.scopeType,
        action: "close",
      });
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: "closed",
      closedAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });

    const refreshed = await ctx.db
      .query("storageInstances")
      .withIndex("by_instance_id", (q) => q.eq("instanceId", args.instanceId))
      .unique();
    return refreshed ? mapStorageInstance(refreshed) : null;
  },
});

export const deleteStorageInstance = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    instanceId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return null;
    }

    const doc = await ctx.db
      .query("storageInstances")
      .withIndex("by_instance_id", (q) => q.eq("instanceId", args.instanceId))
      .unique();
    if (!doc) {
      return null;
    }

    if (!canAccessInstance({
      workspaceId: args.workspaceId,
      organizationId: workspace.organizationId,
      accountId: args.accountId,
      doc,
    })) {
      throw new Error("Storage instance is not accessible in this workspace context");
    }

    if (doc.scopeType === "workspace" || doc.scopeType === "organization") {
      await assertCanManageSharedScope(ctx, {
        organizationId: workspace.organizationId,
        accountId: args.accountId,
        scopeType: doc.scopeType,
        action: "delete",
      });
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: "deleted",
      closedAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });

    const refreshed = await ctx.db
      .query("storageInstances")
      .withIndex("by_instance_id", (q) => q.eq("instanceId", args.instanceId))
      .unique();
    return refreshed ? mapStorageInstance(refreshed) : null;
  },
});

export const touchStorageInstance = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    instanceId: v.string(),
    status: v.optional(storageInstanceStatusValidator),
    sizeBytes: v.optional(v.number()),
    fileCount: v.optional(v.number()),
    provider: v.optional(storageProviderValidator),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return null;
    }

    const doc = await ctx.db
      .query("storageInstances")
      .withIndex("by_instance_id", (q) => q.eq("instanceId", args.instanceId))
      .unique();
    if (!doc) {
      return null;
    }

    if (!canAccessInstance({
      workspaceId: args.workspaceId,
      organizationId: workspace.organizationId,
      accountId: args.accountId,
      doc,
    })) {
      return null;
    }

    if (isExpired(doc)) {
      return null;
    }

    const now = Date.now();
    const hasStatusUpdate = Boolean(args.status || args.provider);
    const hasUsageUpdate = typeof args.sizeBytes === "number" || typeof args.fileCount === "number";
    const shouldPatch = hasStatusUpdate
      || hasUsageUpdate
      || now - doc.lastSeenAt >= STORAGE_TOUCH_DEBOUNCE_MS;

    if (!shouldPatch) {
      return mapStorageInstance(doc);
    }

    await ctx.db.patch(doc._id, {
      updatedAt: now,
      lastSeenAt: now,
      ...(args.status ? { status: args.status } : {}),
      ...(typeof args.sizeBytes === "number" ? { sizeBytes: args.sizeBytes } : {}),
      ...(typeof args.fileCount === "number" ? { fileCount: args.fileCount } : {}),
      ...(args.provider ? { provider: args.provider } : {}),
    });

    const refreshed = await ctx.db
      .query("storageInstances")
      .withIndex("by_instance_id", (q) => q.eq("instanceId", args.instanceId))
      .unique();
    return refreshed ? mapStorageInstance(refreshed) : null;
  },
});
