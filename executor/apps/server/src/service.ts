import { ExecutorDatabase } from "./database";
import { TaskEventHub, type LiveTaskEvent } from "./events";
import { InProcessExecutionAdapter } from "./adapters/in-process-execution-adapter";
import { APPROVAL_DENIED_PREFIX } from "./execution-constants";
import { createDiscoverTool } from "./tool-discovery";
import type { ExternalToolSourceConfig } from "./tool-sources";
import { loadExternalTools } from "./tool-sources";
import type {
  AccessPolicyRecord,
  AnonymousContext,
  ApprovalRecord,
  ApprovalStatus,
  CredentialScope,
  CreateTaskInput,
  PendingApprovalRecord,
  SandboxRuntime,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
  ToolCredentialSpec,
  ToolCallResult,
  ToolCallRequest,
  ToolDefinition,
  ToolDescriptor,
  RuntimeOutputEvent,
  PolicyDecision,
  ResolvedToolCredential,
  CredentialRecord,
  ToolRunContext,
} from "./types";

interface ApprovalWaiter {
  resolve: (decision: Exclude<ApprovalStatus, "pending">) => void;
}

function createTaskId(): string {
  return `task_${crypto.randomUUID()}`;
}

function createApprovalId(): string {
  return `approval_${crypto.randomUUID()}`;
}

function asPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return { value };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matchesToolPath(pattern: string, toolPath: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolPath);
}

function policySpecificity(policy: AccessPolicyRecord, actorId?: string, clientId?: string): number {
  let score = 0;
  if (policy.actorId && actorId && policy.actorId === actorId) score += 4;
  if (policy.clientId && clientId && policy.clientId === clientId) score += 2;
  score += Math.max(1, policy.toolPathPattern.replace(/\*/g, "").length);
  score += policy.priority;
  return score;
}

function sourceSignature(workspaceId: string, sources: Array<{ id: string; updatedAt: number; enabled: boolean }>): string {
  const parts = sources
    .map((source) => `${source.id}:${source.updatedAt}:${source.enabled ? 1 : 0}`)
    .sort();
  return `${workspaceId}|${parts.join(",")}`;
}

function normalizeExternalToolSource(raw: {
  type: "mcp" | "openapi";
  name: string;
  config: Record<string, unknown>;
}): ExternalToolSourceConfig {
  const merged = {
    type: raw.type,
    name: raw.name,
    ...raw.config,
  } as Record<string, unknown>;

  if (raw.type === "mcp") {
    if (typeof merged.url !== "string" || merged.url.trim().length === 0) {
      throw new Error(`MCP source '${raw.name}' missing url`);
    }
    return merged as unknown as ExternalToolSourceConfig;
  }

  const spec = merged.spec;
  if (typeof spec !== "string" && typeof spec !== "object") {
    throw new Error(`OpenAPI source '${raw.name}' missing spec`);
  }

  return merged as unknown as ExternalToolSourceConfig;
}

export class ExecutorService {
  private readonly db: ExecutorDatabase;
  private readonly hub: TaskEventHub;
  private readonly runtimes = new Map<string, SandboxRuntime>();
  private readonly baseTools = new Map<string, ToolDefinition>();
  private readonly workspaceToolCache = new Map<
    string,
    { signature: string; loadedAt: number; tools: Map<string, ToolDefinition> }
  >();
  private readonly workspaceToolLoadWarnings = new Map<string, string[]>();
  private readonly inFlightTaskIds = new Set<string>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();

  constructor(
    db: ExecutorDatabase,
    hub: TaskEventHub,
    runtimes: SandboxRuntime[],
    tools: ToolDefinition[],
  ) {
    this.db = db;
    this.hub = hub;
    for (const runtime of runtimes) {
      this.runtimes.set(runtime.id, runtime);
    }
    for (const tool of tools) {
      this.baseTools.set(tool.path, tool);
    }
  }

  listTasks(workspaceId: string): TaskRecord[] {
    return this.db.listTasks(workspaceId);
  }

  getTask(taskId: string, workspaceId?: string): TaskRecord | null {
    if (workspaceId) {
      return this.db.getTaskInWorkspace(taskId, workspaceId);
    }
    return this.db.getTask(taskId);
  }

  listTaskEvents(taskId: string): TaskEventRecord[] {
    return this.db.listTaskEvents(taskId);
  }

  subscribe(taskId: string, listener: (event: LiveTaskEvent) => void): () => void {
    return this.hub.subscribe(taskId, listener);
  }

  listApprovals(workspaceId: string, status?: ApprovalStatus): ApprovalRecord[] {
    return this.db.listApprovals(workspaceId, status);
  }

