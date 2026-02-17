"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type {
  ToolCallResult,
  ToolDescriptor,
  OpenApiSourceQuality,
  SourceAuthProfile,
} from "../../core/src/types";
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
import { previewOpenApiSourceUpgradeForContext, type OpenApiUpgradeDiffPreview } from "../src/runtime/tool_upgrade";

export const listToolsWithWarnings = customAction({
  method: "POST",
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    includeDetails: v.optional(v.boolean()),
    includeSourceMeta: v.optional(v.boolean()),
    toolPaths: v.optional(v.array(v.string())),
    source: v.optional(v.string()),
    sourceName: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    buildId: v.optional(v.string()),
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

    const inventory = await listToolsWithWarningsForContext(ctx, {
      workspaceId: args.workspaceId,
      accountId: access.accountId,
      clientId: args.clientId,
    }, {
      includeDetails: args.includeDetails ?? true,
      includeSourceMeta: args.includeSourceMeta ?? (args.toolPaths ? false : true),
      toolPaths: args.toolPaths,
      source: args.source,
      sourceName: args.sourceName,
      cursor: args.cursor,
      limit: args.limit,
      buildId: args.buildId,
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
    await rebuildWorkspaceToolInventoryForContext(ctx, args);
    return await listToolsWithWarningsForContext(ctx, args);
  },
});

export const previewOpenApiSourceUpgrade = customAction({
  method: "POST",
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
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
        clientId: args.clientId,
      },
      {
        sourceId: args.sourceId,
        name: args.name,
        config: args.config,
      },
    );
  },
});

export const handleExternalToolCall = internalAction({
  args: {
    runId: v.string(),
    callId: v.string(),
    toolPath: v.string(),
    input: v.optional(jsonObjectValidator),
  },
  handler: async (ctx, args): Promise<ToolCallResult> => await handleExternalToolCallRequest(ctx, args),
});

export const runTask = internalAction({
  args: { taskId: v.string() },
  handler: async (ctx, args) => await runQueuedTask(ctx, args),
});
