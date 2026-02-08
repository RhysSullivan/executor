/**
 * Agent loop — orchestrates Claude + executor via MCP.
 *
 * 1. Connect to executor MCP server
 * 2. List tools (gets run_code with sandbox tool inventory in description)
 * 3. Call Claude → get run_code({ code }) tool call
 * 4. Forward to executor via MCP tools/call (blocks until done)
 * 5. Feed result back to Claude
 * 6. Loop until Claude responds with text
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TaskEvent } from "./events";
import type { Message, GenerateResult, ToolCall, ToolDef } from "./model";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface AgentOptions {
  readonly executorUrl: string;
  readonly generate: (messages: Message[], tools?: ToolDef[]) => Promise<GenerateResult>;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly clientId?: string;
  readonly context?: string;
  readonly maxToolCalls?: number;
}

export interface AgentResult {
  readonly text: string;
  readonly toolCalls: number;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(tools: McpTool[], context?: string): string {
  const toolSection = tools
    .map((t) => `### ${t.name}\n${t.description ?? "No description."}`)
    .join("\n\n");

  const contextSection = context ? `\n## Context\n\n${context}\n` : "";

  return `You are an AI assistant that executes tasks by writing TypeScript code.
${contextSection}
## Available Tools

${toolSection}

## Instructions

- Use the \`run_code\` tool to execute TypeScript code
- Write complete, self-contained scripts — do all work in a single run_code call when possible
- The code runs in a sandbox — only \`tools.*\` calls are available (no fetch, require, import)
- Handle errors with try/catch
- Return a structured result, then summarize what happened
- Be concise and accurate — base your response on actual tool results`;
}

// ---------------------------------------------------------------------------
// MCP client helpers
// ---------------------------------------------------------------------------

async function connectMcp(executorUrl: string, workspaceId: string, actorId: string, clientId?: string): Promise<Client> {
  const url = new URL(`${executorUrl}/mcp`);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("actorId", actorId);
  if (clientId) url.searchParams.set("clientId", clientId);

  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "assistant-agent", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function listMcpTools(client: Client): Promise<McpTool[]> {
  const result = await client.listTools();
  return result.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown> | undefined,
  }));
}

async function callMcpTool(client: Client, name: string, args: Record<string, unknown>): Promise<{
  content: string;
  isError: boolean;
}> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
  return { content: text, isError: result.isError === true };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export function createAgent(options: AgentOptions) {
  return {
    async run(prompt: string, onEvent?: (event: TaskEvent) => void): Promise<AgentResult> {
      const {
        executorUrl,
        generate,
        workspaceId,
        actorId,
        clientId,
        context,
        maxToolCalls = 20,
      } = options;

      function emit(event: TaskEvent): void {
        onEvent?.(event);
      }

      // 1. Connect to executor MCP
      emit({ type: "status", message: "Connecting..." });
      let mcp: Client;
      try {
        mcp = await connectMcp(executorUrl, workspaceId, actorId, clientId);
      } catch (err) {
        const msg = `Failed to connect to executor MCP: ${err instanceof Error ? err.message : String(err)}`;
        emit({ type: "error", error: msg });
        emit({ type: "completed" });
        return { text: msg, toolCalls: 0 };
      }

      try {
        // 2. List tools (run_code description includes sandbox tool inventory)
        emit({ type: "status", message: "Loading tools..." });
        const tools = await listMcpTools(mcp);

        if (tools.length === 0) {
          const msg = "No tools available from executor";
          emit({ type: "error", error: msg });
          emit({ type: "completed" });
          return { text: msg, toolCalls: 0 };
        }

        // 3. Build system prompt + messages
        const systemPrompt = buildSystemPrompt(tools, context);
        const messages: Message[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ];

        // Convert MCP tools to model tool defs
        const toolDefs: ToolDef[] = tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));

        emit({ type: "status", message: "Thinking..." });

        let toolCallCount = 0;

        // 4. Agent loop
        while (toolCallCount < maxToolCalls) {
          const response = await generate(messages, toolDefs);

          // No tool calls → done
          if (!response.toolCalls || response.toolCalls.length === 0) {
            const text = response.text ?? "";
            emit({ type: "agent_message", text });
            emit({ type: "completed" });
            return { text, toolCalls: toolCallCount };
          }

          for (const toolCall of response.toolCalls) {
            toolCallCount++;

            // Emit events
            if (toolCall.name === "run_code" && toolCall.args["code"]) {
              emit({ type: "code_generated", code: String(toolCall.args["code"]) });
            }
            emit({ type: "status", message: `Running ${toolCall.name}...` });

            // 5. Forward to executor via MCP
            const result = await callMcpTool(mcp, toolCall.name, toolCall.args);

            // Emit result
            emit({
              type: "code_result",
              taskId: "",
              status: result.isError ? "failed" : "completed",
              stdout: result.isError ? undefined : result.content,
              error: result.isError ? result.content : undefined,
            });

            // 6. Feed result back to model
            messages.push({ role: "assistant", content: "", toolCalls: [toolCall] });
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              content: result.content,
            });
          }
        }

        const text = "Reached maximum number of tool calls.";
        emit({ type: "agent_message", text });
        emit({ type: "completed" });
        return { text, toolCalls: toolCallCount };
      } finally {
        await mcp.close().catch(() => {});
      }
    },
  };
}
