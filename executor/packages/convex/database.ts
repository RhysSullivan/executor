import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { slugify } from "../core/src/identity";
import { ensureUniqueSlug } from "../core/src/slug";
import type { TaskStatus } from "../core/src/types";

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
const terminalToolCallStatusValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("denied"),
);
const policyDecisionValidator = v.union(v.literal("allow"), v.literal("require_approval"), v.literal("deny"));
const credentialScopeValidator = v.union(v.literal("workspace"), v.literal("actor"));
const credentialProviderValidator = v.union(
  v.literal("local-convex"),
  v.literal("workos-vault"),
);
const toolSourceTypeValidator = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));

async function ensureUniqueOrganizationSlug(ctx: Pick<MutationCtx, "db">, baseName: string): Promise<string> {
  const baseSlug = slugify(baseName, "workspace");
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeSourceAuthFingerprint(value: unknown): string {
  const auth = asRecord(value);
  const type = typeof auth.type === "string" ? auth.type.trim() : "none";
  const mode = auth.mode === "actor" ? "actor" : "workspace";
  const header = typeof auth.header === "string" ? auth.header.trim().toLowerCase() : "";
  return stableStringify({
    type: type || "none",
    mode,
    ...(header ? { header } : {}),
  });
}

function computeSourceSpecHash(type: "mcp" | "openapi" | "graphql", config: Record<string, unknown>): string {
  if (type === "openapi") {
    const spec = config.spec;
    if (typeof spec === "string") {
      return `openapi:${spec.trim()}`;
    }
    return `openapi:${stableStringify(spec)}`;
  }
  if (type === "graphql") {
    const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
    return `graphql:${endpoint}`;
  }
  const url = typeof config.url === "string" ? config.url.trim() : "";
  return `mcp:${url}`;
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
    actorId: doc.actorId,
    clientId: doc.clientId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    error: doc.error,
    result: doc.result,
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

function mapToolCall(doc: Doc<"toolCalls">) {
  return {
    taskId: doc.taskId,
    callId: doc.callId,
    workspaceId: doc.workspaceId,
    toolPath: doc.toolPath,
    status: doc.status,
    approvalId: doc.approvalId,
    error: doc.error,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    completedAt: doc.completedAt,
  };
}

function mapPolicy(doc: Doc<"accessPolicies">) {
  return {
    id: doc.policyId,
    workspaceId: doc.workspaceId,
    actorId: doc.actorId,
    clientId: doc.clientId,
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
    bindingId: doc.bindingId,
    workspaceId: doc.workspaceId,
    sourceKey: doc.sourceKey,
    scope: doc.scope,
    actorId: doc.actorId || undefined,
    provider: doc.provider,
    secretJson: asRecord(doc.secretJson),
    overridesJson: asRecord(doc.overridesJson),
    boundAuthFingerprint: doc.boundAuthFingerprint,
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
    specHash: doc.specHash,
    authFingerprint: doc.authFingerprint,
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
  const anonymousOrganizationName = "Anonymous Organization";
  const anonymousWorkspaceName = "Anonymous Workspace";
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
    const organizationSlug = await ensureUniqueOrganizationSlug(ctx, anonymousOrganizationName);
    organizationId = await ctx.db.insert("organizations", {
      slug: organizationSlug,
      name: anonymousOrganizationName,
      status: "active",
      createdByAccountId: account._id,
      createdAt: now,
      updatedAt: now,
    });

    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      slug: `anonymous-${crypto.randomUUID().slice(0, 8)}`,
      name: anonymousWorkspaceName,
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

async function getToolCallDoc(
  ctx: { db: QueryCtx["db"] },
  taskId: string,
  callId: string,
) {
  return await ctx.db
    .query("toolCalls")
    .withIndex("by_task_call", (q) => q.eq("taskId", taskId).eq("callId", callId))
    .unique();
}

export const createTask = internalMutation({
  args: {
    id: v.string(),
    code: v.string(),
    runtimeId: v.string(),
    timeoutMs: v.optional(v.number()),
    metadata: v.optional(v.any()),
    workspaceId: v.id("workspaces"),
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
      actorId: args.actorId?.trim() || undefined,
      clientId: args.clientId?.trim() || undefined,
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
  args: { workspaceId: v.id("workspaces") },
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
      {
        id: "cloudflare-worker-loader",
        label: "Cloudflare Worker Loader",
        description: "Runs generated code in a Cloudflare Worker",
      }
    ];
  },
});

export const getTaskInWorkspace = internalQuery({
  args: { taskId: v.string(), workspaceId: v.id("workspaces") },
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
    result: v.optional(v.any()),
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc) {
      return null;
    }

    if (doc.status === "completed" || doc.status === "failed" || doc.status === "timed_out" || doc.status === "denied") {
      return mapTask(doc);
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: args.status,
      result: args.result,
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
    workspaceId: v.id("workspaces"),
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
  args: { workspaceId: v.id("workspaces") },
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
  args: { approvalId: v.string(), workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const doc = await getApprovalDoc(ctx, args.approvalId);
    if (!doc || doc.workspaceId !== args.workspaceId) {
      return null;
    }
    return mapApproval(doc);
  },
});

export const upsertToolCallRequested = internalMutation({
  args: {
    taskId: v.string(),
    callId: v.string(),
    workspaceId: v.id("workspaces"),
    toolPath: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (existing) {
      return mapToolCall(existing);
    }

    const now = Date.now();
    await ctx.db.insert("toolCalls", {
      taskId: args.taskId,
      callId: args.callId,
      workspaceId: args.workspaceId,
      toolPath: args.toolPath,
      status: "requested",
      createdAt: now,
      updatedAt: now,
    });

    const created = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!created) {
      throw new Error(`Failed to create tool call ${args.taskId}/${args.callId}`);
    }
    return mapToolCall(created);
  },
});

export const getToolCall = internalQuery({
  args: {
    taskId: v.string(),
    callId: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await getToolCallDoc(ctx, args.taskId, args.callId);
    return doc ? mapToolCall(doc) : null;
  },
});

export const setToolCallPendingApproval = internalMutation({
  args: {
    taskId: v.string(),
    callId: v.string(),
    approvalId: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!doc) {
      throw new Error(`Tool call not found: ${args.taskId}/${args.callId}`);
    }

    if (doc.status === "completed" || doc.status === "failed" || doc.status === "denied") {
      return mapToolCall(doc);
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: "pending_approval",
      approvalId: args.approvalId,
      updatedAt: now,
    });

    const updated = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!updated) {
      throw new Error(`Failed to read tool call ${args.taskId}/${args.callId}`);
    }
    return mapToolCall(updated);
  },
});

