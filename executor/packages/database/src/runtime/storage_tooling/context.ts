import type { ActionCtx } from "../../../convex/_generated/server";
import { internal } from "../../../convex/_generated/api";
import type { TaskRecord, StorageInstanceRecord } from "../../../../core/src/types";
import { getStorageProvider, type StorageProvider } from "../storage_provider";
import { shouldTouchStorageOnRead } from "../storage_touch_policy";
import { shouldRefreshStorageUsage } from "../storage_usage_refresh";

export type StorageScopeType = "scratch" | "account" | "workspace" | "organization";

type TaskStorageDefaults = {
  currentInstanceId?: string;
  currentScopeType?: StorageScopeType;
  byScope: Partial<Record<StorageScopeType, string>>;
};

export type StorageToolHandlerArgs = {
  ctx: ActionCtx;
  task: TaskRecord;
  payload: Record<string, unknown>;
  normalizedToolPath: string;
};

export const SQLITE_MAX_BIND_VARIABLES = 100;

function toInputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

export function normalizeScopeType(value: unknown): StorageScopeType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "scratch" || normalized === "account" || normalized === "workspace" || normalized === "organization") {
    return normalized;
  }
  return undefined;
}

export function isReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  return trimmed.startsWith("select")
    || trimmed.startsWith("pragma")
    || trimmed.startsWith("explain")
    || trimmed.startsWith("with");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function estimateSqlBindCount(sql: string): number {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let count = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && char === "?") {
      count += 1;
    }
  }

  return count;
}

export function decorateSqliteError(error: unknown, args: {
  sql: string;
  params: Array<string | number | boolean | null>;
  instanceId: string;
}): Error {
  const original = toErrorMessage(error);
  const normalized = original.toLowerCase();

  if (normalized.includes("too many sql variables")) {
    const bindCount = estimateSqlBindCount(args.sql);
    const paramsCount = args.params.length;
    return new Error(
      [
        original,
        `sqlite.query guidance: this statement used ${paramsCount} params and ~${bindCount} '?' placeholders.`,
        "Use smaller batches, or prefer JSON batching: INSERT ... SELECT ... FROM json_each(?) with one JSON payload param.",
        "Keep using instanceId to write/read the same database across task runs.",
      ].join(" "),
    );
  }

  if (normalized.includes("no such table")) {
    return new Error(
      [
        original,
        `sqlite.query guidance: table lookup happened in instanceId=${args.instanceId}.`,
        "If the table was created in another run, pass that exact instanceId explicitly.",
      ].join(" "),
    );
  }

  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return new Error(
      [
        original,
        "sqlite.query guidance: reduce batch size and split long imports into multiple calls.",
        "For bulk inserts, use json_each(?) payload batches instead of very large VALUES(...) statements.",
      ].join(" "),
    );
  }

  return error instanceof Error ? error : new Error(original);
}

export function assertSqlIdentifier(identifier: string, label: string): string {
  const trimmed = identifier.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`${label} must be a valid SQLite identifier`);
  }
  return trimmed;
}

export function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

