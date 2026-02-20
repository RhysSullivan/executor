"use client";

import { useMemo } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  Settings2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AddSourceDialog } from "./add/source-dialog";
import type { SourceDialogMeta } from "./add/source-dialog";
import {
  isToolDescriptorNode,
  isToolGroupNode,
  toolDisplayOperation,
  toolDisplaySegment,
  type ToolGroup,
} from "@/lib/tool/explorer-grouping";
import type { ToolDescriptor, ToolSourceRecord } from "@/lib/types";
import type { SourceAuthProfile } from "@/lib/types";
import { SelectableToolRow, ToolListItem, ToolLoadingRows } from "./explorer-rows";
import { DefaultSourceIcon, SourceFavicon } from "./source-favicon";

export function GroupNode({
  group,
  depth,
  expandedKeys,
  onToggle,
  selectedKeys,
  onSelectGroup,
  onSelectTool,
  onExpandedChange,
  detailLoadingPaths,
  search,
  source,
}: {
  group: ToolGroup;
  depth: number;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
  selectedKeys: Set<string>;
  onSelectGroup: (key: string, e: React.MouseEvent) => void;
  onSelectTool: (path: string, e: React.MouseEvent) => void;
  onExpandedChange?: (tool: ToolDescriptor, expanded: boolean) => void;
  detailLoadingPaths?: Set<string>;
  search: string;
  source?: ToolSourceRecord;
}) {
  const isExpanded = expandedKeys.has(group.key);
  const isSource = group.type === "source";
  const isLoading =
    group.type === "source" &&
    typeof group.loadingPlaceholderCount === "number" &&
    group.loadingPlaceholderCount > 0;
  const isGroupSelected = selectedKeys.has(group.key);
  const sourceTypeFallback: ToolSourceRecord["type"] | "local" | "system" = source
    ? source.type
    : group.label === "system"
      ? "system"
      : (group.sourceType as ToolSourceRecord["type"] | "local") ?? "openapi";

  const hasNestedGroups = group.children.some(isToolGroupNode);
  const displayLabel = toolDisplaySegment(group.label);

  return (
    <Collapsible open={isExpanded} onOpenChange={() => onToggle(group.key)}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 transition-colors cursor-pointer group/row",
            "sticky bg-background/95 backdrop-blur-sm",
            isExpanded && "border-b border-border/30",
            isGroupSelected
              ? isSource
                ? "bg-primary/10 ring-1 ring-primary/20"
                : "bg-accent/20 ring-1 ring-accent/30"
              : "hover:bg-accent/30",
          )}
          style={{
            paddingLeft: `${depth * 20 + 8}px`,
            top: `${depth * 32}px`,
            zIndex: 20 - depth,
          }}
        >
          <button
            onClick={(e) => onSelectGroup(group.key, e)}
            className={cn(
              "h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors",
              isGroupSelected
                ? "bg-primary border-primary text-primary-foreground"
                : "border-border hover:border-muted-foreground/50",
            )}
          >
            {isGroupSelected && <Check className="h-2.5 w-2.5" />}
          </button>

          <div className="h-4 w-4 flex items-center justify-center shrink-0">
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </div>

          {isSource && (
            <div className="h-5 w-5 rounded bg-muted/60 flex items-center justify-center shrink-0">
                {source ? (
                  <SourceFavicon
                    source={source}
                    iconClassName="h-3 w-3 text-muted-foreground"
                    imageClassName="w-full h-full"
                  />
                ) : (
                  <DefaultSourceIcon type={sourceTypeFallback} className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
          )}

          <span
            className={cn(
              "truncate text-sm",
              isSource
                ? "font-semibold text-foreground"
                : "font-medium text-foreground/90",
            )}
          >
            {displayLabel}
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground/70">
            {isSource && group.sourceType && (
              <span className="opacity-80">
                {group.sourceType}
              </span>
            )}
            {isLoading ? (
              <>
                <span className="inline-flex items-center gap-0.5 text-muted-foreground/60">
                  <Loader2 className="h-3 w-3 animate-spin" />
                </span>
                <span>
                  <Skeleton className="h-3 w-6" />
                </span>
              </>
            ) : (
              <>
                {group.approvalCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-terminal-amber">
                    <ShieldCheck className="h-2.5 w-2.5" />
                    {group.approvalCount}
                  </span>
                )}
                <span className="tabular-nums">{group.childCount}</span>
              </>
            )}
          </span>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        {hasNestedGroups || group.children.some(isToolDescriptorNode)
          ? group.children.map((child) => {
              if (isToolGroupNode(child)) {
                return (
                  <GroupNode
                    key={child.key}
                    group={child}
                    depth={depth + 1}
                    expandedKeys={expandedKeys}
                    onToggle={onToggle}
                    selectedKeys={selectedKeys}
                    onSelectGroup={onSelectGroup}
                    onSelectTool={onSelectTool}
                    onExpandedChange={onExpandedChange}
                    detailLoadingPaths={detailLoadingPaths}
                    search={search}
                  />
                );
              }

              return (
                <SelectableToolRow
                  key={child.path}
                  tool={child}
                  label={toolDisplayOperation(child.path)}
                  depth={depth + 1}
                  selectedKeys={selectedKeys}
                  onSelectTool={onSelectTool}
                  onExpandedChange={onExpandedChange}
                  detailLoading={detailLoadingPaths?.has(child.path)}
                />
              );
            })
          : null}

        {isLoading ? (
          <ToolLoadingRows
            source={displayLabel}
            count={group.loadingPlaceholderCount ?? 3}
            depth={depth + 1}
          />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Navigation tree node (click-to-focus, no inline detail) ─────────────────

export function NavGroupNode({
  group,
  depth,
  expandedKeys,
  onToggle,
  focusedPath,
  focusedSource,
  onFocusTool,
  onSourceClick,
  source,
  sourceState,
}: {
  group: ToolGroup;
  depth: number;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
  focusedPath: string | null;
  focusedSource?: string | null;
  onFocusTool: (tool: ToolDescriptor) => void;
  onSourceClick?: (sourceName: string) => void;
  source?: ToolSourceRecord;
  sourceState?: {
    state: "queued" | "loading" | "indexing" | "ready" | "failed";
    toolCount: number;
    processedTools?: number;
    message?: string;
    error?: string;
  };
}) {
  const isExpanded = expandedKeys.has(group.key);
  const isSource = group.type === "source";
  const isSourceFocused = isSource && focusedSource === group.label;
  const isLoadingFromTree =
    group.type === "source" &&
    typeof group.loadingPlaceholderCount === "number" &&
    group.loadingPlaceholderCount > 0;
  const isLoadingFromState = sourceState?.state === "queued" || sourceState?.state === "loading" || sourceState?.state === "indexing";
  const isLoading = isLoadingFromTree || isLoadingFromState;
  const showLoadingRows = isLoading && group.children.length === 0;
  const sourceTypeFallback: ToolSourceRecord["type"] | "local" | "system" = source
    ? source.type
    : group.label === "system"
      ? "system"
      : (group.sourceType as ToolSourceRecord["type"] | "local") ?? "openapi";

  const hasNestedGroups = group.children.some(isToolGroupNode);
  const displayLabel = toolDisplaySegment(group.label);

  const handleSourceHeaderClick = () => {
    // Always expand when clicking a source
    if (!isExpanded) {
      onToggle(group.key);
    }
    // Show source details in the main panel
    if (isSource && onSourceClick) {
      onSourceClick(group.label);
    }
  };

  return (
    <Collapsible open={isExpanded} onOpenChange={() => onToggle(group.key)}>
      {isSource ? (
        // Source headers: click shows details in main panel + expands
        <div
          onClick={handleSourceHeaderClick}
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 transition-colors cursor-pointer group/source",
            "sticky bg-background/95 backdrop-blur-sm",
            isExpanded && "border-b border-border/20",
            isSourceFocused
              ? "bg-accent/40 border-l-2 border-l-primary"
              : "hover:bg-accent/20 border-l-2 border-l-transparent",
          )}
          style={{
            paddingLeft: `${depth * 14 + 6}px`,
            top: `${depth * 28}px`,
            zIndex: 20 - depth,
          }}
        >
          <CollapsibleTrigger asChild>
            <button
              className="h-3.5 w-3.5 flex items-center justify-center shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              {isExpanded ? (
                <ChevronDown className="h-2.5 w-2.5 text-muted-foreground/60" />
              ) : (
                <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/40" />
              )}
            </button>
          </CollapsibleTrigger>

          <div className="h-4 w-4 rounded bg-muted/50 flex items-center justify-center shrink-0">
            {source ? (
              <SourceFavicon
                source={source}
                iconClassName="h-2.5 w-2.5 text-muted-foreground"
                imageClassName="w-full h-full"
              />
            ) : (
              <DefaultSourceIcon type={sourceTypeFallback} className="h-2.5 w-2.5 text-muted-foreground" />
            )}
          </div>

          <span className="truncate text-xs font-semibold text-foreground/90">
            {displayLabel}
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground/60">
            {sourceState?.state === "failed" ? (
              <span className="inline-flex items-center gap-0.5 text-terminal-red" title={sourceState.error ?? "Source failed"}>
                <AlertTriangle className="h-2.5 w-2.5" />
              </span>
            ) : isLoading ? (
              <span
                className="inline-flex items-center gap-1"
                title={sourceState?.message}
              >
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {sourceState?.state === "indexing" && typeof sourceState.processedTools === "number" && sourceState.toolCount > 0 ? (
                  <span className="tabular-nums text-[10px] text-muted-foreground/70">
                    {sourceState.processedTools}/{sourceState.toolCount}
                  </span>
                ) : null}
              </span>
            ) : (
              <>
                {group.approvalCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-terminal-amber">
                    <ShieldCheck className="h-2 w-2" />
                    {group.approvalCount}
                  </span>
                )}
                <span className="tabular-nums">{sourceState?.toolCount ?? group.childCount}</span>
              </>
            )}
          </span>
        </div>
      ) : (
        // Namespace headers: plain collapsible toggle
        <CollapsibleTrigger asChild>
          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 transition-colors cursor-pointer",
              "sticky bg-background/95 backdrop-blur-sm",
              isExpanded && "border-b border-border/20",
              "hover:bg-accent/20",
            )}
            style={{
              paddingLeft: `${depth * 14 + 6}px`,
              top: `${depth * 28}px`,
              zIndex: 20 - depth,
            }}
          >
            <div className="h-3.5 w-3.5 flex items-center justify-center shrink-0">
              {isExpanded ? (
                <ChevronDown className="h-2.5 w-2.5 text-muted-foreground/60" />
              ) : (
                <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/40" />
              )}
            </div>

            <span className="truncate text-xs font-medium text-foreground/80">
              {displayLabel}
            </span>

            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground/60">
              {group.approvalCount > 0 && (
                <span className="inline-flex items-center gap-0.5 text-terminal-amber">
                  <ShieldCheck className="h-2 w-2" />
                  {group.approvalCount}
                </span>
              )}
              <span className="tabular-nums">{group.childCount}</span>
            </span>
          </div>
        </CollapsibleTrigger>
      )}

      <CollapsibleContent>
        {hasNestedGroups || group.children.some(isToolDescriptorNode)
          ? group.children.map((child) => {
              if (isToolGroupNode(child)) {
                return (
                  <NavGroupNode
                    key={child.key}
                    group={child}
                    depth={depth + 1}
                    expandedKeys={expandedKeys}
                    onToggle={onToggle}
                    focusedPath={focusedPath}
                    focusedSource={focusedSource}
                    onFocusTool={onFocusTool}
                    onSourceClick={onSourceClick}
                    sourceState={sourceState}
                  />
                );
              }

              return (
                <ToolListItem
                  key={child.path}
                  tool={child}
                  label={toolDisplayOperation(child.path)}
                  focused={child.path === focusedPath}
                  onFocus={onFocusTool}
                  depth={depth + 1}
                />
              );
            })
          : null}

        {showLoadingRows ? (
          <ToolLoadingRows
            source={displayLabel}
            count={group.loadingPlaceholderCount ?? 3}
            depth={depth + 1}
          />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SourceSidebar({
  sources,
  sourceCounts,
  loadingSources,
  warningsBySource,
  activeSource,
  onSelectSource,
  sourceDialogMeta,
  existingSourceNames,
  sourceAuthProfiles,
  onSourceDeleted,
  onRegenerate,
  isRebuilding = false,
  inventoryState,
  inventoryError,
}: {
  sources: ToolSourceRecord[];
  sourceCounts: Record<string, number>;
  loadingSources: Set<string>;
  warningsBySource: Record<string, string[]>;
  activeSource: string | null;
  onSelectSource: (source: string | null) => void;
  sourceDialogMeta?: Record<string, SourceDialogMeta>;
  existingSourceNames: Set<string>;
  sourceAuthProfiles?: Record<string, SourceAuthProfile>;
  onSourceDeleted?: (sourceName: string) => void;
  onRegenerate?: () => void;
  isRebuilding?: boolean;
  inventoryState?: "initializing" | "ready" | "rebuilding" | "failed";
  inventoryError?: string;
}) {
  const warningCountsBySource = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [sourceName, messages] of Object.entries(warningsBySource)) {
      counts[sourceName] = messages.length;
    }
    return counts;
  }, [warningsBySource]);
  const warningMessagesBySource = useMemo(() => {
    return warningsBySource;
  }, [warningsBySource]);
  const activeSourceWarnings = useMemo(
    () => (activeSource ? warningMessagesBySource[activeSource] ?? [] : []),
    [activeSource, warningMessagesBySource],
  );
  const loadingSourceCount = loadingSources.size;
  const regenerationInProgress = isRebuilding;
  const inventoryStatus = useMemo(() => {
    if (!inventoryState) {
      return {
        label: "Checking inventory",
        tone: "muted" as const,
      };
    }

    if (inventoryState === "initializing") {
      const sourceWord = loadingSourceCount === 1 ? "source" : "sources";
      return {
        label: loadingSourceCount > 0
          ? `Building inventory (${loadingSourceCount} ${sourceWord})`
          : "Building inventory",
        tone: "loading" as const,
      };
    }

    if (inventoryState === "rebuilding") {
      const sourceWord = loadingSourceCount === 1 ? "source" : "sources";
      return {
        label: loadingSourceCount > 0
          ? `Refreshing inventory (${loadingSourceCount} ${sourceWord})`
          : "Refreshing inventory",
        tone: "loading" as const,
      };
    }

    if (inventoryState === "failed") {
      return {
        label: inventoryError ? `Refresh failed: ${inventoryError}` : "Refresh failed",
        tone: "error" as const,
      };
    }

    return {
      label: "Inventory up to date",
      tone: "muted" as const,
    };
  }, [inventoryError, inventoryState, loadingSourceCount]);

  const sourceByName = useMemo(() => {
    const map = new Map<string, ToolSourceRecord>();
    for (const source of sources) {
      if (source.enabled) {
        map.set(source.name, source);
      }
    }
    return map;
  }, [sources]);

  const groups = useMemo(() => {
    // Collect all source names: DB records + any that appear in sourceCounts (e.g. "system").
    const allNames = new Set([
      ...Array.from(sourceByName.keys()),
      ...Object.keys(sourceCounts),
    ]);
    // Also include currently loading sources that may not have counts yet.
    for (const name of loadingSources) {
      allNames.add(name);
    }

    return Array.from(allNames)
      .sort((a, b) => {
        // "system" always sorts last.
        if (a === "system") return 1;
        if (b === "system") return -1;
        return a.localeCompare(b);
      })
      .map((name) => ({
        name,
        type: sourceByName.get(name)?.type ?? null,
        count: sourceCounts[name] ?? 0,
        isLoading: loadingSources.has(name),
        warningCount: warningCountsBySource[name] ?? 0,
        source: sourceByName.get(name) ?? null,
      }));
  }, [loadingSources, sourceCounts, sourceByName, warningCountsBySource]);

  return (
    <div className="w-52 shrink-0 border-r border-border/50 pr-0 hidden lg:block">
      <div className="px-3 pb-2 pt-1">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground/70">
            Sources
          </p>
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
                  : "text-muted-foreground/40 hover:text-muted-foreground/70",
              )}
            >
              <RefreshCcw className={cn("h-3 w-3", regenerationInProgress && "animate-spin")} />
            </button>
          ) : null}
        </div>
        <p
          className={cn(
            "mt-1 flex items-center gap-1 text-xs",
            inventoryStatus.tone === "loading"
              ? "text-terminal-amber/90"
              : inventoryStatus.tone === "error"
                ? "text-terminal-red/90"
                : "text-muted-foreground/60",
          )}
          title={inventoryStatus.label}
        >
          {inventoryStatus.tone === "loading" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : inventoryStatus.tone === "error" ? (
            <AlertTriangle className="h-3 w-3" />
          ) : null}
          <span className="truncate">{inventoryStatus.label}</span>
        </p>
      </div>

      <div className="space-y-0.5 px-1">
        {groups.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-muted-foreground/60">No sources configured yet.</p>
        ) : null}
        {groups.map((g) => {
          const editMeta = g.source ? sourceDialogMeta?.[g.name] : undefined;
          return (
            <div key={g.name} className="relative">
              <button
                onClick={() => onSelectSource(activeSource === g.name ? null : g.name)}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 pr-10 rounded-md text-left transition-colors text-[12px]",
                  activeSource === g.name
                    ? "bg-accent/40 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/20",
                )}
              >
                {g.source ? (
                  <SourceFavicon
                    source={g.source}
                    iconClassName="h-3 w-3 text-muted-foreground"
                    imageClassName="w-3 h-3"
                  />
                ) : (
                  <DefaultSourceIcon
                    type={g.name === "system" ? "system" : "openapi"}
                    className="h-3 w-3 shrink-0 text-muted-foreground"
                  />
                )}
                <span className="truncate font-medium">{g.name}</span>
                <span className="ml-auto flex items-center gap-1 text-xs tabular-nums opacity-70">
                  {g.warningCount > 0 ? (
                    <span
                      className="inline-flex items-center gap-0.5 text-terminal-amber"
                      title={`${g.warningCount} warning${g.warningCount !== 1 ? "s" : ""}`}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {g.warningCount}
                    </span>
                  ) : null}
                  {g.isLoading ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <Skeleton className="h-3 w-4" />
                    </>
                  ) : (
                    g.count
                  )}
                </span>
              </button>
              {g.source ? (
                <AddSourceDialog
                  existingSourceNames={existingSourceNames}
                  sourceToEdit={g.source}
                  sourceDialogMeta={editMeta}
                  sourceAuthProfiles={sourceAuthProfiles}
                  onSourceDeleted={onSourceDeleted}
                  trigger={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                  }
                />
              ) : null}
            </div>
          );
        })}

        {activeSource && activeSourceWarnings.length > 0 ? (
          <div className="mt-2 rounded-md border border-terminal-amber/30 bg-terminal-amber/5 px-2 py-2">
            <p className="text-xs font-medium text-terminal-amber/90">
              {activeSourceWarnings.length} warning{activeSourceWarnings.length !== 1 ? "s" : ""}
            </p>
            <div className="mt-1.5 space-y-1">
              {activeSourceWarnings.map((warning, index) => (
                <p key={`${activeSource}-${index}`} className="text-xs leading-4 text-muted-foreground">
                  {warning}
                </p>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
