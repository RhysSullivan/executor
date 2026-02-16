"use node";

import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { InProcessExecutionAdapter } from "../../../core/src/adapters/in/process/execution-adapter";
import { APPROVAL_DENIED_PREFIX } from "../../../core/src/execution-constants";
import { dispatchCodeWithCloudflareWorkerLoader } from "../../../core/src/runtimes/cloudflare/worker/loader-runtime";
import {
  CLOUDFLARE_WORKER_LOADER_RUNTIME_ID,
  isCloudflareWorkerLoaderConfigured,
  isKnownRuntimeId,
  isRuntimeEnabled,
} from "../../../core/src/runtimes/runtime-catalog";
import { runCodeWithAdapter } from "../../../core/src/runtimes/runtime-core";
import type { TaskExecutionOutcome, TaskRecord } from "../../../core/src/types";
import { describeError } from "../../../core/src/utils";
import { publishTaskEvent } from "./events";
import { taskTerminalEventType } from "../task/status";
import { markTaskFinished } from "../task/finish";
import { invokeTool } from "./tool_invocation";

async function markTaskFailedAndPublish(
  ctx: ActionCtx,
  args: { taskId: string; error: string },
): Promise<TaskExecutionOutcome | null> {
  const failed = await markTaskFinished(ctx, {
    taskId: args.taskId,
    status: "failed",
    error: args.error,
  });

  if (!failed) {
    return null;
  }

  await publishTaskEvent(ctx, args.taskId, "task", "task.failed", {
    taskId: args.taskId,
    status: failed.status,
    error: failed.error,
    ...(failed.completedAt ? { completedAt: failed.completedAt } : {}),
  });

  return { task: failed };
}

async function publishTerminalTaskResult(
  ctx: ActionCtx,
  args: {
    taskId: string;
    status: "completed" | "failed" | "timed_out" | "denied";
    finished: TaskRecord;
    durationMs?: number;
  },
): Promise<void> {
  await publishTaskEvent(ctx, args.taskId, "task", taskTerminalEventType(args.status), {
    taskId: args.taskId,
    status: args.finished.status,
    exitCode: args.finished.exitCode,
    durationMs: args.durationMs,
    error: args.finished.error,
    completedAt: args.finished.completedAt,
  });
}

export async function runQueuedTask(
  ctx: ActionCtx,
  args: { taskId: string },
): Promise<TaskExecutionOutcome | null> {
  const task = (await ctx.runQuery(internal.database.getTask, { taskId: args.taskId })) as TaskRecord | null;
  if (!task || task.status !== "queued") {
    return null;
  }

  if (!isKnownRuntimeId(task.runtimeId)) {
    return await markTaskFailedAndPublish(ctx, {
      taskId: args.taskId,
      error: `Runtime not found: ${task.runtimeId}`,
    });
  }

  if (!isRuntimeEnabled(task.runtimeId)) {
    return await markTaskFailedAndPublish(ctx, {
      taskId: args.taskId,
      error: `Runtime is disabled for this deployment: ${task.runtimeId}`,
    });
  }

  if (task.runtimeId === CLOUDFLARE_WORKER_LOADER_RUNTIME_ID && !isCloudflareWorkerLoaderConfigured()) {
    return await markTaskFailedAndPublish(ctx, {
      taskId: args.taskId,
      error: `Runtime is not configured: ${task.runtimeId}`,
    });
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
        return await markTaskFailedAndPublish(ctx, {
          taskId: args.taskId,
          error: dispatchResult.error,
        });
      }

      const finished = await markTaskFinished(ctx, {
        taskId: args.taskId,
        status: dispatchResult.status,
        exitCode: dispatchResult.exitCode,
        error: dispatchResult.error,
      });

      if (!finished) {
        return null;
      }

      await publishTerminalTaskResult(ctx, {
        taskId: args.taskId,
        status: dispatchResult.status,
        finished,
        durationMs: dispatchResult.durationMs,
      });
      return {
        task: finished,
        result: dispatchResult.result,
        durationMs: dispatchResult.durationMs,
      };
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

    const finished = await markTaskFinished(ctx, {
      taskId: args.taskId,
      status: runtimeResult.status,
      exitCode: runtimeResult.exitCode,
      error: runtimeResult.error,
    });

    if (!finished) {
      return null;
    }

    await publishTerminalTaskResult(ctx, {
      taskId: args.taskId,
      status: runtimeResult.status,
      finished,
      durationMs: runtimeResult.durationMs,
    });
    return {
      task: finished,
      result: runtimeResult.result,
      durationMs: runtimeResult.durationMs,
    };
  } catch (error) {
    const message = describeError(error);
    const denied = message.startsWith(APPROVAL_DENIED_PREFIX);
    const finished = await markTaskFinished(ctx, {
      taskId: args.taskId,
      status: denied ? "denied" : "failed",
      error: denied ? message.replace(APPROVAL_DENIED_PREFIX, "") : message,
    });

    if (finished) {
      await publishTerminalTaskResult(ctx, {
        taskId: args.taskId,
        status: denied ? "denied" : "failed",
        finished,
      });
      return { task: finished };
    }
  }

  return null;
}
