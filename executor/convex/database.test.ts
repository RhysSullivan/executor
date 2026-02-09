import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

function setup() {
  return convexTest(schema, {
    "./database.ts": () => import("./database"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });
}

test("task lifecycle supports queue, run, and complete", async () => {
  const t = setup();

  const created = await t.mutation(internal.database.createTask, {
    id: "task_1",
    code: "console.log('hello')",
    runtimeId: "local-bun",
    workspaceId: "ws_1",
    actorId: "actor_1",
    clientId: "web",
  });

  expect(created.id).toBe("task_1");
  expect(created.status).toBe("queued");

  const queued = await t.query(internal.database.listQueuedTaskIds, { limit: 10 });
  expect(queued).toEqual(["task_1"]);

  const running = await t.mutation(internal.database.markTaskRunning, { taskId: "task_1" });
  expect(running?.status).toBe("running");

  const secondRun = await t.mutation(internal.database.markTaskRunning, { taskId: "task_1" });
  expect(secondRun).toBeNull();

  const finished = await t.mutation(internal.database.markTaskFinished, {
    taskId: "task_1",
    status: "completed",
    stdout: "ok",
    stderr: "",
    exitCode: 0,
  });
  expect(finished?.status).toBe("completed");

  const queuedAfter = await t.query(internal.database.listQueuedTaskIds, { limit: 10 });
  expect(queuedAfter).toEqual([]);
});

test("approval lifecycle tracks pending and resolution", async () => {
  const t = setup();

  await t.mutation(internal.database.createTask, {
    id: "task_2",
    code: "await tools.admin.delete_data({ id: 'x' })",
    runtimeId: "local-bun",
    workspaceId: "ws_2",
    actorId: "actor_2",
    clientId: "web",
  });

  const createdApproval = await t.mutation(internal.database.createApproval, {
    id: "approval_1",
    taskId: "task_2",
    toolPath: "admin.delete_data",
    input: { id: "x" },
  });
  expect(createdApproval.status).toBe("pending");

  const pending = await t.query(internal.database.listPendingApprovals, { workspaceId: "ws_2" });
  expect(pending.length).toBe(1);
  expect(pending[0]?.task.id).toBe("task_2");

  const resolved = await t.mutation(internal.database.resolveApproval, {
    approvalId: "approval_1",
    decision: "approved",
    reviewerId: "reviewer_1",
  });
  expect(resolved?.status).toBe("approved");

  const pendingAfter = await t.query(internal.database.listPendingApprovals, { workspaceId: "ws_2" });
  expect(pendingAfter).toEqual([]);
});

test("anonymous bootstrap links guest account membership", async () => {
  const t = setup();

  const first = await t.mutation(internal.database.bootstrapAnonymousSession, {});
  expect(first.sessionId).toContain("anon_session_");
  expect(first.workspaceId.length).toBeGreaterThan(0);
  expect(first.actorId).toContain("anon_");
  expect(first.accountId).toBeDefined();
  expect(first.userId).toBeDefined();

  const again = await t.mutation(internal.database.bootstrapAnonymousSession, {
    sessionId: first.sessionId,
  });

  expect(again.sessionId).toBe(first.sessionId);
  expect(again.accountId).toBe(first.accountId);
  expect(again.userId).toBe(first.userId);
});

test("bootstrap ignores non-MCP caller-provided session id", async () => {
  const t = setup();

  const seeded = await t.mutation(internal.database.bootstrapAnonymousSession, {
    sessionId: "assistant-discord-dev",
  });

  expect(seeded.sessionId).not.toBe("assistant-discord-dev");
  expect(seeded.sessionId).toContain("anon_session_");

  const again = await t.mutation(internal.database.bootstrapAnonymousSession, {
    sessionId: seeded.sessionId,
  });

  expect(again.sessionId).toBe(seeded.sessionId);
  expect(again.workspaceId).toBe(seeded.workspaceId);
  expect(again.actorId).toBe(seeded.actorId);
});

test("bootstrap honors MCP caller-provided session id", async () => {
  const t = setup();

  const seeded = await t.mutation(internal.database.bootstrapAnonymousSession, {
    sessionId: "mcp_assistant-discord-dev",
  });

  expect(seeded.sessionId).toBe("mcp_assistant-discord-dev");

  const again = await t.mutation(internal.database.bootstrapAnonymousSession, {
    sessionId: "mcp_assistant-discord-dev",
  });

  expect(again.sessionId).toBe("mcp_assistant-discord-dev");
  expect(again.workspaceId).toBe(seeded.workspaceId);
  expect(again.actorId).toBe(seeded.actorId);
});

test("credentials persist provider and resolve by scope", async () => {
  const t = setup();

  const workspaceCredential = await t.mutation(internal.database.upsertCredential, {
    workspaceId: "ws_cred",
    sourceKey: "openapi:github",
    scope: "workspace",
    provider: "managed",
    secretJson: { token: "workspace-token" },
  });

  expect(workspaceCredential.provider).toBe("managed");

  const actorCredential = await t.mutation(internal.database.upsertCredential, {
    workspaceId: "ws_cred",
    sourceKey: "openapi:github",
    scope: "actor",
    actorId: "actor_cred",
    provider: "workos-vault",
    secretJson: { objectId: "secret_actor_github" },
  });

  expect(actorCredential.provider).toBe("workos-vault");
  expect(actorCredential.actorId).toBe("actor_cred");

  const resolvedWorkspace = await t.query(internal.database.resolveCredential, {
    workspaceId: "ws_cred",
    sourceKey: "openapi:github",
    scope: "workspace",
  });
  expect(resolvedWorkspace?.provider).toBe("managed");

  const resolvedActor = await t.query(internal.database.resolveCredential, {
    workspaceId: "ws_cred",
    sourceKey: "openapi:github",
    scope: "actor",
    actorId: "actor_cred",
  });
  expect(resolvedActor?.provider).toBe("workos-vault");
});

test("upsertCredential defaults provider to managed", async () => {
  const t = setup();

  const credential = await t.mutation(internal.database.upsertCredential, {
    workspaceId: "ws_default_provider",
    sourceKey: "openapi:stripe",
    scope: "workspace",
    secretJson: { token: "sk_test_123" },
  });

  expect(credential.provider).toBe("managed");
});
