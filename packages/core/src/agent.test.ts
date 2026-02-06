import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { defineTool, type ToolTree } from "./tools.js";
import { createAgent, type LanguageModel, type Message, type GenerateResult } from "./agent.js";
import type { TaskEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mathTools(): ToolTree {
  return {
    math: {
      add: defineTool({
        description: "Add two numbers",
        approval: "auto",
        args: z.object({ a: z.number(), b: z.number() }),
        returns: z.number(),
        run: async (input) => input.a + input.b,
      }),
      multiply: defineTool({
        description: "Multiply two numbers",
        approval: "auto",
        args: z.object({ a: z.number(), b: z.number() }),
        returns: z.number(),
        run: async (input) => input.a * input.b,
      }),
    },
  };
}

/**
 * Create a fake model that returns pre-scripted responses.
 * Each call to generate() returns the next response in the sequence.
 */
function fakeModel(responses: GenerateResult[]): LanguageModel {
  let callIndex = 0;
  return {
    async generate(_messages: Message[]): Promise<GenerateResult> {
      const response = responses[callIndex];
      if (!response) {
        return { text: "No more scripted responses." };
      }
      callIndex++;
      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent — basic flow", () => {
  test("model returns text without tool calls", async () => {
    const model = fakeModel([{ text: "Hello! How can I help?" }]);

    const agent = createAgent({
      tools: mathTools(),
      model,
      requestApproval: async () => "approved",
    });

    const result = await agent.run("Hi there");
    expect(result.text).toBe("Hello! How can I help?");
    expect(result.runs).toHaveLength(0);
    expect(result.allReceipts).toHaveLength(0);
  });

  test("model calls run_code, then returns text", async () => {
    const model = fakeModel([
      // First call: model wants to run code
      {
        toolCalls: [
          {
            id: "tc_1",
            name: "run_code",
            args: { code: "return await tools.math.add({ a: 3, b: 4 })" },
          },
        ],
      },
      // Second call: model sees the result and responds with text
      { text: "The result of 3 + 4 is 7." },
    ]);

    const agent = createAgent({
      tools: mathTools(),
      model,
      requestApproval: async () => "approved",
    });

    const result = await agent.run("What is 3 + 4?");
    expect(result.text).toBe("The result of 3 + 4 is 7.");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.result.ok).toBe(true);
    expect(result.runs[0]!.result.value).toBe(7);
    expect(result.allReceipts).toHaveLength(1);
  });

  test("model chains multiple run_code calls", async () => {
    const model = fakeModel([
      {
        toolCalls: [
          {
            id: "tc_1",
            name: "run_code",
            args: { code: "return await tools.math.add({ a: 1, b: 2 })" },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc_2",
            name: "run_code",
            args: { code: "return await tools.math.multiply({ a: 3, b: 4 })" },
          },
        ],
      },
      { text: "1 + 2 = 3, then 3 * 4 = 12." },
    ]);

    const agent = createAgent({
      tools: mathTools(),
      model,
      requestApproval: async () => "approved",
    });

    const result = await agent.run("Add 1+2 then multiply 3*4");
    expect(result.text).toBe("1 + 2 = 3, then 3 * 4 = 12.");
    expect(result.runs).toHaveLength(2);
    expect(result.allReceipts).toHaveLength(2);
  });

  test("emits events throughout execution", async () => {
    const model = fakeModel([
      {
        toolCalls: [
          {
            id: "tc_1",
            name: "run_code",
            args: { code: "return await tools.math.add({ a: 1, b: 2 })" },
          },
        ],
      },
      { text: "Done." },
    ]);

    const events: TaskEvent[] = [];

    const agent = createAgent({
      tools: mathTools(),
      model,
      requestApproval: async () => "approved",
      onEvent: (e) => events.push(e),
    });

    await agent.run("Add 1+2");

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("status");
    expect(eventTypes).toContain("code_generated");
    expect(eventTypes).toContain("tool_result");
    expect(eventTypes).toContain("agent_message");
    expect(eventTypes).toContain("completed");
  });

  test("handles code that fails in sandbox", async () => {
    const model = fakeModel([
      {
        toolCalls: [
          {
            id: "tc_1",
            name: "run_code",
            // This passes typecheck but fails at runtime (undefined access)
            args: { code: "const x: any = undefined;\nreturn x.foo.bar;" },
          },
        ],
      },
      { text: "The code failed." },
    ]);

    const agent = createAgent({
      tools: mathTools(),
      model,
      requestApproval: async () => "approved",
    });

    const result = await agent.run("Do something that fails");
    expect(result.text).toBe("The code failed.");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.result.ok).toBe(false);
  });

  test("respects maxCodeRuns limit", async () => {
    // Model always wants to run more code
    const infiniteModel: LanguageModel = {
      async generate(): Promise<GenerateResult> {
        return {
          toolCalls: [
            { id: `tc_${Date.now()}`, name: "run_code", args: { code: "return 1" } },
          ],
        };
      },
    };

    const agent = createAgent({
      tools: mathTools(),
      model: infiniteModel,
      requestApproval: async () => "approved",
      maxCodeRuns: 3,
    });

    const result = await agent.run("Keep running");
    expect(result.runs).toHaveLength(3);
    expect(result.text).toContain("maximum");
  });
});
