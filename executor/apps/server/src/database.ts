import { ConvexHttpClient } from "convex/browser";
import type {
  AccessPolicyRecord,
  AnonymousContext,
  ApprovalRecord,
  ApprovalStatus,
  CredentialRecord,
  CredentialScope,
  PendingApprovalRecord,
  PolicyDecision,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
  ToolSourceRecord,
} from "./types";

const DEFAULT_CONVEX_URL = "http://127.0.0.1:3210";

type MutationName =
  | "database:createTask"
  | "database:markTaskRunning"
  | "database:markTaskFinished"
  | "database:createApproval"
  | "database:resolveApproval"
  | "database:bootstrapAnonymousSession"
  | "database:upsertAccessPolicy"
  | "database:upsertCredential"
  | "database:upsertToolSource"
  | "database:deleteToolSource"
  | "database:createTaskEvent";

type QueryName =
  | "database:getTask"
  | "database:listTasks"
  | "database:listQueuedTaskIds"
  | "database:listRuntimeTargets"
  | "database:getTaskInWorkspace"
  | "database:getApproval"
  | "database:listApprovals"
  | "database:listPendingApprovals"
  | "database:getApprovalInWorkspace"
  | "database:listAccessPolicies"
  | "database:listCredentials"
  | "database:resolveCredential"
  | "database:listToolSources"
  | "database:listTaskEvents";

export class ExecutorDatabase {
  private readonly client: ConvexHttpClient;

  constructor(convexUrl = Bun.env.EXECUTOR_CONVEX_URL ?? Bun.env.CONVEX_URL ?? DEFAULT_CONVEX_URL) {
    this.client = new ConvexHttpClient(convexUrl);
  }

  // The `as never` casts below are intentional. ConvexHttpClient.mutation() and
  // .query() expect the exact generated function reference type and its
  // corresponding args type. Because we call them dynamically with string
  // function names (e.g. "database:createTask") and generic arg objects,
  // TypeScript cannot verify the relationship between name and args at the
  // call site. Properly typing this would require a discriminated-union
  // overload map for every Convex function, which adds significant
  // complexity for little safety gain — the real type safety lives in the
  // public method signatures of this class and the Convex handler
  // definitions themselves.
  private async mutation<TArgs extends Record<string, unknown>, TResult>(
    name: MutationName,
    args: TArgs,
  ): Promise<TResult> {
    return (await this.client.mutation(name as never, args as never)) as TResult;
  }

  private async query<TArgs extends Record<string, unknown>, TResult>(
    name: QueryName,
    args: TArgs,
  ): Promise<TResult> {
    return (await this.client.query(name as never, args as never)) as TResult;
  }

  async createTask(params: {
    id: string;
    code: string;
    runtimeId: string;
    timeoutMs?: number;
    metadata?: Record<string, unknown>;
    workspaceId: string;
    actorId: string;
    clientId?: string;
  }): Promise<TaskRecord> {
    return await this.mutation("database:createTask", params);
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return await this.query("database:getTask", { taskId });
  }

  async listTasks(workspaceId: string): Promise<TaskRecord[]> {
    return await this.query("database:listTasks", { workspaceId });
  }

  async listQueuedTaskIds(limit = 20): Promise<string[]> {
    return await this.query("database:listQueuedTaskIds", { limit });
  }

  async listRuntimeTargets(): Promise<Array<{ id: string; label: string; description: string }>> {
    return await this.query("database:listRuntimeTargets", {});
  }

  async getTaskInWorkspace(taskId: string, workspaceId: string): Promise<TaskRecord | null> {
    return await this.query("database:getTaskInWorkspace", { taskId, workspaceId });
  }

  async markTaskRunning(taskId: string): Promise<TaskRecord | null> {
    return await this.mutation("database:markTaskRunning", { taskId });
  }

  async markTaskFinished(params: {
    taskId: string;
    status: Extract<TaskStatus, "completed" | "failed" | "timed_out" | "denied">;
    stdout: string;
    stderr: string;
    exitCode?: number;
    error?: string;
  }): Promise<TaskRecord | null> {
    return await this.mutation("database:markTaskFinished", params);
  }

  async createApproval(params: {
    id: string;
    taskId: string;
    toolPath: string;
    input: unknown;
  }): Promise<ApprovalRecord> {
    return await this.mutation("database:createApproval", params);
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | null> {
    return await this.query("database:getApproval", { approvalId });
  }

  async listApprovals(workspaceId: string, status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    return await this.query("database:listApprovals", { workspaceId, status });
  }

  async listPendingApprovals(workspaceId: string): Promise<PendingApprovalRecord[]> {
    return await this.query("database:listPendingApprovals", { workspaceId });
  }

  async resolveApproval(params: {
    approvalId: string;
    decision: Exclude<ApprovalStatus, "pending">;
    reviewerId?: string;
    reason?: string;
  }): Promise<ApprovalRecord | null> {
    return await this.mutation("database:resolveApproval", params);
  }

  async getApprovalInWorkspace(approvalId: string, workspaceId: string): Promise<ApprovalRecord | null> {
    return await this.query("database:getApprovalInWorkspace", { approvalId, workspaceId });
  }

  async bootstrapAnonymousSession(sessionId?: string): Promise<AnonymousContext> {
    return await this.mutation("database:bootstrapAnonymousSession", { sessionId });
  }

  async upsertAccessPolicy(params: {
    id?: string;
    workspaceId: string;
    actorId?: string;
    clientId?: string;
    toolPathPattern: string;
    decision: PolicyDecision;
    priority?: number;
  }): Promise<AccessPolicyRecord> {
    return await this.mutation("database:upsertAccessPolicy", params);
  }

  async listAccessPolicies(workspaceId: string): Promise<AccessPolicyRecord[]> {
    return await this.query("database:listAccessPolicies", { workspaceId });
  }

  async upsertCredential(params: {
    id?: string;
    workspaceId: string;
    sourceKey: string;
    scope: CredentialScope;
    actorId?: string;
    secretJson: Record<string, unknown>;
  }): Promise<CredentialRecord> {
    return await this.mutation("database:upsertCredential", params);
  }

  async listCredentials(workspaceId: string): Promise<CredentialRecord[]> {
    return await this.query("database:listCredentials", { workspaceId });
  }

  async resolveCredential(params: {
    workspaceId: string;
    sourceKey: string;
    scope: CredentialScope;
    actorId?: string;
  }): Promise<CredentialRecord | null> {
    return await this.query("database:resolveCredential", params);
  }

  async upsertToolSource(params: {
    id?: string;
    workspaceId: string;
    name: string;
    type: ToolSourceRecord["type"];
    config: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<ToolSourceRecord> {
    return await this.mutation("database:upsertToolSource", params);
  }

  async listToolSources(workspaceId: string): Promise<ToolSourceRecord[]> {
    return await this.query("database:listToolSources", { workspaceId });
  }

  async deleteToolSource(workspaceId: string, sourceId: string): Promise<boolean> {
    return await this.mutation("database:deleteToolSource", { workspaceId, sourceId });
  }

  async createTaskEvent(input: {
    taskId: string;
    eventName: TaskEventRecord["eventName"];
    type: string;
    payload: Record<string, unknown>;
  }): Promise<TaskEventRecord> {
    return await this.mutation("database:createTaskEvent", input);
  }

  async listTaskEvents(taskId: string): Promise<TaskEventRecord[]> {
    return await this.query("database:listTaskEvents", { taskId });
  }
}
