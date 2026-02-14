import type { TaskStatus } from "../../core/src/types";

type TerminalTaskStatus = Extract<TaskStatus, "completed" | "failed" | "timed_out" | "denied">;

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "denied";
}

export function taskTerminalEventType(status: TerminalTaskStatus): "task.completed" | "task.failed" | "task.timed_out" | "task.denied" {
  if (status === "completed") return "task.completed";
  if (status === "timed_out") return "task.timed_out";
  if (status === "denied") return "task.denied";
  return "task.failed";
}
