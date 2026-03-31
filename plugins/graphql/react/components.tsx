import { startTransition, useState, type ReactNode } from "react";
import type {
  Source,
  SourceInspectionToolDetail,
} from "@executor/react";
import {
  SecretReferenceField,
  defineExecutorPluginHttpApiClient,
  Result,
  useAtomSet,
  useAtomValue,
  useExecutorMutation,
  useLocalInstallation,
  useSource,
} from "@executor/react";
import {
  Alert,
  Badge,
  Button,
  Card,
  IconPencil,
  Input,
  Label,
  Select,
  SourceToolExplorer,
  Textarea,
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
  getFaviconUrlForRemoteUrl,
  getSourceFaviconUrl,
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
  iconUrl: undefined,
  endpoint: "https://example.com/graphql",
  defaultHeaders: null,
  auth: {
    kind: "none",
  },
});

const DEFAULT_BEARER_HEADER_NAME = "Authorization";
const DEFAULT_BEARER_PREFIX = "Bearer ";

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
  const [iconUrl, setIconUrl] = useState(props.initialValue.iconUrl ?? "");
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
  const resolvedIconUrl = iconUrl.trim() || getFaviconUrlForRemoteUrl(endpoint) || getSourceFaviconUrl(name);

  return (
    <div className="space-y-6 rounded-lg border border-border bg-card p-6 text-sm ring-1 ring-foreground/[0.04]">
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="grid gap-2">
          <Label>Icon URL</Label>
          <Input
            value={iconUrl}
            onChange={(event) => setIconUrl(event.target.value)}
            placeholder="https://cdn.example.com/icon.png"
            className="font-mono text-xs"
          />
          {resolvedIconUrl && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <img src={resolvedIconUrl} alt="" className="size-4 rounded-sm object-contain" />
              <span>{iconUrl.trim() ? "Using override" : "Auto preview"}</span>
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <Label>Endpoint</Label>
          <Input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            className="font-mono text-xs"
          />
        </div>

        <div className="grid gap-2">
          <Label>Default Headers</Label>
          <Textarea
            value={headersText}
            onChange={(event) => setHeadersText(event.target.value)}
            rows={3}
            placeholder='{"x-api-version":"2026-03-23"}'
          />
        </div>

        <div className="grid gap-2">
          <Label>Auth</Label>
          <Select
            value={authKind}
            onChange={(event) =>
              setAuthKind(event.target.value as GraphqlConnectionAuth["kind"])}
          >
            <option value="none">None</option>
            <option value="bearer">Bearer Secret</option>
          </Select>
        </div>

        {authKind === "bearer" && (
          <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
            <SecretReferenceField
              label="Secret"
              value={secretRef}
              emptyLabel="Select a secret"
              draftNamePlaceholder="GraphQL bearer token"
              draftValuePlaceholder="Paste the token value"
              onChange={setSecretRef}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Header Name</Label>
                <Input
                  value={authHeaderName}
                  onChange={(event) => setAuthHeaderName(event.target.value)}
                  placeholder={DEFAULT_BEARER_HEADER_NAME}
                  className="font-mono text-xs"
                />
              </div>

              <div className="grid gap-2">
                <Label>Prefix</Label>
                <Input
                  value={authPrefix}
                  onChange={(event) => setAuthPrefix(event.target.value)}
                  placeholder={DEFAULT_BEARER_PREFIX}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          {error}
        </Alert>
      )}

      <div className="flex items-center justify-end">
        <Button
          type="button"
          onClick={() => {
            void (async () => {
              setError(null);
              try {
                await submitMutation.mutateAsync({
                  name: name.trim(),
                  ...(iconUrl.trim() ? { iconUrl: iconUrl.trim() } : {}),
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
        >
          {submitMutation.status === "pending"
            ? props.mode === "create" ? "Creating..." : "Saving..."
            : props.mode === "create" ? "Create Source" : "Save Changes"}
        </Button>
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl tracking-tight text-foreground">
            Add GraphQL Source
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            Connect a GraphQL endpoint and expose its operations as tools.
          </p>
        </div>

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
      </div>
    </div>
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
      <Alert variant="destructive">
        Failed loading source configuration.
      </Alert>
    );
  }

  if (!Result.isSuccess(configResult)) {
    return <div className="text-sm text-muted-foreground">Loading configuration...</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl tracking-tight text-foreground">
            Edit GraphQL Source
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            Update the connection settings for {props.source.name}.
          </p>
        </div>

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
      </div>
    </div>
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
  const sourceNeedsRecovery =
    props.source.status === "auth_required" || props.source.status === "error";

  if (sourceNeedsRecovery) {
    const title =
      props.source.status === "auth_required"
        ? "Credentials required"
        : "Source needs attention";
    const description =
      props.source.status === "auth_required"
        ? "This endpoint requires credentials before its schema can be introspected. Edit the source, configure bearer auth, and save again."
        : "This source could not be indexed successfully. Edit the configuration and save again to rebuild its catalog.";

    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <Card className="space-y-6 p-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h1 className="font-display text-2xl tracking-tight text-foreground">
                  {title}
                </h1>
                <Badge variant="outline">{props.source.status}</Badge>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            </div>

            {config ? (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-mono text-foreground">{config.endpoint}</span>
                <Badge variant="muted">Auth: {config.auth.kind}</Badge>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigation.edit(props.source.id)}
              >
                <IconPencil className="size-3" />
                Edit
              </Button>
              {confirmDelete ? (
                <>
                  <span className="text-[11px] font-medium text-destructive">
                    Confirm delete?
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDelete(false)}
                    disabled={isDeleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    onClick={() => {
                      void handleDelete().catch(() => {});
                    }}
                    disabled={isDeleting}
                  >
                    {isDeleting ? "Deleting..." : "Delete"}
                  </Button>
                </>
              ) : (
                <Button
                  variant="destructive-outline"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  disabled={isDeleting}
                >
                  Delete
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>
    );
  }

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
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigation.edit(props.source.id)}
          >
            <IconPencil className="size-3" />
            Edit
          </Button>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-destructive">
                Confirm delete?
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive-outline"
                size="sm"
                onClick={() => {
                  void handleDelete().catch(() => {});
                }}
                disabled={isDeleting}
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </Button>
            </div>
          ) : (
            <Button
              variant="destructive-outline"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting}
            >
              Delete
            </Button>
          )}
        </>
      )}
      renderHeaderMeta={renderGraphqlToolHeaderMeta}
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

  if (sourceId === null) {
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

  if (source.status === "error") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        Failed loading this GraphQL source.
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
