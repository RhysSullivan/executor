"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import type {
  ToolCallResult,
  ToolDescriptor,
  OpenApiSourceQuality,
  SourceAuthProfile,
} from "../core/src/types";
import { requireCanonicalActor } from "./executor_node/actor_auth";
import {
  listToolsForContext,
  listToolsWithWarningsForContext,
  loadDtsUrls,
  loadWorkspaceDtsStorageIds,
} from "./executor_node/workspace_tools";
import { runQueuedTask } from "./executor_node/task_runner";
import { handleExternalToolCallRequest } from "./executor_node/external_tool_call";

export const listToolsWithWarnings = action({
  args: {
    workspaceId: v.id("workspaces"),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tools: ToolDescriptor[];
    warnings: string[];
    dtsUrls: Record<string, string>;
    sourceQuality: Record<string, OpenApiSourceQuality>;
    sourceAuthProfiles: Record<string, SourceAuthProfile>;
  }> => {
    const canonicalActorId = await requireCanonicalActor(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      actorId: args.actorId,
    });

    return await listToolsWithWarningsForContext(ctx, {
      workspaceId: args.workspaceId,
      actorId: canonicalActorId,
      clientId: args.clientId,
    });
  },
});

export const listToolDtsUrls = action({
  args: {
    workspaceId: v.id("workspaces"),
    actorId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    dtsUrls: Record<string, string>;
  }> => {
    await requireCanonicalActor(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      actorId: args.actorId,
    });
    const dtsStorageIds = await loadWorkspaceDtsStorageIds(ctx, args.workspaceId);
    const dtsUrls = await loadDtsUrls(ctx, dtsStorageIds);
    return { dtsUrls };
  },
});

export const listToolsInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ToolDescriptor[]> => {
    return await listToolsForContext(ctx, args);
  },
});

export const listToolsWithWarningsInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tools: ToolDescriptor[];
    warnings: string[];
    dtsUrls: Record<string, string>;
    sourceQuality: Record<string, OpenApiSourceQuality>;
    sourceAuthProfiles: Record<string, SourceAuthProfile>;
  }> => {
    return await listToolsWithWarningsForContext(ctx, args);
  },
});

export const handleExternalToolCall = internalAction({
  args: {
    runId: v.string(),
    callId: v.string(),
    toolPath: v.string(),
    input: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<ToolCallResult> => await handleExternalToolCallRequest(ctx, args),
});

export const runTask = internalAction({
  args: { taskId: v.string() },
  handler: async (ctx, args) => await runQueuedTask(ctx, args),
});
