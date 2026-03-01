import {
  type ListStorageDirectoryResult,
  type ListStorageKvResult,
  type OpenStorageInstancePayload,
  type QueryStorageSqlResult,
  type ReadStorageFileResult,
} from "@executor-v2/management-api";
import { StorageInstanceSchema, type StorageInstance } from "@executor-v2/schema";
import { v } from "convex/values";
import * as Schema from "effect/Schema";

import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";

const decodeStorageInstance = Schema.decodeUnknownSync(StorageInstanceSchema);

const StorageFileEntrySchema = Schema.Struct({
  id: Schema.String,
  storageInstanceId: Schema.String,
  path: Schema.String,
  contentBase64: Schema.String,
  sizeBytes: Schema.Number,
  updatedAt: Schema.Number,
});

type StorageFileEntry = typeof StorageFileEntrySchema.Type;
const decodeStorageFileEntry = Schema.decodeUnknownSync(StorageFileEntrySchema);

const StorageKvEntrySchema = Schema.Struct({
  id: Schema.String,
  storageInstanceId: Schema.String,
  key: Schema.String,
  valueJson: Schema.String,
  updatedAt: Schema.Number,
});

type StorageKvEntry = typeof StorageKvEntrySchema.Type;
const decodeStorageKvEntry = Schema.decodeUnknownSync(StorageKvEntrySchema);

const StorageSqlKvEntrySchema = Schema.Struct({
  id: Schema.String,
  storageInstanceId: Schema.String,
  key: Schema.String,
  value: Schema.String,
  updatedAt: Schema.Number,
});

type StorageSqlKvEntry = typeof StorageSqlKvEntrySchema.Type;
const decodeStorageSqlKvEntry = Schema.decodeUnknownSync(StorageSqlKvEntrySchema);

const DEFAULT_KV_LIMIT = 100;
const MAX_KV_LIMIT = 1000;
const DEFAULT_SQL_MAX_ROWS = 200;
const MAX_SQL_MAX_ROWS = 5000;

const stripConvexSystemFields = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = value;
  return rest;
};

const toStorageInstance = (document: Record<string, unknown>): StorageInstance =>
  decodeStorageInstance(stripConvexSystemFields(document));

const toStorageFileEntry = (document: Record<string, unknown>): StorageFileEntry =>
  decodeStorageFileEntry(stripConvexSystemFields(document));

const toStorageKvEntry = (document: Record<string, unknown>): StorageKvEntry =>
  decodeStorageKvEntry(stripConvexSystemFields(document));

const toStorageSqlKvEntry = (document: Record<string, unknown>): StorageSqlKvEntry =>
  decodeStorageSqlKvEntry(stripConvexSystemFields(document));

const storageScopeTypeValidator = v.union(
  v.literal("scratch"),
  v.literal("account"),
  v.literal("workspace"),
  v.literal("organization"),
);

const storageDurabilityValidator = v.union(
  v.literal("ephemeral"),
  v.literal("durable"),
);

const storageProviderValidator = v.union(
  v.literal("agentfs-local"),
  v.literal("agentfs-cloudflare"),
);

const readStorageEncodingValidator = v.union(
  v.literal("utf8"),
  v.literal("base64"),
);

const sortStorageInstances = (
  storageInstances: ReadonlyArray<StorageInstance>,
): Array<StorageInstance> =>
  [...storageInstances].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }

    return left.id.localeCompare(right.id);
  });

const resolveWorkspaceOrganizationId = async (
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
): Promise<string> => {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_domainId", (q) => q.eq("id", workspaceId))
    .unique();

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  return workspace.organizationId;
};

const canAccessStorageInstance = (
  storageInstance: StorageInstance,
  input: {
    workspaceId: string;
    organizationId: string;
  },
): boolean =>
  storageInstance.workspaceId === input.workspaceId
  || (
    storageInstance.workspaceId === null
    && storageInstance.organizationId === input.organizationId
  );

