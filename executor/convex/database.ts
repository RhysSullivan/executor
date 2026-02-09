import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { ensureUniqueSlug } from "../lib/slug";
import type { TaskStatus } from "@executor/contracts";

const DEFAULT_TIMEOUT_MS = 300_000;
type OrganizationRole = "owner" | "admin" | "member" | "billing_admin";
type OrganizationMemberStatus = "active" | "pending" | "removed";

const completedTaskStatusValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("timed_out"),
  v.literal("denied"),
);
const approvalStatusValidator = v.union(v.literal("pending"), v.literal("approved"), v.literal("denied"));
const policyDecisionValidator = v.union(v.literal("allow"), v.literal("require_approval"), v.literal("deny"));
const credentialScopeValidator = v.union(v.literal("workspace"), v.literal("actor"));
const credentialProviderValidator = v.union(
  v.literal("managed"),
  v.literal("workos-vault"),
);
const toolSourceTypeValidator = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));
const agentTaskStatusValidator = v.union(v.literal("running"), v.literal("completed"), v.literal("failed"));

function normalizeOptional(value?: string): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function optionalFromNormalized(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
}

async function ensureUniqueOrganizationSlug(ctx: Pick<MutationCtx, "db">, baseName: string): Promise<string> {
  const baseSlug = slugify(baseName);
  return await ensureUniqueSlug(baseSlug, async (candidate) => {
    const collision = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();
    return collision !== null;
  });
}

async function upsertOrganizationMembership(
  ctx: Pick<MutationCtx, "db">,
  args: {
    organizationId: Doc<"organizations">["_id"];
    accountId: Doc<"accounts">["_id"];
    role: OrganizationRole;
    status: OrganizationMemberStatus;
    billable: boolean;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_account", (q) => q.eq("organizationId", args.organizationId).eq("accountId", args.accountId))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      role: args.role,
      status: args.status,
      billable: args.billable,
      joinedAt: args.status === "active" ? (existing.joinedAt ?? args.now) : existing.joinedAt,
      updatedAt: args.now,
    });
    return;
  }

  await ctx.db.insert("organizationMembers", {
    organizationId: args.organizationId,
    accountId: args.accountId,
    role: args.role,
    status: args.status,
    billable: args.billable,
    joinedAt: args.status === "active" ? args.now : undefined,
    createdAt: args.now,
    updatedAt: args.now,
  });
}

// NOTE: Canonical version lives in convex/lib/utils.ts.
// Convex can't import from the server, so this is a local copy.
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mapTask(doc: Doc<"tasks">) {
  return {
    id: doc.taskId,
    code: doc.code,
    runtimeId: doc.runtimeId,
    status: doc.status,
    timeoutMs: typeof doc.timeoutMs === "number" ? doc.timeoutMs : DEFAULT_TIMEOUT_MS,
    metadata: asRecord(doc.metadata),
    workspaceId: doc.workspaceId,
    actorId: optionalFromNormalized(doc.actorId),
    clientId: optionalFromNormalized(doc.clientId),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    error: doc.error,
    stdout: doc.stdout,
    stderr: doc.stderr,
    exitCode: doc.exitCode,
  };
}

function mapApproval(doc: Doc<"approvals">) {
  return {
    id: doc.approvalId,
    taskId: doc.taskId,
    toolPath: doc.toolPath,
    input: doc.input,
    status: doc.status,
    reason: doc.reason,
    reviewerId: doc.reviewerId,
    createdAt: doc.createdAt,
    resolvedAt: doc.resolvedAt,
  };
}

