"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type {
  ToolDescriptor,
  OpenApiSourceQuality,
  SourceAuthProfile,
  StorageInstanceRecord,
} from "../../core/src/types";
import { isAdminRole } from "../../core/src/identity";
import { requireCanonicalAccount } from "../src/runtime/account_auth";
import {
  listToolsForContext,
  listToolsWithWarningsForContext,
  rebuildWorkspaceToolInventoryForContext,
  type ToolInventoryStatus,
} from "../src/runtime/workspace_tools";
import { runQueuedTask } from "../src/runtime/task_runner";
import { handleExternalToolCallRequest } from "../src/runtime/external_tool_call";
import { jsonObjectValidator } from "../src/database/validators";
import { customAction } from "../../core/src/function-builders";
import { encodeToolCallResultForTransport } from "../../core/src/tool-call-result-transport";
import { previewOpenApiSourceUpgradeForContext, type OpenApiUpgradeDiffPreview } from "../src/runtime/tool_upgrade";
import { getStorageProvider, type StorageEncoding, type StorageProvider } from "../src/runtime/storage_provider";
import { shouldTouchStorageOnRead } from "../src/runtime/storage_touch_policy";
import { shouldRefreshStorageUsage } from "../src/runtime/storage_usage_refresh";

function isReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  return trimmed.startsWith("select")
    || trimmed.startsWith("pragma")
    || trimmed.startsWith("explain")
    || trimmed.startsWith("with");
}

function hasMultipleSqlStatements(sql: string): boolean {
  const statements = sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return statements.length > 1;
}

async function resolveStorageInspectorContext(
  ctx: Parameters<typeof requireCanonicalAccount>[0],
  args: {
    workspaceId: Parameters<typeof requireCanonicalAccount>[1]["workspaceId"];
    accountId?: Parameters<typeof requireCanonicalAccount>[1]["accountId"];
    sessionId?: string;
    instanceId: string;
  },
): Promise<{
  accountId: Awaited<ReturnType<typeof requireCanonicalAccount>>["accountId"];
  instance: StorageInstanceRecord;
  provider: StorageProvider;
}> {
  const access = await requireCanonicalAccount(ctx, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    accountId: args.accountId,
  });

  const instance = await ctx.runQuery(internal.database.getStorageInstance, {
    workspaceId: args.workspaceId,
    accountId: access.accountId,
    instanceId: args.instanceId,
  }) as StorageInstanceRecord | null;

  if (!instance) {
    throw new Error(`Storage instance not found or inaccessible: ${args.instanceId}`);
  }

  return {
    accountId: access.accountId,
    instance,
    provider: getStorageProvider(instance.provider),
  };
}

async function touchStorageInstance(
  ctx: Parameters<typeof requireCanonicalAccount>[0],
  args: {
    workspaceId: Parameters<typeof requireCanonicalAccount>[1]["workspaceId"];
    accountId: Awaited<ReturnType<typeof requireCanonicalAccount>>["accountId"];
    instance: StorageInstanceRecord;
    provider: StorageProvider;
    withUsage: boolean;
  },
) {
  if (!args.withUsage && !shouldTouchStorageOnRead()) {
    return;
  }

  const usage = args.withUsage && shouldRefreshStorageUsage(args.instance.id)
    ? await args.provider.usage(args.instance)
    : undefined;
  await ctx.runMutation(internal.database.touchStorageInstance, {
    workspaceId: args.workspaceId,
    accountId: args.accountId,
    instanceId: args.instance.id,
    provider: args.instance.provider,
    ...(usage?.sizeBytes !== undefined ? { sizeBytes: usage.sizeBytes } : {}),
    ...(usage?.fileCount !== undefined ? { fileCount: usage.fileCount } : {}),
  });
}

export const listToolsWithWarnings = customAction({
  method: "POST",
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    sessionId: v.optional(v.string()),
    includeDetails: v.optional(v.boolean()),
    includeSourceMeta: v.optional(v.boolean()),
    toolPaths: v.optional(v.array(v.string())),
    source: v.optional(v.string()),
    sourceName: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    buildId: v.optional(v.string()),
    fetchAll: v.optional(v.boolean()),
    rebuildInventory: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tools: ToolDescriptor[];
    warnings: string[];
    typesUrl?: string;
    sourceQuality: Record<string, OpenApiSourceQuality>;
    sourceAuthProfiles: Record<string, SourceAuthProfile>;
    inventoryStatus: ToolInventoryStatus;
    nextCursor?: string | null;
    totalTools: number;
  }> => {
    const access = await requireCanonicalAccount(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      accountId: args.accountId,
    });

    if (args.rebuildInventory) {
      const workspaceAccess = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
      });

      if (!isAdminRole(workspaceAccess.role)) {
        throw new Error("Only workspace admins can regenerate tool inventory");
      }

      await rebuildWorkspaceToolInventoryForContext(ctx, {
        workspaceId: args.workspaceId,
        accountId: access.accountId,
        clientId: access.clientId,
      });
    }

    const inventory = await listToolsWithWarningsForContext(ctx, {
      workspaceId: args.workspaceId,
      accountId: access.accountId,
      clientId: access.clientId,
    }, {
      includeDetails: args.includeDetails ?? false,
      includeSourceMeta: args.includeSourceMeta ?? (args.toolPaths ? false : true),
      toolPaths: args.toolPaths,
      source: args.source,
      sourceName: args.sourceName,
      cursor: args.cursor,
      limit: args.limit,
      buildId: args.buildId,
      fetchAll: args.fetchAll,
    });

    return inventory;
  },
});

