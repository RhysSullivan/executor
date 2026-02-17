"use client";

import { useCallback, useState, memo } from "react";
import InfiniteScroll from "react-infinite-scroll-component";
import { Button } from "@/components/ui/button";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Search,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toolDisplayPath } from "@/lib/tool/explorer-grouping";
import type { ToolDescriptor } from "@/lib/types";
import { CopyButton } from "./explorer/copy-button";
import { ToolDetail } from "./explorer/tool-detail";

const ToolRow = memo(function ToolRow({
  tool,
  label,
  depth,
  selected,
  onSelect,
  onExpandedChange,
  detailLoading,
}: {
  tool: ToolDescriptor;
  label: string;
  depth: number;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onExpandedChange?: (tool: ToolDescriptor, expanded: boolean) => void;
  detailLoading?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const handleOpenChange = useCallback((open: boolean) => {
    setExpanded(open);
    onExpandedChange?.(tool, open);
  }, [onExpandedChange, tool]);

  return (
    <Collapsible open={expanded} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 transition-colors cursor-pointer group/tool",
            expanded
              ? "sticky bg-background/95 backdrop-blur-sm bg-accent/30"
              : selected
                ? "bg-primary/5 ring-1 ring-primary/10"
                : "hover:bg-accent/20",
          )}
          style={{
            paddingLeft: `${depth * 20 + 8}px`,
            ...(expanded ? { top: `${depth * 32}px`, zIndex: 20 - depth } : {}),
          }}
        >
          <button
            onClick={onSelect}
            className={cn(
              "h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors",
              selected
                ? "bg-primary border-primary text-primary-foreground"
                : "border-border hover:border-muted-foreground/50",
            )}
          >
            {selected && <Check className="h-2.5 w-2.5" />}
          </button>

          <div className="h-4 w-4 flex items-center justify-center shrink-0">
            {expanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground/50" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
            )}
          </div>

          <Zap className="h-3 w-3 text-primary/60 shrink-0" />

          <span className="text-[13px] font-mono text-foreground/90 truncate">
            {label}
          </span>

          {tool.approval === "required" && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-mono uppercase tracking-wider text-terminal-amber bg-terminal-amber/8 px-1.5 py-0.5 rounded border border-terminal-amber/15 shrink-0">
              <ShieldCheck className="h-2.5 w-2.5" />
              gated
            </span>
          )}

          <div className="ml-auto flex items-center gap-1 shrink-0 opacity-0 group-hover/tool:opacity-100 transition-opacity">
            <CopyButton text={tool.path} />
          </div>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <ToolDetail tool={tool} depth={depth} loading={detailLoading} />
      </CollapsibleContent>
    </Collapsible>
  );
});

export const SelectableToolRow = memo(function SelectableToolRow({
  tool,
  label,
  depth,
  selectedKeys,
  onSelectTool,
  onExpandedChange,
  detailLoading,
}: {
  tool: ToolDescriptor;
  label: string;
  depth: number;
  selectedKeys: Set<string>;
  onSelectTool: (path: string, e: React.MouseEvent) => void;
  onExpandedChange?: (tool: ToolDescriptor, expanded: boolean) => void;
  detailLoading?: boolean;
}) {
  const selected = selectedKeys.has(tool.path);
  const handleSelect = useCallback(
    (e: React.MouseEvent) => onSelectTool(tool.path, e),
    [onSelectTool, tool.path],
  );

  return (
    <ToolRow
      tool={tool}
      label={label}
      depth={depth}
      selected={selected}
      onSelect={handleSelect}
      onExpandedChange={onExpandedChange}
      detailLoading={detailLoading}
    />
  );
},
(prev, next) =>
  prev.tool === next.tool &&
  prev.label === next.label &&
  prev.depth === next.depth &&
  prev.detailLoading === next.detailLoading &&
  prev.selectedKeys.has(prev.tool.path) === next.selectedKeys.has(next.tool.path),
);

