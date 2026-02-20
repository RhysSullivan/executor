import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { workspaceAction, workspaceMutation } from "../../core/src/function-builders";
import {
  completeRuntimeRunHandler,
  createTaskHandler,
  createTaskInternalHandler,
  resolveApprovalHandler,
  resolveApprovalInternalHandler,
} from "../src/executor/handlers";
import { jsonObjectValidator } from "../src/database/validators";
import { vv } from "./typedV";

export const createTask = workspaceAction({
  method: "POST",
  args: {
    code: v.string(),
    timeoutMs: v.optional(v.number()),
    runtimeId: v.optional(v.string()),
    metadata: v.optional(jsonObjectValidator),
    accountId: v.optional(vv.id("accounts")),
    waitForResult: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await createTaskHandler(ctx, internal, args);
  },
});

export const createTaskInternal = internalMutation({
  args: {
    code: v.string(),
    timeoutMs: v.optional(v.number()),
    runtimeId: v.optional(v.string()),
    metadata: v.optional(jsonObjectValidator),
    workspaceId: vv.id("workspaces"),
    accountId: vv.id("accounts"),
    clientId: v.optional(v.string()),
    scheduleAfterCreate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await createTaskInternalHandler(ctx, internal, args);
  },
});

export const resolveApproval = workspaceMutation({
  method: "POST",
  requireAdmin: true,
  args: {
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    reviewerId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await resolveApprovalHandler(ctx, internal, args);
  },
});

export const resolveApprovalInternal = internalMutation({
  args: {
    workspaceId: vv.id("workspaces"),
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    reviewerId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await resolveApprovalInternalHandler(ctx, internal, args);
  },
});

export const completeRuntimeRun = internalMutation({
  args: {
    runId: v.string(),
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("timed_out"), v.literal("denied")),
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await completeRuntimeRunHandler(ctx, internal, args);
  },
});
