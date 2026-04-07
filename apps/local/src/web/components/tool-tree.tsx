import { useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSummary {
  readonly id: string;
  readonly name: string;
  readonly pluginKey: string;
  readonly description?: string;
}

type TreeNode = {
  segment: string;
  tool?: ToolSummary;
  children: Map<string, TreeNode>;
};

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

const buildTree = (tools: readonly ToolSummary[]): TreeNode => {
  const root: TreeNode = { segment: "", children: new Map() };

  for (const tool of tools) {
    const parts = tool.name.split(".");
    let node = root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = { segment: part, children: new Map() };
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
          <mark key={i} className="rounded-sm bg-primary/20 px-px text-foreground">
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
// Tree node view
// ---------------------------------------------------------------------------

function TreeNodeView(props: {
  node: TreeNode;
  depth: number;
  selectedToolId: string | null;
  onSelect: (toolId: string) => void;
  search: string;
  defaultOpen: boolean;
}) {
  const { node, depth, selectedToolId, onSelect, search, defaultOpen } = props;
  const hasChildren = node.children.size > 0;
  const isLeaf = !!node.tool && !hasChildren;

  const hasSelectedDescendant = useMemo(() => {
    if (!selectedToolId) return false;
    const check = (n: TreeNode): boolean => {
      if (n.tool?.id === selectedToolId) return true;
      for (const child of n.children.values()) {
        if (check(child)) return true;
      }
      return false;
    };
    return check(node);
  }, [node, selectedToolId]);

  const [open, setOpen] = useState(defaultOpen || hasSelectedDescendant);

  useEffect(() => {
    if (defaultOpen || hasSelectedDescendant) setOpen(true);
  }, [defaultOpen, hasSelectedDescendant]);

  const paddingLeft = 8 + depth * 16;

  if (isLeaf) {
    return (
      <ToolLeafItem
        tool={node.tool!}
        active={node.tool!.id === selectedToolId}
        onSelect={() => onSelect(node.tool!.id)}
        search={search}
        depth={depth}
      />
    );
  }

  const sorted = [...node.children.values()].sort((a, b) =>
    a.segment.localeCompare(b.segment),
  );
  const leafCount = countLeaves(node);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex h-auto w-full items-center gap-1.5 rounded-md py-1 pr-2.5 text-[12px] hover:bg-accent/40 text-left"
        style={{ paddingLeft }}
      >
        <svg
          viewBox="0 0 8 8"
          className="size-2 shrink-0 text-muted-foreground/30 transition-transform duration-150"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          <path d="M2 1l4 3-4 3z" fill="currentColor" />
        </svg>
        <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-muted-foreground/30">
          <path
            d="M2 4h5l2 2h5v7H2V4z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
        <span className="flex-1 truncate font-mono text-foreground/70">
          {highlightMatch(node.segment, search)}
        </span>
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/25">
          {leafCount}
        </span>
      </button>

      {open && hasChildren && (
        <div className="relative flex flex-col gap-px">
          <span
            className="absolute bottom-1 top-0 w-px bg-border/40"
            style={{ left: paddingLeft + 5 }}
            aria-hidden
          />
          {sorted.map((child) => (
            <TreeNodeView
              key={child.segment}
              node={child}
              depth={depth + 1}
              selectedToolId={selectedToolId}
              onSelect={onSelect}
              search={search}
              defaultOpen={defaultOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaf item
// ---------------------------------------------------------------------------

function ToolLeafItem(props: {
  tool: ToolSummary;
  active: boolean;
  onSelect: () => void;
  search: string;
  depth: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const paddingLeft = 8 + props.depth * 16 + 8;
  const label = props.tool.name.split(".").pop() ?? props.tool.name;

  useEffect(() => {
    if (props.active && ref.current) {
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [props.active]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={props.onSelect}
      className={[
        "group flex h-auto w-full items-center gap-2 rounded-md py-1.5 pr-2.5 text-left",
        props.active
          ? "border-l-2 border-l-primary bg-primary/10 text-foreground"
          : "text-foreground/70 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
      style={{ paddingLeft }}
    >
      <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-muted-foreground/40">
        <path
          d="M4 2h8l1 3H3l1-3zM3 6h10v8H3V6z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
      </svg>
      <span className="flex-1 truncate font-mono text-[12px]">
        {highlightMatch(label, props.search)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// ToolTree — main export
// ---------------------------------------------------------------------------

export function ToolTree(props: {
  tools: readonly ToolSummary[];
  selectedToolId: string | null;
  onSelect: (toolId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const filteredTools = useMemo(() => {
    if (terms.length === 0) return props.tools;
    return props.tools.filter((t) => {
      const corpus = [t.name, t.description ?? ""].join(" ").toLowerCase();
      return terms.every((term) => corpus.includes(term));
    });
  }, [props.tools, terms]);

  const tree = useMemo(() => buildTree(filteredTools), [filteredTools]);

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

  const entries = [...tree.children.values()].sort((a, b) =>
    a.segment.localeCompare(b.segment),
  );

  return (
    <div className="flex h-full flex-col">
      {/* Search */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5">
          <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-muted-foreground/40">
            <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M10 10l4.5 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Filter ${props.tools.length} tools…`}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] shadow-none outline-none placeholder:text-muted-foreground/40"
          />
          {search.length > 0 ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="size-5 shrink-0 flex items-center justify-center text-muted-foreground/40 hover:text-foreground"
            >
              ×
            </button>
          ) : (
            <kbd className="shrink-0 rounded border border-border bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground/50">
              /
            </kbd>
          )}
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {filteredTools.length === 0 ? (
          <div className="p-4 text-center text-[13px] text-muted-foreground/50">
            {terms.length > 0 ? "No tools match your filter" : "No tools available"}
          </div>
        ) : (
          <div className="flex flex-col gap-px">
            {entries.map((node) => (
              <TreeNodeView
                key={node.segment}
                node={node}
                depth={0}
                selectedToolId={props.selectedToolId}
                onSelect={props.onSelect}
                search={search}
                defaultOpen={terms.length > 0}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