const normalizeStoragePath = (pathValue: string): string => {
  const trimmed = pathValue.trim().replaceAll("\\", "/");
  const prefixed = trimmed.length > 0
    ? (trimmed.startsWith("/") ? trimmed : `/${trimmed}`)
    : "/";

  const parts = prefixed.split("/");
  const normalized: Array<string> = [];

  for (const part of parts) {
    if (part.length === 0 || part === ".") {
      continue;
    }

    if (part === "..") {
      if (normalized.length === 0) {
        throw new Error("Path escapes storage root");
      }
      normalized.pop();
      continue;
    }

    normalized.push(part);
  }

  if (normalized.length === 0) {
    return "/";
  }

  return `/${normalized.join("/")}`;
};

const encodeUtf8Base64 = (value: string): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }

  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const decodeBase64Utf8 = (value: string): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "base64").toString("utf8");
  }

  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const parseJsonOrString = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const resolveAccessibleStorageInstance = async (
  ctx: QueryCtx | MutationCtx,
  input: {
    workspaceId: string;
    storageInstanceId: string;
  },
): Promise<StorageInstance | null> => {
  const organizationId = await resolveWorkspaceOrganizationId(ctx, input.workspaceId);
  const storageInstanceRow = await ctx.db
    .query("storageInstances")
    .withIndex("by_domainId", (q) => q.eq("id", input.storageInstanceId))
    .unique();

  if (!storageInstanceRow) {
    return null;
  }

  const storageInstance = toStorageInstance(
    storageInstanceRow as unknown as Record<string, unknown>,
  );

  if (
    !canAccessStorageInstance(storageInstance, {
      workspaceId: input.workspaceId,
      organizationId,
    })
  ) {
    return null;
  }

  return storageInstance;
};

export const upsertStorageFileEntry = internalMutation({
  args: {
    workspaceId: v.string(),
    storageInstanceId: v.string(),
    payload: v.object({
      path: v.string(),
      content: v.string(),
    }),
  },
  handler: async (ctx, args): Promise<StorageFileEntry> => {
    const storageInstance = await resolveAccessibleStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      storageInstanceId: args.storageInstanceId,
    });

    if (!storageInstance) {
      throw new Error(`Storage instance not found: ${args.storageInstanceId}`);
    }

    const normalizedPath = normalizeStoragePath(args.payload.path);
    const now = Date.now();
    const contentBase64 = encodeUtf8Base64(args.payload.content);
    const sizeBytes = args.payload.content.length;

    const existingRow = await ctx.db
      .query("storageFileEntries")
      .withIndex("by_storageInstanceId_path", (q) =>
        q.eq("storageInstanceId", args.storageInstanceId).eq("path", normalizedPath)
      )
      .unique();

    const nextEntry = decodeStorageFileEntry({
      id:
        (existingRow
          ? toStorageFileEntry(existingRow as unknown as Record<string, unknown>).id
          : `storage_file_${crypto.randomUUID()}`),
      storageInstanceId: args.storageInstanceId,
      path: normalizedPath,
      contentBase64,
      sizeBytes,
      updatedAt: now,
    });

    if (existingRow) {
      await ctx.db.patch(existingRow._id, nextEntry);
    } else {
      await ctx.db.insert("storageFileEntries", nextEntry);
    }

    return nextEntry;
  },
});

export const upsertStorageKvEntry = internalMutation({
  args: {
    workspaceId: v.string(),
    storageInstanceId: v.string(),
    payload: v.object({
      key: v.string(),
      valueJson: v.string(),
    }),
  },
  handler: async (ctx, args): Promise<StorageKvEntry> => {
    const storageInstance = await resolveAccessibleStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      storageInstanceId: args.storageInstanceId,
    });

    if (!storageInstance) {
      throw new Error(`Storage instance not found: ${args.storageInstanceId}`);
    }

    const now = Date.now();

    const existingRow = await ctx.db
      .query("storageKvEntries")
      .withIndex("by_storageInstanceId_key", (q) =>
        q.eq("storageInstanceId", args.storageInstanceId).eq("key", args.payload.key)
      )
      .unique();

    const nextEntry = decodeStorageKvEntry({
      id:
        (existingRow
          ? toStorageKvEntry(existingRow as unknown as Record<string, unknown>).id
          : `storage_kv_${crypto.randomUUID()}`),
      storageInstanceId: args.storageInstanceId,
      key: args.payload.key,
      valueJson: args.payload.valueJson,
      updatedAt: now,
    });

    if (existingRow) {
      await ctx.db.patch(existingRow._id, nextEntry);
    } else {
      await ctx.db.insert("storageKvEntries", nextEntry);
    }

    return nextEntry;
  },
});

