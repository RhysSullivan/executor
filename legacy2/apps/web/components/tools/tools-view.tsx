"use client";

import { useAtomValue } from "@effect-atom/atom-react";
import { Result } from "@effect-atom/atom";
import type { Source, SourceId } from "@executor-v2/schema";
import type { SourceToolSummary } from "@executor-v2/management-api/tools/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";

import { useWorkspace } from "../../lib/hooks/use-workspace";
import {
  sourcesByWorkspace,
  toolDetailResult,
  workspaceToolsByWorkspace,
} from "../../lib/control-plane/atoms";
import { sourceToLegacyRecord, type LegacyToolSourceRecord } from "../../lib/control-plane/legacy-source";
import { ToolSchemaSection } from "./schema-fields";
import { getAddMcpInstallConfig } from "./install-configs";
import { resolveSchemaJsonWithRefHints } from "../../lib/tool/openapi-schema-refs";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { SourceManagementPanel } from "./source-management-panel";
import { sourceFaviconSeedUrl } from "../../lib/tools/source-helpers";
import { SourceFavicon, DefaultSourceIcon } from "./source-favicon";

// ---------------------------------------------------------------------------
// Streamdown code plugin (Shiki dual-theme syntax highlighting)
// ---------------------------------------------------------------------------

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolItem = SourceToolSummary;

type FolderGroup = {
  key: string;
  label: string;
  /** Dot-delimited full folder path (e.g. "repos.actions") */
  path: string;
  /** Tools directly under this folder */
  tools: ReadonlyArray<ToolItem>;
  /** Nested subfolders */
  children: ReadonlyArray<FolderGroup>;
  /** Total tool count including descendants */
  toolCount: number;
};

type SourceGroup = {
  sourceId: SourceId;
  sourceName: string;
  sourceKind: string;
  /** Tools that don't belong to any folder (promoted to source level) */
  directTools: ReadonlyArray<ToolItem>;
  /** Folder tree */
  folders: ReadonlyArray<FolderGroup>;
  /** Total tool count across all folders + direct */
  toolCount: number;
};

// ---------------------------------------------------------------------------
// Search helpers (ported from old executor explorer-derived.ts)
// ---------------------------------------------------------------------------

const splitSearchTerms = (value: string): string[] =>
  value
    .trim()
    .toLowerCase()
    .split(/[\s\-_./]+/)
    .filter((term) => term.length > 0);