function mapPolicy(doc: Doc<"accessPolicies">) {
  return {
    id: doc.policyId,
    workspaceId: doc.workspaceId,
    actorId: optionalFromNormalized(doc.actorId),
    clientId: optionalFromNormalized(doc.clientId),
    toolPathPattern: doc.toolPathPattern,
    decision: doc.decision,
    priority: doc.priority,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mapCredential(doc: Doc<"sourceCredentials">) {
  return {
    id: doc.credentialId,
    workspaceId: doc.workspaceId,
    sourceKey: doc.sourceKey,
    scope: doc.scope,
    actorId: optionalFromNormalized(doc.actorId),
    provider: doc.provider ?? "managed",
    secretJson: asRecord(doc.secretJson),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mapSource(doc: Doc<"toolSources">) {
  return {
    id: doc.sourceId,
    workspaceId: doc.workspaceId,
    name: doc.name,
    type: doc.type,
    config: asRecord(doc.config),
    enabled: Boolean(doc.enabled),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function ensureAnonymousIdentity(
  ctx: MutationCtx,
  params: {
    sessionId: string;
    workspaceId?: Doc<"workspaces">["_id"];
    actorId: string;
    timestamp: number;
  },
) {
  const now = params.timestamp;

  let account = await ctx.db
    .query("accounts")
    .withIndex("by_provider", (q) => q.eq("provider", "anonymous").eq("providerAccountId", params.actorId))
    .unique();

  if (!account) {
    const accountId = await ctx.db.insert("accounts", {
      provider: "anonymous",
      providerAccountId: params.actorId,
      email: `${params.actorId}@guest.executor.local`,
      name: "Guest User",
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    });
    account = await ctx.db.get(accountId);
    if (!account) {
      throw new Error("Failed to create anonymous account");
    }
  } else {
    await ctx.db.patch(account._id, { updatedAt: now, lastLoginAt: now });
  }

  let workspace = params.workspaceId ? await ctx.db.get(params.workspaceId) : null;

  let organizationId: Doc<"organizations">["_id"];

  if (!workspace) {
    const organizationSlug = await ensureUniqueOrganizationSlug(ctx, "Guest Workspace");
    organizationId = await ctx.db.insert("organizations", {
      slug: organizationSlug,
      name: "Guest Workspace",
      status: "active",
      createdByAccountId: account._id,
      createdAt: now,
      updatedAt: now,
    });

    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      slug: `guest-${crypto.randomUUID().slice(0, 8)}`,
      name: "Guest Workspace",
      plan: "free",
      createdByAccountId: account._id,
      createdAt: now,
      updatedAt: now,
    });
    workspace = await ctx.db.get(workspaceId);
    if (!workspace) {
      throw new Error("Failed to create anonymous workspace");
    }
  } else {
    organizationId = workspace.organizationId;
  }

  await upsertOrganizationMembership(ctx, {
    organizationId,
    accountId: account._id,
    role: "owner",
    status: "active",
    billable: true,
    now,
  });

  let user = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_account", (q) => q.eq("workspaceId", workspace._id).eq("accountId", account._id))
    .unique();

  if (!user) {
    const userId = await ctx.db.insert("workspaceMembers", {
      workspaceId: workspace._id,
      accountId: account._id,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("Failed to create anonymous user membership");
    }
  } else {
    await ctx.db.patch(user._id, { updatedAt: now });
  }

  return {
    accountId: account._id,
    workspaceId: workspace._id,
    userId: user._id,
  };
}

function mapAnonymousContext(doc: Doc<"anonymousSessions">) {
  return {
    sessionId: doc.sessionId,
    workspaceId: doc.workspaceId,
    actorId: doc.actorId,
    clientId: doc.clientId,
    accountId: doc.accountId,
    userId: doc.userId,
    createdAt: doc.createdAt,
    lastSeenAt: doc.lastSeenAt,
  };
}

function mapTaskEvent(doc: Doc<"taskEvents">) {
  return {
    id: doc.sequence,
    taskId: doc.taskId,
    eventName: doc.eventName,
    type: doc.type,
    payload: doc.payload,
    createdAt: doc.createdAt,
  };
}

async function getTaskDoc(ctx: { db: QueryCtx["db"] }, taskId: string) {
  return await ctx.db.query("tasks").withIndex("by_task_id", (q) => q.eq("taskId", taskId)).unique();
}

async function getApprovalDoc(ctx: { db: QueryCtx["db"] }, approvalId: string) {
  return await ctx.db
    .query("approvals")
    .withIndex("by_approval_id", (q) => q.eq("approvalId", approvalId))
    .unique();
}

export const createTask = internalMutation({
  args: {
    id: v.string(),
    code: v.string(),
    runtimeId: v.string(),
    timeoutMs: v.optional(v.number()),
    metadata: v.optional(v.any()),
    workspaceId: v.string(),
    actorId: v.string(),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await getTaskDoc(ctx, args.id);
    if (existing) {
      throw new Error(`Task already exists: ${args.id}`);
    }

    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId: args.id,
      code: args.code,
      runtimeId: args.runtimeId,
      workspaceId: args.workspaceId,
      actorId: normalizeOptional(args.actorId),
      clientId: normalizeOptional(args.clientId),
      status: "queued",
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      metadata: asRecord(args.metadata),
      createdAt: now,
      updatedAt: now,
    });

    const created = await getTaskDoc(ctx, args.id);
    if (!created) {
      throw new Error(`Failed to fetch created task ${args.id}`);
    }
    return mapTask(created);
  },
});

export const getTask = internalQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    return doc ? mapTask(doc) : null;
  },
});

