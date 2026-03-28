import { startTransition, useState, type ReactNode } from "react";
import type {
  Source,
  SourceInspectionToolDetail,
} from "@executor/react";
import {
  defineExecutorPluginHttpApiClient,
  Result,
  useAtomSet,
  useAtomValue,
  useCreateSecret,
  useExecutorMutation,
  useLocalInstallation,
  useSecrets,
  useSource,
} from "@executor/react";
import {
  Badge,
  IconPencil,
  SourceToolDetailPanel,
  SourceToolExplorer,
  parseSourceToolExplorerSearch,
  useSourcePluginRouteParams,
  type SourceToolExplorerSearch,
  useSourcePluginNavigation,
  useSourcePluginSearch,
} from "@executor/react/plugins";

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

const defaultGraphqlInput = (): GraphqlConnectInput => ({
  name: "My GraphQL Source",
  endpoint: "https://example.com/graphql",
  defaultHeaders: null,
  auth: {
    kind: "none",
  },
});

const DEFAULT_BEARER_HEADER_NAME = "Authorization";
const DEFAULT_BEARER_PREFIX = "Bearer ";
const CREATE_SECRET_VALUE = "__create_graphql_secret__";

const presetString = (
  search: Record<string, unknown>,
  key: string,
): string | null => {
  const value = search[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

const firstSearchString = (
  search: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | null => {
  for (const key of keys) {
    const value = presetString(search, key);
    if (value) {
      return value;
    }
  }

  return null;
};

const graphqlInputFromSearch = (
  search: Record<string, unknown>,
): GraphqlConnectInput => {
  const defaults = defaultGraphqlInput();

  return {
    ...defaults,
    name: presetString(search, "presetName") ?? defaults.name,
    endpoint:
      firstSearchString(search, [
        "presetEndpoint",
        "endpoint",
        "inputUrl",
        "pastedUrl",
        "url",
      ]) ?? defaults.endpoint,
  };
};

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

const bearerHeaderNameValue = (input: GraphqlConnectionAuth): string =>
  input.kind === "bearer"
    ? input.headerName?.trim() || DEFAULT_BEARER_HEADER_NAME
    : DEFAULT_BEARER_HEADER_NAME;

const bearerPrefixValue = (input: GraphqlConnectionAuth): string =>
  input.kind === "bearer"
    ? input.prefix ?? DEFAULT_BEARER_PREFIX
    : DEFAULT_BEARER_PREFIX;

const trimToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const authFromSecretValue = (
  authKind: GraphqlConnectionAuth["kind"],
  value: string,
  headerName: string,
  prefix: string,
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
    headerName: trimToNull(headerName),
    prefix: prefix === DEFAULT_BEARER_PREFIX ? null : prefix,
  };
};

function SecretSelectOrCreateField(props: {
  label: string;
  value: string;
  emptyLabel: string;
  draftNamePlaceholder: string;
  draftValuePlaceholder: string;
  onChange: (value: string) => void;
}) {
  const secrets = useSecrets();
  const createSecret = useCreateSecret();
  const [draftName, setDraftName] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const handleSelectChange = (nextValue: string) => {
    if (nextValue === CREATE_SECRET_VALUE) {
      setShowCreate(true);
      props.onChange("");
      return;
    }

    setShowCreate(false);
    setCreateError(null);
    props.onChange(nextValue);
  };

  const handleCreate = async () => {
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      setCreateError("Secret name is required.");
      return;
    }
    if (!draftValue.trim()) {
      setCreateError("Secret value is required.");
      return;
    }

    try {
      setCreateError(null);
      const created = await createSecret.mutateAsync({
        name: trimmedName,
        value: draftValue,
      });
      props.onChange(JSON.stringify({
        providerId: created.providerId,
        handle: created.id,
      }));
      setDraftName("");
      setDraftValue("");
      setShowCreate(false);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Failed creating secret.");
    }
  };

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">{props.label}</span>
      <select
        value={showCreate ? CREATE_SECRET_VALUE : props.value}
        onChange={(event) => handleSelectChange(event.target.value)}
        className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
      >
        <option value="">{props.emptyLabel}</option>
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
        <option value={CREATE_SECRET_VALUE}>Create new secret</option>
      </select>

      {showCreate && (
        <div className="space-y-3 rounded-lg border border-border/70 bg-background/50 p-3">
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder={props.draftNamePlaceholder}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
          <textarea
            value={draftValue}
            onChange={(event) => setDraftValue(event.target.value)}
            rows={3}
            placeholder={props.draftValuePlaceholder}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
          {createError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
              {createError}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void handleCreate();
              }}
              disabled={createSecret.status === "pending"}
              className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity disabled:pointer-events-none disabled:opacity-50"
            >
              {createSecret.status === "pending" ? "Creating..." : "Create Secret"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setCreateError(null);
              }}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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

function GraphqlSourceForm(props: {
  initialValue: GraphqlConnectInput;
  mode: "create" | "edit";
  onSubmit: (input: GraphqlConnectInput) => Promise<void>;
}) {
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
  const [authHeaderName, setAuthHeaderName] = useState(
    bearerHeaderNameValue(props.initialValue.auth),
  );
  const [authPrefix, setAuthPrefix] = useState(
    bearerPrefixValue(props.initialValue.auth),
  );
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-6 rounded-xl border border-border p-6">
      <div className="grid gap-4">
        <label className="grid gap-2">
          <span className="text-xs font-medium text-foreground">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </label>

        <label className="grid gap-2">
          <span className="text-xs font-medium text-foreground">Endpoint</span>
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </label>

        <label className="grid gap-2">
          <span className="text-xs font-medium text-foreground">Default Headers</span>
          <textarea
            value={headersText}
            onChange={(event) => setHeadersText(event.target.value)}
            rows={3}
            placeholder='{"x-api-version":"2026-03-23"}'
            className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </label>

        <label className="grid gap-2">
          <span className="text-xs font-medium text-foreground">Auth</span>
          <select
            value={authKind}
            onChange={(event) =>
              setAuthKind(event.target.value as GraphqlConnectionAuth["kind"])}
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          >
            <option value="none">None</option>
            <option value="bearer">Bearer Secret</option>
          </select>
        </label>

        {authKind === "bearer" && (
          <div className="space-y-4 border-l-2 border-border pl-4">
            <SecretSelectOrCreateField
              label="Secret"
              value={secretRef}
              emptyLabel="Select a secret"
              draftNamePlaceholder="GraphQL bearer token"
              draftValuePlaceholder="Paste the token value"
              onChange={setSecretRef}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-xs font-medium text-foreground">Header Name</span>
                <input
                  value={authHeaderName}
                  onChange={(event) => setAuthHeaderName(event.target.value)}
                  placeholder={DEFAULT_BEARER_HEADER_NAME}
                  className="h-9 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-xs font-medium text-foreground">Prefix</span>
                <input
                  value={authPrefix}
                  onChange={(event) => setAuthPrefix(event.target.value)}
                  placeholder={DEFAULT_BEARER_PREFIX}
                  className="h-9 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
                />
              </label>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end">
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
                  auth: authFromSecretValue(
                    authKind,
                    secretRef,
                    authHeaderName,
                    authPrefix,
                  ),
                });
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Failed saving GraphQL source.");
              }
            })();
          }}
          disabled={submitMutation.status === "pending"}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
        >
          {submitMutation.status === "pending"
            ? props.mode === "create" ? "Creating..." : "Saving..."
            : props.mode === "create" ? "Create Source" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}

