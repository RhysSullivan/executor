import {
  type ListStorageDirectoryPayload,
  type ListStorageDirectoryResult,
  type ListStorageKvPayload,
  type ListStorageKvResult,
  type QueryStorageSqlPayload,
  type QueryStorageSqlResult,
  type ReadStorageFilePayload,
  type ReadStorageFileResult,
} from "@executor-v2/management-api";
import { type StorageInstance } from "@executor-v2/schema";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";

export const DEFAULT_EPHEMERAL_TTL_HOURS = 24;

const DEFAULT_KV_LIMIT = 100;
const MAX_KV_LIMIT = 1000;
const DEFAULT_SQL_MAX_ROWS = 200;
const MAX_SQL_MAX_ROWS = 5000;
const STORAGE_ROOT_DIRECTORY = "storage";
const STORAGE_FS_DIRECTORY = "fs";
const STORAGE_KV_FILE = "kv-store.json";
const STORAGE_SQLITE_FILE = "storage.sqlite";

type SqliteDatabaseInstance = {
  exec: (sql: string) => void;
  query: (sql: string) => {
    all: () => Array<Record<string, unknown>>;
  };
  run: (sql: string) => unknown;
  close: () => void;
};

type SqliteDatabaseConstructor = new (
  filename: string,
  options?: {
    create?: boolean;
  },
) => SqliteDatabaseInstance;

const loadSqliteDatabase = async (): Promise<SqliteDatabaseConstructor | null> => {
  try {
    const sqliteModule = await import("bun:sqlite");
    return sqliteModule.Database as SqliteDatabaseConstructor;
  } catch {
    return null;
  }
};

const storageInstanceRootPath = (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
): string => path.resolve(stateRootDir, STORAGE_ROOT_DIRECTORY, storageInstanceId);

const storageInstanceFsRootPath = (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
): string =>
  path.resolve(
    storageInstanceRootPath(stateRootDir, storageInstanceId),
    STORAGE_FS_DIRECTORY,
  );

const storageInstanceKvPath = (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
): string =>
  path.resolve(
    storageInstanceRootPath(stateRootDir, storageInstanceId),
    STORAGE_KV_FILE,
  );

const storageInstanceSqlitePath = (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
): string =>
  path.resolve(
    storageInstanceRootPath(stateRootDir, storageInstanceId),
    STORAGE_SQLITE_FILE,
  );

const resolvePathWithinRoot = (
  rootPath: string,
  requestedPath: string,
): {
  normalizedPath: string;
  absolutePath: string;
} => {
  const trimmed = requestedPath.trim();
  const normalizedPath = path.posix.normalize(
    trimmed.length > 0
      ? (trimmed.startsWith("/") ? trimmed : `/${trimmed}`)
      : "/",
  );

  const relativePath = normalizedPath.replace(/^\/+/, "");
  const absolutePath = path.resolve(rootPath, relativePath);

  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error("Path escapes storage root");
  }

  return {
    normalizedPath,
    absolutePath,
  };
};

const toStorageEntryPath = (absolutePath: string, fsRootPath: string): string => {
  const relativePath = path.relative(fsRootPath, absolutePath);
  return `/${relativePath.split(path.sep).join("/")}`;
};

const readKvStore = async (
  kvPath: string,
): Promise<Record<string, unknown>> => {
  const raw = await readFile(kvPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  return {};
};

export const initializeStorageInstanceFiles = async (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
): Promise<void> => {
  const rootPath = storageInstanceRootPath(stateRootDir, storageInstanceId);
  const fsRootPath = storageInstanceFsRootPath(stateRootDir, storageInstanceId);
  const kvPath = storageInstanceKvPath(stateRootDir, storageInstanceId);
  const sqlitePath = storageInstanceSqlitePath(stateRootDir, storageInstanceId);

  await mkdir(rootPath, { recursive: true });
  await mkdir(fsRootPath, { recursive: true });

  const kvJson = JSON.stringify({}, null, 2);
  await writeFile(kvPath, kvJson, { encoding: "utf8" });

  const SqliteDatabase = await loadSqliteDatabase();
  if (SqliteDatabase === null) {
    await writeFile(sqlitePath, "", { encoding: "utf8" });
    return;
  }

  const db = new SqliteDatabase(sqlitePath, { create: true });
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
  } finally {
    db.close();
  }
};