export const listTasks = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(500);
    return docs.map(mapTask);
  },
});

export const listQueuedTaskIds = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("tasks")
      .withIndex("by_status_created", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(args.limit ?? 20);

    return docs.map((doc) => doc.taskId);
  },
});

export const listRuntimeTargets = internalQuery({
  args: {},
  handler: async () => {
    return [
      {
        id: "local-bun",
        label: "Local JS Runtime",
        description: "Runs generated code in-process using Bun",
      },
    ];
  },
});

export const getTaskInWorkspace = internalQuery({
  args: { taskId: v.string(), workspaceId: v.string() },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc || doc.workspaceId !== args.workspaceId) {
      return null;
    }
    return mapTask(doc);
  },
});

export const markTaskRunning = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc || doc.status !== "queued") {
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: "running",
      startedAt: doc.startedAt ?? now,
      updatedAt: now,
    });

    const updated = await getTaskDoc(ctx, args.taskId);
    return updated ? mapTask(updated) : null;
  },
});

export const markTaskFinished = internalMutation({
  args: {
    taskId: v.string(),
    status: completedTaskStatusValidator,
    stdout: v.string(),
    stderr: v.string(),
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc) {
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: args.status,
      stdout: args.stdout,
      stderr: args.stderr,
      exitCode: args.exitCode,
      error: args.error,
      completedAt: now,
      updatedAt: now,
    });

    const updated = await getTaskDoc(ctx, args.taskId);
    return updated ? mapTask(updated) : null;
  },
});

export const createApproval = internalMutation({
  args: {
    id: v.string(),
    taskId: v.string(),
    toolPath: v.string(),
    input: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await getApprovalDoc(ctx, args.id);
    if (existing) {
      throw new Error(`Approval already exists: ${args.id}`);
    }

    const task = await getTaskDoc(ctx, args.taskId);
    if (!task) {
      throw new Error(`Task not found for approval: ${args.taskId}`);
    }

    const now = Date.now();
    await ctx.db.insert("approvals", {
      approvalId: args.id,
      taskId: args.taskId,
      workspaceId: task.workspaceId,
      toolPath: args.toolPath,
      input: args.input ?? {},
      status: "pending",
      createdAt: now,
    });

    const created = await getApprovalDoc(ctx, args.id);
    if (!created) {
      throw new Error(`Failed to fetch approval ${args.id}`);
    }
    return mapApproval(created);
  },
});

export const getApproval = internalQuery({
  args: { approvalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await getApprovalDoc(ctx, args.approvalId);
    return doc ? mapApproval(doc) : null;
  },
});

export const listApprovals = internalQuery({
  args: {
    workspaceId: v.string(),
    status: v.optional(approvalStatusValidator),
  },
  handler: async (ctx, args) => {
    if (args.status) {
      const status = args.status;
      const docs = await ctx.db
        .query("approvals")
        .withIndex("by_workspace_status_created", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("status", status),
        )
        .order("desc")
        .collect();
      return docs.map(mapApproval);
    }

    const docs = await ctx.db
      .query("approvals")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(500);
    return docs.map(mapApproval);
  },
});

