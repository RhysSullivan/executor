import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { mapToolCall } from "../../src/database/mappers";
import { getToolCallDoc } from "../../src/database/readers";
import { terminalToolCallStatusValidator } from "../../src/database/validators";

export const upsertToolCallRequested = internalMutation({
  args: {
    taskId: v.string(),
    callId: v.string(),
    workspaceId: v.id("workspaces"),
    toolPath: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (existing) {
      return mapToolCall(existing);
    }

    const now = Date.now();
    await ctx.db.insert("toolCalls", {
      taskId: args.taskId,
      callId: args.callId,
      workspaceId: args.workspaceId,
      toolPath: args.toolPath,
      status: "requested",
      createdAt: now,
      updatedAt: now,
    });

    const created = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!created) {
      throw new Error(`Failed to create tool call ${args.taskId}/${args.callId}`);
    }
    return mapToolCall(created);
  },
});

export const getToolCall = internalQuery({
  args: {
    taskId: v.string(),
    callId: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await getToolCallDoc(ctx, args.taskId, args.callId);
    return doc ? mapToolCall(doc) : null;
  },
});

export const setToolCallPendingApproval = internalMutation({
  args: {
    taskId: v.string(),
    callId: v.string(),
    approvalId: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!doc) {
      throw new Error(`Tool call not found: ${args.taskId}/${args.callId}`);
    }

    if (doc.status === "completed" || doc.status === "failed" || doc.status === "denied") {
      return mapToolCall(doc);
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: "pending_approval",
      approvalId: args.approvalId,
      updatedAt: now,
    });

    const updated = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!updated) {
      throw new Error(`Failed to read tool call ${args.taskId}/${args.callId}`);
    }
    return mapToolCall(updated);
  },
});

export const finishToolCall = internalMutation({
  args: {
    taskId: v.string(),
    callId: v.string(),
    status: terminalToolCallStatusValidator,
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!doc) {
      throw new Error(`Tool call not found: ${args.taskId}/${args.callId}`);
    }

    if (doc.status === "completed" || doc.status === "failed" || doc.status === "denied") {
      return mapToolCall(doc);
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: args.status,
      error: args.error,
      updatedAt: now,
      completedAt: now,
    });

    const updated = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!updated) {
      throw new Error(`Failed to read tool call ${args.taskId}/${args.callId}`);
    }
    return mapToolCall(updated);
  },
});

export const listToolCalls = internalQuery({
  args: {
    taskId: v.string(),
  },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("toolCalls")
      .withIndex("by_task_created", (q) => q.eq("taskId", args.taskId))
      .order("asc")
      .collect();

    return docs.map(mapToolCall);
  },
});
