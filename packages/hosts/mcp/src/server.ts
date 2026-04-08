import { Effect, Match } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import type {
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
  ElicitationRequest,
} from "@executor/core";
import {
  createExecutionEngine,
  formatExecuteResult,
  formatPausedExecution,
  type ExecutionEngine,
  type ExecutionEngineConfig,
} from "@executor/execution";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type ExecutorMcpServerConfig =
  | ExecutionEngineConfig
  | { readonly engine: ExecutionEngine };

// ---------------------------------------------------------------------------
// Elicitation bridge
// ---------------------------------------------------------------------------

const supportsManagedElicitation = (server: McpServer): boolean => {
  const capabilities = server.server.getClientCapabilities();
  if (capabilities === undefined || !capabilities.elicitation) return false;
  const elicitation = capabilities.elicitation as Record<string, unknown>;
  return Boolean(elicitation.form) && Boolean(elicitation.url);
};

type ElicitInputParams =
  | { mode?: "form"; message: string; requestedSchema: { readonly [key: string]: unknown } }
  | { mode: "url"; message: string; url: string; elicitationId: string };

const elicitationRequestToParams: (request: ElicitationRequest) => ElicitInputParams =
  Match.type<ElicitationRequest>().pipe(
    Match.tag("UrlElicitation", (req) => ({
      mode: "url" as const,
      message: req.message,
      url: req.url,
      elicitationId: req.elicitationId,
    })),
    Match.tag("FormElicitation", (req) => ({
      message: req.message,
      // The MCP SDK validates requestedSchema as a JSON Schema with
      // `type: "object"` and `properties`. For approval-only elicitations
      // where no fields are needed, provide a minimal valid schema.
      requestedSchema:
        Object.keys(req.requestedSchema).length === 0
          ? { type: "object" as const, properties: {} }
          : req.requestedSchema,
    })),
    Match.exhaustive,
  );

const makeMcpElicitationHandler = (server: McpServer): ElicitationHandler =>
  (ctx: ElicitationContext): Effect.Effect<typeof ElicitationResponse.Type> => {
    const params = elicitationRequestToParams(ctx.request);

    return Effect.promise(async (): Promise<typeof ElicitationResponse.Type> => {
      try {
        const response = await server.server.elicitInput(
          params as Parameters<typeof server.server.elicitInput>[0],
        );

        return {
          action: response.action,
          content: response.content,
        };
      } catch (err) {
        console.error(
          "[executor] elicitInput failed — falling back to cancel.",
          err instanceof Error ? err.message : err,
        );
        return { action: "cancel" };
      }
    });
  };

// ---------------------------------------------------------------------------
// MCP result formatting
// ---------------------------------------------------------------------------

type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const toMcpResult = (
  formatted: ReturnType<typeof formatExecuteResult>,
): McpToolResult => ({
  content: [{ type: "text", text: formatted.text }],
  structuredContent: formatted.structured,
  isError: formatted.isError || undefined,
});

const toMcpPausedResult = (
  formatted: ReturnType<typeof formatPausedExecution>,
): McpToolResult => ({
  content: [{ type: "text", text: formatted.text }],
  structuredContent: formatted.structured,
});

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export const createExecutorMcpServer = async (
  config: ExecutorMcpServerConfig,
): Promise<McpServer> => {
  const engine = "engine" in config ? config.engine : createExecutionEngine(config);
  const description = await engine.getDescription();

  const server = new McpServer(
    { name: "executor", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const executeCode = async (code: string): Promise<McpToolResult> => {
    if (supportsManagedElicitation(server)) {
      const result = await engine.execute(code, {
        onElicitation: makeMcpElicitationHandler(server),
      });
      return toMcpResult(formatExecuteResult(result));
    }

    const outcome = await engine.executeWithPause(code);
    return outcome.status === "completed"
      ? toMcpResult(formatExecuteResult(outcome.result))
      : toMcpPausedResult(formatPausedExecution(outcome.execution));
  };

  const parseJsonContent = (raw: string): Record<string, unknown> | undefined => {
    if (raw === "{}") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  };

  // --- tools ---

  const executeTool = server.registerTool(
    "execute",
    {
      description,
      inputSchema: { code: z.string().trim().min(1) },
    },
    async ({ code }) => executeCode(code),
  );

  const resumeTool = server.registerTool(
    "resume",
    {
      description: [
        "Resume a paused execution using the executionId returned by execute.",
        "Never call this without user approval unless they explicitly state otherwise.",
      ].join("\n"),
      inputSchema: {
        executionId: z.string().describe("The execution ID from the paused result"),
        action: z.enum(["accept", "decline", "cancel"]).describe("How to respond to the interaction"),
        content: z.string().describe("Optional JSON-encoded response content for form elicitations").default("{}"),
      },
    },
    async ({ executionId, action, content: rawContent }) => {
      const content = parseJsonContent(rawContent);
      const result = await engine.resume(executionId, { action, content });

      if (!result) {
        return {
          content: [{ type: "text", text: `No paused execution: ${executionId}` }],
          isError: true,
        };
      }

      return toMcpResult(formatExecuteResult(result));
    },
  );

  // --- capability-based tool visibility ---

  const syncToolAvailability = () => {
    executeTool.enable();
    if (supportsManagedElicitation(server)) {
      resumeTool.disable();
    } else {
      resumeTool.enable();
    }
  };

  syncToolAvailability();
  server.server.oninitialized = syncToolAvailability;

  return server;
};
