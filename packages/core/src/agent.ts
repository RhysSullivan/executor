/**
 * Agent loop — orchestrates Claude + codemode runner.
 *
 * 1. Build system prompt from tool descriptions
 * 2. Call Claude with the prompt and the run_code tool
 * 3. Claude responds with run_code({ code: "..." })
 * 4. Typecheck the code
 * 5. If typecheck fails: feed error back, retry (up to maxRetries)
 * 6. Execute in sandbox
 * 7. Collect receipts, feed back to Claude
 * 8. Claude may call run_code again or produce final text
 */

import type { ToolTree, ApprovalDecision, ApprovalRequest, ToolCallReceipt } from "./tools.js";
import type { RunResult } from "./runner.js";
import { createRunner } from "./runner.js";
import { generateToolDeclarations, generatePromptGuidance, typecheckCode } from "./typechecker.js";
import type { TaskEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A language model interface — thin abstraction over AI SDK or any LLM.
 * We don't import AI SDK directly to keep core dependency-free.
 */
export interface LanguageModel {
  /**
   * Generate a response given messages.
   * The model should be configured with the run_code tool.
   * Returns either text or a tool call.
   */
  generate(messages: Message[]): Promise<GenerateResult>;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GenerateResult {
  text?: string | undefined;
  toolCalls?: ToolCall[] | undefined;
}

export interface AgentOptions {
  /** The tool tree to expose to the agent. */
  readonly tools: ToolTree;
  /** The language model to use. */
  readonly model: LanguageModel;
  /** Called when a tool needs approval. */
  readonly requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Called for each task event. */
  readonly onEvent?: ((event: TaskEvent) => void) | undefined;
  /** Maximum typecheck retries per run_code call. Defaults to 3. */
  readonly maxTypecheckRetries?: number | undefined;
  /** Maximum total run_code calls per agent turn. Defaults to 10. */
  readonly maxCodeRuns?: number | undefined;
  /** Execution timeout per code run in ms. Defaults to 30_000. */
  readonly timeoutMs?: number | undefined;
}

export interface AgentResult {
  readonly text: string;
  readonly runs: readonly CodeRun[];
  readonly allReceipts: readonly ToolCallReceipt[];
}

export interface CodeRun {
  readonly code: string;
  readonly typecheckOk: boolean;
  readonly result: RunResult;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(tools: ToolTree): string {
  const guidance = generatePromptGuidance(tools);
  return `You are an AI assistant that executes tasks by generating TypeScript code.

You have access to a set of tools via the \`tools\` object. When the user asks you to do something, generate TypeScript code that calls these tools to accomplish the task.

## Available Tools

${guidance}

## Instructions

- Use the \`run_code\` tool to execute TypeScript code
- The code runs in a sandboxed environment — only \`tools.*\` calls are available
- No \`fetch\`, \`process\`, \`require\`, or \`import\` — use tools for all external interactions
- Write clean, straightforward TypeScript
- Handle errors gracefully — if a tool call is denied, continue with remaining work
- After execution, summarize what happened based on the tool call receipts
- Be concise and accurate — base your response on actual tool results, not assumptions`;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export function createAgent(options: AgentOptions): {
  run(prompt: string): Promise<AgentResult>;
} {
  const {
    tools,
    model,
    requestApproval,
    onEvent,
    maxTypecheckRetries = 3,
    maxCodeRuns = 10,
    timeoutMs = 30_000,
  } = options;

  const toolDeclarations = generateToolDeclarations(tools);

  const runner = createRunner({
    tools,
    requestApproval,
    timeoutMs,
  });

  function emit(event: TaskEvent): void {
    onEvent?.(event);
  }

  return {
    async run(prompt: string): Promise<AgentResult> {
      const systemPrompt = buildSystemPrompt(tools);
      const runs: CodeRun[] = [];
      const allReceipts: ToolCallReceipt[] = [];

      const messages: Message[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ];

      emit({ type: "status", message: "Thinking..." });

      let codeRunCount = 0;

      while (codeRunCount < maxCodeRuns) {
        const response = await model.generate(messages);

        // If the model returned text without tool calls, we're done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          const text = response.text ?? "";
          emit({ type: "agent_message", text });
          emit({ type: "completed", receipts: allReceipts });
          return { text, runs, allReceipts };
        }

        // Process each tool call (should be run_code)
        for (const toolCall of response.toolCalls) {
          if (toolCall.name !== "run_code") {
            // Unknown tool call — tell the model
            messages.push({
              role: "assistant",
              content: "",
              toolCalls: [toolCall],
            });
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              content: `Error: Unknown tool "${toolCall.name}". Use run_code to execute TypeScript code.`,
            });
            continue;
          }

          const code = String(toolCall.args["code"] ?? "");
          codeRunCount++;

          emit({ type: "code_generated", code });

          // Typecheck with retries
          let finalCode = code;
          let typecheckOk = false;
          let typecheckErrors: readonly string[] = [];

          for (let attempt = 0; attempt <= maxTypecheckRetries; attempt++) {
            const check = typecheckCode(finalCode, toolDeclarations);
            if (check.ok) {
              typecheckOk = true;
              break;
            }
            typecheckErrors = check.errors;

            if (attempt < maxTypecheckRetries) {
              emit({
                type: "status",
                message: `Typecheck failed (attempt ${attempt + 1}/${maxTypecheckRetries + 1}), retrying...`,
              });

              // Ask the model to fix the code
              const fixMessages: Message[] = [
                ...messages,
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [toolCall],
                },
                {
                  role: "tool",
                  toolCallId: toolCall.id,
                  content: `Typecheck errors:\n${check.errors.join("\n")}\n\nPlease fix the code and try again.`,
                },
              ];

              const fixResponse = await model.generate(fixMessages);
              if (fixResponse.toolCalls?.[0]?.name === "run_code") {
                finalCode = String(fixResponse.toolCalls[0].args["code"] ?? "");
                emit({ type: "code_generated", code: finalCode });
              } else {
                // Model gave up — use the original code
                break;
              }
            }
          }

          // Execute the code
          emit({ type: "status", message: "Running code..." });
          const result = await runner.run(finalCode);

          // Emit receipts
          for (const receipt of result.receipts) {
            emit({ type: "tool_result", receipt });
            allReceipts.push(receipt);
          }

          runs.push({ code: finalCode, typecheckOk, result });

          // Build the tool result message for the model
          const receiptSummary = result.receipts
            .map((r) => {
              const status = r.status === "succeeded" ? "OK" : r.status === "denied" ? "DENIED" : "FAILED";
              const output = r.outputPreview ? ` → ${r.outputPreview}` : "";
              const error = r.error ? ` (${r.error})` : "";
              return `[${status}] ${r.toolPath}(${r.inputPreview})${output}${error}`;
            })
            .join("\n");

          const resultContent = typecheckOk
            ? result.ok
              ? `Code executed successfully.\n\nTool call results:\n${receiptSummary}\n\nReturn value: ${JSON.stringify(result.value)}`
              : `Code execution had issues.\n\nTool call results:\n${receiptSummary}\n\nError: ${result.error}`
            : `Typecheck failed after ${maxTypecheckRetries + 1} attempts:\n${typecheckErrors.join("\n")}`;

          messages.push({
            role: "assistant",
            content: "",
            toolCalls: [{ ...toolCall, args: { code: finalCode } }],
          });
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: resultContent,
          });
        }
      }

      // Hit max code runs
      const text = "Reached maximum number of code executions.";
      emit({ type: "agent_message", text });
      emit({ type: "completed", receipts: allReceipts });
      return { text, runs, allReceipts };
    },
  };
}
