"use node";

import { connectMcp, extractMcpResult } from "../mcp-runtime";
import { jsonSchemaTypeHintFallback } from "../openapi-schema-hints";
import { buildCredentialSpec, buildStaticAuthHeaders, getCredentialSourceKey } from "../tool-source-auth";
import { callMcpToolWithReconnect } from "../tool-source-execution";
import { sanitizeSegment } from "../tool-path-utils";
import type { McpToolSourceConfig } from "../tool-source-types";
import { compactArgTypeHint, compactReturnTypeHint } from "../type-hints";
import type { ToolDefinition } from "../types";
import { asRecord } from "../utils";
import type { SerializedTool } from "../tool-source-serialization";

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
  const tools = Array.isArray((listed as { tools?: unknown }).tools)
    ? ((listed as { tools: Array<Record<string, unknown>> }).tools)
    : [];

  return tools.map((tool) => {
    const toolName = String(tool.name ?? "tool");
    const inputSchema = asRecord(tool.inputSchema);
    const outputSchema = asRecord(tool.outputSchema);
    const argPreviewKeys = Object.keys(asRecord(inputSchema.properties)).filter((key) => key.length > 0);
    const argsType = jsonSchemaTypeHintFallback(inputSchema);
    const returnsType = Object.keys(outputSchema).length > 0
      ? jsonSchemaTypeHintFallback(outputSchema)
      : "unknown";
    return {
      path: `${sanitizeSegment(config.name)}.${sanitizeSegment(toolName)}`,
      source: `mcp:${config.name}`,
      approval: config.overrides?.[toolName]?.approval ?? config.defaultApproval ?? "auto",
      description: String(tool.description ?? `MCP tool ${toolName}`),
      metadata: {
        argsType,
        returnsType,
        displayArgsType: compactArgTypeHint(argsType),
        displayReturnsType: compactReturnTypeHint(returnsType),
        ...(argPreviewKeys.length > 0 ? { argPreviewKeys } : {}),
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
        const payload = asRecord(input);
        const result = await callToolWithReconnect(toolName, payload, context.credential?.headers);
        return extractMcpResult(result);
      },
    } satisfies ToolDefinition & { _runSpec: SerializedTool["runSpec"] };
  });
}
