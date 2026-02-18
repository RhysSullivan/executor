import { z } from "zod";
import { connectMcp, extractMcpResult } from "../mcp-runtime";
import { buildCredentialSpec, buildStaticAuthHeaders, getCredentialSourceKey } from "../tool/source-auth";
import { callMcpToolWithReconnect } from "../tool/source-execution";
import { sanitizeSegment } from "../tool/path-utils";
import type { McpToolSourceConfig } from "../tool/source-types";
import { buildPreviewKeys, extractTopLevelRequiredKeys } from "../tool-typing/schema-utils";
import type { ToolDefinition } from "../types";
import type { SerializedTool } from "../tool/source-serialization";

const listedToolsResponseSchema = z.object({
  tools: z.array(z.record(z.unknown())).optional(),
});

const recordSchema = z.record(z.unknown());

function coerceRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function normalizeJsonSchema(value: unknown): Record<string, unknown> {
  if (value === true) return {};
  if (value === false) return { not: {} };
  return coerceRecord(value);
}

function extractListedTools(value: unknown): Record<string, unknown>[] {
  const parsed = listedToolsResponseSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }

  return parsed.data.tools ?? [];
}

export async function loadMcpTools(config: McpToolSourceConfig): Promise<ToolDefinition[]> {
  const queryParams = config.queryParams
    ? Object.fromEntries(
      Object.entries(config.queryParams).map(([key, value]) => [key, String(value)]),
    )
      : undefined;
  const authHeaders = buildStaticAuthHeaders(config.auth);
  const discoveryHeaders = {
    ...authHeaders,
    ...(config.discoveryHeaders ?? {}),
  };
  const credentialSpec = buildCredentialSpec(getCredentialSourceKey(config), config.auth);

  let connection = await connectMcp(config.url, queryParams, config.transport, discoveryHeaders);

  async function callToolWithReconnect(
    name: string,
    input: Record<string, unknown>,
    credentialHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const mergedHeaders = {
      ...discoveryHeaders,
      ...(credentialHeaders ?? {}),
    };
    return await callMcpToolWithReconnect(
      () => connection.client.callTool({ name, arguments: input }),
      async () => {
        try {
          await connection.close();
        } catch {
          // ignore
        }

        connection = await connectMcp(config.url, queryParams, config.transport, mergedHeaders);
        return await connection.client.callTool({ name, arguments: input });
      },
    );
  }

  const listed = await connection.client.listTools();
  const tools = extractListedTools(listed);

  return tools.map((tool) => {
    const toolName = String(tool.name ?? "tool");
    const inputSchema = normalizeJsonSchema(tool.inputSchema);
    const outputSchema = normalizeJsonSchema(tool.outputSchema);
    const previewInputKeys = buildPreviewKeys(inputSchema).filter((key) => key.length > 0);
    const requiredInputKeys = extractTopLevelRequiredKeys(inputSchema);
    return {
      path: `${sanitizeSegment(config.name)}.${sanitizeSegment(toolName)}`,
      source: `mcp:${config.name}`,
      approval: config.overrides?.[toolName]?.approval ?? config.defaultApproval ?? "auto",
      description: String(tool.description ?? `MCP tool ${toolName}`),
      typing: {
        inputSchema,
        ...(Object.keys(outputSchema).length > 0 ? { outputSchema } : {}),
        ...(requiredInputKeys.length > 0 ? { requiredInputKeys } : {}),
        ...(previewInputKeys.length > 0 ? { previewInputKeys } : {}),
      },
      credential: credentialSpec,
      _runSpec: {
        kind: "mcp" as const,
        url: config.url,
        transport: config.transport,
        queryParams: config.queryParams,
        authHeaders,
        toolName,
      },
      run: async (input: unknown, context) => {
        const payload = coerceRecord(input);
        const result = await callToolWithReconnect(toolName, payload, context.credential?.headers);
        return extractMcpResult(result);
      },
    } satisfies ToolDefinition & { _runSpec: SerializedTool["runSpec"] };
  });
}
