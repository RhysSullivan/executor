import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { TaskRecord, StorageInstanceRecord } from "../../../core/src/types";
import { getStorageProvider, type StorageEncoding, type StorageProvider } from "./storage_provider";
import {
  fsMkdirInputSchema,
  fsMkdirOutputSchema,
  fsReadInputSchema,
  fsReadOutputSchema,
  fsReaddirInputSchema,
  fsReaddirOutputSchema,
  fsRemoveInputSchema,
  fsRemoveOutputSchema,
  fsStatInputSchema,
  fsStatOutputSchema,
  fsWriteInputSchema,
  fsWriteOutputSchema,
  kvDeleteInputSchema,
  kvDeleteOutputSchema,
  kvGetInputSchema,
  kvGetOutputSchema,
  kvIncrInputSchema,
  kvIncrOutputSchema,
  kvListInputSchema,
  kvListOutputSchema,
  kvSetInputSchema,
  kvSetOutputSchema,
  sqliteCapabilitiesInputSchema,
  sqliteCapabilitiesOutputSchema,
  sqliteInsertRowsInputSchema,
  sqliteInsertRowsOutputSchema,
  sqliteQueryInputSchema,
  sqliteQueryOutputSchema,
  storageCloseInputSchema,
  storageCloseOutputSchema,
  storageDeleteInputSchema,
  storageDeleteOutputSchema,
  storageListInputSchema,
  storageListOutputSchema,
  storageOpenInputSchema,
  storageOpenOutputSchema,
} from "./storage_tool_contracts";

type StorageScopeType = "scratch" | "account" | "workspace" | "organization";

type TaskStorageDefaults = {
  currentInstanceId?: string;
  currentScopeType?: StorageScopeType;
  byScope: Partial<Record<StorageScopeType, string>>;
};

const STORAGE_SYSTEM_TOOLS = new Set([
  "storage.open",
  "storage.list",
  "storage.close",
  "storage.delete",
  "fs.read",
  "fs.write",
  "fs.readdir",
  "fs.stat",
  "fs.mkdir",
  "fs.remove",
  "kv.get",
  "kv.set",
  "kv.put",
  "kv.create",
  "kv.update",
  "kv.list",
  "kv.keys",
  "kv.delete",
  "kv.del",
  "kv.has",
  "kv.exists",
  "kv.value",
  "kv.incr",
  "kv.decr",
  "sqlite.query",
  "sqlite.exec",
  "sqlite.capabilities",
  "sqlite.insert_rows",
  "sqlite.bulk_insert",
]);

const SQLITE_MAX_BIND_VARIABLES = 100;

function toInputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

function normalizeScopeType(value: unknown): undefined | "scratch" | "account" | "workspace" | "organization" {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "scratch" || normalized === "account" || normalized === "workspace" || normalized === "organization") {
    return normalized;
  }
  return undefined;
}