export const listToolsInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ToolDescriptor[]> => {
    return await listToolsForContext(ctx, args);
  },
});

export const listToolsWithWarningsInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tools: ToolDescriptor[];
    warnings: string[];
    typesUrl?: string;
    sourceQuality: Record<string, OpenApiSourceQuality>;
    sourceAuthProfiles: Record<string, SourceAuthProfile>;
    inventoryStatus: ToolInventoryStatus;
    nextCursor?: string | null;
    totalTools: number;
  }> => {
    return await listToolsWithWarningsForContext(ctx, args);
  },
});

export const rebuildToolInventoryInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ rebuilt: boolean }> => {
    const result = await rebuildWorkspaceToolInventoryForContext(ctx, args);
    return {
      rebuilt: result.rebuilt,
    };
  },
});

export const previewOpenApiSourceUpgrade = customAction({
  method: "POST",
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    sessionId: v.optional(v.string()),
    sourceId: v.string(),
    name: v.string(),
    config: jsonObjectValidator,
  },
  handler: async (ctx, args): Promise<OpenApiUpgradeDiffPreview> => {
    const access = await requireCanonicalAccount(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      accountId: args.accountId,
    });

    return await previewOpenApiSourceUpgradeForContext(
      ctx,
        {
          workspaceId: args.workspaceId,
          accountId: access.accountId,
          clientId: access.clientId,
        },
      {
        sourceId: args.sourceId,
        name: args.name,
        config: args.config,
      },
    );
  },
});

export const storageListDirectory = customAction({
  method: "POST",
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    sessionId: v.optional(v.string()),
    instanceId: v.string(),
    path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId, instance, provider } = await resolveStorageInspectorContext(ctx, args);
    const path = args.path?.trim() || "/";
    const entries = await provider.readdir(instance, path);
    await touchStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      accountId,
      instance,
      provider,
      withUsage: false,
    });
    return {
      instanceId: instance.id,
      path,
      entries,
    };
  },
});

export const storageReadFile = customAction({
  method: "POST",
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    sessionId: v.optional(v.string()),
    instanceId: v.string(),
    path: v.string(),
    encoding: v.optional(v.union(v.literal("utf8"), v.literal("base64"))),
  },
  handler: async (ctx, args) => {
    const { accountId, instance, provider } = await resolveStorageInspectorContext(ctx, args);
    const encoding = (args.encoding ?? "utf8") as StorageEncoding;
    const file = await provider.readFile(instance, args.path, encoding);
    await touchStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      accountId,
      instance,
      provider,
      withUsage: false,
    });
    return {
      instanceId: instance.id,
      path: args.path,
      encoding,
      content: file.content,
      bytes: file.bytes,
    };
  },
});

export const storageListKv = customAction({
  method: "POST",
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    sessionId: v.optional(v.string()),
    instanceId: v.string(),
    prefix: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { accountId, instance, provider } = await resolveStorageInspectorContext(ctx, args);
    const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 100)));
    const prefix = args.prefix?.trim() ?? "";
    const items = await provider.kvList(instance, prefix, limit);
    await touchStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      accountId,
      instance,
      provider,
      withUsage: false,
    });
    return {
      instanceId: instance.id,
      prefix,
      items,
      total: items.length,
    };
  },
});

export const storageQuerySql = customAction({
  method: "POST",
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    sessionId: v.optional(v.string()),
    instanceId: v.string(),
    sql: v.string(),
    params: v.optional(v.array(v.union(v.string(), v.number(), v.boolean(), v.null()))),
    maxRows: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!isReadOnlySql(args.sql)) {
      throw new Error("Storage inspector only allows read-only SQL (SELECT/PRAGMA/EXPLAIN/WITH)");
    }
    if (hasMultipleSqlStatements(args.sql)) {
      throw new Error("Storage inspector rejects multi-statement SQL payloads");
    }

    const { accountId, instance, provider } = await resolveStorageInspectorContext(ctx, args);
    const maxRows = Math.max(1, Math.min(1000, Math.floor(args.maxRows ?? 200)));
    const result = await provider.sqliteQuery(instance, {
      sql: args.sql,
      params: args.params ?? [],
      mode: "read",
      maxRows,
    });
    await touchStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      accountId,
      instance,
      provider,
      withUsage: false,
    });
    return {
      instanceId: instance.id,
      ...result,
    };
  },
});

export const handleExternalToolCall = internalAction({
  args: {
    runId: v.string(),
    callId: v.string(),
    toolPath: v.string(),
    input: v.optional(jsonObjectValidator),
  },
  handler: async (ctx, args): Promise<string> => {
    const result = await handleExternalToolCallRequest(ctx, args);
    return encodeToolCallResultForTransport(result);
  },
});

export const runTask = internalAction({
  args: { taskId: v.string() },
  handler: async (ctx, args) => await runQueuedTask(ctx, args),
});