const decodeSqlStringLiteral = (value: string): string => value.replaceAll("''", "'");

const parseSqlWhere = (
  whereClause: string | undefined,
): ((key: string) => boolean) => {
  if (whereClause === undefined) {
    return () => true;
  }

  const equalsMatch = /^key\s*=\s*'((?:''|[^'])*)'$/i.exec(whereClause.trim());
  if (equalsMatch) {
    const expectedKey = decodeSqlStringLiteral(equalsMatch[1] ?? "");
    return (key) => key === expectedKey;
  }

  const likeMatch = /^key\s+like\s+'((?:''|[^'])*)'$/i.exec(whereClause.trim());
  if (likeMatch) {
    const pattern = decodeSqlStringLiteral(likeMatch[1] ?? "");
    if (!pattern.endsWith("%") || pattern.slice(0, -1).includes("%")) {
      throw new Error("Only trailing % LIKE patterns are supported");
    }

    const prefix = pattern.slice(0, -1);
    return (key) => key.startsWith(prefix);
  }

  throw new Error("Unsupported SQL WHERE clause for kv_store");
};

const parseSelectColumns = (columnsClause: string): Array<"key" | "value"> => {
  const normalized = columnsClause.trim().toLowerCase();
  if (normalized === "*") {
    return ["key", "value"];
  }

  const columns = normalized
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column.length > 0);

  if (columns.length === 0) {
    throw new Error("SQL SELECT columns are required");
  }

  const parsedColumns: Array<"key" | "value"> = [];

  for (const column of columns) {
    if (column !== "key" && column !== "value") {
      throw new Error("Only key/value columns are supported for kv_store");
    }

    if (!parsedColumns.includes(column)) {
      parsedColumns.push(column);
    }
  }

  return parsedColumns;
};

type SqlWrite =
  | {
      type: "upsert";
      key: string;
      value: string;
      insertOnly: boolean;
    }
  | {
      type: "delete";
      key: string;
    };

