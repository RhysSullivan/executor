import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { HandleRequestOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { generateToolDeclarations, generateToolInventory, typecheckCode } from "./typechecker";
import type { LiveTaskEvent } from "./events";
import type {
  AnonymousContext,
  CreateTaskInput,
  PendingApprovalRecord,
  TaskRecord,
  ToolDescriptor,
} from "./types";

function getTaskTerminalState(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "denied";
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

interface McpExecutorService {
  createTask(input: CreateTaskInput): Promise<{ task: TaskRecord }>;
  getTask(taskId: string, workspaceId?: string): Promise<TaskRecord | null>;
  subscribe(taskId: string, listener: (event: LiveTaskEvent) => void): () => void;
  bootstrapAnonymousContext(sessionId?: string): Promise<AnonymousContext>;
  listTools(context?: { workspaceId: string; actorId?: string; clientId?: string }): Promise<ToolDescriptor[]>;
  listPendingApprovals?(workspaceId: string): Promise<PendingApprovalRecord[]>;
  resolveApproval?(input: {
    workspaceId: string;
    approvalId: string;
    decision: "approved" | "denied";
    reviewerId?: string;
    reason?: string;
  }): Promise<unknown>;
}

interface ApprovalPromptDecision {
  decision: "approved" | "denied";
  reason?: string;
}

interface ApprovalPromptContext {
  workspaceId: string;
  actorId: string;
}

type ApprovalPrompt = (
  approval: PendingApprovalRecord,
  context: ApprovalPromptContext,
) => Promise<ApprovalPromptDecision | null>;

// ---------------------------------------------------------------------------
// Workspace context (optional, from query params)
// ---------------------------------------------------------------------------

export interface McpWorkspaceContext {
  workspaceId: string;
  actorId: string;
  clientId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asCodeBlock(language: string, value: string): string {
  return `\n\n\`\`\`${language}\n${value}\n\`\`\``;
}

function textContent(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function summarizeTask(task: TaskRecord): string {
  const lines = [
    `taskId: ${task.id}`,
    `status: ${task.status}`,
    `runtimeId: ${task.runtimeId}`,
  ];

  if (task.exitCode !== undefined) {
    lines.push(`exitCode: ${task.exitCode}`);
  }

  if (task.error) {
    lines.push(`error: ${task.error}`);
  }

  let text = lines.join("\n");
  if (task.stdout && task.stdout.trim()) {
    text += asCodeBlock("text", task.stdout);
  }
  if (task.stderr && task.stderr.trim()) {
    text += asCodeBlock("text", task.stderr);
  }
  return text;
}

function waitForTerminalTask(
  service: McpExecutorService,
  taskId: string,
  workspaceId: string,
  waitTimeoutMs: number,
  onApprovalPrompt?: ApprovalPrompt,
  approvalContext?: ApprovalPromptContext,
): Promise<TaskRecord | null> {
  return new Promise((resolve) => {
    let settled = false;
    let checking = false;
    let elicitationEnabled = Boolean(
      onApprovalPrompt
      && approvalContext
      && service.listPendingApprovals
      && service.resolveApproval,
    );
    let loggedElicitationFallback = false;
    const seenApprovalIds = new Set<string>();
    let unsubscribe: (() => void) | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const logElicitationFallback = (reason: string) => {
      if (loggedElicitationFallback) return;
      loggedElicitationFallback = true;
      console.warn(`[executor] MCP approval elicitation unavailable, using out-of-band approvals: ${reason}`);
    };

    const done = async () => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      unsubscribe?.();
      resolve(await service.getTask(taskId, workspaceId));
    };

    const timeout = setTimeout(done, waitTimeoutMs);

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
          // Client likely doesn't support elicitation; fallback to existing out-of-band approvals.
          elicitationEnabled = false;
          logElicitationFallback(error instanceof Error ? error.message : String(error));
          return;
        }

        if (!decision) {
          // Client doesn't support elicitation; stop retrying in this request.
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

    const checkTask = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        const task = await service.getTask(taskId, workspaceId);
        if (task && getTaskTerminalState(task.status)) {
          clearTimeout(timeout);
          await done();
          return;
        }

        await maybeHandleApprovals();
      } finally {
        checking = false;
      }
    };

    poll = setInterval(() => {
      void checkTask().catch(() => {});
    }, 400);

    // Check if already terminal before subscribing (race condition guard)
    void checkTask().catch(() => {});

    // Subscribe for live events when available; polling remains as fallback.
    try {
      unsubscribe = service.subscribe(taskId, (event) => {
        const type = typeof event.payload === "object" && event.payload
          ? (event.payload as Record<string, unknown>).status
          : undefined;
        if (typeof type === "string" && getTaskTerminalState(type)) {
          clearTimeout(timeout);
          void done();
        }
      });
    } catch {
      // Ignore subscription errors and rely on polling.
    }
  });
}

// ---------------------------------------------------------------------------
// Build run_code description with sandbox tool inventory
// ---------------------------------------------------------------------------

function buildRunCodeDescription(tools?: ToolDescriptor[]): string {
  const base =
    "Execute TypeScript code in a sandboxed runtime. The code has access to a `tools` object with typed methods for calling external services. Use `return` to return a value. Waits for completion and returns stdout/stderr. Code is typechecked before execution — type errors are returned without running.";

  return base + generateToolInventory(tools ?? []);
}

// ---------------------------------------------------------------------------
// run_code tool handler
// ---------------------------------------------------------------------------

function createRunCodeTool(
  service: McpExecutorService,
  boundContext?: McpWorkspaceContext,
  onApprovalPrompt?: ApprovalPrompt,
) {
  return async (
    input: {
      code: string;
      timeoutMs?: number;
      runtimeId?: string;
      metadata?: Record<string, unknown>;
      workspaceId?: string;
      actorId?: string;
      clientId?: string;
      sessionId?: string;
      waitForResult?: boolean;
      resultTimeoutMs?: number;
    },
    extra: { sessionId?: string },
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }> => {
    const requestedTimeoutMs = input.timeoutMs ?? 300_000;

    // Resolve context: bound context takes priority, then input, then anonymous
    let context: { workspaceId: string; actorId: string; clientId?: string; sessionId?: string };

    if (boundContext) {
      context = { ...boundContext, sessionId: input.sessionId };
    } else if (input.workspaceId && input.actorId) {
      context = {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        clientId: input.clientId,
        sessionId: input.sessionId,
      };
    } else {
      const seededSessionId = input.sessionId ?? (extra.sessionId ? `mcp_${extra.sessionId}` : undefined);
      const anonymous = await service.bootstrapAnonymousContext(seededSessionId);
      context = {
        workspaceId: anonymous.workspaceId,
        actorId: anonymous.actorId,
        clientId: input.clientId ?? anonymous.clientId,
        sessionId: anonymous.sessionId,
      };
    }

    // Typecheck code before execution — get tool inventory for declarations
    const toolsForContext = await service.listTools({
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      clientId: context.clientId,
    });
    const declarations = generateToolDeclarations(toolsForContext);
    const typecheck = typecheckCode(input.code, declarations);

    if (!typecheck.ok) {
      const errorText = [
        "TypeScript type errors in generated code:",
        "",
        ...typecheck.errors.map((e) => `  ${e}`),
        "",
        "Fix the type errors and try again.",
      ].join("\n");

      return {
        content: [textContent(errorText)],
        isError: true,
        structuredContent: {
          typecheckErrors: typecheck.errors,
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          sessionId: context.sessionId,
        },
      };
    }

    const created = await service.createTask({
      code: input.code,
      timeoutMs: requestedTimeoutMs,
      runtimeId: input.runtimeId,
      metadata: input.metadata,
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      clientId: context.clientId,
    });

    const waitForResult = input.waitForResult ?? true;
    if (!waitForResult) {
      return {
        content: [textContent(`Queued task ${created.task.id}`)],
        structuredContent: {
          taskId: created.task.id,
          status: created.task.status,
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          sessionId: context.sessionId,
        },
      };
    }

    const waitTimeoutMs = input.resultTimeoutMs ?? Math.max(requestedTimeoutMs + 30_000, 120_000);
    const task = await waitForTerminalTask(
      service,
      created.task.id,
      context.workspaceId,
      waitTimeoutMs,
      onApprovalPrompt,
      { workspaceId: context.workspaceId, actorId: context.actorId },
    );

    if (!task) {
      return {
        content: [textContent(`Task ${created.task.id} not found while waiting for result`)],
        isError: true,
      };
    }

    if (!getTaskTerminalState(task.status)) {
      return {
        content: [textContent(`Task ${task.id} is still ${task.status}`)],
        structuredContent: { taskId: task.id, status: task.status, workspaceId: context.workspaceId, actorId: context.actorId, sessionId: context.sessionId },
      };
    }

    const isError = task.status !== "completed";
    return {
      content: [textContent(summarizeTask(task))],
      structuredContent: {
        taskId: task.id,
        status: task.status,
        runtimeId: task.runtimeId,
        exitCode: task.exitCode,
        error: task.error,
        stdout: task.stdout,
        stderr: task.stderr,
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        sessionId: context.sessionId,
      },
      ...(isError ? { isError: true } : {}),
    };
  };
}

// ---------------------------------------------------------------------------
// Input schema — when context is bound, workspace fields aren't needed
// ---------------------------------------------------------------------------

const FULL_INPUT = {
  code: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  runtimeId: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  workspaceId: z.string().optional(),
  actorId: z.string().optional(),
  clientId: z.string().optional(),
  sessionId: z.string().optional(),
  waitForResult: z.boolean().optional(),
  resultTimeoutMs: z.number().int().min(100).max(900_000).optional(),
} as const;

const BOUND_INPUT = {
  code: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  runtimeId: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
} as const;

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

async function createMcpServer(
  service: McpExecutorService,
  context?: McpWorkspaceContext,
): Promise<McpServer> {
  const mcp = new McpServer(
    { name: "executor", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // If workspace context is provided, fetch tool inventory for richer description
  let tools: ToolDescriptor[] | undefined;
  if (context) {
    tools = await service.listTools({
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      clientId: context.clientId,
    });
  }

  const approvalPrompt: ApprovalPrompt = async (approval) => {
    const inputPreview = (() => {
      try {
        const text = JSON.stringify(approval.input ?? {});
        return text.length > 500 ? `${text.slice(0, 500)}...` : text;
      } catch {
        return "{}";
      }
    })();

    const result = await mcp.elicitInput({
      mode: "form",
      message: `Approval required for tool call '${approval.toolPath}'. Input: ${inputPreview}`,
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            oneOf: [
              { const: "approve", title: "Approve" },
              { const: "deny", title: "Deny" },
            ],
            description: "Choose whether to allow this tool invocation",
            default: "deny",
          },
          reason: {
            type: "string",
            description: "Optional reason",
          },
        },
        required: ["decision"],
      },
    });

    if (result.action !== "accept") {
      return {
        decision: "denied",
        reason: result.action === "cancel" ? "Cancelled via MCP elicitation" : "Declined via MCP elicitation",
      } satisfies ApprovalPromptDecision;
    }

    const content = result.content && typeof result.content === "object"
      ? (result.content as Record<string, unknown>)
      : {};
    const decision = content.decision === "approve" ? "approved" : "denied";
    const reason = typeof content.reason === "string" && content.reason.trim().length > 0
      ? content.reason.trim()
      : undefined;

    return { decision, reason } satisfies ApprovalPromptDecision;
  };

  mcp.registerTool(
    "run_code",
    {
      description: buildRunCodeDescription(tools),
      inputSchema: context ? BOUND_INPUT : FULL_INPUT,
    },
    createRunCodeTool(service, context, approvalPrompt),
  );

  return mcp;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

interface SessionServiceRef {
  current: McpExecutorService;
}

interface McpSessionState {
  mcp: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  serviceRef: SessionServiceRef;
  queue: Promise<void>;
  lastSeenAt: number;
}

const mcpSessions = new Map<string, McpSessionState>();

function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    },
    { status },
  );
}

