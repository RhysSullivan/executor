"use client";

import { useMemo } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  Layers,
  Server,
  ShieldCheck,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { sourceLabel, sourceType } from "@/lib/tool-source-utils";
import { toolOperation, type ToolGroup } from "@/lib/tool-explorer-grouping";
import type { ToolDescriptor } from "@/lib/types";
import { SelectableToolRow } from "./explorer-rows";

export function GroupNode({
  group,
  depth,
  expandedKeys,
  onToggle,
  selectedKeys,
  onSelectGroup,
  onSelectTool,
  search,
}: {
  group: ToolGroup;
  depth: number;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
  selectedKeys: Set<string>;
  onSelectGroup: (key: string, e: React.MouseEvent) => void;
  onSelectTool: (path: string, e: React.MouseEvent) => void;
  search: string;
}) {
  const isExpanded = expandedKeys.has(group.key);
  const isSource = group.type === "source";
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
            {group.approvalCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-terminal-amber">
                <ShieldCheck className="h-2.5 w-2.5" />
                {group.approvalCount}
              </span>
            )}
            <span className="tabular-nums">{group.childCount}</span>
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
                search={search}
              />
            ))
          : (group.children as ToolDescriptor[]).map((tool) => (
              <SelectableToolRow
                key={tool.path}
                tool={tool}
                label={search ? tool.path : toolOperation(tool.path)}
                depth={depth + 1}
                selectedKeys={selectedKeys}
                onSelectTool={onSelectTool}
              />
            ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SourceSidebar({
  tools,
  activeSource,
  onSelectSource,
}: {
  tools: ToolDescriptor[];
  activeSource: string | null;
  onSelectSource: (source: string | null) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { name: string; type: string; count: number; approvalCount: number }
    >();

    for (const tool of tools) {
      const name = sourceLabel(tool.source);
      const type = sourceType(tool.source);
      let group = map.get(name);
      if (!group) {
        group = { name, type, count: 0, approvalCount: 0 };
        map.set(name, group);
      }
      group.count++;
      if (tool.approval === "required") {
        group.approvalCount++;
      }
    }

    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [tools]);

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
          <span className="ml-auto text-[10px] font-mono tabular-nums opacity-60">
            {tools.length}
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
              <span className="ml-auto text-[10px] font-mono tabular-nums opacity-60">
                {g.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
