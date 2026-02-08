/**
 * Agent loop — orchestrates Claude + executor.
 *
 * 1. Fetch tool inventory from executor
 * 2. Build system prompt with tool descriptions
 * 3. Call Claude → get run_code({ code }) tool call
 * 4. Send code to executor via sync endpoint (blocks until done)
 * 5. Feed result back to Claude
 * 6. Loop until Claude responds with text
 */

import type { ExecutorClient } from "@assistant/agent-executor-adapter";
import type { TaskEvent } from "./events";
import type { Message, GenerateResult } from "./model";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  path: string;
  description: string;
  approval: "auto" | "required";
  source?: string;
  argsType?: string;
  returnsType?: string;
}

export interface AgentOptions {
  readonly executor: ExecutorClient;
  readonly generate: (messages: Message[]) => Promise<GenerateResult>;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly clientId?: string;
  readonly context?: string;
  readonly maxCodeRuns?: number;
  readonly timeoutMs?: number;
}

export interface AgentResult {
  readonly text: string;
  readonly codeRuns: number;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(tools: ToolDescriptor[], context?: string): string {
  const toolGuidance = tools
    .map((t) => {
      const args = t.argsType ?? "unknown";
      const returns = t.returnsType ?? "unknown";
      const approval = t.approval === "required" ? " (approval required)" : "";
      return `- tools.${t.path}(${args}): Promise<${returns}>${approval} — ${t.description}`;
    })
    .join("\n");

  const discoveryNote = tools.some((t) => t.path === "discover")
    ? `\n\n## Tool Discovery\n\nUse \`tools.discover({ query })\` to search for tools by keyword when you need to find specific capabilities.\n`
    : "";

  const contextSection = context ? `\n## Context\n\n${context}\n` : "";

  return `You are an AI assistant that executes tasks by generating TypeScript code.

You have access to tools via the \`tools\` object. Generate TypeScript code that calls these tools to accomplish the user's task.
${contextSection}
## Available Tools

${toolGuidance}
${discoveryNote}
## Instructions

- Use the \`run_code\` tool to execute TypeScript code
- Write complete, self-contained scripts — do all work in a single run_code call when possible
- The code runs in a sandbox — only \`tools.*\` calls are available (no fetch, require, import)
- Handle errors with try/catch
- Return a structured result, then summarize what happened
- Be concise and accurate — base your response on actual tool results`;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export function createAgent(options: Omit<AgentOptions, "onEvent">) {
  return {
    async run(prompt: string, onEvent?: (event: TaskEvent) => void): Promise<AgentResult> {
      const {
        executor,
        generate,
        workspaceId,
        actorId,
        clientId,
        context,
        maxCodeRuns = 20,
        timeoutMs = 30_000,
      } = options;

      function emit(event: TaskEvent): void {
        onEvent?.(event);
      }

      // 1. Fetch tool inventory
      emit({ type: "status", message: "Loading tools..." });
      const { data: tools, error: toolsError } = await executor.api.tools.get({
        query: { workspaceId, actorId, clientId },
      });

      if (toolsError || !tools) {
        const msg = "Failed to load tools from executor";
        emit({ type: "error", error: msg });
        emit({ type: "completed" });
        return { text: msg, codeRuns: 0 };
      }

      // 2. Build system prompt + messages
      const systemPrompt = buildSystemPrompt(tools as ToolDescriptor[], context);
      const messages: Message[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ];

      emit({ type: "status", message: "Thinking..." });

      let codeRunCount = 0;

      // 3. Agent loop
      while (codeRunCount < maxCodeRuns) {
        const response = await generate(messages);

        // No tool calls → done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          const text = response.text ?? "";
          emit({ type: "agent_message", text });
          emit({ type: "completed" });
          return { text, codeRuns: codeRunCount };
        }

        for (const toolCall of response.toolCalls) {
          if (toolCall.name !== "run_code") {
            messages.push({ role: "assistant", content: "", toolCalls: [toolCall] });
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
          emit({ type: "status", message: "Running code..." });

          // 4. Sync call to executor — blocks until task completes
          const { data: result, error: runError } = await executor.api.tasks.run.post({
            code,
            workspaceId,
            actorId,
            clientId,
            timeoutMs,
          });

          if (runError || !result) {
            const errMsg = "Failed to execute code on executor";
            messages.push({ role: "assistant", content: "", toolCalls: [toolCall] });
            messages.push({ role: "tool", toolCallId: toolCall.id, content: `Error: ${errMsg}` });
            continue;
          }

          const r = result as { taskId?: string; status: string; stdout?: string; stderr?: string; error?: string; exitCode?: number };

          // 5. Emit result event
          emit({
            type: "code_result",
            taskId: r.taskId ?? "",
            status: r.status,
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
            error: r.error,
          });

          // 6. Feed result back to model
          const resultContent = r.status === "completed"
            ? `Code executed successfully.\n${r.stdout ? `\nOutput:\n${r.stdout}` : ""}${r.stderr ? `\nStderr:\n${r.stderr}` : ""}`
            : `Code execution failed (${r.status}).\n${r.error ? `Error: ${r.error}` : ""}${r.stderr ? `\nStderr:\n${r.stderr}` : ""}`;

          messages.push({ role: "assistant", content: "", toolCalls: [toolCall] });
          messages.push({ role: "tool", toolCallId: toolCall.id, content: resultContent });
        }
      }

      const text = "Reached maximum number of code executions.";
      emit({ type: "agent_message", text });
      emit({ type: "completed" });
      return { text, codeRuns: codeRunCount };
    },
  };
}
