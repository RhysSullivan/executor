import type { LiveTaskEvent } from "../events";
import type {
  AnonymousContext,
  CreateTaskInput,
  PendingApprovalRecord,
  TaskExecutionOutcome,
  TaskRecord,
  ToolDescriptor,
} from "../types";
import type { Id } from "../../../database/convex/_generated/dataModel";

export interface McpExecutorService {
  createTask(input: CreateTaskInput): Promise<{ task: TaskRecord }>;
  runTaskNow?(taskId: string): Promise<TaskExecutionOutcome | null>;
  getTask(taskId: string, workspaceId?: Id<"workspaces">): Promise<TaskRecord | null>;
  subscribe(taskId: string, workspaceId: Id<"workspaces">, listener: (event: LiveTaskEvent) => void): () => void;
  bootstrapAnonymousContext(sessionId?: string): Promise<AnonymousContext>;
  listTools(context?: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string }): Promise<ToolDescriptor[]>;
  listPendingApprovals?(workspaceId: Id<"workspaces">): Promise<PendingApprovalRecord[]>;
  resolveApproval?(input: {
    workspaceId: Id<"workspaces">;
    approvalId: string;
    decision: "approved" | "denied";
    reviewerId?: string;
    reason?: string;
  }): Promise<unknown>;
}

export interface ApprovalPromptDecision {
  decision: "approved" | "denied";
  reason?: string;
}

export interface ApprovalPromptContext {
  workspaceId: Id<"workspaces">;
  actorId: string;
}

export type ApprovalPrompt = (
  approval: PendingApprovalRecord,
  context: ApprovalPromptContext,
) => Promise<ApprovalPromptDecision | null>;
