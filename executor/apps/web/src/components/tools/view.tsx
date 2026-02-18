"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryStates } from "nuqs";
import { useLocation } from "@/lib/router";
import { Skeleton } from "@/components/ui/skeleton";
import { ToolExplorer } from "@/components/tools/explorer";
import { TaskComposer } from "@/components/tasks/task-composer";

import { CredentialsPanel } from "@/components/tools/credentials";
import { ConnectionFormDialog } from "@/components/tools/connection/form-dialog";
import { PoliciesPanel } from "@/components/tools/policies";
import { useSession } from "@/lib/session-context";
import { useWorkspaceTools } from "@/hooks/use/workspace-tools";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { convexApi } from "@/lib/convex-api";
import type {
  ToolSourceRecord,
  CredentialRecord,
} from "@/lib/types";
import {
  parseWarningSourceName,
  warningsBySourceName,
} from "@/lib/tools/source-helpers";
import { sourceLabel } from "@/lib/tool/source-utils";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";
import type { SourceDialogMeta } from "@/components/tools/add/source-dialog";
import type { FilterApproval } from "@/components/tools/explorer-derived";
import { toolsCatalogQueryParsers } from "@/lib/url-state/tools";

type ToolsTab = "catalog" | "connections" | "policies" | "editor";
const INVENTORY_REGENERATION_TOAST_ID = "tool-inventory-regeneration";

function parseToolsTab(pathname: string): ToolsTab {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments.at(-1);

  if (last === "catalog") {
    return "catalog";
  }
  if (last === "connections" || last === "credentials") {
    return "connections";
  }
  if (last === "policies") {
    return "policies";
  }
  if (last === "editor" || last === "runner") {
    return "editor";
  }

  return "catalog";
}

function mapEmptyQueryValueToNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

// ── Tools View ──

