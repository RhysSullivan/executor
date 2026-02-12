"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export async function publishTaskEvent(
  ctx: ActionCtx,
  taskId: string,
  eventName: "task" | "approval",
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.runMutation(internal.database.createTaskEvent, {
    taskId,
    eventName,
    type,
    payload,
  });
}