function createServiceProxy(serviceRef: SessionServiceRef): McpExecutorService {
  const listPendingApprovals = serviceRef.current.listPendingApprovals
    ? async (workspaceId: string) => {
      const fn = serviceRef.current.listPendingApprovals;
      if (!fn) return [];
      return await fn(workspaceId);
    }
    : undefined;

  const resolveApproval = serviceRef.current.resolveApproval
    ? async (input: {
      workspaceId: string;
      approvalId: string;
      decision: "approved" | "denied";
      reviewerId?: string;
      reason?: string;
    }) => {
      const fn = serviceRef.current.resolveApproval;
      if (!fn) {
        throw new Error("resolveApproval is not available");
      }
      return await fn(input);
    }
    : undefined;

  return {
    createTask: async (input) => await serviceRef.current.createTask(input),
    getTask: async (taskId, workspaceId) => await serviceRef.current.getTask(taskId, workspaceId),
    subscribe: (taskId, listener) => serviceRef.current.subscribe(taskId, listener),
    bootstrapAnonymousContext: async (sessionId) => await serviceRef.current.bootstrapAnonymousContext(sessionId),
    listTools: async (context) => await serviceRef.current.listTools(context),
    listPendingApprovals,
    resolveApproval,
  };
}

async function createSessionState(
  service: McpExecutorService,
  context?: McpWorkspaceContext,
): Promise<McpSessionState> {
  const serviceRef: SessionServiceRef = { current: service };
  const proxyService = createServiceProxy(serviceRef);
  let state: McpSessionState;

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      mcpSessions.set(sessionId, state);
    },
    onsessionclosed: async (sessionId) => {
      const existing = mcpSessions.get(sessionId);
      if (existing === state) {
        mcpSessions.delete(sessionId);
      }
      await state.mcp.close().catch(() => {});
    },
  });

  const mcp = await createMcpServer(proxyService, context);
  state = {
    mcp,
    transport,
    serviceRef,
    queue: Promise.resolve(),
    lastSeenAt: Date.now(),
  };

  await mcp.connect(transport);
  return state;
}