export function GraphqlAddPage() {
  const navigation = useSourcePluginNavigation();
  const initialValue = graphqlInputFromSearch(useSourcePluginSearch());
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
      initialValue={initialValue}
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

export function GraphqlEditPage(props: {
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
        Failed loading source configuration.
      </div>
    );
  }

  if (!Result.isSuccess(configResult)) {
    return <div className="text-sm text-muted-foreground">Loading configuration...</div>;
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
  const tab = search.tab === "discover" ? "discover" : "model";
  const query = search.query ?? "";
  const selectedToolPath = props.selectedToolPath ?? search.tool ?? null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

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
      ...(nextTab === "discover" && nextToolPath ? { tool: nextToolPath } : {}),
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

  const handleDelete = async () => {
    if (isDeleting) {
      return;
    }

    setIsDeleting(true);
    try {
      await removeSource({
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
      });
      startTransition(() => {
        void navigation.home();
      });
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  const config = Result.isSuccess(configResult) ? configResult.value : null;

  return (
    <SourceToolExplorer
      sourceId={props.source.id}
      title={props.source.name}
      kind={props.source.kind}
      search={search}
      selectedToolPath={selectedToolPath}
      navigate={(next) => setRouteState(next)}
      summary={config ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono text-foreground">{config.endpoint}</span>
          <Badge variant="muted">Auth: {config.auth.kind}</Badge>
        </div>
      ) : undefined}
      actions={(
        <>
          <button
            type="button"
            onClick={() => void navigation.edit(props.source.id)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <IconPencil className="size-3" />
            Edit
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-destructive">
                Confirm delete?
              </span>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
                className="inline-flex items-center rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleDelete().catch(() => {});
                }}
                disabled={isDeleting}
                className="inline-flex items-center rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting}
              className="inline-flex items-center rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
            >
              Delete
            </button>
          )}
        </>
      )}
      renderDetail={(detail) => (
        <SourceToolDetailPanel
          detail={detail}
          renderHeaderMeta={renderGraphqlToolHeaderMeta}
        />
      )}
    />
  );
}

