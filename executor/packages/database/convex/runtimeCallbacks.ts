import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import {
  completeRunHandler,
  getApprovalStatusHandler,
  handleToolCallHandler,
} from "../src/runtime-callbacks/handlers";
import { jsonObjectValidator } from "../src/database/validators";

export const handleToolCall = action({
  args: {
    internalSecret: v.string(),
    runId: v.string(),
    callId: v.string(),
    toolPath: v.string(),
    input: v.optional(jsonObjectValidator),
  },
  handler: async (ctx, args) => {
    return await handleToolCallHandler(ctx, internal, args);
  },
});

export const completeRun = mutation({
  args: {
    internalSecret: v.string(),
    runId: v.string(),
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("timed_out"), v.literal("denied")),
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await completeRunHandler(ctx, internal, args);
  },
});

export const getApprovalStatus = query({
  args: {
    internalSecret: v.string(),
    runId: v.string(),
    approvalId: v.string(),
  },
  handler: async (ctx, args) => {
    return await getApprovalStatusHandler(ctx, internal, args);
  },
});
