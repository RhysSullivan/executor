"use client";

import { type ReactNode, useState, useMemo, useCallback, useRef, useDeferredValue } from "react";
import InfiniteScroll from "react-infinite-scroll-component";
import { cn } from "@/lib/utils";
import {
  collectGroupKeys,
} from "@/lib/tool/explorer-grouping";
import type { SourceAuthProfile, ToolDescriptor, ToolSourceRecord } from "@/lib/types";
import { findToolsInGroupByKey } from "./explorer-helpers";
import {
  autoExpandedKeysForSearch,
  countSelectedTools,
  expandedKeysForSource,
  filterToolsBySearch,
  filterToolsBySourceAndApproval,
  flatToolsForView,
  sourceOptionsFromTools,
  treeGroupsForView,
  type FilterApproval,
} from "./explorer-derived";
import { sourceLabel } from "@/lib/tool/source-utils";
import {
  EmptyState,
  LoadingState,
  VirtualFlatList,
} from "./explorer-rows";
import { GroupNode, SourceSidebar } from "./explorer-groups";
import {
  ToolExplorerToolbar,
  type GroupBy,
  type ViewMode,
} from "./explorer-toolbar";
import type { SourceDialogMeta } from "./add/source-dialog";
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
  onLoadToolDetails?: (toolPaths: string[]) => Promise<Record<string, Pick<ToolDescriptor, "path" | "description" | "display" | "typing">>>;
  warnings?: string[];
  initialSource?: string | null;
  activeSource?: string | null;
  onActiveSourceChange?: (source: string | null) => void;
  showSourceSidebar?: boolean;
  addSourceAction?: ReactNode;
  sourceDialogMeta?: Record<string, SourceDialogMeta>;
  sourceAuthProfiles?: Record<string, SourceAuthProfile>;
  existingSourceNames?: Set<string>;
  onSourceDeleted?: (sourceName: string) => void;
  onRegenerate?: () => void;
  isRebuilding?: boolean;
  inventoryState?: "initializing" | "ready" | "rebuilding" | "stale" | "failed";
  inventoryError?: string;
}

