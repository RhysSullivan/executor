import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { internal } from "./_generated/api";
import schema from "./schema";

function setup() {
  return convexTest(schema, {
    "./database.ts": () => import("./database"),
    "./executor.ts": () => import("./executor"),
    "./executorNode.ts": () => import("./executorNode"),
    "./http.ts": () => import("./http"),
    "./auth.ts": () => import("./auth"),
    "./workspaceAuthInternal.ts": () => import("./workspaceAuthInternal"),
    "./workspaceToolCache.ts": () => import("./workspaceToolCache"),
    "./openApiSpecCache.ts": () => import("./openApiSpecCache"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });
}

function createMcpTransport(
  t: ReturnType<typeof setup>,
  workspaceId: string,
  actorId: string,
  sessionId: string,
  clientId = "e2e",
) {
  const url = new URL("https://executor.test/mcp");
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("actorId", actorId);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("clientId", clientId);

  return new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const parsed = new URL(raw);
      const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return await t.fetch(path, init);
    },
  });
}

async function waitForTaskId(t: ReturnType<typeof setup>, workspaceId: string, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tasks = await t.query(internal.database.listTasks, { workspaceId });
    if (tasks.length > 0) {
      return tasks[0]!.id;
    }
    await Bun.sleep(50);
  }

  throw new Error("Timed out waiting for created task");
}

async function waitForPendingApproval(
  t: ReturnType<typeof setup>,
  workspaceId: string,
  toolPath: string,
  timeoutMs = 10_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const approvals = await t.query(internal.database.listPendingApprovals, { workspaceId });
    const approval = approvals.find((item: { toolPath: string; id: string }) => item.toolPath === toolPath);
    if (approval) {
      return approval.id;
    }
    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for pending approval on ${toolPath}`);
}

test("MCP run_code survives delayed approval and completes", async () => {
  const t = setup();
  const session = await t.mutation(internal.database.bootstrapAnonymousSession, {});

  const client = new Client({ name: "executor-e2e", version: "0.0.1" }, { capabilities: {} });
  const transport = createMcpTransport(t, session.workspaceId, session.actorId, session.sessionId, "e2e-approval-delay");

  try {
    await client.connect(transport);

    const runCode = client.callTool({
      name: "run_code",
      arguments: {
        code: `return await tools.admin.send_announcement({ channel: "general", message: "hello from convex-test" });`,
      },
    });

    const taskId = await waitForTaskId(t, session.workspaceId);
    const runTask = t.action(internal.executorNode.runTask, { taskId });

    const approvalId = await waitForPendingApproval(t, session.workspaceId, "admin.send_announcement");

    await Bun.sleep(16_000);

    await t.mutation(internal.executor.resolveApprovalInternal, {
      workspaceId: session.workspaceId,
      approvalId,
      decision: "approved",
      reviewerId: "e2e-reviewer",
    });

    await runTask;

    const result = (await runCode) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = result.content.find((item) => item.type === "text")?.text ?? "";

    expect(result.isError).toBeFalsy();
    expect(text).toContain("status: completed");
    expect(text).toContain("hello from convex-test");

    const task = await t.query(internal.database.getTask, { taskId });
    expect(task?.status).toBe("completed");
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, 60_000);

test("MCP run_code returns denied after approval denial", async () => {
  const t = setup();
  const session = await t.mutation(internal.database.bootstrapAnonymousSession, {});

  const client = new Client({ name: "executor-e2e", version: "0.0.1" }, { capabilities: {} });
  const transport = createMcpTransport(t, session.workspaceId, session.actorId, session.sessionId, "e2e-deny");

  try {
    await client.connect(transport);

    const runCode = client.callTool({
      name: "run_code",
      arguments: {
        code: `return await tools.admin.delete_data({ key: "important" });`,
      },
    });

    const taskId = await waitForTaskId(t, session.workspaceId);
    const runTask = t.action(internal.executorNode.runTask, { taskId });

    const approvalId = await waitForPendingApproval(t, session.workspaceId, "admin.delete_data");
    await t.mutation(internal.executor.resolveApprovalInternal, {
      workspaceId: session.workspaceId,
      approvalId,
      decision: "denied",
      reviewerId: "e2e-reviewer",
      reason: "not allowed",
    });

    await runTask;

    const result = (await runCode) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = result.content.find((item) => item.type === "text")?.text ?? "";

    expect(result.isError).toBe(true);
    expect(text).toContain("status: denied");

    const task = await t.query(internal.database.getTask, { taskId });
    expect(task?.status).toBe("denied");
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, 30_000);
