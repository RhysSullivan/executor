import type {
  Source,
  SourceInspectionToolDetail,
} from "@executor/react";
import {
  Result,
  defineExecutorPluginHttpApiClient,
  useAtomValue,
  useAtomSet,
  useCreateSecret,
  useExecutorMutation,
  useSecrets,
  useSource,
  useWorkspaceId,
} from "@executor/react";
import {
  DocumentPanel,
  IconPencil,
  SourceToolDetailPanel,
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
import type {
  OpenApiConnectInput,
  OpenApiPreviewRequest,
  OpenApiPreviewSecurityScheme,
  OpenApiPreviewResponse,
  OpenApiSourceConfigPayload,
} from "@executor/plugin-openapi-shared";
import { startTransition, useEffect, useState, type ReactNode } from "react";

type RouteToolSearch = SourceToolExplorerSearch;

const defaultOpenApiInput = (): OpenApiConnectInput => ({
  name: "My OpenAPI Source",
  specUrl: "https://example.com/openapi.json",
  baseUrl: null,
  auth: {
    kind: "none",
  },
});

const DEFAULT_BEARER_HEADER_NAME = "Authorization";
const DEFAULT_BEARER_PREFIX = "Bearer ";
const CREATE_SECRET_VALUE = "__create_openapi_secret__";

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
    <h2 className="mb-3 text-sm font-semibold text-foreground">{props.title}</h2>
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
  specUrl: config.specUrl,
  baseUrl: config.baseUrl,
  auth: config.auth,
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
        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
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
        <div className="space-y-3 border-l-2 border-border pl-4">
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder={props.draftNamePlaceholder}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
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

function OpenApiSourceForm(props: {
  mode: "create" | "edit";
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
  const workspaceId = useWorkspaceId();
  const [name, setName] = useState(props.initialValue.name);
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
      path: { workspaceId },
      payload,
    })
  );
  const submitMutation = useExecutorMutation<OpenApiConnectInput, void>(props.onSubmit);

  const runPreview = async (input: {
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
  };

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
        specUrl: trimmedSpecUrl,
        baseUrl: trimmedBaseUrl || null,
        auth,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed saving source.");
    }
  };

  return (
    <div className="space-y-6 rounded-xl border border-border p-6">
      <Section title="Connection">
        <div className="grid gap-4">
          <label className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Name</span>
            <input
              value={name}
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
              }}
              placeholder="GitHub REST"
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Spec URL</span>
            <input
              value={specUrl}
              onChange={(event) => setSpecUrl(event.target.value)}
              onBlur={() => {
                void runPreview({ mode: "manual" });
              }}
              placeholder="https://example.com/openapi.json"
              className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => {
                setBaseUrlEdited(true);
                setBaseUrl(event.target.value);
              }}
              placeholder="https://api.example.com"
              className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Auth</span>
            <select
              value={authKind}
              onChange={(event) =>
                setAuthKind(event.target.value as OpenApiConnectInput["auth"]["kind"])}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            >
              <option value="none">None</option>
              <option value="bearer">Bearer Secret</option>
            </select>
          </label>

          {authKind === "bearer" && (
            <div className="space-y-4 border-l-2 border-border pl-4">
              <SecretSelectOrCreateField
                label="Secret"
                value={tokenSecretRef}
                emptyLabel="Select a secret"
                draftNamePlaceholder="OpenAPI bearer token"
                draftValuePlaceholder="Paste the token value"
                onChange={setTokenSecretRef}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-xs font-medium text-foreground">Header Name</span>
                  <input
                    value={authHeaderName}
                    onChange={(event) => setAuthHeaderName(event.target.value)}
                    placeholder={DEFAULT_BEARER_HEADER_NAME}
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/25"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-xs font-medium text-foreground">Prefix</span>
                  <input
                    value={authPrefix}
                    onChange={(event) => setAuthPrefix(event.target.value)}
                    placeholder={DEFAULT_BEARER_PREFIX}
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/25"
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section title="Preview">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              void runPreview({ mode: "manual" });
            }}
            disabled={previewMutation.status === "pending" || submitMutation.status === "pending"}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50"
          >
            {previewMutation.status === "pending" ? "Previewing..." : "Preview Spec"}
          </button>
          {preview && (
            <div className="text-xs text-muted-foreground">
              {preview.operationCount} operations
              {preview.version ? ` · v${preview.version}` : ""}
            </div>
          )}
        </div>
        {preview && (
          <div className="mt-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="font-medium text-foreground">Title</dt>
              <dd className="text-muted-foreground">{preview.title ?? "—"}</dd>
              <dt className="font-medium text-foreground">Version</dt>
              <dd className="text-muted-foreground">{preview.version ?? "—"}</dd>
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
              <div className="mt-3 rounded-md border border-amber-300/40 bg-amber-100/20 px-3 py-2 text-xs text-amber-800">
                {preview.warnings.join(" ")}
              </div>
            )}
          </div>
        )}
      </Section>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={submitMutation.status === "pending"}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
        >
          {submitMutation.status === "pending" ? props.busyLabel : props.submitLabel}
        </button>
      </div>
    </div>
  );
}