async function closeSessionState(state: McpSessionState): Promise<void> {
  await state.transport.close().catch(() => {});
  await state.mcp.close().catch(() => {});
}

async function handleWithSession(
  state: McpSessionState,
  service: McpExecutorService,
  request: Request,
  requestOptions?: HandleRequestOptions,
): Promise<Response> {
  const run = async () => {
    state.serviceRef.current = service;
    state.lastSeenAt = Date.now();
    return await state.transport.handleRequest(request, requestOptions);
  };

  const next = state.queue.then(run, run);
  state.queue = next.then(() => undefined, () => undefined);
  return await next;
}

async function parseRequestBody(request: Request): Promise<HandleRequestOptions | undefined> {
  if (request.method !== "POST") return undefined;
  try {
    const parsedBody = await request.clone().json();
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const method = (message as { method?: unknown }).method;
      if (method !== "initialize") continue;
      const params = (message as { params?: unknown }).params;
      const capabilities = params && typeof params === "object"
        ? (params as { capabilities?: unknown }).capabilities
        : undefined;
      console.warn(
        `[executor] MCP initialize client capabilities: ${JSON.stringify(capabilities ?? {})}`,
      );
      break;
    }

    return { parsedBody };
  } catch {
    return undefined;
  }
}

export async function handleMcpRequest(
  service: McpExecutorService,
  request: Request,
  context?: McpWorkspaceContext,
): Promise<Response> {
  const requestOptions = await parseRequestBody(request);
  const sessionId = request.headers.get("mcp-session-id")?.trim() ?? "";

  if (sessionId) {
    const existing = mcpSessions.get(sessionId);
    if (!existing) {
      return jsonRpcErrorResponse(404, -32001, "Session not found");
    }
    return await handleWithSession(existing, service, request, requestOptions);
  }

  if (request.method !== "POST") {
    return jsonRpcErrorResponse(400, -32000, "Bad Request: Mcp-Session-Id header is required");
  }

  const session = await createSessionState(service, context);
  try {
    const response = await handleWithSession(session, service, request, requestOptions);
    if (!session.transport.sessionId) {
      await closeSessionState(session);
    }
    return response;
  } catch (error) {
    await closeSessionState(session);
    throw error;
  }
}
