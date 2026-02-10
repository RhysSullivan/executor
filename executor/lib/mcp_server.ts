import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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
  listToolsForTypecheck?(
    context: { workspaceId: string; actorId?: string; clientId?: string },
  ): Promise<{ tools: ToolDescriptor[]; dtsUrls: Record<string, string> }>;
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
  sessionId?: string;
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

function listTopLevelToolKeys(tools: ToolDescriptor[]): string[] {
  const keys = new Set<string>();
  for (const tool of tools) {
    const first = tool.path.split(".")[0];
    if (first) keys.add(first);
  }
  return [...keys].sort();
}

const dtsUrlCache = new Map<string, Promise<string | null>>();

async function loadSourceDtsByUrl(dtsUrls: Record<string, string>): Promise<Record<string, string>> {
  const entries = Object.entries(dtsUrls);
  if (entries.length === 0) {
    return {};
  }

  const results = await Promise.all(entries.map(async ([sourceKey, url]) => {
    if (!url) return [sourceKey, null] as const;

    if (!dtsUrlCache.has(url)) {
      dtsUrlCache.set(url, (async () => {
        try {
          const response = await fetch(url);
          if (!response.ok) {
            console.warn(`[executor] failed to fetch source .d.ts from ${url}: HTTP ${response.status}`);
            return null;
          }
          return await response.text();
        } catch (error) {
          console.warn(
            `[executor] failed to fetch source .d.ts from ${url}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      })());
    }

    const content = await dtsUrlCache.get(url)!;
    return [sourceKey, content] as const;
  }));

  const sourceDtsBySource: Record<string, string> = {};
  for (const [sourceKey, dts] of results) {
    if (dts) {
      sourceDtsBySource[sourceKey] = dts;
    }
  }
  return sourceDtsBySource;
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
    "Execute TypeScript code in a sandboxed runtime. The code has access to a `tools` object with typed methods for calling external services. Use `return` to return a value. Waits for completion and returns stdout/stderr. Code is typechecked before execution — type errors are returned without running. Runtime has no filesystem/process/import access; use `tools.*` for external calls.";
  const toolList = tools ?? [];
  const topLevelKeys = listTopLevelToolKeys(toolList);
  const rootKeysNote = topLevelKeys.length > 0
    ? `\n\nTop-level tool keys: ${topLevelKeys.join(", ")}`
    : "";
  const hasGraphqlTools = toolList.some((tool) => tool.path.endsWith(".graphql"));
  const discoverNote = "\n\nTip: use `tools.discover({ query, depth?, limit? })` first. It returns `{ results, total }`; call the exact `results[i].path` (or copy `results[i].exampleCall`). Do not assign to `const tools = ...`; use a different variable name (e.g. `const discovered = ...`).";
  const graphqlNote = hasGraphqlTools
    ? "\n\nGraphQL tip: prefer `source.query.*` / `source.mutation.*` helper paths when available; GraphQL tools return `{ data, errors }`."
    : "";

  return base + rootKeysNote + discoverNote + graphqlNote + generateToolInventory(toolList);
}

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

function createMcpApprovalPrompt(mcp: McpServer): ApprovalPrompt {
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
      context = { ...boundContext, sessionId: input.sessionId ?? boundContext.sessionId };
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

    // Typecheck code before execution — align with Monaco by loading source .d.ts
    // for OpenAPI tools when available.
    let toolsForContext: ToolDescriptor[];
    let sourceDtsBySource: Record<string, string> = {};
    if (service.listToolsForTypecheck) {
      const { tools, dtsUrls } = await service.listToolsForTypecheck({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        clientId: context.clientId,
      });
      toolsForContext = tools;
      sourceDtsBySource = await loadSourceDtsByUrl(dtsUrls ?? {});
    } else {
      toolsForContext = await service.listTools({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        clientId: context.clientId,
      });
    }

    const declarations = generateToolDeclarations(toolsForContext, {
      sourceDtsBySource,
    });
    const typecheck = typecheckCode(input.code, declarations);

    if (!typecheck.ok) {
      const topLevelKeys = listTopLevelToolKeys(toolsForContext);
      const toolsShadowingError = typecheck.errors.some((error) =>
        error.includes("Block-scoped variable 'tools' used before its declaration")
        || error.includes("'tools' implicitly has type 'any'"),
      );

      const hintLines: string[] = [];
      if (toolsShadowingError) {
        hintLines.push("Hint: avoid declaring a local variable named `tools`.");
        hintLines.push("Example: `const discovered = await tools.discover({ query: \"github issues\" });`");
      }
      if (topLevelKeys.length > 0) {
        hintLines.push(`Available top-level tool keys: ${topLevelKeys.join(", ")}`);
      }

      const errorText = [
        "TypeScript type errors in generated code:",
        "",
        ...typecheck.errors.map((e) => `  ${e}`),
        ...(hintLines.length > 0 ? ["", ...hintLines] : []),
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
  const onApprovalPrompt = createMcpApprovalPrompt(mcp);

  // If workspace context is provided, fetch tool inventory for richer description
  let tools: ToolDescriptor[] | undefined;
  if (context) {
    tools = await service.listTools({
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      clientId: context.clientId,
    });
  }

  mcp.registerTool(
    "run_code",
    {
      description: buildRunCodeDescription(tools),
      inputSchema: context ? BOUND_INPUT : FULL_INPUT,
    },
    createRunCodeTool(service, context, onApprovalPrompt),
  );

  return mcp;
}

function createDelegatingService(ref: { current: McpExecutorService }): McpExecutorService {
  return {
    createTask: async (input) => await ref.current.createTask(input),
    getTask: async (taskId, workspaceId) => await ref.current.getTask(taskId, workspaceId),
    subscribe: (taskId, listener) => ref.current.subscribe(taskId, listener),
    bootstrapAnonymousContext: async (sessionId) => await ref.current.bootstrapAnonymousContext(sessionId),
    listTools: async (context) => await ref.current.listTools(context),
    listToolsForTypecheck: ref.current.listToolsForTypecheck
      ? async (context) => await ref.current.listToolsForTypecheck!(context)
      : undefined,
    listPendingApprovals: ref.current.listPendingApprovals
      ? async (workspaceId) => await ref.current.listPendingApprovals!(workspaceId)
      : undefined,
    resolveApproval: ref.current.resolveApproval
      ? async (input) => await ref.current.resolveApproval!(input)
      : undefined,
  };
}

const mcpSessionRuntimes = new Map<
  string,
  {
    transport: WebStandardStreamableHTTPServerTransport;
    mcp: McpServer;
    serviceRef: { current: McpExecutorService };
  }
>();

async function handleStatelessMcpRequest(
  service: McpExecutorService,
  request: Request,
  context?: McpWorkspaceContext,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const mcp = await createMcpServer(service, context);

  try {
    await mcp.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

export async function handleMcpRequest(
  service: McpExecutorService,
  request: Request,
  context?: McpWorkspaceContext,
): Promise<Response> {
  const runtimeSessionId = request.headers.get("mcp-session-id") ?? undefined;

  if (runtimeSessionId) {
    const runtime = mcpSessionRuntimes.get(runtimeSessionId);
    if (runtime) {
      runtime.serviceRef.current = service;
      return await runtime.transport.handleRequest(request);
    }

    const headers = new Headers(request.headers);
    headers.delete("mcp-session-id");
    const requestWithoutSession = new Request(request, { headers });
    return await handleStatelessMcpRequest(service, requestWithoutSession, context);
  }

  const serviceRef = { current: service };
  const delegatingService = createDelegatingService(serviceRef);
  const mcp = await createMcpServer(delegatingService, context);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      mcpSessionRuntimes.set(sessionId, {
        transport,
        mcp,
        serviceRef,
      });
    },
    onsessionclosed: async (sessionId) => {
      if (!sessionId) {
        return;
      }

      const runtime = mcpSessionRuntimes.get(sessionId);
      if (!runtime) {
        return;
      }

      mcpSessionRuntimes.delete(sessionId);
      await runtime.mcp.close().catch(() => {});
    },
  });

  try {
    await mcp.connect(transport);
    const response = await transport.handleRequest(request);

    const initializedSessionId = response.headers.get("mcp-session-id") ?? undefined;
    if (!initializedSessionId) {
      await transport.close().catch(() => {});
      await mcp.close().catch(() => {});
    }

    return response;
  } catch (error) {
    await transport.close().catch(() => {});
    await mcp.close().catch(() => {});
    throw error;
  }
}
