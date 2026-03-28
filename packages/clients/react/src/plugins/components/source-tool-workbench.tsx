import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Loadable } from "../../core/types";
import {
  usePrefetchToolDetail,
} from "../../hooks/sources";
import type {
  SourceInspection,
  SourceInspectionToolDetail,
} from "@executor/platform-sdk/schema";
import { MethodBadge } from "./badge";
import { CodeBlock } from "./code-block";
import { DocumentPanel } from "./document-panel";
import { EmptyState, LoadableBlock } from "./loadable";
import { Markdown } from "./markdown";
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconCopy,
  IconFolder,
  IconSearch,
  IconTool,
} from "./icons";
import { cn } from "../lib/cn";

type ToolTreeNode = {
  segment: string;
  tool?: SourceInspectionToolDetail["summary"] | SourceInspection["tools"][number];
  children: Map<string, ToolTreeNode>;
};

export type SourceToolDiscoveryResult = {
  query: string;
  results: ReadonlyArray<{
    path: string;
    score: number;
    description?: string | null;
  }>;
};

export type SourceToolDetailPanelProps = {
  detail: SourceInspectionToolDetail;
  renderHeaderMeta?: (detail: SourceInspectionToolDetail) => ReactNode;
  renderSchemaExtras?: (detail: SourceInspectionToolDetail) => ReactNode;
};

export type SourceToolModelWorkbenchProps = {
  bundle: SourceInspection;
  detail: Loadable<SourceInspectionToolDetail | null>;
  selectedToolPath: string | null;
  onSelectTool: (toolPath: string) => void;
  sourceId: string;
  renderDetail?: (detail: SourceInspectionToolDetail) => ReactNode;
};

export type SourceToolDiscoveryPanelProps<
  TResult extends SourceToolDiscoveryResult = SourceToolDiscoveryResult,
> = {
  discovery: Loadable<TResult>;
  initialQuery: string;
  onSubmitQuery: (query: string) => void;
  onOpenTool: (toolPath: string) => void;
};

const buildToolTree = (tools: SourceInspection["tools"]): ToolTreeNode => {
  const root: ToolTreeNode = {
    segment: "",
    children: new Map(),
  };

  for (const tool of tools) {
    const parts = tool.path.split(".");
    let node = root;

    for (const part of parts) {
      const existing = node.children.get(part);
      if (existing) {
        node = existing;
        continue;
      }

      const next: ToolTreeNode = {
        segment: part,
        children: new Map(),
      };
      node.children.set(part, next);
      node = next;
    }

    node.tool = tool;
  }

  return root;
};

const countToolLeaves = (node: ToolTreeNode): number => {
  let count = node.tool ? 1 : 0;
  for (const child of node.children.values()) {
    count += countToolLeaves(child);
  }
  return count;
};

