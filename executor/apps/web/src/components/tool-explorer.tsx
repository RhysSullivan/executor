"use client";

import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  memo,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Search,
  ChevronRight,
  ChevronDown,
  ShieldCheck,
  Zap,
  Server,
  Globe,
  Filter,
  X,
  FolderTree,
  List,
  Check,
  Copy,
  Layers,
  Loader2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { cn } from "@/lib/utils";
import type { ToolDescriptor, ToolSourceRecord } from "@/lib/types";

// ── Streamdown code plugin (light + dark dual-theme) ──
const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

// ── Helpers ──

function sourceLabel(source?: string): string {
  if (!source) return "built-in";
  const idx = source.indexOf(":");
  return idx >= 0 ? source.slice(idx + 1) : source;
}

function sourceType(source?: string): string {
  if (!source) return "local";
  const idx = source.indexOf(":");
  return idx >= 0 ? source.slice(0, idx) : "local";
}

function toolNamespace(path: string): string {
  const parts = path.split(".");
  if (parts.length >= 2) return parts.slice(0, -1).join(".");
  return parts[0];
}

function toolOperation(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1];
}

// ── Types for grouped tree data ──

interface ToolGroup {
  key: string;
  label: string;
  type: "source" | "namespace";
  sourceType?: string;
  childCount: number;
  approvalCount: number;
  children: ToolGroup[] | ToolDescriptor[];
}

type GroupBy = "source" | "namespace" | "approval";
type ViewMode = "tree" | "flat";

// ── Build grouped data structures ──

function buildSourceTree(tools: ToolDescriptor[]): ToolGroup[] {
  const bySource = new Map<string, ToolDescriptor[]>();
  for (const tool of tools) {
    const src = sourceLabel(tool.source);
    let list = bySource.get(src);
    if (!list) {
      list = [];
      bySource.set(src, list);
    }
    list.push(tool);
  }

  return Array.from(bySource.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([src, srcTools]) => {
      const sType = srcTools[0] ? sourceType(srcTools[0].source) : "local";

      const byNs = new Map<string, ToolDescriptor[]>();
      for (const tool of srcTools) {
        const ns = toolNamespace(tool.path);
        let list = byNs.get(ns);
        if (!list) {
          list = [];
          byNs.set(ns, list);
        }
        list.push(tool);
      }

      const nsGroups: ToolGroup[] = Array.from(byNs.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ns, nsTools]) => ({
          key: `source:${src}:ns:${ns}`,
          label: ns,
          type: "namespace" as const,
          childCount: nsTools.length,
          approvalCount: nsTools.filter((t) => t.approval === "required")
            .length,
          children: [...nsTools].sort((a, b) =>
            a.path.localeCompare(b.path),
          ),
        }));

      return {
        key: `source:${src}`,
        label: src,
        type: "source" as const,
        sourceType: sType,
        childCount: srcTools.length,
        approvalCount: srcTools.filter((t) => t.approval === "required")
          .length,
        children: nsGroups,
      };
    });
}

function buildNamespaceTree(tools: ToolDescriptor[]): ToolGroup[] {
  const byNs = new Map<string, ToolDescriptor[]>();
  for (const tool of tools) {
    const ns = toolNamespace(tool.path);
    let list = byNs.get(ns);
    if (!list) {
      list = [];
      byNs.set(ns, list);
    }
    list.push(tool);
  }

  return Array.from(byNs.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ns, nsTools]) => ({
      key: `ns:${ns}`,
      label: ns,
      type: "namespace" as const,
      childCount: nsTools.length,
      approvalCount: nsTools.filter((t) => t.approval === "required").length,
      children: [...nsTools].sort((a, b) => a.path.localeCompare(b.path)),
    }));
}

