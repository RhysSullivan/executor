import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import type { EffectivePolicy, ToolPolicyAction } from "@executor/sdk";
import { Button } from "./button";
import { Input } from "./input";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSummary {
  readonly id: string;
  readonly name: string;
  readonly pluginKey: string;
  readonly description?: string;
  /** Resolved policy for this tool — combines user-authored rules and
   *  plugin defaults into one answer. Always present. UI distinguishes
   *  user vs default purely via `policy.source`. */
  readonly policy: EffectivePolicy;
}

// Color + label for the per-row policy indicator. Mirrors the badges on
// the /policies page so the same action looks the same everywhere.
const POLICY_INDICATOR: Record<
  ToolPolicyAction,
  { readonly label: string; readonly dot: string; readonly ring: string }
> = {
  approve: {
    label: "Auto-approve",
    dot: "bg-emerald-500",
    ring: "ring-emerald-500/70",
  },
  require_approval: {
    label: "Require approval",
    dot: "bg-amber-500",
    ring: "ring-amber-500/70",
  },
  block: {
    label: "Blocked",
    dot: "bg-destructive",
    ring: "ring-destructive/70",
  },
};

// What the dot looks like for a given effective policy. Auto-approve as
// a plugin default is silent (the safe state — no point cluttering every
// row); everything else gets a dot. User policies are filled, plugin
// defaults are hollow rings.
const indicatorFor = (policy: EffectivePolicy) => {
  if (policy.source === "plugin-default" && policy.action === "approve") {
    return null;
  }
  const ind = POLICY_INDICATOR[policy.action];
  const filled = policy.source === "user";
  const label =
    policy.source === "user"
      ? `${ind.label} (matched ${policy.pattern})`
      : `Plugin default: ${ind.label}`;
  return {
    label,
    className: filled
      ? ind.dot
      : cn("bg-transparent ring-1", ind.ring),
  };
};

type TreeNode = {
  segment: string;
  path: string;
  tool?: ToolSummary;
  children: Map<string, TreeNode>;
};

type Row =
  | { kind: "leaf"; depth: number; path: string; tool: ToolSummary }
  | {
      kind: "group";
      depth: number;
      path: string;
      segment: string;
      count: number;
      open: boolean;
    };

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