const highlightMatch = (text: string, search: string) => {
  if (!search.trim()) {
    return text;
  }

  const terms = search.trim().toLowerCase().split(/\s+/);
  const lowerText = text.toLowerCase();
  const ranges: Array<[number, number]> = [];

  for (const term of terms) {
    let index = 0;
    while (index < lowerText.length) {
      const found = lowerText.indexOf(term, index);
      if (found === -1) {
        break;
      }
      ranges.push([found, found + term.length]);
      index = found + 1;
    }
  }

  if (ranges.length === 0) {
    return text;
  }

  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [ranges[0]!];
  for (let index = 1; index < ranges.length; index++) {
    const last = merged[merged.length - 1]!;
    const current = ranges[index]!;
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
      {parts.map((part, index) =>
        part.highlighted ? (
          <mark key={index} className="rounded-sm bg-primary/20 px-px text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
};

const CopyButton = (props: {
  text: string;
  field: string;
  copiedField: string | null;
  onCopy: (text: string, field: string) => void | Promise<void>;
}) => (
  <button
    type="button"
    onClick={() => {
      void props.onCopy(props.text, props.field);
    }}
    className="shrink-0 rounded p-1 text-muted-foreground/30 transition-colors hover:text-muted-foreground"
    title={`Copy ${props.field}`}
  >
    {props.copiedField === props.field ? <IconCheck /> : <IconCopy />}
  </button>
);

const SourceToolTree = (props: {
  tools: SourceInspection["tools"];
  selectedToolPath: string | null;
  onSelectTool: (path: string) => void;
  search: string;
  isFiltered: boolean;
  sourceId: string;
}) => {
  const tree = useMemo(() => buildToolTree(props.tools), [props.tools]);
  const prefetch = usePrefetchToolDetail();
  const entries = [...tree.children.values()].sort((left, right) =>
    left.segment.localeCompare(right.segment)
  );

  return (
    <div className="flex flex-col gap-px">
      {entries.map((node) => (
        <SourceToolTreeNodeView
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
};

const SourceToolTreeNodeView = (props: {
  node: ToolTreeNode;
  depth: number;
  selectedToolPath: string | null;
  onSelectTool: (path: string) => void;
  search: string;
  defaultOpen: boolean;
  sourceId: string;
  prefetch: ReturnType<typeof usePrefetchToolDetail>;
}) => {
  const {
    node,
    depth,
    selectedToolPath,
    onSelectTool,
    search,
    defaultOpen,
    sourceId,
    prefetch,
  } = props;
  const hasChildren = node.children.size > 0;
  const isLeaf = !!node.tool && !hasChildren;

  const hasSelectedDescendant = useMemo(() => {
    if (!selectedToolPath) {
      return false;
    }

    const check = (candidate: ToolTreeNode): boolean => {
      if (candidate.tool?.path === selectedToolPath) {
        return true;
      }

      for (const child of candidate.children.values()) {
        if (check(child)) {
          return true;
        }
      }

      return false;
    };

    return check(node);
  }, [node, selectedToolPath]);

  const [open, setOpen] = useState(defaultOpen || hasSelectedDescendant);

  useEffect(() => {
    if (defaultOpen || hasSelectedDescendant) {
      setOpen(true);
    }
  }, [defaultOpen, hasSelectedDescendant]);

  if (isLeaf) {
    return (
      <SourceToolListItem
        tool={node.tool as SourceInspection["tools"][number]}
        active={node.tool?.path === selectedToolPath}
        onSelect={() => onSelectTool(node.tool!.path)}
        search={search}
        depth={depth}
        sourceId={sourceId}
        prefetch={prefetch}
      />
    );
  }

  const paddingLeft = 8 + depth * 16;
  const sortedChildren = [...node.children.values()].sort((left, right) =>
    left.segment.localeCompare(right.segment)
  );
  const leafCount = countToolLeaves(node);

  return (
    <div>
      {node.tool ? (
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 rounded p-0.5 text-muted-foreground/30 hover:text-muted-foreground"
            style={{ marginLeft: paddingLeft }}
          >
            <IconChevron
              className={cn("shrink-0 transition-transform duration-150", open && "rotate-90")}
              style={{ width: 8, height: 8 }}
            />
          </button>
          <SourceToolListItem
            tool={node.tool as SourceInspection["tools"][number]}
            active={node.tool?.path === selectedToolPath}
            onSelect={() => onSelectTool(node.tool!.path)}
            search={search}
            depth={-1}
            className="flex-1 pl-1"
            sourceId={sourceId}
            prefetch={prefetch}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "group flex w-full items-center gap-1.5 rounded-md py-1 pr-2.5 text-[12px] transition-colors hover:bg-accent/40",
            open ? "text-foreground/80" : "text-muted-foreground/60",
          )}
          style={{ paddingLeft }}
        >
          <IconChevron
            className={cn(
              "shrink-0 text-muted-foreground/30 transition-transform duration-150",
              open && "rotate-90",
            )}
            style={{ width: 8, height: 8 }}
          />
          <IconFolder
            className={cn("shrink-0", open ? "text-primary/60" : "text-muted-foreground/30")}
            style={{ width: 12, height: 12 }}
          />
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
            className="absolute bottom-1 top-0 w-px bg-border/40"
            style={{ left: paddingLeft + 5 }}
            aria-hidden
          />
          {sortedChildren.map((child) => (
            <SourceToolTreeNodeView
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
};

const SourceToolListItem = (props: {
  tool: SourceInspection["tools"][number];
  active: boolean;
  onSelect: () => void;
  search: string;
  depth: number;
  className?: string;
  sourceId: string;
  prefetch: ReturnType<typeof usePrefetchToolDetail>;
}) => {
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
      onMouseEnter={() => {
        props.prefetch(props.sourceId, props.tool.path);
      }}
      onClick={props.onSelect}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md py-1.5 pr-2.5 text-left transition-colors",
        props.active
          ? "border-l-2 border-l-primary bg-primary/10 text-foreground"
          : "text-foreground/70 hover:bg-accent/50 hover:text-foreground",
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
};

export const SourceToolDetailPanel = (props: SourceToolDetailPanelProps) => {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const inputType = props.detail.contract.input.typeDeclaration
    ?? props.detail.contract.input.typePreview
    ?? null;
  const outputType = props.detail.contract.output.typeDeclaration
    ?? props.detail.contract.output.typePreview
    ?? null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="flex items-start gap-3 px-5 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <IconTool className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {props.detail.summary.path}
              </h3>
              <CopyButton
                text={props.detail.summary.path}
                field="path"
                copiedField={copiedField}
                onCopy={async (text, field) => {
                  await navigator.clipboard.writeText(text);
                  setCopiedField(field);
                  window.setTimeout(() => setCopiedField(null), 1500);
                }}
              />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {props.detail.summary.method && (
                <MethodBadge method={props.detail.summary.method} />
              )}
              {props.renderHeaderMeta?.(props.detail)}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-4 px-5 py-4">
          {props.detail.summary.description && (
            <Markdown>{props.detail.summary.description}</Markdown>
          )}

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <DocumentPanel title="Input" body={inputType} lang="typescript" empty="No input." />
            <DocumentPanel title="Output" body={outputType} lang="typescript" empty="No output." />
          </div>

          <DocumentPanel
            title="Call Signature"
            body={props.detail.contract.callSignature}
            lang="typescript"
            empty="No call signature."
          />

          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            <DocumentPanel
              title="Input schema"
              body={props.detail.contract.input.schemaJson}
              empty="No input schema."
              compact
            />
            <DocumentPanel
              title="Output schema"
              body={props.detail.contract.output.schemaJson}
              empty="No output schema."
              compact
            />
            {props.renderSchemaExtras?.(props.detail)}
          </div>

          {props.detail.sections.map((section, index) => (
            <section
              key={`${section.title}-${String(index)}`}
              className="overflow-hidden rounded-lg border border-border bg-card/60"
            >
              <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {section.title}
              </div>
              {section.kind === "facts" ? (
                <div className="grid gap-2 p-4">
                  {section.items.map((item) => (
                    <div key={`${section.title}-${item.label}`} className="text-sm">
                      <span className="text-muted-foreground">{item.label}:</span>{" "}
                      <span className={item.mono ? "font-mono text-xs text-foreground" : "text-foreground"}>
                        {item.value}
                      </span>
                    </div>
                  ))}
                </div>
              ) : section.kind === "markdown" ? (
                <div className="p-4">
                  <Markdown>{section.body}</Markdown>
                </div>
              ) : (
                section.body ? (
                  <CodeBlock
                    code={section.body}
                    lang={section.language}
                    className="max-h-[32rem]"
                  />
                ) : (
                  <div className="flex items-center justify-center p-6 text-[13px] text-muted-foreground/40">
                    No content.
                  </div>
                )
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};

export const SourceToolModelWorkbench = (
  props: SourceToolModelWorkbenchProps,
) => {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const filteredTools = useMemo(
    () =>
      props.bundle.tools.filter((tool) => {
        if (terms.length === 0) {
          return true;
        }

        const corpus = [
          tool.path,
          tool.method ?? "",
          tool.inputTypePreview ?? "",
          tool.outputTypePreview ?? "",
        ]
          .join(" ")
          .toLowerCase();

        return terms.every((term) => corpus.includes(term));
      }),
    [props.bundle.tools, terms],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        searchRef.current?.focus();
      }

      if (event.key === "Escape") {
        searchRef.current?.blur();
        if (search.length > 0) {
          setSearch("");
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [search]);

  const renderDetail = props.renderDetail ?? ((detail: SourceInspectionToolDetail) => (
    <SourceToolDetailPanel detail={detail} />
  ));

  return (
    <>
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-card/30 lg:w-80 xl:w-[22rem]">
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5">
            <IconSearch className="size-3.5 shrink-0 text-muted-foreground/40" />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Filter ${props.bundle.toolCount} tools...`}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/40"
            />
            {search.length > 0 ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="shrink-0 rounded p-0.5 text-muted-foreground/40 hover:text-foreground"
              >
                <IconClose />
              </button>
            ) : (
              <kbd className="shrink-0 rounded border border-border bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground/50">
                /
              </kbd>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto max-w-[300px]">
          {filteredTools.length === 0 ? (
            <div className="p-4 text-center text-[13px] text-muted-foreground/50">
              {terms.length > 0 ? "No tools match your filter" : "No tools available"}
            </div>
          ) : (
            <div className="p-1.5">
              <SourceToolTree
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

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <LoadableBlock loadable={props.detail} loading="Loading tool...">
          {(detail) =>
            detail ? (
              renderDetail(detail)
            ) : (
              <EmptyState
                title={props.bundle.toolCount > 0 ? "Select a tool" : "No tools available"}
                description={
                  props.bundle.toolCount > 0
                    ? "Choose from the list or press / to search."
                    : undefined
                }
              />
            )
          }
        </LoadableBlock>
      </div>
    </>
  );
};

export const SourceToolDiscoveryPanel = <
  TResult extends SourceToolDiscoveryResult = SourceToolDiscoveryResult,
>(
  props: SourceToolDiscoveryPanelProps<TResult>,
) => {
  const [draftQuery, setDraftQuery] = useState(props.initialQuery);

  useEffect(() => {
    setDraftQuery(props.initialQuery);
  }, [props.initialQuery]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <form
          className="flex max-w-2xl items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmitQuery(draftQuery.trim());
          }}
        >
          <div className="relative flex-1">
            <IconSearch className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
            <input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="Search tools..."
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/30"
            />
          </div>
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded-md border border-input bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
          >
            Search
          </button>
        </form>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <LoadableBlock loadable={props.discovery} loading="Searching...">
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
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-mono tabular-nums text-muted-foreground/60">
                          {index + 1}
                        </span>
                        <h4 className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
                          {item.path}
                        </h4>
                      </div>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/50">
                        {item.score.toFixed(2)}
                      </span>
                    </div>
                    {item.description && (
                      <p className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
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
};
