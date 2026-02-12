"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { InProcessExecutionAdapter } from "../../core/src/adapters/in-process-execution-adapter";
import { APPROVAL_DENIED_PREFIX } from "../../core/src/execution-constants";
import { dispatchCodeWithCloudflareWorkerLoader } from "../../core/src/runtimes/cloudflare-worker-loader-runtime";
import {
  CLOUDFLARE_WORKER_LOADER_RUNTIME_ID,
  isCloudflareWorkerLoaderConfigured,
  isKnownRuntimeId,
} from "../../core/src/runtimes/runtime-catalog";
import { runCodeWithAdapter } from "../../core/src/runtimes/runtime-core";
import type { TaskRecord } from "../../core/src/types";
import { describeError } from "../../core/src/utils";
import { publishTaskEvent } from "./events";
import { invokeTool } from "./tool_invocation";

export async function runQueuedTask(
  ctx: ActionCtx,
  args: { taskId: string },
): Promise<null> {
  const task = (await ctx.runQuery(internal.database.getTask, { taskId: args.taskId })) as TaskRecord | null;
  if (!task || task.status !== "queued") {
    return null;
  }

  if (!isKnownRuntimeId(task.runtimeId)) {
    const failed = await ctx.runMutation(internal.database.markTaskFinished as any, {
      taskId: args.taskId,
      status: "failed",
      error: `Runtime not found: ${task.runtimeId}`,
    });

    if (failed) {
      await publishTaskEvent(ctx, args.taskId, "task", "task.failed", {
        taskId: args.taskId,
        status: failed.status,
        error: failed.error,
      });
    }
    return null;
  }

  if (task.runtimeId === CLOUDFLARE_WORKER_LOADER_RUNTIME_ID && !isCloudflareWorkerLoaderConfigured()) {
    const failed = await ctx.runMutation(internal.database.markTaskFinished as any, {
      taskId: args.taskId,
      status: "failed",
      error: `Runtime is not configured: ${task.runtimeId}`,
    });

    if (failed) {
      await publishTaskEvent(ctx, args.taskId, "task", "task.failed", {
        taskId: args.taskId,
        status: failed.status,
        error: failed.error,
      });
    }
    return null;
  }

  try {
    const running = (await ctx.runMutation(internal.database.markTaskRunning, {
      taskId: args.taskId,
    })) as TaskRecord | null;
    if (!running) {
      return null;
    }

    await publishTaskEvent(ctx, args.taskId, "task", "task.running", {
      taskId: args.taskId,
      status: running.status,
      startedAt: running.startedAt,
    });

    if (running.runtimeId === CLOUDFLARE_WORKER_LOADER_RUNTIME_ID) {
      const dispatchResult = await dispatchCodeWithCloudflareWorkerLoader({
        taskId: args.taskId,
        code: running.code,
        timeoutMs: running.timeoutMs,
      });

      if (!dispatchResult.ok) {
        const failed = await ctx.runMutation(internal.database.markTaskFinished as any, {
          taskId: args.taskId,
          status: "failed",
          error: dispatchResult.error,
        });

        if (failed) {
          await publishTaskEvent(ctx, args.taskId, "task", "task.failed", {
            taskId: args.taskId,
            status: failed.status,
            error: failed.error,
            completedAt: failed.completedAt,
          });
        }
        return null;
      }

      await publishTaskEvent(ctx, args.taskId, "task", "task.dispatched", {
        taskId: args.taskId,
        runtimeId: running.runtimeId,
        dispatchId: dispatchResult.dispatchId,
        durationMs: dispatchResult.durationMs,
      });
      return null;
    }

    const runtimeResult = await (async () => {
      const adapter = new InProcessExecutionAdapter({
        runId: args.taskId,
        invokeTool: async (call) => await invokeTool(ctx, running, call),
      });

      return await runCodeWithAdapter(
        {
          taskId: args.taskId,
          code: running.code,
          timeoutMs: running.timeoutMs,
        },
        adapter,
      );
    })();

    const finished = await ctx.runMutation(internal.database.markTaskFinished as any, {
      taskId: args.taskId,
      status: runtimeResult.status,
      result: runtimeResult.result,
      exitCode: runtimeResult.exitCode,
      error: runtimeResult.error,
    });

    if (!finished) {
      return null;
    }

    const terminalEvent =
      runtimeResult.status === "completed"
        ? "task.completed"
        : runtimeResult.status === "timed_out"
          ? "task.timed_out"
          : runtimeResult.status === "denied"
            ? "task.denied"
            : "task.failed";

    await publishTaskEvent(ctx, args.taskId, "task", terminalEvent, {
      taskId: args.taskId,
      status: finished.status,
      exitCode: finished.exitCode,
      durationMs: runtimeResult.durationMs,
      error: finished.error,
      completedAt: finished.completedAt,
    });
  } catch (error) {
    const message = describeError(error);
    const denied = message.startsWith(APPROVAL_DENIED_PREFIX);
    const finished = await ctx.runMutation(internal.database.markTaskFinished as any, {
      taskId: args.taskId,
      status: denied ? "denied" : "failed",
      error: denied ? message.replace(APPROVAL_DENIED_PREFIX, "") : message,
    });

    if (finished) {
      await publishTaskEvent(ctx, args.taskId, "task", denied ? "task.denied" : "task.failed", {
        taskId: args.taskId,
        status: finished.status,
        error: finished.error,
        completedAt: finished.completedAt,
      });
    }
  }

  return null;
}
