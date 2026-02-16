"use node";

import type { ActionCtx } from "../../convex/_generated/server";
import { createTaskEvent, type TaskEventName } from "../task/events";

export async function publishTaskEvent(
  ctx: ActionCtx,
  taskId: string,
  eventName: TaskEventName,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await createTaskEvent(ctx, {
    taskId,
    eventName,
    type,
    payload,
  });
}
