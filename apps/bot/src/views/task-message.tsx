/**
 * TaskMessage — the live-updating Discord message for a running task.
 *
 * Shows:
 * - Current status (thinking, generating code, running, etc.)
 * - Code blocks when code is generated
 * - Tool call results
 * - Approval buttons when approval is required
 * - Final agent response when complete
 */

import {
  Container,
  TextDisplay,
  Separator,
  Section,
  ActionRow,
  Button,
  Loading,
  useInstance,
} from "@openassistant/reacord";
import type { ButtonInteraction } from "discord.js";
import type { TaskEvent } from "@openassistant/core/events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingApproval {
  readonly id: string;
  readonly toolPath: string;
  readonly preview: { title: string; details?: string };
}

export interface TaskState {
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly statusMessage: string;
  readonly codeBlocks: string[];
  readonly toolResults: string[];
  readonly pendingApprovals: PendingApproval[];
  readonly agentMessage: string | null;
  readonly error: string | null;
}

export function initialTaskState(): TaskState {
  return {
    status: "running",
    statusMessage: "Thinking...",
    codeBlocks: [],
    toolResults: [],
    pendingApprovals: [],
    agentMessage: null,
    error: null,
  };
}

/**
 * Reduce a TaskEvent into the current TaskState.
 */
export function reduceTaskEvent(state: TaskState, event: TaskEvent): TaskState {
  switch (event.type) {
    case "status":
      return { ...state, statusMessage: event.message };

    case "code_generated":
      return {
        ...state,
        codeBlocks: [...state.codeBlocks, event.code],
        statusMessage: "Running code...",
      };

    case "approval_request":
      return {
        ...state,
        pendingApprovals: [
          ...state.pendingApprovals,
          {
            id: event.id,
            toolPath: event.toolPath,
            preview: event.preview,
          },
        ],
        statusMessage: "Waiting for approval...",
      };

    case "approval_resolved":
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((a) => a.id !== event.id),
        statusMessage: event.decision === "approved" ? "Approved, continuing..." : "Denied, continuing...",
      };

    case "tool_result": {
      const r = event.receipt;
      const status = r.status === "succeeded" ? "\u2705" : r.status === "denied" ? "\u26d4" : "\u274c";
      const line = `${status} \`${r.toolPath}\`${r.outputPreview ? ` \u2192 ${r.outputPreview.slice(0, 100)}` : ""}`;
      return {
        ...state,
        toolResults: [...state.toolResults, line],
      };
    }

    case "agent_message":
      return { ...state, agentMessage: event.text, statusMessage: "Done" };

    case "error":
      return { ...state, status: "failed", error: event.error, statusMessage: "Failed" };

    case "completed":
      return { ...state, status: "completed", statusMessage: "Completed" };
  }
}

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

function statusEmoji(status: TaskState["status"]): string {
  switch (status) {
    case "running": return "\u23f3";
    case "completed": return "\u2705";
    case "failed": return "\u274c";
    case "cancelled": return "\u26d4";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TaskMessageProps {
  readonly prompt: string;
  readonly state: TaskState;
  readonly onApprove?: (callId: string, interaction: ButtonInteraction) => void;
  readonly onDeny?: (callId: string, interaction: ButtonInteraction) => void;
}

export function TaskMessage({ prompt, state, onApprove, onDeny }: TaskMessageProps) {
  const instance = useInstance();

  // Deactivate interactive components when task is done
  const isDone = state.status !== "running";

  return (
    <Container accentColor={isDone ? (state.status === "completed" ? 0x57f287 : 0xed4245) : 0x5865f2}>
      {/* Header */}
      <TextDisplay>{`${statusEmoji(state.status)} **${state.statusMessage}**`}</TextDisplay>
      <TextDisplay>{`> ${prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt}`}</TextDisplay>

      {/* Tool results */}
      {state.toolResults.length > 0 && (
        <>
          <Separator />
          <TextDisplay>
            {state.toolResults.slice(-10).join("\n")}
          </TextDisplay>
        </>
      )}

      {/* Pending approvals */}
      {state.pendingApprovals.map((approval) => (
        <ApprovalSection
          key={approval.id}
          approval={approval}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      ))}

      {/* Error */}
      {state.error && (
        <>
          <Separator />
          <TextDisplay>{`\u274c **Error:** ${state.error.slice(0, 500)}`}</TextDisplay>
        </>
      )}

      {/* Final response */}
      {state.agentMessage && (
        <>
          <Separator />
          <TextDisplay>
            {state.agentMessage.length > 1800
              ? state.agentMessage.slice(0, 1800) + "..."
              : state.agentMessage}
          </TextDisplay>
        </>
      )}

      {/* Loading indicator while running */}
      {state.status === "running" && !state.pendingApprovals.length && (
        <Loading />
      )}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Approval sub-component
// ---------------------------------------------------------------------------

interface ApprovalSectionProps {
  readonly approval: PendingApproval;
  readonly onApprove?: (callId: string, interaction: ButtonInteraction) => void;
  readonly onDeny?: (callId: string, interaction: ButtonInteraction) => void;
}

function ApprovalSection({ approval, onApprove, onDeny }: ApprovalSectionProps) {
  return (
    <>
      <Separator />
      <TextDisplay>
        {`\u{1f6e1}\ufe0f **Approval required:** ${approval.preview.title}${approval.preview.details ? `\n${approval.preview.details}` : ""}`}
      </TextDisplay>
      <ActionRow>
        <Button
          label="Approve"
          style="success"
          emoji="\u2705"
          onClick={(interaction) => onApprove?.(approval.id, interaction)}
        />
        <Button
          label="Deny"
          style="danger"
          emoji="\u274c"
          onClick={(interaction) => onDeny?.(approval.id, interaction)}
        />
      </ActionRow>
    </>
  );
}
