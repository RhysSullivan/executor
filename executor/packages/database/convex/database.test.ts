import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel.d.ts";
import schema from "./schema";

function setup() {
  return convexTest(schema, {
    "./database.ts": () => import("./database"),
    "./toolRegistry.ts": () => import("./toolRegistry"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });
}

/** Insert a minimal workspace row and return its Id. */
async function seedWorkspace(t: ReturnType<typeof setup>, name = "test-ws"): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      name: `${name}-org`,
      slug: `${name}-org`,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("workspaces", {
      name,
      slug: name,
      organizationId: orgId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedAccount(t: ReturnType<typeof setup>, key: string): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("accounts", {
      provider: "anonymous",
      providerAccountId: key,
      name: key,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

test("task lifecycle supports queue, run, and complete", async () => {
  const t = setup();
  const wsId = await seedWorkspace(t, "ws_1");
  const accountId = await seedAccount(t, "account_1");

  const created = await t.mutation(internal.database.createTask, {
    id: "task_1",
    code: "console.log('hello')",
    runtimeId: "local-bun",
    workspaceId: wsId,
    accountId,
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
    status: "completed" as const,
    exitCode: 0,
  });
  expect(finished?.status).toBe("completed");

  const queuedAfter = await t.query(internal.database.listQueuedTaskIds, { limit: 10 });
  expect(queuedAfter).toEqual([]);
});

test("approval lifecycle tracks pending and resolution", async () => {
  const t = setup();
  const wsId = await seedWorkspace(t, "ws_2");
  const accountId = await seedAccount(t, "account_2");

  await t.mutation(internal.database.createTask, {
    id: "task_2",
    code: "await tools.admin.delete_data({ id: 'x' })",
    runtimeId: "local-bun",
    workspaceId: wsId,
    accountId,
    clientId: "web",
  });

  const createdApproval = await t.mutation(internal.database.createApproval, {
    id: "approval_1",
    taskId: "task_2",
    toolPath: "admin.delete_data",
    input: { id: "x" },
  });
  expect(createdApproval.status).toBe("pending");

  const pending = await t.query(internal.database.listPendingApprovals, { workspaceId: wsId });
  expect(pending.length).toBe(1);
  expect(pending[0]?.task.id).toBe("task_2");

  const resolved = await t.mutation(internal.database.resolveApproval, {
    approvalId: "approval_1",
    decision: "approved",
    reviewerId: "reviewer_1",
  });
  expect(resolved?.status).toBe("approved");

  const pendingAfter = await t.query(internal.database.listPendingApprovals, { workspaceId: wsId });
  expect(pendingAfter).toEqual([]);
});

test("anonymous bootstrap links guest account membership", async () => {
  const t = setup();

  const first = await t.mutation(internal.database.bootstrapAnonymousSession, {});
  expect(first.sessionId).toContain("anon_session_");
  expect(first.workspaceId.length).toBeGreaterThan(0);
  expect(first.accountId).toBeDefined();

  const again = await t.mutation(internal.database.bootstrapAnonymousSession, {
    sessionId: first.sessionId,
  });

  expect(again.sessionId).toBe(first.sessionId);
  expect(again.accountId).toBe(first.accountId);
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
  expect(again.accountId).toBe(seeded.accountId);
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
  expect(again.accountId).toBe(seeded.accountId);
});

test("credentials persist provider and resolve by scope", async () => {
  const t = setup();
  const wsId = await seedWorkspace(t, "ws_cred");

  const workspaceCredential = await t.mutation(internal.database.upsertCredential, {
    workspaceId: wsId,
    sourceKey: "openapi:github",
    scopeType: "workspace",
    provider: "local-convex",
    secretJson: { token: "workspace-token" },
  });

  expect(workspaceCredential.provider).toBe("local-convex");

  const accountId = await seedAccount(t, "cred-account");
  const accountCredential = await t.mutation(internal.database.upsertCredential, {
    workspaceId: wsId,
    sourceKey: "openapi:github",
    scopeType: "account",
    accountId,
    provider: "workos-vault",
    secretJson: { objectId: "secret_account_github" },
  });

  expect(accountCredential.provider).toBe("workos-vault");
  expect(accountCredential.accountId).toBe(accountId);

  const resolvedWorkspace = await t.query(internal.database.resolveCredential, {
    workspaceId: wsId,
    sourceKey: "openapi:github",
    scopeType: "workspace",
  });
  expect(resolvedWorkspace?.provider).toBe("local-convex");

  const resolvedActor = await t.query(internal.database.resolveCredential, {
    workspaceId: wsId,
    sourceKey: "openapi:github",
    scopeType: "account",
    accountId,
  });
  expect(resolvedActor?.provider).toBe("workos-vault");
});

test("upsertCredential defaults provider to local provider", async () => {
  const t = setup();
  const wsId = await seedWorkspace(t, "ws_default_provider");

  const credential = await t.mutation(internal.database.upsertCredential, {
    workspaceId: wsId,
    sourceKey: "openapi:stripe",
    scopeType: "workspace",
    secretJson: { token: "sk_test_123" },
  });

  expect(credential.provider).toBe("local-convex");
});

test("credentials can link one connection to multiple sources", async () => {
  const t = setup();
  const wsId = await seedWorkspace(t, "ws_linked_connection");

  const primary = await t.mutation(internal.database.upsertCredential, {
    workspaceId: wsId,
    sourceKey: "source:github",
    scopeType: "workspace",
    secretJson: { token: "token_v1" },
  });

  await t.mutation(internal.database.upsertCredential, {
    id: primary.id,
    workspaceId: wsId,
    sourceKey: "source:stripe",
    scopeType: "workspace",
    secretJson: {},
    overridesJson: { headers: { "x-tenant-id": "acme" } },
  });

  const linked = await t.query(internal.database.resolveCredential, {
    workspaceId: wsId,
    sourceKey: "source:stripe",
    scopeType: "workspace",
  });
  expect(linked?.id).toBe(primary.id);
  expect(linked?.secretJson).toEqual({ token: "token_v1" });
  expect(linked?.overridesJson).toEqual({ headers: { "x-tenant-id": "acme" } });

  await t.mutation(internal.database.upsertCredential, {
    id: primary.id,
    workspaceId: wsId,
    sourceKey: "source:github",
    scopeType: "workspace",
    secretJson: { token: "token_v2" },
  });

  const relinked = await t.query(internal.database.resolveCredential, {
    workspaceId: wsId,
    sourceKey: "source:stripe",
    scopeType: "workspace",
  });
  expect(relinked?.secretJson).toEqual({ token: "token_v2" });
});