const executeSqlForStorage = (
  sqlText: string,
  sqlRows: ReadonlyArray<StorageSqlKvEntry>,
  maxRows: number,
): {
  result: QueryStorageSqlResult;
  writes: Array<SqlWrite>;
} => {
  const trimmed = sqlText.trim();

  if (/^create\s+table\s+if\s+not\s+exists\s+kv_store\b/i.test(trimmed)) {
    return {
      result: {
        rows: [],
        columns: [],
        rowCount: 0,
      },
      writes: [],
    };
  }

  if (/^(begin|commit|rollback)\b/i.test(trimmed)) {
    return {
      result: {
        rows: [],
        columns: [],
        rowCount: 0,
      },
      writes: [],
    };
  }

  const sortedRows = [...sqlRows].sort((left, right) => left.key.localeCompare(right.key));

  const selectMatch = /^select\s+(.+?)\s+from\s+kv_store(?:\s+where\s+(.+?))?(?:\s+limit\s+(\d+))?\s*;?$/i.exec(trimmed);
  if (selectMatch) {
    const columns = parseSelectColumns(selectMatch[1] ?? "");
    const where = parseSqlWhere(selectMatch[2]);
    const sqlLimit =
      selectMatch[3] !== undefined
        ? Math.max(1, Math.min(maxRows, Number.parseInt(selectMatch[3], 10)))
        : maxRows;

    const rows = sortedRows
      .filter((row) => where(row.key))
      .slice(0, sqlLimit)
      .map((row) => {
        const resultRow: Record<string, unknown> = {};

        for (const column of columns) {
          if (column === "key") {
            resultRow.key = row.key;
          } else {
            resultRow.value = row.value;
          }
        }

        return resultRow;
      });

    return {
      result: {
        rows,
        columns,
        rowCount: rows.length,
      },
      writes: [],
    };
  }

  const insertMatch = /^insert\s+into\s+kv_store\s*\(\s*key\s*,\s*value\s*\)\s*values\s*\(\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*\)\s*;?$/i.exec(trimmed);
  if (insertMatch) {
    return {
      result: {
        rows: [],
        columns: [],
        rowCount: 0,
      },
      writes: [{
        type: "upsert",
        key: decodeSqlStringLiteral(insertMatch[1] ?? ""),
        value: decodeSqlStringLiteral(insertMatch[2] ?? ""),
        insertOnly: true,
      }],
    };
  }

  const replaceMatch = /^replace\s+into\s+kv_store\s*\(\s*key\s*,\s*value\s*\)\s*values\s*\(\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*\)\s*;?$/i.exec(trimmed);
  if (replaceMatch) {
    return {
      result: {
        rows: [],
        columns: [],
        rowCount: 0,
      },
      writes: [{
        type: "upsert",
        key: decodeSqlStringLiteral(replaceMatch[1] ?? ""),
        value: decodeSqlStringLiteral(replaceMatch[2] ?? ""),
        insertOnly: false,
      }],
    };
  }

  const updateMatch = /^update\s+kv_store\s+set\s+value\s*=\s*'((?:''|[^'])*)'\s+where\s+key\s*=\s*'((?:''|[^'])*)'\s*;?$/i.exec(trimmed);
  if (updateMatch) {
    return {
      result: {
        rows: [],
        columns: [],
        rowCount: 0,
      },
      writes: [{
        type: "upsert",
        key: decodeSqlStringLiteral(updateMatch[2] ?? ""),
        value: decodeSqlStringLiteral(updateMatch[1] ?? ""),
        insertOnly: false,
      }],
    };
  }

  const deleteMatch = /^delete\s+from\s+kv_store\s+where\s+key\s*=\s*'((?:''|[^'])*)'\s*;?$/i.exec(trimmed);
  if (deleteMatch) {
    return {
      result: {
        rows: [],
        columns: [],
        rowCount: 0,
      },
      writes: [{
        type: "delete",
        key: decodeSqlStringLiteral(deleteMatch[1] ?? ""),
      }],
    };
  }

  throw new Error("Unsupported SQL statement for Convex storage inspector");
};

export const listStorageInstances = query({
  args: {
    workspaceId: v.string(),
  },
  handler: async (ctx, args): Promise<Array<StorageInstance>> => {
    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);

    const workspaceRows = await ctx.db
      .query("storageInstances")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    const organizationRows = await ctx.db
      .query("storageInstances")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .collect();

    const storageInstances = [...workspaceRows, ...organizationRows]
      .map((row) =>
        toStorageInstance(row as unknown as Record<string, unknown>),
      )
      .filter((storageInstance) =>
        canAccessStorageInstance(storageInstance, {
          workspaceId: args.workspaceId,
          organizationId,
        })
      );

    const uniqueStorageInstances = Array.from(
      new Map(storageInstances.map((storageInstance) => [storageInstance.id, storageInstance]))
        .values(),
    );

    return sortStorageInstances(uniqueStorageInstances);
  },
});

