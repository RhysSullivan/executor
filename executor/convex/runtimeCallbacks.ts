import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, mutation } from "./_generated/server";
import type { ToolCallResult } from "../lib/types";

function requireInternalSecret(secret: string): void {
  const expected = process.env.EXECUTOR_INTERNAL_TOKEN;
  if (!expected) {
    throw new Error("EXECUTOR_INTERNAL_TOKEN is not configured");
  }
  if (secret !== expected) {
    throw new Error("Unauthorized: invalid internal secret");
  }
}

export const handleToolCall = action({
  args: {
    internalSecret: v.string(),
    runId: v.string(),
    callId: v.string(),
    toolPath: v.string(),
    input: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<ToolCallResult> => {
    requireInternalSecret(args.internalSecret);
    return await ctx.runAction(internal.executorNode.handleExternalToolCall, {
      runId: args.runId,
      callId: args.callId,
      toolPath: args.toolPath,
      input: args.input,
    });
  },
});

export const appendOutput = mutation({
  args: {
    internalSecret: v.string(),
    runId: v.string(),
    stream: v.union(v.literal("stdout"), v.literal("stderr")),
    line: v.string(),
    timestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);

    const task = await ctx.runQuery(internal.database.getTask, {
      taskId: args.runId,
    });
    if (!task) {
      return { ok: false as const, error: `Run not found: ${args.runId}` };
    }

    await ctx.runMutation(internal.executor.appendRuntimeOutput, {
      runId: args.runId,
      stream: args.stream,
      line: args.line,
      timestamp: args.timestamp,
    });

    return { ok: true as const };
  },
});

export const completeRun = mutation({
  args: {
    internalSecret: v.string(),
    runId: v.string(),
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("timed_out"), v.literal("denied")),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);

    return await ctx.runMutation(internal.executor.completeRuntimeRun, {
      runId: args.runId,
      status: args.status,
      stdout: args.stdout,
      stderr: args.stderr,
      exitCode: args.exitCode,
      error: args.error,
      durationMs: args.durationMs,
    });
  },
});
