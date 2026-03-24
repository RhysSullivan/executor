import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import type {
  Loadable,
  Source,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
} from "@executor/react";
import {
  defineExecutorPluginHttpApiClient,
  Result,
  useAtomSet,
  useAtomValue,
  useExecutorMutation,
  useLocalInstallation,
  usePrefetchToolDetail,
  useSecrets,
  useSourceDiscovery,
  useSourceInspection,
  useSourceToolDetail,
} from "@executor/react";
import {
  Badge,
  DocumentPanel,
  EmptyState,
  IconCheck,
  IconChevron,
  IconClose,
  IconCopy,
  IconFolder,
  IconPencil,
  IconSearch,
  IconTool,
  LoadableBlock,
  Markdown,
  MethodBadge,
  cn,
  defineExecutorFrontendPlugin,
  defineFrontendSourceType,
  parseSourceToolExplorerSearch,
  useSourcePluginRouteParams,
  type SourceToolExplorerSearch,
  useSourcePluginNavigation,
  useSourcePluginSearch,
} from "@executor/react/source-plugins";

import {
  graphqlHttpApiExtension,
} from "@executor/plugin-graphql-http";
import {
  type GraphqlConnectInput,
  type GraphqlConnectionAuth,
} from "@executor/plugin-graphql-shared";

const getGraphqlHttpClient = defineExecutorPluginHttpApiClient<"GraphqlReactHttpClient">()(
  "GraphqlReactHttpClient",
  [graphqlHttpApiExtension] as const,
);

type GraphqlToolRouteParams = {
  sourceId: string;
  toolPath?: string;
};

type GraphqlToolTreeNode = {
  segment: string;
  tool?: SourceInspectionToolDetail["summary"] | SourceInspection["tools"][number];
  children: Map<string, GraphqlToolTreeNode>;
};

const defaultGraphqlInput = (): GraphqlConnectInput => ({
  name: "My GraphQL Source",
  endpoint: "https://example.com/graphql",
  defaultHeaders: null,
  auth: {
    kind: "none",
  },
});

const parseStringMap = (value: string): Record<string, string> | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = JSON.parse(trimmed) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.every(([, entry]) => typeof entry === "string")) {
    throw new Error("All header values must be strings.");
  }

  return Object.fromEntries(entries as Array<[string, string]>);
};

const stringifyStringMap = (
  value: Record<string, string> | null | undefined,
): string =>
  !value || Object.keys(value).length === 0
    ? ""
    : JSON.stringify(value, null, 2);

const secretValue = (input: GraphqlConnectionAuth): string =>
  input.kind === "bearer"
    ? JSON.stringify(input.tokenSecretRef)
    : "";

const authFromSecretValue = (
  authKind: GraphqlConnectionAuth["kind"],
  value: string,
): GraphqlConnectionAuth => {
  if (authKind === "none") {
    return {
      kind: "none",
    };
  }

  if (!value) {
    throw new Error("Select a secret for bearer auth.");
  }

  return {
    kind: "bearer",
    tokenSecretRef: JSON.parse(value) as GraphqlConnectionAuth & { tokenSecretRef: never }["tokenSecretRef"],
  };
};

const graphqlToolRoutePath = (toolPath: string): string =>
  `tool/${encodeURIComponent(toolPath)}`;

const readGraphqlToolPath = (params: GraphqlToolRouteParams): string | null => {
  if (!params.toolPath || params.toolPath.length === 0) {
    return null;
  }

  try {
    return decodeURIComponent(params.toolPath);
  } catch {
    return params.toolPath;
  }
};

