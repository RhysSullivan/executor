"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import {
  Database,
  HardDrive,
  KeyRound,
  Table,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { StorageDurability, StorageInstanceRecord, StorageScopeType } from "@/lib/types";
import { convexApi } from "@/lib/convex-api";
import { StorageFsTabContent, StorageKvTabContent, StorageSqlTabContent } from "./storage_panel_parts";
import { StoragePanelSidebar } from "./storage_panel_sidebar";
import {
  ALL_OBJECTS_QUERY,
  FS_ENTRIES_QUERY,
  KV_DATA_QUERY,
  SQL_OBJECTS_QUERY,
  USER_TABLES_QUERY,
  asLocalDate,
  collectSqlColumns,
  escapeSqlIdentifier,
  isInternalSqlObject,
  isJsonLike,
  sqlObjectType,
  tryParseJson,
  type CreateStorageArgs,
  type StorageDirectoryEntry,
  type StorageSqlObject,
  type StorageSqlResult,
} from "./storage_panel_shared";

function StorageInspectorSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-1.5 bg-card/20">
        <div className="space-y-1">
          <Skeleton className="h-3 w-40 rounded" />
          <Skeleton className="h-2.5 w-56 rounded" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-7 w-12 rounded-md" />
          <Skeleton className="h-7 w-12 rounded-md" />
          <Skeleton className="h-7 w-12 rounded-md" />
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-border/30 px-4 py-2 bg-muted/20">
        <Skeleton className="h-7 flex-1 rounded-md" />
        <Skeleton className="h-7 w-16 rounded-md" />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden p-4">
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full rounded-md" />
          ))}
        </div>
      </div>
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
  const parsedFilePreviewJson = useMemo(
    () => (isJsonLike(filePreviewContent) ? tryParseJson(filePreviewContent) : null),
    [filePreviewContent],
  );
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
      <StoragePanelSidebar
        visibleInstances={visibleInstances}
        selectedInstanceId={selectedInstance?.id}
        loading={loading}
        creating={creating}
        busyInstanceId={busyInstanceId}
        showCreateForm={showCreateForm}
        scopeType={scopeType}
        durability={durability}
        purpose={purpose}
        ttlHours={ttlHours}
        onToggleCreateForm={() => setShowCreateForm((current) => !current)}
        onScopeTypeChange={(next) => {
          setScopeType(next);
          if (next !== "scratch") {
            setDurability("durable");
          }
        }}
        onDurabilityChange={setDurability}
        onPurposeChange={setPurpose}
        onTtlHoursChange={setTtlHours}
        onCreate={() => {
          void submitCreate();
        }}
        onSelectInstance={setSelectedInstanceId}
        onCloseInstance={(instanceId) => {
          void onClose(instanceId);
        }}
        onDeleteInstance={(instanceId) => {
          void onDelete(instanceId);
        }}
      />

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

            <StorageFsTabContent
              canInspect={canInspect}
              fsPath={fsPath}
              pathSegments={pathSegments}
              fsEntries={fsEntries}
              fsLoading={fsLoading}
              fsError={fsError}
              filePreviewPath={filePreviewPath}
              filePreviewContent={filePreviewContent}
              filePreviewBytes={filePreviewBytes}
              filePreviewLoading={filePreviewLoading}
              parsedFilePreviewJson={parsedFilePreviewJson}
              onRefreshDirectory={refreshDirectory}
              onReadFilePreview={readFilePreview}
              onCloseFilePreview={() => {
                setFilePreviewPath(null);
                setFilePreviewContent("");
                setFilePreviewBytes(null);
              }}
            />

            <StorageKvTabContent
              canInspect={canInspect}
              kvPrefix={kvPrefix}
              kvLimit={kvLimit}
              kvItems={kvItems}
              kvLoading={kvLoading}
              kvError={kvError}
              expandedKvKey={expandedKvKey}
              onKvPrefixChange={setKvPrefix}
              onKvLimitChange={setKvLimit}
              onRefreshKv={refreshKv}
              onToggleKvKey={(key) => {
                setExpandedKvKey((current) => (current === key ? null : key));
              }}
            />

            <StorageSqlTabContent
              canInspect={canInspect}
              visibleSqlObjects={visibleSqlObjects}
              sqlShowInternalObjects={sqlShowInternalObjects}
              sqlObjectsLoading={sqlObjectsLoading}
              sqlObjectsError={sqlObjectsError}
              selectedSqlObjectName={selectedSqlObjectName}
              sqlText={sqlText}
              sqlMaxRows={sqlMaxRows}
              sqlLoading={sqlLoading}
              sqlError={sqlError}
              sqlResult={sqlResult}
              sqlRows={sqlRows}
              sqlColumns={sqlColumns}
              sqlViewMode={sqlViewMode}
              onToggleShowInternalObjects={() => setSqlShowInternalObjects((current) => !current)}
              onRefreshSqlObjects={() => {
                void refreshSqlObjects();
              }}
              onOpenSqlObject={(name) => {
                void openSqlObject(name);
              }}
              onSqlTextChange={(value) => {
                setSqlText(value);
                setSelectedSqlObjectName(null);
              }}
              onRunSql={() => {
                setSelectedSqlObjectName(null);
                void runSql();
              }}
              onRunUserTables={() => {
                setSelectedSqlObjectName(null);
                void runSql(USER_TABLES_QUERY);
              }}
              onRunAllObjects={() => {
                setSelectedSqlObjectName(null);
                void runSql(ALL_OBJECTS_QUERY);
              }}
              onRunKvSchema={() => {
                setSelectedSqlObjectName(null);
                void runSql("PRAGMA table_info('kv_store')");
              }}
              onRunKvData={() => {
                setSelectedSqlObjectName("kv_store");
                void runSql(KV_DATA_QUERY);
              }}
              onRunFsEntries={() => {
                setSelectedSqlObjectName("fs_dentry");
                void runSql(FS_ENTRIES_QUERY);
              }}
              onSqlMaxRowsChange={setSqlMaxRows}
              onSqlViewModeChange={setSqlViewMode}
            />
          </Tabs>
        ) : loading ? (
          <StorageInspectorSkeleton />
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
