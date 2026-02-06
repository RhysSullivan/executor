/**
 * Server route tests.
 *
 * Uses Elysia's direct handler testing (no HTTP server needed)
 * and Eden Treaty for type-safe client calls.
 */

import { test, expect, describe } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { createApp } from "./routes.js";
import { defineTool } from "@openassistant/core/tools";
import type { ToolTree } from "@openassistant/core/tools";
import type { LanguageModel, GenerateResult, Message } from "@openassistant/core/agent";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A simple echo tool for testing. */
const echoTool = defineTool({
  description: "Echo back the input",
  approval: "auto",
  args: z.object({ message: z.string() }),
  returns: z.object({ echoed: z.string() }),
  run: async (input) => ({ echoed: input.message }),
});

/** A tool that requires approval. */
const dangerousTool = defineTool({
  description: "A dangerous operation that needs approval",
  approval: "required",
  args: z.object({ target: z.string() }),
  returns: z.object({ deleted: z.boolean() }),
  run: async () => ({ deleted: true }),
  formatApproval: (input) => ({
    title: `Delete ${input.target}`,
    details: `This will permanently delete ${input.target}`,
  }),
});

const testTools: ToolTree = {
  echo: echoTool,
  danger: dangerousTool,
};

/**
 * Create a mock LanguageModel for testing.
 * By default, immediately returns text (no tool calls).
 */
function createMockModel(
  handler?: (messages: Message[]) => GenerateResult,
): LanguageModel {
  return {
    async generate(messages: Message[]): Promise<GenerateResult> {
      if (handler) return handler(messages);
      return { text: "Done! I processed your request." };
    },
  };
}

/**
 * Create a model that generates code calling the echo tool,
 * then responds with text on the second call.
 */
function createEchoModel(): LanguageModel {
  let callCount = 0;
  return {
    async generate(): Promise<GenerateResult> {
      callCount++;
      if (callCount === 1) {
        return {
          toolCalls: [
            {
              id: "call_1",
              name: "run_code",
              args: {
                code: `const result = await tools.echo({ message: "hello" });\nreturn result;`,
              },
            },
          ],
        };
      }
      return { text: "Echo completed successfully." };
    },
  };
}

/**
 * Create a model that generates code calling the dangerous tool,
 * then responds with text.
 */
function createDangerModel(): LanguageModel {
  let callCount = 0;
  return {
    async generate(): Promise<GenerateResult> {
      callCount++;
      if (callCount === 1) {
        return {
          toolCalls: [
            {
              id: "call_1",
              name: "run_code",
              args: {
                code: `const result = await tools.danger({ target: "everything" });\nreturn result;`,
              },
            },
          ],
        };
      }
      return { text: "Danger operation completed." };
    },
  };
}

