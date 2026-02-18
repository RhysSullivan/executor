import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PendingApprovalRecord, TaskExecutionOutcome, TaskRecord } from "../types";
import type { Id } from "../../../database/convex/_generated/dataModel";
import type {
  ApprovalPrompt,
  ApprovalPromptContext,
  ApprovalPromptDecision,
  McpExecutorService,
} from "./server-contracts";
import { getTaskTerminalState } from "./server-utils";

const elicitationResponseSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.object({
    decision: z.enum(["approved", "denied"]).optional(),
    reason: z.string().optional(),
  }).optional(),
});

const subscriptionEventPayloadSchema = z.object({
  status: z.string().optional(),
  pendingApprovalCount: z.coerce.number().optional(),
});

const REDACTED_PLACEHOLDER = "[redacted]";
const sensitiveInputKeyPattern = /(authorization|api[-_]?key|token|secret|password|cookie|credential)/i;

function sanitizeApprovalInput(input: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(input)) {
    return input.map((entry) => sanitizeApprovalInput(entry, seen));
  }

  if (input && typeof input === "object") {
    const objectInput = input as Record<string, unknown>;
    if (seen.has(objectInput)) {
      return "[circular]";
    }
    seen.add(objectInput);

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(objectInput)) {
      if (sensitiveInputKeyPattern.test(key)) {
        sanitized[key] = REDACTED_PLACEHOLDER;
        continue;
      }
      sanitized[key] = sanitizeApprovalInput(value, seen);
    }
    return sanitized;
  }

  return input;
}

function formatApprovalInput(input: unknown, maxLength = 2000): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitizeApprovalInput(input ?? {}), null, 2);
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
    const rawResponse = await mcp.server.elicitInput({
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
    }, { timeout: 15_000 });

    const parsedResponse = elicitationResponseSchema.safeParse(rawResponse);
    if (!parsedResponse.success) {
      return {
        decision: "denied",
        reason: "User canceled approval prompt",
      };
    }

    const action = parsedResponse.data.action;
    const content = parsedResponse.data.content;

    if (action !== "accept") {
      return {
        decision: "denied",
        reason: action === "decline"
          ? "User explicitly declined approval"
          : "User canceled approval prompt",
      };
    }

    const selectedDecision = content?.decision;
    const decision = selectedDecision === "approved" ? "approved" : "denied";
    const selectedReason = content?.reason?.trim();
    const reason = selectedReason && selectedReason.length > 0 ? selectedReason : undefined;

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
    let handlingApprovals = false;

    const logElicitationFallback = (reason: string) => {
      if (loggedElicitationFallback) return;
      loggedElicitationFallback = true;
      console.warn(`[executor] MCP approval elicitation unavailable, using out-of-band approvals: ${reason}`);
    };

    const done = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(await service.getTask(taskId, workspaceId));
    };

    const timeout = setTimeout(done, waitTimeoutMs);

    const maybeHandleApprovals = async () => {
      if (
        settled
        || !elicitationEnabled
        || !service.listPendingApprovals
        || !service.resolveApproval
        || !onApprovalPrompt
        || !approvalContext
      ) {
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
          reviewerId: approvalContext.accountId,
        });
        seenApprovalIds.add(approval.id);
      }
    };

    const maybeHandleApprovalsSafely = async () => {
      if (handlingApprovals || settled) {
        return;
      }
      handlingApprovals = true;
      try {
        await maybeHandleApprovals();
      } finally {
        handlingApprovals = false;
      }
    };

    unsubscribe = service.subscribe(taskId, workspaceId, (event) => {
      const parsedPayload = subscriptionEventPayloadSchema.safeParse(event.payload);
      const type = parsedPayload.success ? parsedPayload.data.status : undefined;
      const pendingApprovalCount = parsedPayload.success ? parsedPayload.data.pendingApprovalCount : undefined;

      if (type && getTaskTerminalState(type)) {
        void done();
        return;
      }

      if ((pendingApprovalCount ?? 1) > 0) {
        void maybeHandleApprovalsSafely().catch(() => {});
      }
    });

    void maybeHandleApprovalsSafely().catch(() => {});

    void service.getTask(taskId, workspaceId).then((task) => {
      if (task && getTaskTerminalState(task.status)) {
        void done();
      }
    }).catch(() => {});
  });
}

export async function runTaskNowWithApprovalElicitation(
  service: McpExecutorService,
  taskId: string,
  runTaskNow: () => Promise<TaskExecutionOutcome | null>,
  onApprovalPrompt?: ApprovalPrompt,
  approvalContext?: ApprovalPromptContext,
): Promise<TaskExecutionOutcome | null> {
  const hasApprovalSupport = Boolean(
    onApprovalPrompt
    && approvalContext
    && service.listPendingApprovals
    && service.resolveApproval,
  );

  if (!hasApprovalSupport || !service.listPendingApprovals || !service.resolveApproval || !onApprovalPrompt || !approvalContext) {
    return await runTaskNow();
  }
  const listPendingApprovals = service.listPendingApprovals;
  const resolveApproval = service.resolveApproval;

  let settled = false;
  let elicitationEnabled = true;
  let loggedElicitationFallback = false;
  let handlingApprovals = false;
  let unsubscribe: (() => void) | undefined;
  const seenApprovalIds = new Set<string>();

  const logElicitationFallback = (reason: string) => {
    if (loggedElicitationFallback) return;
    loggedElicitationFallback = true;
    console.warn(`[executor] MCP approval elicitation unavailable, using out-of-band approvals: ${reason}`);
  };

  const maybeHandleApprovals = async () => {
    if (settled || !elicitationEnabled) {
      return;
    }

    const approvals = await listPendingApprovals(approvalContext.workspaceId);
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

      await resolveApproval({
        workspaceId: approvalContext.workspaceId,
        approvalId: approval.id,
        decision: decision.decision,
        reason: decision.reason,
        reviewerId: approvalContext.accountId,
      });
      seenApprovalIds.add(approval.id);
    }
  };

  const maybeHandleApprovalsSafely = async () => {
    if (handlingApprovals || settled) {
      return;
    }
    handlingApprovals = true;
    try {
      await maybeHandleApprovals();
    } finally {
      handlingApprovals = false;
    }
  };

  unsubscribe = service.subscribe(taskId, approvalContext.workspaceId, (event) => {
    const parsedPayload = subscriptionEventPayloadSchema.safeParse(event.payload);
    const pendingApprovalCount = parsedPayload.success ? parsedPayload.data.pendingApprovalCount : undefined;
    if ((pendingApprovalCount ?? 1) > 0) {
      void maybeHandleApprovalsSafely().catch(() => {});
    }
  });

  void maybeHandleApprovalsSafely().catch(() => {});

  try {
    return await runTaskNow();
  } finally {
    settled = true;
    unsubscribe?.();
  }
}
