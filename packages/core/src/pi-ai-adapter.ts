/**
 * pi-ai adapter — implements our LanguageModel interface using pi-ai.
 *
 * Supports Claude Max (via ANTHROPIC_OAUTH_TOKEN), Anthropic API keys,
 * and any other provider pi-ai supports.
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
import { Type } from "@sinclair/typebox";
import type { LanguageModel, Message, GenerateResult, ToolCall } from "./agent.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PiAiModelOptions {
  /** pi-ai provider name (e.g., "anthropic", "openai"). Defaults to "anthropic". */
  readonly provider?: string | undefined;
  /** pi-ai model ID (e.g., "claude-sonnet-4-5"). Defaults to "claude-sonnet-4-5". */
  readonly modelId?: string | undefined;
  /** API key. If not provided, uses ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY env vars. */
  readonly apiKey?: string | undefined;
  /** Thinking level for reasoning models. */
  readonly reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  /** Max tokens for the response. */
  readonly maxTokens?: number | undefined;
}

// ---------------------------------------------------------------------------
// The run_code tool definition for pi-ai (TypeBox schema)
// ---------------------------------------------------------------------------

const RUN_CODE_TOOL: PiTool = {
  name: "run_code",
  description:
    "Execute TypeScript code in a sandboxed environment. The code has access to a `tools` object with typed methods for interacting with external services. The code should use `return` to return a value.",
  parameters: Type.Object({
    code: Type.String({
      description: "The TypeScript code to execute. Use `await tools.<namespace>.<method>(input)` to call tools. Use `return` to return a value.",
    }),
  }),
};

// ---------------------------------------------------------------------------
// Message conversion: our format → pi-ai format
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
      if ("toolCalls" in msg && msg.toolCalls) {
        // Assistant message with tool calls
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
        // Plain text assistant message
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
        toolCallId: msg.toolCallId,
        toolName: "run_code",
        content: [{ type: "text", text: msg.content }],
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage);
      continue;
    }
  }

  return { systemPrompt, piMessages };
}

// ---------------------------------------------------------------------------
// Response conversion: pi-ai format → our format
// ---------------------------------------------------------------------------

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
    // Skip thinking blocks
  }

  const text = textParts.join("") || undefined;

  if (toolCalls.length > 0) {
    return { text, toolCalls };
  }

  return { text };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Create a LanguageModel backed by pi-ai.
 *
 * Works with Claude Max (set ANTHROPIC_OAUTH_TOKEN env var),
 * Anthropic API keys (set ANTHROPIC_API_KEY), or any pi-ai provider.
 */
export function createPiAiModel(options: PiAiModelOptions = {}): LanguageModel {
  const {
    provider = "anthropic",
    modelId = "claude-sonnet-4-5",
    apiKey,
    reasoning,
    maxTokens = 8192,
  } = options;

  const model = getModel(provider as Parameters<typeof getModel>[0], modelId as never);

  return {
    async generate(messages: Message[]): Promise<GenerateResult> {
      const { systemPrompt, piMessages } = convertMessages(messages);

      const context: PiContext = {
        messages: piMessages,
        tools: [RUN_CODE_TOOL],
      };
      if (systemPrompt !== undefined) {
        context.systemPrompt = systemPrompt;
      }

      const streamOptions: SimpleStreamOptions = {
        maxTokens,
      };

      if (apiKey) {
        streamOptions.apiKey = apiKey;
      }

      if (reasoning) {
        streamOptions.reasoning = reasoning;
      }

      const response = await completeSimple(model, context, streamOptions);

      return convertResponse(response);
    },
  };
}
