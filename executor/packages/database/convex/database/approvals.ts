import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { mapApproval } from "../../src/database/mappers";
import { getApprovalDoc, getTaskDoc } from "../../src/database/readers";
import { approvalStatusValidator, jsonObjectValidator } from "../../src/database/validators";
import type { TaskStatus } from "../../../core/src/types";

export const createApproval = internalMutation({
  args: {
    id: v.string(),
    taskId: v.string(),
    toolPath: v.string(),
    input: v.optional(jsonObjectValidator),
  },
  handler: async (ctx, args) => {
    const existing = await getApprovalDoc(ctx, args.id);
    if (existing) {
      throw new Error(`Approval already exists: ${args.id}`);
    }

    const task = await getTaskDoc(ctx, args.taskId);
    if (!task) {
      throw new Error(`Task not found for approval: ${args.taskId}`);
    }

    const now = Date.now();
    await ctx.db.insert("approvals", {
      approvalId: args.id,
      taskId: args.taskId,
      workspaceId: task.workspaceId,
      toolPath: args.toolPath,
      input: args.input ?? {},
      status: "pending",
      createdAt: now,
    });

    const created = await getApprovalDoc(ctx, args.id);
    if (!created) {
      throw new Error(`Failed to fetch approval ${args.id}`);
    }
    return mapApproval(created);
  },
});

export const getApproval = internalQuery({
  args: { approvalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await getApprovalDoc(ctx, args.approvalId);
    return doc ? mapApproval(doc) : null;
  },
});

export const listApprovals = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    status: v.optional(approvalStatusValidator),
  },
  handler: async (ctx, args) => {
    if (args.status) {
      const status = args.status;
      const docs = await ctx.db
        .query("approvals")
        .withIndex("by_workspace_status_created", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("status", status),
        )
        .order("desc")
        .take(500);
      return docs.map(mapApproval);
    }

    const docs = await ctx.db
      .query("approvals")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(500);
    return docs.map(mapApproval);
  },
});

export const listPendingApprovals = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("approvals")
      .withIndex("by_workspace_status_created", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("status", "pending"),
      )
      .order("asc")
      .take(500);

    const tasks = await Promise.all(docs.map((approval) => getTaskDoc(ctx, approval.taskId)));

    const results: Array<
      ReturnType<typeof mapApproval> & {
        task: { id: string; status: TaskStatus; runtimeId: string; timeoutMs: number; createdAt: number };
      }
    > = [];
    for (let i = 0; i < docs.length; i++) {
      const approval = docs[i]!;
      const task = tasks[i];
      if (!task) {
        continue;
      }

      results.push({
        ...mapApproval(approval),
        task: {
          id: task.taskId,
          status: task.status,
          runtimeId: task.runtimeId,
          timeoutMs: task.timeoutMs,
          createdAt: task.createdAt,
        },
      });
    }

    return results;
  },
});

export const resolveApproval = internalMutation({
  args: {
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    reviewerId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await getApprovalDoc(ctx, args.approvalId);
    if (!doc || doc.status !== "pending") {
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: args.decision,
      reason: args.reason,
      reviewerId: args.reviewerId,
      resolvedAt: now,
    });

    const updated = await getApprovalDoc(ctx, args.approvalId);
    return updated ? mapApproval(updated) : null;
  },
});

export const getApprovalInWorkspace = internalQuery({
  args: { approvalId: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const doc = await getApprovalDoc(ctx, args.approvalId);
    if (!doc || doc.workspaceId !== args.workspaceId) {
      return null;
    }
    return mapApproval(doc);
  },
});
