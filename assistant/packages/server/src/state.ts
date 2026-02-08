/**
 * In-memory task state. Tracks active tasks and their event streams.
 */

import type { TaskEvent } from "@assistant/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "running" | "completed" | "failed";

export interface Task {
  readonly id: string;
  readonly prompt: string;
  readonly requesterId: string;
  readonly createdAt: number;
  status: TaskStatus;
  events: TaskEvent[];
  subscribers: Set<(event: TaskEvent) => void>;
  resultText?: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const tasks = new Map<string, Task>();
let counter = 0;

export function generateTaskId(): string {
  return `task_${Date.now()}_${++counter}`;
}

export function createTask(opts: {
  id: string;
  prompt: string;
  requesterId: string;
}): Task {
  const task: Task = {
    id: opts.id,
    prompt: opts.prompt,
    requesterId: opts.requesterId,
    createdAt: Date.now(),
    status: "running",
    events: [],
    subscribers: new Set(),
  };
  tasks.set(task.id, task);
  return task;
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function listTasks(requesterId?: string): Task[] {
  const all = [...tasks.values()];
  return requesterId ? all.filter((t) => t.requesterId === requesterId) : all;
}

export function emitTaskEvent(taskId: string, event: TaskEvent): void {
  const task = tasks.get(taskId);
  if (!task) return;

  task.events.push(event);

  for (const sub of task.subscribers) {
    try {
      sub(event);
    } catch {
      task.subscribers.delete(sub);
    }
  }

  if (event.type === "completed") {
    task.status = "completed";
  } else if (event.type === "error") {
    task.status = "failed";
  } else if (event.type === "agent_message") {
    task.resultText = event.text;
  }
}

export function subscribeToTask(
  taskId: string,
  callback: (event: TaskEvent) => void,
): (() => void) | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;

  task.subscribers.add(callback);
  return () => {
    task.subscribers.delete(callback);
  };
}