export function ToolExplorer({
  tools,
  sources,
  sourceCountsOverride,
  totalTools,
  hasMoreTools = false,
  loadingMoreTools = false,
  onLoadMoreTools,
  sourceHasMoreTools,
  sourceLoadingMoreTools,
  onLoadMoreToolsForSource,
  loading = false,
  loadingSources = [],
  onLoadToolDetails,
  warnings = [],
  initialSource = null,
  activeSource,
  onActiveSourceChange,
  showSourceSidebar = true,
  addSourceAction,
  sourceDialogMeta,
  sourceAuthProfiles,
  existingSourceNames,
  onSourceDeleted,
  onRegenerate,
  isRebuilding = false,
  inventoryState,
  inventoryError,
}: ToolExplorerProps) {
  const hasRenderableToolDetails = useCallback((tool: Pick<ToolDescriptor, "description" | "display" | "typing">) => {
    const description = tool.description?.trim() ?? "";
    const inputHint = tool.display?.input?.trim() ?? "";
    const outputHint = tool.display?.output?.trim() ?? "";
    const inputSchemaJson = tool.typing?.inputSchemaJson?.trim() ?? "";
    const outputSchemaJson = tool.typing?.outputSchemaJson?.trim() ?? "";

    const hasInputHint = inputHint.length > 0 && inputHint !== "{}" && inputHint.toLowerCase() !== "unknown";
    const hasOutputHint = outputHint.length > 0 && outputHint.toLowerCase() !== "unknown";
    const hasSchemas = inputSchemaJson.length > 0 || outputSchemaJson.length > 0;

    return description.length > 0 || hasInputHint || hasOutputHint || hasSchemas;
  }, []);

  const [searchInput, setSearchInput] = useState("");
  const search = useDeferredValue(searchInput);
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [groupBy, setGroupBy] = useState<GroupBy>("source");
  const [internalActiveSource, setInternalActiveSource] = useState<string | null>(initialSource);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => expandedKeysForSource(initialSource),
  );
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [filterApproval, setFilterApproval] = useState<FilterApproval>("all");
  const [toolDetailsByPath, setToolDetailsByPath] = useState<Record<string, Pick<ToolDescriptor, "path" | "description" | "display" | "typing">>>({});
  const [loadingDetailPaths, setLoadingDetailPaths] = useState<Set<string>>(new Set());
  const treeListRef = useRef<HTMLDivElement>(null);
  const flatListRef = useRef<HTMLDivElement>(null);
  const flatScrollContainerId = "tool-explorer-flat-scroll";
  const treeScrollContainerId = "tool-explorer-tree-scroll";
  const resolvedActiveSource =
    activeSource === undefined ? internalActiveSource : activeSource;

  const handleSourceSelect = useCallback((source: string | null) => {
    if (activeSource === undefined) {
      setInternalActiveSource(source);
    }

    onActiveSourceChange?.(source);
    setExpandedKeys(expandedKeysForSource(source));
  }, [activeSource, onActiveSourceChange]);

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

  const visibleLoadingSources = useMemo(() => {
    if (loadingSourceSet.size === 0) {
      return [] as string[];
    }

    if (resolvedActiveSource) {
      return loadingSourceSet.has(resolvedActiveSource)
        ? [resolvedActiveSource]
        : [];
    }

    return Array.from(loadingSourceSet);
  }, [loadingSourceSet, resolvedActiveSource]);

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

  const warningsBySource = useMemo(() => warningsBySourceName(warnings), [warnings]);

  const sidebarExistingSourceNames = useMemo(() => {
    return existingSourceNames ?? new Set(visibleSources.map((source) => source.name));
  }, [existingSourceNames, visibleSources]);

  const treeGroups = useMemo(() => {
    const showAllSources = search.length === 0;
    return treeGroupsForView(searchedTools, viewMode, groupBy, {
      loadingSources: visibleLoadingSources,
      sourceRecords: showAllSources ? visibleSources : [],
      sourceCounts: showAllSources ? sourceCounts : {},
      activeSource: resolvedActiveSource,
    });
  }, [searchedTools, viewMode, groupBy, visibleLoadingSources, visibleSources, sourceCounts, resolvedActiveSource, search]);

  const flatTools = useMemo(() => {
    return flatToolsForView(searchedTools, viewMode);
  }, [searchedTools, viewMode]);

  const sourceByName = useMemo(() => {
    const map = new Map<string, ToolSourceRecord>();
    for (const source of visibleSources) {
      map.set(source.name, source);
    }
    return map;
  }, [visibleSources]);

  const autoExpandedKeys = useMemo(() => {
    return autoExpandedKeysForSearch(search, filteredTools, viewMode);
  }, [search, filteredTools, viewMode]);

  const visibleExpandedKeys = autoExpandedKeys ?? expandedKeys;

  const loadedCountsBySource = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tool of hydratedTools) {
      const name = sourceLabel(tool.source);
      counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
  }, [hydratedTools]);

  const expandedSourceNames = useMemo(() => {
    return Array.from(visibleExpandedKeys)
      .map((key) => /^source:([^:]+)$/.exec(key)?.[1] ?? null)
      .filter((name): name is string => Boolean(name));
  }, [visibleExpandedKeys]);

  const sourceHasMoreByCount = useCallback((sourceName: string) => {
    const total = sourceCounts[sourceName] ?? 0;
    const loaded = loadedCountsBySource[sourceName] ?? 0;
    return loaded < total;
  }, [loadedCountsBySource, sourceCounts]);

  const nextExpandedSourceToLoad = useMemo(() => {
    for (const sourceName of expandedSourceNames) {
      const explicitHasMore = sourceHasMoreTools?.[sourceName];
      const hasMore = explicitHasMore ?? sourceHasMoreByCount(sourceName);
      if (hasMore) {
        return sourceName;
      }
    }
    return null;
  }, [expandedSourceNames, sourceHasMoreByCount, sourceHasMoreTools]);

  const toggleExpand = useCallback((key: string) => {
    const sourceGroupMatch = /^source:([^:]+)$/.exec(key);
    const isSourceGroup = Boolean(sourceGroupMatch);
    const sourceName = sourceGroupMatch?.[1] ?? null;
    const willExpand = !expandedKeys.has(key);

    if (isSourceGroup && sourceName && willExpand && onLoadMoreToolsForSource) {
      const sourceRecord = sourceByName.get(sourceName);
      if (sourceRecord) {
        const explicitHasMore = sourceHasMoreTools?.[sourceName];
        const hasMore = explicitHasMore ?? sourceHasMoreByCount(sourceName);
        if (hasMore) {
          void onLoadMoreToolsForSource({
            source: `${sourceRecord.type}:${sourceRecord.name}`,
            sourceName: sourceRecord.name,
          });
        }
      }
    }

    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, [expandedKeys, onLoadMoreToolsForSource, sourceByName, sourceHasMoreByCount, sourceHasMoreTools]);

  const toggleSelectTool = useCallback(
    (path: string, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    },
    [],
  );

  const toggleSelectGroup = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        const childTools = findToolsInGroupByKey(treeGroups, key);
        const allSelected =
          childTools.length > 0 &&
          childTools.every((t) => prev.has(t.path));

        if (allSelected) {
          for (const t of childTools) next.delete(t.path);
          next.delete(key);
        } else {
          for (const t of childTools) next.add(t.path);
          next.add(key);
        }
        return next;
      });
    },
    [treeGroups],
  );

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
  }, []);

  const selectAll = useCallback(() => {
    setSelectedKeys(new Set(filteredTools.map((t) => t.path)));
  }, [filteredTools]);

  const selectedToolCount = useMemo(() => {
    return countSelectedTools(selectedKeys, filteredTools);
  }, [selectedKeys, filteredTools]);

  const sourceOptions = useMemo(
    () => {
      const optionSet = new Set(sourceOptionsFromTools(hydratedTools, loadingSources));
      for (const source of visibleSources) {
        optionSet.add(source.name);
      }
      return Array.from(optionSet).sort((a, b) => a.localeCompare(b));
    },
    [hydratedTools, loadingSources, visibleSources],
  );

  const maybeLoadToolDetails = useCallback(async (tool: ToolDescriptor, expanded: boolean) => {
    if (!expanded || !onLoadToolDetails) {
      return;
    }

    const hasDetails = hasRenderableToolDetails(tool);

    if (hasDetails || toolDetailsByPath[tool.path]) {
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
  }, [hasRenderableToolDetails, loadingDetailPaths, onLoadToolDetails, toolDetailsByPath]);

  const flatLoadingRows = useMemo(() => {
    if (search.length > 0 || viewMode !== "flat") {
      return [];
    }

    return visibleLoadingSources.map((source) => ({
      source,
      count: 3,
    }));
  }, [search, viewMode, visibleLoadingSources]);

  const hasFlatRows = flatTools.length > 0 || flatLoadingRows.length > 0;
  const canInfiniteLoad = searchInput.length === 0
    && (viewMode === "tree" && groupBy === "source"
      ? nextExpandedSourceToLoad !== null
      : hasMoreTools);
  const activeSourceLoadingMore = nextExpandedSourceToLoad
    ? (sourceLoadingMoreTools?.[nextExpandedSourceToLoad] ?? false)
    : false;
  const awaitingInitialInventory =
    searchInput.length === 0
    && filteredTools.length === 0
    && (loading || loadingSources.length > 0);

  const handleExpandAll = useCallback(() => {
    setExpandedKeys(collectGroupKeys(treeGroups));
  }, [treeGroups]);

  const handleCollapseAll = useCallback(() => {
    setExpandedKeys(new Set());
  }, []);

  const handleExplorerWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const listEl = viewMode === "flat" ? flatListRef.current : treeListRef.current;
      if (!listEl) return;

      const target = e.target as HTMLElement | null;
      if (target && listEl.contains(target)) return;

      const atTop = listEl.scrollTop <= 0;
      const atBottom =
        listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 1;

      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) return;

      listEl.scrollTop += e.deltaY;
      e.preventDefault();
    },
    [viewMode],
  );

  return (
    <div className="flex" onWheelCapture={handleExplorerWheel}>
      {showSourceSidebar ? (
        <SourceSidebar
          sources={visibleSources}
          sourceCounts={sourceCounts}
          loadingSources={loadingSourceSet}
          warningsBySource={warningsBySource}
          activeSource={resolvedActiveSource}
          onSelectSource={handleSourceSelect}
          sourceDialogMeta={sourceDialogMeta}
          sourceAuthProfiles={sourceAuthProfiles}
          existingSourceNames={sidebarExistingSourceNames}
          onSourceDeleted={onSourceDeleted}
          onRegenerate={onRegenerate}
          isRebuilding={isRebuilding}
          inventoryState={inventoryState}
          inventoryError={inventoryError}
        />
      ) : null}

      <div
        className={cn(
          "flex-1 min-w-0 flex flex-col",
          showSourceSidebar ? "pl-2 lg:pl-3" : "pl-0",
        )}
      >
        <ToolExplorerToolbar
          search={searchInput}
          filteredToolCount={filteredTools.length}
          hasSearch={searchInput.length > 0}
          resultCount={searchedTools.length}
          loadingInventory={awaitingInitialInventory}
          viewMode={viewMode}
          groupBy={groupBy}
          filterApproval={filterApproval}
          showSourceSidebar={showSourceSidebar}
          activeSource={resolvedActiveSource}
          sourceOptions={sourceOptions}
          addSourceAction={addSourceAction}
          selectedToolCount={selectedToolCount}
          onSearchChange={setSearchInput}
          onClearSearch={() => setSearchInput("")}
          onViewModeChange={setViewMode}
          onGroupByChange={setGroupBy}
          onFilterApprovalChange={setFilterApproval}
          onSourceSelect={handleSourceSelect}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
          onExpandAll={handleExpandAll}
          onCollapseAll={handleCollapseAll}
        />

        {viewMode === "flat" ? (
          !hasFlatRows ? (
            <div
              ref={flatListRef}
              className="max-h-[calc(100vh-320px)] overflow-y-auto rounded-md border border-border/30 bg-background/30"
            >
              {awaitingInitialInventory ? (
                <LoadingState />
              ) : (
                <EmptyState hasSearch={!!search} onClearSearch={() => setSearchInput("")} />
              )}
            </div>
          ) : (
            <VirtualFlatList
              tools={flatTools}
              selectedKeys={selectedKeys}
              onSelectTool={toggleSelectTool}
              onExpandedChange={maybeLoadToolDetails}
              detailLoadingPaths={loadingDetailPaths}
              scrollContainerRef={flatListRef}
              scrollContainerId={flatScrollContainerId}
              loadingRows={flatLoadingRows}
              hasMoreTools={canInfiniteLoad}
              loadingMoreTools={loadingMoreTools}
              onLoadMoreTools={onLoadMoreTools}
            />
          )
        ) : (
          <div
            ref={treeListRef}
            id={treeScrollContainerId}
            className="max-h-[calc(100vh-320px)] overflow-y-auto rounded-md border border-border/30 bg-background/30"
          >
            {treeGroups.length === 0 ? (
              awaitingInitialInventory ? (
                <LoadingState />
              ) : (
                <EmptyState hasSearch={!!search} onClearSearch={() => setSearchInput("")} />
              )
            ) : (
                <InfiniteScroll
                  dataLength={tools.length}
                  next={() => {
                    if (
                      searchInput.length === 0
                      && viewMode === "tree"
                      && groupBy === "source"
                      && onLoadMoreToolsForSource
                    ) {
                      if (!nextExpandedSourceToLoad) {
                        return;
                      }
                      const sourceRecord = sourceByName.get(nextExpandedSourceToLoad);
                      if (sourceRecord) {
                        void onLoadMoreToolsForSource({
                          source: `${sourceRecord.type}:${sourceRecord.name}`,
                          sourceName: sourceRecord.name,
                        });
                        return;
                      }
                    }

                    void onLoadMoreTools?.();
                  }}
                  hasMore={canInfiniteLoad}
                  scrollableTarget={treeScrollContainerId}
                  style={{ overflow: "visible" }}
                  loader={
                    <div className="px-2 py-2 text-[11px] text-muted-foreground">
                      {(loadingMoreTools || activeSourceLoadingMore)
                        ? `Loading more tools${totalTools ? ` (${tools.length} / ${totalTools})` : ""}...`
                        : ""}
                    </div>
                  }
              >
                <div className="p-1">
                  {treeGroups.map((group) => (
                    <GroupNode
                      key={group.key}
                      group={group}
                      depth={0}
                      expandedKeys={visibleExpandedKeys}
                      onToggle={toggleExpand}
                      selectedKeys={selectedKeys}
                      onSelectGroup={toggleSelectGroup}
                      onSelectTool={toggleSelectTool}
                      onExpandedChange={maybeLoadToolDetails}
                      detailLoadingPaths={loadingDetailPaths}
                      source={group.type === "source" ? sourceByName.get(group.label) : undefined}
                      search={search}
                    />
                  ))}
                </div>
              </InfiniteScroll>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
