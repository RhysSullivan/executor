/**
 * E2E integration test for the executor.
 *
 * Starts the actual server as a subprocess (the same way users run it),
 * connects a real MCP client, runs code that invokes tools, exercises
 * the approval flow, and verifies Convex persistence.
 *
 * Requires the Convex local backend to already be running on port 3210.
 */
import { test, expect, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConvexClient } from "convex/browser";
import { treaty } from "@elysiajs/eden";
import type { App } from "./index";
import { api } from "../../../convex/_generated/api";
import { resolve } from "node:path";

const SERVER_ENTRY = resolve(import.meta.dir, "index.ts");
const CONVEX_URL = Bun.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const PORT = 4099;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: Bun.Subprocess | null = null;
let convex: ConvexClient | null = null;
let executor: ReturnType<typeof treaty<App>>;

afterAll(async () => {
  proc?.kill();
  await proc?.exited.catch(() => {});
  proc = null;
  await convex?.close();
  convex = null;
});

// ── Helpers ──

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${BASE}/api/health`);
      if (resp.ok) return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error("Server did not become healthy");
}

function connectMcp(workspaceId: string, actorId: string) {
  const url = new URL(`${BASE}/mcp?workspaceId=${workspaceId}&actorId=${actorId}`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "e2e-test", version: "0.0.1" }, { capabilities: {} });
  return { client, transport };
}

async function bootstrap(): Promise<{ workspaceId: string; actorId: string; sessionId: string }> {
  const { data, error } = await executor.api.auth.anonymous.bootstrap.post({});
  if (error) throw error;
  return data!;
}

/** Subscribe to Convex and resolve the instant a pending approval for `toolPath` appears. */
function waitForApproval(workspaceId: string, toolPath: string, timeoutMs = 20_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`No pending approval for ${toolPath} within ${timeoutMs}ms`));
    }, timeoutMs);

    const sub = convex!.onUpdate(
      api.database.listPendingApprovals,
      { workspaceId },
      (approvals) => {
        const found = approvals.find((a: any) => a.toolPath === toolPath);
        if (found) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(found.id);
        }
      },
      (error) => {
        clearTimeout(timer);
        sub.unsubscribe();
        reject(error);
      },
    );
  });
}

/** Subscribe to Convex and resolve the instant the task reaches a terminal state. */
function waitForTask(
  taskId: string,
  timeoutMs = 15_000,
): Promise<{ status: string; stdout?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`Task ${taskId} did not complete within ${timeoutMs}ms`));
    }, timeoutMs);

    const sub = convex!.onUpdate(
      api.database.getTask,
      { taskId },
      (task) => {
        if (!task) return;
        if (task.status === "completed" || task.status === "failed" || task.status === "denied") {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(task as any);
        }
      },
      (error) => {
        clearTimeout(timer);
        sub.unsubscribe();
        reject(error);
      },
    );
  });
}

// ── Start the server once for all tests ──

test("server starts", async () => {
  convex = new ConvexClient(CONVEX_URL, { unsavedChangesWarning: false });

  proc = Bun.spawn(["bun", SERVER_ENTRY], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...Bun.env,
      PORT: String(PORT),
      EXECUTOR_SERVER_AUTO_EXECUTE: "1",
      EXECUTOR_AUTO_TAILSCALE_FUNNEL: "0",
    },
  });

  await waitForHealth();

  executor = treaty<App>(BASE);

  const { data: health } = await executor.api.health.get();
  expect(health!.ok).toBe(true);
  expect(health!.tools).toBeGreaterThan(0);
}, 45_000);

// ── MCP ──

test("MCP client lists tools including run_code", async () => {
  const session = await bootstrap();
  const { client, transport } = connectMcp(session.workspaceId, session.actorId);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("run_code");
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, 15_000);

test("run_code executes plain code and returns result", async () => {
  const session = await bootstrap();
  const { client, transport } = connectMcp(session.workspaceId, session.actorId);
  try {
    await client.connect(transport);
    const result = (await client.callTool({
      name: "run_code",
      arguments: { code: "return 40 + 2" },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("completed");
    expect(text).toContain("42");
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, 30_000);

test("run_code calls sandbox tool (math.add) in-band", async () => {
  const session = await bootstrap();
  const { client, transport } = connectMcp(session.workspaceId, session.actorId);
  try {
    await client.connect(transport);
    const result = (await client.callTool({
      name: "run_code",
      arguments: {
        code: `const sum = await tools.math.add({ a: 17, b: 25 }); return sum;`,
      },
    })) as { content: Array<{ type: string; text?: string }> };

    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("completed");
    expect(text).toContain("42");
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, 30_000);

// ── Approval flow ──

test("approval-required tool blocks until approved", async () => {
  const session = await bootstrap();
  const { client, transport } = connectMcp(session.workspaceId, session.actorId);
  try {
    await client.connect(transport);

    // Fire off code that hits the approval gate — don't await
    const resultP = client.callTool({
      name: "run_code",
      arguments: {
        code: `return await tools.admin.send_announcement({ channel: "general", message: "hello from e2e" });`,
      },
    });

    // Convex subscription resolves instantly when the approval appears
    const approvalId = await waitForApproval(session.workspaceId, "admin.send_announcement");

    // Approve it
    const { data: approveResult } = await executor.api.approvals({ approvalId }).post({
      workspaceId: session.workspaceId,
      decision: "approved",
      reviewerId: "e2e-test",
    });
    expect(approveResult).toBeTruthy();

    // Now the tool call completes
    const result = (await resultP) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("completed");
    expect(text).toContain("hello from e2e");
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, 45_000);

test("denied approval propagates failure", async () => {
  const session = await bootstrap();
  const { client, transport } = connectMcp(session.workspaceId, session.actorId);
  try {
    await client.connect(transport);

    const resultP = client.callTool({
      name: "run_code",
      arguments: {
        code: `return await tools.admin.delete_data({ key: "important" });`,
      },
    });

    const approvalId = await waitForApproval(session.workspaceId, "admin.delete_data");

    await executor.api.approvals({ approvalId }).post({
      workspaceId: session.workspaceId,
      decision: "denied",
      reason: "too dangerous",
    });

    const result = (await resultP) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("denied");
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, 45_000);

// ── Convex persistence ──

test("tasks are persisted and queryable via Convex subscription", async () => {
  const session = await bootstrap();

  // Create via REST
  const { data: created, error: createError } = await executor.api.tasks.post({
    code: "return 'persisted'",
    workspaceId: session.workspaceId,
    actorId: session.actorId,
  });
  if (createError) throw createError;
  const taskId = created!.taskId as string;

  // Wait for completion via Convex subscription — no polling
  const task = await waitForTask(taskId);
  expect(task.status).toBe("completed");
  expect(task.stdout).toContain("persisted");

  // Verify it shows up in the list via REST
  const { data: tasks, error: listError } = await executor.api.tasks.get({
    query: { workspaceId: session.workspaceId },
  });
  if (listError) throw listError;
  expect(tasks!.some((t) => t.id === taskId)).toBe(true);
}, 30_000);

// ── Shutdown ──

test("clean shutdown", async () => {
  expect(proc).toBeTruthy();
  proc!.kill();
  const exitCode = await proc!.exited;
  proc = null;
  expect(typeof exitCode).toBe("number");

  // Verify it's actually down
  await Bun.sleep(300);
  const dead = await fetch(`${BASE}/api/health`).catch(() => null);
  expect(dead).toBeNull();
}, 10_000);
