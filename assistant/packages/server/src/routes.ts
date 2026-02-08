/**
 * Elysia server routes.
 *
 * POST   /api/tasks             — Create a task (fires agent in background)
 * GET    /api/tasks             — List tasks
 * GET    /api/tasks/:id         — Get task status
 * GET    /api/tasks/:id/events  — SSE stream of TaskEvents
 */

import { Elysia, sse, t } from "elysia";
import { createAgent } from "@assistant/core";
import type { ExecutorClient } from "@assistant/agent-executor-adapter";
import type { GenerateResult, Message } from "@assistant/core";
import {
  createTask,
  emitTaskEvent,
  generateTaskId,
  getTask,
  listTasks,
  subscribeToTask,
} from "./state";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ServerOptions {
  readonly executor: ExecutorClient;
  readonly generate: (messages: Message[]) => Promise<GenerateResult>;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly clientId?: string;
  readonly context?: string;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeTask(task: NonNullable<ReturnType<typeof getTask>>) {
  const lastError = [...task.events].reverse().find((e) => e.type === "error");
  const errorMessage = lastError && lastError.type === "error" ? lastError.error : undefined;

  return {
    id: task.id,
    prompt: task.prompt,
    requesterId: task.requesterId,
    createdAt: task.createdAt,
    status: task.status,
    resultText: task.resultText,
    errorMessage,
    eventCount: task.events.length,
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createApp(options: ServerOptions) {
  const agent = createAgent({
    executor: options.executor,
    generate: options.generate,
    workspaceId: options.workspaceId,
    actorId: options.actorId,
    clientId: options.clientId,
    context: options.context,
  });

  const app = new Elysia()
    // Expose executor context so the bot can query Convex
    .get("/api/context", () => ({
      workspaceId: options.workspaceId,
      actorId: options.actorId,
      clientId: options.clientId,
    }))

    .post("/api/tasks", async ({ body }) => {
      const taskId = generateTaskId();
      const task = createTask({
        id: taskId,
        prompt: body.prompt,
        requesterId: body.requesterId,
      });

      // Fire and forget
      agent.run(body.prompt, (event) => {
        emitTaskEvent(taskId, event);
      }).catch((err) => {
        console.error(`[task ${taskId}] agent error:`, err);
        emitTaskEvent(taskId, {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return { taskId: task.id, status: task.status, workspaceId: options.workspaceId };
    }, {
      body: t.Object({
        prompt: t.String({ minLength: 1 }),
        requesterId: t.String({ minLength: 1 }),
      }),
    })

    .get("/api/tasks", ({ query }) => {
      return listTasks(query.requesterId).map(serializeTask);
    }, {
      query: t.Object({
        requesterId: t.Optional(t.String()),
      }),
    })

    .get("/api/tasks/:id", ({ params, set }) => {
      const task = getTask(params.id);
      if (!task) {
        set.status = 404;
        return { error: "Task not found" };
      }
      return serializeTask(task);
    })

    .get("/api/tasks/:id/events", async function* ({ params }) {
      const task = getTask(params.id);
      if (!task) {
        yield sse({ event: "error", data: { error: "Task not found" } });
        return;
      }

      type TE = (typeof task.events)[number];
      const queue: TE[] = [];
      let resolveWait: (() => void) | null = null;
      let done = false;
      let replayedCount = 0;

      const unsubscribe = subscribeToTask(params.id, (event) => {
        queue.push(event);
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
        if (event.type === "completed" || event.type === "error") {
          done = true;
        }
      });

      if (!unsubscribe) return;

      // Replay existing events
      const snapshot = task.events.length;
      for (let i = 0; i < snapshot; i++) {
        yield sse({ event: task.events[i]!.type, data: task.events[i] });
      }
      replayedCount = snapshot;

      if (task.status === "completed" || task.status === "failed") {
        unsubscribe();
        return;
      }

      // Stream live events
      try {
        while (!done) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
            });
          }

          while (queue.length > 0) {
            const event = queue.shift()!;
            const idx = task.events.indexOf(event);
            if (idx !== -1 && idx < replayedCount) continue;
            yield sse({ event: event.type, data: event });
          }
        }
      } finally {
        unsubscribe();
      }
    });

  return app;
}

export type App = ReturnType<typeof createApp>;
