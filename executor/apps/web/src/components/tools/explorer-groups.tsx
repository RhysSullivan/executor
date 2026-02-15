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
  toolDisplayOperation,
  toolDisplaySegment,
  type ToolGroup,
} from "@/lib/tool/explorer-grouping";
import type { SourceAuthProfile, ToolDescriptor, ToolSourceRecord } from "@/lib/types";
import { SelectableToolRow, ToolLoadingRows } from "./explorer-rows";
import { SourceFavicon } from "./source-favicon";

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
  const sourceTypeFallback: ToolSourceRecord["type"] = source
    ? source.type
    : group.sourceType === "mcp"
      ? "mcp"
      : group.sourceType === "graphql"
        ? "graphql"
        : "openapi";

  const hasNestedGroups = group.children.some((child): child is ToolGroup => "key" in child);
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
              {source ? (
                <SourceFavicon
                  source={source}
                  iconClassName="h-3 w-3 text-muted-foreground"
                  imageClassName="w-full h-full object-contain"
                />
              ) : (
                sourceTypeFallback === "mcp"
                  ? <Server className="h-3 w-3 text-muted-foreground" />
                  : sourceTypeFallback === "graphql"
                    ? <Layers className="h-3 w-3 text-muted-foreground" />
                    : <Globe className="h-3 w-3 text-muted-foreground" />
              )}
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
            {displayLabel}
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
        {hasNestedGroups || group.children.some((child) => !("key" in child))
          ? group.children.map((child) => {
              if ("key" in child) {
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
          : isLoading
            ? (
              <ToolLoadingRows
                source={displayLabel}
                count={group.loadingPlaceholderCount ?? 0}
                depth={depth + 1}
              />
            )
            : null}
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

  const groups = useMemo(() => {
    const map = new Map<
      string,
      { name: string; type: string; count: number; isLoading: boolean; warningCount: number; source?: ToolSourceRecord }
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
        source,
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
                  <Layers className="h-3 w-3 shrink-0" />
                )}
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
              {g.source ? (
                <AddSourceDialog
                  existingSourceNames={existingSourceNames}
                  sourceToEdit={g.source}
                  sourceDialogMeta={editMeta}
                  sourceAuthProfiles={sourceAuthProfiles}
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
            <p className="text-[10px] font-mono text-terminal-amber/90">
              {activeSourceWarnings.length} warning{activeSourceWarnings.length !== 1 ? "s" : ""}
            </p>
            <div className="mt-1.5 space-y-1">
              {activeSourceWarnings.map((warning, index) => (
                <p key={`${activeSource}-${index}`} className="text-[10px] leading-4 text-muted-foreground">
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