export function VirtualFlatList({
  tools,
  selectedKeys,
  onSelectTool,
  onExpandedChange,
  detailLoadingPaths,
  loadingRows,
  hasMoreTools = false,
  loadingMoreTools = false,
  onLoadMoreTools,
  scrollContainerId,
  scrollContainerRef,
}: {
  tools: ToolDescriptor[];
  selectedKeys: Set<string>;
  onSelectTool: (path: string, e: React.MouseEvent) => void;
  onExpandedChange?: (tool: ToolDescriptor, expanded: boolean) => void;
  detailLoadingPaths?: Set<string>;
  loadingRows?: { source: string; count: number }[];
  hasMoreTools?: boolean;
  loadingMoreTools?: boolean;
  onLoadMoreTools?: () => Promise<void>;
  scrollContainerId: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={scrollContainerRef}
      id={scrollContainerId}
      className="max-h-[calc(100vh-320px)] overflow-y-auto rounded-md border border-border/30 bg-background/30"
    >
      <InfiniteScroll
        dataLength={tools.length}
        next={() => {
          void onLoadMoreTools?.();
        }}
        hasMore={hasMoreTools}
        scrollableTarget={scrollContainerId}
        style={{ overflow: "visible" }}
        loader={
          <div className="px-2 py-2 text-[11px] text-muted-foreground">
            {loadingMoreTools ? "Loading more tools..." : ""}
          </div>
        }
      >
        <div className="p-1">
          {tools.map((tool) => (
            <SelectableToolRow
              key={tool.path}
              tool={tool}
              label={toolDisplayPath(tool.path)}
              depth={0}
              selectedKeys={selectedKeys}
              onSelectTool={onSelectTool}
              onExpandedChange={onExpandedChange}
              detailLoading={detailLoadingPaths?.has(tool.path)}
            />
          ))}

          {loadingRows?.map((loadingRow) => (
            <ToolLoadingRows
              key={loadingRow.source}
              source={loadingRow.source}
              count={loadingRow.count}
              depth={0}
            />
          ))}
        </div>
      </InfiniteScroll>
    </div>
  );
}

export function EmptyState({
  hasSearch,
  onClearSearch,
}: {
  hasSearch: boolean;
  onClearSearch?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-12 gap-2">
      <div className="h-10 w-10 rounded-full bg-muted/50 flex items-center justify-center">
        <Search className="h-5 w-5 text-muted-foreground/30" />
      </div>
      <p className="text-sm text-muted-foreground/60">
        {hasSearch ? "No tools match your search" : "No tools available"}
      </p>
      {hasSearch && onClearSearch ? (
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-[11px]"
          onClick={onClearSearch}
        >
          Clear search
        </Button>
      ) : null}
    </div>
  );
}

const SKELETON_TOOL_WIDTHS = [
  [180, 140, 200, 120],
  [160, 190, 130],
  [170, 150],
];

export function LoadingState() {
  return (
    <div className="p-1 space-y-0.5">
      {SKELETON_TOOL_WIDTHS.map((rowWidths, groupIdx) => (
        <div key={groupIdx}>
          {/* Source group header skeleton */}
          <div className="flex items-center gap-2 px-2 py-1.5">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-3 w-3" />
            <Skeleton className="h-5 w-5 rounded" />
            <Skeleton className="h-3.5 w-28" />
            <div className="ml-auto">
              <Skeleton className="h-3 w-8" />
            </div>
          </div>
          {/* Tool row skeletons */}
          {rowWidths.map((width, rowIdx) => (
            <div
              key={rowIdx}
              className="flex items-center gap-2 px-2 py-1.5"
              style={{ paddingLeft: "28px" }}
            >
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-3 w-3" />
              <Skeleton className="h-3 w-3" />
              <Skeleton className="h-3.5" style={{ width: `${width}px` }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ToolLoadingRows({
  source,
  count,
  depth,
}: {
  source: string;
  count: number;
  depth: number;
}) {
  if (count <= 0) return null;

  return (
    <div>
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={`${source}-loading-${idx}`}
          className="px-2 py-1.5"
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
        >
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 rounded border border-muted/40 flex items-center justify-center shrink-0">
              <Skeleton className="h-2.5 w-2.5 rounded" />
            </div>

            <Skeleton className="h-3.5 w-56 max-w-full" />

            <div className="ml-auto w-10">
              <Skeleton className="h-3.5 w-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
