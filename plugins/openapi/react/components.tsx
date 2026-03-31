import type {
  Source,
  SourceInspectionToolDetail,
} from "@executor/react";
import {
  Result,
  SecretReferenceField,
  defineExecutorPluginHttpApiClient,
  useAtomValue,
  useAtomSet,
  useExecutorMutation,
  useSource,
  useWorkspaceRequestContext,
} from "@executor/react";
import {
  Alert,
  Button,
  DocumentPanel,
  IconPencil,
  Input,
  Label,
  Select,
  SourceToolExplorer,
  parseSourceToolExplorerSearch,
  type SourceToolExplorerSearch,
  useSourcePluginNavigation,
  useSourcePluginRouteParams,
  useSourcePluginSearch,
} from "@executor/react/plugins";
import {
  openApiHttpApiExtension,
} from "@executor/plugin-openapi-http";
import {
  getFaviconUrlForRemoteUrl,
  getSourceFaviconUrl,
} from "@executor/plugin-openapi-shared";
import type {
  OpenApiConnectInput,
  OpenApiPreviewRequest,
  OpenApiPreviewSecurityScheme,
  OpenApiPreviewResponse,
  OpenApiSourceConfigPayload,
} from "@executor/plugin-openapi-shared";
import { startTransition, useEffect, useEffectEvent, useState, type ReactNode } from "react";

type RouteToolSearch = SourceToolExplorerSearch;

const defaultOpenApiInput = (): OpenApiConnectInput => ({
  name: "My OpenAPI Source",
  iconUrl: undefined,
  specUrl: "https://example.com/openapi.json",
  baseUrl: null,
  auth: {
    kind: "none",
  },
  useSpecFetchCredentials: false,
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

const looksLikeOpenApiSpecUrl = (value: string): boolean => {
  const lower = value.trim().toLowerCase();
  if (!/^https?:\/\//.test(lower)) {
    return false;
  }

  return (
    lower.endsWith(".json")
    || lower.endsWith(".yaml")
    || lower.endsWith(".yml")
    || lower.includes("/openapi")
    || lower.includes("openapi.")
    || lower.includes("/swagger")
    || lower.includes("swagger.")
    || lower.includes("/api-docs")
  );
};

const inferOpenApiUrls = (value: string): {
  specUrl: string;
  baseUrl: string | null;
} => {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      specUrl: defaultOpenApiInput().specUrl,
      baseUrl: defaultOpenApiInput().baseUrl,
    };
  }

  if (looksLikeOpenApiSpecUrl(trimmed)) {
    return {
      specUrl: trimmed,
      baseUrl: null,
    };
  }

  const normalizedBaseUrl = trimmed.replace(/\/+$/, "");
  return {
    specUrl: `${normalizedBaseUrl}/openapi.json`,
    baseUrl: normalizedBaseUrl,
  };
};

const openApiInputFromSearch = (
  search: Record<string, unknown>,
): OpenApiConnectInput => {
  const defaults = defaultOpenApiInput();
  const genericUrl = firstSearchString(search, ["inputUrl", "pastedUrl", "url"]);
  const inferred = genericUrl ? inferOpenApiUrls(genericUrl) : defaults;

  return {
    ...defaults,
    name: presetString(search, "presetName") ?? defaults.name,
    specUrl: presetString(search, "presetSpecUrl") ?? inferred.specUrl,
    baseUrl: presetString(search, "presetBaseUrl") ?? inferred.baseUrl,
  };
};

const getOpenApiHttpClient = defineExecutorPluginHttpApiClient<"OpenApiReactHttpClient">()(
  "OpenApiReactHttpClient",
  [openApiHttpApiExtension] as const,
);


const Section = (props: {
  title: string;
  children: ReactNode;
}) => (
  <section>
    <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{props.title}</h2>
    {props.children}
  </section>
);

