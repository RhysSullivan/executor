/**
 * TaskMessage — self-contained live-updating Discord message for a task.
 *
 * Subscribes to the server's SSE stream via Eden Treaty on mount,
 * reduces TaskEvents into local state, and re-renders reactively.
 *
 * The command handler just mounts this component and walks away:
 *   <TaskMessage taskId={id} prompt={prompt} api={api} />
 */

import { useState, useEffect } from "react";
import {
  Container,
  TextDisplay,
  Separator,
  ActionRow,
  Button,
  Loading,
  useInstance,
} from "@openassistant/reacord";
import type { Client as ApiClient } from "@openassistant/server/client";
import { unwrap } from "@openassistant/server/client";
import type { TaskEvent } from "@openassistant/core/events";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PendingApproval {
  readonly id: string;
  readonly toolPath: string;
  readonly input: unknown;
  readonly preview: { title: string; details?: string; link?: string };
}

interface TaskState {
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly statusMessage: string;
  readonly lastCode: string | null;
  readonly toolResults: string[];
  readonly pendingApprovals: PendingApproval[];
  readonly agentMessage: string | null;
  readonly error: string | null;
}

const INITIAL_STATE: TaskState = {
  status: "running",
  statusMessage: "Thinking...",
  lastCode: null,
  toolResults: [],
  pendingApprovals: [],
  agentMessage: null,
  error: null,
};

function reduceEvent(state: TaskState, event: TaskEvent): TaskState {
  switch (event.type) {
    case "status":
      return { ...state, statusMessage: event.message };

    case "code_generated":
      return { ...state, lastCode: event.code, statusMessage: "Running code..." };

    case "approval_request":
      return {
        ...state,
        pendingApprovals: [
          ...state.pendingApprovals,
          { id: event.id, toolPath: event.toolPath, input: event.input, preview: event.preview },
        ],
        statusMessage: "Waiting for approval...",
      };

    case "approval_resolved":
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((a) => a.id !== event.id),
        statusMessage: event.decision === "approved" ? "Approved, continuing..." : "Denied.",
      };

    case "tool_result": {
      const r = event.receipt;
      const icon = r.status === "succeeded" ? "\u2705" : r.status === "denied" ? "\u26d4" : "\u274c";
      const line = `${icon} \`${r.toolPath}\`${r.outputPreview ? ` \u2192 ${r.outputPreview.slice(0, 100)}` : ""}`;
      return { ...state, toolResults: [...state.toolResults, line] };
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
// Component
// ---------------------------------------------------------------------------

export interface TaskMessageProps {
  readonly taskId: string;
  readonly prompt: string;
  readonly api: ApiClient;
}

export function TaskMessage({ taskId, prompt, api }: TaskMessageProps) {
  const instance = useInstance();
  const [state, setState] = useState<TaskState>(INITIAL_STATE);

  // Subscribe to SSE stream on mount
  useEffect(() => {
    let cancelled = false;

    const subscribe = async () => {
      try {
        const { data: stream, error } = await api.api.tasks({ id: taskId }).events.get();

        if (error || !stream) {
          if (!cancelled) {
            setState((s) => ({ ...s, status: "failed", error: "Failed to connect to event stream", statusMessage: "Failed" }));
          }
          return;
        }

        for await (const sse of stream as AsyncIterable<{ event: string; data: TaskEvent }>) {
          if (cancelled) break;
          setState((s) => reduceEvent(s, sse.data));
        }
      } catch (err) {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            statusMessage: "Failed",
          }));
        }
      }
    };

    subscribe();

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Deactivate buttons once done
  useEffect(() => {
    if (state.status !== "running") {
      const timer = setTimeout(() => instance.deactivate(), 5000);
      return () => clearTimeout(timer);
    }
  }, [state.status]);

  const isDone = state.status !== "running";
  const accentColor = isDone
    ? state.status === "completed" ? 0x57f287 : 0xed4245
    : 0x5865f2;

  return (
    <Container accentColor={accentColor}>
      <TextDisplay>{`${statusEmoji(state.status)} **${state.statusMessage}**`}</TextDisplay>
      <TextDisplay>{`> ${prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt}`}</TextDisplay>

      {state.lastCode && (
        <>
          <Separator />
          <TextDisplay>{`\`\`\`ts\n${state.lastCode.length > 800 ? state.lastCode.slice(0, 800) + "\n// ..." : state.lastCode}\n\`\`\``}</TextDisplay>
        </>
      )}

      {state.toolResults.length > 0 && (
        <>
          <Separator />
          <TextDisplay>{state.toolResults.slice(-10).join("\n")}</TextDisplay>
        </>
      )}

      {state.pendingApprovals.map((approval) => (
        <ApprovalButtons key={approval.id} approval={approval} api={api} />
      ))}

      {state.error && (
        <>
          <Separator />
          <TextDisplay>{`\u274c **Error:** ${state.error.slice(0, 500)}`}</TextDisplay>
        </>
      )}

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

      {state.status === "running" && state.pendingApprovals.length === 0 && (
        <Loading />
      )}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Approval buttons
// ---------------------------------------------------------------------------

function ApprovalButtons({ approval, api }: { approval: PendingApproval; api: ApiClient }) {
  const [resolved, setResolved] = useState(false);
  const argsPreview = formatApprovalInput(approval.input);

  const handle = async (decision: "approved" | "denied") => {
    setResolved(true);
    try {
      await unwrap(api.api.approvals({ callId: approval.id }).post({ decision }));
    } catch (err) {
      console.error(`[approval ${approval.id}]`, err);
    }
  };

  return (
    <>
      <Separator />
      <TextDisplay>
        {`\u{1f6e1}\ufe0f **Approval required:** ${approval.preview.title}${approval.preview.details ? `\n${approval.preview.details}` : ""}${approval.preview.link ? `\n${approval.preview.link}` : ""}`}
      </TextDisplay>
      <TextDisplay>{`\`\`\`json\n${argsPreview}\n\`\`\``}</TextDisplay>
      {!resolved && (
        <ActionRow>
          <Button label="Approve" style="success" onClick={() => handle("approved")} />
          <Button label="Deny" style="danger" onClick={() => handle("denied")} />
        </ActionRow>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: TaskState["status"]): string {
  switch (status) {
    case "running": return "\u23f3";
    case "completed": return "\u2705";
    case "failed": return "\u274c";
    case "cancelled": return "\u26d4";
  }
}

function formatApprovalInput(input: unknown): string {
  if (input === undefined) return "undefined";
  if (input === null) return "null";
  try {
    const serialized = JSON.stringify(input, null, 2);
    if (!serialized) return String(input);
    return serialized.length > 1000 ? `${serialized.slice(0, 1000)}...` : serialized;
  } catch {
    return String(input);
  }
}