const buildGraphqlToolTree = (
  tools: SourceInspection["tools"],
): GraphqlToolTreeNode => {
  const root: GraphqlToolTreeNode = {
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

      const next: GraphqlToolTreeNode = {
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

const countGraphqlToolLeaves = (node: GraphqlToolTreeNode): number => {
  let count = node.tool ? 1 : 0;
  for (const child of node.children.values()) {
    count += countGraphqlToolLeaves(child);
  }
  return count;
};

function GraphqlSourceForm(props: {
  initialValue: GraphqlConnectInput;
  mode: "create" | "edit";
  onSubmit: (input: GraphqlConnectInput) => Promise<void>;
}) {
  const secrets = useSecrets();
  const submitMutation = useExecutorMutation<GraphqlConnectInput, void>(props.onSubmit);
  const [name, setName] = useState(props.initialValue.name);
  const [endpoint, setEndpoint] = useState(props.initialValue.endpoint);
  const [headersText, setHeadersText] = useState(
    stringifyStringMap(props.initialValue.defaultHeaders),
  );
  const [authKind, setAuthKind] = useState<GraphqlConnectionAuth["kind"]>(
    props.initialValue.auth.kind,
  );
  const [secretRef, setSecretRef] = useState(secretValue(props.initialValue.auth));
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {props.mode === "create" ? "Connect GraphQL Source" : "Edit GraphQL Source"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          GraphQL is now mounted as a plugin. The source record stays generic; endpoint and auth
          live entirely in plugin storage.
        </p>
      </div>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Endpoint</span>
        <input
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          className="h-10 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Default Headers</span>
        <textarea
          value={headersText}
          onChange={(event) => setHeadersText(event.target.value)}
          rows={5}
          placeholder='{"x-api-version":"2026-03-23"}'
          className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Auth</span>
        <select
          value={authKind}
          onChange={(event) =>
            setAuthKind(event.target.value as GraphqlConnectionAuth["kind"])}
          className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
        >
          <option value="none">None</option>
          <option value="bearer">Bearer Secret</option>
        </select>
      </label>

      {authKind === "bearer" && (
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Secret</span>
          <select
            value={secretRef}
            onChange={(event) => setSecretRef(event.target.value)}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          >
            <option value="">Select a secret</option>
            {secrets.status === "ready" &&
              secrets.data.map((secret) => (
                <option
                  key={`${secret.providerId}:${secret.id}`}
                  value={JSON.stringify({
                    providerId: secret.providerId,
                    handle: secret.id,
                  })}
                >
                  {secret.name ?? secret.id}
                </option>
              ))}
          </select>
        </label>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void (async () => {
              setError(null);
              try {
                await submitMutation.mutateAsync({
                  name: name.trim(),
                  endpoint: endpoint.trim(),
                  defaultHeaders: parseStringMap(headersText),
                  auth: authFromSecretValue(authKind, secretRef),
                });
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Failed saving GraphQL source.");
              }
            })();
          }}
          disabled={submitMutation.status === "pending"}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity disabled:pointer-events-none disabled:opacity-50"
        >
          {submitMutation.status === "pending"
            ? props.mode === "create" ? "Creating..." : "Saving..."
            : props.mode === "create" ? "Create Source" : "Save Changes"}
        </button>
        <div className="text-xs text-muted-foreground">
          {props.mode === "create"
            ? "The plugin will introspect the endpoint immediately after creation."
            : "Saving refreshes the imported schema and tool catalog."}
        </div>
      </div>
    </div>
  );
}

function GraphqlAddPage() {
  const navigation = useSourcePluginNavigation();
  const installation = useLocalInstallation();
  const client = getGraphqlHttpClient();
  const createSource = useAtomSet(
    client.mutation("graphql", "createSource"),
    { mode: "promise" },
  );

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

  return (
    <GraphqlSourceForm
      initialValue={defaultGraphqlInput()}
      mode="create"
      onSubmit={async (input) => {
        const source = await createSource({
          path: {
            workspaceId: installation.data.scopeId,
          },
          payload: input,
          reactivityKeys: {
            sources: [installation.data.scopeId],
          },
        });

        startTransition(() => {
          void navigation.detail(source.id, {
            tab: "model",
          });
        });
      }}
    />
  );
}

function GraphqlEditPage(props: {
  source: Source;
}) {
  const navigation = useSourcePluginNavigation();
  const installation = useLocalInstallation();
  const client = getGraphqlHttpClient();
  const configResult = useAtomValue(
    installation.status === "ready"
      ? client.query("graphql", "getSourceConfig", {
          path: {
            workspaceId: installation.data.scopeId,
            sourceId: props.source.id,
          },
          reactivityKeys: {
            source: [installation.data.scopeId, props.source.id],
          },
          timeToLive: "30 seconds",
        })
      : client.query("local", "installation", {
          timeToLive: "1 second",
        }) as never,
  );
  const updateSource = useAtomSet(
    client.mutation("graphql", "updateSource"),
    { mode: "promise" },
  );

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

  if (Result.isFailure(configResult)) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
        Failed loading GraphQL config.
      </div>
    );
  }

  if (!Result.isSuccess(configResult)) {
    return <div className="text-sm text-muted-foreground">Loading GraphQL config...</div>;
  }

  return (
    <GraphqlSourceForm
      initialValue={configResult.value}
      mode="edit"
      onSubmit={async (input) => {
        const source = await updateSource({
          path: {
            workspaceId: installation.data.scopeId,
            sourceId: props.source.id,
          },
          payload: input,
          reactivityKeys: {
            sources: [installation.data.scopeId],
            source: [installation.data.scopeId, props.source.id],
            sourceInspection: [installation.data.scopeId, props.source.id],
            sourceInspectionTool: [installation.data.scopeId, props.source.id],
            sourceDiscovery: [installation.data.scopeId, props.source.id],
          },
        });

        startTransition(() => {
          void navigation.detail(source.id, {
            tab: "model",
          });
        });
      }}
    />
  );
}

function GraphqlDetailExplorer(props: {
  source: Source;
  selectedToolPath: string | null;
}) {
  const navigation = useSourcePluginNavigation();
  const search = parseSourceToolExplorerSearch(
    useSourcePluginSearch(),
  ) satisfies SourceToolExplorerSearch;
  const installation = useLocalInstallation();
  const client = getGraphqlHttpClient();
  const removeSource = useAtomSet(
    client.mutation("graphql", "removeSource"),
    { mode: "promise" },
  );
  const configResult = useAtomValue(
    installation.status === "ready"
      ? client.query("graphql", "getSourceConfig", {
          path: {
            workspaceId: installation.data.scopeId,
            sourceId: props.source.id,
          },
          reactivityKeys: {
            source: [installation.data.scopeId, props.source.id],
          },
          timeToLive: "30 seconds",
        })
      : client.query("local", "installation", {
          timeToLive: "1 second",
        }) as never,
  );
  const inspection = useSourceInspection(props.source.id);
  const tab = search.tab === "discover" ? "discover" : "model";
  const query = search.query ?? "";
  const selectedToolPath =
    props.selectedToolPath
    ?? search.tool
    ?? (inspection.status === "ready" ? inspection.data.tools[0]?.path ?? null : null);
  const discovery = useSourceDiscovery({
    sourceId: props.source.id,
    query,
    limit: 20,
  });
  const toolDetail = useSourceToolDetail(
    props.source.id,
    tab === "model" ? selectedToolPath : null,
  );

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

  useEffect(() => {
    if (
      tab !== "model"
      || selectedToolPath
      || inspection.status !== "ready"
    ) {
      return;
    }

    const firstTool = inspection.data.tools[0]?.path;
    if (!firstTool) {
      return;
    }

    startTransition(() => {
      void navigation.child({
        sourceId: props.source.id,
        path: graphqlToolRoutePath(firstTool),
        search: {
          tab: "model",
          ...(query ? { query } : {}),
        },
      });
    });
  }, [
    inspection,
    navigation,
    props.source.id,
    query,
    selectedToolPath,
    tab,
  ]);

  const setRouteState = (next: {
    tab?: "model" | "discover";
    tool?: string;
    query?: string;
  }) => {
    const nextTab = next.tab ?? tab;
    const nextQuery = next.query ?? query;
    const nextToolPath = next.tool ?? selectedToolPath;
    const searchState = {
      tab: nextTab,
      ...(nextQuery ? { query: nextQuery } : {}),
    } satisfies SourceToolExplorerSearch;

    if (nextTab === "discover") {
      return navigation.detail(props.source.id, searchState);
    }

    if (nextToolPath) {
      return navigation.child({
        sourceId: props.source.id,
        path: graphqlToolRoutePath(nextToolPath),
        search: searchState,
      });
    }

    return navigation.detail(props.source.id, searchState);
  };

  return (
    <LoadableBlock loadable={inspection} loading="Loading source...">
      {(loadedInspection) => {
        const config = Result.isSuccess(configResult) ? configResult.value : null;
        const activeTool =
          loadedInspection.tools.find((tool) => tool.path === selectedToolPath)
          ?? loadedInspection.tools[0]
          ?? null;

        return (
          <div className="flex h-full flex-col overflow-hidden">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm">
              <div className="flex min-w-0 items-center gap-3">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {loadedInspection.source.name}
                </h2>
                <Badge variant="outline">{loadedInspection.source.kind}</Badge>
                <span className="hidden text-[11px] tabular-nums text-muted-foreground/50 sm:block">
                  {loadedInspection.toolCount} {loadedInspection.toolCount === 1 ? "tool" : "tools"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
                  {(["model", "discover"] as const).map((tabId) => (
                    <button
                      key={tabId}
                      type="button"
                      onClick={() => {
                        void setRouteState({ tab: tabId });
                      }}
                      className={cn(
                        "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                        tabId === tab
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tabId === "model" ? "Tools" : "Search"}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => void navigation.edit(props.source.id)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  <IconPencil className="size-3" />
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const confirmed = window.confirm(`Delete GraphQL source "${props.source.name}"?`);
                    if (!confirmed) {
                      return;
                    }

                    void removeSource({
                      path: {
                        workspaceId: installation.data.scopeId,
                        sourceId: props.source.id,
                      },
                      reactivityKeys: {
                        sources: [installation.data.scopeId],
                        source: [installation.data.scopeId, props.source.id],
                        sourceInspection: [installation.data.scopeId, props.source.id],
                        sourceInspectionTool: [installation.data.scopeId, props.source.id],
                        sourceDiscovery: [installation.data.scopeId, props.source.id],
                      },
                    }).then(() => {
                      startTransition(() => {
                        void navigation.home();
                      });
                    });
                  }}
                  className="inline-flex items-center rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10"
                >
                  Delete
                </button>
              </div>
            </div>

            {config && (
              <div className="shrink-0 border-b border-border bg-card/30 px-4 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-mono text-foreground">{config.endpoint}</span>
                  <Badge variant="muted">Auth: {config.auth.kind}</Badge>
                </div>
              </div>
            )}

            <div className="flex min-h-0 flex-1 overflow-hidden">
              {tab === "model" ? (
                <GraphqlModelView
                  bundle={loadedInspection}
                  detail={toolDetail}
                  selectedToolPath={activeTool?.path ?? null}
                  onSelectTool={(toolPath) => {
                    void setRouteState({
                      tab: "model",
                      tool: toolPath,
                    });
                  }}
                  sourceId={props.source.id}
                />
              ) : (
                <GraphqlDiscoveryView
                  discovery={discovery}
                  initialQuery={query}
                  onOpenTool={(toolPath) => {
                    void setRouteState({
                      tab: "model",
                      tool: toolPath,
                      query,
                    });
                  }}
                  onSubmitQuery={(nextQuery) => {
                    void setRouteState({
                      tab: "discover",
                      query: nextQuery,
                    });
                  }}
                />
              )}
            </div>
          </div>
        );
      }}
    </LoadableBlock>
  );
}

function GraphqlModelView(props: {
  bundle: SourceInspection;
  detail: Loadable<SourceInspectionToolDetail | null>;
  selectedToolPath: string | null;
  onSelectTool: (toolPath: string) => void;
  sourceId: string;
}) {
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

        <div className="flex-1 overflow-y-auto">
          {filteredTools.length === 0 ? (
            <div className="p-4 text-center text-[13px] text-muted-foreground/50">
              {terms.length > 0 ? "No tools match your filter" : "No tools available"}
            </div>
          ) : (
            <div className="p-1.5">
              <GraphqlToolTree
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
              <GraphqlToolDetailPanel detail={detail} />
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
}

function GraphqlToolTree(props: {
  tools: SourceInspection["tools"];
  selectedToolPath: string | null;
  onSelectTool: (path: string) => void;
  search: string;
  isFiltered: boolean;
  sourceId: string;
}) {
  const tree = useMemo(() => buildGraphqlToolTree(props.tools), [props.tools]);
  const prefetch = usePrefetchToolDetail();
  const entries = [...tree.children.values()].sort((left, right) =>
    left.segment.localeCompare(right.segment)
  );

  return (
    <div className="flex flex-col gap-px">
      {entries.map((node) => (
        <GraphqlToolTreeNodeView
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

function GraphqlToolTreeNodeView(props: {
  node: GraphqlToolTreeNode;
  depth: number;
  selectedToolPath: string | null;
  onSelectTool: (path: string) => void;
  search: string;
  defaultOpen: boolean;
  sourceId: string;
  prefetch: ReturnType<typeof usePrefetchToolDetail>;
}) {
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

    function check(candidate: GraphqlToolTreeNode): boolean {
      if (candidate.tool?.path === selectedToolPath) {
        return true;
      }

      for (const child of candidate.children.values()) {
        if (check(child)) {
          return true;
        }
      }

      return false;
    }

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
      <GraphqlToolListItem
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
  const leafCount = countGraphqlToolLeaves(node);

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
          <GraphqlToolListItem
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
            <GraphqlToolTreeNodeView
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

function GraphqlToolListItem(props: {
  tool: SourceInspection["tools"][number];
  active: boolean;
  onSelect: () => void;
  search: string;
  depth: number;
  className?: string;
  sourceId: string;
  prefetch: ReturnType<typeof usePrefetchToolDetail>;
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
}

function GraphqlToolDetailPanel(props: {
  detail: SourceInspectionToolDetail;
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const inputType = props.detail.contract.input.typeDeclaration
    ?? props.detail.contract.input.typePreview
    ?? null;
  const outputType = props.detail.contract.output.typeDeclaration
    ?? props.detail.contract.output.typePreview
    ?? null;
  const detailGroup =
    props.detail.summary.group
    && props.detail.summary.group.toLowerCase() !== props.detail.summary.method?.toLowerCase()
      ? props.detail.summary.group
      : null;

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
              {detailGroup && (
                <Badge variant="outline">{detailGroup}</Badge>
              )}
              {props.detail.summary.protocol && (
                <Badge variant="muted">{props.detail.summary.protocol}</Badge>
              )}
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
                <DocumentPanel
                  title={section.title}
                  body={section.body}
                  lang={section.language}
                  empty=""
                />
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function GraphqlDiscoveryView(props: {
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
              <div className="grid gap-3">
                {result.results.map((item, index) => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => props.onOpenTool(item.path)}
                    className="rounded-xl border border-border bg-card/60 p-4 text-left transition-colors hover:border-primary/30 hover:bg-card"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex size-5 items-center justify-center rounded-md bg-muted text-[10px] text-muted-foreground">
                            {index + 1}
                          </span>
                          <span className="truncate font-mono text-xs text-foreground">
                            {item.path}
                          </span>
                        </div>
                        {item.description && (
                          <div className="mt-2 text-sm text-muted-foreground">
                            {item.description}
                          </div>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground/60">
                        {item.score.toFixed(2)}
                      </span>
                    </div>
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

function CopyButton(props: {
  text: string;
  field: string;
  copiedField: string | null;
  onCopy: (text: string, field: string) => void | Promise<void>;
}) {
  return (
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
}

function highlightMatch(text: string, search: string) {
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
}

function GraphqlDetailPage(props: {
  source: Source;
}) {
  return (
    <GraphqlDetailExplorer
      source={props.source}
      selectedToolPath={null}
    />
  );
}

function GraphqlToolDetailPage(props: {
  source: Source;
}) {
  const params = useSourcePluginRouteParams<GraphqlToolRouteParams>();

  return (
    <GraphqlDetailExplorer
      source={props.source}
      selectedToolPath={readGraphqlToolPath(params)}
    />
  );
}

const graphqlSourceType = defineFrontendSourceType({
  key: "graphql",
  kind: "graphql",
  displayName: "GraphQL",
  description: "Introspect a GraphQL endpoint into typed query and mutation tools.",
  renderAddPage: GraphqlAddPage,
  renderEditPage: GraphqlEditPage,
  renderDetailPage: GraphqlDetailPage,
  detailRoutes: [
    {
      key: "tool-detail",
      path: "tool/$toolPath",
      component: GraphqlToolDetailPage,
    },
  ],
});

export const GraphqlReactPlugin = defineExecutorFrontendPlugin({
  key: "graphql",
  sourceTypes: [graphqlSourceType],
});
