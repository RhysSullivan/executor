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

test("anonymous bootstrap links guest account membership", async () => {
  const t = setup();

  const first = await t.mutation(api.database.bootstrapAnonymousSession, {});
  expect(first.sessionId).toContain("anon_session_");
  expect(first.workspaceId).toContain("ws_");
  expect(first.actorId).toContain("anon_");
  expect(first.accountId).toBeDefined();
  expect(first.workspaceDocId).toBeDefined();
  expect(first.userId).toBeDefined();

  const again = await t.mutation(api.database.bootstrapAnonymousSession, {
    sessionId: first.sessionId,
  });

  expect(again.sessionId).toBe(first.sessionId);
  expect(again.accountId).toBe(first.accountId);
  expect(again.workspaceDocId).toBe(first.workspaceDocId);
  expect(again.userId).toBe(first.userId);
});

test("bootstrap honors caller-provided session id", async () => {
  const t = setup();

  const seeded = await t.mutation(api.database.bootstrapAnonymousSession, {
    sessionId: "assistant-discord-dev",
  });

  expect(seeded.sessionId).toBe("assistant-discord-dev");

  const again = await t.mutation(api.database.bootstrapAnonymousSession, {
    sessionId: "assistant-discord-dev",
  });

  expect(again.sessionId).toBe("assistant-discord-dev");
  expect(again.workspaceId).toBe(seeded.workspaceId);
  expect(again.actorId).toBe(seeded.actorId);
});
