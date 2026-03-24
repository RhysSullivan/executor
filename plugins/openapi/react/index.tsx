import type {
  Loadable,
  Source,
  SourceInspection,
  SourceInspectionToolDetail,
} from "@executor/react";
import {
  Result,
  defineExecutorPluginHttpApiClient,
  useAtomValue,
  useAtomSet,
  useCreateSecret,
  useExecutorMutation,
  useInstanceConfig,
  useLocalInstallation,
  usePrefetchToolDetail,
  useSourceDiscovery,
  useSourceInspection,
  useSourceToolDetail,
} from "@executor/react";
import { EmptyState, LoadableBlock } from "../../../apps/web/src/components/loadable";
import { DocumentPanel } from "../../../apps/web/src/components/document-panel";
import { Markdown } from "../../../apps/web/src/components/markdown";
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconCopy,
  IconFolder,
  IconPencil,
  IconSearch,
  IconTool,
} from "../../../apps/web/src/components/icons";
import { Badge, MethodBadge } from "../../../apps/web/src/components/ui/badge";
import { cn } from "../../../apps/web/src/lib/utils";
import {
  openApiHttpApiExtension,
} from "@executor/plugin-openapi-http";
import type {
  OpenApiConnectInput,
  OpenApiOAuthPopupResult,
  OpenApiPreviewRequest,
  OpenApiPreviewOAuthFlow,
  OpenApiPreviewSecurityScheme,
  OpenApiPreviewResponse,
  OpenApiSourceConfigPayload,
  OpenApiStartOAuthInput,
} from "@executor/plugin-openapi-shared";
import { useNavigate } from "@tanstack/react-router";
import { startTransition, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const OAUTH_STORAGE_PREFIX = "executor:openapi-oauth:";
const OAUTH_TIMEOUT_MS = 2 * 60_000;

type FrontendSourceTypeDefinition = {
  kind: string;
  displayName: string;
  renderAddPage: () => ReactNode;
  renderEditPage?: (input: { source: Source }) => ReactNode;
  renderDetailPage?: (input: {
    source: Source;
    route: {
      search?: unknown;
      navigate?: unknown;
    };
  }) => ReactNode;
};

type FrontendPluginRegisterApi = {
  sources: {
    registerType: (definition: FrontendSourceTypeDefinition) => void;
  };
};

type RouteToolSearch = {
  tab?: "model" | "discover";
  tool?: string;
  query?: string;
};

const defaultOpenApiInput = (): OpenApiConnectInput => ({
  name: "My OpenAPI Source",
  specUrl: "https://example.com/openapi.json",
  baseUrl: null,
  auth: {
    kind: "none",
  },
});

const getOpenApiHttpClient = defineExecutorPluginHttpApiClient<"OpenApiReactHttpClient">()(
  "OpenApiReactHttpClient",
  [openApiHttpApiExtension] as const,
);


const Section = (props: {
  title: string;
  children: ReactNode;
}) => (
  <section className="rounded-xl border border-border/70 bg-card/40 p-4">
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-sm font-semibold">{props.title}</h2>
      <span className="inline-flex items-center rounded-full border border-transparent bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
        Plugin
      </span>
    </div>
    {props.children}
  </section>
);

type ToolTreeNode = {
  segment: string;
  tool?: SourceInspectionToolDetail["summary"] | SourceInspection["tools"][number];
  children: Map<string, ToolTreeNode>;
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

const waitForOauthPopupResult = async (
  sessionId: string,
): Promise<OpenApiOAuthPopupResult> =>
  new Promise((resolve, reject) => {
    const storageKey = `${OAUTH_STORAGE_PREFIX}${sessionId}`;
    const startedAt = Date.now();

    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearInterval(intervalId);
    };

    const finish = (result: OpenApiOAuthPopupResult) => {
      cleanup();
      try {
        window.localStorage.removeItem(storageKey);
      } catch {}
      resolve(result);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as OpenApiOAuthPopupResult | undefined;
      if (!data || data.type !== "executor:oauth-result") {
        return;
      }

      if (data.ok && data.sessionId !== sessionId) {
        return;
      }

      finish(data);
    };

    window.addEventListener("message", handleMessage);
    const intervalId = window.setInterval(() => {
      if (Date.now() - startedAt > OAUTH_TIMEOUT_MS) {
        cleanup();
        reject(new Error("Timed out waiting for OpenAPI OAuth to finish."));
        return;
      }

      try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) {
          return;
        }

        finish(JSON.parse(raw) as OpenApiOAuthPopupResult);
      } catch {
        // Ignore malformed local storage and continue polling.
      }
    }, 400);
  });

