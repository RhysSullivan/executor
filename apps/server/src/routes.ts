/**
 * Elysia server routes.
 *
 * Exports the Elysia app type for Eden Treaty consumption.
 * Routes:
 *   POST   /api/tasks             — Create a new task
 *   GET    /api/tasks             — List tasks
 *   GET    /api/tasks/:id         — Get task status
 *   GET    /api/tasks/:id/events  — SSE stream of TaskEvents
 *   POST   /api/tasks/:id/cancel  — Cancel a task
 *   POST   /api/approvals/:callId — Resolve an approval decision
 */

import { Elysia, sse, t } from "elysia";
import {
  addApprovalRule,
  createTask,
  generateTaskId,
  getTask,
  listTasks,
  listPendingApprovals,
  resolveApproval,
  subscribeToTask,
  type RuleOperator,
} from "./state.js";
import { runTask, type TaskRunnerOptions } from "./task-runner.js";

// ---------------------------------------------------------------------------
// Elysia validation schemas (TypeBox — Elysia's native)
// ---------------------------------------------------------------------------

const CreateTaskBody = t.Object({
  prompt: t.String({ minLength: 1 }),
  requesterId: t.String({ minLength: 1 }),
  channelId: t.Optional(t.String()),
});

const ApprovalBody = t.Object({
  decision: t.Union([t.Literal("approved"), t.Literal("denied")]),
});

const ApprovalRuleBody = t.Object({
  toolPath: t.String({ minLength: 1 }),
  field: t.String({ minLength: 1 }),
  operator: t.Union([
    t.Literal("equals"),
    t.Literal("not_equals"),
    t.Literal("includes"),
    t.Literal("not_includes"),
  ]),
  value: t.String(),
  decision: t.Union([t.Literal("approved"), t.Literal("denied")]),
});

// ---------------------------------------------------------------------------
// Task serialization (strip internal fields)
// ---------------------------------------------------------------------------

function serializeTask(task: NonNullable<ReturnType<typeof getTask>>) {
  // Find the last error event if any
  const lastError = [...task.events].reverse().find((e) => e.type === "error");
  const errorMessage = lastError && lastError.type === "error" ? lastError.error : undefined;

  return {
    id: task.id,
    prompt: task.prompt,
    requesterId: task.requesterId,
    channelId: task.channelId,
    createdAt: task.createdAt,
    status: task.status,
    resultText: task.resultText,
    errorMessage,
    eventCount: task.events.length,
    pendingApprovals: listPendingApprovals(task.id).map((a) => ({
      callId: a.callId,
      toolPath: a.toolPath,
    })),
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(runnerOptions: TaskRunnerOptions) {
  const app = new Elysia()
    // -----------------------------------------------------------------------
    // POST /api/tasks — create and start a task
    // -----------------------------------------------------------------------
    .post(
      "/api/tasks",
      async ({ body }) => {
        const taskId = generateTaskId();
        const task = createTask({
          id: taskId,
          prompt: body.prompt,
          requesterId: body.requesterId,
          channelId: body.channelId,
        });

        // Fire-and-forget: run the agent in the background
        runTask(taskId, body.prompt, runnerOptions).catch((err) => {
          console.error(`[task ${taskId}] unhandled error:`, err);
        });

        return { taskId: task.id, status: task.status };
      },
      { body: CreateTaskBody },
    )

    // -----------------------------------------------------------------------
    // GET /api/tasks — list all tasks
    // -----------------------------------------------------------------------
    .get("/api/tasks", ({ query }) => {
      const tasks = listTasks(query.requesterId);
      return tasks.map(serializeTask);
    }, {
      query: t.Object({
        requesterId: t.Optional(t.String()),
      }),
    })

    // -----------------------------------------------------------------------
    // GET /api/tasks/:id — get task status
    // -----------------------------------------------------------------------
    .get(
      "/api/tasks/:id",
      ({ params, status }) => {
        const task = getTask(params.id);
        if (!task) {
          return status(404, { error: "Task not found" as const });
        }
        return serializeTask(task);
      },
    )

    // -----------------------------------------------------------------------
    // GET /api/tasks/:id/events — SSE stream of TaskEvents
    // -----------------------------------------------------------------------
    .get(
      "/api/tasks/:id/events",
      async function* ({ params }) {
        const task = getTask(params.id);
        if (!task) {
          yield sse({ event: "error", data: { error: "Task not found" } });
          return;
        }

        // First, replay all existing events
        for (const event of task.events) {
          yield sse({ event: event.type, data: event });
        }

        // If task is already done, close the stream
        if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
          return;
        }

        // Subscribe to new events via an async queue
        type TaskEvent = (typeof task.events)[number];
        const queue: TaskEvent[] = [];
        let resolveWait: (() => void) | null = null;
        let done = false;

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

        try {
          while (!done) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                resolveWait = resolve;
              });
            }

            while (queue.length > 0) {
              const event = queue.shift()!;
              yield sse({ event: event.type, data: event });
            }
          }
        } finally {
          unsubscribe();
        }
      },
    )

    // -----------------------------------------------------------------------
    // POST /api/tasks/:id/cancel — cancel a task
    // -----------------------------------------------------------------------
    .post("/api/tasks/:id/cancel", ({ params, status }) => {
      const task = getTask(params.id);
      if (!task) {
        return status(404, { error: "Task not found" as const });
      }
      if (task.status !== "running") {
        return status(400, { error: "Task is not running" as const });
      }
      task.status = "cancelled";
      return { taskId: task.id, status: task.status };
    })

    // -----------------------------------------------------------------------
    // POST /api/approvals/:callId — resolve a pending approval
    // -----------------------------------------------------------------------
    .post(
      "/api/approvals/:callId",
      ({ params, body, status }) => {
        const resolved = resolveApproval(params.callId, body.decision);
        if (!resolved) {
          return status(404, { error: "Approval not found or already resolved" as const });
        }
        return { callId: params.callId, decision: body.decision };
      },
      { body: ApprovalBody },
    )

    // -----------------------------------------------------------------------
    // POST /api/tasks/:id/approval-rules — add an auto-approval rule
    // -----------------------------------------------------------------------
    .post(
      "/api/tasks/:id/approval-rules",
      ({ params, body, status }) => {
        const task = getTask(params.id);
        if (!task) {
          return status(404, { error: "Task not found" as const });
        }

        const ruleId = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const resolved = addApprovalRule({
          id: ruleId,
          taskId: params.id,
          toolPath: body.toolPath,
          field: body.field,
          operator: body.operator as RuleOperator,
          value: body.value,
          decision: body.decision,
        });

        return { ruleId, resolved, toolPath: body.toolPath, field: body.field, operator: body.operator, value: body.value, decision: body.decision };
      },
      { body: ApprovalRuleBody },
    );

  return app;
}

export type App = ReturnType<typeof createApp>;
