import { startTransition, useEffect, useState, type ReactNode } from "react";

import type { Loadable } from "../../core/types";
import type {
  SourceInspection,
  SourceInspectionToolDetail,
} from "@executor/platform-sdk/schema";
import {
  useSourceDiscovery,
  useSourceInspection,
  useSourceToolDetail,
} from "../../hooks/sources";
import { Badge, MethodBadge } from "./badge";
import { DocumentPanel } from "./document-panel";
import { EmptyState, LoadableBlock } from "./loadable";
import { Markdown } from "./markdown";
import {
  IconCheck,
  IconCopy,
  IconSearch,
  IconTool,
} from "./icons";
import { cn } from "../lib/cn";

export type SourceToolExplorerSearch = {
  tab: "model" | "discover";
  tool?: string;
  query?: string;
};

const sourceToolExplorerTabs = ["model", "discover"] as const;

export const parseSourceToolExplorerSearch = (
  search: Record<string, unknown>,
): SourceToolExplorerSearch => ({
  tab:
    typeof search.tab === "string"
    && sourceToolExplorerTabs.includes(
      search.tab as SourceToolExplorerSearch["tab"],
    )
      ? (search.tab as SourceToolExplorerSearch["tab"])
      : "model",
  tool:
    typeof search.tool === "string" && search.tool.length > 0
      ? search.tool
      : undefined,
  query: typeof search.query === "string" ? search.query : undefined,
});

const highlight = (text: string, query: string) => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return text;
  }

  const index = text.toLowerCase().indexOf(trimmed);
  if (index === -1) {
    return text;
  }

  return (
    <>
      <span>{text.slice(0, index)}</span>
      <mark className="rounded-sm bg-primary/20 px-px text-foreground">
        {text.slice(index, index + trimmed.length)}
      </mark>
      <span>{text.slice(index + trimmed.length)}</span>
    </>
  );
};

