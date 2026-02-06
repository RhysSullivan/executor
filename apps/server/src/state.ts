/**
 * In-memory task state management.
 *
 * Tracks active tasks, their event streams, and pending approval resolvers.
 * This is the MVP — swap for bun:sqlite later.
 */

import type { TaskEvent } from "@openassistant/core/events";
import type { ApprovalDecision } from "@openassistant/core/tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface Task {
  readonly id: string;
  readonly prompt: string;
  readonly requesterId: string;
  readonly channelId?: string | undefined;
  readonly createdAt: number;
  status: TaskStatus;
  events: TaskEvent[];
  /** Subscribers get called for each new event. */
  subscribers: Set<(event: TaskEvent) => void>;
  /** Final result text, set on completion. */
  resultText?: string | undefined;
}

export interface PendingApproval {
  readonly callId: string;
  readonly taskId: string;
  readonly toolPath: string;
  readonly input: unknown;
  resolve: (decision: ApprovalDecision) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const tasks = new Map<string, Task>();
const pendingApprovals = new Map<string, PendingApproval>();

let taskCounter = 0;

export function generateTaskId(): string {
  return `task_${Date.now()}_${++taskCounter}`;
}

// -- Tasks --

export function createTask(opts: {
  id: string;
  prompt: string;
  requesterId: string;
  channelId?: string | undefined;
}): Task {
  const task: Task = {
    id: opts.id,
    prompt: opts.prompt,
    requesterId: opts.requesterId,
    channelId: opts.channelId,
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
  if (requesterId) {
    return all.filter((t) => t.requesterId === requesterId);
  }
  return all;
}

export function emitTaskEvent(taskId: string, event: TaskEvent): void {
  const task = tasks.get(taskId);
  if (!task) return;

  task.events.push(event);

  // Notify all subscribers
  for (const subscriber of task.subscribers) {
    try {
      subscriber(event);
    } catch {
      // Subscriber threw — remove it
      task.subscribers.delete(subscriber);
    }
  }

  // Update task status based on events
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

// -- Approvals --

export function registerApproval(approval: PendingApproval): void {
  pendingApprovals.set(approval.callId, approval);
}

export function resolveApproval(
  callId: string,
  decision: ApprovalDecision,
): boolean {
  const approval = pendingApprovals.get(callId);
  if (!approval) return false;

  approval.resolve(decision);
  pendingApprovals.delete(callId);
  return true;
}

export function getPendingApproval(callId: string): PendingApproval | undefined {
  return pendingApprovals.get(callId);
}

export function listPendingApprovals(taskId?: string): PendingApproval[] {
  const all = [...pendingApprovals.values()];
  if (taskId) {
    return all.filter((a) => a.taskId === taskId);
  }
  return all;
}
