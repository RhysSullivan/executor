import { test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createAgent } from "./agent";
import type { Message, GenerateResult, ToolDef } from "./model";

/**
 * Create a mock MCP server that exposes run_code.
 * Returns the Bun HTTP server so we can get the port.
 */
function createMockMcpServer() {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      const mcp = new McpServer(
        { name: "mock-executor", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );

      mcp.registerTool(
        "run_code",
        {
          description: "Execute TypeScript code in a sandbox.\n\nAvailable tools in the sandbox:\n  - tools.utils.get_time({}): { iso: string; unix: number } — Get the current time",
          inputSchema: {
            code: z.string(),
          },
        },
        async (input) => {
          return {
            content: [{ type: "text" as const, text: `taskId: task_123\nstatus: completed\nruntimeId: local-bun\n\n\`\`\`text\nresult: {"iso":"2026-02-07T00:00:00Z","unix":1770422400000}\n\`\`\`` }],
          };
        },
      );

      try {
        await mcp.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await transport.close().catch(() => {});
        await mcp.close().catch(() => {});
      }
    },
  });

  return server;
}

test("agent connects via MCP, calls run_code, returns result", async () => {
  const server = createMockMcpServer();
  const port = server.port;

  let callCount = 0;
  const events: string[] = [];

  const mockGenerate = async (messages: Message[], tools?: ToolDef[]): Promise<GenerateResult> => {
    callCount++;

    // First call: verify tools were passed from MCP
    if (callCount === 1) {
      expect(tools).toBeDefined();
      expect(tools!.length).toBeGreaterThan(0);
      expect(tools![0].name).toBe("run_code");

      return {
        toolCalls: [{
          id: "call_1",
          name: "run_code",
          args: { code: "return await tools.utils.get_time({})" },
        }],
      };
    }

    // Second call: return final text
    return { text: "The current time is 2026-02-07." };
  };

  const agent = createAgent({
    executorUrl: `http://127.0.0.1:${port}`,
    generate: mockGenerate,
    workspaceId: "ws_test",
    actorId: "actor_test",
  });

  const result = await agent.run("What time is it?", (event) => {
    events.push(event.type);
  });

  expect(result.text).toBe("The current time is 2026-02-07.");
  expect(result.toolCalls).toBe(1);
  expect(callCount).toBe(2);
  expect(events).toContain("status");
  expect(events).toContain("code_generated");
  expect(events).toContain("code_result");
  expect(events).toContain("agent_message");
  expect(events).toContain("completed");

  server.stop(true);
});

test("agent handles model returning text immediately (no tool calls)", async () => {
  const server = createMockMcpServer();
  const port = server.port;

  const mockGenerate = async (_messages: Message[], tools?: ToolDef[]): Promise<GenerateResult> => {
    // Tools should still be available even if we don't use them
    expect(tools).toBeDefined();
    return { text: "I don't need to run any code for that. Hello!" };
  };

  const agent = createAgent({
    executorUrl: `http://127.0.0.1:${port}`,
    generate: mockGenerate,
    workspaceId: "ws_test",
    actorId: "actor_test",
  });

  const result = await agent.run("Say hello");

  expect(result.text).toBe("I don't need to run any code for that. Hello!");
  expect(result.toolCalls).toBe(0);

  server.stop(true);
});
