import { describe, expect, it } from "@effect/vitest";
import {
  createInMemoryRuntimeRunClient,
  createRuntimeRunClient,
  makeDenoSubprocessRuntimeAdapter,
  makeLocalInProcessRuntimeAdapter,
  makeToolProviderRegistry,
} from "@executor-v2/engine";
import { createExecutorRunClient } from "@executor-v2/sdk";
import type { ExecuteRunResult } from "@executor-v2/sdk";
import { createGateway, generateText, stepCountIs, tool } from "ai";
import * as Effect from "effect/Effect";

import { z } from "zod";

import { toAiSdkTools } from "./index";

const gateway = createGateway();

describe("toAiSdkTools", () => {
  it.effect(
    "generates a tool call via generateText with a mock executor",
    () =>
      Effect.gen(function* () {
        const executionLog: Array<{ code: string; timeoutMs?: number }> = [];

        const mockResult: ExecuteRunResult = {
          runId: "run-test-123",
          status: "completed",
          result: 42,
        };

        const runClient = createExecutorRunClient(async (input) => {
          executionLog.push({ code: input.code, timeoutMs: input.timeoutMs });
          return mockResult;
        });

        const tools = toAiSdkTools({
          runClient,
          makeTool: (def) => tool(def),
          defaults: { timeoutMs: 30_000 },
        });

        const result = yield* Effect.tryPromise(() =>
          generateText({
            model: gateway("openai/gpt-4o-mini"),
            tools,
            stopWhen: stepCountIs(3),
            system:
              "You have an execute tool that runs JavaScript code. Always use it when asked to run code.",
            prompt:
              'Run this code using the execute tool: console.log("hello")',
          }),
        );

        expect(executionLog.length).toBeGreaterThanOrEqual(1);
        expect(executionLog[0]!.code).toBeTypeOf("string");
        expect(executionLog[0]!.code.length).toBeGreaterThan(0);
        expect(executionLog[0]!.timeoutMs).toBeTypeOf("number");

        const toolCallSteps = result.steps.filter(
          (step) => step.toolCalls.length > 0,
        );
        expect(toolCallSteps.length).toBeGreaterThanOrEqual(1);

        const firstToolCall = toolCallSteps[0]!.toolCalls[0]!;
        expect(firstToolCall.toolName).toBe("execute");
        expect(firstToolCall.input).toHaveProperty("code");

        const toolResultSteps = result.steps.filter(
          (step) => step.toolResults.length > 0,
        );
        expect(toolResultSteps.length).toBeGreaterThanOrEqual(1);
        const toolResult = toolResultSteps[0]!.toolResults[0]!;
        expect(toolResult.toolName).toBe("execute");
        expect(toolResult.output).toMatchObject(mockResult);

        expect(result.text).toBeTypeOf("string");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "calls a normal AI SDK tool from the execute sandbox",
    () =>
      Effect.gen(function* () {
        const normalToolCalls: Array<{ query: string }> = [];

        const searchDocsTool = tool({
          description: "Search docs by query",
          inputSchema: z.object({
            query: z.string(),
          }),
          execute: async (input: { query: string }) => {
            normalToolCalls.push(input);
            return {
              hits: [`match:${input.query}`],
            };
          },
        });

        const runClient = createInMemoryRuntimeRunClient({
          runtimeAdapter: makeLocalInProcessRuntimeAdapter(),
          tools: {
            search_docs: searchDocsTool,
          },
          defaults: {
            timeoutMs: 30_000,
          },
        });

        const tools = toAiSdkTools({
          runClient,
          makeTool: (def) => def,
        });

        const result = yield* Effect.tryPromise(() =>
          tools.execute.execute({
            code: "return await tools.search_docs({ query: 'codemode adapter integration' });",
          }),
        );

        expect(result.status).toBe("completed");
        expect(result.result).toEqual({
          hits: ["match:codemode adapter integration"],
        });
        expect(normalToolCalls).toEqual([
          {
            query: "codemode adapter integration",
          },
        ]);
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "executes code in a real Deno subprocess via generateText",
    () =>
      Effect.gen(function* () {
        const runtimeAdapter = makeDenoSubprocessRuntimeAdapter({
          defaultTimeoutMs: 10_000,
        });

        const toolProviderRegistry = makeToolProviderRegistry([]);

        const runClient = createRuntimeRunClient({
          runtimeAdapter,
          toolProviderRegistry,
        });

        const tools = toAiSdkTools({
          runClient,
          makeTool: (def) => tool(def),
        });

        const result = yield* Effect.tryPromise(() =>
          generateText({
            model: gateway("openai/gpt-4o-mini"),
            tools,
            stopWhen: stepCountIs(3),
            system: [
              "You have an execute tool that runs JavaScript code in a sandboxed Deno runtime.",
              "Always use it when asked to run code.",
              "The code must use `return` to produce a result value.",
            ].join(" "),
            prompt: "Use the execute tool to compute 2 + 3. The code should be: return 2 + 3;",
          }),
        );

        const toolCallSteps = result.steps.filter(
          (step) => step.toolCalls.length > 0,
        );
        expect(toolCallSteps.length).toBeGreaterThanOrEqual(1);

        const firstToolCall = toolCallSteps[0]!.toolCalls[0]!;
        expect(firstToolCall.toolName).toBe("execute");

        const toolResultSteps = result.steps.filter(
          (step) => step.toolResults.length > 0,
        );
        expect(toolResultSteps.length).toBeGreaterThanOrEqual(1);

        const toolResult = toolResultSteps[0]!.toolResults[0]!;
        expect(toolResult.toolName).toBe("execute");
        expect(toolResult.output).toMatchObject({
          status: "completed",
          result: 5,
        });

        expect(result.text).toBeTypeOf("string");
      }),
    { timeout: 30_000 },
  );
});