const buildTree = (tools: readonly ToolSummary[]): TreeNode => {
  const root: TreeNode = { segment: "", path: "", children: new Map() };

  for (const tool of tools) {
    const parts = tool.name.split(".");
    let node = root;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}.${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { segment: part, path, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.tool = tool;
  }

  return root;
};

const countLeaves = (node: TreeNode): number => {
  let count = node.tool ? 1 : 0;
  for (const child of node.children.values()) {
    count += countLeaves(child);
  }
  return count;
};

const collectGroupPaths = (node: TreeNode, acc: Set<string>): void => {
  for (const child of node.children.values()) {
    if (child.children.size > 0) {
      acc.add(child.path);
      collectGroupPaths(child, acc);
    }
  }
};

const flattenTree = (
  node: TreeNode,
  depth: number,
  openSet: ReadonlySet<string>,
  acc: Row[],
): void => {
  const sorted = [...node.children.values()].sort((a, b) => a.segment.localeCompare(b.segment));
  for (const child of sorted) {
    const hasChildren = child.children.size > 0;
    const isLeaf = !!child.tool && !hasChildren;

    if (isLeaf) {
      acc.push({ kind: "leaf", depth, path: child.path, tool: child.tool! });
      continue;
    }

    const open = openSet.has(child.path);
    acc.push({
      kind: "group",
      depth,
      path: child.path,
      segment: child.segment,
      count: countLeaves(child),
      open,
    });
    if (open) {
      flattenTree(child, depth + 1, openSet, acc);
    }
  }
};

// ---------------------------------------------------------------------------
// Highlight
// ---------------------------------------------------------------------------

const highlightMatch = (text: string, search: string) => {
  if (!search.trim()) return text;

  const terms = search.trim().toLowerCase().split(/\s+/);
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];

  for (const term of terms) {
    let idx = 0;
    while (idx < lower.length) {
      const found = lower.indexOf(term, idx);
      if (found === -1) break;
      ranges.push([found, found + term.length]);
      idx = found + 1;
    }
  }

  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [ranges[0]!];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1]!;
    const cur = ranges[i]!;
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }

  const parts: { text: string; hl: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (cursor < start) parts.push({ text: text.slice(cursor, start), hl: false });
    parts.push({ text: text.slice(start, end), hl: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hl: false });

  return (
    <>
      {parts.map((p, i) =>
        p.hl ? (
          <mark key={i} className="rounded-sm bg-primary/25 px-px text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// ToolTree — main export
// ---------------------------------------------------------------------------

export function ToolTree(props: {
  tools: readonly ToolSummary[];
  selectedToolId: string | null;
  onSelect: (toolId: string) => void;
}) {
  const { tools, selectedToolId, onSelect } = props;
  const [search, setSearch] = useState("");
  const [manualOpen, setManualOpen] = useState<Set<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);

  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const filteredTools = useMemo(() => {
    if (terms.length === 0) return tools;
    return tools.filter((t) => {
      const corpus = [t.name, t.description ?? ""].join(" ").toLowerCase();
      return terms.every((term) => corpus.includes(term));
    });
  }, [tools, terms]);

  const tree = useMemo(() => buildTree(filteredTools), [filteredTools]);

  // When searching, expand everything so matches are visible.
  // Also auto-expand groups that contain the selected tool.
  const openSet = useMemo(() => {
    if (terms.length > 0) {
      const all = new Set<string>();
      collectGroupPaths(tree, all);
      return all;
    }
    const set = new Set(manualOpen);
    if (selectedToolId) {
      const parts = selectedToolId.split(".");
      // Progressively add ancestor paths (best-effort, based on dotted name).
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}.${parts[i]}` : parts[i]!;
        set.add(acc);
      }
    }
    return set;
  }, [tree, manualOpen, selectedToolId, terms.length]);

  const rows = useMemo(() => {
    const acc: Row[] = [];
    flattenTree(tree, 0, openSet, acc);
    return acc;
  }, [tree, openSet]);

  const toggleGroup = (path: string) => {
    setManualOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Keyboard shortcuts — `/` focuses search, Escape clears
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        searchRef.current?.blur();
        if (search.length > 0) setSearch("");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [search]);

  // Scroll the selected row into view when it changes
  useEffect(() => {
    if (!selectedToolId) return;
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedToolId, rows]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <SearchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <Input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Filter ${tools.length} tools…`}
          aria-label="Filter tools"
          className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-xs shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0"
        />
        {search.length > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setSearch("")}
            aria-label="Clear search"
            className="size-4 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3" />
          </Button>
        )}
      </div>
      <div className="mx-2 border-t border-border/30" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filteredTools.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {terms.length > 0 ? "No tools match your filter" : "No tools available"}
          </div>
        ) : (
          rows.map((row) =>
            row.kind === "leaf" ? (
              <ToolLeafRow
                key={row.path}
                buttonRef={row.tool.id === selectedToolId ? selectedRowRef : undefined}
                tool={row.tool}
                depth={row.depth}
                active={row.tool.id === selectedToolId}
                onSelect={() => onSelect(row.tool.id)}
                search={search}
              />
            ) : (
              <ToolGroupRow
                key={row.path}
                segment={row.segment}
                depth={row.depth}
                count={row.count}
                open={row.open}
                onToggle={() => toggleGroup(row.path)}
                search={search}
              />
            ),
          )
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

const rowIndent = (depth: number) => 12 + depth * 16;

const rowBaseClasses =
  "relative flex h-auto w-full items-center justify-start gap-2 rounded-none py-2 text-xs font-normal transition-[background-color] duration-150";

function ToolGroupRow(props: {
  segment: string;
  depth: number;
  count: number;
  open: boolean;
  onToggle: () => void;
  search: string;
}) {
  return (
    <Button
      variant="ghost"
      aria-expanded={props.open}
      onClick={props.onToggle}
      className={cn(rowBaseClasses, "hover:bg-accent/60")}
      style={{ paddingLeft: rowIndent(props.depth), paddingRight: 12 }}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
          props.open && "rotate-90",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left font-mono text-xs text-foreground">
        {highlightMatch(props.segment, props.search)}
      </span>
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{props.count}</span>
    </Button>
  );
}

function ToolLeafRow(props: {
  buttonRef?: React.Ref<HTMLButtonElement>;
  tool: ToolSummary;
  depth: number;
  active: boolean;
  onSelect: () => void;
  search: string;
}) {
  const label = props.tool.name.split(".").pop() ?? props.tool.name;
  const indicator = indicatorFor(props.tool.policy);
  return (
    <Button
      ref={props.buttonRef}
      variant="ghost"
      onClick={props.onSelect}
      className={cn(
        rowBaseClasses,
        props.active
          ? "bg-primary/15 text-foreground ring-1 ring-inset ring-primary/40 hover:bg-primary/20"
          : "text-foreground/80 hover:bg-accent/60 hover:text-foreground",
        props.tool.policy.action === "block" && !props.active && "opacity-60",
      )}
      style={{ paddingLeft: rowIndent(props.depth) + 20, paddingRight: 12 }}
    >
      <span className="flex-1 truncate text-left font-mono">
        {highlightMatch(label, props.search)}
      </span>
      {indicator && (
        <span
          aria-label={indicator.label}
          title={indicator.label}
          className={cn("shrink-0 size-1.5 rounded-full", indicator.className)}
        />
      )}
    </Button>
  );
}
