/**
 * TaskMessage — live-updating Discord message.
 *
 * - Polls assistant server for task status (agent_message, completed, failed)
 * - Watches Convex for pending approvals (reactive, no polling)
 * - Approval buttons resolve via executor REST API
 */

import { useState, useEffect, useCallback } from "react";
import {
  Container,
  TextDisplay,
  Separator,
  ActionRow,
  Button,
  Loading,
  useInstance,
} from "@openassistant/reacord";
// Executor client is just an Eden Treaty client — no separate adapter needed
import type { ConvexReactClient } from "convex/react";
import { api as convexApi } from "@executor/convex/_generated/api";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PendingApproval {
  readonly id: string;
  readonly toolPath: string;
  readonly input: unknown;
}

interface TaskState {
  readonly status: "running" | "completed" | "failed";
  readonly statusMessage: string;
  readonly agentMessage: string | null;
  readonly error: string | null;
  readonly pendingApprovals: PendingApproval[];
}

const INITIAL_STATE: TaskState = {
  status: "running",
  statusMessage: "Thinking...",
  agentMessage: null,
  error: null,
  pendingApprovals: [],
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TaskMessageProps {
  readonly taskId: string;
  readonly prompt: string;
  readonly workspaceId: string;
  readonly executor: ReturnType<typeof import("@elysiajs/eden").treaty>;
  readonly convex: ConvexReactClient;
}

export function TaskMessage({ taskId, prompt, workspaceId, executor, convex }: TaskMessageProps) {
  const instance = useInstance();
  const [state, setState] = useState<TaskState>(INITIAL_STATE);

  // Poll assistant server for task completion
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        try {
          const resp = await fetch(`http://localhost:3000/api/tasks/${taskId}`);
          if (resp.ok) {
            const task = await resp.json() as {
              status: string;
              resultText?: string;
              errorMessage?: string;
            };

            if (task.status === "completed" && task.resultText) {
              setState((s) => ({
                ...s,
                status: "completed",
                statusMessage: "Completed",
                agentMessage: task.resultText!,
              }));
              return;
            }

            if (task.status === "failed") {
              setState((s) => ({
                ...s,
                status: "failed",
                statusMessage: "Failed",
                error: task.errorMessage ?? "Unknown error",
              }));
              return;
            }
          }
        } catch {
          // ignore
        }

        await new Promise((r) => setTimeout(r, 1500));
      }
    };

    poll();
    return () => { cancelled = true; };
  }, [taskId]);

  // Watch Convex for pending approvals (reactive!)
  useEffect(() => {
    const watch = convex.watchQuery(convexApi.database.listPendingApprovals, {
      workspaceId,
    });

    const unsubscribe = watch.onUpdate(() => {
      const approvals = watch.localQueryResult();
      if (!approvals) return;

      setState((s) => ({
        ...s,
        pendingApprovals: (approvals as any[]).map((a) => ({
          id: a.id,
          toolPath: a.toolPath,
          input: a.input,
        })),
        statusMessage: (approvals as any[]).length > 0 ? "Waiting for approval..." : s.statusMessage,
      }));
    });

    return unsubscribe;
  }, [convex, workspaceId]);

  // Deactivate once done
  useEffect(() => {
    if (state.status !== "running") {
      const timer = setTimeout(() => instance.deactivate(), 5000);
      return () => clearTimeout(timer);
    }
  }, [state.status]);

  const handleApproval = useCallback(async (approvalId: string, decision: "approved" | "denied") => {
    try {
      await executor.api.approvals({ approvalId }).post({
        workspaceId,
        decision,
      });
    } catch (err) {
      console.error(`[approval ${approvalId}]`, err);
    }
  }, [executor, workspaceId]);

  const isDone = state.status !== "running";
  const accentColor = isDone
    ? state.status === "completed" ? 0x57f287 : 0xed4245
    : 0x5865f2;

  return (
    <Container accentColor={accentColor}>
      <TextDisplay>{`${state.status === "running" ? "\u23f3" : state.status === "completed" ? "\u2705" : "\u274c"} **${state.statusMessage}**`}</TextDisplay>
      <TextDisplay>{`> ${prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt}`}</TextDisplay>

      {state.pendingApprovals.map((approval) => (
        <ApprovalSection
          key={approval.id}
          approval={approval}
          onDecision={(d) => handleApproval(approval.id, d)}
        />
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

      {state.status === "running" && state.pendingApprovals.length === 0 && <Loading />}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Approval section
// ---------------------------------------------------------------------------

function ApprovalSection({
  approval,
  onDecision,
}: {
  approval: PendingApproval;
  onDecision: (decision: "approved" | "denied") => void;
}) {
  const [resolved, setResolved] = useState(false);
  const toolName = approval.toolPath.split(".").pop() ?? approval.toolPath;

  const handle = (decision: "approved" | "denied") => {
    setResolved(true);
    onDecision(decision);
  };

  return (
    <>
      <Separator />
      <TextDisplay>{`\u{1f6e1}\ufe0f **Approval Required:** \`${toolName}\``}</TextDisplay>
      {!resolved && (
        <ActionRow>
          <Button label="Approve" style="success" onClick={() => handle("approved")} />
          <Button label="Deny" style="danger" onClick={() => handle("denied")} />
        </ActionRow>
      )}
    </>
  );
}
