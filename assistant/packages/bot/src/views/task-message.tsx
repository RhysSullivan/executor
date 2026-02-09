/**
 * TaskMessage — live-updating Discord message powered by Convex reactivity.
 *
 * - Watches agentTask in Convex for status, result, error (reactive, no polling)
 * - Watches pending approvals in Convex (reactive)
 * - Approval buttons resolve via Convex mutation
 */

import { useState, useCallback } from "react";
import {
  Container,
  TextDisplay,
  Separator,
  ActionRow,
  Button,
  Loading,
  useInstance,
} from "@openassistant/reacord";
import { useMutation, useQuery } from "convex/react";
import { api } from "@executor/convex/_generated/api";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TaskMessageProps {
  readonly agentTaskId: string;
  readonly prompt: string;
  readonly workspaceId: string;
}

export function TaskMessage({ agentTaskId, prompt, workspaceId }: TaskMessageProps) {
  const instance = useInstance();
  const resolveApproval = useMutation(api.executor.resolveApproval);

  // Reactive queries — no polling!
  const agentTask = useQuery(api.database.getAgentTask, { agentTaskId });
  const pendingApprovals = useQuery(api.workspace.listPendingApprovals, { workspaceId });

  const status = agentTask?.status ?? "running";
  const isDone = status !== "running";

  // Deactivate instance after completion (give Discord a moment to render)
  if (isDone) {
    setTimeout(() => instance.deactivate(), 5000);
  }

  const handleApproval = useCallback(async (approvalId: string, decision: "approved" | "denied") => {
    try {
      await resolveApproval({
        workspaceId,
        approvalId,
        decision,
      });
    } catch (err) {
      console.error(`[approval ${approvalId}]`, err);
    }
  }, [resolveApproval, workspaceId]);

  const accentColor = isDone
    ? status === "completed" ? 0x57f287 : 0xed4245
    : 0x5865f2;

  const statusEmoji = status === "running" ? "\u23f3" : status === "completed" ? "\u2705" : "\u274c";
  const statusMessage = status === "running"
    ? (pendingApprovals && pendingApprovals.length > 0 ? "Waiting for approval..." : "Thinking...")
    : status === "completed" ? "Completed" : "Failed";

  return (
    <Container accentColor={accentColor}>
      <TextDisplay>{`${statusEmoji} **${statusMessage}**`}</TextDisplay>
      <TextDisplay>{`> ${prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt}`}</TextDisplay>

      {pendingApprovals?.map((approval: any) => (
        <ApprovalSection
          key={approval.id}
          approval={approval}
          onDecision={(d) => handleApproval(approval.id, d)}
        />
      ))}

      {agentTask?.error && (
        <>
          <Separator />
          <TextDisplay>{`\u274c **Error:** ${agentTask.error.slice(0, 500)}`}</TextDisplay>
        </>
      )}

      {agentTask?.resultText && (
        <>
          <Separator />
          <TextDisplay>
            {agentTask.resultText.length > 1800
              ? agentTask.resultText.slice(0, 1800) + "..."
              : agentTask.resultText}
          </TextDisplay>
        </>
      )}

      {status === "running" && (!pendingApprovals || pendingApprovals.length === 0) && <Loading />}
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
  approval: { id: string; toolPath: string; input: unknown };
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
