import { test, expect } from "bun:test";
import { Elysia, t } from "elysia";
import { treaty } from "@elysiajs/eden";
import { createAgent } from "./agent";
import type { Message, GenerateResult } from "./model";

/**
 * Minimal mock executor with sync /api/tasks/run endpoint.
 */
function createMockExecutor() {
  return new Elysia()
    .get("/api/tools", ({ query }) => {
      return [
        {
          path: "utils.get_time",
          description: "Get the current time",
          approval: "auto" as const,
          source: "local",
          argsType: "{}",
          returnsType: "{ iso: string; unix: number }",
        },
      ];
    }, {
      query: t.Object({
        workspaceId: t.String(),
        actorId: t.Optional(t.String()),
        clientId: t.Optional(t.String()),
      }),
    })
    .post("/api/tasks/run", ({ body }) => {
      return {
        taskId: `task_${Date.now()}`,
        status: "completed" as const,
        stdout: 'result: {"iso":"2026-02-07T00:00:00Z","unix":1770422400000}',
        stderr: "",
        exitCode: 0,
      };
    }, {
      body: t.Object({
        code: t.String(),
        workspaceId: t.String(),
        actorId: t.String(),
        clientId: t.Optional(t.String()),
        timeoutMs: t.Optional(t.Number()),
      }),
    })
    .listen(0);
}

test("agent calls model, sends code to executor, returns result", async () => {
  const server = createMockExecutor();
  const executor = treaty<typeof server>(`http://127.0.0.1:${server.server!.port}`);

  let callCount = 0;
  const events: string[] = [];

  const mockGenerate = async (messages: Message[]): Promise<GenerateResult> => {
    callCount++;
    if (callCount === 1) {
      return {
        toolCalls: [{
          id: "call_1",
          name: "run_code",
          args: { code: "return await tools.utils.get_time({})" },
        }],
      };
    }
    return { text: "The current time is 2026-02-07." };
  };

  const agent = createAgent({
    executor: executor as any,
    generate: mockGenerate,
    workspaceId: "ws_test",
    actorId: "actor_test",
  });

  const result = await agent.run("What time is it?", (event) => {
    events.push(event.type);
  });

  expect(result.text).toBe("The current time is 2026-02-07.");
  expect(result.codeRuns).toBe(1);
  expect(callCount).toBe(2);
  expect(events).toContain("status");
  expect(events).toContain("code_generated");
  expect(events).toContain("code_result");
  expect(events).toContain("agent_message");
  expect(events).toContain("completed");

  server.stop(true);
});

test("agent handles model returning text immediately (no code)", async () => {
  const server = createMockExecutor();
  const executor = treaty<typeof server>(`http://127.0.0.1:${server.server!.port}`);

  const mockGenerate = async (): Promise<GenerateResult> => {
    return { text: "I don't need to run any code for that. Hello!" };
  };

  const agent = createAgent({
    executor: executor as any,
    generate: mockGenerate,
    workspaceId: "ws_test",
    actorId: "actor_test",
  });

  const result = await agent.run("Say hello");

  expect(result.text).toBe("I don't need to run any code for that. Hello!");
  expect(result.codeRuns).toBe(0);

  server.stop(true);
});