const stringifyScopes = (scopes: ReadonlyArray<string>): string =>
  scopes.length === 0 ? "" : scopes.join("\n");

const parseScopes = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((scope) => scope.trim())
    .filter(Boolean);

const supportedAuthorizationCodeFlowForScheme = (
  scheme: OpenApiPreviewSecurityScheme | null,
): OpenApiPreviewOAuthFlow | null =>
  scheme?.kind === "oauth2"
    ? (
        scheme.oauthFlows.find(
          (flow) => flow.name === "authorizationCode" && flow.supported,
        ) ?? null
      )
    : null;

const inputFromConfig = (
  config: OpenApiSourceConfigPayload,
): OpenApiConnectInput => ({
  name: config.name,
  specUrl: config.specUrl,
  baseUrl: config.baseUrl,
  auth: config.auth,
});

const useWorkspaceId = (): Source["scopeId"] => {
  const installation = useLocalInstallation();
  if (installation.status === "ready") {
    return installation.data.scopeId;
  }

  if (installation.status === "error") {
    throw installation.error;
  }

  throw new Error("Workspace is still loading.");
};

const useAvailableSecrets = (
  openApiHttpClient: ReturnType<typeof getOpenApiHttpClient>,
) => {
  const secretsResult = useAtomValue(
    openApiHttpClient.query("local", "listSecrets", {
      reactivityKeys: {
        secrets: [],
      },
      timeToLive: "1 minute",
    }),
  );

  return Result.isSuccess(secretsResult) ? secretsResult.value : [];
};