const isPreviewableSpecUrl = (value: string): boolean => {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return url.hostname !== "example.com";
  } catch {
    return false;
  }
};

const previewSecuritySchemeLabel = (scheme: OpenApiPreviewSecurityScheme): string => {
  if (scheme.kind === "apiKey") {
    return scheme.placement ? `API key in ${scheme.placement}` : "API key";
  }

  if (scheme.kind === "http") {
    return scheme.scheme ? `HTTP ${scheme.scheme}` : "HTTP auth";
  }

  if (scheme.kind === "oauth2") {
    return "OAuth 2.0";
  }

  if (scheme.kind === "openIdConnect") {
    return "OpenID Connect";
  }

  return "Custom auth";
};

const inputFromConfig = (
  config: OpenApiSourceConfigPayload,
): OpenApiConnectInput => ({
  name: config.name,
  iconUrl: config.iconUrl,
  specUrl: config.specUrl,
  baseUrl: config.baseUrl,
  auth: config.auth,
  useSpecFetchCredentials: config.useSpecFetchCredentials === true,
});

const secretValue = (input: OpenApiConnectInput["auth"]): string =>
  input.kind === "bearer"
    ? JSON.stringify(input.tokenSecretRef)
    : "";

const bearerHeaderNameValue = (input: OpenApiConnectInput["auth"]): string =>
  input.kind === "bearer"
    ? input.headerName?.trim() || DEFAULT_BEARER_HEADER_NAME
    : DEFAULT_BEARER_HEADER_NAME;

const bearerPrefixValue = (input: OpenApiConnectInput["auth"]): string =>
  input.kind === "bearer"
    ? input.prefix ?? DEFAULT_BEARER_PREFIX
    : DEFAULT_BEARER_PREFIX;

const trimToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const authFromSecretValue = (
  authKind: OpenApiConnectInput["auth"]["kind"],
  value: string,
  headerName: string,
  prefix: string,
): OpenApiConnectInput["auth"] => {
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
    tokenSecretRef: JSON.parse(value) as OpenApiConnectInput["auth"] & { tokenSecretRef: never }["tokenSecretRef"],
    headerName: trimToNull(headerName),
    prefix: prefix === DEFAULT_BEARER_PREFIX ? null : prefix,
  };
};

