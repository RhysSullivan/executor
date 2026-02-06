/**
 * Task event types — the stream of events produced by every task run.
 * Clients subscribe to these and render them however they want.
 */

import type { ApprovalPresentation, ToolCallReceipt } from "./tools.js";

export type TaskEvent =
  | TaskStatusEvent
  | TaskCodeGeneratedEvent
  | TaskApprovalRequestEvent
  | TaskApprovalResolvedEvent
  | TaskToolResultEvent
  | TaskAgentMessageEvent
  | TaskErrorEvent
  | TaskCompletedEvent;

export interface TaskStatusEvent {
  readonly type: "status";
  readonly message: string;
}

export interface TaskCodeGeneratedEvent {
  readonly type: "code_generated";
  readonly code: string;
}

export interface TaskApprovalRequestEvent {
  readonly type: "approval_request";
  readonly id: string;
  readonly toolPath: string;
  readonly input: unknown;
  readonly preview: ApprovalPresentation;
}

export interface TaskApprovalResolvedEvent {
  readonly type: "approval_resolved";
  readonly id: string;
  readonly decision: "approved" | "denied";
}

export interface TaskToolResultEvent {
  readonly type: "tool_result";
  readonly receipt: ToolCallReceipt;
}

export interface TaskAgentMessageEvent {
  readonly type: "agent_message";
  readonly text: string;
}

export interface TaskErrorEvent {
  readonly type: "error";
  readonly error: string;
}

export interface TaskCompletedEvent {
  readonly type: "completed";
  readonly receipts: readonly ToolCallReceipt[];
}
