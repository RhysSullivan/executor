import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { mapTask } from "../../src/database/mappers";
import { getTaskDoc } from "../../src/database/readers";
import { completedTaskStatusValidator, jsonObjectValidator } from "../../src/database/validators";
import { asRecord } from "../../src/lib/object";
import { DEFAULT_TASK_TIMEOUT_MS } from "../../src/task/constants";
import { isTerminalTaskStatus } from "../../src/task/status";

export const createTask = internalMutation({
  args: {
    id: v.string(),
    code: v.string(),
    runtimeId: v.string(),
    timeoutMs: v.optional(v.number()),
    metadata: v.optional(jsonObjectValidator),
    workspaceId: v.id("workspaces"),
    actorId: v.string(),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await getTaskDoc(ctx, args.id);
    if (existing) {
      throw new Error(`Task already exists: ${args.id}`);
    }

    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId: args.id,
      code: args.code,
      runtimeId: args.runtimeId,
      workspaceId: args.workspaceId,
      actorId: args.actorId?.trim() || undefined,
      clientId: args.clientId?.trim() || undefined,
      status: "queued",
      timeoutMs: args.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      metadata: asRecord(args.metadata),
      createdAt: now,
      updatedAt: now,
    });

    const created = await getTaskDoc(ctx, args.id);
    if (!created) {
      throw new Error(`Failed to fetch created task ${args.id}`);
    }
    return mapTask(created);
  },
});

export const getTask = internalQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    return doc ? mapTask(doc) : null;
  },
});

export const listTasks = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(500);
    return docs.map(mapTask);
  },
});

export const listQueuedTaskIds = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("tasks")
      .withIndex("by_status_created", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(args.limit ?? 20);

    return docs.map((doc) => doc.taskId);
  },
});

export const getTaskInWorkspace = internalQuery({
  args: { taskId: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc || doc.workspaceId !== args.workspaceId) {
      return null;
    }
    return mapTask(doc);
  },
});

export const markTaskRunning = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc || doc.status !== "queued") {
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: "running",
      startedAt: doc.startedAt ?? now,
      updatedAt: now,
    });

    const updated = await getTaskDoc(ctx, args.taskId);
    return updated ? mapTask(updated) : null;
  },
});

export const markTaskFinished = internalMutation({
  args: {
    taskId: v.string(),
    status: completedTaskStatusValidator,
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc) {
      return null;
    }

    if (isTerminalTaskStatus(doc.status)) {
      return mapTask(doc);
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: args.status,
      exitCode: args.exitCode,
      error: args.error,
      completedAt: now,
      updatedAt: now,
    });

    const updated = await getTaskDoc(ctx, args.taskId);
    return updated ? mapTask(updated) : null;
  },
});
