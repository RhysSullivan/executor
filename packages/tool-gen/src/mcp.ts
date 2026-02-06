/**
 * MCP tool generator — introspects an MCP server and produces a ToolTree.
 *
 * Connects to an MCP server via SSE or Streamable HTTP transport,
 * fetches the tool list, and converts each tool into a defineTool()
 * with Zod schemas derived from the JSON Schema in the tool definitions.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ApprovalMode, type ToolTree } from "@openassistant/core";
import { jsonSchemaToZod, jsonSchemaToTypeString, type JsonSchema } from "./json-schema-to-ts.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface McpToolSource {
  /** Namespace in the tool tree: `tools.<name>.<toolName>` */
  readonly name: string;
  /** URL of the MCP server (SSE or Streamable HTTP endpoint) */
  readonly url: string;
  /** Transport type. Defaults to trying streamable HTTP first, falling back to SSE. */
  readonly transport?: "sse" | "streamable-http" | undefined;
  /** Per-tool overrides for approval mode. Key is the MCP tool name. */
  readonly overrides?: Readonly<Record<string, {
    readonly approval?: ApprovalMode | undefined;
  }>> | undefined;
  /** Default approval mode for tools. Defaults to "auto". */
  readonly defaultApproval?: ApprovalMode | undefined;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface McpGenerateResult {
  /** The generated tool tree, namespaced under the source name. */
  readonly tools: ToolTree;
  /** TypeScript declarations for the typechecker. */
  readonly typeDeclaration: string;
  /** Human-readable descriptions for the LLM prompt. */
  readonly promptGuidance: string;
  /** The MCP client (keep alive for making tool calls). */
  readonly client: Client;
  /** Cleanup function to close the connection. */
  readonly close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function connectMcp(
  url: string,
  transport?: "sse" | "streamable-http",
): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client(
    { name: "openassistant-tool-gen", version: "0.1.0" },
    { capabilities: {} },
  );

  const parsedUrl = new URL(url);

  if (transport === "sse") {
    const sseTransport = new SSEClientTransport(parsedUrl);
    await client.connect(sseTransport);
    return { client, close: () => client.close() };
  }

  if (transport === "streamable-http") {
    const httpTransport = new StreamableHTTPClientTransport(parsedUrl);
    await client.connect(httpTransport as Parameters<typeof client.connect>[0]);
    return { client, close: () => client.close() };
  }

  // Try streamable HTTP first, fall back to SSE
  try {
    const httpTransport = new StreamableHTTPClientTransport(parsedUrl);
    await client.connect(httpTransport as Parameters<typeof client.connect>[0]);
    return { client, close: () => client.close() };
  } catch {
    const sseTransport = new SSEClientTransport(parsedUrl);
    await client.connect(sseTransport);
    return { client, close: () => client.close() };
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export async function generateMcpTools(
  source: McpToolSource,
): Promise<McpGenerateResult> {
  const { client, close } = await connectMcp(source.url, source.transport);

  const { tools: mcpTools } = await client.listTools();

  const toolTree: Record<string, ReturnType<typeof defineTool>> = {};
  const typeLines: string[] = [];
  const guidanceLines: string[] = [];

  for (const mcpTool of mcpTools) {
    const toolName = mcpTool.name;
    const description = mcpTool.description ?? `MCP tool: ${toolName}`;
    const inputSchema = (mcpTool.inputSchema as JsonSchema | undefined) ?? { type: "object" };

    const approval =
      source.overrides?.[toolName]?.approval ??
      source.defaultApproval ??
      "auto";

    // Generate Zod schema from JSON Schema
    const argsZod = jsonSchemaToZod(inputSchema);

    // Generate TypeScript type string for declarations
    const argsTypeString = jsonSchemaToTypeString(inputSchema);

    // Create the tool definition
    toolTree[toolName] = defineTool({
      description,
      approval,
      args: argsZod,
      returns: z.any(), // MCP tools return opaque content
      run: async (input: unknown) => {
        const result = await client.callTool({
          name: toolName,
          arguments: input as Record<string, unknown>,
        });
        // MCP returns { content: [{ type, text, ... }] }
        // Extract text content for simplicity
        if (result.content && Array.isArray(result.content)) {
          const textParts = result.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { text?: string }) => c.text)
            .filter(Boolean);
          if (textParts.length === 1) return textParts[0];
          if (textParts.length > 1) return textParts;
        }
        return result.content;
      },
    });

    // Build TypeScript declaration
    const approvalNote = approval === "required" ? " (approval required)" : " (auto-approved)";
    typeLines.push(`  /** ${description} */`);
    typeLines.push(`  ${toolName}(input: ${argsTypeString}): Promise<any>;`);

    guidanceLines.push(
      `- tools.${source.name}.${toolName}(${argsTypeString}): Promise<any>${approvalNote} — ${description}`,
    );
  }

  const typeDeclaration = `${source.name}: {\n${typeLines.join("\n")}\n}`;
  const promptGuidance = guidanceLines.join("\n");

  return {
    tools: { [source.name]: toolTree },
    typeDeclaration,
    promptGuidance,
    client,
    close,
  };
}