function OpenApiSourceForm(props: {
  mode: "create" | "edit";
  initialValue: OpenApiConnectInput;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (input: OpenApiConnectInput) => Promise<void>;
}) {
  const openApiHttpClient = getOpenApiHttpClient();
  const availableSecrets = useAvailableSecrets(openApiHttpClient);
  const instanceConfig = useInstanceConfig();
  const createSecret = useCreateSecret();
  const previewDocument = useAtomSet(
    openApiHttpClient.mutation("openapi", "previewDocument"),
    { mode: "promise" },
  );
  const startOAuth = useAtomSet(
    openApiHttpClient.mutation("openapi", "startOAuth"),
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
    props.initialValue.auth.kind === "bearer"
      ? props.initialValue.auth.tokenSecretRef
      : "",
  );
  const [selectedOauthSchemeName, setSelectedOauthSchemeName] = useState(
    props.initialValue.auth.kind === "oauth2" ? props.initialValue.auth.schemeName : "",
  );
  const [oauthScopesText, setOauthScopesText] = useState(
    props.initialValue.auth.kind === "oauth2"
      ? stringifyScopes(props.initialValue.auth.scopes)
      : "",
  );
  const [clientId, setClientId] = useState(
    props.initialValue.auth.kind === "oauth2" ? props.initialValue.auth.clientId : "",
  );
  const [clientSecretRef, setClientSecretRef] = useState(
    props.initialValue.auth.kind === "oauth2"
      ? props.initialValue.auth.clientSecretRef ?? ""
      : "",
  );
  const [isCreatingClientSecret, setIsCreatingClientSecret] = useState(false);
  const [newClientSecretName, setNewClientSecretName] = useState("");
  const [newClientSecretValue, setNewClientSecretValue] = useState("");
  const [newClientSecretProviderId, setNewClientSecretProviderId] = useState("");
  const [newClientSecretError, setNewClientSecretError] = useState<string | null>(null);
  const [oauthAuth, setOauthAuth] = useState<
    Extract<OpenApiConnectInput["auth"], { kind: "oauth2" }> | null
  >(
    props.initialValue.auth.kind === "oauth2"
      ? props.initialValue.auth
      : null,
  );
  const [oauthStatus, setOauthStatus] = useState<"idle" | "pending" | "connected">(
    props.initialValue.auth.kind === "oauth2" ? "connected" : "idle",
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

  const oauthSchemeOptions = useMemo(
    () =>
      (preview?.securitySchemes ?? []).filter((scheme) =>
        supportedAuthorizationCodeFlowForScheme(scheme) !== null
      ),
    [preview],
  );
  const secretProviderOptions = useMemo(
    () =>
      instanceConfig.status === "ready"
        ? instanceConfig.data.secretProviders
          .filter((provider) => provider.canStore)
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
          }))
        : [],
    [instanceConfig],
  );
  const defaultSecretStoreProviderId =
    instanceConfig.status === "ready"
      ? instanceConfig.data.defaultSecretStoreProvider
      : null;
  const selectedOauthScheme = useMemo(
    () =>
      oauthSchemeOptions.find((scheme) => scheme.name === selectedOauthSchemeName) ?? null,
    [oauthSchemeOptions, selectedOauthSchemeName],
  );
  const selectedAuthorizationCodeFlow = useMemo(
    () => supportedAuthorizationCodeFlowForScheme(selectedOauthScheme),
    [selectedOauthScheme],
  );

  const resetOauthState = () => {
    setOauthAuth(null);
    setOauthStatus("idle");
  };

  useEffect(() => {
    if (newClientSecretProviderId.length > 0) {
      return;
    }
    if (defaultSecretStoreProviderId) {
      setNewClientSecretProviderId(defaultSecretStoreProviderId);
    }
  }, [defaultSecretStoreProviderId, newClientSecretProviderId]);

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
      const supportedSchemes = result.securitySchemes.filter((scheme) =>
        supportedAuthorizationCodeFlowForScheme(scheme) !== null
      );
      if (supportedSchemes.length > 0) {
        const nextScheme =
          supportedSchemes.find((scheme) => scheme.name === selectedOauthSchemeName)
          ?? supportedSchemes[0];
        if (nextScheme?.name !== selectedOauthSchemeName) {
          resetOauthState();
          const nextFlow = supportedAuthorizationCodeFlowForScheme(nextScheme ?? null);
          setOauthScopesText(
            stringifyScopes(nextFlow?.scopes.map((scope) => scope.name) ?? []),
          );
        }
        setSelectedOauthSchemeName(nextScheme?.name ?? "");
        const nextFlow = supportedAuthorizationCodeFlowForScheme(nextScheme ?? null);
        if (
          nextFlow
          && oauthStatus !== "connected"
          && oauthScopesText.trim().length === 0
        ) {
          setOauthScopesText(stringifyScopes(nextFlow.scopes.map((scope) => scope.name)));
        }
      } else {
        setSelectedOauthSchemeName("");
      }
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

  const runOauth = async () => {
    const selectedScheme = selectedOauthScheme;
    const selectedFlow = selectedAuthorizationCodeFlow;
    if (!selectedScheme || !selectedFlow) {
      throw new Error("Select an OpenAPI OAuth scheme with an authorization code flow.");
    }
    if (!clientId.trim()) {
      throw new Error("Client ID is required for OpenAPI OAuth.");
    }

    const payload: OpenApiStartOAuthInput = {
      schemeName: selectedScheme.name,
      flow: "authorizationCode",
      authorizationEndpoint: selectedFlow.authorizationUrl ?? "",
      tokenEndpoint: selectedFlow.tokenUrl ?? "",
      scopes: parseScopes(oauthScopesText),
      clientId: clientId.trim(),
      clientSecretRef: clientSecretRef.trim() || null,
      redirectUrl: new URL(
        "/v1/plugins/openapi/oauth/callback",
        window.location.origin,
      ).toString(),
    };

    const started = await startOAuth({
      path: { workspaceId },
      payload,
    });

    const popup = window.open(
      started.authorizationUrl,
      "executor-openapi-oauth",
      "width=560,height=760,noopener,noreferrer",
    );
    if (!popup) {
      throw new Error("Failed opening OpenAPI OAuth popup.");
    }

    const result = await waitForOauthPopupResult(started.sessionId);
    if (!result.ok) {
      throw new Error(result.error);
    }

    setOauthScopesText(stringifyScopes(result.auth.scopes));
    setOauthAuth(result.auth);
    setOauthStatus("connected");
  };

  const handleCreateClientSecret = async () => {
    setNewClientSecretError(null);
    const trimmedName = newClientSecretName.trim();
    if (!trimmedName) {
      setNewClientSecretError("Secret name is required.");
      return;
    }
    if (!newClientSecretValue) {
      setNewClientSecretError("Secret value is required.");
      return;
    }

    try {
      const created = await createSecret.mutateAsync({
        name: trimmedName,
        value: newClientSecretValue,
        ...(newClientSecretProviderId
          ? { providerId: newClientSecretProviderId }
          : {}),
      });
      setClientSecretRef(created.id);
      setIsCreatingClientSecret(false);
      setNewClientSecretName("");
      setNewClientSecretValue("");
      setNewClientSecretError(null);
      resetOauthState();
    } catch (cause) {
      setNewClientSecretError(
        cause instanceof Error ? cause.message : "Failed storing client secret.",
      );
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

  useEffect(() => {
    if (!selectedAuthorizationCodeFlow || authKind !== "oauth2") {
      return;
    }

    if (oauthStatus === "connected" || oauthScopesText.trim().length > 0) {
      return;
    }

    setOauthScopesText(
      stringifyScopes(selectedAuthorizationCodeFlow.scopes.map((scope) => scope.name)),
    );
  }, [authKind, oauthStatus, oauthScopesText, selectedAuthorizationCodeFlow]);

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
    if (authKind === "oauth2" && !oauthAuth) {
      setError("Finish OpenAPI OAuth before saving.");
      return;
    }

    try {
      await submitMutation.mutateAsync({
        name: trimmedName,
        specUrl: trimmedSpecUrl,
        baseUrl: trimmedBaseUrl || null,
        auth:
          authKind === "bearer"
            ? {
                kind: "bearer",
                tokenSecretRef: tokenSecretRef.trim(),
              }
            : authKind === "oauth2" && oauthAuth
              ? oauthAuth
            : {
                kind: "none",
              },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed saving source.");
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Connection">
        <p className="text-sm text-muted-foreground">
          This plugin owns its typed HTTP client and source payload shape. The app shell only
          mounts the registered page.
        </p>
        <div className="mt-4 grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">Name</span>
            <input
              value={name}
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
              }}
              placeholder="GitHub REST"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">Spec URL</span>
            <input
              value={specUrl}
              onChange={(event) => {
                setSpecUrl(event.target.value);
                if (authKind === "oauth2") {
                  resetOauthState();
                }
              }}
              onBlur={() => {
                void runPreview({ mode: "manual" });
              }}
              placeholder="https://example.com/openapi.json"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => {
                setBaseUrlEdited(true);
                setBaseUrl(event.target.value);
              }}
              placeholder="https://api.example.com"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">Auth</span>
            <select
              value={authKind}
              onChange={(event) => {
                const nextAuthKind = event.target.value as OpenApiConnectInput["auth"]["kind"];
                setAuthKind(nextAuthKind);
                setError(null);
                if (nextAuthKind !== "oauth2") {
                  resetOauthState();
                }
              }}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            >
              <option value="none">None</option>
              <option value="bearer">Bearer Secret</option>
              <option value="oauth2">OAuth 2.0</option>
            </select>
          </label>

          {authKind === "bearer" && (
            <label className="grid gap-1.5">
              <span className="text-[12px] font-medium text-foreground">Secret</span>
              <select
                value={tokenSecretRef}
                onChange={(event) => setTokenSecretRef(event.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
              >
                <option value="">Select a secret</option>
                {availableSecrets.map((secret) => (
                  <option key={secret.id} value={secret.id}>
                    {secret.name || secret.id}
                  </option>
                ))}
              </select>
            </label>
          )}

          {authKind === "oauth2" && (
            <div className="space-y-4 rounded-xl border border-border/70 bg-background/50 p-4">
              <p className="text-xs text-muted-foreground">
                Executor will store your OAuth access token and refresh token locally as
                secrets. PKCE is always enabled for this flow.
              </p>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">OAuth Scheme</span>
                <select
                  value={selectedOauthSchemeName}
                  onChange={(event) => {
                    const nextSchemeName = event.target.value;
                    const nextScheme =
                      oauthSchemeOptions.find((scheme) => scheme.name === nextSchemeName)
                      ?? null;
                    setSelectedOauthSchemeName(nextSchemeName);
                    setOauthScopesText(
                      stringifyScopes(
                        supportedAuthorizationCodeFlowForScheme(nextScheme)?.scopes.map(
                          (scope) => scope.name,
                        ) ?? [],
                      ),
                    );
                    resetOauthState();
                  }}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
                >
                  <option value="">Select a scheme</option>
                  {oauthSchemeOptions.map((scheme) => (
                    <option key={scheme.name} value={scheme.name}>
                      {scheme.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-1.5">
                  <span className="text-[12px] font-medium text-foreground">Flow</span>
                  <input
                    value="Authorization Code"
                    readOnly
                    className="h-10 w-full rounded-lg border border-input bg-muted/40 px-3 text-[13px] text-muted-foreground outline-none"
                  />
                </label>

                <label className="grid gap-1.5">
                  <span className="text-[12px] font-medium text-foreground">Client ID</span>
                  <input
                    value={clientId}
                    onChange={(event) => {
                      setClientId(event.target.value);
                      resetOauthState();
                    }}
                    className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
                  />
                </label>
              </div>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Client Secret</span>
                <select
                  value={clientSecretRef}
                  onChange={(event) => {
                    setClientSecretRef(event.target.value);
                    resetOauthState();
                  }}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
                >
                  <option value="">Public client / no secret</option>
                  {availableSecrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name || secret.id}
                    </option>
                  ))}
                </select>
              </label>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsCreatingClientSecret((current) => !current);
                    setNewClientSecretError(null);
                  }}
                  className="inline-flex h-8 items-center justify-center rounded-lg border border-input bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
                >
                  {isCreatingClientSecret ? "Use an existing secret" : "Paste and store a new secret"}
                </button>

                {isCreatingClientSecret && (
                  <div className="space-y-3 rounded-lg border border-border/70 bg-card/60 p-3">
                    {newClientSecretError && (
                      <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
                        {newClientSecretError}
                      </div>
                    )}

                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="grid gap-1.5">
                        <span className="text-[12px] font-medium text-foreground">Secret Name</span>
                        <input
                          value={newClientSecretName}
                          onChange={(event) => setNewClientSecretName(event.target.value)}
                          placeholder="OpenAPI OAuth Client Secret"
                          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/25"
                        />
                      </label>

                      <label className="grid gap-1.5">
                        <span className="text-[12px] font-medium text-foreground">Store In</span>
                        <select
                          value={newClientSecretProviderId}
                          onChange={(event) => setNewClientSecretProviderId(event.target.value)}
                          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
                          disabled={secretProviderOptions.length === 0}
                        >
                          {secretProviderOptions.length === 0 ? (
                            <option value="">No writable secret providers available</option>
                          ) : (
                            secretProviderOptions.map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.name}
                              </option>
                            ))
                          )}
                        </select>
                      </label>
                    </div>

                    <label className="grid gap-1.5">
                      <span className="text-[12px] font-medium text-foreground">Secret Value</span>
                      <input
                        type="password"
                        value={newClientSecretValue}
                        onChange={(event) => setNewClientSecretValue(event.target.value)}
                        placeholder="Paste the OAuth client secret"
                        className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-ring focus:ring-1 focus:ring-ring/25"
                      />
                    </label>

                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          void handleCreateClientSecret();
                        }}
                        disabled={
                          createSecret.status === "pending"
                          || secretProviderOptions.length === 0
                        }
                        className="inline-flex h-9 items-center justify-center rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50"
                      >
                        {createSecret.status === "pending" ? "Storing..." : "Store secret"}
                      </button>
                      <div className="text-xs text-muted-foreground">
                        The secret is stored locally, then selected for this OAuth client.
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Scopes</span>
                <textarea
                  value={oauthScopesText}
                  onChange={(event) => {
                    setOauthScopesText(event.target.value);
                    resetOauthState();
                  }}
                  rows={4}
                  className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
                />
              </label>

              {selectedAuthorizationCodeFlow ? (
                <div className="rounded-lg border border-border/70 bg-card/60 px-3 py-2 text-xs text-muted-foreground">
                  <div>Authorization URL: {selectedAuthorizationCodeFlow.authorizationUrl}</div>
                  <div>Token URL: {selectedAuthorizationCodeFlow.tokenUrl}</div>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-300/40 bg-amber-100/20 px-3 py-2 text-xs text-amber-800">
                  Choose a previewed OAuth 2.0 scheme with an authorization code flow to connect.
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      setError(null);
                      setOauthStatus("pending");
                      try {
                        await runOauth();
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : "OpenAPI OAuth failed.");
                        setOauthStatus("idle");
                        return;
                      }
                    })();
                  }}
                  disabled={
                    oauthStatus === "pending"
                    || !selectedAuthorizationCodeFlow
                    || !selectedOauthSchemeName
                  }
                  className="inline-flex h-9 items-center justify-center rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50"
                >
                  {oauthStatus === "pending"
                    ? "Connecting..."
                    : oauthStatus === "connected"
                      ? "Reconnect OAuth"
                      : "Connect OAuth"}
                </button>
                <div className="text-xs text-muted-foreground">
                  {oauthStatus === "connected"
                    ? "Access token and refresh token are ready and will be saved with this source."
                    : "Executor stores the resulting access and refresh tokens locally as secrets."}
                </div>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section title="Preview">
        <p className="text-sm text-muted-foreground">
          Preview introspects the document and can pull out defaults like title and base URL from
          the OpenAPI spec.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              void runPreview({ mode: "manual" });
            }}
            disabled={previewMutation.status === "pending" || submitMutation.status === "pending"}
            className="inline-flex h-7 items-center justify-center rounded-md border border-input bg-transparent px-2.5 text-xs font-medium text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {previewMutation.status === "pending" ? "Previewing..." : "Preview OpenAPI Document"}
          </button>
          {previewMutation.status === "pending" && (
            <div className="text-xs text-muted-foreground">
              Inferring from spec...
            </div>
          )}
          {preview && (
            <div className="text-xs text-muted-foreground">
              {preview.operationCount} operations
              {preview.version ? ` · v${preview.version}` : ""}
            </div>
          )}
        </div>
        {preview && (
          <div className="mt-4 rounded-lg border border-border/70 bg-background/60 p-4 text-sm">
            <div className="grid gap-2">
              <div>
                <span className="font-medium text-foreground">Title:</span>{" "}
                <span className="text-muted-foreground">{preview.title ?? "Unknown"}</span>
              </div>
              <div>
                <span className="font-medium text-foreground">Version:</span>{" "}
                <span className="text-muted-foreground">{preview.version ?? "Unknown"}</span>
              </div>
              <div>
                <span className="font-medium text-foreground">Base URL:</span>{" "}
                <span className="text-muted-foreground">{preview.baseUrl ?? "Not declared"}</span>
              </div>
              <div>
                <span className="font-medium text-foreground">Namespace:</span>{" "}
                <span className="text-muted-foreground">{preview.namespace ?? "Not inferred"}</span>
              </div>
              <div>
                <span className="font-medium text-foreground">Auth:</span>{" "}
                <span className="text-muted-foreground">
                  {preview.securitySchemes.length > 0
                    ? preview.securitySchemes
                        .map((scheme) => `${scheme.name} (${previewSecuritySchemeLabel(scheme)})`)
                        .join(", ")
                    : "No declared auth schemes"}
                </span>
              </div>
            </div>
            {preview.warnings.length > 0 && (
              <div className="mt-3 rounded-md border border-amber-300/40 bg-amber-100/20 px-3 py-2 text-xs text-amber-800">
                {preview.warnings.join(" ")}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title={props.mode === "create" ? "Submit" : "Save"}>
        {error && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-[13px] text-destructive">
            {error}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={submitMutation.status === "pending"}
            className="inline-flex h-7 items-center justify-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {submitMutation.status === "pending" ? props.busyLabel : props.submitLabel}
          </button>
          <div className="text-xs text-muted-foreground">
            {props.mode === "create"
              ? "Creates a real source and immediately imports its tools."
              : "Updates plugin-owned config and refreshes the imported model."}
          </div>
        </div>
      </Section>
    </div>
  );
}

function OpenApiAddSourcePage(props: {
  initialValue: OpenApiConnectInput;
}) {
  const navigate = useNavigate();
  const openApiHttpClient = getOpenApiHttpClient();
  const createSource = useAtomSet(
    openApiHttpClient.mutation("openapi", "createSource"),
    { mode: "promise" },
  );
  const workspaceId = useWorkspaceId();

  return (
    <OpenApiSourceForm
      mode="create"
      initialValue={props.initialValue}
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
          void navigate({
            to: "/sources/$sourceId",
            params: {
              sourceId: source.id,
            },
            search: {
              tab: "model",
            },
          });
        });
      }}
    />
  );
}

