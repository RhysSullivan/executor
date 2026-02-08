import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

function setup() {
  return convexTest(schema, {
    "./database.ts": () => import("./database"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });
}

test("task lifecycle supports queue, run, and complete", async () => {
  const t = setup();

  const created = await t.mutation(api.database.createTask, {
    id: "task_1",
    code: "console.log('hello')",
    runtimeId: "local-bun",
    workspaceId: "ws_1",
    actorId: "actor_1",
    clientId: "web",
  });

  expect(created.id).toBe("task_1");
  expect(created.status).toBe("queued");

  const queued = await t.query(api.database.listQueuedTaskIds, { limit: 10 });
  expect(queued).toEqual(["task_1"]);

  const running = await t.mutation(api.database.markTaskRunning, { taskId: "task_1" });
  expect(running?.status).toBe("running");

  const secondRun = await t.mutation(api.database.markTaskRunning, { taskId: "task_1" });
  expect(secondRun).toBeNull();

  const finished = await t.mutation(api.database.markTaskFinished, {
    taskId: "task_1",
    status: "completed",
    stdout: "ok",
    stderr: "",
    exitCode: 0,
  });
  expect(finished?.status).toBe("completed");

  const queuedAfter = await t.query(api.database.listQueuedTaskIds, { limit: 10 });
  expect(queuedAfter).toEqual([]);
});

test("approval lifecycle tracks pending and resolution", async () => {
  const t = setup();

  await t.mutation(api.database.createTask, {
    id: "task_2",
    code: "await tools.admin.delete_data({ id: 'x' })",
    runtimeId: "local-bun",
    workspaceId: "ws_2",
    actorId: "actor_2",
    clientId: "web",
  });

  const createdApproval = await t.mutation(api.database.createApproval, {
    id: "approval_1",
    taskId: "task_2",
    toolPath: "admin.delete_data",
    input: { id: "x" },
  });
  expect(createdApproval.status).toBe("pending");

  const pending = await t.query(api.database.listPendingApprovals, { workspaceId: "ws_2" });
  expect(pending.length).toBe(1);
  expect(pending[0]?.task.id).toBe("task_2");

  const resolved = await t.mutation(api.database.resolveApproval, {
    approvalId: "approval_1",
    decision: "approved",
    reviewerId: "reviewer_1",
  });
  expect(resolved?.status).toBe("approved");

  const pendingAfter = await t.query(api.database.listPendingApprovals, { workspaceId: "ws_2" });
  expect(pendingAfter).toEqual([]);
});

test("workspace tool inventory applies policy decisions by context", async () => {
  const t = setup();

  await t.mutation(api.database.syncWorkspaceTools, {
    workspaceId: "ws_tools",
    tools: [
      {
        path: "utils.get_time",
        description: "Read current time",
        approval: "auto",
      },
      {
        path: "admin.delete_data",
        description: "Delete data",
        approval: "required",
      },
    ],
  });

  await t.mutation(api.database.upsertAccessPolicy, {
    workspaceId: "ws_tools",
    toolPathPattern: "admin.*",
    decision: "deny",
    priority: 100,
  });

  await t.mutation(api.database.upsertAccessPolicy, {
    workspaceId: "ws_tools",
    actorId: "actor_allow",
    toolPathPattern: "admin.delete_data",
    decision: "require_approval",
    priority: 200,
  });

  const actorAllowTools = await t.query(api.database.listWorkspaceToolsForContext, {
    workspaceId: "ws_tools",
    actorId: "actor_allow",
    clientId: "web",
  });

  const actorDenyTools = await t.query(api.database.listWorkspaceToolsForContext, {
    workspaceId: "ws_tools",
    actorId: "actor_other",
    clientId: "web",
  });

  const actorAllow = actorAllowTools.filter((tool): tool is NonNullable<typeof tool> => tool !== null);
  const actorDeny = actorDenyTools.filter((tool): tool is NonNullable<typeof tool> => tool !== null);

  expect(actorAllow.map((tool) => tool.path)).toEqual(["admin.delete_data", "utils.get_time"]);
  expect(actorAllow.find((tool) => tool.path === "admin.delete_data")?.approval).toBe("required");

  expect(actorDeny.map((tool) => tool.path)).toEqual(["utils.get_time"]);
});
