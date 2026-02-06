import type { CodeModeRunResult, ToolCallReceipt } from "@openassistant/core";
import { generateText, stepCountIs, tool } from "ai";
import { getAnthropicModel } from "./anthropic-provider.js";
import { typecheckCodeSnippet } from "./code-typecheck.js";
import { z } from "zod";

export interface AgentCodeRun {
  code: string;
  result: CodeModeRunResult;
  reason?: string | undefined;
}

export interface AgentLoopResult {
  provider: "claude";
  planner: string;
  text: string;
  runs: AgentCodeRun[];
}

interface RunCodeToolInput {
  code: string;
  reason?: string | undefined;
}

interface RunCodeToolOutput {
  ok: boolean;
  receipts: ToolCallReceipt[];
  value?: unknown;
  error?: string;
}

interface RunWithClaudeInput {
  prompt: string;
  now: Date;
  executeCode: (input: RunCodeToolInput) => Promise<RunCodeToolOutput>;
}

interface RunWithClaudeOutput {
  text: string;
  modelID: string;
  authSource: string;
}

interface AgentLoopOptions {
  now?: Date;
  runWithClaude?: (input: RunWithClaudeInput) => Promise<RunWithClaudeOutput>;
}

const DEFAULT_ANTHROPIC_MODEL =
  readEnv("OPENASSISTANT_ANTHROPIC_MODEL")?.trim() ??
  readEnv("OPENASSISTANT_CLAUDE_MODEL")?.trim() ??
  "claude-opus-4-5-20251101";
const CLAUDE_TIMEOUT_MS = Number(readEnv("OPENASSISTANT_CLAUDE_TIMEOUT_MS") ?? 60_000);
const CLAUDE_MAX_STEPS = Number(readEnv("OPENASSISTANT_AGENT_MAX_STEPS") ?? 8);

const RUN_CODE_TOOL_SCHEMA = z.object({
  code: z.string().min(1),
  reason: z.string().min(1).optional(),
});

export async function runAgentLoop(
  prompt: string,
  runCode: (code: string) => Promise<CodeModeRunResult>,
  options: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  const now = options.now ?? new Date();
  const runs: AgentCodeRun[] = [];

  const executeCode = async (input: RunCodeToolInput): Promise<RunCodeToolOutput> => {
    const typecheck = typecheckCodeSnippet(input.code);
    if (!typecheck.ok) {
      const failed: CodeModeRunResult = {
        ok: false,
        error: `Typecheck failed: ${typecheck.error}`,
        receipts: [],
      };
      runs.push({
        code: input.code,
        result: failed,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return {
        ok: false,
        error: failed.error,
        receipts: [],
      };
    }

    const result = await runCode(input.code);
    runs.push({
      code: input.code,
      result,
      ...(input.reason ? { reason: input.reason } : {}),
    });

    if (result.ok) {
      return {
        ok: true,
        value: result.value,
        receipts: result.receipts,
      };
    }

    return {
      ok: false,
      error: result.error,
      receipts: result.receipts,
    };
  };

  try {
    const generated = await (options.runWithClaude ?? runWithClaude)({
      prompt,
      now,
      executeCode,
    });

    return {
      provider: "claude",
      planner: `Claude tool-loop (${runs.length} code run${runs.length === 1 ? "" : "s"}, model=${generated.modelID}, auth=${generated.authSource}).`,
      text: generated.text,
      runs,
    };
  } catch (error) {
    return {
      provider: "claude",
      planner: `Claude tool-loop failed before completion (model=${DEFAULT_ANTHROPIC_MODEL}).`,
      text: `Agent loop failed: ${describeUnknown(error)}. No actions were executed.`,
      runs,
    };
  }
}

async function runWithClaude(input: RunWithClaudeInput): Promise<RunWithClaudeOutput> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CLAUDE_TIMEOUT_MS);

  try {
    const { model, authSource, authMode } = await getAnthropicModel(DEFAULT_ANTHROPIC_MODEL);
    const result = await generateText({
      model,
      temperature: 0,
      stopWhen: stepCountIs(CLAUDE_MAX_STEPS),
      prompt: buildAgentPrompt(input.prompt, input.now),
      system: buildSystemPrompt(authMode),
      tools: {
        run_code: tool({
          description:
            "Execute Bun TypeScript function body in codemode runtime. Use this for every action that requires tools.* calls.",
          inputSchema: RUN_CODE_TOOL_SCHEMA,
          execute: (args) => input.executeCode(args),
        }),
      },
      abortSignal: abortController.signal,
    });

    return {
      text: result.text.trim() || "Done.",
      modelID: DEFAULT_ANTHROPIC_MODEL,
      authSource,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildSystemPrompt(authMode: "api" | "oauth"): string {
  if (authMode === "oauth") {
    return "You are Claude Code, Anthropic's official CLI for Claude.";
  }

  return [
    "You are OpenAssistant. Execute work via the run_code tool and then report what happened.",
    "In your final response, summarize relevant tool activity and mention failures/denials clearly.",
  ].join("\n");
}

function buildAgentPrompt(userPrompt: string, now: Date): string {
  return [
    "run_code expects JavaScript function-body code executed as new AsyncFunction('tools', code).",
    "Inside code, call available tools directly like: await tools.calendar.update({ title, startsAt, notes }).",
    "For multiple events, produce multiple tool calls in the same code block.",
    "Never claim an action succeeded unless run_code returned ok=true.",
    `Current timestamp: ${now.toISOString()}`,
    `User request: ${userPrompt}`,
  ].join("\n");
}

function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readEnv(key: string): string | undefined {
  const bun = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun;
  return bun?.env?.[key] ?? process.env[key];
}
