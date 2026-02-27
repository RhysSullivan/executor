import type { ExecuteRunResult, ExecutorRunClient } from "@executor-v2/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export type GatewayTarget = "local" | "remote";

export type ExecuteToolInput = {
  code: string;
  timeoutMs?: number;
};

export type ExecuteToolResult = {
  output?: unknown;
  error?: string;
  isError: boolean;
};

export type SourceControlListInput = {
  workspaceId: string;
};

export type SourceControlUpsertPayload = {
  id?: string;
  name: string;
  kind: "mcp" | "openapi" | "graphql" | "internal";
  endpoint: string;
  status?: "draft" | "probing" | "auth_required" | "connected" | "error";
  enabled?: boolean;
  configJson?: string;
  sourceHash?: string | null;
  lastError?: string | null;
};

export type SourceControlUpsertInput = {
  workspaceId: string;
  payload: SourceControlUpsertPayload;
};

export type SourceControlRemoveInput = {
  workspaceId: string;
  sourceId: string;
};

export type SourceControlClient = {
  listSources: (input: SourceControlListInput) => Promise<unknown>;
  upsertSource: (input: SourceControlUpsertInput) => Promise<unknown>;
  removeSource: (input: SourceControlRemoveInput) => Promise<unknown>;
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

  return {
    isError: true,
    error: result.error ?? `Run ${result.runId} ended with status ${result.status}`,
  };
};

export type McpGatewayOptions = {
  target: GatewayTarget;
  serverName?: string;
  serverVersion?: string;
  runClient: ExecutorRunClient;
  sourceControl?: SourceControlClient;
};

const DEFAULT_SERVER_NAME = "executor-v2";
const DEFAULT_SERVER_VERSION = "0.0.0";
const STUB_TOOL_NAME = "executor.ping";
const EXECUTE_TOOL_NAME = "executor.execute";
const SOURCES_LIST_TOOL_NAME = "tools.executor.sources.list";
const SOURCES_ADD_TOOL_NAME = "tools.executor.sources.add";
const SOURCES_REMOVE_TOOL_NAME = "tools.executor.sources.remove";

const PingToolInput = z.object({
  message: z.string().optional(),
});

const ExecuteToolInputSchema = z.object({
  code: z.string(),
  timeoutMs: z.number().int().positive().optional(),
});

const SourceListToolInputSchema = z.object({
  workspaceId: z.string(),
});

const SourceUpsertToolInputSchema = z.object({
  workspaceId: z.string(),
  id: z.string().optional(),
  name: z.string(),
  kind: z.enum(["mcp", "openapi", "graphql", "internal"]),
  endpoint: z.string(),
  status: z.enum(["draft", "probing", "auth_required", "connected", "error"]).optional(),
  enabled: z.boolean().optional(),
  configJson: z.string().optional(),
  sourceHash: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
});

const SourceRemoveToolInputSchema = z.object({
  workspaceId: z.string(),
  sourceId: z.string(),
});

const contentText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const registerSourceControlTools = (
  mcp: McpServer,
  sourceControl: SourceControlClient,
): void => {
  mcp.registerTool(
    SOURCES_LIST_TOOL_NAME,
    {
      description: "List sources for a workspace",
      inputSchema: SourceListToolInputSchema,
    },
    async (input: SourceControlListInput) => {
      try {
        const result = await sourceControl.listSources({
          workspaceId: input.workspaceId,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: contentText(result),
            },
          ],
          isError: false,
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

  mcp.registerTool(
    SOURCES_ADD_TOOL_NAME,
    {
      description: "Add or update a source for a workspace",
      inputSchema: SourceUpsertToolInputSchema,
    },
    async (input: z.infer<typeof SourceUpsertToolInputSchema>) => {
      try {
        const result = await sourceControl.upsertSource({
          workspaceId: input.workspaceId,
          payload: {
            id: input.id,
            name: input.name,
            kind: input.kind,
            endpoint: input.endpoint,
            status: input.status,
            enabled: input.enabled,
            configJson: input.configJson,
            sourceHash: input.sourceHash,
            lastError: input.lastError,
          },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: contentText(result),
            },
          ],
          isError: false,
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

  mcp.registerTool(
    SOURCES_REMOVE_TOOL_NAME,
    {
      description: "Remove a source from a workspace",
      inputSchema: SourceRemoveToolInputSchema,
    },
    async (input: SourceControlRemoveInput) => {
      try {
        const result = await sourceControl.removeSource({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: contentText(result),
            },
          ],
          isError: false,
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
};

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

  mcp.registerTool(
    EXECUTE_TOOL_NAME,
    {
      description: "Execute JavaScript against configured runtime",
      inputSchema: ExecuteToolInputSchema,
    },
    async (input: ExecuteToolInput) => {
      try {
        const result = toGatewayExecuteResult(
          await options.runClient.execute({
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

  if (options.sourceControl) {
    registerSourceControlTools(mcp, options.sourceControl);
  }

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