export const openStorageInstance = mutation({
  args: {
    workspaceId: v.string(),
    payload: v.object({
      scopeType: storageScopeTypeValidator,
      durability: storageDurabilityValidator,
      provider: v.optional(storageProviderValidator),
      purpose: v.optional(v.string()),
      ttlHours: v.optional(v.number()),
      accountId: v.optional(v.string()),
      sessionId: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args): Promise<StorageInstance> => {
    const payload = args.payload as OpenStorageInstancePayload;

    if (payload.scopeType === "account" && payload.accountId === undefined) {
      throw new Error("Account scope storage requires accountId");
    }

    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);
    const now = Date.now();
    const storageInstanceId = `storage_${crypto.randomUUID()}`;
    const ttlHours =
      payload.ttlHours !== undefined && Number.isFinite(payload.ttlHours)
        ? Math.max(1, Math.floor(payload.ttlHours))
        : 24;

    const nextStorageInstance = decodeStorageInstance({
      id: storageInstanceId,
      scopeType: payload.scopeType,
      durability: payload.durability,
      status: "active",
      provider: payload.provider ?? "agentfs-local",
      backendKey: `convex:${storageInstanceId}`,
      organizationId,
      workspaceId:
        payload.scopeType === "workspace" || payload.scopeType === "scratch"
          ? args.workspaceId
          : null,
      accountId: payload.scopeType === "account" ? (payload.accountId ?? null) : null,
      createdByAccountId: payload.accountId ?? null,
      purpose:
        payload.purpose !== undefined && payload.purpose.trim().length > 0
          ? payload.purpose.trim()
          : null,
      sizeBytes: null,
      fileCount: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      closedAt: null,
      expiresAt:
        payload.durability === "ephemeral"
          ? now + ttlHours * 3_600_000
          : null,
    });

    await ctx.db.insert("storageInstances", nextStorageInstance);

    return nextStorageInstance;
  },
});

export const closeStorageInstance = mutation({
  args: {
    workspaceId: v.string(),
    storageInstanceId: v.string(),
  },
  handler: async (ctx, args): Promise<StorageInstance> => {
    const existingStorageInstance = await resolveAccessibleStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      storageInstanceId: args.storageInstanceId,
    });

    if (!existingStorageInstance) {
      throw new Error(`Storage instance not found: ${args.storageInstanceId}`);
    }

    const existingRow = await ctx.db
      .query("storageInstances")
      .withIndex("by_domainId", (q) => q.eq("id", args.storageInstanceId))
      .unique();

    if (!existingRow) {
      throw new Error(`Storage instance not found: ${args.storageInstanceId}`);
    }

    const now = Date.now();
    const nextStorageInstance = decodeStorageInstance({
      ...existingStorageInstance,
      status: "closed",
      updatedAt: now,
      lastSeenAt: now,
      closedAt: existingStorageInstance.closedAt ?? now,
    });

    await ctx.db.patch(existingRow._id, nextStorageInstance);

    return nextStorageInstance;
  },
});

export const removeStorageInstance = mutation({
  args: {
    workspaceId: v.string(),
    storageInstanceId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    removed: boolean;
  }> => {
    const existingStorageInstance = await resolveAccessibleStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      storageInstanceId: args.storageInstanceId,
    });

    if (!existingStorageInstance) {
      return { removed: false };
    }

    const storageInstanceRow = await ctx.db
      .query("storageInstances")
      .withIndex("by_domainId", (q) => q.eq("id", args.storageInstanceId))
      .unique();

    if (!storageInstanceRow) {
      return { removed: false };
    }

    const storageFileRows = await ctx.db
      .query("storageFileEntries")
      .withIndex("by_storageInstanceId", (q) => q.eq("storageInstanceId", args.storageInstanceId))
      .collect();

    for (const storageFileRow of storageFileRows) {
      await ctx.db.delete(storageFileRow._id);
    }

    const storageKvRows = await ctx.db
      .query("storageKvEntries")
      .withIndex("by_storageInstanceId", (q) => q.eq("storageInstanceId", args.storageInstanceId))
      .collect();

    for (const storageKvRow of storageKvRows) {
      await ctx.db.delete(storageKvRow._id);
    }

    const storageSqlKvRows = await ctx.db
      .query("storageSqlKvEntries")
      .withIndex("by_storageInstanceId", (q) => q.eq("storageInstanceId", args.storageInstanceId))
      .collect();

    for (const storageSqlKvRow of storageSqlKvRows) {
      await ctx.db.delete(storageSqlKvRow._id);
    }

    await ctx.db.delete(storageInstanceRow._id);

    return { removed: true };
  },
});

