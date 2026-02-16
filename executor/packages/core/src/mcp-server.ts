import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import type { McpExecutorService, ApprovalPrompt } from "./mcp/server-contracts";
import type { Id } from "../../database/convex/_generated/dataModel.d.ts";
import { waitForTerminalTask, createMcpApprovalPrompt } from "./mcp/server-approval";
import { buildRunCodeDescription, summarizeTask } from "./mcp/server-formatting";
import { getTaskTerminalState, textContent } from "./mcp/server-utils";

// ---------------------------------------------------------------------------
// Workspace context (optional, from query params)
// ---------------------------------------------------------------------------

export interface McpWorkspaceContext {
  workspaceId: Id<"workspaces">;
  actorId: string;
  clientId?: string;
  sessionId?: string;
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
    let context: { workspaceId: Id<"workspaces">; actorId: string; clientId?: string; sessionId?: string };

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

    if (service.runTaskNow) {
      const runOutcome = await service.runTaskNow(created.task.id);
      const task = runOutcome?.task ?? await service.getTask(created.task.id, context.workspaceId);
      if (!task) {
        return {
          content: [textContent(`Task ${created.task.id} not found after execution`)],
          isError: true,
        };
      }

      const result = runOutcome?.result ?? task.result;
      const isError = task.status !== "completed";
      return {
        content: [textContent(summarizeTask(task, result))],
        structuredContent: {
          taskId: task.id,
          status: task.status,
          runtimeId: task.runtimeId,
          exitCode: task.exitCode,
          error: task.error,
          result,
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          sessionId: context.sessionId,
        },
        ...(isError ? { isError: true } : {}),
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
        result: task.result,
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

const FULL_INPUT = z.object({
  code: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  runtimeId: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  clientId: z.string().optional(),
  sessionId: z.string().optional(),
  waitForResult: z.boolean().optional(),
  resultTimeoutMs: z.number().int().min(100).max(900_000).optional(),
}) as unknown as AnySchema;

const BOUND_INPUT = z.object({
  code: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  runtimeId: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}) as unknown as AnySchema;

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

async function createMcpServer(
  service: McpExecutorService,
  context?: McpWorkspaceContext,
): Promise<McpServer> {
  const mcp = new McpServer(
    { name: "executor", version: "0.1.0" },
    { capabilities: { tools: {}, elicitation: { form: {} } } as any },
  );
  const onApprovalPrompt = createMcpApprovalPrompt(mcp);
  const registerTool = (mcp.registerTool as (
    name: string,
    config: { description: string; inputSchema: AnySchema },
    cb: ReturnType<typeof createRunCodeTool>,
  ) => void).bind(mcp);

  registerTool(
    "run_code",
    {
      description: buildRunCodeDescription(),
      inputSchema: context ? BOUND_INPUT : FULL_INPUT,
    },
    createRunCodeTool(service, context, onApprovalPrompt),
  );

  return mcp;
}

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
  // Preserve MCP session headers so the SDK can negotiate capabilities
  // (elicitation/sampling) across requests.
  return await handleStatelessMcpRequest(service, request, context);
}