function OpenApiSourceForm(props: {
  mode: "create" | "edit";
  workspaceId: Source["scopeId"];
  initialValue: OpenApiConnectInput;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (input: OpenApiConnectInput) => Promise<void>;
}) {
  const openApiHttpClient = getOpenApiHttpClient();
  const previewDocument = useAtomSet(
    openApiHttpClient.mutation("openapi", "previewDocument"),
    { mode: "promise" },
  );
  const [name, setName] = useState(props.initialValue.name);
  const [iconUrl, setIconUrl] = useState(props.initialValue.iconUrl ?? "");
  const [specUrl, setSpecUrl] = useState(props.initialValue.specUrl);
  const [baseUrl, setBaseUrl] = useState(props.initialValue.baseUrl ?? "");
  const [authKind, setAuthKind] = useState<OpenApiConnectInput["auth"]["kind"]>(
    props.initialValue.auth.kind,
  );
  const [tokenSecretRef, setTokenSecretRef] = useState(
    secretValue(props.initialValue.auth),
  );
  const [authHeaderName, setAuthHeaderName] = useState(
    bearerHeaderNameValue(props.initialValue.auth),
  );
  const [authPrefix, setAuthPrefix] = useState(
    bearerPrefixValue(props.initialValue.auth),
  );
  const [useSpecFetchCredentials, setUseSpecFetchCredentials] = useState(
    props.initialValue.useSpecFetchCredentials === true,
  );
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<OpenApiPreviewResponse | null>(null);
  const [nameEdited, setNameEdited] = useState(false);
  const [baseUrlEdited, setBaseUrlEdited] = useState(false);
  const [lastPreviewedSpecUrl, setLastPreviewedSpecUrl] = useState<string | null>(null);
  const previewMutation = useExecutorMutation<
    OpenApiPreviewRequest,
    OpenApiPreviewResponse
  >(async (payload) =>
    previewDocument({
      path: { workspaceId: props.workspaceId },
      payload,
    })
  );
  const submitMutation = useExecutorMutation<OpenApiConnectInput, void>(props.onSubmit);
  const resolvedIconUrl = iconUrl.trim() || getFaviconUrlForRemoteUrl(baseUrl || specUrl) || getSourceFaviconUrl(name);

  const runPreview = useEffectEvent(async (input: {
    mode: "auto" | "manual";
  }) => {
    const trimmedSpecUrl = specUrl.trim();
    if (!trimmedSpecUrl) {
      if (input.mode === "manual") {
        setError("Spec URL is required.");
      }
      setPreview(null);
      setLastPreviewedSpecUrl(null);
      return;
    }

    if (!isPreviewableSpecUrl(trimmedSpecUrl)) {
      return;
    }

    try {
      const result = await previewMutation.mutateAsync({
        specUrl: trimmedSpecUrl,
      });
      setPreview({
        ...result,
        warnings: [...result.warnings],
        securitySchemes: [...result.securitySchemes],
      });
      setLastPreviewedSpecUrl(trimmedSpecUrl);
      if (error) {
        setError(null);
      }

      if (!nameEdited && result.title) {
        setName(result.title);
      }
      if (!baseUrlEdited && result.baseUrl) {
        setBaseUrl(result.baseUrl);
      }
    } catch (cause) {
      if (input.mode === "manual") {
        setError(cause instanceof Error ? cause.message : "Failed previewing document.");
      }
      setPreview(null);
    }
  });

  useEffect(() => {
    const trimmedSpecUrl = specUrl.trim();
    if (!isPreviewableSpecUrl(trimmedSpecUrl)) {
      return;
    }

    if (trimmedSpecUrl === lastPreviewedSpecUrl) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void runPreview({ mode: "auto" });
    }, 450);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [specUrl, lastPreviewedSpecUrl]);

  const handleSubmit = async () => {
    setError(null);
    const trimmedName = name.trim();
    const trimmedSpecUrl = specUrl.trim();
    const trimmedBaseUrl = baseUrl.trim();

    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (!trimmedSpecUrl) {
      setError("Spec URL is required.");
      return;
    }
    if (authKind === "bearer" && tokenSecretRef.trim().length === 0) {
      setError("Select a secret for bearer auth.");
      return;
    }

    try {
      const auth = authFromSecretValue(
        authKind,
        tokenSecretRef,
        authHeaderName,
        authPrefix,
      );
      await submitMutation.mutateAsync({
        name: trimmedName,
        ...(iconUrl.trim() ? { iconUrl: iconUrl.trim() } : {}),
        specUrl: trimmedSpecUrl,
        baseUrl: trimmedBaseUrl || null,
        auth,
        useSpecFetchCredentials,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed saving source.");
    }
  };

  return (
    <div className="space-y-6 rounded-lg border border-border bg-card p-6 text-sm ring-1 ring-foreground/[0.04]">
      <Section title="Connection">
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
              }}
              placeholder="GitHub REST"
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
            <Label>Spec URL</Label>
            <Input
              value={specUrl}
              onChange={(event) => setSpecUrl(event.target.value)}
              onBlur={() => {
                void runPreview({ mode: "manual" });
              }}
              placeholder="https://example.com/openapi.json"
              className="font-mono text-xs"
            />
          </div>

          <div className="grid gap-2">
            <Label>Base URL</Label>
            <Input
              value={baseUrl}
              onChange={(event) => {
                setBaseUrlEdited(true);
                setBaseUrl(event.target.value);
              }}
              placeholder="https://api.example.com"
              className="font-mono text-xs"
            />
          </div>

          <div className="grid gap-2">
            <Label>Auth</Label>
            <Select
              value={authKind}
              onChange={(event) =>
                setAuthKind(event.target.value as OpenApiConnectInput["auth"]["kind"])}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer Secret</option>
            </Select>
          </div>

          {authKind === "bearer" && (
            <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
              <SecretReferenceField
                label="Secret"
                value={tokenSecretRef}
                emptyLabel="Select a secret"
                draftNamePlaceholder="OpenAPI bearer token"
                draftValuePlaceholder="Paste the token value"
                onChange={setTokenSecretRef}
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

              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={useSpecFetchCredentials}
                  onChange={(event) => setUseSpecFetchCredentials(event.target.checked)}
                  className="mt-0.5 rounded border-border"
                />
                <div className="space-y-1">
                  <div className="font-medium text-foreground">
                    Use credentials for spec fetch
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Send this bearer token when downloading the OpenAPI document and any
                    referenced files. Leave it off for public specs hosted elsewhere.
                  </div>
                </div>
              </label>
            </div>
          )}
        </div>
      </Section>

      {(preview || previewMutation.status === "pending") && (
        <Section title="Preview">
          {previewMutation.status === "pending" ? (
            <div className="text-xs text-muted-foreground">Loading preview...</div>
          ) : preview && (
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                <dt className="font-medium text-foreground">Title</dt>
                <dd className="text-muted-foreground">{preview.title ?? "—"}</dd>
                <dt className="font-medium text-foreground">Version</dt>
                <dd className="text-muted-foreground">{preview.version ?? "—"}</dd>
                <dt className="font-medium text-foreground">Operations</dt>
                <dd className="text-muted-foreground">{preview.operationCount}</dd>
                <dt className="font-medium text-foreground">Base URL</dt>
                <dd className="font-mono text-muted-foreground">{preview.baseUrl ?? "—"}</dd>
                {preview.namespace && (
                  <>
                    <dt className="font-medium text-foreground">Namespace</dt>
                    <dd className="text-muted-foreground">{preview.namespace}</dd>
                  </>
                )}
                {preview.securitySchemes.length > 0 && (
                  <>
                    <dt className="font-medium text-foreground">Auth</dt>
                    <dd className="text-muted-foreground">
                      {preview.securitySchemes
                        .map((scheme) => `${scheme.name} (${previewSecuritySchemeLabel(scheme)})`)
                        .join(", ")}
                    </dd>
                  </>
                )}
              </dl>
              {preview.warnings.length > 0 && (
                <Alert variant="warning" className="mt-3 text-xs">
                  {preview.warnings.join(" ")}
                </Alert>
              )}
            </div>
          )}
        </Section>
      )}

      {error && (
        <Alert variant="destructive">
          {error}
        </Alert>
      )}

      <div className="flex items-center justify-end">
        <Button
          type="button"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={submitMutation.status === "pending"}
        >
          {submitMutation.status === "pending" ? props.busyLabel : props.submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function OpenApiAddSourcePage() {
  const navigation = useSourcePluginNavigation();
  const initialValue = openApiInputFromSearch(useSourcePluginSearch());
  const openApiHttpClient = getOpenApiHttpClient();
  const workspace = useWorkspaceRequestContext();
  const createSource = useAtomSet(
    openApiHttpClient.mutation("openapi", "createSource"),
    { mode: "promise" },
  );

  if (!workspace.enabled) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <div className="text-sm text-muted-foreground">Loading workspace...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl tracking-tight text-foreground">
            Add OpenAPI Source
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            Import operations from an OpenAPI specification as callable tools.
          </p>
        </div>

        <OpenApiSourceForm
          mode="create"
          workspaceId={workspace.workspaceId}
          initialValue={initialValue}
          submitLabel="Create Source"
          busyLabel="Creating..."
          onSubmit={async (payload) => {
            const source = await createSource({
              path: { workspaceId: workspace.workspaceId },
              payload,
              reactivityKeys: {
                sources: [workspace.workspaceId],
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

export function OpenApiEditSourcePage(props: {
  source: Source;
}) {
  const workspace = useWorkspaceRequestContext();

  if (!workspace.enabled) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <div className="text-sm text-muted-foreground">Loading workspace...</div>
        </div>
      </div>
    );
  }

  return (
    <OpenApiEditSourcePageReady
      source={props.source}
      workspaceId={workspace.workspaceId}
    />
  );
}

function OpenApiEditSourcePageReady(props: {
  source: Source;
  workspaceId: Source["scopeId"];
}) {
  const navigation = useSourcePluginNavigation();
  const openApiHttpClient = getOpenApiHttpClient();
  const configResult = useAtomValue(
    openApiHttpClient.query("openapi", "getSourceConfig", {
      path: {
        workspaceId: props.workspaceId,
        sourceId: props.source.id,
      },
      reactivityKeys: {
        source: [props.workspaceId, props.source.id],
      },
      timeToLive: "30 seconds",
    }),
  );
  const updateSource = useAtomSet(
    openApiHttpClient.mutation("openapi", "updateSource"),
    { mode: "promise" },
  );

  if (!Result.isSuccess(configResult)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          {Result.isFailure(configResult) ? (
            <Alert variant="destructive">
              Failed loading source configuration.
            </Alert>
          ) : (
            <div className="text-sm text-muted-foreground">Loading configuration...</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl tracking-tight text-foreground">
            Edit OpenAPI Source
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            Update the connection settings for {props.source.name}.
          </p>
        </div>

        <OpenApiSourceForm
          mode="edit"
          workspaceId={props.workspaceId}
          initialValue={inputFromConfig(configResult.value)}
          submitLabel="Save Changes"
          busyLabel="Saving..."
          onSubmit={async (config) => {
            const source = await updateSource({
              path: {
                workspaceId: props.workspaceId,
                sourceId: props.source.id,
              },
              payload: config,
              reactivityKeys: {
                sources: [props.workspaceId],
                source: [props.workspaceId, props.source.id],
                sourceInspection: [props.workspaceId, props.source.id],
                sourceInspectionTool: [props.workspaceId, props.source.id],
                sourceDiscovery: [props.workspaceId, props.source.id],
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

export function OpenApiSourceDetailPage(props: {
  source: Source;
}) {
  const workspace = useWorkspaceRequestContext();

  if (!workspace.enabled) {
    return (
      <Section title="Source">
        <div className="text-sm text-muted-foreground">Loading workspace...</div>
      </Section>
    );
  }

  return (
    <OpenApiSourceDetailPageReady
      source={props.source}
      workspaceId={workspace.workspaceId}
    />
  );
}

function OpenApiSourceDetailPageReady(props: {
  source: Source;
  workspaceId: Source["scopeId"];
}) {
  const navigation = useSourcePluginNavigation();
  const openApiHttpClient = getOpenApiHttpClient();
  const removeSource = useAtomSet(
    openApiHttpClient.mutation("openapi", "removeSource"),
    { mode: "promise" },
  );
  const refreshSource = useAtomSet(
    openApiHttpClient.mutation("openapi", "refreshSource"),
    { mode: "promise" },
  );
  const refreshMutation = useExecutorMutation<Source["id"], Source>(async (sourceId) =>
    refreshSource({
      path: {
        workspaceId: props.workspaceId,
        sourceId,
      },
      reactivityKeys: {
        sources: [props.workspaceId],
        source: [props.workspaceId, sourceId],
        sourceInspection: [props.workspaceId, sourceId],
        sourceInspectionTool: [props.workspaceId, sourceId],
        sourceDiscovery: [props.workspaceId, sourceId],
      },
    })
  );
  const removeMutation = useExecutorMutation<Source["id"], { removed: boolean }>(async (sourceId) =>
    removeSource({
      path: {
        workspaceId: props.workspaceId,
        sourceId,
      },
      reactivityKeys: {
        sources: [props.workspaceId],
        source: [props.workspaceId, sourceId],
        sourceInspection: [props.workspaceId, sourceId],
        sourceInspectionTool: [props.workspaceId, sourceId],
        sourceDiscovery: [props.workspaceId, sourceId],
      },
    })
  );
  const search = parseSourceToolExplorerSearch(
    useSourcePluginSearch(),
  ) satisfies RouteToolSearch;
  const tab = search.tab === "discover" ? "discover" : "model";
  const query = search.query ?? "";
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <SourceToolExplorer
      sourceId={props.source.id}
      title={props.source.name}
      kind={props.source.kind}
      search={search}
      navigate={(next) =>
        navigation.updateSearch({
          tab: next.tab ?? tab,
          ...(next.tool !== undefined
            ? { tool: next.tool || undefined }
            : { tool: search.tool }),
          ...(next.query !== undefined
            ? { query: next.query || undefined }
            : { query }),
        })}
      actions={(
        <>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              void refreshMutation.mutateAsync(props.source.id);
            }}
            disabled={refreshMutation.status === "pending"}
          >
            {refreshMutation.status === "pending" ? "Refreshing..." : "Refresh"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
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
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={removeMutation.status === "pending"}
              >
                Cancel
              </Button>
              <Button
                variant="destructive-outline"
                size="sm"
                type="button"
                onClick={() => {
                  void removeMutation.mutateAsync(props.source.id).then(() => {
                    startTransition(() => {
                      void navigation.home();
                    });
                  }).finally(() => {
                    setConfirmDelete(false);
                  });
                }}
                disabled={removeMutation.status === "pending"}
              >
                {removeMutation.status === "pending" ? "Deleting..." : "Delete"}
              </Button>
            </div>
          ) : (
            <Button
              variant="destructive-outline"
              size="sm"
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={removeMutation.status === "pending"}
            >
              Delete
            </Button>
          )}
        </>
      )}
      renderHeaderMeta={renderOpenApiToolHeaderMeta}
      renderSchemaExtras={renderOpenApiToolSchemaExtras}
    />
  );
}

const renderOpenApiToolHeaderMeta = (detail: SourceInspectionToolDetail) =>
  detail.summary.pathTemplate ? (
    <span className="font-mono text-[11px] text-muted-foreground/60">
      {detail.summary.pathTemplate}
    </span>
  ) : null;

const renderOpenApiToolSchemaExtras = (detail: SourceInspectionToolDetail) => (
  <>
    {detail.contract.input.exampleJson && (
      <DocumentPanel title="Example request" body={detail.contract.input.exampleJson} empty="" compact />
    )}
    {detail.contract.output.exampleJson && (
      <DocumentPanel title="Example response" body={detail.contract.output.exampleJson} empty="" compact />
    )}
  </>
);

function OpenApiSourceRoute(props: {
  children: (source: Source) => ReactNode;
}) {
  const params = useSourcePluginRouteParams<{ sourceId?: string }>();
  const sourceId = typeof params.sourceId === "string" ? params.sourceId : null;
  const source = useSource(sourceId ?? "");

  if (sourceId === null || source.status === "error") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        This OpenAPI source is unavailable.
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

  if (source.data.kind !== "openapi") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        Expected an `openapi` source, but received `{source.data.kind}`.
      </div>
    );
  }

  return props.children(source.data);
}

export function OpenApiDetailRoute() {
  return (
    <OpenApiSourceRoute>
      {(source) => <OpenApiSourceDetailPage source={source} />}
    </OpenApiSourceRoute>
  );
}

export function OpenApiEditRoute() {
  return (
    <OpenApiSourceRoute>
      {(source) => <OpenApiEditSourcePage source={source} />}
    </OpenApiSourceRoute>
  );
}