export const finishToolCall = internalMutation({
  args: {
    taskId: v.string(),
    callId: v.string(),
    status: terminalToolCallStatusValidator,
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!doc) {
      throw new Error(`Tool call not found: ${args.taskId}/${args.callId}`);
    }

    if (doc.status === "completed" || doc.status === "failed" || doc.status === "denied") {
      return mapToolCall(doc);
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: args.status,
      error: args.error,
      updatedAt: now,
      completedAt: now,
    });

    const updated = await getToolCallDoc(ctx, args.taskId, args.callId);
    if (!updated) {
      throw new Error(`Failed to read tool call ${args.taskId}/${args.callId}`);
    }
    return mapToolCall(updated);
  },
});

export const listToolCalls = internalQuery({
  args: {
    taskId: v.string(),
  },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("toolCalls")
      .withIndex("by_task_created", (q) => q.eq("taskId", args.taskId))
      .order("asc")
      .collect();

    return docs.map(mapToolCall);
  },
});

export const bootstrapAnonymousSession = internalMutation({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const requestedSessionId = args.sessionId?.trim() || "";
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
    workspaceId: v.id("workspaces"),
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
        actorId: args.actorId?.trim() || undefined,
        clientId: args.clientId?.trim() || undefined,
        toolPathPattern: args.toolPathPattern,
        decision: args.decision,
        priority: args.priority ?? 100,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("accessPolicies", {
        policyId,
        workspaceId: args.workspaceId,
        actorId: args.actorId?.trim() || undefined,
        clientId: args.clientId?.trim() || undefined,
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
  args: { workspaceId: v.id("workspaces") },
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

async function computeBoundAuthFingerprint(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  workspaceId: Doc<"workspaces">["_id"],
  sourceKey: string,
): Promise<string> {
  const prefix = "source:";
  if (!sourceKey.startsWith(prefix)) {
    return normalizeSourceAuthFingerprint({ type: "none" });
  }

  const sourceId = sourceKey.slice(prefix.length).trim();
  if (!sourceId) {
    return normalizeSourceAuthFingerprint({ type: "none" });
  }

  const source = await ctx.db
    .query("toolSources")
    .withIndex("by_source_id", (q) => q.eq("sourceId", sourceId))
    .unique();

  if (!source || source.workspaceId !== workspaceId) {
    return normalizeSourceAuthFingerprint({ type: "none" });
  }

  return normalizeSourceAuthFingerprint(asRecord(source.config).auth);
}

export const upsertCredential = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    sourceKey: v.string(),
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
    provider: v.optional(credentialProviderValidator),
    secretJson: v.any(),
    overridesJson: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const actorId = args.scope === "actor" ? (args.actorId?.trim() || "") : "";
    const submittedSecret = asRecord(args.secretJson);
    const hasSubmittedSecret = Object.keys(submittedSecret).length > 0;

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

    let requestedId = args.id?.trim() || "";
    if (requestedId.startsWith("bind_")) {
      const binding = await ctx.db
        .query("sourceCredentials")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", requestedId))
        .unique();
      if (binding && binding.workspaceId === args.workspaceId) {
        requestedId = binding.credentialId;
      }
    }

    const connectionId = requestedId || existing?.credentialId || `conn_${crypto.randomUUID()}`;

    const linkedRows = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_credential", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("credentialId", connectionId),
      )
      .collect();
    const exemplar = linkedRows[0] ?? existing ?? null;

    const provider = args.provider ?? exemplar?.provider ?? "local-convex";
    const fallbackSecret = asRecord(exemplar?.secretJson);
    const finalSecret = hasSubmittedSecret ? submittedSecret : fallbackSecret;
    if (Object.keys(finalSecret).length === 0) {
      throw new Error("Credential values are required");
    }

    const overridesJson = args.overridesJson === undefined
      ? asRecord(existing?.overridesJson)
      : asRecord(args.overridesJson);

    const boundAuthFingerprint = await computeBoundAuthFingerprint(ctx, args.workspaceId, args.sourceKey);

    if (linkedRows.length > 0 && (hasSubmittedSecret || args.provider)) {
      await Promise.all(linkedRows.map(async (row) => {
        await ctx.db.patch(row._id, {
          provider,
          secretJson: finalSecret,
          updatedAt: now,
        });
      }));
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        credentialId: connectionId,
        provider,
        secretJson: finalSecret,
        overridesJson,
        boundAuthFingerprint,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("sourceCredentials", {
        bindingId: `bind_${crypto.randomUUID()}`,
        credentialId: connectionId,
        workspaceId: args.workspaceId,
        sourceKey: args.sourceKey,
        scope: args.scope,
        actorId,
        provider,
        secretJson: finalSecret,
        overridesJson,
        boundAuthFingerprint,
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
  args: { workspaceId: v.id("workspaces") },
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
    const workosEnabled = Boolean(process.env.WORKOS_API_KEY?.trim());
    return [
      {
        id: workosEnabled ? "workos-vault" : "local-convex",
        label: workosEnabled ? "Encrypted" : "Local",
        description: workosEnabled
          ? "Secrets are stored in WorkOS Vault."
          : "Secrets are stored locally in Convex on this machine.",
      },
    ] as const;
  },
});

export const resolveCredential = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    sourceKey: v.string(),
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.scope === "actor") {
      const actorId = args.actorId?.trim() || "";
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
    workspaceId: v.id("workspaces"),
    name: v.string(),
    type: toolSourceTypeValidator,
    config: v.any(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const sourceId = args.id ?? `src_${crypto.randomUUID()}`;
    const config = asRecord(args.config);
    const specHash = computeSourceSpecHash(args.type, config);
    const authFingerprint = normalizeSourceAuthFingerprint(config.auth);
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
        config,
        specHash,
        authFingerprint,
        enabled: args.enabled !== false,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("toolSources", {
        sourceId,
        workspaceId: args.workspaceId,
        name: args.name,
        type: args.type,
        config,
        specHash,
        authFingerprint,
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
  args: { workspaceId: v.id("workspaces") },
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
  args: { workspaceId: v.id("workspaces"), sourceId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("toolSources")
      .withIndex("by_source_id", (q) => q.eq("sourceId", args.sourceId))
      .unique();

    if (!doc || doc.workspaceId !== args.workspaceId) {
      return false;
    }

    const sourceKey = `source:${args.sourceId}`;
    const bindings = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_source_scope_actor", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("sourceKey", sourceKey),
      )
      .collect();

    for (const binding of bindings) {
      await ctx.db.delete(binding._id);
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

// ── Anonymous OAuth Signing Keys ─────────────────────────────────────────────

/**
 * Get the active anonymous OAuth signing key pair.
 * Returns null if no key has been generated yet.
 */
export const getActiveAnonymousOauthSigningKey = internalQuery({
  args: {},
  handler: async (ctx) => {
    const doc = await ctx.db
      .query("anonymousOauthSigningKeys")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .first();

    if (!doc) return null;

    return {
      keyId: doc.keyId,
      algorithm: doc.algorithm,
      privateKeyJwk: doc.privateKeyJwk,
      publicKeyJwk: doc.publicKeyJwk,
      createdAt: doc.createdAt,
    };
  },
});

/**
 * Store a new anonymous OAuth signing key pair, rotating any previously active key.
 */
export const storeAnonymousOauthSigningKey = internalMutation({
  args: {
    keyId: v.string(),
    algorithm: v.string(),
    privateKeyJwk: v.any(),
    publicKeyJwk: v.any(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Rotate any currently active keys
    const activeKeys = await ctx.db
      .query("anonymousOauthSigningKeys")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    for (const key of activeKeys) {
      await ctx.db.patch(key._id, { status: "rotated", rotatedAt: now });
    }

    // Insert the new active key
    await ctx.db.insert("anonymousOauthSigningKeys", {
      keyId: args.keyId,
      algorithm: args.algorithm,
      privateKeyJwk: args.privateKeyJwk,
      publicKeyJwk: args.publicKeyJwk,
      status: "active",
      createdAt: now,
    });
  },
});

// ── Anonymous OAuth Client Registrations ────────────────────────────────────

/**
 * Register a new anonymous OAuth client (RFC 7591 dynamic client registration).
 */
export const registerAnonymousOauthClient = internalMutation({
  args: {
    clientId: v.string(),
    clientName: v.optional(v.string()),
    redirectUris: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("anonymousOauthClients", {
      clientId: args.clientId,
      clientName: args.clientName,
      redirectUris: args.redirectUris,
      createdAt: now,
    });

    return {
      client_id: args.clientId,
      client_name: args.clientName,
      redirect_uris: args.redirectUris,
      created_at: now,
    };
  },
});

/**
 * Look up an anonymous OAuth client by client_id.
 */
export const getAnonymousOauthClient = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("anonymousOauthClients")
      .withIndex("by_client_id", (q) => q.eq("clientId", args.clientId))
      .unique();

    if (!doc) return null;

    return {
      client_id: doc.clientId,
      client_name: doc.clientName,
      redirect_uris: doc.redirectUris,
      created_at: doc.createdAt,
    };
  },
});

// ── Anonymous OAuth Authorization Codes ──────────────────────────────────────

export const storeAnonymousOauthAuthorizationCode = internalMutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(),
    actorId: v.string(),
    tokenClaims: v.optional(v.any()),
    expiresAt: v.number(),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("anonymousOauthCodes", {
      code: args.code,
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      codeChallengeMethod: args.codeChallengeMethod,
      actorId: args.actorId,
      tokenClaims: args.tokenClaims,
      expiresAt: args.expiresAt,
      createdAt: args.createdAt,
    });
  },
});

export const consumeAnonymousOauthAuthorizationCode = internalMutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("anonymousOauthCodes")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();

    if (!doc) {
      return null;
    }

    await ctx.db.delete(doc._id);

    return {
      code: doc.code,
      clientId: doc.clientId,
      redirectUri: doc.redirectUri,
      codeChallenge: doc.codeChallenge,
      codeChallengeMethod: doc.codeChallengeMethod,
      actorId: doc.actorId,
      tokenClaims: doc.tokenClaims,
      expiresAt: doc.expiresAt,
      createdAt: doc.createdAt,
    };
  },
});

export const purgeExpiredAnonymousOauthAuthorizationCodes = internalMutation({
  args: {
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const expired = await ctx.db
      .query("anonymousOauthCodes")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", args.now))
      .collect();

    for (const doc of expired) {
      await ctx.db.delete(doc._id);
    }

    return { purged: expired.length };
  },
});

export const countAnonymousOauthAuthorizationCodes = internalQuery({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("anonymousOauthCodes").collect();
    return { count: docs.length };
  },
});
