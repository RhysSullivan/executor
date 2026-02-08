/**
 * Agent — connects to executor via MCP, calls Claude, runs code.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  completeSimple,
  getModel,
  type Context as PiContext,
  type Message as PiMessage,
  type UserMessage,
  type AssistantMessage as PiAssistantMessage,
  type ToolResultMessage,
  type Tool as PiTool,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall as PiToolCall,
} from "@mariozechner/pi-ai";
import { readFileSync } from "node:fs";
import type { TaskEvent } from "./events";

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function resolveApiKey(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (typeof process !== "undefined") {
    if (process.env.ANTHROPIC_OAUTH_TOKEN) return process.env.ANTHROPIC_OAUTH_TOKEN;
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  }
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const text = readFileSync(`${home}/.claude/.credentials.json`, "utf-8");
    const creds = JSON.parse(text);
    const token = (creds as Record<string, Record<string, unknown>>)?.["claudeAiOauth"]?.["accessToken"];
    if (typeof token === "string" && token.startsWith("sk-ant-")) return token;
  } catch {}
  return undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  toolCallId?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export interface AgentOptions {
  readonly executorUrl: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly clientId?: string;
  readonly apiKey?: string;
  readonly modelId?: string;
  readonly context?: string;
  readonly maxToolCalls?: number;
}

export interface AgentResult {
  readonly text: string;
  readonly toolCalls: number;
}

// ---------------------------------------------------------------------------
// pi-ai conversions (inline, no separate module)
// ---------------------------------------------------------------------------

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function toPiMessages(messages: Message[]): { systemPrompt?: string; piMessages: PiMessage[] } {
  let systemPrompt: string | undefined;
  const piMessages: PiMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt = msg.content;
    } else if (msg.role === "user") {
      piMessages.push({ role: "user", content: msg.content, timestamp: Date.now() } satisfies UserMessage);
    } else if (msg.role === "assistant") {
      if (msg.toolCalls?.length) {
        const content: (TextContent | PiToolCall)[] = [];
        if (msg.content) content.push({ type: "text", text: msg.content });
        for (const tc of msg.toolCalls) {
          content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args });
        }
        piMessages.push({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "", usage: EMPTY_USAGE, stopReason: "toolUse", timestamp: Date.now() } satisfies PiAssistantMessage);
      } else {
        piMessages.push({ role: "assistant", content: [{ type: "text", text: msg.content }], api: "anthropic-messages", provider: "anthropic", model: "", usage: EMPTY_USAGE, stopReason: "stop", timestamp: Date.now() } satisfies PiAssistantMessage);
      }
    } else if (msg.role === "tool") {
      piMessages.push({ role: "toolResult", toolCallId: msg.toolCallId!, toolName: "run_code", content: [{ type: "text", text: msg.content }], isError: false, timestamp: Date.now() } satisfies ToolResultMessage);
    }
  }

  return { systemPrompt, piMessages };
}

function fromPiResponse(response: PiAssistantMessage): { text?: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] } {
  const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
  const textParts: string[] = [];

  for (const block of response.content) {
    if (block.type === "text") textParts.push((block as TextContent).text);
    else if (block.type === "toolCall") {
      const tc = block as PiToolCall;
      toolCalls.push({ id: tc.id, name: tc.name, args: tc.arguments });
    }
  }

  return {
    text: textParts.join("") || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export function createAgent(options: AgentOptions) {
  const {
    executorUrl,
    workspaceId,
    actorId,
    clientId,
    apiKey,
    modelId = "claude-sonnet-4-5",
    context,
    maxToolCalls = 20,
  } = options;

  const resolvedApiKey = resolveApiKey(apiKey);
  const model = getModel("anthropic", modelId as never);
  const executorBaseUrl = (() => {
    const raw = executorUrl.trim().replace(/\/$/, "");
    if (/^https?:\/\//.test(raw)) return raw;
    if (raw.includes(".convex.cloud")) return raw.replace(".convex.cloud", ".convex.site");
    throw new Error(`Invalid executorUrl: expected http(s) URL, got '${executorUrl}'`);
  })();

  async function generate(messages: Message[], tools: McpTool[]) {
    const { systemPrompt, piMessages } = toPiMessages(messages);
    const piTools: PiTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as PiTool["parameters"],
    }));

    const ctx: PiContext = { messages: piMessages, tools: piTools };
    if (systemPrompt) ctx.systemPrompt = systemPrompt;

    const opts: SimpleStreamOptions = { maxTokens: 8192 };
    if (resolvedApiKey) opts.apiKey = resolvedApiKey;

    return fromPiResponse(await completeSimple(model, ctx, opts));
  }

  return {
    async run(prompt: string, onEvent?: (event: TaskEvent) => void): Promise<AgentResult> {
      function emit(event: TaskEvent) { onEvent?.(event); }

      // Connect to executor MCP
      emit({ type: "status", message: "Connecting..." });
      const mcpUrl = new URL(`${executorBaseUrl}/mcp`);
      mcpUrl.searchParams.set("workspaceId", workspaceId);
      mcpUrl.searchParams.set("actorId", actorId);
      if (clientId) mcpUrl.searchParams.set("clientId", clientId);

      const transport = new StreamableHTTPClientTransport(mcpUrl);
      const mcp = new Client({ name: "assistant-agent", version: "0.1.0" });

      let mcpConnected = false;
      try {
        await withTimeout(mcp.connect(transport), 20_000, "MCP connection");
        mcpConnected = true;
      } catch (err) {
        const msg = `Failed to connect to executor MCP: ${err instanceof Error ? err.message : String(err)}`;
        emit({ type: "error", error: msg });
        emit({ type: "completed" });
        return { text: msg, toolCalls: 0 };
      }

      try {
        // List tools
        emit({ type: "status", message: "Loading tools..." });
        const { tools: rawTools } = await withTimeout(mcp.listTools(), 20_000, "MCP listTools");
        const tools: McpTool[] = rawTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        }));

        if (tools.length === 0) {
          emit({ type: "error", error: "No tools available" });
          emit({ type: "completed" });
          return { text: "No tools available", toolCalls: 0 };
        }

        // Build system prompt
        const toolSection = tools
          .map((t) => `### ${t.name}\n${t.description ?? "No description."}`)
          .join("\n\n");

        const contextBlock = context ? `\n## Context\n\n${context}\n` : "";

        const systemPrompt = `You are an AI assistant that executes tasks by writing TypeScript code.
${contextBlock}
## Available Tools

${toolSection}

## Instructions

- Use the \`run_code\` tool to execute TypeScript code
- Write complete, self-contained scripts — do all work in a single run_code call when possible
- TypeScript syntax is allowed; prefer simple runnable scripts over heavy type scaffolding
- The code runs in a sandbox — only \`tools.*\` calls are available (no fetch, require, import)
- Handle errors with try/catch
- Return a structured result, then summarize what happened
- Be concise and accurate — base your response on actual tool results`;

        const messages: Message[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ];

        emit({ type: "status", message: "Thinking..." });

        let toolCallCount = 0;

        // Agent loop
        while (toolCallCount < maxToolCalls) {
          const response = await withTimeout(generate(messages, tools), 90_000, "Model response");

          if (!response.toolCalls?.length) {
            const text = response.text ?? "";
            emit({ type: "agent_message", text });
            emit({ type: "completed" });
            return { text, toolCalls: toolCallCount };
          }

          for (const tc of response.toolCalls) {
            toolCallCount++;

            if (tc.name === "run_code" && tc.args["code"]) {
              emit({ type: "code_generated", code: String(tc.args["code"]) });
            }
            emit({ type: "status", message: `Running ${tc.name}...` });

            // Call tool via MCP
            const result = await withTimeout(
              mcp.callTool({ name: tc.name, arguments: tc.args }),
              120_000,
              `MCP tool call (${tc.name})`,
            );
            const text = (result.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text!)
              .join("\n");

            emit({
              type: "code_result",
              taskId: "",
              status: result.isError ? "failed" : "completed",
              stdout: result.isError ? undefined : text,
              error: result.isError ? text : undefined,
            });

            messages.push({ role: "assistant", content: "", toolCalls: [tc] });
            messages.push({ role: "tool", toolCallId: tc.id, content: text });
          }
        }

        const text = "Reached maximum number of tool calls.";
        emit({ type: "agent_message", text });
        emit({ type: "completed" });
        return { text, toolCalls: toolCallCount };
      } finally {
        if (mcpConnected) await mcp.close().catch(() => {});
      }
    },
  };
}
