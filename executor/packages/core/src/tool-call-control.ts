import {
  APPROVAL_DENIED_PREFIX,
  APPROVAL_PENDING_PREFIX,
} from "./execution-constants";

export type ToolCallControlSignal =
  | { kind: "approval_pending"; approvalId: string }
  | { kind: "approval_denied"; reason: string };

export function encodeToolCallControlSignal(signal: ToolCallControlSignal): string {
  if (signal.kind === "approval_pending") {
    return `${APPROVAL_PENDING_PREFIX}${signal.approvalId}`;
  }

  return `${APPROVAL_DENIED_PREFIX}${signal.reason}`;
}

export function decodeToolCallControlSignal(value: unknown): ToolCallControlSignal | null {
  const message = value instanceof Error ? value.message : String(value ?? "");

  if (message.startsWith(APPROVAL_PENDING_PREFIX)) {
    const approvalId = message.replace(APPROVAL_PENDING_PREFIX, "").trim();
    return { kind: "approval_pending", approvalId };
  }

  if (message.startsWith(APPROVAL_DENIED_PREFIX)) {
    const reason = message.replace(APPROVAL_DENIED_PREFIX, "").trim();
    return { kind: "approval_denied", reason };
  }

  return null;
}

export class ToolCallControlError extends Error {
  readonly signal: ToolCallControlSignal;

  constructor(signal: ToolCallControlSignal) {
    super(encodeToolCallControlSignal(signal));
    this.name = "ToolCallControlError";
    this.signal = signal;
  }
}
