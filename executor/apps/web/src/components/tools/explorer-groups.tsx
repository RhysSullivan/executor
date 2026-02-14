"use client";

import { useMemo } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  Layers,
  Loader2,
  Server,
  ShieldCheck,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toolOperation, type ToolGroup } from "@/lib/tool-explorer-grouping";
import type { ToolDescriptor, ToolSourceRecord } from "@/lib/types";
import { SelectableToolRow, ToolLoadingRows } from "./explorer-rows";

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
}) {
  const isExpanded = expandedKeys.has(group.key);
  const isSource = group.type === "source";
  const isLoading =
    group.type === "source" &&
    typeof group.loadingPlaceholderCount === "number" &&
    group.loadingPlaceholderCount > 0;
  const isGroupSelected = selectedKeys.has(group.key);
  const SourceIcon =
    group.sourceType === "mcp"
      ? Server
      : group.sourceType === "graphql"
        ? Layers
        : Globe;

  const hasNestedGroups =
    group.children.length > 0 && "key" in group.children[0];

  return (
    <Collapsible open={isExpanded} onOpenChange={() => onToggle(group.key)}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 transition-colors cursor-pointer group/row",
            "sticky bg-background/95 backdrop-blur-sm",
            isExpanded && "border-b border-border/30",
            isGroupSelected
              ? "bg-primary/10 ring-1 ring-primary/20"
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
              <SourceIcon className="h-3 w-3 text-muted-foreground" />
            </div>
          )}

          <span
            className={cn(
              "font-mono text-[13px] truncate",
              isSource
                ? "font-semibold text-foreground"
                : "font-medium text-foreground/90",
            )}
          >
            {group.label}
          </span>

          <span className="text-[10px] font-mono text-muted-foreground/60 ml-auto flex items-center gap-2 shrink-0">
            {isSource && group.sourceType && (
              <span className="uppercase tracking-wider opacity-70">
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
        {hasNestedGroups
          ? (group.children as ToolGroup[]).map((child) => (
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
            ))
          : isLoading
            ? (
              <ToolLoadingRows
                source={group.label}
                count={group.loadingPlaceholderCount ?? 0}
                depth={depth + 1}
              />
            )
            : (group.children as ToolDescriptor[]).map((tool) => (
                <SelectableToolRow
                  key={tool.path}
                  tool={tool}
                  label={toolOperation(tool.path)}
                  depth={depth + 1}
                  selectedKeys={selectedKeys}
                  onSelectTool={onSelectTool}
                  onExpandedChange={onExpandedChange}
                  detailLoading={detailLoadingPaths?.has(tool.path)}
                />
              ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SourceSidebar({
  sources,
  sourceCounts,
  loadingSources,
  warnings,
  activeSource,
  onSelectSource,
}: {
  sources: ToolSourceRecord[];
  sourceCounts: Record<string, number>;
  loadingSources: Set<string>;
  warnings: string[];
  activeSource: string | null;
  onSelectSource: (source: string | null) => void;
}) {
  const totalToolCount = useMemo(
    () => Object.values(sourceCounts).reduce((sum, count) => sum + count, 0),
    [sourceCounts],
  );
  const hasLoadingSources = useMemo(
    () => loadingSources.size > 0,
    [loadingSources],
  );
  const warningCountsBySource = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const warning of warnings) {
      const source = warning.match(/source '([^']+)'/i)?.[1];
      if (!source) {
        continue;
      }
      counts[source] = (counts[source] ?? 0) + 1;
    }
    return counts;
  }, [warnings]);
  const totalSourceWarningCount = useMemo(
    () => Object.values(warningCountsBySource).reduce((sum, count) => sum + count, 0),
    [warningCountsBySource],
  );

  const groups = useMemo(() => {
    const map = new Map<
      string,
      { name: string; type: string; count: number; isLoading: boolean; warningCount: number }
    >();

    for (const source of sources) {
      if (!source.enabled) {
        continue;
      }

      const count = sourceCounts[source.name] ?? 0;
      const isLoading = loadingSources.has(source.name);
      const warningCount = warningCountsBySource[source.name] ?? 0;

      if (count === 0 && !isLoading && warningCount === 0) {
        continue;
      }

      map.set(source.name, {
        name: source.name,
        type: source.type,
        count,
        isLoading,
        warningCount,
      });
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
  }, [sourceCounts, sources, loadingSources, warningCountsBySource]);

  return (
    <div className="w-52 shrink-0 border-r border-border/50 pr-0 hidden lg:block">
      <div className="px-3 pb-2 pt-1">
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50">
          Sources
        </p>
      </div>

      <div className="space-y-0.5 px-1">
        <button
          onClick={() => onSelectSource(null)}
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors text-[12px]",
            activeSource === null
              ? "bg-accent/40 text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/20",
          )}
        >
          <Layers className="h-3 w-3 shrink-0" />
          <span className="font-medium truncate">All sources</span>
          <span className="ml-auto text-[10px] font-mono tabular-nums opacity-60 flex items-center gap-1">
            {totalSourceWarningCount > 0 ? (
              <span
                className="inline-flex items-center gap-0.5 text-terminal-amber"
                title={`${totalSourceWarningCount} source warning${totalSourceWarningCount !== 1 ? "s" : ""}`}
              >
                <AlertTriangle className="h-3 w-3" />
                {totalSourceWarningCount}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1">
              {hasLoadingSources ? <Skeleton className="h-3 w-8" /> : totalToolCount}
            </span>
          </span>
        </button>

        {groups.map((g) => {
          const Icon = g.type === "mcp" ? Server : Globe;
          return (
            <button
              key={g.name}
              onClick={() => onSelectSource(g.name)}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors text-[12px]",
                activeSource === g.name
                  ? "bg-accent/40 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/20",
              )}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span className="font-mono font-medium truncate">{g.name}</span>
              <span className="ml-auto text-[10px] font-mono tabular-nums opacity-60 flex items-center gap-1">
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
          );
        })}
      </div>
    </div>
  );
}