export const listPendingApprovals = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("approvals")
      .withIndex("by_workspace_status_created", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("status", "pending"),
      )
      .order("asc")
      .collect();

    const tasks = await Promise.all(docs.map((approval) => getTaskDoc(ctx, approval.taskId)));

    const results: Array<
      ReturnType<typeof mapApproval> & {
        task: { id: string; status: TaskStatus; runtimeId: string; timeoutMs: number; createdAt: number };
      }
    > = [];
    for (let i = 0; i < docs.length; i++) {
      const approval = docs[i]!;
      const task = tasks[i];
      if (!task) {
        continue;
      }

      results.push({
        ...mapApproval(approval),
        task: {
          id: task.taskId,
          status: task.status,
          runtimeId: task.runtimeId,
          timeoutMs: task.timeoutMs,
          createdAt: task.createdAt,
        },
      });
    }

    return results;
  },
});

export const resolveApproval = internalMutation({
  args: {
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    reviewerId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await getApprovalDoc(ctx, args.approvalId);
    if (!doc || doc.status !== "pending") {
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: args.decision,
      reason: args.reason,
      reviewerId: args.reviewerId,
      resolvedAt: now,
    });

    const updated = await getApprovalDoc(ctx, args.approvalId);
    return updated ? mapApproval(updated) : null;
  },
});

export const getApprovalInWorkspace = internalQuery({
  args: { approvalId: v.string(), workspaceId: v.string() },
  handler: async (ctx, args) => {
    const doc = await getApprovalDoc(ctx, args.approvalId);
    if (!doc || doc.workspaceId !== args.workspaceId) {
      return null;
    }
    return mapApproval(doc);
  },
});

// ── Agent Tasks ──

