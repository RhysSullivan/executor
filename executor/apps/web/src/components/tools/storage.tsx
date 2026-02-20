"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import {
  Database,
  FolderOpen,
  HardDrive,
  KeyRound,
  Play,
  Plus,
  Power,
  Table,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { StorageDurability, StorageInstanceRecord, StorageScopeType } from "@/lib/types";
import { convexApi } from "@/lib/convex-api";
import { cn } from "@/lib/utils";

type CreateStorageArgs = {
  scopeType: StorageScopeType;
  durability: StorageDurability;
  purpose?: string;
  ttlHours?: number;
};

type StorageDirectoryEntry = {
  name: string;
  type: "file" | "directory" | "symlink" | "unknown";
  size?: number;
  mtime?: number;
};

type StorageSqlResult = {
  mode: "read" | "write";
  rows?: Record<string, unknown>[];
  rowCount: number;
  changes?: number;
};

type StorageSqlObject = {
  name: string;
  type: "table" | "view" | "unknown";
};

const USER_TABLES_QUERY = [
  "SELECT name",
  "FROM sqlite_master",
  "WHERE type = 'table'",
  "  AND name NOT LIKE 'sqlite_%'",
  "  AND name NOT IN ('fs_config', 'fs_data', 'fs_dentry', 'fs_inode', 'fs_symlink', 'kv_store')",
  "ORDER BY name",
].join("\n");

const ALL_OBJECTS_QUERY = "SELECT name, type FROM sqlite_master ORDER BY name";
const KV_DATA_QUERY = "SELECT key, value, updated_at FROM kv_store ORDER BY key LIMIT 200";
const FS_ENTRIES_QUERY = "SELECT * FROM fs_dentry LIMIT 200";
const SQL_OBJECTS_QUERY = "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name";

const INTERNAL_SQL_OBJECT_NAMES = new Set([
  "fs_config",
  "fs_data",
  "fs_dentry",
  "fs_inode",
  "fs_symlink",
  "kv_store",
  "sqlite_sequence",
]);

function prettyBytes(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let bytes = value;
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index += 1;
  }
  const precision = bytes >= 100 || index === 0 ? 0 : 1;
  return `${bytes.toFixed(precision)} ${units[index]}`;
}

