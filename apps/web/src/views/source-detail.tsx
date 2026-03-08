import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  useSourceInspection,
  useSourceToolDetail,
  useSourceDiscovery,
  usePrefetchToolDetail,
  type Loadable,
  type SourceInspection,
  type SourceInspectionToolDetail,
  type SourceInspectionDiscoverResult,
} from "@executor-v3/react";
import { cn } from "../lib/utils";
import { Badge, MethodBadge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { LoadableBlock, EmptyState } from "../components/loadable";
import { DocumentPanel } from "../components/document-panel";
import {
  IconSearch,
  IconChevron,
  IconTool,
  IconFolder,
  IconCopy,
  IconCheck,
  IconClose,
  IconEmpty,
  IconInfo,
} from "../components/icons";
import { Markdown } from "../components/markdown";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceRouteSearch = {
  tab: "model" | "discover" | "manifest" | "definitions" | "raw";
  tool?: string;
  query?: string;
};

const sourceTabs: Array<{ id: SourceRouteSearch["tab"]; label: string }> = [
  { id: "model", label: "Model" },
  { id: "discover", label: "Discover" },
  { id: "manifest", label: "Manifest" },
  { id: "definitions", label: "Definitions" },
  { id: "raw", label: "Raw" },
];

// ---------------------------------------------------------------------------
// SourceDetailPage (main export)
// ---------------------------------------------------------------------------

export function SourceDetailPage(props: {
  sourceId: string;
  search: SourceRouteSearch;
  navigate: (opts: { search: (prev: SourceRouteSearch) => SourceRouteSearch; replace?: boolean }) => void;
}) {
  const { sourceId, search, navigate } = props;
  const inspection = useSourceInspection(sourceId);

  const selectedToolPath =
    search.tool
    ?? (inspection.status === "ready" ? inspection.data.tools[0]?.path : undefined);

  const toolDetail = useSourceToolDetail(
    sourceId,
    search.tab === "model" ? selectedToolPath ?? null : null,
  );

  const discovery = useSourceDiscovery({
    sourceId,
    query: search.query ?? "",
    limit: 12,
  });

  // Auto-select first tool
  useEffect(() => {
    if (search.tab !== "model" || search.tool || inspection.status !== "ready") return;
    const firstTool = inspection.data.tools[0]?.path;
    if (!firstTool) return;
    void navigate({ search: (prev) => ({ ...prev, tool: firstTool }), replace: true });
  }, [inspection, navigate, search.tab, search.tool]);

  return (
    <LoadableBlock loadable={inspection} loading="Resolving inspection bundle...">
      {(bundle) => {
        const selectedTool =
          bundle.tools.find((t) => t.path === selectedToolPath) ?? bundle.tools[0] ?? null;

        return (
          <div className="flex h-full flex-col overflow-hidden">
            {/* Header bar */}
            <div className="flex shrink-0 items-center justify-between border-b border-border bg-background/95 backdrop-blur-sm px-4 h-12">
              <div className="flex items-center gap-3 min-w-0">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {bundle.source.name}
                </h2>
                <Badge variant="outline">{bundle.pipelineKind}</Badge>
                <span className="hidden text-[11px] text-muted-foreground/50 font-mono sm:block">
                  {bundle.namespace}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {sourceTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => void navigate({ search: (prev) => ({ ...prev, tab: tab.id }) })}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                      tab.id === search.tab
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab content */}
            <div className="flex flex-1 min-h-0 overflow-hidden">
              {search.tab === "model" && (
                <ModelView
                  bundle={bundle}
                  detail={toolDetail}
                  selectedToolPath={selectedTool?.path ?? null}
                  onSelectTool={(toolPath) =>
                    void navigate({ search: (prev) => ({ ...prev, tool: toolPath, tab: "model" }) })
                  }
                  sourceId={sourceId}
                />
              )}
              {search.tab === "discover" && (
                <DiscoveryView
                  bundle={bundle}
                  discovery={discovery}
                  initialQuery={search.query ?? ""}
                  onSubmitQuery={(query) =>
                    void navigate({ search: (prev) => ({ ...prev, query, tab: "discover" }) })
                  }
                  onOpenTool={(toolPath) =>
                    void navigate({ search: (prev) => ({ ...prev, tab: "model", tool: toolPath }) })
                  }
                />
              )}
              {search.tab === "manifest" && (
                <div className="flex-1 overflow-y-auto p-4">
                  <DocumentPanel title="Extracted manifest" body={bundle.manifestJson} empty="No manifest snapshot available." />
                </div>
              )}
              {search.tab === "definitions" && (
                <div className="flex-1 overflow-y-auto p-4">
                  <DocumentPanel title="Compiled tool definitions" body={bundle.definitionsJson} empty="No compiled definitions snapshot available." />
                </div>
              )}
              {search.tab === "raw" && (
                <div className="flex-1 overflow-y-auto p-4">
                  <DocumentPanel title="Raw source document" body={bundle.rawDocumentText} empty="No raw source document stored." />
                </div>
              )}
            </div>
          </div>
        );
      }}
    </LoadableBlock>
  );
}

