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
 *
 * When the tool count exceeds DISCOVERY_THRESHOLD, the agent injects
 * a `tools.discover()` meta-tool so the LLM can search for relevant
 * tools by keyword instead of having all tools described in the prompt.
 */

import type { ToolTree, ApprovalDecision, ApprovalRequest, ToolCallReceipt } from "./tools.js";
import type { RunResult } from "./runner.js";
import { createRunner } from "./runner.js";
import { generateToolDeclarations, generatePromptGuidance, typecheckCode } from "./typechecker.js";
import { countTools, createDiscoverTool } from "./discovery.js";
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
  /**
   * Tool count threshold for enabling discovery mode.
   * When total tools exceed this, inject `tools.discover()` and
   * only describe small tool sources in the system prompt.
   * Defaults to 50.
   */
  readonly discoveryThreshold?: number | undefined;
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
// Discovery mode
// ---------------------------------------------------------------------------

const DISCOVERY_THRESHOLD = 50;

/**
 * When discovery mode is active, separate tools into:
 * - "small" tools that fit in the prompt (under the threshold)
 * - "large" tools that are only available via discover()
 *
 * The discover tool searches ALL tools. Small tools are described
 * in the prompt AND available via discover.
 */
function prepareToolsForAgent(
  tools: ToolTree,
  threshold: number,
): {
  /** Tools actually wired in the sandbox (always all of them + discover if needed) */
  sandboxTools: ToolTree;
  /** Prompt guidance (subset or all) */
  promptGuidance: string;
  /** Tool declarations for typechecker (subset or all) */
  toolDeclarations: string;
  /** Whether discovery mode is active */
  discoveryMode: boolean;
} {
  const totalCount = countTools(tools);

  if (totalCount <= threshold) {
    // Small enough — describe everything in the prompt
    return {
      sandboxTools: tools,
      promptGuidance: generatePromptGuidance(tools),
      toolDeclarations: generateToolDeclarations(tools),
      discoveryMode: false,
    };
  }

  // Discovery mode: inject discover tool, only describe small namespaces in prompt
  const discoverTool = createDiscoverTool(tools);

  // Separate namespaces into small (described) and large (discover-only)
  const described: Record<string, ToolTree | import("./tools.js").ToolDefinition> = { discover: discoverTool };
  const largeNamespaces: string[] = [];

  for (const [key, value] of Object.entries(tools)) {
    const nsCount = countTools({ [key]: value });
    if (nsCount <= threshold) {
      described[key] = value;
    } else {
      largeNamespaces.push(`${key} (${nsCount} tools)`);
    }
  }

  const describedTree = described as ToolTree;

  // Sandbox gets ALL tools + discover
  const sandboxTools = { ...tools, discover: discoverTool } as ToolTree;

  // Prompt only describes the small namespaces + discover
  const promptGuidance = generatePromptGuidance(describedTree);

  // Typechecker: small namespaces are fully typed, large namespaces
  // are declared as `Record<string, any>` so the LLM can call
  // discovered tools without typecheck errors.
  const largeNsDeclarations = Object.entries(tools)
    .filter(([key]) => !described[key])
    .map(([key]) => `  ${key}: Record<string, Record<string, (...args: any[]) => Promise<any>>>;`)
    .join("\n");

  const toolDeclarations = generateToolDeclarations(describedTree).replace(
    /\};$/,
    largeNsDeclarations ? `${largeNsDeclarations}\n};` : "};",
  );

  return {
    sandboxTools,
    promptGuidance,
    toolDeclarations,
    discoveryMode: true,
  };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(guidance: string, discoveryMode: boolean): string {
  const discoveryInstructions = discoveryMode
    ? `
## Tool Discovery

Some tool namespaces are too large to list here. Use \`tools.discover({ query, depth? })\` to search for tools by keyword.

The \`depth\` parameter controls how much type detail you get:
- **depth 0** (default): tool paths, descriptions, and input arg types only. Fast, use for browsing.
- **depth 1**: adds return types (comments stripped). Use when you need to know response shapes before writing code.
- **depth 2**: full signatures with JSDoc comments and examples. Use when you need exact details.

**Workflow:**
1. Discover tools at depth 0 to find what's available
2. If you need to know response shapes, re-discover at depth 1 for the specific tools you'll use
3. Write a SINGLE self-contained script that does the entire task

Example — "close all open issues on acme/myapp":

Call 1 (find tools):
\`\`\`ts
return await tools.discover({ query: "issues list update repo" });
\`\`\`

Call 2 (get return types for the tools you'll use):
\`\`\`ts
return await tools.discover({ query: "issues list_for_repo update", depth: 1 });
\`\`\`

Call 3 (do the work — everything in one script):
\`\`\`ts
const issues = await tools.github.issues.issues_list_for_repo({
  owner: "acme", repo: "myapp", state: "open", per_page: 100
});

const results = [];
for (const issue of issues) {
  const closed = await tools.github.issues.issues_update({
    owner: "acme", repo: "myapp", issue_number: issue.number, state: "closed"
  });
  results.push({ number: issue.number, title: issue.title, state: closed.state });
}

return { closed: results.length, issues: results };
\`\`\`
`
    : "";

  return `You are an AI assistant that executes tasks by generating TypeScript code.

You have access to a set of tools via the \`tools\` object. When the user asks you to do something, generate TypeScript code that calls these tools to accomplish the task.

## Available Tools

${guidance}
${discoveryInstructions}
## Instructions

- Use the \`run_code\` tool to execute TypeScript code
- **Write complete, self-contained scripts.** Once you know what tools are available, do all the work in a single run_code call — fetch data, loop, transform, write back, and return results. Don't do reads in one call and writes in another.
- The code runs in a sandboxed environment — only \`tools.*\` calls are available
- No \`fetch\`, \`process\`, \`require\`, or \`import\` — use tools for all external interactions
- Write clean, straightforward TypeScript — use for loops, map, filter, Promise.all as needed
- Handle errors gracefully with try/catch — if a tool call fails or is denied, continue with remaining work
- Return a structured result from your script, then summarize what happened
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
    maxCodeRuns = 100,
    timeoutMs = 30_000,
    discoveryThreshold = DISCOVERY_THRESHOLD,
  } = options;

  const { sandboxTools, promptGuidance, toolDeclarations, discoveryMode } =
    prepareToolsForAgent(tools, discoveryThreshold);

  const runner = createRunner({
    tools: sandboxTools,
    requestApproval,
    timeoutMs,
  });

  function emit(event: TaskEvent): void {
    onEvent?.(event);
  }

  return {
    async run(prompt: string): Promise<AgentResult> {
      const systemPrompt = buildSystemPrompt(promptGuidance, discoveryMode);
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
      const text = "I've reached the maximum number of code executions for this task.";
      emit({ type: "agent_message", text });
      emit({ type: "completed", receipts: allReceipts });
      return { text, runs, allReceipts };
    },
  };
}
