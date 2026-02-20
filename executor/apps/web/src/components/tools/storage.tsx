"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  File,
  Folder,
  HardDrive,
  KeyRound,
  Play,
  Plus,
  Power,
  Table,
  Trash2,
  X,
} from "lucide-react";
import { JsonView } from "react-json-view-lite";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { StorageDurability, StorageInstanceRecord, StorageScopeType } from "@/lib/types";
import { convexApi } from "@/lib/convex-api";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

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

// ── Constants ──────────────────────────────────────────────────────────────

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

// ── Custom JSON viewer styles ──────────────────────────────────────────────

const jsonViewerStyles = {
  container: "json-viewer-container",
  basicChildStyle: "json-viewer-child",
  label: "json-viewer-label",
  clickableLabel: "json-viewer-clickable-label",
  nullValue: "json-viewer-null",
  undefinedValue: "json-viewer-undefined",
  numberValue: "json-viewer-number",
  stringValue: "json-viewer-string",
  booleanValue: "json-viewer-boolean",
  otherValue: "json-viewer-other",
  punctuation: "json-viewer-punctuation",
  expandIcon: "json-viewer-expand",
  collapseIcon: "json-viewer-collapse",
  collapsedContent: "json-viewer-collapsed",
  childFieldsContainer: "json-viewer-fields",
  noQuotesForStringValues: false,
  quotesForFieldNames: true,
  stringifyStringValues: true,
  ariaLables: {
    collapseJson: "Collapse",
    expandJson: "Expand",
  },
} as const;

// ── Helpers ────────────────────────────────────────────────────────────────

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