export function normalizeInstanceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeInputPayload(input: unknown): Record<string, unknown> {
  const payload = toInputRecord(input);
  return {
    ...payload,
    ...(normalizeScopeType(payload.scopeType) ? { scopeType: normalizeScopeType(payload.scopeType) } : {}),
    ...(normalizeInstanceId(payload.instanceId) ? { instanceId: normalizeInstanceId(payload.instanceId) } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseTaskStorageDefaults(metadata: unknown): TaskStorageDefaults {
  const root = asRecord(metadata);
  const storage = asRecord(root.storage);
  const byScopeRaw = asRecord(storage.defaultInstanceByScope);
  const byScope: Partial<Record<StorageScopeType, string>> = {};

  for (const scopeType of ["scratch", "account", "workspace", "organization"] as const) {
    const value = normalizeInstanceId(byScopeRaw[scopeType]);
    if (value) {
      byScope[scopeType] = value;
    }
  }

  return {
    currentInstanceId: normalizeInstanceId(storage.currentInstanceId),
    currentScopeType: normalizeScopeType(storage.currentScopeType),
    byScope,
  };
}

async function getTaskStorageDefaults(
  ctx: ActionCtx,
  task: TaskRecord,
): Promise<TaskStorageDefaults> {
  const latest = await ctx.runQuery(internal.database.getTask, { taskId: task.id });
  if (!latest) {
    return { byScope: {} };
  }

  return parseTaskStorageDefaults((latest as TaskRecord).metadata);
}

export async function saveTaskStorageDefault(
  ctx: ActionCtx,
  task: TaskRecord,
  scopeType: StorageScopeType,
  instanceId: string,
  setCurrent = true,
  accessType: "opened" | "provided" | "accessed" = "accessed",
) {
  await ctx.runMutation(internal.database.setTaskStorageDefaultInstance, {
    taskId: task.id,
    scopeType,
    instanceId,
    setCurrent,
  });

  await ctx.runMutation(internal.database.trackTaskStorageAccess, {
    taskId: task.id,
    instanceId,
    scopeType,
    accessType,
  });
}

export async function trackTaskStorageAccess(
  ctx: ActionCtx,
  task: TaskRecord,
  args: {
    instanceId: string;
    scopeType?: StorageScopeType;
    accessType: "opened" | "provided" | "accessed";
  },
) {
  await ctx.runMutation(internal.database.trackTaskStorageAccess, {
    taskId: task.id,
    instanceId: args.instanceId,
    scopeType: args.scopeType,
    accessType: args.accessType,
  });
}

export async function openStorageInstanceForTask(
  ctx: ActionCtx,
  task: TaskRecord,
  args: {
    instanceId?: string;
    scopeType?: StorageScopeType;
    durability?: "ephemeral" | "durable";
    purpose?: string;
    ttlHours?: number;
  },
): Promise<StorageInstanceRecord> {
  const opened = await ctx.runMutation(internal.database.openStorageInstance, {
    workspaceId: task.workspaceId,
    accountId: task.accountId,
    instanceId: args.instanceId,
    scopeType: args.scopeType,
    durability: args.durability,
    purpose: args.purpose,
    ttlHours: args.ttlHours,
  });
  return opened as StorageInstanceRecord;
}

export async function resolveStorageInstance(
  ctx: ActionCtx,
  task: TaskRecord,
  payload: Record<string, unknown>,
): Promise<StorageInstanceRecord> {
  const requestedInstanceId = normalizeInstanceId(payload.instanceId);
  const requestedScopeType = normalizeScopeType(payload.scopeType);

  if (requestedInstanceId) {
    const existing = await ctx.runQuery(internal.database.getStorageInstance, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      instanceId: requestedInstanceId,
    });
    if (!existing) {
      throw new Error(`Storage instance not found: ${requestedInstanceId}`);
    }

    const reopened = await openStorageInstanceForTask(ctx, task, {
      instanceId: requestedInstanceId,
    });
    await saveTaskStorageDefault(ctx, task, reopened.scopeType, reopened.id, true, "provided");
    return reopened;
  }

  const defaults = await getTaskStorageDefaults(ctx, task);

  const candidateIds: string[] = [];
  if (requestedScopeType) {
    const forScope = defaults.byScope[requestedScopeType];
    if (forScope) {
      candidateIds.push(forScope);
    }
    if (defaults.currentScopeType === requestedScopeType && defaults.currentInstanceId) {
      candidateIds.push(defaults.currentInstanceId);
    }
  } else {
    if (defaults.currentInstanceId) {
      candidateIds.push(defaults.currentInstanceId);
    }
    if (defaults.byScope.scratch) {
      candidateIds.push(defaults.byScope.scratch);
    }
  }

  const uniqueCandidateIds = [...new Set(candidateIds)];
  for (const candidateId of uniqueCandidateIds) {
    const existing = await ctx.runQuery(internal.database.getStorageInstance, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      instanceId: candidateId,
    }) as StorageInstanceRecord | null;
    if (!existing) {
      continue;
    }

    const reopened = await openStorageInstanceForTask(ctx, task, {
      instanceId: candidateId,
    });
    await saveTaskStorageDefault(ctx, task, reopened.scopeType, reopened.id, true, "accessed");
    return reopened;
  }

  const fallbackScopeType = requestedScopeType ?? defaults.currentScopeType ?? "scratch";

  const created = await openStorageInstanceForTask(ctx, task, {
    scopeType: fallbackScopeType,
  });
  await saveTaskStorageDefault(ctx, task, created.scopeType, created.id, true, "opened");
  return created;
}

export async function touchInstance(
  ctx: ActionCtx,
  task: TaskRecord,
  instance: StorageInstanceRecord,
  provider: StorageProvider,
  withUsage: boolean,
) {
  if (!withUsage && !shouldTouchStorageOnRead()) {
    return;
  }

  const usage = withUsage && shouldRefreshStorageUsage(instance.id)
    ? await provider.usage(instance)
    : undefined;

  await ctx.runMutation(internal.database.touchStorageInstance, {
    workspaceId: task.workspaceId,
    accountId: task.accountId,
    instanceId: instance.id,
    provider: instance.provider,
    ...(usage?.sizeBytes !== undefined ? { sizeBytes: usage.sizeBytes } : {}),
    ...(usage?.fileCount !== undefined ? { fileCount: usage.fileCount } : {}),
  });
}

export async function resolveStorageProviderForPayload(
  ctx: ActionCtx,
  task: TaskRecord,
  payload: Record<string, unknown>,
): Promise<{ instance: StorageInstanceRecord; provider: StorageProvider }> {
  const instance = await resolveStorageInstance(ctx, task, payload);
  return {
    instance,
    provider: getStorageProvider(instance.provider),
  };
}