export const removeStorageInstanceFiles = async (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
): Promise<void> => {
  await rm(storageInstanceRootPath(stateRootDir, storageInstanceId), {
    recursive: true,
    force: true,
  });
};

export const listStorageDirectoryFromFilesystem = async (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
  payload: ListStorageDirectoryPayload,
): Promise<ListStorageDirectoryResult> => {
  const fsRootPath = storageInstanceFsRootPath(stateRootDir, storageInstanceId);
  await mkdir(fsRootPath, { recursive: true });

  const resolved = resolvePathWithinRoot(fsRootPath, payload.path);

  const entries = await readdir(resolved.absolutePath, {
    withFileTypes: true,
  });

  const mapped = await Promise.all(
    entries.map(async (entry) => {
      const entryAbsolutePath = path.resolve(
        resolved.absolutePath,
        entry.name,
      );
      const entryStat = await stat(entryAbsolutePath);

      return {
        name: entry.name,
        path: toStorageEntryPath(entryAbsolutePath, fsRootPath),
        kind: entry.isDirectory() ? "directory" : "file",
        sizeBytes: entry.isDirectory() ? null : entryStat.size,
        updatedAt: entryStat.mtimeMs,
      } as const;
    }),
  );

  mapped.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  return {
    path: resolved.normalizedPath,
    entries: mapped,
  };
};

export const readStorageFileFromFilesystem = async (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
  payload: ReadStorageFilePayload,
): Promise<ReadStorageFileResult> => {
  const fsRootPath = storageInstanceFsRootPath(stateRootDir, storageInstanceId);
  const encoding = payload.encoding ?? "utf8";

  await mkdir(fsRootPath, { recursive: true });

  const resolved = resolvePathWithinRoot(fsRootPath, payload.path);
  const entryStat = await stat(resolved.absolutePath);

  if (entryStat.isDirectory()) {
    throw new Error("Cannot read a directory");
  }

  const contentBuffer = await readFile(resolved.absolutePath);

  return {
    path: resolved.normalizedPath,
    encoding,
    content:
      encoding === "base64"
        ? contentBuffer.toString("base64")
        : contentBuffer.toString("utf8"),
    bytes: contentBuffer.byteLength,
  };
};

export const listStorageKvFromFilesystem = async (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
  payload: ListStorageKvPayload,
): Promise<ListStorageKvResult> => {
  const kvPath = storageInstanceKvPath(stateRootDir, storageInstanceId);
  const kvStore = await readKvStore(kvPath);
  const prefix = payload.prefix ?? "";
  const requestedLimit =
    payload.limit !== undefined && Number.isFinite(payload.limit)
      ? Math.floor(payload.limit)
      : DEFAULT_KV_LIMIT;
  const limit = Math.max(1, Math.min(MAX_KV_LIMIT, requestedLimit));

  const items = Object.entries(kvStore)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .slice(0, limit)
    .map(([key, value]) => ({ key, value }));

  return {
    items,
  };
};

export const queryStorageSqliteFile = async (
  stateRootDir: string,
  storageInstanceId: StorageInstance["id"],
  payload: QueryStorageSqlPayload,
): Promise<QueryStorageSqlResult> => {
  const sqlitePath = storageInstanceSqlitePath(stateRootDir, storageInstanceId);
  await mkdir(path.dirname(sqlitePath), { recursive: true });

  const SqliteDatabase = await loadSqliteDatabase();
  if (SqliteDatabase === null) {
    throw new Error("SQLite runtime is unavailable in this environment");
  }

  const db = new SqliteDatabase(sqlitePath, { create: true });

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );

    const maxRows =
      payload.maxRows !== undefined && Number.isFinite(payload.maxRows)
        ? Math.max(1, Math.min(MAX_SQL_MAX_ROWS, Math.floor(payload.maxRows)))
        : DEFAULT_SQL_MAX_ROWS;

    try {
      const statement = db.query(payload.sql);
      const rawRows = statement.all() as Array<Record<string, unknown>>;
      const rows = rawRows.slice(0, maxRows);
      const columns =
        rows.length > 0
          ? Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
          : [];

      return {
        rows,
        columns,
        rowCount: rows.length,
      };
    } catch {
      db.run(payload.sql);

      return {
        rows: [],
        columns: [],
        rowCount: 0,
      };
    }
  } finally {
    db.close();
  }
};