function relativeTime(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "-";
  }
  const seconds = Math.floor((Date.now() - value) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

function isJsonLike(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function tryParseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function shouldExpandJsonNode(level: number): boolean {
  return level < 2;
}

// ── Scope badge color ──────────────────────────────────────────────────────

function scopeColor(scope: string): string {
  switch (scope) {
    case "scratch": return "text-muted-foreground";
    case "account": return "text-terminal-cyan";
    case "workspace": return "text-terminal-green";
    case "organization": return "text-terminal-amber";
    default: return "text-muted-foreground";
  }
}

// ── Inline JSON Viewer ─────────────────────────────────────────────────────

function JsonPreview({ data, className }: { data: unknown; className?: string }) {
  if (data === null || data === undefined || typeof data !== "object") {
    return <pre className={cn("font-mono text-xs leading-relaxed whitespace-pre-wrap break-words", className)}>{String(data)}</pre>;
  }

  return (
    <div className={cn("json-viewer-root font-mono text-xs", className)}>
      <JsonView data={data as object} style={jsonViewerStyles} shouldExpandNode={shouldExpandJsonNode} />
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

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
  // ── Create form state ──
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [scopeType, setScopeType] = useState<StorageScopeType>("scratch");
  const [durability, setDurability] = useState<StorageDurability>("ephemeral");
  const [purpose, setPurpose] = useState("");
  const [ttlHours, setTtlHours] = useState("24");

  // ── Selection state ──
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | undefined>(undefined);
  const [activeInspectorTab, setActiveInspectorTab] = useState<"fs" | "kv" | "sql">("fs");

  // ── FS state ──
  const [fsPath, setFsPath] = useState("/");
  const [fsEntries, setFsEntries] = useState<StorageDirectoryEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  const [filePreviewPath, setFilePreviewPath] = useState<string | null>(null);
  const [filePreviewContent, setFilePreviewContent] = useState<string>("");
  const [filePreviewBytes, setFilePreviewBytes] = useState<number | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  // ── KV state ──
  const [kvPrefix, setKvPrefix] = useState("");
  const [kvLimit, setKvLimit] = useState("100");
  const [kvItems, setKvItems] = useState<Array<{ key: string; value: unknown }>>([]);
  const [kvLoading, setKvLoading] = useState(false);
  const [kvError, setKvError] = useState<string | null>(null);
  const [expandedKvKey, setExpandedKvKey] = useState<string | null>(null);

  // ── SQL state ──
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

  // ── Actions ──
  const listDirectory = useAction(convexApi.executorNode.storageListDirectory);
  const readFileAction = useAction(convexApi.executorNode.storageReadFile);
  const listKv = useAction(convexApi.executorNode.storageListKv);
  const querySql = useAction(convexApi.executorNode.storageQuerySql);

  // ── Derived ──
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

  // ── Data fetchers ──

  const refreshDirectory = async (nextPath?: string) => {
    if (!workspaceId || !selectedInstance) return;
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
    if (!workspaceId || !selectedInstance) return;
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
    if (!workspaceId || !selectedInstance) return;
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
    if (!workspaceId || !selectedInstance) return;
    const sql = (queryOverride ?? sqlText).trim();
    if (!sql) return;
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
      if (queryOverride) setSqlText(sql);
      setSqlResult(result as StorageSqlResult);
    } catch (error) {
      setSqlError(error instanceof Error ? error.message : "Failed to query SQLite");
      setSqlResult(null);
    } finally {
      setSqlLoading(false);
    }
  };

  const refreshSqlObjects = async () => {
    if (!workspaceId || !selectedInstance) return [] as StorageSqlObject[];
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

  // ── Effects ──

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
    setShowCreateForm(false);
  };

  // path breadcrumbs
  const pathSegments = fsPath.split("/").filter(Boolean);

  return (
    <section className="flex h-full min-h-0 w-full overflow-hidden border-t border-border/40 bg-background">
      {/* ── Left sidebar: instances ── */}
      <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border/40 bg-card/30 lg:w-72">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">Instances</span>
            {visibleInstances.length > 0 && (
              <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-mono text-muted-foreground">
                {visibleInstances.length}
              </Badge>
            )}
          </div>
          <Button
            variant={showCreateForm ? "default" : "outline"}
            size="sm"
            className="h-6 rounded-md px-2 text-[10px]"
            onClick={() => setShowCreateForm(!showCreateForm)}
          >
            {showCreateForm ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          </Button>
        </div>

        {/* Create form (collapsible) */}
        {showCreateForm && (
          <div className="border-b border-border/40 bg-muted/30 px-3 py-3">
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                  Scope
                  <select
                    className="h-7 rounded-md border border-border/60 bg-background px-2 text-[11px] text-foreground"
                    value={scopeType}
                    onChange={(event) => {
                      const next = event.target.value as StorageScopeType;
                      setScopeType(next);
                      if (next !== "scratch") setDurability("durable");
                    }}
                  >
                    <option value="scratch">scratch</option>
                    <option value="account">account</option>
                    <option value="workspace">workspace</option>
                    <option value="organization">organization</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                  Durability
                  <select
                    className="h-7 rounded-md border border-border/60 bg-background px-2 text-[11px] text-foreground"
                    value={durability}
                    onChange={(event) => setDurability(event.target.value as StorageDurability)}
                  >
                    <option value="ephemeral">ephemeral</option>
                    <option value="durable">durable</option>
                  </select>
                </label>
              </div>
              <Input
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="Purpose (optional)"
                className="h-7 rounded-md text-[11px]"
              />
              <div className="flex items-end gap-2">
                <Input
                  value={ttlHours}
                  onChange={(event) => setTtlHours(event.target.value)}
                  disabled={durability !== "ephemeral"}
                  placeholder="TTL (hours)"
                  className="h-7 flex-1 rounded-md text-[11px]"
                />
                <Button size="sm" className="h-7 rounded-md px-3 text-[10px]" disabled={creating} onClick={() => void submitCreate()}>
                  Create
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Instance list */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="space-y-1 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-md" />
              ))}
            </div>
          ) : visibleInstances.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-8">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/50">
                <Database className="h-5 w-5 text-muted-foreground/40" />
              </div>
              <div className="text-center">
                <p className="text-xs font-medium text-muted-foreground">No instances</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground/60">Create one to get started</p>
              </div>
            </div>
          ) : (
            <div className="p-1.5 space-y-0.5">
              {visibleInstances.map((instance) => {
                const busy = busyInstanceId === instance.id;
                const active = selectedInstance?.id === instance.id;
                return (
                  <div
                    key={instance.id}
                    className={cn(
                      "group relative rounded-md transition-all duration-150",
                      active
                        ? "bg-primary/8 ring-1 ring-primary/20"
                        : "hover:bg-accent/50",
                      busy && "opacity-50 pointer-events-none",
                    )}
                  >
                    <button
                      type="button"
                      className="flex w-full items-start gap-2.5 px-2.5 py-2 text-left"
                      onClick={() => setSelectedInstanceId(instance.id)}
                    >
                      <div className={cn(
                        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                        active ? "bg-primary/15 text-primary" : "bg-muted/60 text-muted-foreground",
                      )}>
                        <Database className="h-3 w-3" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={cn(
                          "truncate text-[11px] font-medium",
                          active ? "text-foreground" : "text-foreground/80",
                        )}>
                          {instance.purpose || instance.id.slice(0, 12)}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span className={cn("text-[9px] font-medium uppercase tracking-wider", scopeColor(instance.scopeType))}>
                            {instance.scopeType}
                          </span>
                          <span className="text-[9px] text-muted-foreground/40">/</span>
                          <span className="text-[9px] text-muted-foreground">
                            {prettyBytes(instance.sizeBytes)}
                          </span>
                          <span className="text-[9px] text-muted-foreground/40">/</span>
                          <span className="text-[9px] text-muted-foreground">
                            {relativeTime(instance.lastSeenAt)}
                          </span>
                        </div>
                      </div>
                    </button>
                    {/* Action buttons - visible on hover/active */}
                    <div className={cn(
                      "absolute right-1.5 top-1.5 flex items-center gap-0.5 transition-opacity",
                      active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 rounded p-0 text-muted-foreground hover:text-foreground"
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); void onClose(instance.id); }}
                        title="Close instance"
                      >
                        <Power className="h-2.5 w-2.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 rounded p-0 text-muted-foreground hover:text-destructive"
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); void onDelete(instance.id); }}
                        title="Delete instance"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* ── Right panel: inspector ── */}
      <div className="flex min-h-0 flex-1 min-w-0 flex-col">
        {selectedInstance ? (
          <Tabs
            value={activeInspectorTab}
            onValueChange={(value) => setActiveInspectorTab(value as "fs" | "kv" | "sql")}
            className="flex h-full min-h-0 flex-col"
          >
            {/* Inspector header */}
            <div className="flex items-center justify-between border-b border-border/40 px-4 py-1.5 bg-card/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-medium text-foreground">
                    {selectedInstance.purpose || selectedInstance.id.slice(0, 20)}
                  </p>
                  <p className="text-[9px] text-muted-foreground">
                    {selectedInstance.durability} · {selectedInstance.status} · last used {asLocalDate(selectedInstance.lastSeenAt)}
                  </p>
                </div>
              </div>
              <TabsList variant="line" className="h-8">
                <TabsTrigger value="fs" className="gap-1.5 px-3 text-[11px]">
                  <HardDrive className="h-3 w-3" />
                  Files
                </TabsTrigger>
                <TabsTrigger value="kv" className="gap-1.5 px-3 text-[11px]">
                  <KeyRound className="h-3 w-3" />
                  KV
                </TabsTrigger>
                <TabsTrigger value="sql" className="gap-1.5 px-3 text-[11px]">
                  <Table className="h-3 w-3" />
                  SQLite
                </TabsTrigger>
              </TabsList>
            </div>

            {/* ── FS Tab ── */}
            <TabsContent value="fs" className="flex-1 min-h-0 overflow-hidden">
              <div className="flex h-full flex-col">
                {/* Path bar */}
                <div className="flex items-center gap-2 border-b border-border/30 px-4 py-2 bg-muted/20">
                  <div className="flex items-center gap-1 min-w-0 flex-1 text-[11px]">
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => void refreshDirectory("/")}
                    >
                      /
                    </button>
                    {pathSegments.map((segment, i) => {
                      const segmentPath = "/" + pathSegments.slice(0, i + 1).join("/");
                      return (
                        <span key={segmentPath} className="flex items-center gap-1">
                          <span className="text-muted-foreground/40">/</span>
                          <button
                            type="button"
                            className={cn(
                              "hover:text-foreground transition-colors truncate",
                              i === pathSegments.length - 1 ? "text-foreground font-medium" : "text-muted-foreground",
                            )}
                            onClick={() => void refreshDirectory(segmentPath)}
                          >
                            {segment}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 rounded-md px-2 text-[10px] text-muted-foreground"
                    disabled={fsLoading || !canInspect}
                    onClick={() => void refreshDirectory()}
                  >
                    Refresh
                  </Button>
                </div>

                {fsError && (
                  <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-1.5 text-[11px] text-destructive">
                    {fsError}
                  </div>
                )}

                {/* File list + preview */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {fsLoading ? (
                    <div className="p-4 space-y-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-8 rounded-md" />
                      ))}
                    </div>
                  ) : fsEntries.length === 0 && !filePreviewPath ? (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-xs text-muted-foreground/60">Empty directory</p>
                    </div>
                  ) : (
                    <div>
                      {/* Directory listing */}
                      {fsEntries.length > 0 && (
                        <div className="divide-y divide-border/20">
                          {/* Parent directory link */}
                          {fsPath !== "/" && (
                            <button
                              type="button"
                              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent/30 transition-colors"
                              onClick={() => {
                                const parent = fsPath.split("/").slice(0, -1).join("/") || "/";
                                void refreshDirectory(parent);
                              }}
                            >
                              <Folder className="h-3.5 w-3.5 text-muted-foreground/50" />
                              <span className="text-[11px] text-muted-foreground">..</span>
                            </button>
                          )}
                          {fsEntries.map((entry) => {
                            const nextPath = joinStoragePath(fsPath, entry.name);
                            const isDir = entry.type === "directory";
                            return (
                              <button
                                key={`${entry.type}:${entry.name}`}
                                type="button"
                                className={cn(
                                  "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                                  "hover:bg-accent/30",
                                  filePreviewPath === nextPath && "bg-primary/5",
                                )}
                                onClick={() => {
                                  if (isDir) {
                                    void refreshDirectory(nextPath);
                                  } else if (entry.type === "file") {
                                    void readFilePreview(nextPath);
                                  }
                                }}
                              >
                                {isDir ? (
                                  <Folder className="h-3.5 w-3.5 shrink-0 text-terminal-amber/70" />
                                ) : (
                                  <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                                )}
                                <span className="flex-1 min-w-0 truncate text-[11px] font-medium text-foreground/90">
                                  {entry.name}
                                </span>
                                {typeof entry.size === "number" && (
                                  <span className="shrink-0 text-[10px] text-muted-foreground/60">{prettyBytes(entry.size)}</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* File preview */}
                      {filePreviewPath && (
                        <div className="border-t border-border/30">
                          <div className="flex items-center justify-between border-b border-border/20 bg-muted/20 px-4 py-1.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <File className="h-3 w-3 shrink-0 text-muted-foreground" />
                              <span className="truncate text-[11px] font-medium text-foreground/80">
                                {filePreviewPath.split("/").pop()}
                              </span>
                              {filePreviewBytes !== null && (
                                <span className="shrink-0 text-[10px] text-muted-foreground/60">
                                  {prettyBytes(filePreviewBytes)}
                                </span>
                              )}
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 shrink-0 rounded p-0 text-muted-foreground hover:text-foreground"
                              onClick={() => {
                                setFilePreviewPath(null);
                                setFilePreviewContent("");
                                setFilePreviewBytes(null);
                              }}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                          <div className="max-h-[60vh] overflow-auto p-4">
                            {filePreviewLoading ? (
                              <div className="space-y-1">
                                {Array.from({ length: 8 }).map((_, i) => (
                                  <Skeleton key={i} className="h-4 rounded" style={{ width: `${40 + Math.random() * 50}%` }} />
                                ))}
                              </div>
                            ) : isJsonLike(filePreviewContent) && tryParseJson(filePreviewContent) !== null ? (
                              <JsonPreview data={tryParseJson(filePreviewContent)} />
                            ) : (
                              <pre className="font-mono text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
                                {filePreviewContent}
                              </pre>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>

            {/* ── KV Tab ── */}
            <TabsContent value="kv" className="flex-1 min-h-0 overflow-hidden">
              <div className="flex h-full flex-col">
                {/* Search bar */}
                <div className="flex items-center gap-2 border-b border-border/30 px-4 py-2 bg-muted/20">
                  <Input
                    value={kvPrefix}
                    onChange={(event) => setKvPrefix(event.target.value)}
                    className="h-7 flex-1 rounded-md text-[11px]"
                    placeholder="Filter by key prefix..."
                  />
                  <Input
                    value={kvLimit}
                    onChange={(event) => setKvLimit(event.target.value)}
                    className="h-7 w-16 rounded-md text-[11px] text-center"
                    placeholder="100"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 rounded-md px-2 text-[10px] text-muted-foreground"
                    disabled={kvLoading || !canInspect}
                    onClick={() => void refreshKv()}
                  >
                    Refresh
                  </Button>
                </div>

                {kvError && (
                  <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-1.5 text-[11px] text-destructive">
                    {kvError}
                  </div>
                )}

                {/* KV list */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {kvLoading ? (
                    <div className="p-4 space-y-2">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 rounded-md" />
                      ))}
                    </div>
                  ) : kvItems.length === 0 ? (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-xs text-muted-foreground/60">No key-value entries</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-border/20">
                      {kvItems.map((item) => {
                        const isExpanded = expandedKvKey === item.key;
                        return (
                          <div key={item.key}>
                            <button
                              type="button"
                              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors"
                              onClick={() => setExpandedKvKey(isExpanded ? null : item.key)}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                              )}
                              <span className="flex-1 min-w-0 truncate font-mono text-[11px] font-medium text-foreground/90">
                                {item.key}
                              </span>
                              <span className="shrink-0 max-w-[40%] truncate font-mono text-[10px] text-muted-foreground/60">
                                {typeof item.value === "string"
                                  ? item.value.length > 60 ? item.value.slice(0, 60) + "..." : item.value
                                  : typeof item.value === "object"
                                    ? Array.isArray(item.value) ? `Array(${item.value.length})` : "Object"
                                    : String(item.value)}
                              </span>
                            </button>
                            {isExpanded && (
                              <div className="border-t border-border/10 bg-muted/20 px-4 py-3 pl-10">
                                <JsonPreview data={item.value} />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>

            {/* ── SQL Tab ── */}
            <TabsContent value="sql" className="flex-1 min-h-0 overflow-hidden">
              <div className="flex h-full min-h-0 flex-col">
                {/* Table chips — inline horizontal list, no sidebar */}
                {visibleSqlObjects.length > 0 && (
                  <div className="flex items-center gap-1.5 border-b border-border/30 bg-muted/15 px-4 py-1.5 overflow-x-auto shrink-0">
                    <span className="shrink-0 text-[9px] font-medium text-muted-foreground/60 uppercase tracking-wider mr-0.5">Tables</span>
                    {visibleSqlObjects.map((entry) => (
                      <button
                        key={entry.name}
                        type="button"
                        className={cn(
                          "shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                          selectedSqlObjectName === entry.name
                            ? "bg-primary/15 text-primary ring-1 ring-primary/20"
                            : "text-foreground/60 hover:bg-accent/50 hover:text-foreground",
                        )}
                        onClick={() => void openSqlObject(entry.name)}
                      >
                        {entry.name}
                      </button>
                    ))}
                    <div className="ml-auto flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 rounded px-1.5 text-[9px] text-muted-foreground/50"
                        onClick={() => setSqlShowInternalObjects((c) => !c)}
                      >
                        {sqlShowInternalObjects ? "Hide sys" : "Show sys"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 rounded px-1.5 text-[9px] text-muted-foreground/50"
                        onClick={() => void refreshSqlObjects()}
                        disabled={sqlObjectsLoading}
                      >
                        Refresh
                      </Button>
                    </div>
                  </div>
                )}

                {sqlObjectsError && (
                  <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-1 text-[10px] text-destructive">
                    {sqlObjectsError}
                  </div>
                )}

                {/* Query editor */}
                <div className="shrink-0 border-b border-border/30 bg-muted/20 p-3">
                  <textarea
                    value={sqlText}
                    onChange={(event) => {
                      setSqlText(event.target.value);
                      setSelectedSqlObjectName(null);
                    }}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        setSelectedSqlObjectName(null);
                        void runSql();
                      }
                    }}
                    className="min-h-[3.5rem] max-h-32 w-full resize-y rounded-md border border-border/40 bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    placeholder="SELECT * FROM ..."
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      className="h-6 rounded-md px-2.5 text-[10px]"
                      disabled={sqlLoading || !canInspect}
                      onClick={() => { setSelectedSqlObjectName(null); void runSql(); }}
                    >
                      <Play className="mr-1 h-2.5 w-2.5" /> Run
                    </Button>
                    <div className="h-4 w-px bg-border/40 mx-0.5" />
                    <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[10px] text-muted-foreground" onClick={() => { setSelectedSqlObjectName(null); void runSql(USER_TABLES_QUERY); }}>
                      User tables
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[10px] text-muted-foreground" onClick={() => { setSelectedSqlObjectName(null); void runSql(ALL_OBJECTS_QUERY); }}>
                      All objects
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[10px] text-muted-foreground" onClick={() => { setSelectedSqlObjectName(null); void runSql("PRAGMA table_info('kv_store')"); }}>
                      KV schema
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[10px] text-muted-foreground" onClick={() => { setSelectedSqlObjectName("kv_store"); void runSql(KV_DATA_QUERY); }}>
                      KV data
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[10px] text-muted-foreground" onClick={() => { setSelectedSqlObjectName("fs_dentry"); void runSql(FS_ENTRIES_QUERY); }}>
                      FS entries
                    </Button>
                    <div className="ml-auto flex items-center gap-1.5">
                      <span className="text-[9px] text-muted-foreground/50">Limit</span>
                      <Input
                        value={sqlMaxRows}
                        onChange={(event) => setSqlMaxRows(event.target.value)}
                        className="h-6 w-14 rounded-md text-center text-[10px]"
                      />
                    </div>
                  </div>
                  <p className="mt-1.5 text-[9px] text-muted-foreground/40">
                    Press <kbd className="rounded border border-border/40 bg-muted/50 px-1 py-0.5 text-[8px] font-mono">Cmd+Enter</kbd> to run
                  </p>
                </div>

                {sqlError && (
                  <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-1.5 text-[11px] text-destructive">
                    {sqlError}
                  </div>
                )}

                {/* Results */}
                <div className="min-h-0 flex-1 flex flex-col">
                  {sqlLoading ? (
                    <div className="flex-1 flex items-center justify-center">
                      <p className="text-xs text-muted-foreground/60">Running query...</p>
                    </div>
                  ) : sqlResult ? (
                    <>
                      {/* Results header */}
                      <div className="flex items-center justify-between border-b border-border/20 px-4 py-1.5 bg-muted/10">
                        <span className="text-[10px] text-muted-foreground">
                          {sqlResult.rowCount} row{sqlResult.rowCount === 1 ? "" : "s"}
                          {typeof sqlResult.changes === "number" ? ` · ${sqlResult.changes} change${sqlResult.changes === 1 ? "" : "s"}` : ""}
                          {sqlColumns.length > 0 ? ` · ${sqlColumns.length} col${sqlColumns.length === 1 ? "" : "s"}` : ""}
                        </span>
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant={sqlViewMode === "table" ? "default" : "ghost"}
                            size="sm"
                            className="h-5 rounded-md px-2 text-[9px]"
                            onClick={() => setSqlViewMode("table")}
                          >
                            Table
                          </Button>
                          <Button
                            variant={sqlViewMode === "json" ? "default" : "ghost"}
                            size="sm"
                            className="h-5 rounded-md px-2 text-[9px]"
                            onClick={() => setSqlViewMode("json")}
                          >
                            JSON
                          </Button>
                        </div>
                      </div>

                      {/* Results body */}
                      <div className="flex-1 min-h-0 overflow-auto">
                        {sqlViewMode === "json" ? (
                          <div className="p-4">
                            <JsonPreview data={sqlRows} />
                          </div>
                        ) : sqlRows.length === 0 ? (
                          <div className="flex h-full items-center justify-center">
                            <p className="text-xs text-muted-foreground/60">Query returned no rows</p>
                          </div>
                        ) : (
                          <table className="min-w-full border-collapse text-[11px]">
                            <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
                              <tr>
                                <th className="border-b border-r border-border/30 px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground w-10">#</th>
                                {sqlColumns.map((column) => (
                                  <th
                                    key={column}
                                    className="border-b border-r border-border/30 px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground last:border-r-0"
                                  >
                                    {column}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {sqlRows.map((row, rowIndex) => (
                                <tr key={`row-${rowIndex}`} className="hover:bg-accent/20 transition-colors">
                                  <td className="border-b border-r border-border/15 px-3 py-1.5 align-top text-muted-foreground/50 tabular-nums">{rowIndex + 1}</td>
                                  {sqlColumns.map((column) => (
                                    <td
                                      key={`row-${rowIndex}-${column}`}
                                      className="max-w-[28rem] border-b border-r border-border/15 px-3 py-1.5 align-top last:border-r-0"
                                    >
                                      <div className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-foreground/80">
                                        {row[column] === null ? (
                                          <span className="text-muted-foreground/40 italic">null</span>
                                        ) : (
                                          truncateText(sqlCellText(row[column]), 2000)
                                        )}
                                      </div>
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex items-center justify-center">
                      <p className="text-xs text-muted-foreground/60">Select a table or run a query</p>
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>
          </Tabs>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/40">
                <Database className="h-6 w-6 text-muted-foreground/30" />
              </div>
              <p className="text-xs text-muted-foreground/60">
                {visibleInstances.length === 0
                  ? "Create a storage instance to get started"
                  : "Select an instance to inspect"}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