function asLocalDate(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function joinStoragePath(basePath: string, name: string): string {
  const base = (basePath.trim() || "/").replace(/\/+$/, "");
  if (!base || base === "/") {
    return `/${name}`;
  }
  return `${base}/${name}`;
}

function previewJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxChars))}\n\n...truncated...`;
}

function sqlCellText(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return previewJson(value);
}

function collectSqlColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

function isInternalSqlObject(name: string): boolean {
  if (INTERNAL_SQL_OBJECT_NAMES.has(name)) {
    return true;
  }
  if (name.startsWith("fs_")) {
    return true;
  }
  return name.startsWith("sqlite_");
}

function sqlObjectType(value: unknown): "table" | "view" | "unknown" {
  if (value === "table" || value === "view") {
    return value;
  }
  return "unknown";
}

function escapeSqlIdentifier(value: string): string {
  return value.replaceAll('"', '""');
}

export function StoragePanel({
  workspaceId,
  sessionId,
  instances,
  loading,
  creating,
  busyInstanceId,
  onCreate,
  onClose,
  onDelete,
}: {
  workspaceId?: string;
  sessionId?: string;
  instances: StorageInstanceRecord[];
  loading: boolean;
  creating: boolean;
  busyInstanceId?: string;
  onCreate: (args: CreateStorageArgs) => Promise<void>;
  onClose: (instanceId: string) => Promise<void>;
  onDelete: (instanceId: string) => Promise<void>;
}) {
  const [scopeType, setScopeType] = useState<StorageScopeType>("scratch");
  const [durability, setDurability] = useState<StorageDurability>("ephemeral");
  const [purpose, setPurpose] = useState("");
  const [ttlHours, setTtlHours] = useState("24");
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | undefined>(undefined);
  const [activeInspectorTab, setActiveInspectorTab] = useState<"fs" | "kv" | "sql">("fs");

  const [fsPath, setFsPath] = useState("/");
  const [fsEntries, setFsEntries] = useState<StorageDirectoryEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  const [filePreviewPath, setFilePreviewPath] = useState<string | null>(null);
  const [filePreviewContent, setFilePreviewContent] = useState<string>("");
  const [filePreviewBytes, setFilePreviewBytes] = useState<number | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  const [kvPrefix, setKvPrefix] = useState("");
  const [kvLimit, setKvLimit] = useState("100");
  const [kvItems, setKvItems] = useState<Array<{ key: string; value: unknown }>>([]);
  const [kvLoading, setKvLoading] = useState(false);
  const [kvError, setKvError] = useState<string | null>(null);

  const [sqlText, setSqlText] = useState(USER_TABLES_QUERY);
  const [sqlMaxRows, setSqlMaxRows] = useState("200");
  const [sqlViewMode, setSqlViewMode] = useState<"table" | "json">("table");
  const [sqlResult, setSqlResult] = useState<StorageSqlResult | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlObjects, setSqlObjects] = useState<StorageSqlObject[]>([]);
  const [sqlObjectsLoading, setSqlObjectsLoading] = useState(false);
  const [sqlObjectsError, setSqlObjectsError] = useState<string | null>(null);
  const [sqlShowInternalObjects, setSqlShowInternalObjects] = useState(false);
  const [selectedSqlObjectName, setSelectedSqlObjectName] = useState<string | null>(null);

  const listDirectory = useAction(convexApi.executorNode.storageListDirectory);
  const readFileAction = useAction(convexApi.executorNode.storageReadFile);
  const listKv = useAction(convexApi.executorNode.storageListKv);
  const querySql = useAction(convexApi.executorNode.storageQuerySql);

  const visibleInstances = useMemo(
    () => [...instances].sort((a, b) => b.updatedAt - a.updatedAt),
    [instances],
  );

  const selectedInstance = useMemo(
    () => visibleInstances.find((instance) => instance.id === selectedInstanceId) ?? visibleInstances[0],
    [selectedInstanceId, visibleInstances],
  );

  useEffect(() => {
    if (!selectedInstance && visibleInstances.length === 0) {
      setSelectedInstanceId(undefined);
      return;
    }
    if (!selectedInstance && visibleInstances.length > 0) {
      setSelectedInstanceId(visibleInstances[0]?.id);
      return;
    }
    if (selectedInstance && selectedInstanceId !== selectedInstance.id) {
      setSelectedInstanceId(selectedInstance.id);
    }
  }, [selectedInstance, selectedInstanceId, visibleInstances]);

  const canInspect = Boolean(workspaceId && selectedInstance);
  const sqlRows = useMemo(() => (sqlResult?.rows ?? []) as Array<Record<string, unknown>>, [sqlResult]);
  const sqlColumns = useMemo(() => collectSqlColumns(sqlRows), [sqlRows]);
  const visibleSqlObjects = useMemo(
    () => sqlObjects.filter((entry) => sqlShowInternalObjects || !isInternalSqlObject(entry.name)),
    [sqlObjects, sqlShowInternalObjects],
  );

  const refreshDirectory = async (nextPath?: string) => {
    if (!workspaceId || !selectedInstance) {
      return;
    }

    const path = (nextPath ?? fsPath).trim() || "/";
    setFsLoading(true);
    setFsError(null);
    try {
      const result = await listDirectory({
        workspaceId: workspaceId as never,
        sessionId,
        instanceId: selectedInstance.id,
        path,
      });
      setFsPath(result.path);
      setFsEntries(result.entries as StorageDirectoryEntry[]);
    } catch (error) {
      setFsError(error instanceof Error ? error.message : "Failed to list directory");
      setFsEntries([]);
    } finally {
      setFsLoading(false);
    }
  };

  const readFilePreview = async (path: string) => {
    if (!workspaceId || !selectedInstance) {
      return;
    }

    setFilePreviewLoading(true);
    try {
      const result = await readFileAction({
        workspaceId: workspaceId as never,
        sessionId,
        instanceId: selectedInstance.id,
        path,
        encoding: "utf8",
      });
      setFilePreviewPath(result.path);
      setFilePreviewContent(truncateText(result.content, 20_000));
      setFilePreviewBytes(result.bytes);
    } catch (error) {
      setFilePreviewPath(path);
      setFilePreviewContent(error instanceof Error ? error.message : "Failed to read file");
      setFilePreviewBytes(null);
    } finally {
      setFilePreviewLoading(false);
    }
  };

  const refreshKv = async () => {
    if (!workspaceId || !selectedInstance) {
      return;
    }

    const parsedLimit = Number.parseInt(kvLimit, 10);
    setKvLoading(true);
    setKvError(null);
    try {
      const result = await listKv({
        workspaceId: workspaceId as never,
        sessionId,
        instanceId: selectedInstance.id,
        prefix: kvPrefix,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 100,
      });
      setKvItems(result.items as Array<{ key: string; value: unknown }>);
    } catch (error) {
      setKvError(error instanceof Error ? error.message : "Failed to list key-value entries");
      setKvItems([]);
    } finally {
      setKvLoading(false);
    }
  };

  const runSql = async (queryOverride?: string) => {
    if (!workspaceId || !selectedInstance) {
      return;
    }

    const sql = (queryOverride ?? sqlText).trim();
    if (!sql) {
      return;
    }

    const parsedMaxRows = Number.parseInt(sqlMaxRows, 10);
    setSqlLoading(true);
    setSqlError(null);
    try {
      const result = await querySql({
        workspaceId: workspaceId as never,
        sessionId,
        instanceId: selectedInstance.id,
        sql,
        maxRows: Number.isFinite(parsedMaxRows) ? parsedMaxRows : 200,
      });
      if (queryOverride) {
        setSqlText(sql);
      }
      setSqlResult(result as StorageSqlResult);
    } catch (error) {
      setSqlError(error instanceof Error ? error.message : "Failed to query SQLite");
      setSqlResult(null);
    } finally {
      setSqlLoading(false);
    }
  };

  const refreshSqlObjects = async () => {
    if (!workspaceId || !selectedInstance) {
      return [] as StorageSqlObject[];
    }

    setSqlObjectsLoading(true);
    setSqlObjectsError(null);
    try {
      const result = await querySql({
        workspaceId: workspaceId as never,
        sessionId,
        instanceId: selectedInstance.id,
        sql: SQL_OBJECTS_QUERY,
        maxRows: 1000,
      });

      const rows = ((result as StorageSqlResult).rows ?? []) as Array<Record<string, unknown>>;
      const objects = rows
        .map((row) => ({
          name: typeof row.name === "string" ? row.name : "",
          type: sqlObjectType(row.type),
        }))
        .filter((entry) => entry.name.length > 0);

      setSqlObjects(objects);
      return objects;
    } catch (error) {
      setSqlObjectsError(error instanceof Error ? error.message : "Failed to list SQLite tables");
      setSqlObjects([]);
      return [] as StorageSqlObject[];
    } finally {
      setSqlObjectsLoading(false);
    }
  };

  const openSqlObject = async (objectName: string) => {
    const parsedMaxRows = Number.parseInt(sqlMaxRows, 10);
    const limit = Number.isFinite(parsedMaxRows) ? Math.max(1, parsedMaxRows) : 200;
    setSelectedSqlObjectName(objectName);
    setSqlViewMode("table");
    await runSql(`SELECT * FROM "${escapeSqlIdentifier(objectName)}" LIMIT ${limit}`);
  };

  useEffect(() => {
    if (!canInspect) {
      setFsEntries([]);
      setKvItems([]);
      setSqlResult(null);
      setSqlObjects([]);
      setSqlObjectsError(null);
      setSelectedSqlObjectName(null);
      return;
    }

    void refreshDirectory("/");
    void refreshKv();
    void (async () => {
      const objects = await refreshSqlObjects();
      const preferred = objects.find((entry) => !isInternalSqlObject(entry.name)) ?? objects[0];
      if (preferred) {
        await openSqlObject(preferred.name);
        return;
      }
      await runSql();
    })();
    setFilePreviewPath(null);
    setFilePreviewContent("");
    setFilePreviewBytes(null);
  }, [canInspect, selectedInstance?.id]);

  const submitCreate = async () => {
    const parsedTtl = Number.parseInt(ttlHours, 10);
    await onCreate({
      scopeType,
      durability,
      ...(purpose.trim().length > 0 ? { purpose: purpose.trim() } : {}),
      ...(durability === "ephemeral" && Number.isFinite(parsedTtl) ? { ttlHours: parsedTtl } : {}),
    });
    setPurpose("");
  };

  return (
    <section className="flex h-full min-h-0 w-full overflow-hidden rounded-none border border-border/50 bg-card/30">
      <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border/40 lg:w-80 xl:w-[22rem]">
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center border border-border/60 bg-background/80">
              <Database className="h-4 w-4 text-muted-foreground" />
            </div>
            <h2 className="text-sm font-medium">Storage</h2>
          </div>
          <Badge variant="outline" className="h-5 px-2 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
            {visibleInstances.length}
          </Badge>
        </div>

        <div className="shrink-0 border-b border-border/40 bg-background/40 px-3 py-3">
          <div className="space-y-2">
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Scope
              <select
                className="h-8 rounded-none border border-border/60 bg-background px-2 text-xs text-foreground"
                value={scopeType}
                onChange={(event) => {
                  const next = event.target.value as StorageScopeType;
                  setScopeType(next);
                  if (next !== "scratch") {
                    setDurability("durable");
                  }
                }}
              >
                <option value="scratch">scratch</option>
                <option value="account">account</option>
                <option value="workspace">workspace</option>
                <option value="organization">organization</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Durability
              <select
                className="h-8 rounded-none border border-border/60 bg-background px-2 text-xs text-foreground"
                value={durability}
                onChange={(event) => setDurability(event.target.value as StorageDurability)}
              >
                <option value="ephemeral">ephemeral</option>
                <option value="durable">durable</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Purpose
              <Input
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="scratch for repo indexing"
                className="h-8 rounded-none text-xs"
              />
            </label>

            <div className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
                TTL (hours)
                <Input
                  value={ttlHours}
                  onChange={(event) => setTtlHours(event.target.value)}
                  disabled={durability !== "ephemeral"}
                  className="h-8 rounded-none text-xs"
                />
              </label>
              <Button size="sm" className="h-8 rounded-none text-xs" disabled={creating} onClick={() => void submitCreate()}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Create
              </Button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-none" />
              ))}
            </div>
          ) : visibleInstances.length === 0 ? (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 border border-dashed border-border/50 bg-background/50 p-3">
              <div className="flex h-10 w-10 items-center justify-center border border-border/60 bg-muted/40">
                <FolderOpen className="h-5 w-5 text-muted-foreground/50" />
              </div>
              <p className="text-sm text-muted-foreground">No storage instances yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {visibleInstances.map((instance) => {
                const busy = busyInstanceId === instance.id;
                const active = selectedInstance?.id === instance.id;
                return (
                  <div
                    key={instance.id}
                    className={cn(
                      "group flex items-center gap-2 border px-2 py-2 transition-colors",
                      active ? "border-primary/40 bg-primary/5" : "border-border/50 bg-background/70",
                      busy ? "opacity-60" : "hover:border-border hover:bg-accent/20",
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setSelectedInstanceId(instance.id)}
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-border/60 bg-muted/50">
                        <Database className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium">{instance.purpose || instance.id}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {instance.scopeType} · {instance.durability} · {instance.status}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {prettyBytes(instance.sizeBytes)} · {instance.fileCount ?? "-"} inode{instance.fileCount === 1 ? "" : "s"}
                        </p>
                      </div>
                    </button>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 rounded-none px-2 text-[11px]"
                        disabled={busy}
                        onClick={() => void onClose(instance.id)}
                      >
                        <Power className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 rounded-none border-destructive/40 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                        disabled={busy}
                        onClick={() => void onDelete(instance.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-h-0 flex-1 min-w-0 flex-col bg-background/50">
        {selectedInstance ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-2.5">
              <div>
                <p className="text-xs font-medium">Inspector</p>
                <p className="text-[11px] text-muted-foreground">{selectedInstance.id} · last used {asLocalDate(selectedInstance.lastSeenAt)}</p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant={activeInspectorTab === "fs" ? "default" : "outline"}
                  size="sm"
                  className="h-7 rounded-none px-2 text-[11px]"
                  onClick={() => setActiveInspectorTab("fs")}
                >
                  <HardDrive className="mr-1 h-3 w-3" /> FS
                </Button>
                <Button
                  variant={activeInspectorTab === "kv" ? "default" : "outline"}
                  size="sm"
                  className="h-7 rounded-none px-2 text-[11px]"
                  onClick={() => setActiveInspectorTab("kv")}
                >
                  <KeyRound className="mr-1 h-3 w-3" /> KV
                </Button>
                <Button
                  variant={activeInspectorTab === "sql" ? "default" : "outline"}
                  size="sm"
                  className="h-7 rounded-none px-2 text-[11px]"
                  onClick={() => setActiveInspectorTab("sql")}
                >
                  <Table className="mr-1 h-3 w-3" /> SQLite
                </Button>
              </div>
            </div>

            {!canInspect ? (
              <div className="p-4 text-xs text-muted-foreground">Select a signed-in workspace session to inspect contents.</div>
            ) : null}

            {activeInspectorTab === "fs" ? (
              <div className="space-y-2 p-4">
                <div className="flex items-center gap-2">
                  <Input
                    value={fsPath}
                    onChange={(event) => setFsPath(event.target.value)}
                    className="h-8 rounded-none text-xs"
                    placeholder="/"
                  />
                  <Button
                    size="sm"
                    className="h-8 rounded-none text-xs"
                    disabled={fsLoading || !canInspect}
                    onClick={() => void refreshDirectory()}
                  >
                    Refresh
                  </Button>
                </div>
                {fsError ? <p className="text-[11px] text-destructive">{fsError}</p> : null}

                <div className="max-h-56 overflow-auto border border-border/40">
                  {fsLoading ? (
                    <div className="p-2 text-[11px] text-muted-foreground">Loading...</div>
                  ) : fsEntries.length === 0 ? (
                    <div className="p-2 text-[11px] text-muted-foreground">No entries</div>
                  ) : (
                    <div className="divide-y divide-border/30">
                      {fsEntries.map((entry) => {
                        const nextPath = joinStoragePath(fsPath, entry.name);
                        return (
                          <div key={`${entry.type}:${entry.name}`} className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px]">
                            <div className="min-w-0">
                              <p className="truncate font-medium">{entry.name}</p>
                              <p className="text-muted-foreground">{entry.type} {typeof entry.size === "number" ? `- ${prettyBytes(entry.size)}` : ""}</p>
                            </div>
                            {entry.type === "directory" ? (
                              <Button variant="outline" size="sm" className="h-6 rounded-none px-2 text-[10px]" onClick={() => void refreshDirectory(nextPath)}>
                                Open
                              </Button>
                            ) : entry.type === "file" ? (
                              <Button variant="outline" size="sm" className="h-6 rounded-none px-2 text-[10px]" onClick={() => void readFilePreview(nextPath)}>
                                Read
                              </Button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {filePreviewPath ? (
                  <div className="border border-border/40">
                    <div className="flex items-center justify-between border-b border-border/30 px-2 py-1 text-[11px]">
                      <span className="truncate">{filePreviewPath}</span>
                      <span className="text-muted-foreground">{filePreviewBytes !== null ? prettyBytes(filePreviewBytes) : "-"}</span>
                    </div>
                    <pre className="max-h-[28rem] overflow-auto p-2 text-[11px] leading-5">{filePreviewLoading ? "Loading..." : filePreviewContent}</pre>
                  </div>
                ) : null}
              </div>
            ) : null}

            {activeInspectorTab === "kv" ? (
              <div className="space-y-2 p-4">
                <div className="flex items-center gap-2">
                  <Input
                    value={kvPrefix}
                    onChange={(event) => setKvPrefix(event.target.value)}
                    className="h-8 rounded-none text-xs"
                    placeholder="prefix"
                  />
                  <Input
                    value={kvLimit}
                    onChange={(event) => setKvLimit(event.target.value)}
                    className="h-8 w-24 rounded-none text-xs"
                    placeholder="100"
                  />
                  <Button
                    size="sm"
                    className="h-8 rounded-none text-xs"
                    disabled={kvLoading || !canInspect}
                    onClick={() => void refreshKv()}
                  >
                    Refresh
                  </Button>
                </div>
                {kvError ? <p className="text-[11px] text-destructive">{kvError}</p> : null}

                <div className="max-h-[36rem] overflow-auto border border-border/40">
                  {kvLoading ? (
                    <div className="p-2 text-[11px] text-muted-foreground">Loading...</div>
                  ) : kvItems.length === 0 ? (
                    <div className="p-2 text-[11px] text-muted-foreground">No key-value entries</div>
                  ) : (
                    <div className="divide-y divide-border/30">
                      {kvItems.map((item) => (
                        <div key={item.key} className="px-2 py-1.5 text-[11px]">
                          <p className="font-medium">{item.key}</p>
                          <pre className="overflow-auto text-muted-foreground">{truncateText(previewJson(item.value), 4000)}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {activeInspectorTab === "sql" ? (
              <div className="grid h-full min-h-0 gap-3 p-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
                <div className="flex min-h-0 flex-col border border-border/40">
                  <div className="flex items-center justify-between border-b border-border/30 px-2 py-1 text-[11px] text-muted-foreground">
                    <span>Tables</span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 rounded-none px-2 text-[10px]"
                        onClick={() => setSqlShowInternalObjects((current) => !current)}
                      >
                        {sqlShowInternalObjects ? "Hide internal" : "Show internal"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 rounded-none px-2 text-[10px]"
                        onClick={() => void refreshSqlObjects()}
                        disabled={sqlObjectsLoading}
                      >
                        Refresh
                      </Button>
                    </div>
                  </div>

                  {sqlObjectsError ? <p className="px-2 py-1 text-[11px] text-destructive">{sqlObjectsError}</p> : null}

                  <div className="min-h-0 flex-1 overflow-y-auto p-1">
                    {sqlObjectsLoading ? (
                      <p className="px-2 py-1 text-[11px] text-muted-foreground">Loading...</p>
                    ) : visibleSqlObjects.length === 0 ? (
                      <p className="px-2 py-1 text-[11px] text-muted-foreground">No tables</p>
                    ) : (
                      <div className="space-y-1">
                        {visibleSqlObjects.map((entry) => (
                          <Button
                            key={entry.name}
                            variant={selectedSqlObjectName === entry.name ? "default" : "outline"}
                            size="sm"
                            className="h-7 w-full justify-start rounded-none px-2 text-[11px]"
                            onClick={() => void openSqlObject(entry.name)}
                          >
                            <span className="truncate">{entry.name}</span>
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex min-h-0 flex-col gap-2">
                  <textarea
                    value={sqlText}
                    onChange={(event) => {
                      setSqlText(event.target.value);
                      setSelectedSqlObjectName(null);
                    }}
                    className="h-24 w-full resize-y rounded-none border border-border/60 bg-background px-2 py-1.5 font-mono text-xs text-foreground"
                    placeholder="SELECT * FROM sqlite_master"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={sqlMaxRows}
                      onChange={(event) => setSqlMaxRows(event.target.value)}
                      className="h-8 w-24 rounded-none text-xs"
                      placeholder="200"
                    />
                    <Button
                      size="sm"
                      className="h-8 rounded-none text-xs"
                      disabled={sqlLoading || !canInspect}
                      onClick={() => {
                        setSelectedSqlObjectName(null);
                        void runSql();
                      }}
                    >
                      <Play className="mr-1 h-3 w-3" /> Run
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 rounded-none px-2 text-[11px]" onClick={() => { setSelectedSqlObjectName(null); void runSql(USER_TABLES_QUERY); }}>
                      User tables
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 rounded-none px-2 text-[11px]" onClick={() => { setSelectedSqlObjectName(null); void runSql(ALL_OBJECTS_QUERY); }}>
                      All objects
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 rounded-none px-2 text-[11px]" onClick={() => { setSelectedSqlObjectName(null); void runSql("PRAGMA table_info('kv_store')"); }}>
                      KV schema
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 rounded-none px-2 text-[11px]" onClick={() => { setSelectedSqlObjectName("kv_store"); void runSql(KV_DATA_QUERY); }}>
                      KV data
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 rounded-none px-2 text-[11px]" onClick={() => { setSelectedSqlObjectName("fs_dentry"); void runSql(FS_ENTRIES_QUERY); }}>
                      FS entries
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Tip: click a table on the left to load rows instantly (no manual SQL needed).
                  </p>
                  {sqlError ? <p className="text-[11px] text-destructive">{sqlError}</p> : null}

                  <div className="min-h-0 flex-1 border border-border/40">
                    {sqlLoading ? (
                      <div className="p-2 text-[11px] text-muted-foreground">Running query...</div>
                    ) : sqlResult ? (
                      <div className="h-full min-h-0">
                        <div className="flex items-center justify-between gap-2 border-b border-border/30 px-2 py-1 text-[11px] text-muted-foreground">
                          <span>
                            rows: {sqlResult.rowCount}
                            {typeof sqlResult.changes === "number" ? ` - changes: ${sqlResult.changes}` : ""}
                            {sqlColumns.length > 0 ? ` - columns: ${sqlColumns.length}` : ""}
                          </span>
                          <div className="flex items-center gap-1">
                            <Button
                              variant={sqlViewMode === "table" ? "default" : "outline"}
                              size="sm"
                              className="h-6 rounded-none px-2 text-[10px]"
                              onClick={() => setSqlViewMode("table")}
                            >
                              Table
                            </Button>
                            <Button
                              variant={sqlViewMode === "json" ? "default" : "outline"}
                              size="sm"
                              className="h-6 rounded-none px-2 text-[10px]"
                              onClick={() => setSqlViewMode("json")}
                            >
                              JSON
                            </Button>
                          </div>
                        </div>

                        {sqlViewMode === "json" ? (
                          <pre className="h-[calc(100%-2rem)] overflow-auto p-2 text-[11px] leading-5">{previewJson(sqlRows)}</pre>
                        ) : sqlRows.length === 0 ? (
                          <div className="p-2 text-[11px] text-muted-foreground">Query returned no rows.</div>
                        ) : (
                          <div className="h-[calc(100%-2rem)] overflow-auto">
                            <table className="min-w-full border-collapse text-[11px]">
                              <thead className="sticky top-0 z-10 bg-muted/50">
                                <tr>
                                  <th className="border-b border-r border-border/40 px-2 py-1 text-left font-medium text-muted-foreground">#</th>
                                  {sqlColumns.map((column) => (
                                    <th
                                      key={column}
                                      className="border-b border-r border-border/40 px-2 py-1 text-left font-medium text-muted-foreground last:border-r-0"
                                    >
                                      {column}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {sqlRows.map((row, rowIndex) => (
                                  <tr key={`row-${rowIndex}`} className="odd:bg-background even:bg-muted/10">
                                    <td className="border-b border-r border-border/30 px-2 py-1 align-top text-muted-foreground">{rowIndex + 1}</td>
                                    {sqlColumns.map((column) => (
                                      <td
                                        key={`row-${rowIndex}-${column}`}
                                        className="max-w-[420px] border-b border-r border-border/30 px-2 py-1 align-top last:border-r-0"
                                      >
                                        <div className="max-h-28 overflow-auto whitespace-pre-wrap break-words">
                                          {truncateText(sqlCellText(row[column]), 2000)}
                                        </div>
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="p-2 text-[11px] text-muted-foreground">Select a table from the left or run a query.</div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="p-4 text-[11px] text-muted-foreground">Select a storage instance to inspect.</div>
        )}
      </div>
    </section>
  );
}
