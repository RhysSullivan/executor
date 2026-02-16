import { internal } from "../../convex/_generated/api";
import type { ActionCtx, MutationCtx } from "../../convex/_generated/server";
import type { TaskRecord, TaskStatus } from "../../../core/src/types";

type TerminalTaskStatus = Extract<TaskStatus, "completed" | "failed" | "timed_out" | "denied">;
type TaskFinishContext = Pick<ActionCtx, "runMutation"> | Pick<MutationCtx, "runMutation">;

interface MarkTaskFinishedInput {
  taskId: string;
  status: TerminalTaskStatus;
  exitCode?: number;
  error?: string;
}

export async function markTaskFinished(
  ctx: TaskFinishContext,
  args: MarkTaskFinishedInput,
): Promise<TaskRecord | null> {
  return await ctx.runMutation(internal.database.markTaskFinished, args) as TaskRecord | null;
}
