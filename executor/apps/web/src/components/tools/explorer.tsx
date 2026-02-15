"use client";

import { type ReactNode, useState, useMemo, useCallback, useRef, useDeferredValue, useEffect } from "react";
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
  loading?: boolean;
  loadingSources?: string[];
  onLoadToolDetails?: (toolPaths: string[]) => Promise<Record<string, ToolDescriptor>>;
  warnings?: string[];
  initialSource?: string | null;
  activeSource?: string | null;
  onActiveSourceChange?: (source: string | null) => void;
  showSourceSidebar?: boolean;
  addSourceAction?: ReactNode;
  sourceDialogMeta?: Record<string, SourceDialogMeta>;
  sourceAuthProfiles?: Record<string, SourceAuthProfile>;
  existingSourceNames?: Set<string>;
}

export function ToolExplorer({
  tools,
  sources,
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
}: ToolExplorerProps) {
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
  const [toolDetailsByPath, setToolDetailsByPath] = useState<Record<string, ToolDescriptor>>({});
  const [loadingDetailPaths, setLoadingDetailPaths] = useState<Set<string>>(new Set());
  const treeListRef = useRef<HTMLDivElement>(null);
  const flatListRef = useRef<HTMLDivElement>(null);
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

  const loadingSourceSet = useMemo(() => new Set(loadingSources), [loadingSources]);

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
    const counts: Record<string, number> = {};

    for (const tool of hydratedTools) {
      const sourceName = sourceLabel(tool.source);
      counts[sourceName] = (counts[sourceName] ?? 0) + 1;
    }

    return counts;
  }, [hydratedTools]);

  const [stableSources, setStableSources] = useState<ToolSourceRecord[]>(sources);

  useEffect(() => {
    setStableSources((previous) => {
      const nextByName = new Map<string, ToolSourceRecord>();

      for (const source of previous) {
        if (source.enabled) {
          nextByName.set(source.name, source);
        }
      }

      const enabledSourceNames = new Set<string>();
      for (const source of sources) {
        if (!source.enabled) {
          continue;
        }
        enabledSourceNames.add(source.name);
        nextByName.set(source.name, source);
      }

      for (const [name] of nextByName) {
        const hasTools = (sourceCounts[name] ?? 0) > 0;
        const isLoading = loadingSourceSet.has(name);
        const stillEnabled = enabledSourceNames.has(name);
        if (!stillEnabled && !hasTools && !isLoading) {
          nextByName.delete(name);
        }
      }

      const next = Array.from(nextByName.values()).sort((a, b) => a.name.localeCompare(b.name));
      const unchanged =
        next.length === previous.length
        && next.every((source, index) => {
          const prior = previous[index];
          return prior
            && prior.id === source.id
            && prior.name === source.name
            && prior.type === source.type
            && prior.enabled === source.enabled;
        });
      return unchanged ? previous : next;
    });
  }, [loadingSourceSet, sourceCounts, sources]);

  const searchedTools = useMemo(() => {
    return filterToolsBySearch(filteredTools, search);
  }, [filteredTools, search]);

  const warningsBySource = useMemo(() => warningsBySourceName(warnings), [warnings]);

  const sidebarExistingSourceNames = useMemo(() => {
    return existingSourceNames ?? new Set(stableSources.map((source) => source.name));
  }, [existingSourceNames, stableSources]);

  const treeGroups = useMemo(() => {
    return treeGroupsForView(searchedTools, viewMode, groupBy, {
      loadingSources: visibleLoadingSources,
      sourceRecords: stableSources,
      activeSource: resolvedActiveSource,
    });
  }, [searchedTools, viewMode, groupBy, visibleLoadingSources, stableSources, resolvedActiveSource]);

  const flatTools = useMemo(() => {
    return flatToolsForView(searchedTools, viewMode);
  }, [searchedTools, viewMode]);

  const sourceByName = useMemo(() => {
    const map = new Map<string, ToolSourceRecord>();
    for (const source of stableSources) {
      map.set(source.name, source);
    }
    return map;
  }, [stableSources]);

  const autoExpandedKeys = useMemo(() => {
    return autoExpandedKeysForSearch(search, filteredTools, viewMode);
  }, [search, filteredTools, viewMode]);

  const visibleExpandedKeys = autoExpandedKeys ?? expandedKeys;

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
    () => sourceOptionsFromTools(hydratedTools, loadingSources),
    [hydratedTools, loadingSources],
  );

  const maybeLoadToolDetails = useCallback(async (tool: ToolDescriptor, expanded: boolean) => {
    if (!expanded || !onLoadToolDetails) {
      return;
    }

    const hasDetails = Boolean(
      tool.description
      || tool.display?.input
      || tool.display?.output
      || (tool.typing?.requiredInputKeys?.length ?? 0) > 0,
    );

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
  }, [loadingDetailPaths, onLoadToolDetails, toolDetailsByPath]);

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
          sources={stableSources}
          sourceCounts={sourceCounts}
          loadingSources={loadingSourceSet}
          warningsBySource={warningsBySource}
          activeSource={resolvedActiveSource}
          onSelectSource={handleSourceSelect}
          sourceDialogMeta={sourceDialogMeta}
          sourceAuthProfiles={sourceAuthProfiles}
          existingSourceNames={sidebarExistingSourceNames}
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
              loadingRows={flatLoadingRows}
            />
          )
        ) : (
          <div
            ref={treeListRef}
            className="max-h-[calc(100vh-320px)] overflow-y-auto rounded-md border border-border/30 bg-background/30"
          >
            {treeGroups.length === 0 ? (
              awaitingInitialInventory ? (
                <LoadingState />
              ) : (
                <EmptyState hasSearch={!!search} onClearSearch={() => setSearchInput("")} />
              )
            ) : (
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
            )}
          </div>
        )}
      </div>
    </div>
  );
}