function createTestApp(model?: LanguageModel) {
  return createApp({
    tools: testTools,
    model: model ?? createMockModel(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/tasks", () => {
  test("creates a task and returns taskId", async () => {
    const app = createTestApp();
    const client = treaty(app);

    const { data, error } = await client.api.tasks.post({
      prompt: "Say hello",
      requesterId: "user_1",
    });

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.taskId).toMatch(/^task_/);
    expect(data!.status).toBe("running");
  });

  test("rejects empty prompt", async () => {
    const app = createTestApp();
    const client = treaty(app);

    const { error } = await client.api.tasks.post({
      prompt: "",
      requesterId: "user_1",
    });

    expect(error).toBeDefined();
  });
});

describe("GET /api/tasks", () => {
  test("lists created tasks", async () => {
    const app = createTestApp();
    const client = treaty(app);

    await client.api.tasks.post({
      prompt: "Test task",
      requesterId: "user_1",
    });

    await Bun.sleep(10);

    const { data, error } = await client.api.tasks.get({
      query: {},
    });

    expect(error).toBeNull();
    expect(data).toBeInstanceOf(Array);
    expect(data!.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/tasks/:id", () => {
  test("returns task details", async () => {
    const app = createTestApp();
    const client = treaty(app);

    const { data: created } = await client.api.tasks.post({
      prompt: "Detail test",
      requesterId: "user_1",
    });

    const { data, error } = await client.api.tasks({ id: created!.taskId }).get();

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.id).toBe(created!.taskId);
    expect(data!.prompt).toBe("Detail test");
  });

  test("returns 404 for unknown task", async () => {
    const app = createTestApp();
    const client = treaty(app);

    const { error } = await client.api.tasks({ id: "nonexistent" }).get();

    expect(error).toBeDefined();
    expect(error!.status).toBe(404);
  });
});

describe("Agent execution flow", () => {
  test("simple model completes task with text", async () => {
    const model = createMockModel();
    const app = createTestApp(model);
    const client = treaty(app);

    const { data } = await client.api.tasks.post({
      prompt: "Just respond",
      requesterId: "user_1",
    });

    // Wait for agent to finish
    await Bun.sleep(500);

    const { data: task } = await client.api.tasks({ id: data!.taskId }).get();

    expect(task!.status).toBe("completed");
    expect(task!.resultText).toBe("Done! I processed your request.");
  });

  test("echo model generates code and executes it", async () => {
    const model = createEchoModel();
    const app = createTestApp(model);
    const client = treaty(app);

    const { data } = await client.api.tasks.post({
      prompt: "Echo hello",
      requesterId: "user_1",
    });

    // Wait for agent to finish
    await Bun.sleep(1000);

    const { data: task } = await client.api.tasks({ id: data!.taskId }).get();

    expect(task!.status).toBe("completed");
    expect(task!.eventCount).toBeGreaterThan(0);
  });
});

describe("Approval flow", () => {
  test("dangerous tool creates approval request, resolving it completes task", async () => {
    const model = createDangerModel();
    const app = createTestApp(model);
    const client = treaty(app);

    const { data } = await client.api.tasks.post({
      prompt: "Delete everything",
      requesterId: "user_1",
    });

    const taskId = data!.taskId;

    // Poll for the approval request to appear
    let approvals: Array<{ callId: string; toolPath: string }> = [];
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(100);
      const { data: task } = await client.api.tasks({ id: taskId }).get();
      if (task && task.pendingApprovals.length > 0) {
        approvals = task.pendingApprovals;
        break;
      }
    }

    expect(approvals.length).toBeGreaterThan(0);

    // Resolve the approval
    const callId = approvals[0]!.callId;
    const { data: result, error } = await client.api.approvals({ callId }).post({
      decision: "approved",
    });

    expect(error).toBeNull();
    expect(result!.decision).toBe("approved");

    // Wait for task to complete
    await Bun.sleep(1000);

    const { data: finalTask } = await client.api.tasks({ id: taskId }).get();
    expect(finalTask!.status).toBe("completed");
  });
});

describe("POST /api/approvals/:callId", () => {
  test("returns 404 for unknown callId", async () => {
    const app = createTestApp();
    const client = treaty(app);

    const { error } = await client.api.approvals({ callId: "unknown" }).post({
      decision: "approved",
    });

    expect(error).toBeDefined();
    expect(error!.status).toBe(404);
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  test("cancels a running task", async () => {
    // Use a model that hangs forever (simulating a long-running task)
    const hangingModel: LanguageModel = {
      generate: () => new Promise(() => {}), // Never resolves
    };

    const app = createTestApp(hangingModel);
    const client = treaty(app);

    const { data } = await client.api.tasks.post({
      prompt: "Hang forever",
      requesterId: "user_1",
    });

    await Bun.sleep(50);

    const { data: result } = await client.api.tasks({ id: data!.taskId }).cancel.post();

    expect(result!.status).toBe("cancelled");
  });

  test("returns 404 for unknown task", async () => {
    const app = createTestApp();
    const client = treaty(app);

    const { error } = await client.api.tasks({ id: "nonexistent" }).cancel.post();

    expect(error).toBeDefined();
    expect(error!.status).toBe(404);
  });
});
