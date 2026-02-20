import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { getTaskDoc, mapTaskEvent } from "../../src/database/readers";
import { jsonObjectValidator } from "../../src/database/validators";

export const createTaskEvent = internalMutation({
  args: {
    taskId: v.string(),
    eventName: v.string(),
    type: v.string(),
    payload: jsonObjectValidator,
  },
  handler: async (ctx, args) => {
    const task = await getTaskDoc(ctx, args.taskId);
    if (!task) {
      throw new Error(`Task not found for event: ${args.taskId}`);
    }

    const currentSequence = task.nextEventSequence ?? 0;
    const sequence = currentSequence + 1;
    const createdAt = Date.now();

    await ctx.db.patch(task._id, {
      nextEventSequence: sequence,
    });

    await ctx.db.insert("taskEvents", {
      sequence,
      taskId: args.taskId,
      eventName: args.eventName,
      type: args.type,
      payload: args.payload,
      createdAt,
    });

    const created = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_sequence", (q) => q.eq("taskId", args.taskId).eq("sequence", sequence))
      .unique();

    if (!created) {
      throw new Error("Failed to read inserted task event");
    }

    return mapTaskEvent(created);
  },
});

export const listTaskEvents = internalQuery({
  args: {
    taskId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 500)));
    const docs = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_sequence", (q) => q.eq("taskId", args.taskId))
      .order("asc")
      .take(limit);

    return docs.map(mapTaskEvent);
  },
});
