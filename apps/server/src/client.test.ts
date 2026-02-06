/**
 * Client tests — proves end-to-end type safety with Eden Treaty.
 *
 * Uses Elysia's direct app testing (no HTTP server) + Eden Treaty.
 */

import { test, expect, describe } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { createApp } from "./routes.js";
import { ApiError, unwrap } from "./client.js";
import { defineTool } from "@openassistant/core/tools";
import type { ToolTree } from "@openassistant/core/tools";
import type { LanguageModel, GenerateResult } from "@openassistant/core/agent";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const echoTool = defineTool({
  description: "Echo",
  approval: "auto",
  args: z.object({ message: z.string() }),
  returns: z.object({ echoed: z.string() }),
  run: async (input) => ({ echoed: input.message }),
});

const testTools: ToolTree = { echo: echoTool };

function createSimpleModel(): LanguageModel {
  return {
    async generate(): Promise<GenerateResult> {
      return { text: "All done." };
    },
  };
}

function createTestApp() {
  return createApp({
    tools: testTools,
    model: createSimpleModel(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Eden Treaty client", () => {
  test("unwrap extracts data from successful call", async () => {
    const app = createTestApp();
    const client = treaty(app);

    const data = await unwrap(
      client.api.tasks.post({
        prompt: "Hello",
        requesterId: "user_1",
      }),
    );

    expect(data.taskId).toMatch(/^task_/);
    expect(data.status).toBe("running");
  });

  test("unwrap throws ApiError on 404", async () => {
    const app = createTestApp();
    const client = treaty(app);

    try {
      await unwrap(client.api.tasks({ id: "nonexistent" }).get());
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
    }
  });

  test("type inference: task data has correct shape", async () => {
    const app = createTestApp();
    const client = treaty(app);

    // Create a task
    const created = await unwrap(
      client.api.tasks.post({
        prompt: "Type test",
        requesterId: "user_1",
      }),
    );

    // Wait for completion
    await Bun.sleep(200);

    // Get task — the data should have the full serialized shape
    const task = await unwrap(
      client.api.tasks({ id: created.taskId }).get(),
    );

    // These type-check at compile time thanks to Eden Treaty!
    expect(typeof task.id).toBe("string");
    expect(typeof task.prompt).toBe("string");
    expect(typeof task.requesterId).toBe("string");
    expect(typeof task.createdAt).toBe("number");
    expect(typeof task.status).toBe("string");
    expect(typeof task.eventCount).toBe("number");
    expect(Array.isArray(task.pendingApprovals)).toBe(true);
  });

  test("type inference: approval response has correct shape", async () => {
    const app = createTestApp();
    const client = treaty(app);

    // This should be a 404 since no approval exists
    try {
      await unwrap(
        client.api.approvals({ callId: "fake" }).post({
          decision: "approved",
        }),
      );
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
    }
  });
});

describe("Direct treaty usage (no unwrap)", () => {
  test("data/error pattern works as expected", async () => {
    const app = createTestApp();
    const client = treaty(app);

    // Success case
    const { data, error } = await client.api.tasks.post({
      prompt: "Direct test",
      requesterId: "user_1",
    });

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.taskId).toBeDefined();

    // Error case
    const { data: data2, error: error2 } = await client.api.tasks({
      id: "nonexistent",
    }).get();

    expect(data2).toBeNull();
    expect(error2).toBeDefined();
    expect(error2!.status).toBe(404);
  });
});