// ---------------------------------------------------------------------------
// ModelView — full-screen two-panel: tool list + tool detail
// ---------------------------------------------------------------------------

function ModelView(props: {
  bundle: SourceInspection;
  detail: Loadable<SourceInspectionToolDetail | null>;
  selectedToolPath: string | null;
  onSelectTool: (toolPath: string) => void;
  sourceId: string;
}) {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const filteredTools = props.bundle.tools.filter((tool) => {
    if (terms.length === 0) return true;
    const corpus = [tool.path, tool.description ?? "", tool.title ?? "", tool.method ?? ""]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => corpus.includes(t));
  });

  // Keyboard shortcut: / to focus search
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

  return (
    <>
      {/* Left panel: tool tree */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-card/30 lg:w-80 xl:w-[22rem]">
        {/* Search */}
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="relative">
            <IconSearch className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${props.bundle.toolCount} tools...`}
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/30"
            />
            {search.length > 0 ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/40 hover:text-foreground"
              >
                <IconClose />
              </button>
            ) : (
              <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1 py-px text-[10px] text-muted-foreground/50">
                /
              </kbd>
            )}
          </div>
        </div>

        {/* Tool header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Tools
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground/40">
            {filteredTools.length !== props.bundle.toolCount
              ? `${filteredTools.length} / ${props.bundle.toolCount}`
              : props.bundle.toolCount}
          </span>
        </div>

        {/* Tool tree */}
        <div className="flex-1 overflow-y-auto">
          {filteredTools.length === 0 ? (
            <div className="p-4 text-center text-[13px] text-muted-foreground/50">
              {terms.length > 0 ? "No tools match your search" : "No tools available"}
            </div>
          ) : (
            <div className="p-1.5">
              <ToolTree
                tools={filteredTools}
                selectedToolPath={props.selectedToolPath}
                onSelectTool={props.onSelectTool}
                search={search}
                isFiltered={terms.length > 0}
                sourceId={props.sourceId}
              />
            </div>
          )}
        </div>
      </div>

      {/* Right panel: tool detail */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <LoadableBlock loadable={props.detail} loading="Loading tool detail...">
          {(detail) =>
            detail ? (
              <ToolDetailPanel detail={detail} />
            ) : (
              <EmptyState
                title={props.bundle.toolCount > 0 ? "Select a tool to view its details" : "No tools available"}
                description={props.bundle.toolCount > 0 ? "Browse the tree on the left or press / to search" : undefined}
              />
            )
          }
        </LoadableBlock>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tool Tree (nested by . segments)
// ---------------------------------------------------------------------------

type ToolTreeNode = {
  segment: string;
  tool?: SourceInspection["tools"][number];
  children: Map<string, ToolTreeNode>;
};

function buildToolTree(tools: SourceInspection["tools"]): ToolTreeNode {
  const root: ToolTreeNode = { segment: "", children: new Map() };
  for (const tool of tools) {
    const parts = tool.path.split(".");
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { segment: part, children: new Map() });
      }
      node = node.children.get(part)!;
    }
    node.tool = tool;
  }
  return root;
}

function ToolTree(props: {
  tools: SourceInspection["tools"];
  selectedToolPath: string | null;
  onSelectTool: (path: string) => void;
  search: string;
  isFiltered: boolean;
  sourceId: string;
}) {
  const tree = useMemo(() => buildToolTree(props.tools), [props.tools]);
  const prefetch = usePrefetchToolDetail();
  const entries = [...tree.children.values()].sort((a, b) =>
    a.segment.localeCompare(b.segment),
  );

  return (
    <div className="flex flex-col gap-px">
      {entries.map((node) => (
        <ToolTreeNodeView
          key={node.segment}
          node={node}
          depth={0}
          selectedToolPath={props.selectedToolPath}
          onSelectTool={props.onSelectTool}
          search={props.search}
          defaultOpen={props.isFiltered}
          sourceId={props.sourceId}
          prefetch={prefetch}
        />
      ))}
    </div>
  );
}

function ToolTreeNodeView(props: {
  node: ToolTreeNode;
  depth: number;
  selectedToolPath: string | null;
  onSelectTool: (path: string) => void;
  search: string;
  defaultOpen: boolean;
  sourceId: string;
  prefetch: (sourceId: string, toolPath: string) => () => void;
}) {
  const { node, depth, selectedToolPath, onSelectTool, search, defaultOpen, sourceId, prefetch } = props;
  const hasChildren = node.children.size > 0;
  const isLeaf = !!node.tool && !hasChildren;

  // Check if any descendant is the selected tool
  const hasSelectedDescendant = useMemo(() => {
    if (!selectedToolPath) return false;
    function check(n: ToolTreeNode): boolean {
      if (n.tool?.path === selectedToolPath) return true;
      for (const child of n.children.values()) {
        if (check(child)) return true;
      }
      return false;
    }
    return check(node);
  }, [node, selectedToolPath]);

  const [open, setOpen] = useState(defaultOpen || hasSelectedDescendant);

  // Auto-open when search filter is active or selection moves into this group
  useEffect(() => {
    if (defaultOpen || hasSelectedDescendant) setOpen(true);
  }, [defaultOpen, hasSelectedDescendant]);

  // Leaf: render as a tool item
  if (isLeaf) {
    return (
      <ToolListItem
        tool={node.tool!}
        active={node.tool!.path === selectedToolPath}
        onSelect={() => onSelectTool(node.tool!.path)}
        search={search}
        depth={depth}
        sourceId={sourceId}
        prefetch={prefetch}
      />
    );
  }

  // Folder: collapsible group
  const paddingLeft = 8 + depth * 16;
  const sortedChildren = [...node.children.values()].sort((a, b) =>
    a.segment.localeCompare(b.segment),
  );

  const leafCount = countToolLeaves(node);

  return (
    <div>
      {node.tool ? (
        // Node is both a folder AND a tool (rare)
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded p-0.5 text-muted-foreground/30 hover:text-muted-foreground"
            style={{ marginLeft: paddingLeft }}
          >
            <IconChevron
              className={cn(
                "size-2.5 transition-transform duration-150",
                open && "rotate-90",
              )}
            />
          </button>
          <ToolListItem
            tool={node.tool}
            active={node.tool.path === selectedToolPath}
            onSelect={() => onSelectTool(node.tool!.path)}
            search={search}
            depth={-1}
            className="flex-1 pl-1"
            sourceId={sourceId}
            prefetch={prefetch}
          />
        </div>
      ) : (
        // Pure folder
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "group flex w-full items-center gap-1.5 rounded-md py-1 pr-2.5 text-[12px] transition-colors hover:bg-accent/40",
            open ? "text-foreground/80" : "text-muted-foreground/60",
          )}
          style={{ paddingLeft }}
        >
          <IconChevron
            className={cn(
              "size-2.5 shrink-0 text-muted-foreground/30 transition-transform duration-150",
              open && "rotate-90",
            )}
          />
          <IconFolder className={cn(
            "size-3 shrink-0",
            open ? "text-primary/60" : "text-muted-foreground/30",
          )} />
          <span className="flex-1 truncate text-left font-mono">
            {highlightMatch(node.segment, search)}
          </span>
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/25">
            {leafCount}
          </span>
        </button>
      )}

      {open && hasChildren && (
        <div className="relative flex flex-col gap-px">
          <span
            className="absolute top-0 bottom-1 w-px bg-border/40"
            style={{ left: paddingLeft + 5 }}
            aria-hidden
          />
          {sortedChildren.map((child) => (
            <ToolTreeNodeView
              key={child.segment}
              node={child}
              depth={depth + 1}
              selectedToolPath={selectedToolPath}
              onSelectTool={onSelectTool}
              search={search}
              defaultOpen={defaultOpen}
              sourceId={sourceId}
              prefetch={prefetch}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function countToolLeaves(node: ToolTreeNode): number {
  let count = node.tool ? 1 : 0;
  for (const child of node.children.values()) {
    count += countToolLeaves(child);
  }
  return count;
}

// ---------------------------------------------------------------------------
// ToolListItem
// ---------------------------------------------------------------------------

function ToolListItem(props: {
  tool: SourceInspection["tools"][number];
  active: boolean;
  onSelect: () => void;
  search: string;
  depth: number;
  className?: string;
  sourceId: string;
  prefetch: (sourceId: string, toolPath: string) => () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const paddingLeft = props.depth >= 0 ? 8 + props.depth * 16 + 8 : undefined;
  const prefetchedRef = useRef(false);

  useEffect(() => {
    if (props.active && ref.current) {
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [props.active]);

  // Prefetch when visible in viewport
  useEffect(() => {
    const el = ref.current;
    if (!el || prefetchedRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !prefetchedRef.current) {
          prefetchedRef.current = true;
          props.prefetch(props.sourceId, props.tool.path);
          observer.disconnect();
        }
      },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.prefetch, props.sourceId, props.tool.path]);

  // Show only the last segment (the actual method name) since parents show the namespace
  const label = props.depth >= 0
    ? props.tool.path.split(".").pop() ?? props.tool.path
    : props.tool.path;

  return (
    <button
      ref={ref}
      type="button"
      onClick={props.onSelect}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md py-1.5 pr-2.5 text-left transition-colors",
        props.active
          ? "bg-primary/10 text-foreground border-l-2 border-l-primary"
          : "hover:bg-accent/50 text-foreground/70 hover:text-foreground",
        props.className,
      )}
      style={paddingLeft != null ? { paddingLeft } : undefined}
    >
      <IconTool className="size-3 shrink-0 text-muted-foreground/40" />
      <span className="flex-1 truncate font-mono text-[12px]">
        {highlightMatch(label, props.search)}
      </span>
      {props.tool.method && <MethodBadge method={props.tool.method} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ToolDetailPanel
// ---------------------------------------------------------------------------

type OutputTypeExplanation = {
  title: string;
  description: string;
};

const getOutputTypeExplanation = (outputType: string | null | undefined): OutputTypeExplanation | null => {
  if (outputType === "void") {
    return {
      title: "No response body",
      description: "This operation succeeds without returning JSON. The HTTP response carries status only.",
    };
  }

  if (outputType === "{}") {
    return {
      title: "Empty JSON object",
      description: "This operation returns a response body, but the schema has no fields.",
    };
  }

  return null;
};


function ToolDetailPanel(props: { detail: SourceInspectionToolDetail }) {
  const { detail } = props;
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const outputTypeExplanation = getOutputTypeExplanation(detail.summary.outputType);

  const copy = useCallback((text: string, field: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    });
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Sticky header */}
      <div className="shrink-0 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="flex items-start gap-3 px-5 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <IconTool className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {detail.summary.path}
              </h3>
              <CopyButton text={detail.summary.path} field="path" copiedField={copiedField} onCopy={copy} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{detail.summary.providerKind}</Badge>
              {detail.summary.operationId && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {detail.summary.operationId}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 space-y-4">
          {/* Description */}
          {detail.summary.description && (
            <Markdown>{detail.summary.description}</Markdown>
          )}

          {/* Type signatures */}
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <DocumentPanel title="Input type" body={detail.summary.inputType ?? null} lang="typescript" empty="No input type." />
            <DocumentPanel title="Output type" body={detail.summary.outputType ?? null} lang="typescript" empty="No output type." />
          </div>
          {outputTypeExplanation && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-card/40 px-3 py-2.5 text-[12px] text-muted-foreground">
              <IconInfo className="mt-0.5 size-3.5 shrink-0 text-primary/80" />
              <div>
                <div className="font-medium text-foreground/90">{outputTypeExplanation.title}</div>
                <p className="mt-0.5 leading-relaxed">{outputTypeExplanation.description}</p>
              </div>
            </div>
          )}

          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <MetricPill label="Tool ID" value={detail.summary.toolId} />
            {detail.summary.pathTemplate && (
              <MetricPill label="Path" value={detail.summary.pathTemplate} />
            )}
            {detail.summary.method && (
              <MethodBadge method={detail.summary.method} />
            )}
          </div>

          {/* Schema panels */}
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            <DocumentPanel title="Input schema" body={detail.inputSchemaJson} empty="No input schema." compact />
            <DocumentPanel title="Output schema" body={detail.outputSchemaJson} empty="No output schema." compact />
            <DocumentPanel title="Example input" body={detail.exampleInputJson} empty="No example input." compact />
            <DocumentPanel title="Example output" body={detail.exampleOutputJson} empty="No example output." compact />
            <DocumentPanel title="Provider detail" body={detail.providerDataJson} empty="No provider detail." compact />
            <DocumentPanel title="Definition" body={detail.definitionJson} empty="No compiled definition." compact />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiscoveryView
// ---------------------------------------------------------------------------

function DiscoveryView(props: {
  bundle: SourceInspection;
  discovery: Loadable<SourceInspectionDiscoverResult>;
  initialQuery: string;
  onSubmitQuery: (query: string) => void;
  onOpenTool: (toolPath: string) => void;
}) {
  const [draftQuery, setDraftQuery] = useState(props.initialQuery);

  useEffect(() => {
    setDraftQuery(props.initialQuery);
  }, [props.initialQuery]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Search bar */}
      <div className="shrink-0 border-b border-border px-4 py-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmitQuery(draftQuery.trim());
          }}
        >
          <input
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
            placeholder="Search repos, issues, webhooks..."
            className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/30"
          />
          <Button type="submit" size="sm">Run</Button>
        </form>
      </div>

      {/* Results */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar stats */}
        <aside className="hidden w-56 shrink-0 border-r border-border p-3 space-y-2 lg:block">
          <MetricCard label="Source" value={props.bundle.source.name} />
          <MetricCard label="Namespace" value={props.bundle.namespace} />
          <MetricCard label="Tool count" value={String(props.bundle.toolCount)} />
        </aside>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto p-3">
          <LoadableBlock loadable={props.discovery} loading="Scoring candidate tools...">
            {(result) =>
              result.query.length === 0 ? (
                <EmptyState
                  title="Enter a query"
                  description="Search terms live in the URL so you can deep-link ranking investigations."
                />
              ) : result.results.length === 0 ? (
                <EmptyState
                  title="No ranked matches"
                  description="Try a provider noun, operation verb, tag, or path fragment."
                />
              ) : (
                <div className="space-y-2">
                  {result.results.map((item, index) => (
                    <article
                      key={item.path}
                      className="rounded-lg border border-border bg-card/60 p-3 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground">
                            #{index + 1}
                          </span>
                          <h4 className="truncate font-mono text-[13px] font-medium text-foreground">
                            {item.path}
                          </h4>
                        </div>
                        <span className="shrink-0 font-mono text-sm font-semibold text-primary">
                          {item.score.toFixed(2)}
                        </span>
                      </div>
                      <p className="text-[12px] text-muted-foreground leading-relaxed">
                        {item.description ?? "No description"}
                      </p>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
                        <span>{item.inputType ?? "unknown input"}</span>
                        <span>&rarr;</span>
                        <span>{item.outputType ?? "unknown output"}</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {item.reasons.map((reason) => (
                          <span
                            key={reason}
                            className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                          >
                            {reason}
                          </span>
                        ))}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[11px]"
                        onClick={() => props.onOpenTool(item.path)}
                      >
                        Open tool detail &rarr;
                      </Button>
                    </article>
                  ))}
                </div>
              )
            }
          </LoadableBlock>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function MetricCard(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        {props.label}
      </div>
      <div className={cn(
        "mt-0.5 truncate text-[13px] text-foreground/85",
        props.mono && "font-mono text-[12px]",
      )}>
        {props.value}
      </div>
    </div>
  );
}

function MetricPill(props: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 py-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
        {props.label}
      </span>
      <span className="font-mono text-[11px] text-foreground/70">
        {props.value}
      </span>
    </span>
  );
}


function CopyButton(props: {
  text: string;
  field: string;
  copiedField: string | null;
  onCopy: (text: string, field: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onCopy(props.text, props.field)}
      className="shrink-0 rounded p-1 text-muted-foreground/30 transition-colors hover:text-muted-foreground"
      title={`Copy ${props.field}`}
    >
      {props.copiedField === props.field ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

function highlightMatch(text: string, search: string) {
  if (!search.trim()) return text;
  const terms = search.trim().toLowerCase().split(/\s+/);
  const lowerText = text.toLowerCase();
  const ranges: Array<[number, number]> = [];

  for (const term of terms) {
    let idx = 0;
    while (idx < lowerText.length) {
      const found = lowerText.indexOf(term, idx);
      if (found === -1) break;
      ranges.push([found, found + term.length]);
      idx = found + 1;
    }
  }

  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [ranges[0]!];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1]!;
    const current = ranges[i]!;
    if (current[0] <= last[1]) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }

  const parts: Array<{ text: string; hl: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (cursor < start) parts.push({ text: text.slice(cursor, start), hl: false });
    parts.push({ text: text.slice(start, end), hl: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hl: false });

  return (
    <>
      {parts.map((part, i) =>
        part.hl ? (
          <mark key={i} className="rounded-sm bg-primary/20 text-foreground px-px">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
