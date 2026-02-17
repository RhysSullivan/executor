"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
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
  type WorkspaceToolsDebug,
} from "../src/runtime/workspace_tools";
import { runQueuedTask } from "../src/runtime/task_runner";
import { handleExternalToolCallRequest } from "../src/runtime/external_tool_call";
import { jsonObjectValidator } from "../src/database/validators";

export const listToolsWithWarnings = action({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    includeDetails: v.optional(v.boolean()),
    includeSourceMeta: v.optional(v.boolean()),
    toolPaths: v.optional(v.array(v.string())),
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
    debug: WorkspaceToolsDebug;
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
    debug: WorkspaceToolsDebug;
  }> => {
    await rebuildWorkspaceToolInventoryForContext(ctx, args);
    return await listToolsWithWarningsForContext(ctx, args);
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