export function ToolsView() {
  const location = useLocation();
  const { context, loading: sessionLoading } = useSession();
  const activeTab = useMemo(() => parseToolsTab(location.pathname), [location.pathname]);
  const [catalogQueryState, setCatalogQueryState] = useQueryStates(toolsCatalogQueryParsers, {
    history: "replace",
  });

  const catalogSearchValue = catalogQueryState.q;
  const catalogFilterValue = catalogQueryState.approval as FilterApproval;
  const catalogSourceValue = useMemo(() => mapEmptyQueryValueToNull(catalogQueryState.source), [catalogQueryState.source]);
  const catalogActiveToolPath = mapEmptyQueryValueToNull(catalogQueryState.tool);
  const catalogSelectedToolPaths = useMemo(
    () => catalogQueryState.selected ?? [],
    [catalogQueryState.selected],
  );
  const catalogFocusedSourceName = useMemo(
    () => mapEmptyQueryValueToNull(catalogQueryState.sourcePanel),
    [catalogQueryState.sourcePanel],
  );
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionDialogEditing, setConnectionDialogEditing] = useState<CredentialRecord | null>(null);
  const [connectionDialogSourceKey, setConnectionDialogSourceKey] = useState<string | null>(null);
  const [regenerationInFlight, setRegenerationInFlight] = useState(false);
  const lastRegenerationToastMessageRef = useRef<string | null>(null);

  const sources = useQuery(
    convexApi.workspace.listToolSources,
    workspaceQueryArgs(context),
  );
  const sourceCacheRef = useRef<{ workspaceId: string | null; items: ToolSourceRecord[] }>({
    workspaceId: null,
    items: [],
  });
  const workspaceId = context?.workspaceId ?? null;
  if (sourceCacheRef.current.workspaceId !== workspaceId) {
    sourceCacheRef.current = {
      workspaceId,
      items: [],
    };
  }
  if (sources !== undefined) {
    sourceCacheRef.current.items = sources;
  }
  const serverSourceItems = useMemo<ToolSourceRecord[]>(
    () => sources ?? sourceCacheRef.current.items,
    [sources],
  );
  const sourcesLoading = !!context && sources === undefined && serverSourceItems.length === 0;

  const {
    tools,
    warnings,
    sourceQuality,
    sourceAuthProfiles,
    inventoryStatus,
    loadingSources,
    loadingTools,
    refreshingTools,
    hasMoreTools,
    loadingMoreTools,
    loadMoreTools,
    sourceHasMoreTools,
    sourceLoadingMoreTools,
    loadMoreToolsForSource,
    rebuildInventoryNow,
    loadToolDetails,
  } = useWorkspaceTools(context ?? null, {
    includeDetails: false,
  });

  const showRegenerationToast = useCallback((kind: "loading" | "success" | "error", message: string) => {
    const dedupeKey = `${kind}:${message}`;
    if (lastRegenerationToastMessageRef.current === dedupeKey) {
      return;
    }
    lastRegenerationToastMessageRef.current = dedupeKey;

    if (kind === "loading") {
      toast.loading(message, {
        id: INVENTORY_REGENERATION_TOAST_ID,
        duration: Number.POSITIVE_INFINITY,
      });
      return;
    }

    if (kind === "success") {
      toast.success(message, { id: INVENTORY_REGENERATION_TOAST_ID });
      return;
    }

    toast.error(message, { id: INVENTORY_REGENERATION_TOAST_ID });
  }, []);

  const sourceItems = serverSourceItems;

  const visibleSourceNames = useMemo(
    () => new Set(sourceItems.map((source) => source.name)),
    [sourceItems],
  );

  const visibleTools = useMemo(
    () => tools.filter((tool) => {
      const sourceName = sourceLabel(tool.source);
      return sourceName === "system" || sourceName === "built-in" || visibleSourceNames.has(sourceName);
    }),
    [tools, visibleSourceNames],
  );

  const toolSourceNames = useMemo(
    () => {
      const names = new Set<string>(["system", "built-in"]);
      for (const source of sourceItems) {
        names.add(source.name);
      }
      for (const tool of visibleTools) {
        const sourceName = sourceLabel(tool.source);
        if (sourceName === "system" || sourceName === "built-in") {
          names.add(sourceName);
        }
      }
      return names;
    },
    [sourceItems, visibleTools],
  );

  const credentials = useQuery(
    convexApi.workspace.listCredentials,
    workspaceQueryArgs(context),
  );
  const credentialItems: CredentialRecord[] = credentials ?? [];
  const credentialsLoading = !!context && credentials === undefined;

  const globalWarnings = useMemo(
    () => warnings.filter((warning) => !parseWarningSourceName(warning)),
    [warnings],
  );
  const hasGlobalInventoryWarning = useMemo(
    () => globalWarnings.some((warning) =>
      warning.includes("Tool inventory is still loading")
      || warning.includes("showing previous results while refreshing"),
    ),
    [globalWarnings],
  );

  // Merge loading sources with global inventory warnings
  const mergedLoadingSources = useMemo(() => {
    const combined = new Set<string>();

    for (const sourceName of loadingSources) {
      if (typeof sourceName === "string") {
        combined.add(sourceName);
      }
    }

    if (hasGlobalInventoryWarning) {
      for (const source of sourceItems) {
        if (toolSourceNames.has(source.name)) {
          continue;
        }
        combined.add(source.name);
      }
    }

    return Array.from(combined);
  }, [hasGlobalInventoryWarning, loadingSources, sourceItems, toolSourceNames]);

  const visibleLoadingSources = useMemo(
    () => mergedLoadingSources.filter((name) =>
      visibleSourceNames.has(name) || name === "system" || name === "built-in"
    ),
    [mergedLoadingSources, visibleSourceNames],
  );

  const visibleSourceCounts = useMemo(() => {
    const sourceCounts = inventoryStatus?.sourceToolCounts;
    if (!sourceCounts) {
      return undefined;
    }

    const counts: Record<string, number> = {};
    for (const [sourceName, rawCount] of Object.entries(sourceCounts)) {
      const count =
        typeof rawCount === "number"
          ? rawCount
          : typeof rawCount === "string"
            ? Number(rawCount)
            : Number.NaN;
      if (!Number.isFinite(count)) {
        continue;
      }
      if (visibleSourceNames.has(sourceName) || sourceName === "system" || sourceName === "built-in") {
        counts[sourceName] = count;
      }
    }

    return counts;
  }, [inventoryStatus?.sourceToolCounts, visibleSourceNames]);

  const existingSourceNames = useMemo(() => new Set(sourceItems.map((source) => source.name)), [sourceItems]);
  const warningsBySource = useMemo(() => warningsBySourceName(warnings), [warnings]);

  const sourceDialogMeta = useMemo(() => {
    const bySource: Record<string, SourceDialogMeta> = {};
    for (const source of sourceItems) {
      const label = `${source.type}:${source.name}`;
      bySource[source.name] = {
        quality: source.type === "openapi" ? sourceQuality[label] : undefined,
        qualityLoading: source.type === "openapi" && !sourceQuality[label] && refreshingTools,
        warnings: warningsBySource[source.name] ?? [],
      };
    }
    return bySource;
  }, [sourceItems, sourceQuality, refreshingTools, warningsBySource]);
  const activeSource = catalogSourceValue
    && (sourceItems.some((source) => source.name === catalogSourceValue) || toolSourceNames.has(catalogSourceValue))
      ? catalogSourceValue
      : null;

  const syncSourceToUrl = useCallback((sourceName: string) => {
    void setCatalogQueryState({
      source: sourceName,
    }, {
      history: "replace",
    });
  }, [setCatalogQueryState]);

  const handleSourceDeleted = useCallback((sourceName: string) => {
    syncSourceToUrl(activeSource === sourceName ? "" : (activeSource ?? ""));
  }, [activeSource, syncSourceToUrl]);

  const setCatalogSearch = useCallback((search: string) => {
    void setCatalogQueryState({
      q: search,
    }, {
      history: "replace",
    });
  }, [setCatalogQueryState]);

  const setCatalogApprovalFilter = useCallback((filterApproval: FilterApproval) => {
    void setCatalogQueryState({
      approval: filterApproval,
    }, {
      history: "replace",
    });
  }, [setCatalogQueryState]);

  const setCatalogActiveToolPath = useCallback((toolPath: string | null) => {
    void setCatalogQueryState({
      tool: toolPath ?? "",
    }, {
      history: "replace",
    });
  }, [setCatalogQueryState]);

  const setCatalogSelectedToolPaths = useCallback((toolPaths: string[]) => {
    void setCatalogQueryState({
      selected: toolPaths,
    }, {
      history: "replace",
    });
  }, [setCatalogQueryState]);

  const setCatalogFocusedSourceName = useCallback((sourceName: string | null) => {
    void setCatalogQueryState({
      sourcePanel: sourceName ?? "",
    }, {
      history: "replace",
    });
  }, [setCatalogQueryState]);

  const handleRegenerateInventory = useCallback(async () => {
    if (!context || regenerationInFlight) {
      return;
    }

    lastRegenerationToastMessageRef.current = null;
    setRegenerationInFlight(true);
    showRegenerationToast("loading", "Refreshing inventory...");

    try {
      await rebuildInventoryNow();
      showRegenerationToast("success", "Tool inventory refreshed");
    } catch (error) {
      showRegenerationToast(
        "error",
        error instanceof Error ? error.message : "Failed to refresh tool inventory",
      );
    } finally {
      setRegenerationInFlight(false);
    }
  }, [context, rebuildInventoryNow, regenerationInFlight, showRegenerationToast]);
  const openConnectionCreate = (sourceKey?: string) => {
    setConnectionDialogEditing(null);
    setConnectionDialogSourceKey(sourceKey ?? null);
    setConnectionDialogOpen(true);
  };

  const openConnectionEdit = (credential: CredentialRecord) => {
    setConnectionDialogEditing(credential);
    setConnectionDialogSourceKey(null);
    setConnectionDialogOpen(true);
  };

  const handleConnectionDialogOpenChange = (open: boolean) => {
    setConnectionDialogOpen(open);
    if (!open) {
      setConnectionDialogEditing(null);
      setConnectionDialogSourceKey(null);
    }
  };

  if (sessionLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-1 min-h-0 rounded-lg border border-border/50 p-4">
          <div className="flex h-full w-full">
            {/* Sidebar skeleton */}
            <div className="w-52 shrink-0 border-r border-border/30 pr-3 space-y-2 hidden lg:block">
              <Skeleton className="h-3 w-16 mb-3" />
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full rounded-md" />
              ))}
            </div>
            {/* Main content skeleton */}
            <div className="flex-1 pl-3 space-y-1">
              <Skeleton className="h-8 w-full rounded-md mb-2" />
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-3 w-3" />
                  <Skeleton className="h-3.5" style={{ width: `${100 + i * 25}px` }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {activeTab === "editor" ? (
        <div className="flex-1 min-h-0">
          <TaskComposer />
        </div>
      ) : null}

      {activeTab === "catalog" ? (
        <div className="flex-1 min-h-0">
          <ToolExplorer
            tools={visibleTools}
            sources={sourceItems}
            loadingSources={visibleLoadingSources}
            sourceCountsOverride={visibleSourceCounts}
            totalTools={visibleTools.length}
            hasMoreTools={hasMoreTools}
            loadingMoreTools={loadingMoreTools}
            onLoadMoreTools={loadMoreTools}
            sourceHasMoreTools={sourceHasMoreTools}
            sourceLoadingMoreTools={sourceLoadingMoreTools}
            onLoadMoreToolsForSource={loadMoreToolsForSource}
            loading={loadingTools}
            sourceDialogMeta={sourceDialogMeta}
            sourceAuthProfiles={sourceAuthProfiles}
            existingSourceNames={existingSourceNames}
            onSourceDeleted={handleSourceDeleted}
            onLoadToolDetails={loadToolDetails}
            warnings={warnings}
            activeSource={activeSource}
            searchValue={catalogSearchValue}
            filterApprovalValue={catalogFilterValue}
            focusedToolPathValue={catalogActiveToolPath}
            selectedToolPathsValue={catalogSelectedToolPaths}
            focusedSourceNameValue={catalogFocusedSourceName}
            onSearchValueChange={setCatalogSearch}
            onFilterApprovalValueChange={setCatalogApprovalFilter}
            onFocusedToolPathChange={setCatalogActiveToolPath}
            onSelectedToolPathsChange={setCatalogSelectedToolPaths}
            onFocusedSourceNameChange={setCatalogFocusedSourceName}
            onRegenerate={handleRegenerateInventory}
            inventoryState={inventoryStatus?.state}
            inventoryError={inventoryStatus?.error}
            isRebuilding={
              regenerationInFlight
              || inventoryStatus?.state === "rebuilding"
              || inventoryStatus?.state === "initializing"
            }
          />
        </div>
      ) : null}

      {activeTab === "connections" ? (
        <div className="flex-1 min-h-0">
          <CredentialsPanel
            sources={sourceItems}
            credentials={credentialItems}
            loading={credentialsLoading || sourcesLoading}
            onCreateConnection={openConnectionCreate}
            onEditConnection={openConnectionEdit}
          />
        </div>
      ) : null}

      {activeTab === "policies" ? (
        <div className="flex-1 min-h-0">
          <PoliciesPanel
            tools={visibleTools}
            loadingTools={loadingTools}
          />
        </div>
      ) : null}

      <ConnectionFormDialog
        open={connectionDialogOpen}
        onOpenChange={handleConnectionDialogOpenChange}
        editing={connectionDialogEditing}
        initialSourceKey={connectionDialogSourceKey}
        sources={sourceItems}
        credentials={credentialItems}
        sourceAuthProfiles={sourceAuthProfiles}
        loadingSourceNames={visibleLoadingSources}
      />
    </div>
  );
}