function OpenApiEditSourcePage(props: {
  source: Source;
}) {
  const navigate = useNavigate();
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
        <Section title="OpenAPI Plugin Editor">
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-4 text-sm text-destructive">
            Failed loading plugin config.
          </div>
        </Section>
      );
    }

    return (
      <Section title="OpenAPI Plugin Editor">
        <div className="text-sm text-muted-foreground">Loading plugin config...</div>
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
          void navigate({
            to: "/sources/$sourceId",
            params: {
              sourceId: source.id,
            },
            search: {
              tab: "model",
            },
          });
        });
      }}
    />
  );
}

function OpenApiSourceDetailPage(props: {
  source: Source;
  route: {
    search?: unknown;
    navigate?: unknown;
  };
}) {
  const routerNavigate = useNavigate();
  const openApiHttpClient = getOpenApiHttpClient();
  const workspaceId = useWorkspaceId();
  const removeSource = useAtomSet(
    openApiHttpClient.mutation("openapi", "removeSource"),
    { mode: "promise" },
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
  const inspection = useSourceInspection(props.source.id);
  const search = (props.route.search ?? {}) as RouteToolSearch;
  const navigate =
    props.route.navigate as
      | ((input: {
          search: {
            tab: "model" | "discover";
            tool?: string;
            query?: string;
          };
        }) => void | Promise<void>)
      | undefined;
  const tab = search.tab === "discover" ? "discover" : "model";
  const query = search.query ?? "";
  const selectedToolPath =
    search.tool ?? (inspection.status === "ready" ? inspection.data.tools[0]?.path ?? null : null);
  const discovery = useSourceDiscovery({
    sourceId: props.source.id,
    query,
    limit: 20,
  });
  const toolDetail = useSourceToolDetail(props.source.id, selectedToolPath);

  const setRouteSearch = (next: {
    tab?: "model" | "discover";
    tool?: string;
    query?: string;
  }) => {
    if (!navigate) {
      return;
    }

    void navigate({
      search: {
        tab: next.tab ?? tab,
        ...(next.tool !== undefined
          ? { tool: next.tool || undefined }
          : { tool: search.tool }),
        ...(next.query !== undefined
          ? { query: next.query || undefined }
          : { query }),
      },
    });
  };

  useEffect(() => {
    if (tab !== "model" || selectedToolPath || inspection.status !== "ready") {
      return;
    }

    const firstTool = inspection.data.tools[0]?.path;
    if (!firstTool) {
      return;
    }

    setRouteSearch({
      tab: "model",
      tool: firstTool,
    });
  }, [inspection.status, selectedToolPath, tab]);

  return (
    <LoadableBlock loadable={inspection} loading="Loading source...">
      {(loadedInspection) => {
        const selectedTool =
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
                      onClick={() => setRouteSearch({ tab: tabId })}
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
                  onClick={() =>
                    void routerNavigate({
                      to: "/sources/$sourceId/edit",
                      params: { sourceId: props.source.id },
                    })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  <IconPencil className="size-3" />
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const confirmed = window.confirm(`Delete OpenAPI source "${props.source.name}"?`);
                    if (!confirmed) return;

                    void removeMutation.mutateAsync(props.source.id).then(() => {
                      startTransition(() => {
                        void routerNavigate({ to: "/" });
                      });
                    });
                  }}
                  disabled={removeMutation.status === "pending"}
                  className="inline-flex items-center rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                >
                  {removeMutation.status === "pending" ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>

            <div className="flex flex-1 min-h-0 overflow-hidden">
              {tab === "model" ? (
                <ModelView
                  bundle={loadedInspection}
                  detail={toolDetail}
                  selectedToolPath={selectedTool?.path ?? null}
                  onSelectTool={(toolPath) =>
                    setRouteSearch({
                      tab: "model",
                      tool: toolPath,
                    })}
                  sourceId={props.source.id}
                />
              ) : (
                <DiscoveryView
                  bundle={loadedInspection}
                  initialQuery={query}
                  discovery={discovery}
                  onSubmitQuery={(nextQuery) =>
                    setRouteSearch({
                      tab: "discover",
                      query: nextQuery,
                    })}
                  onOpenTool={(toolPath) =>
                    setRouteSearch({
                      tab: "model",
                      tool: toolPath,
                      query,
                    })}
                />
              )}
            </div>
          </div>
        );
      }}
    </LoadableBlock>
  );
}

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
    const corpus = [
      tool.path,
      tool.method ?? "",
      tool.inputTypePreview ?? "",
      tool.outputTypePreview ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => corpus.includes(term));
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        searchRef.current?.blur();
        if (search.length > 0) setSearch("");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [search]);

  return (
    <>
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-card/30 lg:w-80 xl:w-[22rem]">
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="relative">
            <IconSearch className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Filter ${props.bundle.toolCount} tools…`}
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
  const entries = [...tree.children.values()].sort((a, b) => a.segment.localeCompare(b.segment));

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
  prefetch: ReturnType<typeof usePrefetchToolDetail>;
}) {
  const { node, depth, selectedToolPath, onSelectTool, search, defaultOpen, sourceId, prefetch } = props;
  const hasChildren = node.children.size > 0;
  const isLeaf = !!node.tool && !hasChildren;

  const hasSelectedDescendant = useMemo(() => {
    if (!selectedToolPath) return false;
    function check(candidate: ToolTreeNode): boolean {
      if (candidate.tool?.path === selectedToolPath) return true;
      for (const child of candidate.children.values()) {
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
  const sortedChildren = [...node.children.values()].sort((a, b) => a.segment.localeCompare(b.segment));
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
          <ToolListItem
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
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/25">{leafCount}</span>
        </button>
      )}

      {open && hasChildren && (
        <div className="relative flex flex-col gap-px">
          <span className="absolute bottom-1 top-0 w-px bg-border/40" style={{ left: paddingLeft + 5 }} aria-hidden />
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

function ToolListItem(props: {
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

function ToolDetailPanel(props: {
  detail: SourceInspectionToolDetail;
}) {
  const { detail } = props;
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const inputType = detail.contract.input.typeDeclaration
    ?? detail.contract.input.typePreview
    ?? null;
  const outputType = detail.contract.output.typeDeclaration
    ?? detail.contract.output.typePreview
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
                {detail.summary.path}
              </h3>
              <CopyButton
                text={detail.summary.path}
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

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-4 px-5 py-4">
          {detail.summary.description && <Markdown>{detail.summary.description}</Markdown>}

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <DocumentPanel title="Input" body={inputType} lang="typescript" empty="No input." />
            <DocumentPanel title="Output" body={outputType} lang="typescript" empty="No output." />
          </div>

          <DocumentPanel title="Call Signature" body={detail.contract.callSignature} lang="typescript" empty="No call signature." />

          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            <DocumentPanel title="Input schema" body={detail.contract.input.schemaJson} empty="No input schema." compact />
            <DocumentPanel title="Output schema" body={detail.contract.output.schemaJson} empty="No output schema." compact />
            {detail.contract.input.exampleJson && (
              <DocumentPanel title="Example request" body={detail.contract.input.exampleJson} empty="" compact />
            )}
            {detail.contract.output.exampleJson && (
              <DocumentPanel title="Example response" body={detail.contract.output.exampleJson} empty="" compact />
            )}
          </div>

          {detail.sections.map((section, index) => (
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
                <DocumentPanel title={section.title} body={section.body} lang={section.language} empty="" />
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function DiscoveryView(props: {
  bundle: SourceInspection;
  discovery: Loadable<ReturnType<typeof useSourceDiscovery> extends Loadable<infer T> ? T : never>;
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
              placeholder="Search tools…"
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
        <LoadableBlock loadable={props.discovery} loading="Searching…">
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
  for (let index = 1; index < ranges.length; index++) {
    const last = merged[merged.length - 1]!;
    const current = ranges[index]!;
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
      {parts.map((part, index) =>
        part.hl ? (
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

export const OpenApiReactPlugin = {
  key: "openapi",
  register(api: FrontendPluginRegisterApi) {
    api.sources.registerType({
      kind: "openapi",
      displayName: "OpenAPI",
      renderAddPage: () => (
        <OpenApiAddSourcePage initialValue={defaultOpenApiInput()} />
      ),
      renderEditPage: ({ source }) => (
        <OpenApiEditSourcePage source={source} />
      ),
      renderDetailPage: ({ source, route }) => (
        <OpenApiSourceDetailPage source={source} route={route} />
      ),
    });
  },
};
