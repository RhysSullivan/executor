"use client";

import { useState, useMemo, useCallback, useRef, useDeferredValue, useEffect } from "react";
import {
  AlertTriangle,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import InfiniteScroll from "react-infinite-scroll-component";
import { cn } from "@/lib/utils";
import type { ToolDescriptor, ToolSourceRecord } from "@/lib/types";
import type { SourceAuthProfile } from "@/lib/types";
import {
  autoExpandedKeysForSearch,
  filterToolsBySearch,
  filterToolsBySourceAndApproval,
  treeGroupsForView,
  type FilterApproval,
} from "./explorer-derived";
import { sourceLabel } from "@/lib/tool/source-utils";
import {
  EmptyState,
  LoadingState,
} from "./explorer-rows";
import { NavGroupNode } from "./explorer-groups";
import {
  ToolExplorerToolbar,
} from "./explorer-toolbar";
import { ToolDetailPanel, ToolDetailEmpty } from "./explorer/tool-detail";
import { SourceFormPanel } from "./explorer/source-form-panel";
import type {
  SourceDialogMeta,
  SourceAddedOptions,
} from "./add/source-dialog";
import { warningsBySourceName } from "@/lib/tools/source-helpers";

// ── Main Explorer ──

interface ToolExplorerProps {
  tools: ToolDescriptor[];
  sources: ToolSourceRecord[];
  sourceCountsOverride?: Record<string, number>;
  totalTools?: number;
  hasMoreTools?: boolean;
  loadingMoreTools?: boolean;
  onLoadMoreTools?: () => Promise<void>;
  sourceHasMoreTools?: Record<string, boolean>;
  sourceLoadingMoreTools?: Record<string, boolean>;
  onLoadMoreToolsForSource?: (source: { source: string; sourceName: string }) => Promise<void>;
  loading?: boolean;
  loadingSources?: string[];
  sourceStates?: Record<string, {
    state: "queued" | "loading" | "indexing" | "ready" | "failed";
    toolCount: number;
    processedTools?: number;
    message?: string;
    error?: string;
  }>;
  onLoadToolDetails?: (toolPaths: string[]) => Promise<Record<string, Pick<ToolDescriptor, "path" | "description" | "display" | "typing">>>;
  warnings?: string[];
  activeSource: string | null;
  searchValue: string;
  filterApprovalValue: FilterApproval;
  focusedToolPathValue: string | null;
  focusedSourceNameValue: string | null;
  onSearchValueChange: (value: string) => void;
  onFilterApprovalValueChange: (filter: FilterApproval) => void;
  onFocusedToolPathChange: (toolPath: string | null) => void;
  onFocusedSourceNameChange: (sourceName: string | null) => void;
  onSourceAdded?: (source: ToolSourceRecord, options?: SourceAddedOptions) => void;
  sourceDialogMeta?: Record<string, SourceDialogMeta>;
  sourceAuthProfiles?: Record<string, SourceAuthProfile>;
  existingSourceNames?: Set<string>;
  onSourceDeleted?: (sourceName: string) => void;
  onRegenerate?: () => void;
  isRebuilding?: boolean;
  inventoryState?: "initializing" | "ready" | "rebuilding" | "failed";
  inventoryError?: string;
}

export function ToolExplorer({
  tools,
  sources,
  sourceCountsOverride,
  hasMoreTools = false,
  loadingMoreTools = false,
  onLoadMoreTools,
  sourceLoadingMoreTools,
  loading = false,
  loadingSources = [],
  sourceStates = {},
  onLoadToolDetails,
  warnings = [],
  activeSource,
  searchValue,
  filterApprovalValue,
  focusedToolPathValue,
  focusedSourceNameValue,
  onSearchValueChange,
  onFilterApprovalValueChange,
  onFocusedToolPathChange,
  onFocusedSourceNameChange,
  onSourceAdded,
  sourceDialogMeta,
  sourceAuthProfiles,
  existingSourceNames,
  onSourceDeleted,
  onRegenerate,
  isRebuilding = false,
  inventoryState,
  inventoryError,
}: ToolExplorerProps) {
  const [toolDetailsByPath, setToolDetailsByPath] = useState<Record<string, Pick<ToolDescriptor, "path" | "description" | "display" | "typing">>>({});
  const [loadingDetailPaths, setLoadingDetailPaths] = useState<Set<string>>(new Set());
  // "new" = add source form, ToolSourceRecord = edit/view existing source, null = no source panel
  const [formSource, setFormSource] = useState<"new" | ToolSourceRecord | null>(null);
  const toolListRef = useRef<HTMLDivElement>(null);
  const toolListScrollContainerId = "tool-explorer-toollist-scroll";
  const resolvedActiveSource = activeSource;
  const searchInput = searchValue;
  const filterApproval = filterApprovalValue;
  const focusedToolPath = focusedToolPathValue;
  const focusedSourceName = focusedSourceNameValue;
  const search = useDeferredValue(searchInput);

  const setSearchInput = useCallback((value: string) => {
    onSearchValueChange(value);
  }, [onSearchValueChange]);

  const setFilterApproval = useCallback((nextFilter: FilterApproval) => {
    onFilterApprovalValueChange(nextFilter);
  }, [onFilterApprovalValueChange]);

  const setFocusedToolPath = useCallback((toolPath: string | null) => {
    onFocusedToolPathChange(toolPath);
  }, [onFocusedToolPathChange]);

  const setFocusedSourceName = useCallback((sourceName: string | null) => {
    onFocusedSourceNameChange(sourceName);
  }, [onFocusedSourceNameChange]);

  const setSourceFocusState = useCallback((sourceName: string | null, sourceRecord: ToolSourceRecord | null) => {
    setFocusedSourceName(sourceName);
    setFormSource(sourceRecord);
    setFocusedToolPath(null);
  }, [setFocusedSourceName, setFocusedToolPath]);

  const hydratedTools = useMemo(() => {
    if (Object.keys(toolDetailsByPath).length === 0) {
      return tools;
    }

    return tools.map((tool) => {
      const override = toolDetailsByPath[tool.path];
      return override ? { ...tool, ...override } : tool;
    });
  }, [tools, toolDetailsByPath]);

  const filteredTools = useMemo(() => {
    return filterToolsBySourceAndApproval(
      hydratedTools,
      resolvedActiveSource,
      filterApproval,
    );
  }, [hydratedTools, resolvedActiveSource, filterApproval]);

  const loadingSourceSet = useMemo(() => {
    const set = new Set(loadingSources);
    for (const [sourceName, isLoading] of Object.entries(sourceLoadingMoreTools ?? {})) {
      if (isLoading) {
        set.add(sourceName);
      }
    }

    if (set.size === 0 && loading && searchInput.length === 0 && filteredTools.length === 0) {
      if (resolvedActiveSource) {
        set.add(resolvedActiveSource);
      } else {
        for (const source of sources) {
          if (source.enabled) {
            set.add(source.name);
          }
        }
      }
    }

    return set;
  }, [filteredTools.length, loading, loadingSources, resolvedActiveSource, searchInput.length, sourceLoadingMoreTools, sources]);

  const sourceCounts = useMemo(() => {
    if (sourceCountsOverride) {
      return sourceCountsOverride;
    }

    const counts: Record<string, number> = {};

    for (const tool of hydratedTools) {
      const sourceName = sourceLabel(tool.source);
      counts[sourceName] = (counts[sourceName] ?? 0) + 1;
    }

    return counts;
  }, [hydratedTools, sourceCountsOverride]);

  const visibleSources = useMemo(() => {
    const enabledByName = new Map<string, ToolSourceRecord>();
    for (const source of sources) {
      if (source.enabled) {
        enabledByName.set(source.name, source);
      }
    }

    return Array.from(enabledByName.values());
  }, [sources]);

  const searchedTools = useMemo(() => {
    return filterToolsBySearch(filteredTools, search);
  }, [filteredTools, search]);

  const sidebarExistingSourceNames = useMemo(() => {
    return existingSourceNames ?? new Set(visibleSources.map((source) => source.name));
  }, [existingSourceNames, visibleSources]);

  const warningsBySrc = useMemo(() => warningsBySourceName(warnings), [warnings]);

  const sourceByName = useMemo(() => {
    const map = new Map<string, ToolSourceRecord>();
    for (const source of visibleSources) {
      map.set(source.name, source);
    }
    return map;
  }, [visibleSources]);

  useEffect(() => {
    if (formSource === "new") {
      return;
    }

    const resolvedSource = focusedSourceNameValue
      ? sourceByName.get(focusedSourceNameValue) ?? null
      : null;

    setFormSource(resolvedSource);
    if (focusedSourceNameValue) {
      setFocusedToolPath(null);
    }
  }, [focusedSourceNameValue, formSource, sourceByName, setFocusedToolPath]);

  const maybeLoadToolDetails = useCallback(async (tool: ToolDescriptor, expanded: boolean) => {
    if (!expanded || !onLoadToolDetails) {
      return;
    }

    if (toolDetailsByPath[tool.path]) {
      return;
    }

    if (loadingDetailPaths.has(tool.path)) {
      return;
    }

    setLoadingDetailPaths((prev) => {
      const next = new Set(prev);
      next.add(tool.path);
      return next;
    });

    try {
      const loaded = await onLoadToolDetails([tool.path]);
      const detail = loaded[tool.path];
      if (detail) {
        setToolDetailsByPath((prev) => ({ ...prev, [tool.path]: detail }));
      }
    } finally {
      setLoadingDetailPaths((prev) => {
        const next = new Set(prev);
        next.delete(tool.path);
        return next;
      });
    }
  }, [loadingDetailPaths, onLoadToolDetails, toolDetailsByPath]);

  // ── Focus tool handler ──────────────────────────────────────────────────

  const handleFocusTool = useCallback((tool: ToolDescriptor) => {
    setFocusedToolPath(tool.path);
    setFocusedSourceName(null);
    setFormSource(null);
    void maybeLoadToolDetails(tool, true);
  }, [maybeLoadToolDetails, setFocusedSourceName, setFocusedToolPath]);

  const handleSourceClick = useCallback((sourceName: string) => {
    const key = `source:${sourceName}`;
    const wasFocused = focusedSourceName === sourceName;
    const source = sourceByName.get(sourceName);

    if (wasFocused) {
      setSourceFocusState(null, null);
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }

    setSourceFocusState(sourceName, source ?? null);
    // Ensure the source group is expanded
    setExpandedKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [focusedSourceName, setSourceFocusState, sourceByName]);

  const handleAddSource = useCallback(() => {
    setSourceFocusState(null, null);
    setFormSource("new");
  }, [setSourceFocusState]);

  const handleSourceFormClose = useCallback(() => {
    setFormSource(null);
  }, []);

  const handleSourceFormAdded = useCallback((
    source: ToolSourceRecord,
    options?: SourceAddedOptions,
  ) => {
    onSourceAdded?.(source, options);
    setSourceFocusState(source.name, source);
    const key = `source:${source.name}`;
    setExpandedKeys((prev) => {
      if (prev.has(key)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [onSourceAdded, setSourceFocusState]);

  const focusedTool = useMemo(() => {
    if (!focusedToolPath) return null;
    return hydratedTools.find((t) => t.path === focusedToolPath) ?? null;
  }, [focusedToolPath, hydratedTools]);

  const selectedSourceState = resolvedActiveSource ? sourceStates[resolvedActiveSource] : undefined;
  const selectedSourceWarnings = resolvedActiveSource ? (warningsBySrc[resolvedActiveSource] ?? []) : [];
  const selectedSourceToolCount = resolvedActiveSource
    ? (sourceCounts[resolvedActiveSource] ?? selectedSourceState?.toolCount ?? 0)
    : 0;
  const selectedSourceLoading = selectedSourceState
    ? selectedSourceState.state === "queued"
      || selectedSourceState.state === "loading"
      || selectedSourceState.state === "indexing"
    : false;
  const formSourceProgress = formSource && formSource !== "new"
    ? sourceStates[formSource.name]
    : undefined;

  useEffect(() => {
    if (formSource !== null && focusedToolPath) {
      setFocusedToolPath(null);
    }
  }, [focusedToolPath, formSource, setFocusedToolPath]);

  // Auto-focus first tool when tools arrive
  useEffect(() => {
    if (formSource === null && !focusedToolPath && !focusedSourceName && searchedTools.length > 0) {
      const [first] = searchedTools;
      if (first) {
        setFocusedToolPath(first.path);
        void maybeLoadToolDetails(first, true);
      }
    }
  }, [focusedSourceName, focusedToolPath, formSource, maybeLoadToolDetails, searchedTools, setFocusedToolPath]);

  useEffect(() => {
    if (!focusedToolPath || searchedTools.length === 0) {
      return;
    }

    if (!searchedTools.some((tool) => tool.path === focusedToolPath)) {
      setFocusedToolPath(null);
    }
  }, [focusedToolPath, searchedTools, setFocusedToolPath]);

  const canInfiniteLoad = searchInput.length === 0 && hasMoreTools;
  const awaitingInitialInventory =
    searchInput.length === 0
    && filteredTools.length === 0
    && (loading || loadingSources.length > 0);

  // ── Tree view data ──────────────────────────────────────────────────────

  const treeGroups = useMemo(() => {
    return treeGroupsForView(searchedTools, "tree", "source", {
      loadingSources,
      sourceRecords: visibleSources,
      sourceCounts,
      activeSource: resolvedActiveSource,
    });
  }, [searchedTools, loadingSources, visibleSources, sourceCounts, resolvedActiveSource]);

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  // Auto-expand all groups when search is active
  const searchAutoExpanded = useMemo(
    () => autoExpandedKeysForSearch(search, searchedTools, "tree"),
    [search, searchedTools],
  );

  const effectiveExpandedKeys = searchAutoExpanded ?? expandedKeys;


  const toggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const inventoryStatus = useMemo(() => {
    const loadingSourceCount = loadingSourceSet.size;
    const sourceStateEntries = Object.entries(sourceStates);
    const totalSourceCount = sourceStateEntries.length;
    const readySourceCount = sourceStateEntries.filter(([, state]) => state.state === "ready").length;
    const failedSourceCount = sourceStateEntries.filter(([, state]) => state.state === "failed").length;

    if (!inventoryState) {
      return { label: "Checking...", tone: "muted" as const };
    }
    if (inventoryState === "initializing") {
      const progress = totalSourceCount > 0
        ? `${readySourceCount}/${totalSourceCount}`
        : `${loadingSourceCount}`;
      return {
        label: `Building ${progress}`,
        tone: "loading" as const,
      };
    }
    if (inventoryState === "rebuilding") {
      const progress = totalSourceCount > 0
        ? `${readySourceCount}/${totalSourceCount}`
        : `${loadingSourceCount}`;
      return {
        label: `Refreshing ${progress}`,
        tone: "loading" as const,
      };
    }
    if (inventoryState === "failed") {
      return {
        label: inventoryError
          ? `Failed: ${inventoryError}`
          : failedSourceCount > 0
            ? `Failed (${failedSourceCount} sources)`
            : "Failed",
        tone: "error" as const,
      };
    }
    return {
      label: totalSourceCount > 0 ? `Up to date (${readySourceCount}/${totalSourceCount})` : "Up to date",
      tone: "muted" as const,
    };
  }, [inventoryError, inventoryState, loadingSourceSet.size, sourceStates]);

  const regenerationInProgress = isRebuilding;
  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 max-h-screen overflow-hidden">
      {/* ── Left panel: search + tree ────────────────────────────────────── */}
      <div className="flex h-full max-h-screen flex-col w-72 lg:w-80 xl:w-[22rem] shrink-0 border-r border-border/40">
        {/* Header: inventory status + regenerate */}
        <div className="shrink-0 px-3 pt-2 pb-1.5 border-b border-border/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50">
                Tools
              </p>
              <span
                className={cn(
                  "text-[9px] font-mono flex items-center gap-0.5",
                  inventoryStatus.tone === "loading"
                    ? "text-terminal-amber/80"
                    : inventoryStatus.tone === "error"
                      ? "text-terminal-red/80"
                      : "text-muted-foreground/40",
                )}
                title={inventoryStatus.label}
              >
                {inventoryStatus.tone === "loading" ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : inventoryStatus.tone === "error" ? (
                  <AlertTriangle className="h-2.5 w-2.5" />
                ) : null}
                {inventoryStatus.label}
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              {onRegenerate ? (
                <button
                  onClick={onRegenerate}
                  disabled={regenerationInProgress}
                  title={
                    regenerationInProgress
                      ? "Rebuilding..."
                      : "Regenerate inventory"
                  }
                  className={cn(
                    "p-0.5 rounded transition-colors",
                    regenerationInProgress
                      ? "text-terminal-amber cursor-not-allowed"
                      : "text-muted-foreground/30 hover:text-muted-foreground/60",
                  )}
                >
                  <RefreshCcw className={cn("h-3 w-3", regenerationInProgress && "animate-spin")} />
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Search toolbar (own row) */}
        <div className="shrink-0 px-2 py-2 border-b border-border/20">
          <ToolExplorerToolbar
            search={searchInput}
            filteredToolCount={filteredTools.length}
            hasSearch={searchInput.length > 0}
            resultCount={searchedTools.length}
            loadingInventory={awaitingInitialInventory}
            filterApproval={filterApproval}
            activeSource={resolvedActiveSource}
            onSearchChange={setSearchInput}
            onClearSearch={() => setSearchInput("")}
            onFilterApprovalChange={setFilterApproval}
            onAddSource={handleAddSource}
          />
        </div>

        {/* Source-grouped tree */}
        <div className="flex-1 min-h-0">
          {searchedTools.length === 0 && loadingSourceSet.size === 0 ? (
            <div className="h-full overflow-y-auto">
              {awaitingInitialInventory ? (
                <LoadingState />
              ) : (
                <EmptyState hasSearch={!!search} onClearSearch={() => setSearchInput("")} />
              )}
            </div>
          ) : (
            <div
              ref={toolListRef}
              id={toolListScrollContainerId}
              className="h-full overflow-y-auto"
            >
              <InfiniteScroll
                dataLength={searchedTools.length}
                next={() => {
                  void onLoadMoreTools?.();
                }}
                hasMore={canInfiniteLoad}
                scrollableTarget={toolListScrollContainerId}
                style={{ overflow: "visible" }}
                loader={
                  <div className="px-2 py-2 text-[10px] text-muted-foreground/60">
                    {loadingMoreTools ? "Loading..." : ""}
                  </div>
                }
              >
                <div className="py-0.5">
                  {treeGroups.map((group) => (
                    <NavGroupNode
                      key={group.key}
                      group={group}
                      depth={0}
                      expandedKeys={effectiveExpandedKeys}
                      onToggle={toggleExpand}
                      focusedPath={focusedToolPath}
                      focusedSource={focusedSourceName}
                      onFocusTool={handleFocusTool}
                      onSourceClick={handleSourceClick}
                      source={sourceByName.get(group.label) ?? undefined}
                      sourceState={sourceStates[group.label]}
                    />
                  ))}

                </div>
              </InfiniteScroll>
            </div>
          )}
        </div>
      </div>

      {/* ── Detail panel (right, main content) ─────────────────────────────── */}
      <div className="flex-1 min-w-0 max-h-screen overflow-y-auto bg-background/50">
        {formSource !== null ? (
          <SourceFormPanel
            existingSourceNames={sidebarExistingSourceNames}
            sourceToEdit={formSource === "new" ? undefined : formSource}
            sourceProgress={formSourceProgress}
            sourceDialogMeta={formSource !== "new" ? sourceDialogMeta?.[formSource.name] : undefined}
            sourceAuthProfiles={sourceAuthProfiles}
            onSourceAdded={handleSourceFormAdded}
            onSourceDeleted={onSourceDeleted}
            onClose={handleSourceFormClose}
          />
        ) : focusedTool ? (
          <ToolDetailPanel
            tool={focusedTool}
            loading={loadingDetailPaths.has(focusedTool.path)}
          />
        ) : resolvedActiveSource ? (
          <div className="h-full p-6">
            <div className="mx-auto w-full max-w-3xl space-y-4 rounded-xl border border-border/60 bg-card/40 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground/70">Selected source</p>
                  <h2 className="mt-1 text-xl font-semibold text-foreground">{resolvedActiveSource}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {selectedSourceToolCount} tool{selectedSourceToolCount === 1 ? "" : "s"}
                  </p>
                </div>
                <div className={cn(
                  "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs",
                  selectedSourceState?.state === "failed"
                    ? "border-terminal-red/40 bg-terminal-red/5 text-terminal-red"
                    : selectedSourceLoading
                      ? "border-terminal-amber/40 bg-terminal-amber/5 text-terminal-amber"
                      : "border-border/60 bg-muted/30 text-muted-foreground",
                )}>
                  {selectedSourceState?.state === "failed" ? (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  ) : selectedSourceLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  <span>
                    {selectedSourceState?.state === "failed"
                      ? "Failed"
                      : selectedSourceLoading
                        ? "Loading"
                        : "Ready"}
                  </span>
                </div>
              </div>

              {selectedSourceState?.message ? (
                <p className="text-sm text-muted-foreground">{selectedSourceState.message}</p>
              ) : null}

              {selectedSourceState?.state === "indexing" && typeof selectedSourceState.processedTools === "number" && selectedSourceState.toolCount > 0 ? (
                <div className="space-y-1.5">
                  <div className="h-1.5 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-terminal-amber transition-[width] duration-300"
                      style={{ width: `${Math.max(2, Math.min(100, (selectedSourceState.processedTools / selectedSourceState.toolCount) * 100))}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground/80 tabular-nums">
                    Indexed {selectedSourceState.processedTools}/{selectedSourceState.toolCount}
                  </p>
                </div>
              ) : null}

              {selectedSourceState?.error ? (
                <p className="rounded-md border border-terminal-red/30 bg-terminal-red/5 px-3 py-2 text-sm text-terminal-red">
                  {selectedSourceState.error}
                </p>
              ) : null}

              {selectedSourceWarnings.length > 0 ? (
                <div className="rounded-md border border-terminal-amber/30 bg-terminal-amber/5 px-3 py-2">
                  <p className="text-xs font-medium text-terminal-amber/90">
                    {selectedSourceWarnings.length} warning{selectedSourceWarnings.length !== 1 ? "s" : ""}
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {selectedSourceWarnings.map((warning, index) => (
                      <p key={`${resolvedActiveSource}-${index}`} className="text-xs leading-4 text-muted-foreground">
                        {warning}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <ToolDetailEmpty />
        )}
      </div>
    </div>
  );
}