export const listStorageDirectory = query({
  args: {
    workspaceId: v.string(),
    storageInstanceId: v.string(),
    payload: v.object({
      path: v.string(),
    }),
  },
  handler: async (ctx, args): Promise<ListStorageDirectoryResult> => {
    const storageInstance = await resolveAccessibleStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      storageInstanceId: args.storageInstanceId,
    });

    if (!storageInstance) {
      throw new Error(`Storage instance not found: ${args.storageInstanceId}`);
    }

    const normalizedPath = normalizeStoragePath(args.payload.path);

    const storageFileRows = await ctx.db
      .query("storageFileEntries")
      .withIndex("by_storageInstanceId", (q) => q.eq("storageInstanceId", args.storageInstanceId))
      .collect();

    const storageFiles = storageFileRows.map((row) =>
      toStorageFileEntry(row as unknown as Record<string, unknown>),
    );

    const exactFile = storageFiles.find((storageFile) => storageFile.path === normalizedPath);
    if (exactFile) {
      throw new Error(`Cannot list a file path as directory: ${normalizedPath}`);
    }

    const prefix = normalizedPath === "/" ? "/" : `${normalizedPath}/`;
    const directoryByPath = new Map<string, {
      name: string;
      path: string;
      kind: "directory";
      sizeBytes: null;
      updatedAt: number;
    }>();
    const fileEntries: Array<{
      name: string;
      path: string;
      kind: "file";
      sizeBytes: number;
      updatedAt: number;
    }> = [];

    for (const storageFile of storageFiles) {
      if (!storageFile.path.startsWith(prefix)) {
        continue;
      }

      const remainder = storageFile.path.slice(prefix.length);
      if (remainder.length === 0) {
        continue;
      }

      const separatorIndex = remainder.indexOf("/");
      if (separatorIndex < 0) {
        const fileName = remainder;
        fileEntries.push({
          name: fileName,
          path: storageFile.path,
          kind: "file",
          sizeBytes: storageFile.sizeBytes,
          updatedAt: storageFile.updatedAt,
        });
        continue;
      }

      const directoryName = remainder.slice(0, separatorIndex);
      const directoryPath = normalizedPath === "/"
        ? `/${directoryName}`
        : `${normalizedPath}/${directoryName}`;
      const existingDirectory = directoryByPath.get(directoryPath);

      if (!existingDirectory) {
        directoryByPath.set(directoryPath, {
          name: directoryName,
          path: directoryPath,
          kind: "directory",
          sizeBytes: null,
          updatedAt: storageFile.updatedAt,
        });
        continue;
      }

      if (storageFile.updatedAt > existingDirectory.updatedAt) {
        directoryByPath.set(directoryPath, {
          ...existingDirectory,
          updatedAt: storageFile.updatedAt,
        });
      }
    }

    if (
      normalizedPath !== "/"
      && directoryByPath.size === 0
      && fileEntries.length === 0
    ) {
      throw new Error(`Directory not found: ${normalizedPath}`);
    }

    const directoryEntries = [...directoryByPath.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    const sortedFileEntries = [...fileEntries].sort((left, right) =>
      left.name.localeCompare(right.name)
    );

    return {
      path: normalizedPath,
      entries: [...directoryEntries, ...sortedFileEntries],
    };
  },
});

export const readStorageFile = query({
  args: {
    workspaceId: v.string(),
    storageInstanceId: v.string(),
    payload: v.object({
      path: v.string(),
      encoding: v.optional(readStorageEncodingValidator),
    }),
  },
  handler: async (ctx, args): Promise<ReadStorageFileResult> => {
    const storageInstance = await resolveAccessibleStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      storageInstanceId: args.storageInstanceId,
    });

    if (!storageInstance) {
      throw new Error(`Storage instance not found: ${args.storageInstanceId}`);
    }

    const normalizedPath = normalizeStoragePath(args.payload.path);
    const storageFileRow = await ctx.db
      .query("storageFileEntries")
      .withIndex("by_storageInstanceId_path", (q) =>
        q.eq("storageInstanceId", args.storageInstanceId).eq("path", normalizedPath)
      )
      .unique();

    if (!storageFileRow) {
      throw new Error(`Storage file not found: ${normalizedPath}`);
    }

    const storageFile = toStorageFileEntry(storageFileRow as unknown as Record<string, unknown>);
    const encoding = args.payload.encoding ?? "utf8";

    return {
      path: normalizedPath,
      encoding,
      content: encoding === "base64"
        ? storageFile.contentBase64
        : decodeBase64Utf8(storageFile.contentBase64),
      bytes: storageFile.sizeBytes,
    };
  },
});