  upsertAccessPolicy(input: {
    id?: string;
    workspaceId: string;
    actorId?: string;
    clientId?: string;
    toolPathPattern: string;
    decision: PolicyDecision;
    priority?: number;
  }): AccessPolicyRecord {
    return this.db.upsertAccessPolicy(input);
  }

  listAccessPolicies(workspaceId: string): AccessPolicyRecord[] {
    return this.db.listAccessPolicies(workspaceId);
  }

  upsertCredential(input: {
    id?: string;
    workspaceId: string;
    sourceKey: string;
    scope: CredentialScope;
    actorId?: string;
    secretJson: Record<string, unknown>;
  }): CredentialRecord {
    return this.db.upsertCredential(input);
  }

  listCredentials(workspaceId: string): Array<Omit<CredentialRecord, "secretJson"> & { hasSecret: boolean }> {
    return this.db.listCredentials(workspaceId).map((credential) => ({
      id: credential.id,
      workspaceId: credential.workspaceId,
      sourceKey: credential.sourceKey,
      scope: credential.scope,
      actorId: credential.actorId,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
      hasSecret: Object.keys(credential.secretJson).length > 0,
    }));
  }

  listToolSources(workspaceId: string): Array<{
    id: string;
    workspaceId: string;
    name: string;
    type: "mcp" | "openapi";
    enabled: boolean;
    config: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
  }> {
    return this.db.listToolSources(workspaceId);
  }

