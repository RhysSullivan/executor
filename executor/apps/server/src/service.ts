import { ExecutorDatabase } from "./database";
import { TaskEventHub, type LiveTaskEvent } from "./events";
import { InProcessExecutionAdapter } from "./adapters/in-process-execution-adapter";
import { APPROVAL_DENIED_PREFIX } from "./execution-constants";
import { createDiscoverTool } from "./tool-discovery";
import type { ExternalToolSourceConfig } from "./tool-sources";
import { loadExternalTools, parseGraphqlOperationPaths } from "./tool-sources";
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
  ToolSourceRecord,
  RuntimeOutputEvent,
  PolicyDecision,
  ResolvedToolCredential,
  CredentialRecord,
  ToolRunContext,
} from "./types";
import { asPayload, describeError } from "./utils";

function createTaskId(): string {
  return `task_${crypto.randomUUID()}`;
}

function createApprovalId(): string {
  return `approval_${crypto.randomUUID()}`;
}

// NOTE: Duplicated in convex/database.ts — these must be kept in sync.
// They can't share code because Convex functions run in a separate environment.
function matchesToolPath(pattern: string, toolPath: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolPath);
}

// NOTE: Duplicated in convex/database.ts — these must be kept in sync.
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
  type: ToolSourceRecord["type"];
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

    if (
      merged.transport !== undefined &&
      merged.transport !== "sse" &&
      merged.transport !== "streamable-http"
    ) {
      throw new Error(`MCP source '${raw.name}' has invalid transport (expected 'sse' or 'streamable-http')`);
    }

    if (merged.queryParams !== undefined) {
      const queryParams = merged.queryParams;
      if (!queryParams || typeof queryParams !== "object" || Array.isArray(queryParams)) {
        throw new Error(`MCP source '${raw.name}' queryParams must be an object`);
      }

      for (const [key, value] of Object.entries(queryParams as Record<string, unknown>)) {
        if (typeof key !== "string" || key.trim().length === 0) {
          throw new Error(`MCP source '${raw.name}' queryParams contains an invalid key`);
        }
        if (typeof value !== "string") {
          throw new Error(`MCP source '${raw.name}' queryParams values must be strings`);
        }
      }
    }

    return merged as unknown as ExternalToolSourceConfig;
  }

  if (raw.type === "graphql") {
    if (typeof merged.endpoint !== "string" || merged.endpoint.trim().length === 0) {
      throw new Error(`GraphQL source '${raw.name}' missing endpoint`);
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
  private readonly autoExecuteTasks: boolean;

  constructor(
    db: ExecutorDatabase,
    hub: TaskEventHub,
    runtimes: SandboxRuntime[],
    tools: ToolDefinition[],
    options?: { autoExecuteTasks?: boolean },
  ) {
    this.db = db;
    this.hub = hub;
    this.autoExecuteTasks = options?.autoExecuteTasks ?? true;
    for (const runtime of runtimes) {
      this.runtimes.set(runtime.id, runtime);
    }
    for (const tool of tools) {
      this.baseTools.set(tool.path, tool);
    }
  }

  async listTasks(workspaceId: string): Promise<TaskRecord[]> {
    return await this.db.listTasks(workspaceId);
  }

  async listQueuedTaskIds(limit = 20): Promise<string[]> {
    return await this.db.listQueuedTaskIds(limit);
  }

  async runTask(taskId: string): Promise<void> {
    await this.executeTask(taskId);
  }

  async getTask(taskId: string, workspaceId?: string): Promise<TaskRecord | null> {
    if (workspaceId) {
      return await this.db.getTaskInWorkspace(taskId, workspaceId);
    }
    return await this.db.getTask(taskId);
  }

  async listTaskEvents(taskId: string): Promise<TaskEventRecord[]> {
    return await this.db.listTaskEvents(taskId);
  }

  subscribe(taskId: string, listener: (event: LiveTaskEvent) => void): () => void {
    return this.hub.subscribe(taskId, listener);
  }

  async listApprovals(workspaceId: string, status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    return await this.db.listApprovals(workspaceId, status);
  }

  async upsertAccessPolicy(input: {
    id?: string;
    workspaceId: string;
    actorId?: string;
    clientId?: string;
    toolPathPattern: string;
    decision: PolicyDecision;
    priority?: number;
  }): Promise<AccessPolicyRecord> {
    return await this.db.upsertAccessPolicy(input);
  }

  async listAccessPolicies(workspaceId: string): Promise<AccessPolicyRecord[]> {
    return await this.db.listAccessPolicies(workspaceId);
  }

  async upsertCredential(input: {
    id?: string;
    workspaceId: string;
    sourceKey: string;
    scope: CredentialScope;
    actorId?: string;
    secretJson: Record<string, unknown>;
  }): Promise<CredentialRecord> {
    return await this.db.upsertCredential(input);
  }

  async listCredentials(
    workspaceId: string,
  ): Promise<Array<Omit<CredentialRecord, "secretJson"> & { hasSecret: boolean }>> {
    return (await this.db.listCredentials(workspaceId)).map((credential) => ({
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

  async listToolSources(workspaceId: string): Promise<ToolSourceRecord[]> {
    return await this.db.listToolSources(workspaceId);
  }

  async upsertToolSource(input: {
    id?: string;
    workspaceId: string;
    name: string;
    type: ToolSourceRecord["type"];
    config: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<ToolSourceRecord & { warnings?: string[] }> {
    const source = await this.db.upsertToolSource(input);
    this.workspaceToolCache.delete(source.workspaceId);
    await this.getWorkspaceTools(source.workspaceId);
    const warnings = this.workspaceToolLoadWarnings.get(source.workspaceId) ?? [];
    return { ...source, warnings };
  }

  async deleteToolSource(workspaceId: string, sourceId: string): Promise<boolean> {
    const deleted = await this.db.deleteToolSource(workspaceId, sourceId);
    if (deleted) {
      this.workspaceToolCache.delete(workspaceId);
      await this.getWorkspaceTools(workspaceId);
    }
    return deleted;
  }

  async listPendingApprovals(workspaceId: string): Promise<PendingApprovalRecord[]> {
    return await this.db.listPendingApprovals(workspaceId);
  }

  async bootstrapAnonymousContext(sessionId?: string): Promise<AnonymousContext> {
    return await this.db.bootstrapAnonymousSession(sessionId);
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

    const policies = await this.db.listAccessPolicies(context.workspaceId);
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
    return this.baseTools.size;
  }

  async createTask(input: CreateTaskInput): Promise<{ task: TaskRecord }> {
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

    const task = await this.db.createTask({
      id: createTaskId(),
      code: input.code,
      runtimeId,
      timeoutMs: input.timeoutMs,
      metadata: input.metadata,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      clientId: input.clientId,
    });

    await this.publish(task.id, "task", "task.created", {
      taskId: task.id,
      status: task.status,
      runtimeId: task.runtimeId,
      timeoutMs: task.timeoutMs,
      workspaceId: task.workspaceId,
      actorId: task.actorId,
      clientId: task.clientId,
      createdAt: task.createdAt,
    });

    await this.publish(task.id, "task", "task.queued", {
      taskId: task.id,
      status: "queued",
    });

    if (this.autoExecuteTasks) {
      void this.executeTask(task.id);
    }
    return { task };
  }

  async resolveApproval(
    workspaceId: string,
    approvalId: string,
    decision: "approved" | "denied",
    reviewerId?: string,
    reason?: string,
  ): Promise<{ approval: ApprovalRecord; task: TaskRecord } | null> {
    const scopedApproval = await this.db.getApprovalInWorkspace(approvalId, workspaceId);
    if (!scopedApproval || scopedApproval.status !== "pending") {
      return null;
    }

    const approval = await this.db.resolveApproval({
      approvalId,
      decision,
      reviewerId,
      reason,
    });

    if (!approval) {
      return null;
    }

    await this.publish(approval.taskId, "approval", "approval.resolved", {
      approvalId: approval.id,
      taskId: approval.taskId,
      toolPath: approval.toolPath,
      decision: approval.status,
      reviewerId: approval.reviewerId,
      reason: approval.reason,
      resolvedAt: approval.resolvedAt,
    });

    const task = await this.db.getTask(approval.taskId);
    if (!task) {
      throw new Error(`Task ${approval.taskId} missing while resolving approval`);
    }

    return { approval, task };
  }

  async handleExternalToolCall(call: ToolCallRequest): Promise<ToolCallResult> {
    const task = await this.db.getTask(call.runId);
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

  async appendRuntimeOutput(event: RuntimeOutputEvent): Promise<void> {
    await this.publish(
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

  private async publish(
    taskId: string,
    eventName: TaskEventRecord["eventName"],
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event = await this.db.createTaskEvent({ taskId, eventName, type, payload });
    this.hub.publish(taskId, {
      id: event.id,
      eventName,
      payload,
      createdAt: event.createdAt,
    });
  }

  private async waitForApproval(approvalId: string): Promise<"approved" | "denied"> {
    while (true) {
      const approval = await this.db.getApproval(approvalId);
      if (!approval) {
        throw new Error(`Approval ${approvalId} not found`);
      }

      if (approval.status !== "pending") {
        return approval.status as "approved" | "denied";
      }

      await Bun.sleep(600);
    }
  }

  private async getWorkspaceTools(workspaceId: string): Promise<Map<string, ToolDefinition>> {
    const sources = (await this.db.listToolSources(workspaceId)).filter((source) => source.enabled);
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

  private getToolDecision(
    task: TaskRecord,
    tool: ToolDefinition,
    policies: AccessPolicyRecord[],
  ): PolicyDecision {
    return this.getDecisionForContext(
      tool,
      {
        workspaceId: task.workspaceId,
        actorId: task.actorId,
        clientId: task.clientId,
      },
      policies,
    );
  }

  private getDecisionForContext(
    tool: ToolDefinition,
    context: { workspaceId: string; actorId?: string; clientId?: string },
    policies: AccessPolicyRecord[],
  ): PolicyDecision {
    const defaultDecision: PolicyDecision = tool.approval === "required" ? "require_approval" : "allow";
    const candidates = policies
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
    policies: AccessPolicyRecord[],
  ): boolean {
    const tool = workspaceTools.get(toolPath);
    if (!tool) return false;
    return this.getToolDecision(task, tool, policies) !== "deny";
  }

  private async resolveCredentialHeaders(
    spec: ToolCredentialSpec,
    task: TaskRecord,
  ): Promise<ResolvedToolCredential | null> {
    const record = await this.db.resolveCredential({
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

  /**
   * For GraphQL tools with _graphqlSource, resolve the approval decision
   * by parsing the query and checking policies against each virtual field path
   * (e.g. linear.mutation.issueCreate, linear.query.issues).
   *
   * Returns the most restrictive decision across all field paths.
   */
  private getGraphqlDecision(
    task: TaskRecord,
    tool: ToolDefinition,
    input: unknown,
    workspaceTools: Map<string, ToolDefinition>,
    policies: AccessPolicyRecord[],
  ): { decision: PolicyDecision; effectivePaths: string[] } {
    const sourceName = tool._graphqlSource!;
    const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const queryString = typeof payload.query === "string" ? payload.query : "";

    if (!queryString.trim()) {
      // No query to parse — fall back to tool's own approval
      return { decision: this.getToolDecision(task, tool, policies), effectivePaths: [tool.path] };
    }

    const { fieldPaths } = parseGraphqlOperationPaths(sourceName, queryString);
    if (fieldPaths.length === 0) {
      return { decision: this.getToolDecision(task, tool, policies), effectivePaths: [tool.path] };
    }

    let worstDecision: PolicyDecision = "allow";

    for (const fieldPath of fieldPaths) {
      // Look up the pseudo-tool for this field path to get its default approval
      const pseudoTool = workspaceTools.get(fieldPath);
      const fieldDecision = pseudoTool
        ? this.getDecisionForContext(pseudoTool, {
            workspaceId: task.workspaceId,
            actorId: task.actorId,
            clientId: task.clientId,
          }, policies)
        : // Unknown field — check if any policies match, otherwise default to mutation=required
          this.getDecisionForContext(
            { ...tool, path: fieldPath, approval: fieldPath.includes(".mutation.") ? "required" : "auto" },
            {
              workspaceId: task.workspaceId,
              actorId: task.actorId,
              clientId: task.clientId,
            },
            policies,
          );

      // Escalate: deny > require_approval > allow
      if (fieldDecision === "deny") {
        worstDecision = "deny";
        break; // Can't get worse
      }
      if (fieldDecision === "require_approval") {
        worstDecision = "require_approval";
      }
    }

    return { decision: worstDecision, effectivePaths: fieldPaths };
  }

  private async invokeTool(task: TaskRecord, call: ToolCallRequest): Promise<unknown> {
    const { toolPath, input, callId } = call;
    const workspaceTools = await this.getWorkspaceTools(task.workspaceId);
    const policies = await this.db.listAccessPolicies(task.workspaceId);
    const tool = workspaceTools.get(toolPath);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolPath}`);
    }

    // Determine approval decision — for GraphQL tools, parse the query for granular paths
    let decision: PolicyDecision;
    let effectiveToolPath = toolPath;

    if (tool._graphqlSource) {
      const result = this.getGraphqlDecision(task, tool, input, workspaceTools, policies);
      decision = result.decision;
      // Use the field paths for event reporting so approvals show what's actually being called
      if (result.effectivePaths.length > 0) {
        effectiveToolPath = result.effectivePaths.join(", ");
      }
    } else {
      decision = this.getToolDecision(task, tool, policies);
    }

    if (decision === "deny") {
      await this.publish(task.id, "task", "tool.call.denied", {
        taskId: task.id,
        callId,
        toolPath: effectiveToolPath,
        reason: "policy_deny",
      });
      throw new Error(`${APPROVAL_DENIED_PREFIX}${effectiveToolPath} (policy denied)`);
    }

    let credential: ResolvedToolCredential | undefined;
    if (tool.credential) {
      const resolved = await this.resolveCredentialHeaders(tool.credential, task);
      if (!resolved) {
        throw new Error(
          `Missing credential for source '${tool.credential.sourceKey}' (${tool.credential.mode} scope)`,
        );
      }
      credential = resolved;
    }

    await this.publish(task.id, "task", "tool.call.started", {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
      approval: decision === "require_approval" ? "required" : "auto",
      input: asPayload(input),
    });

    if (decision === "require_approval") {
      const approval = await this.db.createApproval({
        id: createApprovalId(),
        taskId: task.id,
        toolPath: effectiveToolPath,
        input,
      });

      await this.publish(task.id, "approval", "approval.requested", {
        approvalId: approval.id,
        taskId: task.id,
        callId,
        toolPath: approval.toolPath,
        input: asPayload(approval.input),
        createdAt: approval.createdAt,
      });

      const approvalDecision = await this.waitForApproval(approval.id);
      if (approvalDecision === "denied") {
        await this.publish(task.id, "task", "tool.call.denied", {
          taskId: task.id,
          callId,
          toolPath: effectiveToolPath,
          approvalId: approval.id,
        });
        throw new Error(`${APPROVAL_DENIED_PREFIX}${effectiveToolPath} (${approval.id})`);
      }
    }

    try {
      const context: ToolRunContext = {
        taskId: task.id,
        workspaceId: task.workspaceId,
        actorId: task.actorId,
        clientId: task.clientId,
        credential,
        isToolAllowed: (path) => this.isToolAllowedForTask(task, path, workspaceTools, policies),
      };
      const value = await tool.run(input, context);
      await this.publish(task.id, "task", "tool.call.completed", {
        taskId: task.id,
        callId,
        toolPath: effectiveToolPath,
        output: asPayload(value),
      });
      return value;
    } catch (error) {
      const message = describeError(error);
      await this.publish(task.id, "task", "tool.call.failed", {
        taskId: task.id,
        callId,
        toolPath: effectiveToolPath,
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
      const task = await this.db.getTask(taskId);
      if (!task || task.status !== "queued") {
        return;
      }

      const runtime = this.runtimes.get(task.runtimeId);
      if (!runtime) {
        const failed = await this.db.markTaskFinished({
          taskId,
          status: "failed",
          stdout: "",
          stderr: "",
          error: `Runtime not found: ${task.runtimeId}`,
        });

        if (failed) {
          await this.publish(taskId, "task", "task.failed", {
            taskId,
            status: failed.status,
            error: failed.error,
          });
        }
        return;
      }

      const running = await this.db.markTaskRunning(taskId);
      if (!running) {
        return;
      }

      await this.publish(taskId, "task", "task.running", {
        taskId,
        status: running.status,
        startedAt: running.startedAt,
      });

      const adapter = new InProcessExecutionAdapter({
        runId: taskId,
        invokeTool: async (call) => await this.invokeTool(running, call),
        emitOutput: async (event) => {
          await this.appendRuntimeOutput(event);
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

      const finished = await this.db.markTaskFinished({
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

      await this.publish(taskId, "task", terminalEvent, {
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
      const finished = await this.db.markTaskFinished({
        taskId,
        status: denied ? "denied" : "failed",
        stdout: "",
        stderr: "",
        error: denied ? message.replace(APPROVAL_DENIED_PREFIX, "") : message,
      });

      if (finished) {
        await this.publish(taskId, "task", denied ? "task.denied" : "task.failed", {
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
