import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export type GatewayTarget = "local" | "remote";

export type McpGatewayOptions = {
  target: GatewayTarget;
  serverName?: string;
  serverVersion?: string;
};

const DEFAULT_SERVER_NAME = "executor-v2";
const DEFAULT_SERVER_VERSION = "0.0.0";
const STUB_TOOL_NAME = "executor.ping";

const PingToolInput = z.object({
  message: z.string().optional(),
});

const createStubMcpServer = (options: McpGatewayOptions): McpServer => {
  const mcp = new McpServer({
    name: options.serverName ?? DEFAULT_SERVER_NAME,
    version: options.serverVersion ?? DEFAULT_SERVER_VERSION,
  });

  mcp.registerTool(
    STUB_TOOL_NAME,
    {
      description: "Stub MCP tool that replies with pong",
      inputSchema: PingToolInput,
    },
    async (input: { message?: string }) => {
      const text = input.message
        ? `pong (${options.target}) - ${input.message}`
        : `pong (${options.target})`;

      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
        isError: false,
      };
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
  const mcp = createStubMcpServer(options);

  try {
    await mcp.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }
};
