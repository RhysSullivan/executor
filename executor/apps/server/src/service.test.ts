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
  private readonly policies = new Map<string, AccessPolicyRecord>();

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

  async listAccessPolicies(_workspaceId: string): Promise<AccessPolicyRecord[]> {
    return [...this.policies.values()]
      .filter((policy) => policy.workspaceId === _workspaceId)
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt - b.createdAt;
      });
  }

  async upsertAccessPolicy(params: {
    id?: string;
    workspaceId: string;
    actorId?: string;
    clientId?: string;
    toolPathPattern: string;
    decision: "allow" | "require_approval" | "deny";
    priority?: number;
  }): Promise<AccessPolicyRecord> {
    const now = Date.now();
    const id = params.id ?? `policy_${crypto.randomUUID()}`;
    const existing = this.policies.get(id);

    const record: AccessPolicyRecord = {
      id,
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      clientId: params.clientId,
      toolPathPattern: params.toolPathPattern,
      decision: params.decision,
      priority: params.priority ?? 100,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.policies.set(id, record);
    return record;
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

  constructor(
    private readonly toolPath = "admin.delete_data",
    private readonly input: unknown = { key: "abc" },
  ) {}

  async run(
    request: SandboxExecutionRequest,
    adapter: ExecutionAdapter,
  ): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const result = await adapter.invokeTool({
      runId: request.taskId,
      callId: "call_inline_1",
      toolPath: this.toolPath,
      input: this.input,
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

async function waitForTaskStatus(
  service: ExecutorService,
  taskId: string,
  expected: TaskRecord["status"],
  timeoutMs = 2_000,
): Promise<TaskRecord | null> {
  let task = await service.getTask(taskId);
  const waitUntil = Date.now() + timeoutMs;
  while (task?.status !== expected && Date.now() < waitUntil) {
    await Bun.sleep(25);
    task = await service.getTask(taskId);
  }
  return task;
}

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

  const task = await waitForTaskStatus(service, created.task.id, "completed");

  expect(task?.status).toBe("completed");
  expect((await service.listApprovals("ws_test", "approved")).length).toBe(1);
});

test("policy deny blocks tool call without creating approval", async () => {
  const service = new ExecutorService(
    new TestExecutorDatabase(),
    new TaskEventHub(),
    [new InlineToolRuntime()],
    tools,
  );

  await service.upsertAccessPolicy({
    workspaceId: "ws_deny",
    toolPathPattern: "admin.delete_data",
    decision: "deny",
    priority: 500,
  });

  const created = await service.createTask({
    code: "unused",
    runtimeId: "inline",
    workspaceId: "ws_deny",
    actorId: "actor_test",
  });

  const task = await waitForTaskStatus(service, created.task.id, "denied");
  expect(task?.status).toBe("denied");
  expect((await service.listPendingApprovals("ws_deny")).length).toBe(0);
});

test("unknown tool path fails task execution", async () => {
  const service = new ExecutorService(
    new TestExecutorDatabase(),
    new TaskEventHub(),
    [new InlineToolRuntime("admin.missing_tool")],
    tools,
  );

  const created = await service.createTask({
    code: "unused",
    runtimeId: "inline",
    workspaceId: "ws_unknown",
    actorId: "actor_test",
  });

  const task = await waitForTaskStatus(service, created.task.id, "failed");
  expect(task?.status).toBe("failed");
  expect(task?.error).toContain("Unknown tool");
});
