import type { ExecuteRunResult, ExecutorRunClient } from "@executor-v2/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export type ExecuteToolInput = {
  code: string;
  timeoutMs?: number;
};

export type ExecuteToolResult = {
  output?: unknown;
  error?: string;
  isError: boolean;
};

const toGatewayExecuteResult = (
  result: ExecuteRunResult,
): ExecuteToolResult => {
  if (result.status === "completed") {
    return {
      isError: false,
      output: result.result,
    };
  }

  if (result.status === "waiting_for_interaction") {
    return {
      isError: false,
      output: {
        status: "interaction_required",
        runId: result.runId,
        interactionId: result.interactionId ?? null,
        message: result.error ?? "Run paused pending interaction",
      },
    };
  }

  return {
    isError: true,
    error: result.error ?? `Run ${result.runId} ended with status ${result.status}`,
  };
};

export type McpGatewayOptions = {
  serverName?: string;
  serverVersion?: string;
  runClient?: ExecutorRunClient;
  executeToolDescription?: string;
  registerTools?: (server: McpServer) => void;
};
const DEFAULT_SERVER_NAME = "executor-v2";
const DEFAULT_SERVER_VERSION = "0.0.0";
const EXECUTE_TOOL_NAME = "executor.execute";

const ExecuteToolInputSchema = z.object({
  code: z.string(),
  timeoutMs: z.number().int().positive().optional(),
});

const contentText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    const serialized = JSON.stringify(value, null, 2);
    if (typeof serialized === "string") {
      return serialized;
    }
    return String(value);
  } catch {
    return String(value);
  }
};

const createMcpServer = (options: McpGatewayOptions): McpServer => {
  const mcp = new McpServer({
    name: options.serverName ?? DEFAULT_SERVER_NAME,
    version: options.serverVersion ?? DEFAULT_SERVER_VERSION,
  });

  if (options.runClient) {
    const runClient = options.runClient;

    mcp.registerTool(
      EXECUTE_TOOL_NAME,
      {
        description:
          options.executeToolDescription ??
          "Execute JavaScript against configured runtime",
        inputSchema: ExecuteToolInputSchema,
      },
      async (input: ExecuteToolInput) => {
        try {
          const result = toGatewayExecuteResult(
            await runClient.execute({
              code: input.code,
              timeoutMs: input.timeoutMs,
            }),
          );

          return {
            content: [
              {
                type: "text" as const,
                text: result.isError
                  ? result.error ?? "Execution failed"
                  : contentText(result.output),
              },
            ],
            isError: result.isError,
          };
        } catch (cause) {
          return {
            content: [
              {
                type: "text" as const,
                text: cause instanceof Error ? cause.message : String(cause),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  options.registerTools?.(mcp);

  return mcp;
};

export const handleMcpHttpRequest = async (
  request: Request,
  options: McpGatewayOptions,
): Promise<Response> => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const mcp = createMcpServer(options);

  try {
    await mcp.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }
};