const ToolDetailPanel = (props: {
  detail: SourceInspectionToolDetail;
}) => {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (value: string, key: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-card/60 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-mono text-sm font-medium text-foreground">
              {props.detail.summary.path}
            </h3>
            <button
              type="button"
              onClick={() => {
                void copy(props.detail.summary.path, "path");
              }}
              className="rounded p-1 text-muted-foreground/50 transition-colors hover:text-foreground"
            >
              {copied === "path" ? <IconCheck /> : <IconCopy />}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {props.detail.summary.method && (
              <MethodBadge method={props.detail.summary.method} />
            )}
            {props.detail.summary.group && (
              <Badge variant="outline">{props.detail.summary.group}</Badge>
            )}
            {props.detail.summary.protocol && (
              <Badge variant="muted">{props.detail.summary.protocol}</Badge>
            )}
          </div>
        </div>
      </div>

      {props.detail.summary.description && (
        <div className="rounded-xl border border-border/70 bg-card/40 p-4">
          <Markdown>{props.detail.summary.description}</Markdown>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <DocumentPanel
          title="Input"
          body={
            props.detail.contract.input.typeDeclaration
            ?? props.detail.contract.input.typePreview
            ?? null
          }
          lang="typescript"
          empty="No input."
        />
        <DocumentPanel
          title="Output"
          body={
            props.detail.contract.output.typeDeclaration
            ?? props.detail.contract.output.typePreview
            ?? null
          }
          lang="typescript"
          empty="No output."
        />
      </div>

      <DocumentPanel
        title="Call Signature"
        body={props.detail.contract.callSignature}
        lang="typescript"
        empty="No signature."
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <DocumentPanel
          title="Input Schema"
          body={props.detail.contract.input.schemaJson}
          empty="No input schema."
          compact
        />
        <DocumentPanel
          title="Output Schema"
          body={props.detail.contract.output.schemaJson}
          empty="No output schema."
          compact
        />
      </div>
    </div>
  );
};

const DiscoveryPanel = (props: {
  sourceId: string;
  query: string;
  onOpenTool: (toolPath: string) => void;
  onQueryChange: (query: string) => void;
}) => {
  const [draftQuery, setDraftQuery] = useState(props.query);
  const results = useSourceDiscovery({
    sourceId: props.sourceId,
    query: props.query,
    limit: 20,
  });

  useEffect(() => {
    setDraftQuery(props.query);
  }, [props.query]);

  return (
    <div className="space-y-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          props.onQueryChange(draftQuery.trim());
        }}
      >
        <div className="relative flex-1">
          <IconSearch className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
          <input
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search tools..."
            className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </div>
        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
        >
          Search
        </button>
      </form>

      <LoadableBlock loadable={results} loading="Searching tools...">
        {(loaded) =>
          loaded.query.length === 0 ? (
            <EmptyState
              title="Search this source"
              description="Enter a query to find relevant tools."
            />
          ) : loaded.results.length === 0 ? (
            <EmptyState
              title="No results"
              description="Try different search terms."
            />
          ) : (
            <div className="space-y-2">
              {loaded.results.map((item, index) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => props.onOpenTool(item.path)}
                  className="w-full rounded-xl border border-border/70 bg-card/50 p-3 text-left transition-colors hover:border-primary/30 hover:bg-card"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="inline-flex size-5 items-center justify-center rounded-md bg-muted text-[10px] text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="truncate font-mono text-xs text-foreground">
                        {item.path}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground/60">
                      {item.score.toFixed(2)}
                    </span>
                  </div>
                  {item.description && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      {item.description}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )
        }
      </LoadableBlock>
    </div>
  );
};

export const SourceToolExplorer = (props: {
  sourceId: string;
  title: string;
  kind: string;
  search: SourceToolExplorerSearch;
  modelLayout?: "split" | "detail";
  navigate?: (search: {
    tab: "model" | "discover";
    tool?: string;
    query?: string;
  }) => void | Promise<void>;
  actions?: ReactNode;
  summary?: ReactNode;
}) => {
  const inspection = useSourceInspection(props.sourceId);
  const tab = props.search.tab === "discover" ? "discover" : "model";
  const toolPath = props.search.tool ?? null;
  const detail = useSourceToolDetail(props.sourceId, tab === "model" ? toolPath : null);
  const [filter, setFilter] = useState("");
  const navigate = props.navigate;
  const modelLayout = props.modelLayout ?? "split";

  useEffect(() => {
    if (
      tab !== "model"
      || inspection.status !== "ready"
      || props.search.tool
      || !navigate
    ) {
      return;
    }

    const firstTool = inspection.data.tools[0]?.path;
    if (!firstTool) {
      return;
    }

    startTransition(() => {
      void navigate({
        tab: "model",
        tool: firstTool,
        query: props.search.query,
      });
    });
  }, [inspection, navigate, props.search.query, props.search.tool, tab]);

  return (
    <LoadableBlock loadable={inspection} loading="Loading source...">
      {(loadedInspection) => {
        const selectedTool =
          loadedInspection.tools.find((candidate) => candidate.path === toolPath)
          ?? loadedInspection.tools[0]
          ?? null;
        const visibleTools = loadedInspection.tools.filter((tool) => {
          const query = filter.trim().toLowerCase();
          if (!query) {
            return true;
          }

          return [
            tool.path,
            tool.method ?? "",
            tool.inputTypePreview ?? "",
            tool.outputTypePreview ?? "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(query);
        });

        return (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold text-foreground">
                      {props.title}
                    </h2>
                    <Badge variant="outline">{props.kind}</Badge>
                    <Badge variant="muted">
                      {loadedInspection.toolCount} tool{loadedInspection.toolCount === 1 ? "" : "s"}
                    </Badge>
                  </div>
                  {props.summary && (
                    <div className="mt-3 text-sm text-muted-foreground">
                      {props.summary}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-lg bg-muted p-0.5">
                    {(["model", "discover"] as const).map((entry) => (
                      <button
                        key={entry}
                        type="button"
                        onClick={() => {
                          if (!navigate) {
                            return;
                          }

                          startTransition(() => {
                            void navigate({
                              tab: entry,
                              tool: entry === "model" ? (selectedTool?.path ?? undefined) : props.search.tool,
                              query: props.search.query,
                            });
                          });
                        }}
                        className={cn(
                          "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                          tab === entry
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {entry === "model" ? "Tools" : "Search"}
                      </button>
                    ))}
                  </div>
                  {props.actions}
                </div>
              </div>
            </div>

            {tab === "discover" ? (
              <DiscoveryPanel
                sourceId={props.sourceId}
                query={props.search.query ?? ""}
                onQueryChange={(query) => {
                  if (!navigate) {
                    return;
                  }

                  startTransition(() => {
                    void navigate({
                      tab: "discover",
                      tool: props.search.tool,
                      query,
                    });
                  });
                }}
                onOpenTool={(path) => {
                  if (!navigate) {
                    return;
                  }

                  startTransition(() => {
                    void navigate({
                      tab: "model",
                      tool: path,
                      query: props.search.query,
                    });
                  });
                }}
              />
            ) : (
              modelLayout === "detail" ? (
                <div className="rounded-2xl border border-border bg-card p-4">
                  <LoadableBlock loadable={detail} loading="Loading tool...">
                    {(loadedDetail) =>
                      loadedDetail ? (
                        <ToolDetailPanel detail={loadedDetail} />
                      ) : (
                        <EmptyState
                          title="Tool unavailable"
                          description="The selected tool could not be loaded."
                        />
                      )
                    }
                  </LoadableBlock>
                </div>
              ) : (
                <div className="flex min-h-0 flex-col gap-4 md:flex-row">
                  <div
                    className={cn(
                      "space-y-3 rounded-2xl border border-border bg-card p-4 md:w-72 md:shrink-0 xl:w-80",
                      selectedTool && "order-2 md:order-1",
                    )}
                  >
                    <div className="relative">
                      <IconSearch className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
                      <input
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        placeholder="Filter tools..."
                        className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/25"
                      />
                    </div>
                    <div className="space-y-1">
                      {visibleTools.length === 0 ? (
                        <EmptyState
                          title="No tools match"
                          description="Try a different filter."
                        />
                      ) : (
                        visibleTools.map((tool) => (
                          <button
                            key={tool.path}
                            type="button"
                            onClick={() => {
                              if (!navigate) {
                                return;
                              }

                              startTransition(() => {
                                void navigate({
                                  tab: "model",
                                  tool: tool.path,
                                  query: props.search.query,
                                });
                              });
                            }}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                              selectedTool?.path === tool.path
                                ? "border-primary/30 bg-primary/8"
                                : "border-transparent bg-muted/30 hover:border-border hover:bg-card",
                            )}
                          >
                            <IconTool className="size-3.5 shrink-0 text-muted-foreground/60" />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                              {highlight(tool.path, filter)}
                            </span>
                            {tool.method && <MethodBadge method={tool.method} />}
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  <div
                    className={cn(
                      "min-w-0 flex-1 rounded-2xl border border-border bg-card p-4",
                      selectedTool && "order-1 md:order-2",
                    )}
                  >
                    <LoadableBlock loadable={detail} loading="Loading tool...">
                      {(loadedDetail) =>
                        loadedDetail ? (
                          <ToolDetailPanel detail={loadedDetail} />
                        ) : (
                          <EmptyState
                            title="Select a tool"
                            description="Choose a tool from the list to inspect its contract."
                          />
                        )
                      }
                    </LoadableBlock>
                  </div>
                </div>
              )
            )}
          </div>
        );
      }}
    </LoadableBlock>
  );
};
