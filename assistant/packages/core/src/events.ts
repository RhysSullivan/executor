/**
 * Task event types — the stream of events produced by the agent loop.
 * Clients subscribe to these and render however they want.
 */

export type TaskEvent =
  | TaskStatusEvent
  | TaskCodeGeneratedEvent
  | TaskCodeResultEvent
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

export interface TaskCodeResultEvent {
  readonly type: "code_result";
  readonly taskId: string;
  readonly status: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
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
}