export const listStorageKv = query({
  args: {
    workspaceId: v.string(),
    storageInstanceId: v.string(),
    payload: v.object({
      prefix: v.optional(v.string()),
      limit: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args): Promise<ListStorageKvResult> => {
    const storageInstance = await resolveAccessibleStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      storageInstanceId: args.storageInstanceId,
    });

    if (!storageInstance) {
      throw new Error(`Storage instance not found: ${args.storageInstanceId}`);
    }

    const prefix = args.payload.prefix ?? "";
    const requestedLimit =
      args.payload.limit !== undefined && Number.isFinite(args.payload.limit)
        ? Math.floor(args.payload.limit)
        : DEFAULT_KV_LIMIT;
    const limit = Math.max(1, Math.min(MAX_KV_LIMIT, requestedLimit));

    const storageKvRows = await ctx.db
      .query("storageKvEntries")
      .withIndex("by_storageInstanceId", (q) => q.eq("storageInstanceId", args.storageInstanceId))
      .collect();

    const items = storageKvRows
      .map((row) => toStorageKvEntry(row as unknown as Record<string, unknown>))
      .filter((entry) => entry.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key))
      .slice(0, limit)
      .map((entry) => ({
        key: entry.key,
        value: parseJsonOrString(entry.valueJson),
      }));

    return {
      items,
    };
  },
});

export const queryStorageSql = mutation({
  args: {
    workspaceId: v.string(),
    storageInstanceId: v.string(),
    payload: v.object({
      sql: v.string(),
      maxRows: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args): Promise<QueryStorageSqlResult> => {
    const storageInstance = await resolveAccessibleStorageInstance(ctx, {
      workspaceId: args.workspaceId,
      storageInstanceId: args.storageInstanceId,
    });

    if (!storageInstance) {
      throw new Error(`Storage instance not found: ${args.storageInstanceId}`);
    }

    const sqlText = args.payload.sql.trim();
    if (sqlText.length === 0) {
      throw new Error("SQL query is required");
    }

    const requestedMaxRows =
      args.payload.maxRows !== undefined && Number.isFinite(args.payload.maxRows)
        ? Math.floor(args.payload.maxRows)
        : DEFAULT_SQL_MAX_ROWS;
    const maxRows = Math.max(1, Math.min(MAX_SQL_MAX_ROWS, requestedMaxRows));

    const sqlRowsRaw = await ctx.db
      .query("storageSqlKvEntries")
      .withIndex("by_storageInstanceId", (q) => q.eq("storageInstanceId", args.storageInstanceId))
      .collect();

    const sqlRows = sqlRowsRaw.map((row) =>
      toStorageSqlKvEntry(row as unknown as Record<string, unknown>),
    );
    const byKey = new Map<string, {
      row: StorageSqlKvEntry;
      docId: unknown;
    }>();

    for (let index = 0; index < sqlRows.length; index += 1) {
      const row = sqlRows[index];
      const rawRow = sqlRowsRaw[index];
      if (row && rawRow) {
        byKey.set(row.key, {
          row,
          docId: rawRow._id,
        });
      }
    }

    const execution = executeSqlForStorage(sqlText, sqlRows, maxRows);

    for (const write of execution.writes) {
      if (write.type === "delete") {
        const existing = byKey.get(write.key);
        if (existing) {
          await ctx.db.delete(existing.docId as any);
          byKey.delete(write.key);
        }
        continue;
      }

      const existing = byKey.get(write.key);
      if (existing && write.insertOnly) {
        throw new Error(`UNIQUE constraint failed: kv_store.key (${write.key})`);
      }

      const now = Date.now();

      if (existing) {
        const nextRow = decodeStorageSqlKvEntry({
          ...existing.row,
          value: write.value,
          updatedAt: now,
        });

        await ctx.db.patch(existing.docId as any, nextRow);
        byKey.set(write.key, {
          row: nextRow,
          docId: existing.docId,
        });
        continue;
      }

      const nextRow = decodeStorageSqlKvEntry({
        id: `storage_sql_kv_${crypto.randomUUID()}`,
        storageInstanceId: args.storageInstanceId,
        key: write.key,
        value: write.value,
        updatedAt: now,
      });

      const insertedId = await ctx.db.insert("storageSqlKvEntries", nextRow);
      byKey.set(write.key, {
        row: nextRow,
        docId: insertedId,
      });
    }

    return execution.result;
  },
});