export function OpenApiAddSourcePage() {
  const navigation = useSourcePluginNavigation();
  const initialValue = openApiInputFromSearch(useSourcePluginSearch());
  const openApiHttpClient = getOpenApiHttpClient();
  const createSource = useAtomSet(
    openApiHttpClient.mutation("openapi", "createSource"),
    { mode: "promise" },
  );
  const workspaceId = useWorkspaceId();

  return (
    <OpenApiSourceForm
      mode="create"
      initialValue={initialValue}
      submitLabel="Create Source"
      busyLabel="Creating..."
      onSubmit={async (payload) => {
        const source = await createSource({
          path: { workspaceId },
          payload,
          reactivityKeys: {
            sources: [workspaceId],
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

export function OpenApiEditSourcePage(props: {
  source: Source;
}) {
  const navigation = useSourcePluginNavigation();
  const openApiHttpClient = getOpenApiHttpClient();
  const workspaceId = useWorkspaceId();
  const configResult = useAtomValue(
    openApiHttpClient.query("openapi", "getSourceConfig", {
      path: {
        workspaceId,
        sourceId: props.source.id,
      },
      reactivityKeys: {
        source: [workspaceId, props.source.id],
      },
      timeToLive: "30 seconds",
    }),
  );
  const updateSource = useAtomSet(
    openApiHttpClient.mutation("openapi", "updateSource"),
    { mode: "promise" },
  );

  if (!Result.isSuccess(configResult)) {
    if (Result.isFailure(configResult)) {
      return (
        <Section title="Edit Source">
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-4 text-sm text-destructive">
            Failed loading source configuration.
          </div>
        </Section>
      );
    }

    return (
      <Section title="Edit Source">
        <div className="text-sm text-muted-foreground">Loading configuration...</div>
      </Section>
    );
  }

  return (
    <OpenApiSourceForm
      mode="edit"
      initialValue={inputFromConfig(configResult.value)}
      submitLabel="Save Changes"
      busyLabel="Saving..."
      onSubmit={async (config) => {
        const source = await updateSource({
          path: {
            workspaceId,
            sourceId: props.source.id,
          },
          payload: config,
          reactivityKeys: {
            sources: [workspaceId],
            source: [workspaceId, props.source.id],
            sourceInspection: [workspaceId, props.source.id],
            sourceInspectionTool: [workspaceId, props.source.id],
            sourceDiscovery: [workspaceId, props.source.id],
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

export function OpenApiSourceDetailPage(props: {
  source: Source;
}) {
  const navigation = useSourcePluginNavigation();
  const openApiHttpClient = getOpenApiHttpClient();
  const workspaceId = useWorkspaceId();
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
        workspaceId,
        sourceId,
      },
      reactivityKeys: {
        sources: [workspaceId],
        source: [workspaceId, sourceId],
        sourceInspection: [workspaceId, sourceId],
        sourceInspectionTool: [workspaceId, sourceId],
        sourceDiscovery: [workspaceId, sourceId],
      },
    })
  );
  const removeMutation = useExecutorMutation<Source["id"], { removed: boolean }>(async (sourceId) =>
    removeSource({
      path: {
        workspaceId,
        sourceId,
      },
      reactivityKeys: {
        sources: [workspaceId],
        source: [workspaceId, sourceId],
        sourceInspection: [workspaceId, sourceId],
        sourceInspectionTool: [workspaceId, sourceId],
        sourceDiscovery: [workspaceId, sourceId],
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
          <button
            type="button"
            onClick={() => {
              void refreshMutation.mutateAsync(props.source.id);
            }}
            disabled={refreshMutation.status === "pending"}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {refreshMutation.status === "pending" ? "Refreshing..." : "Refresh"}
          </button>
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
                disabled={removeMutation.status === "pending"}
                className="inline-flex items-center rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                Cancel
              </button>
              <button
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
                className="inline-flex items-center rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
              >
                {removeMutation.status === "pending" ? "Deleting..." : "Delete"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={removeMutation.status === "pending"}
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
          renderHeaderMeta={renderOpenApiToolHeaderMeta}
          renderSchemaExtras={renderOpenApiToolSchemaExtras}
        />
      )}
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