const toolMatchesSearch = (tool: ToolItem, terms: string[]): boolean => {
  if (terms.length === 0) return true;

  const corpus = [
    tool.name,
    tool.sourceName,
    tool.toolId,
    tool.method,
    tool.path,
    tool.description ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return terms.every((term) => corpus.includes(term));
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Grouping - Source > Folder tree > Tool
// ---------------------------------------------------------------------------

/**
 * Build folder path segments from URL path:
 * - strip dynamic params ({id}, :id)
 * - strip common leading prefixes (v1, api, rest)
 * - folder path = all tokens except last; if only one token, use that token
 */
function deriveFolderSegments(path: string): string[] {
  const normalizedPath = path.replace(
    /^(get|post|put|patch|delete|head|options|trace)\s+/i,
    "",
  );

  // New registry paths are namespaced identifiers (e.g. "cloudflare_api_123.tool-id"),
  // not URL paths. Treat them as direct tools to avoid one-folder-per-tool noise.
  if (!normalizedPath.includes("/")) {
    return [];
  }

  const segments = normalizedPath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => !segment.startsWith("{") && !segment.startsWith(":"))
    .map((segment) => segment.toLowerCase());

  const skipLeading = new Set(["v1", "v2", "v3", "v4", "api", "rest", "graphql"]);
  const meaningful = [...segments];
  while (meaningful.length > 0 && skipLeading.has(meaningful[0]!)) {
    meaningful.shift();
  }

  if (meaningful.length === 0) {
    return [];
  }

  if (meaningful.length === 1) {
    return [meaningful[0]!];
  }

  return meaningful.slice(0, -1);
}

const sortToolsForGroup = (a: ToolItem, b: ToolItem): number => {
  if (a.path !== b.path) {
    return a.path.localeCompare(b.path);
  }
  return a.name.localeCompare(b.name);
};

type MutableFolderNode = {
  key: string;
  label: string;
  path: string;
  tools: ToolItem[];
  children: Map<string, MutableFolderNode>;
};

const finalizeFolderNode = (node: MutableFolderNode): FolderGroup => {
  const children = Array.from(node.children.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(finalizeFolderNode);

  const tools = [...node.tools].sort(sortToolsForGroup);
  const toolCount = tools.length + children.reduce((sum, child) => sum + child.toolCount, 0);

  return {
    key: node.key,
    label: node.label,
    path: node.path,
    tools,
    children,
    toolCount,
  };
};

const buildGroups = (
  sources: ReadonlyArray<Source>,
  tools: ReadonlyArray<ToolItem>,
): SourceGroup[] => {
  const bySource = new Map<string, ToolItem[]>();
  for (const tool of tools) {
    const list = bySource.get(tool.sourceId);
    if (list) {
      list.push(tool);
    } else {
      bySource.set(tool.sourceId, [tool]);
    }
  }

  const sourceById = new Map<string, Source>();
  for (const source of sources) {
    sourceById.set(source.id, source);
  }

  const sourceIds = new Set<string>();
  for (const source of sources) {
    sourceIds.add(source.id);
  }
  for (const sourceId of bySource.keys()) {
    sourceIds.add(sourceId);
  }

  const result: SourceGroup[] = [];

  for (const sourceId of sourceIds) {
    const sourceTools = bySource.get(sourceId) ?? [];
    const source = sourceById.get(sourceId);
    const first = sourceTools[0];
    const rootFolders = new Map<string, MutableFolderNode>();
    const direct: ToolItem[] = [];

    for (const tool of sourceTools) {
      const parts = deriveFolderSegments(tool.operationPath ?? tool.path);
      if (parts.length === 0) {
        direct.push(tool);
        continue;
      }

      let currentChildren = rootFolders;
      const pathParts: string[] = [];

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        pathParts.push(part);
        const pathKey = pathParts.join("/");

        let node = currentChildren.get(part);
        if (!node) {
          node = {
            key: `${sourceId}:folder:${pathKey}`,
            label: part,
            path: pathParts.join("."),
            tools: [],
            children: new Map<string, MutableFolderNode>(),
          };
          currentChildren.set(part, node);
        }

        if (i === parts.length - 1) {
          node.tools.push(tool);
        } else {
          currentChildren = node.children;
        }
      }
    }

    const folders = Array.from(rootFolders.values())
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(finalizeFolderNode);

    result.push({
      sourceId: sourceId as SourceId,
      sourceName: source?.name ?? first?.sourceName ?? sourceId,
      sourceKind: source?.kind ?? first?.sourceKind ?? "openapi",
      directTools: [...direct].sort(sortToolsForGroup),
      folders,
      toolCount: sourceTools.length,
    });
  }

  // Match old behavior: bigger source groups first, then name
  return result.sort((a, b) => {
    if (a.toolCount !== b.toolCount) {
      return b.toolCount - a.toolCount;
    }
    return a.sourceName.toLowerCase().localeCompare(b.sourceName.toLowerCase());
  });
};

// ---------------------------------------------------------------------------
// Method badge color
// ---------------------------------------------------------------------------

const methodColor = (method: string): string => {
  switch (method.toUpperCase()) {
    case "GET":
      return "text-emerald-700 bg-emerald-500/10 border-emerald-600/20";
    case "POST":
      return "text-sky-700 bg-sky-500/10 border-sky-600/20";
    case "PUT":
    case "PATCH":
      return "text-amber-700 bg-amber-500/10 border-amber-600/20";
    case "DELETE":
      return "text-rose-700 bg-rose-500/10 border-rose-600/20";
    default:
      return "text-muted-foreground bg-muted border-border";
  }
};

const inferServerName = (workspaceId: string): string =>
  `executor-v2-${workspaceId.slice(0, 8).toLowerCase()}`;

// ---------------------------------------------------------------------------
// Streamdown description wrapper — Tailwind prose via [&_...] selectors
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION_CLASSES = [
  "text-[13px] leading-relaxed text-muted-foreground",
  // paragraphs
  "[&_p]:mb-[0.4em] [&_p:last-child]:mb-0",
  // bold
  "[&_strong]:text-foreground [&_strong]:font-semibold",
  "[&_b]:text-foreground [&_b]:font-semibold",
  // inline code
  "[&_code]:font-mono [&_code]:text-xs [&_code]:bg-muted [&_code]:border [&_code]:border-border",
  "[&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-px [&_code]:text-primary",
  // pre blocks
  "[&_pre]:bg-muted [&_pre]:border [&_pre]:border-border [&_pre]:rounded-md",
  "[&_pre]:px-3 [&_pre]:py-2 [&_pre]:overflow-x-auto [&_pre]:my-2 [&_pre]:text-xs [&_pre]:leading-relaxed",
  "[&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0 [&_pre_code]:text-inherit",
  // links
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_a]:decoration-primary/30 hover:[&_a]:decoration-primary/80",
  // lists
  "[&_ul]:pl-5 [&_ul]:my-1.5 [&_ol]:pl-5 [&_ol]:my-1.5",
  "[&_li]:mb-0.5 [&_li_::marker]:text-muted-foreground",
  // tables
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_table]:my-2",
  "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:bg-muted [&_th]:font-semibold [&_th]:text-foreground",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-left [&_td]:bg-background",
  // headings
  "[&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-[15px]",
  "[&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-sm",
  "[&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-[13px]",
  "[&_h4]:font-semibold [&_h4]:text-foreground [&_h4]:mt-2 [&_h4]:mb-1 [&_h4]:text-[13px]",
  // blockquote
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:my-1.5 [&_blockquote]:text-muted-foreground",
  // hr
  "[&_hr]:border-0 [&_hr]:border-t [&_hr]:border-border [&_hr]:my-2",
  // images
  "[&_img]:max-w-full [&_img]:rounded",
].join(" ");