function mapAgentTask(doc: Doc<"agentTasks">) {
  return {
    id: doc.agentTaskId,
    prompt: doc.prompt,
    requesterId: doc.requesterId,
    workspaceId: doc.workspaceId,
    actorId: doc.actorId,
    status: doc.status,
    resultText: doc.resultText,
    error: doc.error,
    codeRuns: doc.codeRuns ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function getAgentTaskDoc(ctx: { db: QueryCtx["db"] }, agentTaskId: string) {
  return await ctx.db
    .query("agentTasks")
    .withIndex("by_agent_task_id", (q) => q.eq("agentTaskId", agentTaskId))
    .unique();
}

export const createAgentTask = internalMutation({
  args: {
    id: v.string(),
    prompt: v.string(),
    requesterId: v.string(),
    workspaceId: v.string(),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await getAgentTaskDoc(ctx, args.id);
    if (existing) {
      throw new Error(`Agent task already exists: ${args.id}`);
    }

    const now = Date.now();
    await ctx.db.insert("agentTasks", {
      agentTaskId: args.id,
      prompt: args.prompt,
      requesterId: args.requesterId,
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      status: "running",
      codeRuns: 0,
      createdAt: now,
      updatedAt: now,
    });

    const created = await getAgentTaskDoc(ctx, args.id);
    if (!created) throw new Error(`Failed to fetch created agent task ${args.id}`);
    return mapAgentTask(created);
  },
});

export const getAgentTask = internalQuery({
  args: { agentTaskId: v.string() },
  handler: async (ctx, args) => {
    const doc = await getAgentTaskDoc(ctx, args.agentTaskId);
    return doc ? mapAgentTask(doc) : null;
  },
});

export const updateAgentTask = internalMutation({
  args: {
    agentTaskId: v.string(),
    status: v.optional(agentTaskStatusValidator),
    resultText: v.optional(v.string()),
    error: v.optional(v.string()),
    codeRuns: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const doc = await getAgentTaskDoc(ctx, args.agentTaskId);
    if (!doc) return null;

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.resultText !== undefined) patch.resultText = args.resultText;
    if (args.error !== undefined) patch.error = args.error;
    if (args.codeRuns !== undefined) patch.codeRuns = args.codeRuns;

    await ctx.db.patch(doc._id, patch);
    const updated = await getAgentTaskDoc(ctx, args.agentTaskId);
    return updated ? mapAgentTask(updated) : null;
  },
});

export const bootstrapAnonymousSession = internalMutation({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const requestedSessionId = normalizeOptional(args.sessionId);
    const allowRequestedSessionId = requestedSessionId?.startsWith("mcp_") ?? false;

    if (requestedSessionId) {
      const sessionId = requestedSessionId;
      const existing = await ctx.db
        .query("anonymousSessions")
        .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
        .unique();
      if (existing) {
        const identity = await ensureAnonymousIdentity(ctx, {
          sessionId,
          workspaceId: existing.workspaceId,
          actorId: existing.actorId,
          timestamp: now,
        });

        await ctx.db.patch(existing._id, {
          workspaceId: identity.workspaceId,
          accountId: identity.accountId,
          userId: identity.userId,
          lastSeenAt: now,
        });

        const refreshed = await ctx.db
          .query("anonymousSessions")
          .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
          .unique();
        if (!refreshed) {
          throw new Error("Failed to refresh anonymous session");
        }
        return mapAnonymousContext(refreshed);
      }
    }

    const generatedSessionId = allowRequestedSessionId
      ? `mcp_${crypto.randomUUID()}`
      : `anon_session_${crypto.randomUUID()}`;
    const sessionId = allowRequestedSessionId
      ? requestedSessionId as string
      : generatedSessionId;
    const actorId = `anon_${crypto.randomUUID()}`;
    const clientId = "web";

    const identity = await ensureAnonymousIdentity(ctx, {
      sessionId,
      actorId,
      timestamp: now,
    });

    await ctx.db.insert("anonymousSessions", {
      sessionId,
      workspaceId: identity.workspaceId,
      actorId,
      clientId,
      accountId: identity.accountId,
      userId: identity.userId,
      createdAt: now,
      lastSeenAt: now,
    });

    const created = await ctx.db
      .query("anonymousSessions")
      .withIndex("by_session_id", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (!created) {
      throw new Error("Failed to create anonymous session");
    }

    return mapAnonymousContext(created);
  },
});

export const upsertAccessPolicy = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.string(),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
    toolPathPattern: v.string(),
    decision: policyDecisionValidator,
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const policyId = args.id ?? `policy_${crypto.randomUUID()}`;
    const existing = await ctx.db
      .query("accessPolicies")
      .withIndex("by_policy_id", (q) => q.eq("policyId", policyId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        workspaceId: args.workspaceId,
        actorId: normalizeOptional(args.actorId),
        clientId: normalizeOptional(args.clientId),
        toolPathPattern: args.toolPathPattern,
        decision: args.decision,
        priority: args.priority ?? 100,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("accessPolicies", {
        policyId,
        workspaceId: args.workspaceId,
        actorId: normalizeOptional(args.actorId),
        clientId: normalizeOptional(args.clientId),
        toolPathPattern: args.toolPathPattern,
        decision: args.decision,
        priority: args.priority ?? 100,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updated = await ctx.db
      .query("accessPolicies")
      .withIndex("by_policy_id", (q) => q.eq("policyId", policyId))
      .unique();
    if (!updated) {
      throw new Error(`Failed to read policy ${policyId}`);
    }
    return mapPolicy(updated);
  },
});

export const listAccessPolicies = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("accessPolicies")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    return docs
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt - b.createdAt;
      })
      .map(mapPolicy);
  },
});

export const upsertCredential = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.string(),
    sourceKey: v.string(),
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
    provider: v.optional(credentialProviderValidator),
    secretJson: v.any(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const actorId = args.scope === "actor" ? normalizeOptional(args.actorId) : "";

    const existing = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_source_scope_actor", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("sourceKey", args.sourceKey)
          .eq("scope", args.scope)
          .eq("actorId", actorId),
      )
      .unique();

    const provider = args.provider ?? existing?.provider ?? "managed";

    if (existing) {
      await ctx.db.patch(existing._id, {
        provider,
        secretJson: asRecord(args.secretJson),
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("sourceCredentials", {
        credentialId: args.id ?? `cred_${crypto.randomUUID()}`,
        workspaceId: args.workspaceId,
        sourceKey: args.sourceKey,
        scope: args.scope,
        actorId,
        provider,
        secretJson: asRecord(args.secretJson),
        createdAt: now,
        updatedAt: now,
      });
    }

    const updated = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_source_scope_actor", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("sourceKey", args.sourceKey)
          .eq("scope", args.scope)
          .eq("actorId", actorId),
      )
      .unique();

    if (!updated) {
      throw new Error("Failed to read upserted credential");
    }

    return mapCredential(updated);
  },
});

export const listCredentials = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .collect();
    return docs.map(mapCredential);
  },
});

