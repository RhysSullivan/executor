import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PendingApprovalRecord, TaskRecord } from "../types";
import type { Id } from "../../../database/convex/_generated/dataModel";
import type {
  ApprovalPrompt,
  ApprovalPromptContext,
  ApprovalPromptDecision,
  McpExecutorService,
} from "./server-contracts";
import { getTaskTerminalState } from "./server-utils";

function formatApprovalInput(input: unknown, maxLength = 2000): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input ?? {}, null, 2);
  } catch {
    serialized = String(input);
  }

  if (serialized.length <= maxLength) {
    return serialized;
  }

  return `${serialized.slice(0, maxLength)}\n... [truncated ${serialized.length - maxLength} chars]`;
}

function buildApprovalPromptMessage(approval: PendingApprovalRecord): string {
  const lines = [
    "Approval required before tool execution can continue.",
    `Tool: ${approval.toolPath}`,
    `Task: ${approval.taskId}`,
    `Runtime: ${approval.task.runtimeId}`,
    "",
    "Tool input:",
    "```json",
    formatApprovalInput(approval.input),
    "```",
  ];

  return lines.join("\n");
}

export function createMcpApprovalPrompt(mcp: McpServer): ApprovalPrompt {
  return async (approval) => {
    const response = await mcp.server.elicitInput({
      mode: "form",
      message: buildApprovalPromptMessage(approval),
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Approval decision",
            description: "Approve or deny this tool call",
            oneOf: [
              { const: "approved", title: "Approve tool call" },
              { const: "denied", title: "Deny tool call" },
            ],
            default: "approved",
          },
          reason: {
            type: "string",
            title: "Reason (optional)",
            description: "Optional note recorded with your decision",
            maxLength: 500,
          },
        },
        required: ["decision"],
      },
    }, { timeout: 15_000 }) as {
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    };

    if (response.action !== "accept") {
      return {
        decision: "denied",
        reason: response.action === "decline"
          ? "User explicitly declined approval"
          : "User canceled approval prompt",
      };
    }

    const selectedDecision = response.content?.decision;
    const decision = selectedDecision === "approved" ? "approved" : "denied";
    const selectedReason = response.content?.reason;
    const reason = typeof selectedReason === "string" && selectedReason.trim().length > 0
      ? selectedReason
      : undefined;

    return { decision, reason };
  };
}

export function waitForTerminalTask(
  service: McpExecutorService,
  taskId: string,
  workspaceId: Id<"workspaces">,
  waitTimeoutMs: number,
  onApprovalPrompt?: ApprovalPrompt,
  approvalContext?: ApprovalPromptContext,
): Promise<TaskRecord | null> {
  return new Promise((resolve) => {
    let settled = false;
    let elicitationEnabled = Boolean(
      onApprovalPrompt
      && approvalContext
      && service.listPendingApprovals
      && service.resolveApproval,
    );
    let loggedElicitationFallback = false;
    const seenApprovalIds = new Set<string>();
    let unsubscribe: (() => void) | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;

    const logElicitationFallback = (reason: string) => {
      if (loggedElicitationFallback) return;
      loggedElicitationFallback = true;
      console.warn(`[executor] MCP approval elicitation unavailable, using out-of-band approvals: ${reason}`);
    };

    const done = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (interval) {
        clearInterval(interval);
      }
      unsubscribe?.();
      resolve(await service.getTask(taskId, workspaceId));
    };

    const timeout = setTimeout(done, waitTimeoutMs);

    // Convex HTTP actions don't provide a real push subscription. To avoid hanging
    // forever, we poll task state and pending approvals on an interval.
    let polling = false;
    const poll = async () => {
      if (settled || polling) return;
      polling = true;
      try {
        await maybeHandleApprovals();
        const task = await service.getTask(taskId, workspaceId);
        if (task && getTaskTerminalState(task.status)) {
          await done();
        }
      } finally {
        polling = false;
      }
    };

    interval = setInterval(() => {
      void poll().catch(() => {});
    }, 750);

    const maybeHandleApprovals = async () => {
      if (!elicitationEnabled || !service.listPendingApprovals || !service.resolveApproval || !onApprovalPrompt || !approvalContext) {
        return;
      }

      const approvals = await service.listPendingApprovals(workspaceId);
      const pending = approvals.filter((approval) => approval.taskId === taskId && !seenApprovalIds.has(approval.id));
      if (pending.length === 0) {
        return;
      }
      for (const approval of pending) {
        let decision: ApprovalPromptDecision | null;
        try {
          decision = await onApprovalPrompt(approval, approvalContext);
        } catch (error) {
          elicitationEnabled = false;
          logElicitationFallback(error instanceof Error ? error.message : String(error));
          return;
        }

        if (!decision) {
          elicitationEnabled = false;
          logElicitationFallback("client did not provide elicitation response support");
          return;
        }

        await service.resolveApproval({
          workspaceId,
          approvalId: approval.id,
          decision: decision.decision,
          reason: decision.reason,
          reviewerId: approvalContext.actorId,
        });
        seenApprovalIds.add(approval.id);
      }
    };

    unsubscribe = service.subscribe(taskId, workspaceId, (event) => {
      const payload = typeof event.payload === "object" && event.payload
        ? event.payload as Record<string, unknown>
        : {};
      const type = typeof payload.status === "string" ? payload.status : undefined;
      const pendingApprovalCount = typeof payload.pendingApprovalCount === "number"
        ? payload.pendingApprovalCount
        : 0;

      if (typeof type === "string" && getTaskTerminalState(type)) {
        void done();
        return;
      }

      if (pendingApprovalCount > 0) {
        void maybeHandleApprovals().catch(() => {});
      }
    });

    void poll().catch(() => {});

    void service.getTask(taskId, workspaceId).then((task) => {
      if (task && getTaskTerminalState(task.status)) {
        void done();
      }
    }).catch(() => {});
  });
}
