import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "./mcp-server";
import type { AnonymousContext, CreateTaskInput, TaskRecord, ToolDescriptor } from "./types";

class FakeMcpService {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly sessions = new Map<string, AnonymousContext>();

  async createTask(input: CreateTaskInput): Promise<{ task: TaskRecord }> {
    const id = `task_${crypto.randomUUID()}`;
    const now = Date.now();
    const queued: TaskRecord = {
      id,
      code: input.code,
      runtimeId: input.runtimeId ?? "local-bun",
      status: "queued",
      timeoutMs: input.timeoutMs ?? 15_000,
      metadata: input.metadata ?? {},
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      clientId: input.clientId,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, queued);

    queueMicrotask(() => {
      const current = this.tasks.get(id);
      if (!current) return;
      this.tasks.set(id, {
        ...current,
        status: "completed",
        startedAt: current.createdAt + 1,
        completedAt: current.createdAt + 2,
        updatedAt: current.createdAt + 2,
        exitCode: 0,
        stdout: `ran:${input.code.slice(0, 20)}`,
        stderr: "",
      });
    });

    return { task: queued };
  }

  async getTask(taskId: string, workspaceId?: string): Promise<TaskRecord | null> {
    const task = this.tasks.get(taskId) ?? null;
    if (!task) return null;
    if (workspaceId && task.workspaceId !== workspaceId) return null;
    return task;
  }

  async bootstrapAnonymousContext(sessionId?: string): Promise<AnonymousContext> {
    if (sessionId && this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId)!;
      const updated = { ...existing, lastSeenAt: Date.now() };
      this.sessions.set(sessionId, updated);
      return updated;
    }

    const now = Date.now();
    const context: AnonymousContext = {
      sessionId: sessionId ?? `anon_session_${crypto.randomUUID()}`,
      workspaceId: `ws_${crypto.randomUUID()}`,
      actorId: `anon_${crypto.randomUUID()}`,
      clientId: "mcp",
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(context.sessionId, context);
    return context;
  }

  async listTools(_context?: { workspaceId: string; actorId?: string; clientId?: string }): Promise<ToolDescriptor[]> {
    return [
      { path: "utils.get_time", description: "Get the current time", approval: "auto" },
    ];
  }
}

async function withMcpClient<T>(
  service: FakeMcpService,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/mcp") {
        return handleMcpRequest(service, request);
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
  const client = new Client({ name: "executor-mcp-test", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
    server.stop(true);
  }
}

test("run_code MCP tool returns terminal task result", async () => {
  const service = new FakeMcpService();

  await withMcpClient(service, async (client) => {
    const result = (await client.callTool({
      name: "run_code",
      arguments: {
        code: "console.log('hello from mcp')",
        workspaceId: "ws_test",
        actorId: "actor_test",
        clientId: "assistant",
      },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };

    expect(result.isError).toBeUndefined();
    const text = result.content.find((part) => part.type === "text");
    expect(text?.type).toBe("text");
    if (text?.type === "text") {
      expect(text.text).toContain("status: completed");
      expect(text.text).toContain("ran:console.log('hello f");
    }
  });
});

test("run_code MCP tool bootstraps anonymous context when workspace is omitted", async () => {
  const service = new FakeMcpService();

  await withMcpClient(service, async (client) => {
    const result = (await client.callTool({
      name: "run_code",
      arguments: {
        code: "console.log('anon')",
        sessionId: "mcp_session_test",
      },
    })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent;
    expect(typeof structured?.workspaceId).toBe("string");
    expect(typeof structured?.actorId).toBe("string");
    expect(structured?.sessionId).toBe("mcp_session_test");
  });
});
