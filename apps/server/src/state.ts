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

export type RuleOperator = "equals" | "not_equals" | "includes" | "not_includes";

export interface ApprovalRule {
  readonly id: string;
  readonly taskId: string;
  /** Tool path the rule applies to (e.g. "vercel.projects.removeProjectDomain") */
  readonly toolPath: string;
  /** Dot-path into the input object (e.g. "idOrName", "owner") */
  readonly field: string;
  readonly operator: RuleOperator;
  readonly value: string;
  readonly decision: ApprovalDecision;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const tasks = new Map<string, Task>();
const pendingApprovals = new Map<string, PendingApproval>();
const approvalRules = new Map<string, ApprovalRule[]>(); // taskId → rules

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
  // Check rules first — auto-resolve if matched (scoped to same tool)
  const autoDecision = checkApprovalRules(approval.taskId, approval.toolPath, approval.input);
  if (autoDecision) {
    // Resolve immediately without registering as pending
    approval.resolve(autoDecision);
    return;
  }
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

// -- Approval Rules --

/**
 * Get the value at a dot-path in an object.
 * e.g. getFieldValue({ a: { b: "c" } }, "a.b") → "c"
 */
function getFieldValue(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Check if an approval input matches a rule.
 */
function matchesRule(input: unknown, rule: ApprovalRule): boolean {
  const fieldValue = String(getFieldValue(input, rule.field) ?? "");
  switch (rule.operator) {
    case "equals": return fieldValue === rule.value;
    case "not_equals": return fieldValue !== rule.value;
    case "includes": return fieldValue.includes(rule.value);
    case "not_includes": return !fieldValue.includes(rule.value);
  }
}

/**
 * Check if any rules match this approval. Returns the decision if matched.
 * Rules only apply to the same tool path they were created for.
 */
export function checkApprovalRules(taskId: string, toolPath: string, input: unknown): ApprovalDecision | undefined {
  const rules = approvalRules.get(taskId);
  if (!rules || rules.length === 0) return undefined;
  for (const rule of rules) {
    if (rule.toolPath === toolPath && matchesRule(input, rule)) return rule.decision;
  }
  return undefined;
}

/**
 * Add a rule for a task. Also retroactively applies to pending approvals
 * for the same tool. Returns the number of approvals that were auto-resolved.
 */
export function addApprovalRule(rule: ApprovalRule): number {
  const existing = approvalRules.get(rule.taskId) ?? [];
  existing.push(rule);
  approvalRules.set(rule.taskId, existing);

  // Retroactively apply to pending approvals for the same tool
  let resolved = 0;
  const pending = listPendingApprovals(rule.taskId);
  for (const approval of pending) {
    if (approval.toolPath === rule.toolPath && matchesRule(approval.input, rule)) {
      resolveApproval(approval.callId, rule.decision);
      resolved++;
    }
  }
  return resolved;
}

export function listApprovalRules(taskId: string): ApprovalRule[] {
  return approvalRules.get(taskId) ?? [];
}
