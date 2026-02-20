import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { StorageInstanceRecord, StorageProvider as StorageProviderId } from "../../../core/src/types";

export type StorageEncoding = "utf8" | "base64";

export interface StorageDirectoryEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "unknown";
  size?: number;
  mtime?: number;
}

export interface StorageStatResult {
  exists: boolean;
  type?: "file" | "directory" | "symlink" | "unknown";
  size?: number;
  mode?: number;
  mtime?: number;
  ctime?: number;
}

export interface StorageUsage {
  sizeBytes?: number;
  fileCount?: number;
}

export interface StorageSqlResult {
  mode: "read" | "write";
  rows?: Record<string, unknown>[];
  rowCount: number;
  changes?: number;
}

export interface StorageProvider {
  readFile(instance: StorageInstanceRecord, path: string, encoding: StorageEncoding): Promise<{ content: string; bytes: number }>;
  writeFile(
    instance: StorageInstanceRecord,
    path: string,
    content: string,
    encoding: StorageEncoding,
  ): Promise<{ bytesWritten: number }>;
  readdir(instance: StorageInstanceRecord, path: string): Promise<StorageDirectoryEntry[]>;
  stat(instance: StorageInstanceRecord, path: string): Promise<StorageStatResult>;
  mkdir(instance: StorageInstanceRecord, path: string): Promise<void>;
  remove(instance: StorageInstanceRecord, path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
  kvGet(instance: StorageInstanceRecord, key: string): Promise<unknown>;
  kvSet(instance: StorageInstanceRecord, key: string, value: unknown): Promise<void>;
  kvList(instance: StorageInstanceRecord, prefix: string, limit: number): Promise<Array<{ key: string; value: unknown }>>;
  kvDelete(instance: StorageInstanceRecord, key: string): Promise<void>;
  sqliteQuery(
    instance: StorageInstanceRecord,
    args: { sql: string; params: Array<string | number | boolean | null>; mode: "read" | "write"; maxRows: number },
  ): Promise<StorageSqlResult>;
  usage(instance: StorageInstanceRecord): Promise<StorageUsage>;
  deleteInstance(instance: StorageInstanceRecord): Promise<void>;
}

type SqlJsDatabase = {
  run: (sql: string, params?: Array<string | number | null>) => void;
  exec: (sql: string, params?: Array<string | number | null>) => Array<{
    columns: string[];
    values: Array<Array<string | number | null>>;
  }>;
  export: () => Uint8Array;
  getRowsModified: () => number;
  close: () => void;
};

type SqlJsModule = {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
};

let sqlJsModulePromise: Promise<SqlJsModule> | null = null;

async function loadSqlJsModule(): Promise<SqlJsModule> {
  if (!sqlJsModulePromise) {
    sqlJsModulePromise = (async () => {
      const module = await import("sql.js/dist/sql-asm.js") as { default?: (options?: unknown) => Promise<SqlJsModule> };
      const initialize = module.default;
      if (typeof initialize !== "function") {
        throw new Error("Failed to load sql.js asm module");
      }

      return await initialize();
    })();
  }

  return await sqlJsModulePromise;
}

function normalizeBackendKey(backendKey: string): string {
  const trimmed = backendKey.trim();
  const fallback = `instance_${crypto.randomUUID()}`;
  const safe = (trimmed.length > 0 ? trimmed : fallback).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return safe.length > 0 ? safe : fallback;
}

function normalizeStoragePath(baseDir: string, backendKey: string): string {
  const key = normalizeBackendKey(backendKey);
  return join(baseDir, key);
}

function normalizeRelativeFsPath(path: string): string {
  const candidate = (path ?? "").trim();
  const withoutLeadingSlash = candidate.replace(/^\/+/, "");
  const normalized = normalize(withoutLeadingSlash);
  if (!normalized || normalized === ".") {
    return "";
  }

  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes storage root: ${path}`);
  }

  return normalized;
}

function toDbValue(value: string | number | boolean | null): string | number | null {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

function rowsFromSqlResult(result: Array<{ columns: string[]; values: Array<Array<string | number | null>> }>): Record<string, unknown>[] {
  const first = result[0];
  if (!first) {
    return [];
  }

  return first.values.map((row) => {
    const entry: Record<string, unknown> = {};
    for (let index = 0; index < first.columns.length; index += 1) {
      entry[first.columns[index]] = row[index];
    }
    return entry;
  });
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function isNotFoundError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "ENOENT" || code === "NOT_FOUND";
}

function isReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  return trimmed.startsWith("select")
    || trimmed.startsWith("pragma")
    || trimmed.startsWith("explain")
    || trimmed.startsWith("with");
}

function hasMultipleSqlStatements(sql: string): boolean {
  const statements = sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return statements.length > 1;
}

class AgentFsLocalStorageProvider implements StorageProvider {
  private readonly baseDir: string;
  private readonly instanceWriteLocks = new Map<string, Promise<void>>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private getInstancePaths(instance: StorageInstanceRecord) {
    const rootPath = normalizeStoragePath(this.baseDir, instance.backendKey || instance.id);
    const fsRoot = join(rootPath, "fs");
    const sqlitePath = join(rootPath, "storage.sqlite");

    return {
      rootPath,
      fsRoot,
      sqlitePath,
    };
  }

  private resolveFsPath(instance: StorageInstanceRecord, path: string): string {
    const { fsRoot } = this.getInstancePaths(instance);
    const relative = normalizeRelativeFsPath(path);
    const fullPath = resolve(fsRoot, relative);
    const resolvedRoot = resolve(fsRoot);
    if (fullPath !== resolvedRoot && !fullPath.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`Path escapes storage root: ${path}`);
    }

    return fullPath;
  }

  private async withInstanceWriteLock<T>(instance: StorageInstanceRecord, callback: () => Promise<T>): Promise<T> {
    const key = instance.id;
    const previous = this.instanceWriteLocks.get(key) ?? Promise.resolve();
    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.instanceWriteLocks.set(key, current);

    await previous;
    try {
      return await callback();
    } finally {
      releaseLock();
      if (this.instanceWriteLocks.get(key) === current) {
        this.instanceWriteLocks.delete(key);
      }
    }
  }

  private async withDatabaseUnlocked<T>(
    instance: StorageInstanceRecord,
    writeMode: boolean,
    callback: (db: SqlJsDatabase) => Promise<T> | T,
  ): Promise<T> {
    const { rootPath, sqlitePath } = this.getInstancePaths(instance);
    await mkdir(rootPath, { recursive: true });

    const SQL = await loadSqlJsModule();
    let initialBytes: Uint8Array | undefined;
    try {
      const existing = await readFile(sqlitePath);
      initialBytes = new Uint8Array(existing);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const db = new SQL.Database(initialBytes);
    try {
      const result = await callback(db);
      if (writeMode) {
        const serialized = db.export();
        await writeFile(sqlitePath, Buffer.from(serialized));
      }
      return result;
    } finally {
      db.close();
    }
  }

  private async withDatabase<T>(
    instance: StorageInstanceRecord,
    writeMode: boolean,
    callback: (db: SqlJsDatabase) => Promise<T> | T,
  ): Promise<T> {
    if (!writeMode) {
      return await this.withDatabaseUnlocked(instance, false, callback);
    }

    return await this.withInstanceWriteLock(instance, async () => {
      return await this.withDatabaseUnlocked(instance, true, callback);
    });
  }

  private async ensureKvTable(db: SqlJsDatabase) {
    db.run(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async readFile(instance: StorageInstanceRecord, path: string, encoding: StorageEncoding): Promise<{ content: string; bytes: number }> {
    const fullPath = this.resolveFsPath(instance, path);
    const file = await readFile(fullPath);
    if (encoding === "base64") {
      return {
        content: file.toString("base64"),
        bytes: file.length,
      };
    }

    const text = file.toString("utf8");
    return {
      content: text,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }

  async writeFile(
    instance: StorageInstanceRecord,
    path: string,
    content: string,
    encoding: StorageEncoding,
  ): Promise<{ bytesWritten: number }> {
    return await this.withInstanceWriteLock(instance, async () => {
      const fullPath = this.resolveFsPath(instance, path);
      await mkdir(dirname(fullPath), { recursive: true });
      const payload = encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf8");
      await writeFile(fullPath, payload);
      return {
        bytesWritten: payload.length,
      };
    });
  }

  async readdir(instance: StorageInstanceRecord, path: string): Promise<StorageDirectoryEntry[]> {
    const fullPath = this.resolveFsPath(instance, path);
    const entries = await readdir(fullPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : entry.isSymbolicLink()
            ? "symlink"
            : "unknown",
    }));
  }

  async stat(instance: StorageInstanceRecord, path: string): Promise<StorageStatResult> {
    const fullPath = this.resolveFsPath(instance, path);
    try {
      const stats = await lstat(fullPath);
      return {
        exists: true,
        type: stats.isDirectory()
          ? "directory"
          : stats.isFile()
            ? "file"
            : stats.isSymbolicLink()
              ? "symlink"
              : "unknown",
        size: stats.size,
        mode: stats.mode,
        mtime: stats.mtimeMs,
        ctime: stats.ctimeMs,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return { exists: false };
      }
      throw error;
    }
  }

  async mkdir(instance: StorageInstanceRecord, path: string): Promise<void> {
    await this.withInstanceWriteLock(instance, async () => {
      const fullPath = this.resolveFsPath(instance, path);
      await mkdir(fullPath, { recursive: true });
    });
  }

  async remove(instance: StorageInstanceRecord, path: string, options: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.withInstanceWriteLock(instance, async () => {
      const fullPath = this.resolveFsPath(instance, path);
      await rm(fullPath, {
        recursive: options.recursive ?? false,
        force: options.force ?? false,
      });
    });
  }

  async kvGet(instance: StorageInstanceRecord, key: string): Promise<unknown> {
    return await this.withDatabase(instance, false, async (db) => {
      await this.ensureKvTable(db);
      const rows = rowsFromSqlResult(db.exec("SELECT value FROM kv_store WHERE key = ?", [key]));
      const raw = rows[0]?.value;
      if (typeof raw !== "string") {
        return undefined;
      }
      return JSON.parse(raw) as unknown;
    });
  }

  async kvSet(instance: StorageInstanceRecord, key: string, value: unknown): Promise<void> {
    await this.withDatabase(instance, true, async (db) => {
      await this.ensureKvTable(db);
      db.run(
        "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [key, JSON.stringify(value), Math.floor(Date.now() / 1000)],
      );
    });
  }

  async kvList(instance: StorageInstanceRecord, prefix: string, limit: number): Promise<Array<{ key: string; value: unknown }>> {
    return await this.withDatabase(instance, false, async (db) => {
      await this.ensureKvTable(db);
      const escapedPrefix = prefix
        .replaceAll("^", "^^")
        .replaceAll("%", "^%")
        .replaceAll("_", "^_");
      const rows = rowsFromSqlResult(
        db.exec(
          "SELECT key, value FROM kv_store WHERE key LIKE ? ESCAPE '^' ORDER BY key LIMIT ?",
          [`${escapedPrefix}%`, limit],
        ),
      );
      return rows.map((row) => ({
        key: String(row.key ?? ""),
        value: typeof row.value === "string" ? JSON.parse(row.value) : null,
      }));
    });
  }

  async kvDelete(instance: StorageInstanceRecord, key: string): Promise<void> {
    await this.withDatabase(instance, true, async (db) => {
      await this.ensureKvTable(db);
      db.run("DELETE FROM kv_store WHERE key = ?", [key]);
    });
  }

  async sqliteQuery(
    instance: StorageInstanceRecord,
    args: { sql: string; params: Array<string | number | boolean | null>; mode: "read" | "write"; maxRows: number },
  ): Promise<StorageSqlResult> {
    if (args.mode === "read" && !isReadOnlySql(args.sql)) {
      throw new Error("sqlite.query rejected a non-read SQL statement in read mode");
    }

    if (hasMultipleSqlStatements(args.sql)) {
      throw new Error("sqlite.query rejects multi-statement SQL payloads");
    }

    const normalizedParams = args.params.map(toDbValue);
    if (args.mode === "write") {
      return await this.withDatabase(instance, true, async (db) => {
        db.exec("PRAGMA query_only = 0");
        db.run(args.sql, normalizedParams);
        const changes = Number(db.getRowsModified());
        return {
          mode: "write",
          rowCount: 0,
          changes: Number.isFinite(changes) ? changes : 0,
        };
      });
    }

    return await this.withDatabase(instance, false, async (db) => {
      db.exec("PRAGMA query_only = 1");
      try {
        const rows = rowsFromSqlResult(db.exec(args.sql, normalizedParams));
        const boundedRows = rows.slice(0, Math.max(1, args.maxRows));
        return {
          mode: "read",
          rows: boundedRows,
          rowCount: boundedRows.length,
        };
      } finally {
        db.exec("PRAGMA query_only = 0");
      }
    });
  }

  async usage(instance: StorageInstanceRecord): Promise<StorageUsage> {
    const { rootPath } = this.getInstancePaths(instance);

    let sizeBytes = 0;
    let fileCount = 0;

    const walk = async (currentPath: string): Promise<void> => {
      const entries = await readdir(currentPath, { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        const absolute = join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          return;
        }

        if (entry.isFile()) {
          const fileStats = await stat(absolute);
          sizeBytes += fileStats.size;
          fileCount += 1;
        }
      }));
    };

    try {
      await walk(rootPath);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    return {
      sizeBytes,
      fileCount,
    };
  }

  async deleteInstance(instance: StorageInstanceRecord): Promise<void> {
    const { rootPath } = this.getInstancePaths(instance);
    await rm(rootPath, { recursive: true, force: true });
  }
}

class CloudflareRemoteStorageProvider implements StorageProvider {
  private readonly endpoint: string;
  private readonly token: string;

  constructor(endpoint: string, token: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.token = token;
  }

  private async request<T>(instance: StorageInstanceRecord, operation: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.endpoint}/v1/storage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        instanceId: instance.id,
        operation,
        payload,
      }),
    });

    const body = await response.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
    if (!response.ok || !body?.ok) {
      const message = body?.error ?? `Cloudflare storage request failed with status ${response.status}`;
      throw new Error(message);
    }

    return body.data as T;
  }

  async readFile(instance: StorageInstanceRecord, path: string, encoding: StorageEncoding): Promise<{ content: string; bytes: number }> {
    return await this.request(instance, "fs.read", { path, encoding });
  }

  async writeFile(
    instance: StorageInstanceRecord,
    path: string,
    content: string,
    encoding: StorageEncoding,
  ): Promise<{ bytesWritten: number }> {
    return await this.request(instance, "fs.write", { path, content, encoding });
  }

  async readdir(instance: StorageInstanceRecord, path: string): Promise<StorageDirectoryEntry[]> {
    const response = await this.request<{ entries: StorageDirectoryEntry[] }>(instance, "fs.readdir", { path });
    return response.entries;
  }

  async stat(instance: StorageInstanceRecord, path: string): Promise<StorageStatResult> {
    return await this.request(instance, "fs.stat", { path });
  }

  async mkdir(instance: StorageInstanceRecord, path: string): Promise<void> {
    await this.request(instance, "fs.mkdir", { path });
  }

  async remove(instance: StorageInstanceRecord, path: string, options: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.request(instance, "fs.remove", {
      path,
      recursive: options.recursive ?? false,
      force: options.force ?? false,
    });
  }

  async kvGet(instance: StorageInstanceRecord, key: string): Promise<unknown> {
    const response = await this.request<{ value?: unknown }>(instance, "kv.get", { key });
    return response.value;
  }

  async kvSet(instance: StorageInstanceRecord, key: string, value: unknown): Promise<void> {
    await this.request(instance, "kv.set", { key, value });
  }

  async kvList(instance: StorageInstanceRecord, prefix: string, limit: number): Promise<Array<{ key: string; value: unknown }>> {
    const response = await this.request<{ items: Array<{ key: string; value: unknown }> }>(instance, "kv.list", {
      prefix,
      limit,
    });
    return response.items;
  }

  async kvDelete(instance: StorageInstanceRecord, key: string): Promise<void> {
    await this.request(instance, "kv.delete", { key });
  }

  async sqliteQuery(
    instance: StorageInstanceRecord,
    args: { sql: string; params: Array<string | number | boolean | null>; mode: "read" | "write"; maxRows: number },
  ): Promise<StorageSqlResult> {
    return await this.request(instance, "sqlite.query", args);
  }

  async usage(instance: StorageInstanceRecord): Promise<StorageUsage> {
    return await this.request(instance, "instance.usage", {});
  }

  async deleteInstance(instance: StorageInstanceRecord): Promise<void> {
    await this.request(instance, "instance.delete", {});
  }
}

let localProviderSingleton: AgentFsLocalStorageProvider | null = null;
let cloudflareProviderSingleton: CloudflareRemoteStorageProvider | null = null;
let cloudflareStorageProbeStarted = false;

function isHostedConvexHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized.endsWith(".convex.cloud") || normalized.endsWith(".convex.site");
}

function isHostedConvexDeployment(): boolean {
  const candidates = [process.env.CONVEX_URL, process.env.CONVEX_SITE_URL]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (isHostedConvexHostname(url.hostname)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

function assertLocalProviderSupported() {
  if (!isHostedConvexDeployment()) {
    return;
  }

  throw new Error(
    "agentfs-local is not supported on hosted Convex deployments because filesystem state is not shared across workers. Use AGENT_STORAGE_PROVIDER=agentfs-cloudflare, or run self-hosted Convex for agentfs-local.",
  );
}

function startCloudflareStorageProbe(endpoint: string, token: string) {
  if (cloudflareStorageProbeStarted) {
    return;
  }
  cloudflareStorageProbeStarted = true;

  void (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`${endpoint}/v1/storage`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: "{}",
        signal: controller.signal,
      });

      if (response.status === 404) {
        console.warn(
          `[storage] Cloudflare storage endpoint ${endpoint}/v1/storage is unreachable (404). Ensure the runner-sandbox-host is deployed with the storage route.`,
        );
      } else if (response.status === 401 || response.status === 403) {
        console.warn(
          "[storage] Cloudflare storage endpoint rejected auth. Verify CLOUDFLARE_SANDBOX_AUTH_TOKEN matches runner-sandbox-host AUTH_TOKEN.",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[storage] Cloudflare storage endpoint ${endpoint}/v1/storage is unreachable: ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  })();
}

function getLocalProvider(): AgentFsLocalStorageProvider {
  assertLocalProviderSupported();

  if (!localProviderSingleton) {
    const baseDir = (process.env.AGENT_STORAGE_ROOT ?? "").trim() || "/tmp/executor-agentfs";
    localProviderSingleton = new AgentFsLocalStorageProvider(baseDir);
  }

  return localProviderSingleton;
}

function getCloudflareProvider(): CloudflareRemoteStorageProvider {
  if (!cloudflareProviderSingleton) {
    const sandboxRunUrl = (process.env.CLOUDFLARE_SANDBOX_RUN_URL ?? "").trim();
    const token = (process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN ?? "").trim();
    if (!sandboxRunUrl || !token) {
      throw new Error(
        "Cloudflare storage provider requires CLOUDFLARE_SANDBOX_RUN_URL and CLOUDFLARE_SANDBOX_AUTH_TOKEN",
      );
    }

    let endpoint = "";
    try {
      const url = new URL(sandboxRunUrl);
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      endpoint = url.toString().replace(/\/$/, "");
    } catch {
      endpoint = sandboxRunUrl.endsWith("/v1/runs")
        ? sandboxRunUrl.slice(0, -"/v1/runs".length)
        : sandboxRunUrl.replace(/\/$/, "");
    }

    cloudflareProviderSingleton = new CloudflareRemoteStorageProvider(endpoint, token);
    startCloudflareStorageProbe(endpoint, token);
  }

  return cloudflareProviderSingleton;
}

export function getStorageProvider(provider: StorageProviderId): StorageProvider {
  if (provider === "agentfs-cloudflare") {
    return getCloudflareProvider();
  }

  return getLocalProvider();
}

export function resetStorageProviderSingletonsForTests() {
  localProviderSingleton = null;
  cloudflareProviderSingleton = null;
  cloudflareStorageProbeStarted = false;
}
