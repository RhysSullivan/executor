import { internal } from "../_generated/api";

export type TaskEventName = "task" | "approval";

interface TaskEventMutationContext {
  runMutation: (
    mutation: typeof internal.database.createTaskEvent,
    args: {
      taskId: string;
      eventName: TaskEventName;
      type: string;
      payload: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export async function createTaskEvent(
  ctx: TaskEventMutationContext,
  input: {
    taskId: string;
    eventName: TaskEventName;
    type: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.runMutation(internal.database.createTaskEvent, input);
}
