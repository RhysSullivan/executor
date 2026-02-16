import { Migrations } from "@convex-dev/migrations";
import type { Id } from "./_generated/dataModel.d.ts";
import type { DataModel } from "./_generated/dataModel.d.ts";
import { components } from "./_generated/api";

const migrations = new Migrations<DataModel>(components.migrations);

const LEGACY_GUEST_NAME = "Guest Workspace";
const ANONYMOUS_ORGANIZATION_NAME = "Anonymous Organization";
const ANONYMOUS_WORKSPACE_NAME = "Anonymous Workspace";

async function isAnonymousCreator(
  ctx: { db: { get: (id: Id<"accounts">) => Promise<{ provider: string } | null> } },
  accountId: Id<"accounts"> | undefined,
): Promise<boolean> {
  if (!accountId) {
    return false;
  }

  const account = await ctx.db.get(accountId);
  return account?.provider === "anonymous";
}

export const renameLegacyAnonymousOrganizations = migrations.define({
  table: "organizations",
  migrateOne: async (ctx, organization) => {
    if (organization.name !== LEGACY_GUEST_NAME) {
      return;
    }

    const anonymousCreator = await isAnonymousCreator(ctx, organization.createdByAccountId);
    if (!anonymousCreator) {
      return;
    }

    return {
      name: ANONYMOUS_ORGANIZATION_NAME,
      updatedAt: Date.now(),
    };
  },
});

export const renameLegacyAnonymousWorkspaces = migrations.define({
  table: "workspaces",
  migrateOne: async (ctx, workspace) => {
    if (workspace.name !== LEGACY_GUEST_NAME) {
      return;
    }

    const anonymousCreator = await isAnonymousCreator(ctx, workspace.createdByAccountId);
    if (!anonymousCreator) {
      return;
    }

    return {
      name: ANONYMOUS_WORKSPACE_NAME,
      updatedAt: Date.now(),
    };
  },
});

export const deleteAnonymousSessionsMissingAccountId = migrations.define({
  table: "anonymousSessions",
  migrateOne: async (ctx, session) => {
    if (session.accountId) {
      return;
    }

    await ctx.db.delete(session._id);
  },
});

export const deleteSourceCredentialsMissingProvider = migrations.define({
  table: "sourceCredentials",
  migrateOne: async (ctx, credential) => {
    if (credential.provider) {
      return;
    }

    await ctx.db.delete(credential._id);
  },
});

export const deleteAnonymousSessionsMissingUserId = migrations.define({
  table: "anonymousSessions",
  migrateOne: async (ctx, session) => {
    if (session.userId) {
      return;
    }

    await ctx.db.delete(session._id);
  },
});

export const cleanupTaskEmptyStringSentinels = migrations.define({
  table: "tasks",
  migrateOne: async (_ctx, task) => {
    const patch: Record<string, undefined> = {};
    if (task.actorId === "") patch.actorId = undefined;
    if (task.clientId === "") patch.clientId = undefined;
    if (Object.keys(patch).length > 0) return patch;
  },
});

export const cleanupAccessPolicyEmptyStringSentinels = migrations.define({
  table: "accessPolicies",
  migrateOne: async (_ctx, policy) => {
    const patch: Record<string, undefined> = {};
    if (policy.actorId === "") patch.actorId = undefined;
    if (policy.clientId === "") patch.clientId = undefined;
    if (Object.keys(patch).length > 0) return patch;
  },
});

export const cleanupWorkspaceToolCacheLegacyDtsStorageIds = migrations.define({
  table: "workspaceToolCache",
  migrateOne: async (ctx, entry) => {
    const legacy = (entry as any).dtsStorageIds as Array<{ storageId?: string }> | undefined;
    if (!Array.isArray(legacy) || legacy.length === 0) {
      if ((entry as any).dtsStorageIds !== undefined) {
        return { dtsStorageIds: undefined };
      }
      return;
    }

    for (const dts of legacy) {
      if (dts && typeof dts.storageId === "string") {
        await ctx.storage.delete(dts.storageId as any).catch(() => {});
      }
    }

    return { dtsStorageIds: undefined };
  },
});

export const run = migrations.runner();
