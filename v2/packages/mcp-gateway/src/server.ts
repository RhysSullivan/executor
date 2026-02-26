import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export type GatewayTarget = "local" | "remote";

export type GatewayRuntimeKind =
  | "local-inproc"
  | "deno-subprocess"
  | "cloudflare-worker-loader";

export type ExecuteToolInput = {
  code: string;
  runtimeKind?: GatewayRuntimeKind;
};

export type ExecuteToolResult = {
  output?: unknown;
  error?: string;
  isError: boolean;
};

export type McpGatewayOptions = {
  target: GatewayTarget;
  serverName?: string;
  serverVersion?: string;
  execute: (input: ExecuteToolInput) => Promise<ExecuteToolResult>;
};

const DEFAULT_SERVER_NAME = "executor-v2";
const DEFAULT_SERVER_VERSION = "0.0.0";
const EXECUTE_TOOL_NAME = "executor.execute";

const ExecuteToolInputSchema = z.object({
  code: z.string(),
  runtimeKind: z
    .enum(["local-inproc", "deno-subprocess", "cloudflare-worker-loader"])
    .optional(),
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
  } catch {
    // fall through
  }

  return String(value);
};

const createMcpServer = (options: McpGatewayOptions): McpServer => {
  const mcp = new McpServer({
    name: options.serverName ?? DEFAULT_SERVER_NAME,
    version: options.serverVersion ?? DEFAULT_SERVER_VERSION,
  });

  mcp.registerTool(
    EXECUTE_TOOL_NAME,
    {
      description:
        "Execute JavaScript against configured runtime adapter. Runtime receives tools namespace, including executor source controls under tools.executor.sources.*.",
      inputSchema: ExecuteToolInputSchema,
    },
    async (input: ExecuteToolInput) => {
      try {
        const result = await options.execute(input);
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