function buildApprovalTree(tools: ToolDescriptor[]): ToolGroup[] {
  const gated = tools.filter((t) => t.approval === "required");
  const auto = tools.filter((t) => t.approval !== "required");
  const groups: ToolGroup[] = [];

  if (gated.length > 0) {
    groups.push({
      key: "approval:required",
      label: "Approval Required",
      type: "namespace",
      childCount: gated.length,
      approvalCount: gated.length,
      children: [...gated].sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  if (auto.length > 0) {
    groups.push({
      key: "approval:auto",
      label: "Auto-approved",
      type: "namespace",
      childCount: auto.length,
      approvalCount: 0,
      children: [...auto].sort((a, b) => a.path.localeCompare(b.path)),
    });
  }

  return groups;
}

// ── Copy button ──

function CopyButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [text],
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className={cn(
              "h-5 w-5 rounded flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted transition-colors shrink-0",
              className,
            )}
          >
            {copied ? (
              <Check className="h-3 w-3 text-terminal-green" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-[11px]">
          Copy path
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Inline tool detail (shown when tool row is expanded) ──

function ToolDetail({ tool, depth }: { tool: ToolDescriptor; depth: number }) {
  // Align with the tool name text: depth indent + row paddingLeft(8) + checkbox(16) + gap(8) + chevron(16) + gap(8) + zap(12) + gap(8) = 76
  const insetLeft = depth * 20 + 8 + 76;
  return (
    <div className="pr-2 pb-3 pt-1 space-y-2.5" style={{ paddingLeft: insetLeft }}>
      {/* Description rendered as markdown/HTML via Streamdown */}
      {tool.description && (
        <div className="tool-description text-[12px] text-muted-foreground leading-relaxed">
          <Streamdown plugins={{ code: codePlugin }}>
            {tool.description}
          </Streamdown>
        </div>
      )}

      {/* Metadata pills */}
      <div className="flex flex-wrap gap-1.5">
        <span className="text-[10px] font-mono text-muted-foreground/70 bg-muted/50 px-1.5 py-0.5 rounded">
          {tool.path}
        </span>
        {tool.source && (
          <span className="text-[10px] font-mono text-muted-foreground/70 bg-muted/50 px-1.5 py-0.5 rounded">
            source: {tool.source}
          </span>
        )}
        {tool.operationId && (
          <span className="text-[10px] font-mono text-muted-foreground/70 bg-muted/50 px-1.5 py-0.5 rounded">
            op: {tool.operationId}
          </span>
        )}
      </div>

      {/* Args / Returns rendered as highlighted TypeScript via Streamdown */}
      {tool.argsType && (
        <div className="tool-description">
          <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50 mb-1">
            Arguments
          </p>
          <Streamdown plugins={{ code: codePlugin }}>
            {"```ts\n" + tool.argsType + "\n```"}
          </Streamdown>
        </div>
      )}
      {tool.returnsType && (
        <div className="tool-description">
          <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50 mb-1">
            Returns
          </p>
          <Streamdown plugins={{ code: codePlugin }}>
            {"```ts\n" + tool.returnsType + "\n```"}
          </Streamdown>
        </div>
      )}
    </div>
  );
}

// ── Tool row — self-contained expand state, memoized ──
// Expand/collapse is local state so toggling one row never re-renders siblings.

const ToolRow = memo(function ToolRow({
  tool,
  label,
  depth,
  selected,
  onSelect,
}: {
  tool: ToolDescriptor;
  label: string;
  depth: number;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors cursor-pointer group/tool select-none",
            expanded
              ? "bg-accent/30"
              : selected
                ? "bg-primary/5 ring-1 ring-primary/10"
                : "hover:bg-accent/20",
          )}
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
        >
          {/* Selection checkbox */}
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

          {/* Expand chevron */}
          <div className="h-4 w-4 flex items-center justify-center shrink-0">
            {expanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground/50" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
            )}
          </div>

          {/* Tool icon */}
          <Zap className="h-3 w-3 text-primary/60 shrink-0" />

          {/* Tool name */}
          <span className="text-[13px] font-mono text-foreground/90 truncate">
            {label}
          </span>

          {/* Badges */}
          {tool.approval === "required" && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-mono uppercase tracking-wider text-terminal-amber bg-terminal-amber/8 px-1.5 py-0.5 rounded border border-terminal-amber/15 shrink-0">
              <ShieldCheck className="h-2.5 w-2.5" />
              gated
            </span>
          )}

          {/* Right side actions */}
          <div className="ml-auto flex items-center gap-1 shrink-0 opacity-0 group-hover/tool:opacity-100 transition-opacity">
            <CopyButton text={tool.path} />
          </div>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <ToolDetail tool={tool} depth={depth} />
      </CollapsibleContent>
    </Collapsible>
  );
});

// ── Group row with Collapsible children ──

function GroupNode({
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
            "flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors cursor-pointer group/row select-none",
            isGroupSelected
              ? "bg-primary/10 ring-1 ring-primary/20"
              : "hover:bg-accent/30",
          )}
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
        >
          {/* Selection checkbox */}
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

          {/* Expand/collapse chevron */}
          <div className="h-4 w-4 flex items-center justify-center shrink-0">
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </div>

          {/* Icon */}
          {isSource && (
            <div className="h-5 w-5 rounded bg-muted/60 flex items-center justify-center shrink-0">
              <SourceIcon className="h-3 w-3 text-muted-foreground" />
            </div>
          )}

          {/* Label */}
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

          {/* Metadata */}
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

/**
 * Thin adapter: extracts a boolean from the Set so ToolRow's memo sees
 * a primitive `selected` and skips re-render when a *different* tool changes.
 */
const SelectableToolRow = memo(function SelectableToolRow({
  tool,
  label,
  depth,
  selectedKeys,
  onSelectTool,
}: {
  tool: ToolDescriptor;
  label: string;
  depth: number;
  selectedKeys: Set<string>;
  onSelectTool: (path: string, e: React.MouseEvent) => void;
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
    />
  );
},
(prev, next) =>
  prev.tool === next.tool &&
  prev.label === next.label &&
  prev.depth === next.depth &&
  prev.selectedKeys.has(prev.tool.path) === next.selectedKeys.has(next.tool.path),
);

// ── Sidebar (Source list) ──

function SourceSidebar({
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
      if (tool.approval === "required") group.approvalCount++;
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

// ── Main Explorer ──

interface ToolExplorerProps {
  tools: ToolDescriptor[];
  sources: ToolSourceRecord[];
  loading?: boolean;
  warnings?: string[];
  initialSource?: string | null;
}

export function ToolExplorer({
  tools,
  sources,
  loading = false,
  warnings = [],
  initialSource = null,
}: ToolExplorerProps) {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [groupBy, setGroupBy] = useState<GroupBy>("source");
  const [activeSource, setActiveSource] = useState<string | null>(
    initialSource,
  );
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [filterApproval, setFilterApproval] = useState<
    "all" | "required" | "auto"
  >("all");

  // When initialSource changes (e.g. URL param), update the active source
  useEffect(() => {
    if (initialSource) {
      setActiveSource(initialSource);
    }
  }, [initialSource]);

  // Auto-expand source when navigating from dashboard with a source filter
  useEffect(() => {
    if (initialSource && tools.length > 0) {
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        next.add(`source:${initialSource}`);
        return next;
      });
    }
  }, [initialSource, tools.length]);

  // Filter tools by active source and approval filter
  const filteredTools = useMemo(() => {
    let result = tools;

    if (activeSource) {
      result = result.filter(
        (t) => sourceLabel(t.source) === activeSource,
      );
    }

    if (filterApproval === "required") {
      result = result.filter((t) => t.approval === "required");
    } else if (filterApproval === "auto") {
      result = result.filter((t) => t.approval !== "required");
    }

    return result;
  }, [tools, activeSource, filterApproval]);

  // Apply search filter
  const searchedTools = useMemo(() => {
    if (!search) return filteredTools;
    const lowerSearch = search.toLowerCase();
    return filteredTools.filter(
      (t) =>
        t.path.toLowerCase().includes(lowerSearch) ||
        t.description.toLowerCase().includes(lowerSearch),
    );
  }, [filteredTools, search]);

  // Build grouped tree
  const treeGroups = useMemo(() => {
    if (viewMode === "flat") return [];
    if (groupBy === "source") return buildSourceTree(searchedTools);
    if (groupBy === "namespace") return buildNamespaceTree(searchedTools);
    return buildApprovalTree(searchedTools);
  }, [searchedTools, viewMode, groupBy]);

  // Flat list
  const flatTools = useMemo(() => {
    if (viewMode !== "flat") return [];
    return [...searchedTools].sort((a, b) => a.path.localeCompare(b.path));
  }, [searchedTools, viewMode]);

  // Auto-expand everything when searching
  useEffect(() => {
    if (search.length >= 2 && viewMode === "tree") {
      const allGroupKeys = new Set<string>();
      const lowerSearch = search.toLowerCase();
      const matching = filteredTools.filter(
        (t) =>
          t.path.toLowerCase().includes(lowerSearch) ||
          t.description.toLowerCase().includes(lowerSearch),
      );

      for (const tool of matching) {
        const src = sourceLabel(tool.source);
        const ns = toolNamespace(tool.path);
        allGroupKeys.add(`source:${src}`);
        allGroupKeys.add(`source:${src}:ns:${ns}`);
        allGroupKeys.add(`ns:${ns}`);
      }

      setExpandedKeys(allGroupKeys);
    }
  }, [search, filteredTools, viewMode]);

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

        const findToolsInGroup = (
          groups: ToolGroup[],
        ): ToolDescriptor[] => {
          const result: ToolDescriptor[] = [];
          for (const g of groups) {
            if (g.key === key) {
              const collectTools = (group: ToolGroup): void => {
                if (
                  group.children.length > 0 &&
                  "key" in group.children[0]
                ) {
                  for (const child of group.children as ToolGroup[]) {
                    collectTools(child);
                  }
                } else {
                  result.push(
                    ...(group.children as ToolDescriptor[]),
                  );
                }
              };
              collectTools(g);
              return result;
            }
            if (
              g.children.length > 0 &&
              "key" in g.children[0]
            ) {
              const found = findToolsInGroup(
                g.children as ToolGroup[],
              );
              if (found.length > 0) return found;
            }
          }
          return result;
        };

        const childTools = findToolsInGroup(treeGroups);
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
    return Array.from(selectedKeys).filter((k) =>
      filteredTools.some((t) => t.path === k),
    ).length;
  }, [selectedKeys, filteredTools]);

  const collectAllGroupKeys = useCallback(
    (groups: ToolGroup[]): Set<string> => {
      const keys = new Set<string>();
      for (const g of groups) {
        keys.add(g.key);
        if (g.children.length > 0 && "key" in g.children[0]) {
          for (const k of collectAllGroupKeys(
            g.children as ToolGroup[],
          )) {
            keys.add(k);
          }
        }
      }
      return keys;
    },
    [],
  );

  if (loading) {
    const enabledSources = sources.filter((s) => s.enabled);
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading {enabledSources.length > 0 ? `${enabledSources.length} tool source${enabledSources.length === 1 ? "" : "s"}` : "tools"}…
        </div>
        {enabledSources.length > 0 && (
          <div className="space-y-1">
            {enabledSources.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
              >
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">{s.type}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-220px)] min-h-[400px]">
      {/* Source sidebar */}
      <SourceSidebar
        tools={tools}
        activeSource={activeSource}
        onSelectSource={setActiveSource}
      />

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col pl-0 lg:pl-4">
        {/* Toolbar */}
        <div className="flex items-center gap-2 pb-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${filteredTools.length} tools...`}
              className="h-8 text-xs pl-8 bg-background/50 border-border/50 focus:border-primary/30"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded flex items-center justify-center text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* View mode toggle */}
          <div className="flex h-8 rounded-md border border-border/50 overflow-hidden">
            <button
              onClick={() => setViewMode("tree")}
              className={cn(
                "px-2 flex items-center gap-1 text-[11px] transition-colors",
                viewMode === "tree"
                  ? "bg-accent/40 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/20",
              )}
            >
              <FolderTree className="h-3 w-3" />
              <span className="hidden sm:inline">Tree</span>
            </button>
            <button
              onClick={() => setViewMode("flat")}
              className={cn(
                "px-2 flex items-center gap-1 text-[11px] transition-colors border-l border-border/50",
                viewMode === "flat"
                  ? "bg-accent/40 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/20",
              )}
            >
              <List className="h-3 w-3" />
              <span className="hidden sm:inline">Flat</span>
            </button>
          </div>

          {/* Group by (only in tree mode) */}
          {viewMode === "tree" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-[11px] border-border/50"
                >
                  <FolderTree className="h-3 w-3 mr-1" />
                  {groupBy === "source"
                    ? "By source"
                    : groupBy === "namespace"
                      ? "By namespace"
                      : "By approval"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-[11px]">
                  Group by
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={groupBy === "source"}
                  onCheckedChange={() => setGroupBy("source")}
                  className="text-xs"
                >
                  Source → Namespace
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={groupBy === "namespace"}
                  onCheckedChange={() => setGroupBy("namespace")}
                  className="text-xs"
                >
                  Namespace
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={groupBy === "approval"}
                  onCheckedChange={() => setGroupBy("approval")}
                  className="text-xs"
                >
                  Approval mode
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 text-[11px] border-border/50",
                  filterApproval !== "all" &&
                    "border-primary/30 text-primary",
                )}
              >
                <Filter className="h-3 w-3 mr-1" />
                {filterApproval === "all"
                  ? "Filter"
                  : filterApproval === "required"
                    ? "Gated only"
                    : "Auto only"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-[11px]">
                Approval filter
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={filterApproval === "all"}
                onCheckedChange={() => setFilterApproval("all")}
                className="text-xs"
              >
                All tools
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={filterApproval === "required"}
                onCheckedChange={() => setFilterApproval("required")}
                className="text-xs"
              >
                Approval required
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={filterApproval === "auto"}
                onCheckedChange={() => setFilterApproval("auto")}
                className="text-xs"
              >
                Auto-approved
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Mobile source selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 text-[11px] border-border/50 lg:hidden",
                  activeSource && "border-primary/30 text-primary",
                )}
              >
                <Server className="h-3 w-3 mr-1" />
                {activeSource ?? "All"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-[11px]">
                Source
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={activeSource === null}
                onCheckedChange={() => setActiveSource(null)}
                className="text-xs"
              >
                All sources
              </DropdownMenuCheckboxItem>
              {Array.from(
                new Set(tools.map((t) => sourceLabel(t.source))),
              ).map((src) => (
                <DropdownMenuCheckboxItem
                  key={src}
                  checked={activeSource === src}
                  onCheckedChange={() =>
                    setActiveSource(
                      activeSource === src ? null : src,
                    )
                  }
                  className="text-xs font-mono"
                >
                  {src}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Selection bar */}
        {selectedToolCount > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 mb-2 rounded-md bg-primary/5 border border-primary/10">
            <span className="text-[12px] font-mono text-primary">
              {selectedToolCount} tool
              {selectedToolCount !== 1 ? "s" : ""} selected
            </span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px] text-muted-foreground"
              onClick={selectAll}
            >
              Select all ({filteredTools.length})
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px] text-muted-foreground"
              onClick={clearSelection}
            >
              Clear
            </Button>
            <div className="h-4 w-px bg-border/50" />
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] border-terminal-amber/30 text-terminal-amber hover:bg-terminal-amber/10"
            >
              <ShieldCheck className="h-3 w-3 mr-1" />
              Set approval
            </Button>
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="mb-2 rounded-md border border-terminal-amber/20 bg-terminal-amber/5 px-3 py-2">
            <p className="text-[11px] text-terminal-amber/80">
              {warnings.length} source warning
              {warnings.length !== 1 ? "s" : ""} — inventory may be
              incomplete
            </p>
          </div>
        )}

        {/* Results info */}
        <div className="flex items-center justify-between pb-1.5">
          <span className="text-[10px] font-mono text-muted-foreground/50">
            {search
              ? `${searchedTools.length} results`
              : `${filteredTools.length} tools`}
            {activeSource && ` in ${activeSource}`}
          </span>
          {viewMode === "tree" && (
            <div className="flex gap-1">
              <button
                onClick={() => {
                  setExpandedKeys(collectAllGroupKeys(treeGroups));
                }}
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                Expand all
              </button>
              <span className="text-[10px] text-muted-foreground/30">
                ·
              </span>
              <button
                onClick={() => setExpandedKeys(new Set())}
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                Collapse all
              </button>
            </div>
          )}
        </div>

        {/* Scrollable list */}
        {viewMode === "flat" ? (
          flatTools.length === 0 ? (
            <div className="flex-1 rounded-md border border-border/30 bg-background/30">
              <EmptyState hasSearch={!!search} />
            </div>
          ) : (
            <VirtualFlatList
              tools={flatTools}
              selectedKeys={selectedKeys}
              onSelectTool={toggleSelectTool}
            />
          )
        ) : (
          <ScrollArea className="flex-1 rounded-md border border-border/30 bg-background/30">
            {treeGroups.length === 0 ? (
              <EmptyState hasSearch={!!search} />
            ) : (
              <div className="p-1">
                {treeGroups.map((group) => (
                  <GroupNode
                    key={group.key}
                    group={group}
                    depth={0}
                    expandedKeys={expandedKeys}
                    onToggle={toggleExpand}
                    selectedKeys={selectedKeys}
                    onSelectGroup={toggleSelectGroup}
                    onSelectTool={toggleSelectTool}
                    search={search}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

// ── Virtualized flat list — only renders visible rows ──

const ROW_HEIGHT = 32;

function VirtualFlatList({
  tools,
  selectedKeys,
  onSelectTool,
}: {
  tools: ToolDescriptor[];
  selectedKeys: Set<string>;
  onSelectTool: (path: string, e: React.MouseEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: tools.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  return (
    <div
      ref={scrollRef}
      className="flex-1 rounded-md border border-border/30 bg-background/30 overflow-y-auto"
    >
      <div
        className="relative w-full p-1"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((vItem) => {
          const tool = tools[vItem.index];
          return (
            <div
              key={tool.path}
              className="absolute left-0 right-0 px-1"
              style={{
                height: vItem.size,
                transform: `translateY(${vItem.start}px)`,
              }}
            >
              <SelectableToolRow
                tool={tool}
                label={tool.path}
                depth={0}
                selectedKeys={selectedKeys}
                onSelectTool={onSelectTool}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Empty state ──

function EmptyState({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-12 gap-2">
      <div className="h-10 w-10 rounded-full bg-muted/50 flex items-center justify-center">
        <Search className="h-5 w-5 text-muted-foreground/30" />
      </div>
      <p className="text-sm text-muted-foreground/60">
        {hasSearch ? "No tools match your search" : "No tools available"}
      </p>
    </div>
  );
}