// ---------------------------------------------------------------------------
// ToolsView (main export)
// ---------------------------------------------------------------------------

export function ToolsView(props: {
  mcpBaseUrl: string | null;
}) {
  const { workspaceId } = useWorkspace();

  // --- Data ---
  const workspaceTools = useAtomValue(workspaceToolsByWorkspace(workspaceId));
  const sources = useAtomValue(sourcesByWorkspace(workspaceId));

  // Build sourceId -> favicon seed URL lookup from source config/endpoint
  const sourceEndpoints = useMemo(() => {
    const map = new Map<string, string>();
    for (const source of sources.items) {
      const seedUrl = sourceFaviconSeedUrl(source);
      if (seedUrl) {
        map.set(source.id, seedUrl);
      }
    }
    return map;
  }, [sources.items]);

  // --- Local state ---
  const [search, setSearch] = useState("");
  const [focusedToolId, setFocusedToolId] = useState<string | null>(null);
  const [focusedSourceId, setFocusedSourceId] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [copiedInstallCommand, setCopiedInstallCommand] = useState(false);
  const [showCatalog, setShowCatalog] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // --- Derived data ---
  const searchTerms = useMemo(() => splitSearchTerms(search), [search]);

  const filteredTools = useMemo(
    () => workspaceTools.items.filter((tool) => toolMatchesSearch(tool, searchTerms)),
    [workspaceTools.items, searchTerms],
  );

  const groups = useMemo(
    () => buildGroups(sources.items, filteredTools),
    [sources.items, filteredTools],
  );

  const focusedTool = useMemo(
    () =>
      focusedToolId
        ? workspaceTools.items.find((t) => t.toolId === focusedToolId) ?? null
        : null,
    [focusedToolId, workspaceTools.items],
  );

  const totalToolCount = workspaceTools.items.length;

  const mcpUrl = useMemo(() => {
    if (props.mcpBaseUrl) {
      const configured = new URL(props.mcpBaseUrl);
      configured.pathname = "/v1/mcp";
      configured.searchParams.set("workspaceId", workspaceId);
      return configured.toString();
    }

    if (typeof window === "undefined") {
      return `http://127.0.0.1:8788/v1/mcp?workspaceId=${encodeURIComponent(workspaceId)}`;
    }

    const url = new URL("/v1/mcp", window.location.origin);
    url.searchParams.set("workspaceId", workspaceId);
    return url.toString();
  }, [props.mcpBaseUrl, workspaceId]);

  const installConfig = useMemo(
    () => getAddMcpInstallConfig(mcpUrl, inferServerName(workspaceId)),
    [mcpUrl, workspaceId],
  );

  const copyInstallCommand = useCallback(() => {
    void navigator.clipboard.writeText(installConfig.content).then(() => {
      setCopiedInstallCommand(true);
      setTimeout(() => setCopiedInstallCommand(false), 1500);
    });
  }, [installConfig.content]);

  // --- Collect all expandable keys ---
  const allKeys = useMemo(() => {
    const keys: string[] = [];

    const walkFolders = (folders: ReadonlyArray<FolderGroup>) => {
      for (const folder of folders) {
        keys.push(folder.key);
        walkFolders(folder.children);
      }
    };

    for (const group of groups) {
      keys.push(`source:${group.sourceId}`);
      walkFolders(group.folders);
    }

    return keys;
  }, [groups]);

  // --- Auto-expand all sources on first load ---
  useEffect(() => {
    if (groups.length === 0) return;
    setExpandedKeys((current) => {
      const next = new Set(current);
      let changed = false;
      for (const group of groups) {
        const key = `source:${group.sourceId}`;
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [groups]);

  // Auto-expand all when searching (including nested folders)
  useEffect(() => {
    if (searchTerms.length > 0) {
      setExpandedKeys(new Set(allKeys));
    }
  }, [searchTerms.length, allKeys]);

  // Auto-focus first tool if nothing focused and catalog is dismissed
  useEffect(() => {
    if (focusedToolId === null && filteredTools.length > 0 && !showCatalog && !focusedSourceId) {
      setFocusedToolId(filteredTools[0]!.toolId);
    }
  }, [focusedToolId, filteredTools, showCatalog, focusedSourceId]);

  // Clear focus if focused tool is filtered out
  useEffect(() => {
    if (focusedToolId && !filteredTools.some((t) => t.toolId === focusedToolId)) {
      setFocusedToolId(filteredTools[0]?.toolId ?? null);
    }
  }, [focusedToolId, filteredTools]);

  // --- Derived: focused source record for editing ---
  const focusedSourceRecord: LegacyToolSourceRecord | undefined = useMemo(() => {
    if (!focusedSourceId) return undefined;
    const raw = sources.items.find((s) => s.id === focusedSourceId);
    return raw ? sourceToLegacyRecord(raw) : undefined;
  }, [focusedSourceId, sources.items]);

  // --- Handlers ---
  const handleFocusTool = useCallback((toolId: string) => {
    setFocusedToolId(toolId);
    setFocusedSourceId(null);
    setShowCatalog(false);
  }, []);

  const handleFocusSource = useCallback((sourceId: string) => {
    setFocusedSourceId(sourceId);
    setFocusedToolId(null);
    setShowCatalog(false);
  }, []);

  const handleShowCatalog = useCallback(() => {
    setShowCatalog(true);
    setFocusedToolId(null);
    setFocusedSourceId(null);
  }, []);

  const handleSourceDone = useCallback(() => {
    setFocusedSourceId(null);
    setShowCatalog(false);
    // Auto-select first tool if available
    if (filteredTools.length > 0) {
      setFocusedToolId(filteredTools[0]!.toolId);
    }
  }, [filteredTools]);

  const toggleKey = useCallback((key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Keyboard: focus search with /
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === "Escape") {
        searchInputRef.current?.blur();
        if (search.length > 0) {
          setSearch("");
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [search]);

  // --- Render ---
  const isLoading = workspaceTools.state === "loading";

  return (
    <div className="flex h-full min-h-0 max-h-screen overflow-hidden">
      {/* ---------------------------------------------------------------- */}
      {/* Left panel: source-grouped tool tree                             */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-card/50 lg:w-80 xl:w-[22rem]">
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Tools</h2>
            {!isLoading && (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {filteredTools.length !== totalToolCount
                  ? `${filteredTools.length} / ${totalToolCount}`
                  : totalToolCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isLoading ? (
              <span className="text-[11px] text-muted-foreground">Loading...</span>
            ) : (
              <Button
                type="button"
                variant={showCatalog ? "secondary" : "outline"}
                size="sm"
                className="h-6 text-[11px] px-2"
                onClick={handleShowCatalog}
              >
                + Source
              </Button>
            )}
          </div>
        </div>

        <div className="shrink-0 border-b border-border px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{installConfig.description}</p>
          <div className="mt-2 rounded-md border border-border bg-muted/30 p-2.5">
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-foreground">
              <code>{installConfig.content}</code>
            </pre>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-[11px]"
              onClick={copyInstallCommand}
            >
              {copiedInstallCommand ? "Copied" : "Copy command"}
            </Button>
          </div>
        </div>

        {/* Search bar */}
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="relative">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
            >
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={isLoading ? "Loading..." : `Search ${totalToolCount} tools...`}
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring/40"
            />
            {search.length > 0 && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <svg viewBox="0 0 16 16" fill="none" className="size-3">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
            {search.length === 0 && (
              <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1 py-px text-[10px] text-muted-foreground">
                /
              </kbd>
            )}
          </div>
        </div>

        {/* Tool tree */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <div className="space-y-1 p-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 rounded px-2.5 py-1.5">
                  <div className="h-3 w-3 animate-pulse rounded bg-muted" />
                  <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${50 + Math.random() * 40}%` }} />
                </div>
              ))}
            </div>
          )}

          {!isLoading && workspaceTools.state === "error" && (
            <div className="p-4 text-center text-sm text-destructive">
              Failed to load tools {workspaceTools.message}
            </div>
          )}

          {!isLoading && groups.length === 0 && workspaceTools.state !== "error" && (
            <div className="p-4 text-center text-[13px] text-muted-foreground">
              {searchTerms.length > 0
                ? "No tools match your search"
                : "No sources available"}
            </div>
          )}

          <div className="p-1.5">
            {groups.map((group) => (
              <SourceGroupNode
                key={group.sourceId}
                group={group}
                expandedKeys={expandedKeys}
                onToggle={toggleKey}
                focusedToolId={focusedToolId}
                focusedSourceId={focusedSourceId}
                onFocusTool={handleFocusTool}
                onSourceClick={handleFocusSource}
                search={search}
                sourceEndpoint={sourceEndpoints.get(group.sourceId)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Right panel: tool detail                                         */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {showCatalog ? (
          <SourceManagementPanel onDone={handleSourceDone} />
        ) : focusedSourceRecord ? (
          <SourceManagementPanel
            editSource={focusedSourceRecord}
            onDone={handleSourceDone}
          />
        ) : focusedTool ? (
          <ToolDetailPanel
            tool={focusedTool}
            workspaceId={workspaceId}
            sourceEndpoint={sourceEndpoints.get(focusedTool.sourceId)}
          />
        ) : (
          <ToolDetailEmpty isLoading={isLoading} hasTools={totalToolCount > 0} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SourceGroupNode - collapsible source node with nested folders
// ---------------------------------------------------------------------------

function SourceGroupNode({
  group,
  expandedKeys,
  onToggle,
  focusedToolId,
  focusedSourceId,
  onFocusTool,
  onSourceClick,
  search,
  sourceEndpoint,
}: {
  group: SourceGroup;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
  focusedToolId: string | null;
  focusedSourceId: string | null;
  onFocusTool: (toolId: string) => void;
  onSourceClick: (sourceId: string) => void;
  search: string;
  sourceEndpoint?: string;
}) {
  const sourceKey = `source:${group.sourceId}`;
  const isExpanded = expandedKeys.has(sourceKey);
  const hasFolders = group.folders.length > 0;
  const isSourceFocused = focusedSourceId === group.sourceId;

  const handleHeaderClick = () => {
    // Toggle expand and also select this source for editing
    if (!isExpanded) {
      onToggle(sourceKey);
    }
    onSourceClick(group.sourceId);
  };

  return (
    <div className="mb-0.5">
      {/* Source header */}
      <button
        type="button"
        onClick={handleHeaderClick}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
          isSourceFocused
            ? "bg-primary/10 border-l-2 border-l-primary -ml-px"
            : "hover:bg-accent/60",
        )}
      >
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onToggle(sourceKey); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onToggle(sourceKey); } }}
          className="shrink-0 rounded p-0.5 hover:bg-accent/40"
        >
          <Chevron expanded={isExpanded} />
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center">
          <SourceFavicon
            endpoint={sourceEndpoint}
            kind={group.sourceKind}
            className="size-4 text-muted-foreground/70"
          />
        </span>
        <span className="flex-1 truncate text-[13px] font-semibold text-foreground/90">
          {group.sourceName}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground/60">
          {group.toolCount}
        </span>
      </button>

      {/* Children: folders and/or direct tools */}
      {isExpanded && (
        <div className="ml-3 border-l border-border/50 pl-0.5">
          {group.toolCount === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground/60">
              {search.trim().length > 0
                ? "No matching tools in this source"
                : "No tools yet"}
            </div>
          )}

          {hasFolders &&
            group.folders.map((folder) => (
              <FolderGroupNode
                key={folder.key}
                folder={folder}
                expandedKeys={expandedKeys}
                onToggle={onToggle}
                focusedToolId={focusedToolId}
                onFocusTool={onFocusTool}
                search={search}
              />
            ))}

          {/* Direct tools (no folder) */}
          {group.directTools.map((tool) => (
            <ToolListItem
              key={tool.toolId}
              tool={tool}
              focused={tool.toolId === focusedToolId}
              onFocus={onFocusTool}
              search={search}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FolderGroupNode - recursive collapsible folder within a source tree
// ---------------------------------------------------------------------------

function FolderGroupNode({
  folder,
  expandedKeys,
  onToggle,
  focusedToolId,
  onFocusTool,
  search,
}: {
  folder: FolderGroup;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
  focusedToolId: string | null;
  onFocusTool: (toolId: string) => void;
  search: string;
}) {
  const isExpanded = expandedKeys.has(folder.key);

  return (
    <div className="mb-px">
      <button
        type="button"
        onClick={() => onToggle(folder.key)}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors",
          "hover:bg-accent/40",
        )}
      >
        <Chevron expanded={isExpanded} />
        <svg viewBox="0 0 16 16" fill="none" className="size-3 shrink-0 text-muted-foreground/40">
          <path d="M2 4h5l2 2h5v7H2V4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        <span className="flex-1 truncate text-[12px] font-medium text-foreground/75">
          {folder.label}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/50">
          {folder.toolCount}
        </span>
      </button>

      {isExpanded && (
        <div className="ml-3 border-l border-border/30 pl-0.5">
          {folder.children.map((child) => (
            <FolderGroupNode
              key={child.key}
              folder={child}
              expandedKeys={expandedKeys}
              onToggle={onToggle}
              focusedToolId={focusedToolId}
              onFocusTool={onFocusTool}
              search={search}
            />
          ))}

          {folder.tools.map((tool) => (
            <ToolListItem
              key={tool.toolId}
              tool={tool}
              focused={tool.toolId === focusedToolId}
              onFocus={onFocusTool}
              search={search}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chevron toggle icon
// ---------------------------------------------------------------------------

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={cn(
        "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150",
        expanded && "rotate-90",
      )}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ToolListItem - single tool row in the left tree
// ---------------------------------------------------------------------------

function ToolListItem({
  tool,
  focused,
  onFocus,
  search,
}: {
  tool: ToolItem;
  focused: boolean;
  onFocus: (toolId: string) => void;
  search: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  // Scroll focused tool into view
  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onFocus(tool.toolId)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
        focused
          ? "bg-primary/10 text-foreground border-l-2 border-l-primary -ml-px"
          : "hover:bg-accent/40 text-foreground/75 hover:text-foreground",
      )}
    >
      <svg viewBox="0 0 16 16" fill="none" className="size-3 shrink-0 text-muted-foreground/50">
        <path d="M4 8h8M8 4v8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
      </svg>
      <span className="flex-1 truncate font-mono text-[12px]">
        {highlightMatch(tool.name, search)}
      </span>
      <span
        className={cn(
          "shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase leading-tight border",
          methodColor(tool.method),
        )}
      >
        {tool.method}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Highlight search match in text
// ---------------------------------------------------------------------------

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

  const parts: Array<{ text: string; highlighted: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (cursor < start) {
      parts.push({ text: text.slice(cursor, start), highlighted: false });
    }
    parts.push({ text: text.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false });
  }

  return (
    <>
      {parts.map((part, i) =>
        part.highlighted ? (
          <mark key={i} className="rounded-sm bg-primary/15 text-foreground px-px">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ToolDetailPanel - right side detail view
// ---------------------------------------------------------------------------

function ToolDetailPanel({
  tool,
  workspaceId,
  sourceEndpoint,
}: {
  tool: ToolItem;
  workspaceId: string;
  sourceEndpoint?: string;
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string, field: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    });
  }, []);

  // Fetch tool detail (includes schema data) when a tool is focused
  const detailAtom = useMemo(
    () =>
      toolDetailResult({
        workspaceId: workspaceId as import("@executor-v2/schema").WorkspaceId,
        sourceId: tool.sourceId,
        operationHash: tool.operationHash,
      }),
    [workspaceId, tool.sourceId, tool.operationHash],
  );
  const detailResult = useAtomValue(detailAtom);

  const schemaData = useMemo(() => {
    if (Result.isSuccess(detailResult) && detailResult.value) {
      const detail = detailResult.value;
      const refHintTableJson = detail.refHintTableJson;

      return {
        inputSchemaJson: resolveSchemaJsonWithRefHints(
          detail.inputSchemaJson,
          refHintTableJson,
        ),
        outputSchemaJson: resolveSchemaJsonWithRefHints(
          detail.outputSchemaJson,
          refHintTableJson,
        ),
      };
    }
    return null;
  }, [detailResult]);

  const schemaLoading = Result.isInitial(detailResult) || Result.isWaiting(detailResult);

  const hasSchema = Boolean(
    schemaData && (schemaData.inputSchemaJson || schemaData.outputSchemaJson),
  );

  const schemaUnavailable =
    !schemaLoading
    && Result.isSuccess(detailResult)
    && detailResult.value !== null
    && !hasSchema;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Sticky header */}
      <div className="shrink-0 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="flex items-start gap-3 px-6 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <SourceFavicon
              endpoint={sourceEndpoint}
              kind={tool.sourceKind}
              className="size-5 text-primary"
              size={20}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold text-foreground">
                {tool.name}
              </h1>
              <CopyButton
                text={tool.name}
                field="name"
                copiedField={copiedField}
                onCopy={copyToClipboard}
              />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase border",
                  methodColor(tool.method),
                )}
              >
                {tool.method}
              </span>
              <span className="font-mono text-[12px] text-muted-foreground break-all">
                {tool.path}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-5 space-y-6">
          {/* Description */}
          {tool.description && (
            <section>
              <SectionLabel>Description</SectionLabel>
              <div className={TOOL_DESCRIPTION_CLASSES}>
                <Streamdown plugins={{ code: codePlugin }} controls={{ code: true }}>
                  {tool.description}
                </Streamdown>
              </div>
            </section>
          )}

          {/* Schema: input/output types */}
          {schemaLoading ? (
            <section>
              <SectionLabel>Schema</SectionLabel>
              <div className="space-y-2">
                <div className="h-4 w-32 rounded bg-muted animate-pulse" />
                <div className="h-20 w-full rounded-md border border-border bg-muted/30 animate-pulse" />
              </div>
            </section>
          ) : hasSchema && schemaData ? (
            <ToolSchemaSection
              inputSchemaJson={schemaData.inputSchemaJson}
              outputSchemaJson={schemaData.outputSchemaJson}
            />
          ) : schemaUnavailable ? (
            <section>
              <SectionLabel>Schema</SectionLabel>
              <p className="text-xs text-muted-foreground">
                Input/output schema metadata is not available for this tool in the current backend.
              </p>
            </section>
          ) : null}

          {/* Metadata grid */}
          <section>
            <SectionLabel>Details</SectionLabel>
            <div className="rounded-lg border border-border bg-card/60">
              <MetadataRow label="Tool ID" mono copyable onCopy={copyToClipboard} copiedField={copiedField}>
                {tool.toolId}
              </MetadataRow>
              <MetadataRow label="Source" bordered>
                <div className="flex items-center gap-1.5">
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    <SourceFavicon
                      endpoint={sourceEndpoint}
                      kind={tool.sourceKind}
                      className="size-3.5 text-muted-foreground/60"
                      size={14}
                    />
                  </span>
                  <span>{tool.sourceName}</span>
                </div>
              </MetadataRow>
              <MetadataRow label="Kind" bordered>
                <Badge variant="outline" className="text-[10px]">
                  {tool.sourceKind}
                </Badge>
              </MetadataRow>
              <MetadataRow label="Method" bordered>
                <span
                  className={cn(
                    "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase border",
                    methodColor(tool.method),
                  )}
                >
                  {tool.method}
                </span>
              </MetadataRow>
              <MetadataRow label="Path" bordered mono copyable onCopy={copyToClipboard} copiedField={copiedField}>
                {tool.path}
              </MetadataRow>
              <MetadataRow label="Operation Hash" bordered mono copyable onCopy={copyToClipboard} copiedField={copiedField}>
                {tool.operationHash}
              </MetadataRow>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail sub-components
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
      {children}
    </h3>
  );
}

function CopyButton({
  text,
  field,
  copiedField,
  onCopy,
}: {
  text: string;
  field: string;
  copiedField: string | null;
  onCopy: (text: string, field: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCopy(text, field)}
      className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
      title={`Copy ${field}`}
    >
      {copiedField === field ? (
        <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
          <path d="M4 8.5l3 3 5-6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
          <rect x="5" y="5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M11 3H4a1 1 0 00-1 1v7" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </button>
  );
}

function MetadataRow({
  label,
  children,
  bordered,
  mono,
  copyable,
  onCopy,
  copiedField,
}: {
  label: string;
  children: React.ReactNode;
  bordered?: boolean;
  mono?: boolean;
  copyable?: boolean;
  onCopy?: (text: string, field: string) => void;
  copiedField?: string | null;
}) {
  const textContent = typeof children === "string" ? children : null;

  return (
    <div
      className={cn(
        "group flex items-start gap-3 px-3 py-2.5",
        bordered && "border-t border-border/60",
      )}
    >
      <span className="w-28 shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "flex-1 min-w-0 break-all text-[12px] text-foreground/85",
          mono && "font-mono",
        )}
      >
        {children}
      </span>
      {copyable && textContent && onCopy && (
        <button
          type="button"
          onClick={() => onCopy(textContent, label)}
          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground/40 hover:text-muted-foreground"
          title={`Copy ${label.toLowerCase()}`}
        >
          {copiedField === label ? (
            <svg viewBox="0 0 16 16" fill="none" className="size-3">
              <path d="M4 8.5l3 3 5-6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="size-3">
              <rect x="5" y="5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
              <path d="M11 3H4a1 1 0 00-1 1v7" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty detail state
// ---------------------------------------------------------------------------

function ToolDetailEmpty({ isLoading, hasTools }: { isLoading: boolean; hasTools: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <svg viewBox="0 0 48 48" fill="none" className="mx-auto mb-3 size-12 text-muted-foreground/20">
          <rect x="6" y="6" width="36" height="36" rx="4" stroke="currentColor" strokeWidth="1.5" />
          <path d="M16 18h16M16 24h12M16 30h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <p className="text-[13px] text-muted-foreground/60">
          {isLoading
            ? "Loading tools..."
            : hasTools
              ? "Select a tool to view its details"
              : "No tools available"}
        </p>
        {!isLoading && hasTools && (
          <p className="mt-1 text-[11px] text-muted-foreground/40">
            Browse the tree on the left or press <kbd className="rounded border border-border bg-muted px-1 py-px text-[10px]">/</kbd> to search
          </p>
        )}
      </div>
    </div>
  );
}