const renderGraphqlToolHeaderMeta = (detail: SourceInspectionToolDetail) => {
  const detailGroup =
    detail.summary.group
    && detail.summary.group.toLowerCase() !== detail.summary.method?.toLowerCase()
      ? detail.summary.group
      : null;

  return (
    <>
      {detailGroup && <Badge variant="outline">{detailGroup}</Badge>}
      {detail.summary.protocol && (
        <Badge variant="muted">{detail.summary.protocol}</Badge>
      )}
    </>
  );
};

export function GraphqlDetailPage(props: {
  source: Source;
}) {
  return (
    <GraphqlDetailExplorer
      source={props.source}
      selectedToolPath={null}
    />
  );
}

export function GraphqlToolDetailPage(props: {
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

function GraphqlSourceRoute(props: {
  children: (source: Source) => ReactNode;
}) {
  const params = useSourcePluginRouteParams<{ sourceId?: string }>();
  const sourceId = typeof params.sourceId === "string" ? params.sourceId : null;
  const source = useSource(sourceId ?? "");

  if (sourceId === null || source.status === "error") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        This GraphQL source is unavailable.
      </div>
    );
  }

  if (source.status === "loading") {
    return (
      <div className="px-6 py-8 text-sm text-muted-foreground">
        Loading source...
      </div>
    );
  }

  if (source.data.kind !== "graphql") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        Expected a `graphql` source, but received `{source.data.kind}`.
      </div>
    );
  }

  return props.children(source.data);
}

export function GraphqlDetailRoute() {
  return (
    <GraphqlSourceRoute>
      {(source) => <GraphqlDetailPage source={source} />}
    </GraphqlSourceRoute>
  );
}

export function GraphqlEditRoute() {
  return (
    <GraphqlSourceRoute>
      {(source) => <GraphqlEditPage source={source} />}
    </GraphqlSourceRoute>
  );
}

export function GraphqlToolDetailRoute() {
  return (
    <GraphqlSourceRoute>
      {(source) => <GraphqlToolDetailPage source={source} />}
    </GraphqlSourceRoute>
  );
}