  async upsertToolSource(input: {
    id?: string;
    workspaceId: string;
    name: string;
    type: "mcp" | "openapi";
    config: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<{
    id: string;
    workspaceId: string;
    name: string;
    type: "mcp" | "openapi";
    enabled: boolean;
    config: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
  }> {
    const source = this.db.upsertToolSource(input);
    this.workspaceToolCache.delete(source.workspaceId);
    await this.getWorkspaceTools(source.workspaceId);
    const warnings = this.workspaceToolLoadWarnings.get(source.workspaceId) ?? [];
    return { ...source, warnings };
  }

  async deleteToolSource(workspaceId: string, sourceId: string): Promise<boolean> {
    const deleted = this.db.deleteToolSource(workspaceId, sourceId);
    if (deleted) {
      this.workspaceToolCache.delete(workspaceId);
      await this.getWorkspaceTools(workspaceId);
    }
    return deleted;
  }

  listPendingApprovals(workspaceId: string): PendingApprovalRecord[] {
    return this.db.listPendingApprovals(workspaceId);
  }

  bootstrapAnonymousContext(sessionId?: string): AnonymousContext {
    return this.db.bootstrapAnonymousSession(sessionId);
  }

  async listTools(context?: {
    workspaceId: string;
    actorId?: string;
    clientId?: string;
  }): Promise<ToolDescriptor[]> {
    const all = context
      ? [...(await this.getWorkspaceTools(context.workspaceId)).values()]
      : [...this.baseTools.values()];

    if (!context) {
      return all.map((tool) => ({
        path: tool.path,
        description: tool.description,
        approval: tool.approval,
        source: tool.source,
        argsType: tool.metadata?.argsType,
        returnsType: tool.metadata?.returnsType,
      }));
    }

    const policies = this.db.listAccessPolicies(context.workspaceId);
    return all
      .filter((tool) => {
        const decision = this.getDecisionForContext(tool, context, policies);
        return decision !== "deny";
      })
      .map((tool) => {
        const decision = this.getDecisionForContext(tool, context, policies);
        return {
          path: tool.path,
          description: tool.description,
          approval: decision === "require_approval" ? "required" : "auto",
          source: tool.source,
          argsType: tool.metadata?.argsType,
          returnsType: tool.metadata?.returnsType,
        };
      });
  }

  listRuntimes(): Array<{ id: string; label: string; description: string }> {
    return [...this.runtimes.values()].map((runtime) => ({
      id: runtime.id,
      label: runtime.label,
      description: runtime.description,
    }));
  }

  getBaseToolCount(): number {
    return [...this.baseTools.keys()].filter((path) => path !== "discover").length + 1;
  }

  createTask(input: CreateTaskInput): { task: TaskRecord } {
    if (!input.code || input.code.trim().length === 0) {
      throw new Error("Task code is required");
    }

    if (!input.workspaceId || input.workspaceId.trim().length === 0) {
      throw new Error("workspaceId is required");
    }

    if (!input.actorId || input.actorId.trim().length === 0) {
      throw new Error("actorId is required");
    }

    const runtimeId = input.runtimeId ?? "local-bun";
    if (!this.runtimes.has(runtimeId)) {
      throw new Error(`Unknown runtime: ${runtimeId}`);
    }

    const task = this.db.createTask({
      id: createTaskId(),
      code: input.code,
      runtimeId,
      timeoutMs: input.timeoutMs,
      metadata: input.metadata,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      clientId: input.clientId,
    });

    this.publish(task.id, "task", "task.created", {
      taskId: task.id,
      status: task.status,
      runtimeId: task.runtimeId,
      timeoutMs: task.timeoutMs,
      workspaceId: task.workspaceId,
      actorId: task.actorId,
      clientId: task.clientId,
      createdAt: task.createdAt,
    });

    this.publish(task.id, "task", "task.queued", {
      taskId: task.id,
      status: "queued",
    });

    void this.executeTask(task.id);
    return { task };
  }

  resolveApproval(
    workspaceId: string,
    approvalId: string,
    decision: "approved" | "denied",
    reviewerId?: string,
    reason?: string,
  ): { approval: ApprovalRecord; task: TaskRecord } | null {
    const scopedApproval = this.db.getApprovalInWorkspace(approvalId, workspaceId);
    if (!scopedApproval || scopedApproval.status !== "pending") {
      return null;
    }

    const approval = this.db.resolveApproval({
      approvalId,
      decision,
      reviewerId,
      reason,
    });

    if (!approval) {
      return null;
    }

    this.publish(approval.taskId, "approval", "approval.resolved", {
      approvalId: approval.id,
      taskId: approval.taskId,
      toolPath: approval.toolPath,
      decision: approval.status,
      reviewerId: approval.reviewerId,
      reason: approval.reason,
      resolvedAt: approval.resolvedAt,
    });

    const waiter = this.approvalWaiters.get(approval.id);
    if (waiter) {
      this.approvalWaiters.delete(approval.id);
      waiter.resolve(approval.status as "approved" | "denied");
    }

    const task = this.db.getTask(approval.taskId);
    if (!task) {
      throw new Error(`Task ${approval.taskId} missing while resolving approval`);
    }

    return { approval, task };
  }

  async handleExternalToolCall(call: ToolCallRequest): Promise<ToolCallResult> {
    const task = this.db.getTask(call.runId);
    if (!task) {
      return {
        ok: false,
        error: `Run not found: ${call.runId}`,
      };
    }

    try {
      const value = await this.invokeTool(task, call);
      return { ok: true, value };
    } catch (error) {
      const message = describeError(error);
      if (message.startsWith(APPROVAL_DENIED_PREFIX)) {
        return {
          ok: false,
          denied: true,
          error: message.replace(APPROVAL_DENIED_PREFIX, "").trim(),
        };
      }

      return {
        ok: false,
        error: message,
      };
    }
  }

  appendRuntimeOutput(event: RuntimeOutputEvent): void {
    this.publish(
      event.runId,
      "task",
      event.stream === "stdout" ? "task.stdout" : "task.stderr",
      {
        taskId: event.runId,
        line: event.line,
        timestamp: event.timestamp,
      },
    );
  }

  private publish(
    taskId: string,
    eventName: TaskEventRecord["eventName"],
    type: string,
    payload: Record<string, unknown>,
  ): void {
    const event = this.db.createTaskEvent({ taskId, eventName, type, payload });
    this.hub.publish(taskId, {
      id: event.id,
      eventName,
      payload,
      createdAt: event.createdAt,
    });
  }

  private async waitForApproval(approvalId: string): Promise<"approved" | "denied"> {
    const approval = this.db.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId} not found`);
    }

    if (approval.status !== "pending") {
      return approval.status as "approved" | "denied";
    }

    return await new Promise<"approved" | "denied">((resolve) => {
      this.approvalWaiters.set(approvalId, { resolve });
    });
  }

  private async getWorkspaceTools(workspaceId: string): Promise<Map<string, ToolDefinition>> {
    const sources = this.db.listToolSources(workspaceId).filter((source) => source.enabled);
    const signature = sourceSignature(workspaceId, sources);
    const cached = this.workspaceToolCache.get(workspaceId);
    if (cached && cached.signature === signature) {
      return cached.tools;
    }

    const configs: ExternalToolSourceConfig[] = [];
    const warnings: string[] = [];
    for (const source of sources) {
      try {
        configs.push(normalizeExternalToolSource(source));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Source '${source.name}': ${message}`);
        console.warn(`[executor] skipping invalid source ${source.id}: ${message}`);
      }
    }

    const { tools: externalTools, warnings: loadWarnings } = await loadExternalTools(configs);
    warnings.push(...loadWarnings);
    this.workspaceToolLoadWarnings.set(workspaceId, warnings);

    const merged = new Map<string, ToolDefinition>();
    for (const tool of this.baseTools.values()) {
      if (tool.path === "discover") continue;
      merged.set(tool.path, tool);
    }
    for (const tool of externalTools) {
      merged.set(tool.path, tool);
    }

    const discover = createDiscoverTool([...merged.values()]);
    merged.set(discover.path, discover);

    this.workspaceToolCache.set(workspaceId, {
      signature,
      loadedAt: Date.now(),
      tools: merged,
    });
    return merged;
  }

  private getToolDecision(task: TaskRecord, tool: ToolDefinition): PolicyDecision {
    return this.getDecisionForContext(
      tool,
      {
        workspaceId: task.workspaceId,
        actorId: task.actorId,
        clientId: task.clientId,
      },
      this.db.listAccessPolicies(task.workspaceId),
    );
  }

  private getDecisionForContext(
    tool: ToolDefinition,
    context: { workspaceId: string; actorId?: string; clientId?: string },
    policies?: AccessPolicyRecord[],
  ): PolicyDecision {
    const defaultDecision: PolicyDecision = tool.approval === "required" ? "require_approval" : "allow";
    const scopedPolicies = policies ?? this.db.listAccessPolicies(context.workspaceId);
    const candidates = scopedPolicies
      .filter((policy) => {
        if (policy.actorId && policy.actorId !== context.actorId) return false;
        if (policy.clientId && policy.clientId !== context.clientId) return false;
        return matchesToolPath(policy.toolPathPattern, tool.path);
      })
      .sort(
        (a, b) =>
          policySpecificity(b, context.actorId, context.clientId) -
          policySpecificity(a, context.actorId, context.clientId),
      );

    return candidates[0]?.decision ?? defaultDecision;
  }

  private isToolAllowedForTask(
    task: TaskRecord,
    toolPath: string,
    workspaceTools: Map<string, ToolDefinition>,
  ): boolean {
    const tool = workspaceTools.get(toolPath);
    if (!tool) return false;
    return this.getToolDecision(task, tool) !== "deny";
  }

  private resolveCredentialHeaders(
    spec: ToolCredentialSpec,
    task: TaskRecord,
  ): ResolvedToolCredential | null {
    const record = this.db.resolveCredential({
      workspaceId: task.workspaceId,
      sourceKey: spec.sourceKey,
      scope: spec.mode,
      actorId: task.actorId,
    });

    const source = record?.secretJson ?? spec.staticSecretJson ?? null;
    if (!source) {
      return null;
    }

    const headers: Record<string, string> = {};
    if (spec.authType === "bearer") {
      const token = String((source as Record<string, unknown>).token ?? "").trim();
      if (token) headers.authorization = `Bearer ${token}`;
    } else if (spec.authType === "apiKey") {
      const headerName = spec.headerName ?? String((source as Record<string, unknown>).headerName ?? "x-api-key");
      const value = String((source as Record<string, unknown>).value ?? (source as Record<string, unknown>).token ?? "").trim();
      if (value) headers[headerName] = value;
    } else if (spec.authType === "basic") {
      const username = String((source as Record<string, unknown>).username ?? "");
      const password = String((source as Record<string, unknown>).password ?? "");
      if (username || password) {
        const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
        headers.authorization = `Basic ${encoded}`;
      }
    }

    if (Object.keys(headers).length === 0) {
      return null;
    }

    return {
      sourceKey: spec.sourceKey,
      mode: spec.mode,
      headers,
    };
  }

  private async invokeTool(task: TaskRecord, call: ToolCallRequest): Promise<unknown> {
    const { toolPath, input, callId } = call;
    const workspaceTools = await this.getWorkspaceTools(task.workspaceId);
    const tool = workspaceTools.get(toolPath);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolPath}`);
    }

    const decision = this.getToolDecision(task, tool);
    if (decision === "deny") {
      this.publish(task.id, "task", "tool.call.denied", {
        taskId: task.id,
        callId,
        toolPath,
        reason: "policy_deny",
      });
      throw new Error(`${APPROVAL_DENIED_PREFIX}${toolPath} (policy denied)`);
    }

    let credential: ResolvedToolCredential | undefined;
    if (tool.credential) {
      const resolved = this.resolveCredentialHeaders(tool.credential, task);
      if (!resolved) {
        throw new Error(
          `Missing credential for source '${tool.credential.sourceKey}' (${tool.credential.mode} scope)`,
        );
      }
      credential = resolved;
    }

    this.publish(task.id, "task", "tool.call.started", {
      taskId: task.id,
      callId,
      toolPath,
      approval: decision === "require_approval" ? "required" : "auto",
      input: asPayload(input),
    });

    if (decision === "require_approval") {
      const approval = this.db.createApproval({
        id: createApprovalId(),
        taskId: task.id,
        toolPath,
        input,
      });

      this.publish(task.id, "approval", "approval.requested", {
        approvalId: approval.id,
        taskId: task.id,
        callId,
        toolPath: approval.toolPath,
        input: asPayload(approval.input),
        createdAt: approval.createdAt,
      });

      const decision = await this.waitForApproval(approval.id);
      if (decision === "denied") {
        this.publish(task.id, "task", "tool.call.denied", {
          taskId: task.id,
          callId,
          toolPath,
          approvalId: approval.id,
        });
        throw new Error(`${APPROVAL_DENIED_PREFIX}${toolPath} (${approval.id})`);
      }
    }

    try {
      const context: ToolRunContext = {
        taskId: task.id,
        workspaceId: task.workspaceId,
        actorId: task.actorId,
        clientId: task.clientId,
        credential,
        isToolAllowed: (path) => this.isToolAllowedForTask(task, path, workspaceTools),
      };
      const value = await tool.run(input, context);
      this.publish(task.id, "task", "tool.call.completed", {
        taskId: task.id,
        callId,
        toolPath,
        output: asPayload(value),
      });
      return value;
    } catch (error) {
      const message = describeError(error);
      this.publish(task.id, "task", "tool.call.failed", {
        taskId: task.id,
        callId,
        toolPath,
        error: message,
      });
      throw error;
    }
  }

  private async executeTask(taskId: string): Promise<void> {
    if (this.inFlightTaskIds.has(taskId)) {
      return;
    }

    this.inFlightTaskIds.add(taskId);
    try {
      const task = this.db.getTask(taskId);
      if (!task || task.status !== "queued") {
        return;
      }

      const runtime = this.runtimes.get(task.runtimeId);
      if (!runtime) {
        const failed = this.db.markTaskFinished({
          taskId,
          status: "failed",
          stdout: "",
          stderr: "",
          error: `Runtime not found: ${task.runtimeId}`,
        });

        if (failed) {
          this.publish(taskId, "task", "task.failed", {
            taskId,
            status: failed.status,
            error: failed.error,
          });
        }
        return;
      }

      const running = this.db.markTaskRunning(taskId);
      if (!running) {
        return;
      }

      this.publish(taskId, "task", "task.running", {
        taskId,
        status: running.status,
        startedAt: running.startedAt,
      });

      const adapter = new InProcessExecutionAdapter({
        runId: taskId,
        invokeTool: async (call) => await this.invokeTool(running, call),
        emitOutput: (event) => {
          this.appendRuntimeOutput(event);
        },
      });

      const runtimeResult = await runtime.run(
        {
          taskId,
          code: running.code,
          timeoutMs: running.timeoutMs,
        },
        adapter,
      );

      const finished = this.db.markTaskFinished({
        taskId,
        status: runtimeResult.status,
        stdout: runtimeResult.stdout,
        stderr: runtimeResult.stderr,
        exitCode: runtimeResult.exitCode,
        error: runtimeResult.error,
      });

      if (!finished) {
        return;
      }

      const terminalEvent =
        runtimeResult.status === "completed"
          ? "task.completed"
          : runtimeResult.status === "timed_out"
            ? "task.timed_out"
            : runtimeResult.status === "denied"
              ? "task.denied"
              : "task.failed";

      this.publish(taskId, "task", terminalEvent, {
        taskId,
        status: finished.status,
        exitCode: finished.exitCode,
        durationMs: runtimeResult.durationMs,
        error: finished.error,
        completedAt: finished.completedAt,
      });
    } catch (error) {
      const message = describeError(error);
      const denied = message.startsWith(APPROVAL_DENIED_PREFIX);
      const finished = this.db.markTaskFinished({
        taskId,
        status: denied ? "denied" : "failed",
        stdout: "",
        stderr: "",
        error: denied ? message.replace(APPROVAL_DENIED_PREFIX, "") : message,
      });

      if (finished) {
        this.publish(taskId, "task", denied ? "task.denied" : "task.failed", {
          taskId,
          status: finished.status,
          error: finished.error,
          completedAt: finished.completedAt,
        });
      }
    } finally {
      this.inFlightTaskIds.delete(taskId);
    }
  }
}

export function getTaskTerminalState(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "denied";
}
