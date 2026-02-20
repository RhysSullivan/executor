import { COMPLETED_TASK_STATUSES, type CompletedTaskStatus, type TaskStatus } from "../../../core/src/types";

type TerminalTaskStatus = CompletedTaskStatus;

const TERMINAL_TASK_STATUS_SET = new Set<TaskStatus>(COMPLETED_TASK_STATUSES);

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return TERMINAL_TASK_STATUS_SET.has(status);
}

export function taskTerminalEventType(status: TerminalTaskStatus): "task.completed" | "task.failed" | "task.timed_out" | "task.denied" {
  if (status === "completed") return "task.completed";
  if (status === "timed_out") return "task.timed_out";
  if (status === "denied") return "task.denied";
  return "task.failed";
}
