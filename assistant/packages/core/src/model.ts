/**
 * LLM adapter — wraps pi-ai to implement a simple generate interface.
 *
 * Tools are passed dynamically per call (from MCP tools/list).
 */

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface GenerateResult {
  text?: string;
  toolCalls?: ToolCall[];
}

export interface ModelOptions {
  provider?: string;
  modelId?: string;
  apiKey?: string;
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Tool conversion (MCP → pi-ai)
// ---------------------------------------------------------------------------

function convertTool(tool: ToolDef): PiTool {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as PiTool["parameters"],
  };
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function convertMessages(messages: Message[]): { systemPrompt: string | undefined; piMessages: PiMessage[] } {
  let systemPrompt: string | undefined;
  const piMessages: PiMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt = msg.content;
      continue;
    }

    if (msg.role === "user") {
      piMessages.push({
        role: "user",
        content: msg.content,
        timestamp: Date.now(),
      } satisfies UserMessage);
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const content: (TextContent | PiToolCall)[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            arguments: tc.args,
          });
        }
        piMessages.push({
          role: "assistant",
          content,
          api: "anthropic-messages",
          provider: "anthropic",
          model: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        } satisfies PiAssistantMessage);
      } else {
        piMessages.push({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        } satisfies PiAssistantMessage);
      }
      continue;
    }

    if (msg.role === "tool") {
      piMessages.push({
        role: "toolResult",
        toolCallId: msg.toolCallId!,
        toolName: "run_code",
        content: [{ type: "text", text: msg.content }],
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage);
    }
  }

  return { systemPrompt, piMessages };
}

function convertResponse(response: PiAssistantMessage): GenerateResult {
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      textParts.push((block as TextContent).text);
    } else if (block.type === "toolCall") {
      const tc = block as PiToolCall;
      toolCalls.push({
        id: tc.id,
        name: tc.name,
        args: tc.arguments,
      });
    }
  }

  return {
    text: textParts.join("") || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

// ---------------------------------------------------------------------------
// Model factory
// ---------------------------------------------------------------------------

export function createModel(options: ModelOptions = {}) {
  const {
    provider = "anthropic",
    modelId = "claude-sonnet-4-5",
    apiKey,
    reasoning,
    maxTokens = 8192,
  } = options;

  const model = getModel(provider as Parameters<typeof getModel>[0], modelId as never);

  return {
    async generate(messages: Message[], tools?: ToolDef[]): Promise<GenerateResult> {
      const { systemPrompt, piMessages } = convertMessages(messages);

      const piTools: PiTool[] = tools?.map(convertTool) ?? [];

      const context: PiContext = {
        messages: piMessages,
        tools: piTools,
      };
      if (systemPrompt !== undefined) {
        context.systemPrompt = systemPrompt;
      }

      const streamOptions: SimpleStreamOptions = { maxTokens };
      if (apiKey) streamOptions.apiKey = apiKey;
      if (reasoning) streamOptions.reasoning = reasoning;

      const response = await completeSimple(model, context, streamOptions);
      return convertResponse(response);
    },
  };
}
