import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { mapTask } from "../../src/database/mappers";
import { getTaskDoc } from "../../src/database/readers";
import {
  completedTaskStatusValidator,
  jsonObjectValidator,
  storageAccessTypeValidator,
  storageScopeTypeValidator,
} from "../../src/database/validators";
import { DEFAULT_TASK_TIMEOUT_MS, MAX_TASK_TIMEOUT_MS } from "../../src/task/constants";
import { isTerminalTaskStatus } from "../../src/task/status";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function pushUniqueString(items: string[], value: string, maxItems = 50): string[] {
  const normalized = value.trim();
  if (!normalized) {
    return items;
  }

  const withoutExisting = items.filter((entry) => entry !== normalized);
  const next = [...withoutExisting, normalized];
  if (next.length <= maxItems) {
    return next;
  }

  return next.slice(next.length - maxItems);
}

function clampTaskTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_TASK_TIMEOUT_MS;
  }

  const normalized = Math.floor(timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
  if (normalized <= 0) {
    return DEFAULT_TASK_TIMEOUT_MS;
  }

  return Math.min(normalized, MAX_TASK_TIMEOUT_MS);
}

export const createTask = internalMutation({
  args: {
    id: v.string(),
    code: v.string(),
    runtimeId: v.string(),
    timeoutMs: v.optional(v.number()),
    metadata: v.optional(jsonObjectValidator),
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await getTaskDoc(ctx, args.id);
    if (existing) {
      throw new Error(`Task already exists: ${args.id}`);
    }

    const now = Date.now();
    const metadata = args.metadata === undefined
      ? {}
      : args.metadata;
    await ctx.db.insert("tasks", {
      taskId: args.id,
      code: args.code,
      runtimeId: args.runtimeId,
      workspaceId: args.workspaceId,
      accountId: args.accountId,
      clientId: args.clientId?.trim() || undefined,
      status: "queued",
      timeoutMs: clampTaskTimeout(args.timeoutMs),
      metadata,
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
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc) {
      return null;
    }

    if (isTerminalTaskStatus(doc.status)) {
      return mapTask(doc);
    }

    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: args.status,
      exitCode: args.exitCode,
      error: args.error,
      completedAt: now,
      updatedAt: now,
    });

    const updated = await getTaskDoc(ctx, args.taskId);
    return updated ? mapTask(updated) : null;
  },
});

export const setTaskStorageDefaultInstance = internalMutation({
  args: {
    taskId: v.string(),
    scopeType: storageScopeTypeValidator,
    instanceId: v.string(),
    setCurrent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc) {
      return null;
    }

    const now = Date.now();
    const metadata = asRecord(doc.metadata);
    const storage = asRecord(metadata.storage);
    const defaultsByScope = asRecord(storage.defaultInstanceByScope);

    defaultsByScope[args.scopeType] = args.instanceId;

    const nextStorage: Record<string, unknown> = {
      ...storage,
      defaultInstanceByScope: defaultsByScope,
    };

    if (args.setCurrent !== false) {
      nextStorage.currentInstanceId = args.instanceId;
      nextStorage.currentScopeType = args.scopeType;
    }

    await ctx.db.patch(doc._id, {
      metadata: {
        ...metadata,
        storage: nextStorage,
      },
      updatedAt: now,
    });

    const updated = await getTaskDoc(ctx, args.taskId);
    return updated ? mapTask(updated) : null;
  },
});

export const trackTaskStorageAccess = internalMutation({
  args: {
    taskId: v.string(),
    instanceId: v.string(),
    scopeType: v.optional(storageScopeTypeValidator),
    accessType: storageAccessTypeValidator,
  },
  handler: async (ctx, args) => {
    const doc = await getTaskDoc(ctx, args.taskId);
    if (!doc) {
      return null;
    }

    const now = Date.now();
    const metadata = asRecord(doc.metadata);
    const storage = asRecord(metadata.storage);

    const accessedInstanceIds = pushUniqueString(
      asStringArray(storage.accessedInstanceIds),
      args.instanceId,
    );

    const nextStorage: Record<string, unknown> = {
      ...storage,
      accessedInstanceIds,
      lastAccessedInstanceId: args.instanceId,
      lastAccessedAt: now,
    };

    if (args.accessType === "opened") {
      nextStorage.openedInstanceIds = pushUniqueString(
        asStringArray(storage.openedInstanceIds),
        args.instanceId,
      );
    }

    if (args.accessType === "provided") {
      nextStorage.providedInstanceIds = pushUniqueString(
        asStringArray(storage.providedInstanceIds),
        args.instanceId,
      );
    }

    if (args.scopeType) {
      nextStorage.lastAccessedScopeType = args.scopeType;
    }

    await ctx.db.patch(doc._id, {
      metadata: {
        ...metadata,
        storage: nextStorage,
      },
      updatedAt: now,
    });

    const updated = await getTaskDoc(ctx, args.taskId);
    return updated ? mapTask(updated) : null;
  },
});