export const listCredentialProviders = internalQuery({
  args: {},
  handler: async () => {
    return [
      {
        id: "managed",
        label: "Managed",
        description: "Store credential payload in Executor's sourceCredentials table.",
      },
      {
        id: "workos-vault",
        label: "Encrypted",
        description: "Store credential payload in encrypted external storage.",
      },
    ] as const;
  },
});

export const resolveCredential = internalQuery({
  args: {
    workspaceId: v.string(),
    sourceKey: v.string(),
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.scope === "actor") {
      const actorId = normalizeOptional(args.actorId);
      if (!actorId) {
        return null;
      }

      const actorDoc = await ctx.db
        .query("sourceCredentials")
        .withIndex("by_workspace_source_scope_actor", (q) =>
          q
            .eq("workspaceId", args.workspaceId)
            .eq("sourceKey", args.sourceKey)
            .eq("scope", "actor")
            .eq("actorId", actorId),
        )
        .unique();

      return actorDoc ? mapCredential(actorDoc) : null;
    }

    const workspaceDoc = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_source_scope_actor", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("sourceKey", args.sourceKey)
          .eq("scope", "workspace")
          .eq("actorId", ""),
      )
      .unique();

    return workspaceDoc ? mapCredential(workspaceDoc) : null;
  },
});

export const upsertToolSource = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.string(),
    name: v.string(),
    type: toolSourceTypeValidator,
    config: v.any(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const sourceId = args.id ?? `src_${crypto.randomUUID()}`;
    const [existing, conflict] = await Promise.all([
      ctx.db
        .query("toolSources")
        .withIndex("by_source_id", (q) => q.eq("sourceId", sourceId))
        .unique(),
      ctx.db
        .query("toolSources")
        .withIndex("by_workspace_name", (q) => q.eq("workspaceId", args.workspaceId).eq("name", args.name))
        .unique(),
    ]);

    if (conflict && conflict.sourceId !== sourceId) {
      throw new Error(`Tool source name '${args.name}' already exists in workspace ${args.workspaceId}`);
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        workspaceId: args.workspaceId,
        name: args.name,
        type: args.type,
        config: asRecord(args.config),
        enabled: args.enabled !== false,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("toolSources", {
        sourceId,
        workspaceId: args.workspaceId,
        name: args.name,
        type: args.type,
        config: asRecord(args.config),
        enabled: args.enabled !== false,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updated = await ctx.db
      .query("toolSources")
      .withIndex("by_source_id", (q) => q.eq("sourceId", sourceId))
      .unique();
    if (!updated) {
      throw new Error(`Failed to read tool source ${sourceId}`);
    }
    return mapSource(updated);
  },
});

export const listToolSources = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("toolSources")
      .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .collect();
    return docs.map(mapSource);
  },
});

export const deleteToolSource = internalMutation({
  args: { workspaceId: v.string(), sourceId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("toolSources")
      .withIndex("by_source_id", (q) => q.eq("sourceId", args.sourceId))
      .unique();

    if (!doc || doc.workspaceId !== args.workspaceId) {
      return false;
    }

    await ctx.db.delete(doc._id);
    return true;
  },
});

export const createTaskEvent = internalMutation({
  args: {
    taskId: v.string(),
    eventName: v.string(),
    type: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const task = await getTaskDoc(ctx, args.taskId);
    if (!task) {
      throw new Error(`Task not found for event: ${args.taskId}`);
    }

    const latest = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_sequence", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .first();

    const sequence = latest ? latest.sequence + 1 : 1;
    const createdAt = Date.now();

    await ctx.db.insert("taskEvents", {
      sequence,
      taskId: args.taskId,
      eventName: args.eventName,
      type: args.type,
      payload: asRecord(args.payload),
      createdAt,
    });

    const created = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_sequence", (q) => q.eq("taskId", args.taskId).eq("sequence", sequence))
      .unique();

    if (!created) {
      throw new Error("Failed to read inserted task event");
    }

    return mapTaskEvent(created);
  },
});

export const listTaskEvents = internalQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_sequence", (q) => q.eq("taskId", args.taskId))
      .order("asc")
      .collect();

    return docs.map(mapTaskEvent);
  },
});
