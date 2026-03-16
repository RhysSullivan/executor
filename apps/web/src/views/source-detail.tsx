import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import {
  type ConnectSourcePayload,
  useSource,
  useSources,
  useConnectSource,
  useSourceInspection,
  useSourceToolDetail,
  useSourceDiscovery,
  type Loadable,
  type Source,
  type SourceInspection,
  type SourceInspectionToolDetail,
  type SourceInspectionDiscoverResult,
} from "@executor/react";
import { cn } from "../lib/utils";
import { formatSchemaJsonForDisplay } from "../lib/schema-display";
import { Badge, MethodBadge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { LoadableBlock, EmptyState } from "../components/loadable";
import { DocumentPanel } from "../components/document-panel";
import { SourceNotFoundState } from "../components/source-not-found-state";
import { SourceRecoveryState } from "../components/source-recovery-state";
import {
  IconSearch,
  IconChevron,
  IconTool,
  IconFolder,
  IconCopy,
  IconCheck,
  IconClose,
  IconPencil,
  IconSpinner,
} from "../components/icons";
import { Markdown } from "../components/markdown";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceRouteSearch = {
  tab: "model" | "discover";
  tool?: string;
  query?: string;
};

const visibleTabs: Array<{ id: SourceRouteSearch["tab"]; label: string }> = [
  { id: "model", label: "Tools" },
  { id: "discover", label: "Search" },
];

const isSourceNotFoundError = (loadable: Loadable<unknown>): boolean =>
  loadable.status === "error"
  && loadable.error.message.toLowerCase().includes("source not found");

const isMissingCatalogArtifactError = (loadable: Loadable<unknown>): boolean =>
  loadable.status === "error"
  && loadable.error.message.toLowerCase().includes("catalog artifact missing for source");

const listExcludesSource = (
  sources: Loadable<ReadonlyArray<Source>>,
  sourceId: string,
): boolean => sources.status === "ready" && !sources.data.some((source) => source.id === sourceId);

type SourceDetailPageState =
  | { kind: "source_not_found" }
  | { kind: "tools_missing"; source: Source }
  | { kind: "ready" };

const resolveSourceDetailPageState = (input: {
  sources: Loadable<ReadonlyArray<Source>>;
  source: Loadable<Source>;
  inspection: Loadable<SourceInspection>;
  sourceId: string;
}): SourceDetailPageState => {
  if (
    listExcludesSource(input.sources, input.sourceId)
    || isSourceNotFoundError(input.source)
    || isSourceNotFoundError(input.inspection)
  ) {
    return { kind: "source_not_found" };
  }

  if (input.source.status === "ready" && isMissingCatalogArtifactError(input.inspection)) {
    return {
      kind: "tools_missing",
      source: input.source.data,
    };
  }

  return { kind: "ready" };
};

const readBindingString = (source: Source, key: string): string | null =>
  typeof source.binding[key] === "string" && source.binding[key].trim().length > 0
    ? String(source.binding[key])
    : null;

const readBindingStringMap = (source: Source, key: string): Record<string, string> | null => {
  const candidate = source.binding[key];
  if (candidate === null || candidate === undefined || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const entries = Object.entries(candidate as Record<string, unknown>);
  return entries.every(([, value]) => typeof value === "string")
    ? Object.fromEntries(entries as ReadonlyArray<readonly [string, string]>)
    : null;
};

const readBindingStringArray = (source: Source, key: string): Array<string> | undefined => {
  const candidate = source.binding[key];
  return Array.isArray(candidate) && candidate.every((value) => typeof value === "string")
    ? [...candidate]
    : undefined;
};

const readBindingTransport = (source: Source): "auto" | "streamable-http" | "sse" | undefined => {
  const candidate = source.binding.transport;
  return candidate === "auto" || candidate === "streamable-http" || candidate === "sse"
    ? candidate
    : undefined;
};

const refreshableHttpAuth = (
  auth: Source["auth"],
): Extract<Source["auth"], { kind: "none" | "bearer" | "oauth2" }> | undefined =>
  auth.kind === "none" || auth.kind === "bearer" || auth.kind === "oauth2"
    ? auth
    : undefined;

const refreshPayloadFromSource = (source: Source): ConnectSourcePayload | null => {
  switch (source.kind) {
    case "mcp":
      return {
        kind: "mcp",
        endpoint: source.endpoint,
        name: source.name,
        namespace: source.namespace,
        ...(readBindingTransport(source) ? { transport: readBindingTransport(source) } : {}),
        queryParams: readBindingStringMap(source, "queryParams"),
        headers: readBindingStringMap(source, "headers"),
      };
    case "openapi": {
      const specUrl = readBindingString(source, "specUrl");
      if (!specUrl) {
        return null;
      }

      return {
        kind: "openapi",
        endpoint: source.endpoint,
        specUrl,
        name: source.name,
        namespace: source.namespace,
        importAuthPolicy: source.importAuthPolicy,
        importAuth: refreshableHttpAuth(source.importAuth),
        auth: refreshableHttpAuth(source.auth),
      };
    }
    case "graphql":
      return {
        kind: "graphql",
        endpoint: source.endpoint,
        name: source.name,
        namespace: source.namespace,
        importAuthPolicy: source.importAuthPolicy,
        importAuth: refreshableHttpAuth(source.importAuth),
        auth: refreshableHttpAuth(source.auth),
      };
    case "google_discovery": {
      const service = readBindingString(source, "service");
      const version = readBindingString(source, "version");
      if (!service || !version) {
        return null;
      }

      return {
        kind: "google_discovery",
        service,
        version,
        discoveryUrl: readBindingString(source, "discoveryUrl"),
        scopes: readBindingStringArray(source, "scopes"),
        oauthClient: null,
        name: source.name,
        namespace: source.namespace,
        importAuthPolicy: source.importAuthPolicy,
        importAuth: refreshableHttpAuth(source.importAuth),
        auth: refreshableHttpAuth(source.auth),
      };
    }
  }
};

// ---------------------------------------------------------------------------
// SourceDetailPage (main export)
// ---------------------------------------------------------------------------

export function SourceDetailPage(props: {
  sourceId: string;
  search: SourceRouteSearch;
  navigate: (opts: { search: (prev: SourceRouteSearch) => SourceRouteSearch; replace?: boolean }) => void;
}) {
  const { sourceId, search, navigate } = props;
  const sources = useSources();
  const source = useSource(sourceId);
  const connectSource = useConnectSource();
  const inspection = useSourceInspection(sourceId);
  const [refreshFeedback, setRefreshFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const sourceDetailPageState = resolveSourceDetailPageState({
    sources,
    source,
    inspection,
    sourceId,
  });

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

  const handleRefresh = useCallback(async (currentSource: Source) => {
    const payload = refreshPayloadFromSource(currentSource);
    if (!payload) {
      setRefreshFeedback({
        tone: "error",
        text: "Refresh is unavailable until this source has complete connection details.",
      });
      return;
    }

    setRefreshFeedback(null);
    try {
      await connectSource.mutateAsync(payload);
      setRefreshFeedback({
        tone: "success",
        text: `Refreshed ${currentSource.name}.`,
      });
    } catch (error) {
      setRefreshFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to refresh source.",
      });
    }
  }, [connectSource]);

  // Auto-select first tool
  useEffect(() => {
    if (search.tab !== "model" || search.tool || inspection.status !== "ready") return;
    const firstTool = inspection.data.tools[0]?.path;
    if (!firstTool) return;
    void navigate({ search: (prev) => ({ ...prev, tool: firstTool }), replace: true });
  }, [inspection, navigate, search.tab, search.tool]);

  if (sourceDetailPageState.kind === "source_not_found") {
    return <SourceNotFoundState />;
  }

  if (sourceDetailPageState.kind === "tools_missing") {
    const refreshPayload = refreshPayloadFromSource(sourceDetailPageState.source);

    return (
      <SourceRecoveryState
        source={sourceDetailPageState.source}
        title="Tools need to be rebuilt"
        description="This source exists in your workspace, but its generated tool catalog is missing. Refresh to reconnect and rebuild the tools."
        refreshLabel="Refresh source"
        refreshTitle={
          refreshPayload === null
            ? "Refresh is unavailable for this source configuration"
            : "Reconnect and rebuild this source"
        }
        refreshDisabled={connectSource.status === "pending" || refreshPayload === null}
        refreshPending={connectSource.status === "pending"}
        feedback={refreshFeedback}
        onRefresh={() => void handleRefresh(sourceDetailPageState.source)}
      />
    );
  }

  return (
    <LoadableBlock loadable={inspection} loading="Loading source...">
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
                <Badge variant="outline">{bundle.source.kind}</Badge>
                <span className="hidden text-[11px] tabular-nums text-muted-foreground/50 sm:block">
                  {bundle.toolCount} {bundle.toolCount === 1 ? "tool" : "tools"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {refreshFeedback && (
                  <span
                    className={cn(
                      "hidden max-w-72 truncate text-[11px] font-medium sm:inline-flex sm:items-center sm:gap-1.5",
                      refreshFeedback.tone === "success"
                        ? "text-primary"
                        : "text-destructive",
                    )}
                    title={refreshFeedback.text}
                  >
                    {refreshFeedback.tone === "success" && (
                      <IconCheck className="size-3 shrink-0" />
                    )}
                    {refreshFeedback.text}
                  </span>
                )}
                <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
                  {visibleTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => void navigate({ search: (prev) => ({ ...prev, tab: tab.id }) })}
                      className={cn(
                        "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                        tab.id === search.tab
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleRefresh(bundle.source)}
                  disabled={connectSource.status === "pending" || refreshPayloadFromSource(bundle.source) === null}
                  title={
                    refreshPayloadFromSource(bundle.source) === null
                      ? "Refresh is unavailable for this source configuration"
                      : "Reconnect and resync this source"
                  }
                >
                  {connectSource.status === "pending"
                    ? <IconSpinner className="size-3" />
                    : null}
                  Refresh
                </Button>
                <Link
                  to="/sources/$sourceId/edit"
                  params={{ sourceId }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground hover:bg-accent/50"
                >
                  <IconPencil className="size-3" />
                  Edit
                </Link>
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
            </div>
          </div>
        );
      }}
    </LoadableBlock>
  );
}

// ---------------------------------------------------------------------------
// ModelView — two-panel: tool list + tool detail
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
    const corpus = [tool.path, tool.method ?? ""]
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
      {/* Left panel: tool list */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-card/30 lg:w-80 xl:w-[22rem]">
        {/* Search */}
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="relative">
            <IconSearch className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Filter ${props.bundle.toolCount} tools\u2026`}
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

        {/* Tool list */}
        <div className="flex-1 overflow-y-auto">
          {filteredTools.length === 0 ? (
            <div className="p-4 text-center text-[13px] text-muted-foreground/50">
              {terms.length > 0 ? "No tools match your filter" : "No tools available"}
            </div>
          ) : (
            <div className="p-1.5">
              <ToolTree
                tools={filteredTools}
                selectedToolPath={props.selectedToolPath}
                onSelectTool={props.onSelectTool}
                search={search}
                isFiltered={terms.length > 0}
              />
            </div>
          )}
        </div>
      </div>

      {/* Right panel: tool detail */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <LoadableBlock loadable={props.detail} loading="Loading tool...">
          {(detail) =>
            detail ? (
              <ToolDetailPanel detail={detail} />
            ) : (
              <EmptyState
                title={props.bundle.toolCount > 0 ? "Select a tool" : "No tools available"}
                description={props.bundle.toolCount > 0 ? "Choose from the list or press / to search" : undefined}
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
}) {
  const tree = useMemo(() => buildToolTree(props.tools), [props.tools]);
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
}) {
  const { node, depth, selectedToolPath, onSelectTool, search, defaultOpen } = props;
  const hasChildren = node.children.size > 0;
  const isLeaf = !!node.tool && !hasChildren;

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

  useEffect(() => {
    if (defaultOpen || hasSelectedDescendant) setOpen(true);
  }, [defaultOpen, hasSelectedDescendant]);

  if (isLeaf) {
    return (
      <ToolListItem
        tool={node.tool!}
        active={node.tool!.path === selectedToolPath}
        onSelect={() => onSelectTool(node.tool!.path)}
        search={search}
        depth={depth}
      />
    );
  }

  const paddingLeft = 8 + depth * 16;
  const sortedChildren = [...node.children.values()].sort((a, b) =>
    a.segment.localeCompare(b.segment),
  );

  const leafCount = countToolLeaves(node);

  return (
    <div>
      {node.tool ? (
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
          />
        </div>
      ) : (
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
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const paddingLeft = props.depth >= 0 ? 8 + props.depth * 16 + 8 : undefined;

  useEffect(() => {
    if (props.active && ref.current) {
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [props.active]);

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

function ToolDetailPanel(props: { detail: SourceInspectionToolDetail }) {
  const { detail } = props;
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const displayedCallSchema = useMemo(
    () => formatSchemaJsonForDisplay(detail.callSchemaJson),
    [detail.callSchemaJson],
  );
  const displayedResultSchema = useMemo(
    () => formatSchemaJsonForDisplay(detail.resultSchemaJson),
    [detail.resultSchemaJson],
  );

  const copy = useCallback((text: string, field: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    });
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
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
              {detail.summary.method && <MethodBadge method={detail.summary.method} />}
              {detail.summary.pathTemplate && (
                <span className="font-mono text-[11px] text-muted-foreground/60">
                  {detail.summary.pathTemplate}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 space-y-4">
          {/* Description */}
          {detail.summary.description && (
            <Markdown>{detail.summary.description}</Markdown>
          )}

          {/* Type signatures */}
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <DocumentPanel title="Input" body={detail.summary.fullInputType ?? null} lang="typescript" empty="No input." />
            <DocumentPanel title="Output" body={detail.summary.fullOutputType ?? null} lang="typescript" empty="No output." />
          </div>

          {/* Schemas */}
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            <DocumentPanel title="Input schema" body={displayedCallSchema} empty="No input schema." compact />
            <DocumentPanel title="Output schema" body={displayedResultSchema} empty="No output schema." compact />
            {detail.exampleCallJson && (
              <DocumentPanel title="Example request" body={detail.exampleCallJson} empty="" compact />
            )}
            {detail.exampleResultJson && (
              <DocumentPanel title="Example response" body={detail.exampleResultJson} empty="" compact />
            )}
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
          className="flex items-center gap-2 max-w-2xl"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmitQuery(draftQuery.trim());
          }}
        >
          <div className="relative flex-1">
            <IconSearch className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
            <input
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="Search tools\u2026"
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/30"
            />
          </div>
          <Button type="submit" size="sm">Search</Button>
        </form>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-4">
        <LoadableBlock loadable={props.discovery} loading="Searching\u2026">
          {(result) =>
            result.query.length === 0 ? (
              <EmptyState
                title="Search your tools"
                description="Type a query to find matching tools across this source."
              />
            ) : result.results.length === 0 ? (
              <EmptyState
                title="No results"
                description="Try different search terms."
              />
            ) : (
              <div className="max-w-3xl space-y-2">
                {result.results.map((item, index) => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => props.onOpenTool(item.path)}
                    className="group w-full rounded-lg border border-border bg-card/60 p-3.5 text-left transition-all hover:border-primary/30 hover:shadow-sm"
                  >
                    <div className="flex items-center justify-between gap-3 mb-1.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-mono tabular-nums text-muted-foreground/60">
                          {index + 1}
                        </span>
                        <h4 className="truncate font-mono text-[13px] font-medium text-foreground group-hover:text-primary transition-colors">
                          {item.path}
                        </h4>
                      </div>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/50">
                        {item.score.toFixed(2)}
                      </span>
                    </div>
                    {item.description && (
                      <p className="text-[12px] text-muted-foreground leading-relaxed line-clamp-2">
                        {item.description}
                      </p>
                    )}
                  </button>
                ))}
              </div>
            )
          }
        </LoadableBlock>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

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
