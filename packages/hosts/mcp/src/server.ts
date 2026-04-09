import { Effect, Match } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { jsonSchemaValidator, JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { Validator } from "@cfworker/json-schema";
import { z } from "zod/v4";

import type {
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
  ElicitationRequest,
} from "@executor/sdk";
import {
  createExecutionEngine,
  formatExecuteResult,
  formatPausedExecution,
  type ExecutionEngine,
  type ExecutionEngineConfig,
} from "@executor/execution";

// ---------------------------------------------------------------------------
// Workers-compatible JSON Schema validator (replaces Ajv which uses new Function())
// ---------------------------------------------------------------------------

class CfWorkerJsonSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const validator = new Validator(schema as Record<string, unknown>, "2020-12", false);
    return (input: unknown) => {
      const result = validator.validate(input);
      if (result.valid) {
        return { valid: true, data: input as T, errorMessage: undefined };
      }
      const errorMessage = result.errors
        .map((e) => `${e.instanceLocation}: ${e.error}`)
        .join("; ");
      return { valid: false, data: undefined, errorMessage };
    };
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type ExecutorMcpServerConfig =
  | ExecutionEngineConfig
  | { readonly engine: ExecutionEngine }
  | (ExecutionEngineConfig & { readonly stateless: true })
  | { readonly engine: ExecutionEngine; readonly stateless: true };

// ---------------------------------------------------------------------------
// Elicitation bridge
// ---------------------------------------------------------------------------

const getElicitationSupport = (
  server: McpServer,
): { form: boolean; url: boolean } => {
  const capabilities = server.server.getClientCapabilities();
  if (capabilities === undefined || !capabilities.elicitation)
    return { form: false, url: false };
  const elicitation = capabilities.elicitation as Record<string, unknown>;
  return { form: Boolean(elicitation.form), url: Boolean(elicitation.url) };
};

const supportsManagedElicitation = (server: McpServer): boolean =>
  getElicitationSupport(server).form;

type ElicitInputParams =
  | {
      mode?: "form";
      message: string;
      requestedSchema: { readonly [key: string]: unknown };
    }
  | { mode: "url"; message: string; url: string; elicitationId: string };

const elicitationRequestToParams: (
  request: ElicitationRequest,
) => ElicitInputParams = Match.type<ElicitationRequest>().pipe(
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

const makeMcpElicitationHandler =
  (server: McpServer): ElicitationHandler =>
  (ctx: ElicitationContext): Effect.Effect<typeof ElicitationResponse.Type> => {
    const { url: supportsUrl } = getElicitationSupport(server);

    // If client doesn't support url mode, fall back to a form asking the user
    // to visit the URL manually and confirm when done.
    const params =
      ctx.request._tag === "UrlElicitation" && !supportsUrl
        ? {
            message: `${ctx.request.message}\n\nPlease visit this URL:\n${ctx.request.url}\n\nClick accept once you have completed the flow.`,
            requestedSchema: { type: "object" as const, properties: {} },
          }
        : elicitationRequestToParams(ctx.request);

    return Effect.promise(
      async (): Promise<typeof ElicitationResponse.Type> => {
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
      },
    );
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
  const engine =
    "engine" in config ? config.engine : createExecutionEngine(config);
  const description = await engine.getDescription();

  const server = new McpServer(
    { name: "executor", version: "1.0.0" },
    { capabilities: { tools: {} }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
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

  const parseJsonContent = (
    raw: string,
  ): Record<string, unknown> | undefined => {
    if (raw === "{}") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
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
        executionId: z
          .string()
          .describe("The execution ID from the paused result"),
        action: z
          .enum(["accept", "decline", "cancel"])
          .describe("How to respond to the interaction"),
        content: z
          .string()
          .describe(
            "Optional JSON-encoded response content for form elicitations",
          )
          .default("{}"),
      },
    },
    async ({ executionId, action, content: rawContent }) => {
      const content = parseJsonContent(rawContent);
      const outcome = await engine.resume(executionId, { action, content });

      if (!outcome) {
        return {
          content: [
            { type: "text", text: `No paused execution: ${executionId}` },
          ],
          isError: true,
        };
      }

      return outcome.status === "completed"
        ? toMcpResult(formatExecuteResult(outcome.result))
        : toMcpPausedResult(formatPausedExecution(outcome.execution));
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