function isReadOnlySql(sql: string): boolean {
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

function decorateSqliteError(error: unknown, args: {
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

function assertSqlIdentifier(identifier: string, label: string): string {
  const trimmed = identifier.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`${label} must be a valid SQLite identifier`);
  }
  return trimmed;
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function normalizeInstanceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeInputPayload(input: unknown): Record<string, unknown> {
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

async function saveTaskStorageDefault(
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

async function trackTaskStorageAccess(
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

async function openStorageInstanceForTask(
  ctx: ActionCtx,
  task: TaskRecord,
  args: {
    instanceId?: string;
    scopeType?: "scratch" | "account" | "workspace" | "organization";
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

async function resolveStorageInstance(
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

async function touchInstance(
  ctx: ActionCtx,
  task: TaskRecord,
  instance: StorageInstanceRecord,
  provider: StorageProvider,
  withUsage: boolean,
) {
  const usage = withUsage ? await provider.usage(instance) : undefined;
  await ctx.runMutation(internal.database.touchStorageInstance, {
    workspaceId: task.workspaceId,
    accountId: task.accountId,
    instanceId: instance.id,
    provider: instance.provider,
    ...(usage?.sizeBytes !== undefined ? { sizeBytes: usage.sizeBytes } : {}),
    ...(usage?.fileCount !== undefined ? { fileCount: usage.fileCount } : {}),
  });
}

export function isStorageSystemToolPath(path: string): boolean {
  return STORAGE_SYSTEM_TOOLS.has(path);
}

export async function runStorageSystemTool(
  ctx: ActionCtx,
  task: TaskRecord,
  toolPath: string,
  input: unknown,
): Promise<unknown> {
  const payload = normalizeInputPayload(input);
  const normalizedToolPath = toolPath === "kv.put"
    ? "kv.set"
    : toolPath === "kv.create"
      ? "kv.set"
      : toolPath === "kv.update"
        ? "kv.set"
    : toolPath === "kv.del"
      ? "kv.delete"
      : toolPath === "kv.has"
        ? "kv.get"
        : toolPath === "kv.exists"
          ? "kv.get"
          : toolPath === "kv.value"
            ? "kv.get"
            : toolPath === "kv.keys"
              ? "kv.list"
      : toolPath === "sqlite.exec"
        ? "sqlite.query"
        : toolPath === "sqlite.bulk_insert"
          ? "sqlite.insert_rows"
        : toolPath;

  if (normalizedToolPath === "storage.open") {
    const parsed = storageOpenInputSchema.parse(payload);
    const instance = await openStorageInstanceForTask(ctx, task, parsed);
    await saveTaskStorageDefault(
      ctx,
      task,
      instance.scopeType,
      instance.id,
      true,
      parsed.instanceId ? "provided" : "opened",
    );
    return storageOpenOutputSchema.parse({ instance });
  }

  if (normalizedToolPath === "storage.list") {
    const parsed = storageListInputSchema.parse(payload);
    const instances = await ctx.runQuery(internal.database.listStorageInstances, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      scopeType: parsed.scopeType,
      includeDeleted: parsed.includeDeleted,
    });

    return storageListOutputSchema.parse({
      instances,
      total: instances.length,
    });
  }

  if (normalizedToolPath === "storage.close") {
    const parsed = storageCloseInputSchema.parse(payload);
    const instance = await ctx.runMutation(internal.database.closeStorageInstance, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      instanceId: parsed.instanceId,
    });

    await trackTaskStorageAccess(ctx, task, {
      instanceId: parsed.instanceId,
      scopeType: instance?.scopeType,
      accessType: "provided",
    });

    return storageCloseOutputSchema.parse({ instance });
  }

  if (normalizedToolPath === "storage.delete") {
    const parsed = storageDeleteInputSchema.parse(payload);
    const existing = await ctx.runQuery(internal.database.getStorageInstance, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      instanceId: parsed.instanceId,
    }) as StorageInstanceRecord | null;

    if (existing) {
      const provider = getStorageProvider(existing.provider);
      try {
        await provider.deleteInstance(existing);
      } catch {
        // Continue marking the instance deleted even if backend cleanup fails.
      }
    }

    const instance = await ctx.runMutation(internal.database.deleteStorageInstance, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      instanceId: parsed.instanceId,
    });

    await trackTaskStorageAccess(ctx, task, {
      instanceId: parsed.instanceId,
      scopeType: existing?.scopeType,
      accessType: "provided",
    });

    return storageDeleteOutputSchema.parse({ instance });
  }

  if (normalizedToolPath === "fs.read") {
    const parsed = fsReadInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    const encoding = parsed.encoding ?? "utf8";
    const file = await provider.readFile(instance, parsed.path, encoding as StorageEncoding);
    await touchInstance(ctx, task, instance, provider, false);
    return fsReadOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      encoding,
      content: file.content,
      bytes: file.bytes,
    });
  }

  if (normalizedToolPath === "fs.write") {
    const parsed = fsWriteInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    const encoding = parsed.encoding ?? "utf8";
    const result = await provider.writeFile(instance, parsed.path, parsed.content, encoding as StorageEncoding);
    await touchInstance(ctx, task, instance, provider, true);
    return fsWriteOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      bytesWritten: result.bytesWritten,
    });
  }

  if (normalizedToolPath === "fs.readdir") {
    const parsed = fsReaddirInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    const path = parsed.path ?? "/";
    const entries = await provider.readdir(instance, path);
    await touchInstance(ctx, task, instance, provider, false);
    return fsReaddirOutputSchema.parse({
      instanceId: instance.id,
      path,
      entries,
    });
  }

  if (normalizedToolPath === "fs.stat") {
    const parsed = fsStatInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    const stat = await provider.stat(instance, parsed.path);
    await touchInstance(ctx, task, instance, provider, false);
    return fsStatOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      ...stat,
    });
  }

  if (normalizedToolPath === "fs.mkdir") {
    const parsed = fsMkdirInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    await provider.mkdir(instance, parsed.path);
    await touchInstance(ctx, task, instance, provider, true);
    return fsMkdirOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      ok: true,
    });
  }

  if (normalizedToolPath === "fs.remove") {
    const parsed = fsRemoveInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    await provider.remove(instance, parsed.path, {
      recursive: parsed.recursive,
      force: parsed.force,
    });
    await touchInstance(ctx, task, instance, provider, true);
    return fsRemoveOutputSchema.parse({
      instanceId: instance.id,
      path: parsed.path,
      ok: true,
    });
  }

  if (normalizedToolPath === "kv.get") {
    const parsed = kvGetInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    const value = await provider.kvGet(instance, parsed.key);
    await touchInstance(ctx, task, instance, provider, false);
    return kvGetOutputSchema.parse({
      instanceId: instance.id,
      key: parsed.key,
      found: value !== undefined,
      ...(value !== undefined ? { value } : {}),
    });
  }

  if (normalizedToolPath === "kv.set") {
    const parsed = kvSetInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    await provider.kvSet(instance, parsed.key, parsed.value);
    await touchInstance(ctx, task, instance, provider, true);
    return kvSetOutputSchema.parse({
      instanceId: instance.id,
      key: parsed.key,
      ok: true,
    });
  }

  if (normalizedToolPath === "kv.list") {
    const parsed = kvListInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    const limit = Math.max(1, Math.min(500, Math.floor(parsed.limit ?? 100)));
    const items = await provider.kvList(instance, parsed.prefix ?? "", limit);
    await touchInstance(ctx, task, instance, provider, false);
    return kvListOutputSchema.parse({
      instanceId: instance.id,
      items,
      total: items.length,
    });
  }

  if (normalizedToolPath === "kv.delete") {
    const parsed = kvDeleteInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    await provider.kvDelete(instance, parsed.key);
    await touchInstance(ctx, task, instance, provider, true);
    return kvDeleteOutputSchema.parse({
      instanceId: instance.id,
      key: parsed.key,
      ok: true,
    });
  }

  if (normalizedToolPath === "kv.incr" || normalizedToolPath === "kv.decr") {
    const parsed = kvIncrInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);

    const existing = await provider.kvGet(instance, parsed.key);
    const initial = assertFiniteNumber(parsed.initial ?? 0, "initial");
    const previous = existing === undefined
      ? initial
      : assertFiniteNumber(existing, `kv value at '${parsed.key}'`);

    const rawBy = assertFiniteNumber(parsed.by ?? 1, "by");
    const by = normalizedToolPath === "kv.decr" ? -Math.abs(rawBy) : rawBy;
    const value = previous + by;

    await provider.kvSet(instance, parsed.key, value);
    await touchInstance(ctx, task, instance, provider, true);

    return kvIncrOutputSchema.parse({
      instanceId: instance.id,
      key: parsed.key,
      by,
      previous,
      value,
    });
  }

  if (normalizedToolPath === "sqlite.capabilities") {
    sqliteCapabilitiesInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    await touchInstance(ctx, task, instance, provider, false);
    return sqliteCapabilitiesOutputSchema.parse({
      instanceId: instance.id,
      provider: instance.provider,
      maxBindVariables: SQLITE_MAX_BIND_VARIABLES,
      supportsJsonEach: true,
      supportsInsertRowsTool: true,
      guidance: [
        "Prefer sqlite.insert_rows for bulk tabular inserts.",
        "Keep bind params per statement under maxBindVariables.",
        "For very large payloads, use one JSON payload param and expand with json_each(?).",
        "Pass instanceId explicitly to reuse the same database across task runs.",
      ],
    });
  }

  if (normalizedToolPath === "sqlite.insert_rows") {
    const parsed = sqliteInsertRowsInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);

    const table = assertSqlIdentifier(parsed.table, "table");
    const columns = parsed.columns.map((column, index) => assertSqlIdentifier(column, `columns[${index}]`));
    if (new Set(columns).size !== columns.length) {
      throw new Error("columns must be unique");
    }

    const rows = parsed.rows;
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].length !== columns.length) {
        throw new Error(`rows[${index}] has ${rows[index].length} values but expected ${columns.length}`);
      }
    }

    const maxRowsPerChunk = Math.max(1, Math.floor(SQLITE_MAX_BIND_VARIABLES / Math.max(1, columns.length)));
    const requestedChunkSize = typeof parsed.chunkSize === "number" && Number.isFinite(parsed.chunkSize)
      ? Math.max(1, Math.floor(parsed.chunkSize))
      : maxRowsPerChunk;
    const rowsPerChunk = Math.max(1, Math.min(maxRowsPerChunk, requestedChunkSize));

    const conflictClause = parsed.onConflict === "ignore"
      ? " OR IGNORE"
      : parsed.onConflict === "replace"
        ? " OR REPLACE"
        : "";

    const quotedTable = quoteSqlIdentifier(table);
    const quotedColumns = columns.map(quoteSqlIdentifier).join(", ");
    const placeholderRow = `(${columns.map(() => "?").join(", ")})`;

    let totalChanges = 0;
    let chunkCount = 0;
    for (let start = 0; start < rows.length; start += rowsPerChunk) {
      const chunk = rows.slice(start, start + rowsPerChunk);
      const values = chunk.map(() => placeholderRow).join(", ");
      const params = chunk.flat();
      const sql = `INSERT${conflictClause} INTO ${quotedTable} (${quotedColumns}) VALUES ${values}`;

      let writeResult;
      try {
        writeResult = await provider.sqliteQuery(instance, {
          sql,
          params,
          mode: "write",
          maxRows: 1,
        });
      } catch (error) {
        throw decorateSqliteError(error, {
          sql,
          params,
          instanceId: instance.id,
        });
      }

      totalChanges += Number(writeResult.changes ?? 0);
      chunkCount += 1;
    }

    await touchInstance(ctx, task, instance, provider, true);
    return sqliteInsertRowsOutputSchema.parse({
      instanceId: instance.id,
      table,
      columns,
      rowsReceived: rows.length,
      rowsProcessed: rows.length,
      chunkCount,
      rowsPerChunk,
      maxBindVariables: SQLITE_MAX_BIND_VARIABLES,
      changes: totalChanges,
    });
  }

  if (normalizedToolPath === "sqlite.query") {
    const parsed = sqliteQueryInputSchema.parse(payload);
    const instance = await resolveStorageInstance(ctx, task, payload);
    const provider = getStorageProvider(instance.provider);
    const mode = parsed.mode ?? (isReadOnlySql(parsed.sql) ? "read" : "write");
    const maxRows = Math.max(1, Math.min(1_000, Math.floor(parsed.maxRows ?? 200)));
    const params = parsed.params ?? [];
    let result;
    try {
      result = await provider.sqliteQuery(instance, {
        sql: parsed.sql,
        params,
        mode,
        maxRows,
      });
    } catch (error) {
      throw decorateSqliteError(error, {
        sql: parsed.sql,
        params,
        instanceId: instance.id,
      });
    }
    await touchInstance(ctx, task, instance, provider, mode === "write");
    return sqliteQueryOutputSchema.parse({
      instanceId: instance.id,
      ...result,
    });
  }

  throw new Error(`Unsupported storage system tool: ${toolPath}`);
}
