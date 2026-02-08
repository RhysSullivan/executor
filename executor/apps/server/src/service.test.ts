import { expect, test } from "bun:test";
import { ExecutorDatabase } from "./database";
import { TaskEventHub } from "./events";
import { ExecutorService } from "./service";
import type {
  AccessPolicyRecord,
  ApprovalRecord,
  ExecutionAdapter,
  PendingApprovalRecord,
  TaskEventRecord,
  TaskRecord,
  ToolDescriptor,
  ToolSourceRecord,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxRuntime,
  ToolDefinition,
} from "./types";

class TestExecutorDatabase extends ExecutorDatabase {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly events = new Map<string, TaskEventRecord[]>();

  constructor() {
    super("http://127.0.0.1:3210");
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
    const now = Date.now();
    const task: TaskRecord = {
      id: params.id,
      code: params.code,
      runtimeId: params.runtimeId,
      status: "queued",
      timeoutMs: params.timeoutMs ?? 15_000,
      metadata: params.metadata ?? {},
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      clientId: params.clientId,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async getTaskInWorkspace(taskId: string, workspaceId: string): Promise<TaskRecord | null> {
    const task = this.tasks.get(taskId);
    if (!task || task.workspaceId !== workspaceId) {
      return null;
    }
    return task;
  }

  async markTaskRunning(taskId: string): Promise<TaskRecord | null> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }

    const now = Date.now();
    const updated: TaskRecord = {
      ...task,
      status: "running",
      startedAt: task.startedAt ?? now,
      updatedAt: now,
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  async markTaskFinished(params: {
    taskId: string;
    status: "completed" | "failed" | "timed_out" | "denied";
    stdout: string;
    stderr: string;
    exitCode?: number;
    error?: string;
  }): Promise<TaskRecord | null> {
    const task = this.tasks.get(params.taskId);
    if (!task) {
      return null;
    }

    const now = Date.now();
    const updated: TaskRecord = {
      ...task,
      status: params.status,
      stdout: params.stdout,
      stderr: params.stderr,
      exitCode: params.exitCode,
      error: params.error,
      completedAt: now,
      updatedAt: now,
    };
    this.tasks.set(params.taskId, updated);
    return updated;
  }

  async createApproval(params: {
    id: string;
    taskId: string;
    toolPath: string;
    input: unknown;
  }): Promise<ApprovalRecord> {
    const approval: ApprovalRecord = {
      id: params.id,
      taskId: params.taskId,
      toolPath: params.toolPath,
      input: params.input,
      status: "pending",
      createdAt: Date.now(),
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | null> {
    return this.approvals.get(approvalId) ?? null;
  }

  async listPendingApprovals(workspaceId: string): Promise<PendingApprovalRecord[]> {
    const pending = [...this.approvals.values()].filter((approval) => approval.status === "pending");
    const inWorkspace = pending.filter((approval) => {
      const task = this.tasks.get(approval.taskId);
      return task?.workspaceId === workspaceId;
    });

    return inWorkspace.map((approval) => {
      const task = this.tasks.get(approval.taskId)!;
      return {
        ...approval,
        task: {
          id: task.id,
          status: task.status,
          runtimeId: task.runtimeId,
          timeoutMs: task.timeoutMs,
          createdAt: task.createdAt,
        },
      };
    });
  }

  async resolveApproval(params: {
    approvalId: string;
    decision: "approved" | "denied";
    reviewerId?: string;
    reason?: string;
  }): Promise<ApprovalRecord | null> {
    const approval = this.approvals.get(params.approvalId);
    if (!approval || approval.status !== "pending") {
      return null;
    }

    const updated: ApprovalRecord = {
      ...approval,
      status: params.decision,
      reviewerId: params.reviewerId,
      reason: params.reason,
      resolvedAt: Date.now(),
    };
    this.approvals.set(params.approvalId, updated);
    return updated;
  }

  async getApprovalInWorkspace(approvalId: string, workspaceId: string): Promise<ApprovalRecord | null> {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      return null;
    }

    const task = this.tasks.get(approval.taskId);
    if (!task || task.workspaceId !== workspaceId) {
      return null;
    }

    return approval;
  }

  async listApprovals(workspaceId: string, status?: "pending" | "approved" | "denied"): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()].filter((approval) => {
      const task = this.tasks.get(approval.taskId);
      if (!task || task.workspaceId !== workspaceId) {
        return false;
      }
      if (!status) {
        return true;
      }
      return approval.status === status;
    });
  }

  async listToolSources(_workspaceId: string): Promise<ToolSourceRecord[]> {
    return [];
  }

  async syncWorkspaceTools(): Promise<boolean> {
    return true;
  }

  async listWorkspaceToolsForContext(): Promise<ToolDescriptor[]> {
    return [];
  }

  async listAccessPolicies(_workspaceId: string): Promise<AccessPolicyRecord[]> {
    return [];
  }

  async resolveCredential(): Promise<null> {
    return null;
  }

  async createTaskEvent(input: {
    taskId: string;
    eventName: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<TaskEventRecord> {
    const existing = this.events.get(input.taskId) ?? [];
    const event: TaskEventRecord = {
      id: existing.length + 1,
      taskId: input.taskId,
      eventName: input.eventName,
      type: input.type,
      payload: input.payload,
      createdAt: Date.now(),
    };
    existing.push(event);
    this.events.set(input.taskId, existing);
    return event;
  }

  async listTaskEvents(taskId: string): Promise<TaskEventRecord[]> {
    return this.events.get(taskId) ?? [];
  }
}

class InlineToolRuntime implements SandboxRuntime {
  readonly id = "inline";
  readonly label = "Inline";
  readonly description = "Calls one tool then exits";

  async run(
    request: SandboxExecutionRequest,
    adapter: ExecutionAdapter,
  ): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const result = await adapter.invokeTool({
      runId: request.taskId,
      callId: "call_inline_1",
      toolPath: "admin.delete_data",
      input: { key: "abc" },
    });

    if (!result.ok) {
      return {
        status: result.denied ? "denied" : "failed",
        stdout: "",
        stderr: result.error,
        error: result.error,
        durationMs: Date.now() - startedAt,
      };
    }

    await adapter.emitOutput({
      runId: request.taskId,
      stream: "stdout",
      line: `tool_result:${JSON.stringify(result.value)}`,
      timestamp: Date.now(),
    });

    return {
      status: "completed",
      stdout: `task:${request.taskId}`,
      stderr: "",
      exitCode: 0,
      durationMs: Date.now() - startedAt,
    };
  }
}

const tools: ToolDefinition[] = [
  {
    path: "admin.delete_data",
    description: "Requires approval",
    approval: "required",
    run: async (input) => ({ deleted: true, input }),
  },
];

test("tool-level approval gates individual function call", async () => {
  const service = new ExecutorService(
    new TestExecutorDatabase(),
    new TaskEventHub(),
    [new InlineToolRuntime()],
    tools,
  );

  const created = await service.createTask({
    code: "unused",
    runtimeId: "inline",
    workspaceId: "ws_test",
    actorId: "actor_test",
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const approvals = await service.listPendingApprovals("ws_test");

  expect(approvals.length).toBe(1);
  expect(approvals[0]?.toolPath).toBe("admin.delete_data");

  const resolved = await service.resolveApproval("ws_test", approvals[0]!.id, "approved", "test-user");
  expect(resolved).toBeTruthy();

  let task = await service.getTask(created.task.id);
  const waitUntil = Date.now() + 2_000;
  while (task?.status !== "completed" && Date.now() < waitUntil) {
    await Bun.sleep(25);
    task = await service.getTask(created.task.id);
  }

  expect(task?.status).toBe("completed");
  expect((await service.listApprovals("ws_test", "approved")).length).toBe(1);
});
