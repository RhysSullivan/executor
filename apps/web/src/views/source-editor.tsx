import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type CompleteSourceOAuthResult,
  type CreateSourcePayload,
  type InstanceConfig,
  type Loadable,
  type StartSourceOAuthPayload,
  type SecretListItem,
  type Source,
  type UpdateSourcePayload,
  useCreateSecret,
  useCreateSource,
  useInstanceConfig,
  useRefreshSecrets,
  useRemoveSource,
  useSecrets,
  useSources,
  useStartSourceOAuth,
  useSource,
  useUpdateSource,
} from "@executor/react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { LoadableBlock } from "../components/loadable";
import { SourceNotFoundState } from "../components/source-not-found-state";
import { SourceFavicon } from "../components/source-favicon";
import {
  IconArrowLeft,
  IconPencil,
  IconPlus,
  IconSpinner,
  IconTrash,
} from "../components/icons";
import { cn } from "../lib/utils";
import { sourceTemplates, type SourceTemplate } from "./source-templates";
import { getDomain } from "tldts";

type StatusBannerState = {
  tone: "info" | "success" | "error";
  text: string;
};

type SourceOAuthPopupMessage =
  | {
      type: "executor:oauth-result";
      ok: true;
      sessionId: string;
      auth: CompleteSourceOAuthResult["auth"];
    }
  | {
      type: "executor:oauth-result";
      ok: false;
      sessionId: string | null;
      error: string;
    };

const SOURCE_OAUTH_POPUP_RESULT_TIMEOUT_MS = 2 * 60_000;
const SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX = "executor:oauth-result:";

const isSourceNotFoundLoadable = (loadable: Loadable<unknown>): boolean =>
  loadable.status === "error"
  && loadable.error.message.toLowerCase().includes("source not found");

type TransportValue = "" | "auto" | "streamable-http" | "sse";

type SourceFormState = {
  name: string;
  kind: Source["kind"];
  endpoint: string;
  namespace: string;
  enabled: boolean;
  transport: TransportValue;
  queryParamsText: string;
  headersText: string;
  specUrl: string;
  defaultHeadersText: string;
  authKind: Source["auth"]["kind"];
  authHeaderName: string;
  authPrefix: string;
  bearerProviderId: string;
  bearerHandle: string;
  oauthAccessProviderId: string;
  oauthAccessHandle: string;
  oauthRefreshProviderId: string;
  oauthRefreshHandle: string;
};

const kindOptions: ReadonlyArray<Source["kind"]> = ["mcp", "openapi", "graphql", "internal"];

const transportOptions: ReadonlyArray<Exclude<TransportValue, "">> = [
  "auto",
  "streamable-http",
  "sse",
];

const authOptions: ReadonlyArray<Source["auth"]["kind"]> = ["none", "bearer", "oauth2"];

const trimToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const namespaceFromUrl = (url: string): string => {
  try {
    const domain = getDomain(url);
    if (!domain) return "";
    const dot = domain.indexOf(".");
    return dot > 0 ? domain.slice(0, dot) : domain;
  } catch {
    return "";
  }
};

const readStoredSourceOAuthPopupResult = (sessionId: string): SourceOAuthPopupMessage | null => {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(
    `${SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX}${sessionId}`,
  );
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SourceOAuthPopupMessage;
  } catch {
    return null;
  }
};

const clearStoredSourceOAuthPopupResult = (sessionId: string): void => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(`${SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX}${sessionId}`);
};

const startSourceOAuthPopup = async (input: {
  authorizationUrl: string;
  sessionId: string;
}): Promise<CompleteSourceOAuthResult["auth"]> => {
  if (typeof window === "undefined") {
    throw new Error("OAuth popup is only available in a browser context");
  }

  clearStoredSourceOAuthPopupResult(input.sessionId);

  const popup = window.open(
    input.authorizationUrl,
    "executor-source-oauth",
    "popup=yes,width=520,height=720",
  );

  if (!popup) {
    throw new Error("Popup blocked. Allow popups and try again.");
  }

  popup.focus();

  return await new Promise<CompleteSourceOAuthResult["auth"]>((resolve, reject) => {
    let settled = false;
    let closedPoll = 0;
    let resultTimeout = 0;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      if (closedPoll) {
        window.clearInterval(closedPoll);
      }
      if (resultTimeout) {
        window.clearTimeout(resultTimeout);
      }
      if (!popup.closed) {
        popup.close();
      }
      clearStoredSourceOAuthPopupResult(input.sessionId);
    };

    const settleWithError = (message: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const settleFromPayload = (data: SourceOAuthPopupMessage) => {
      if (!data.ok) {
        settleWithError(data.error || "OAuth failed");
        return;
      }

      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(data.auth);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as SourceOAuthPopupMessage | undefined;
      if (!data || data.type !== "executor:oauth-result") {
        return;
      }

      if (data.ok && data.sessionId !== input.sessionId) {
        return;
      }

      if (!data.ok && data.sessionId !== null && data.sessionId !== input.sessionId) {
        return;
      }

      settleFromPayload(data);
    };

    window.addEventListener("message", onMessage);

    resultTimeout = window.setTimeout(() => {
      settleWithError("OAuth popup timed out before completion. Please try again.");
    }, SOURCE_OAUTH_POPUP_RESULT_TIMEOUT_MS);

    closedPoll = window.setInterval(() => {
      const stored = readStoredSourceOAuthPopupResult(input.sessionId);
      if (stored) {
        settleFromPayload(stored);
        return;
      }
      if (popup.closed) {
        // Stop polling — only run one final deferred check to give the
        // callback page time to write localStorage before we give up.
        window.clearInterval(closedPoll);
        closedPoll = 0;
        window.setTimeout(() => {
          const delayedStored = readStoredSourceOAuthPopupResult(input.sessionId);
          if (delayedStored) {
            settleFromPayload(delayedStored);
            return;
          }
          settleWithError("OAuth popup was closed before completion.");
        }, 1500);
      }
    }, 300);
  });
};

const stringMapToEditor = (value: Record<string, string> | null): string =>
  value === null ? "" : JSON.stringify(value, null, 2);

const readBindingStringMap = (
  source: Source,
  key: string,
): Record<string, string> | null => {
  const candidate = source.binding[key];
  if (candidate === null || candidate === undefined || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const entries = Object.entries(candidate as Record<string, unknown>);
  return entries.every(([, value]) => typeof value === "string")
    ? Object.fromEntries(entries as ReadonlyArray<readonly [string, string]>)
    : null;
};

const readBindingString = (source: Source, key: string): string =>
  typeof source.binding[key] === "string" ? String(source.binding[key]) : "";

const readBindingTransport = (source: Source): TransportValue => {
  const candidate = source.binding.transport;
  return typeof candidate === "string" && (candidate === "auto" || candidate === "streamable-http" || candidate === "sse")
    ? candidate
    : "";
};

const defaultFormState = (template?: SourceTemplate): SourceFormState => ({
  name: template?.name ?? "",
  kind: template?.kind ?? "openapi",
  endpoint: template?.endpoint ?? "",
  namespace: template ? namespaceFromUrl(template.endpoint) : "",
  enabled: true,
  transport: template?.kind === "mcp" ? "auto" : "",
  queryParamsText: "",
  headersText: "",
  specUrl: template && "specUrl" in template ? template.specUrl : "",
  defaultHeadersText: "",
  authKind: "none",
  authHeaderName: "Authorization",
  authPrefix: "Bearer ",
  bearerProviderId: "",
  bearerHandle: "",
  oauthAccessProviderId: "",
  oauthAccessHandle: "",
  oauthRefreshProviderId: "",
  oauthRefreshHandle: "",
});

const formStateFromSource = (source: Source): SourceFormState => ({
  name: source.name,
  kind: source.kind,
  endpoint: source.endpoint,
  namespace: source.namespace ?? "",
  enabled: source.enabled,
  transport: source.kind === "mcp" ? (readBindingTransport(source) || "auto") : "",
  queryParamsText: stringMapToEditor(readBindingStringMap(source, "queryParams")),
  headersText: stringMapToEditor(readBindingStringMap(source, "headers")),
  specUrl: readBindingString(source, "specUrl"),
  defaultHeadersText: stringMapToEditor(readBindingStringMap(source, "defaultHeaders")),
  authKind: source.auth.kind,
  authHeaderName: source.auth.kind === "none" ? "Authorization" : source.auth.headerName,
  authPrefix: source.auth.kind === "none" ? "Bearer " : source.auth.prefix,
  bearerProviderId: source.auth.kind === "bearer" ? source.auth.token.providerId : "",
  bearerHandle: source.auth.kind === "bearer" ? source.auth.token.handle : "",
  oauthAccessProviderId: source.auth.kind === "oauth2" ? source.auth.accessToken.providerId : "",
  oauthAccessHandle: source.auth.kind === "oauth2" ? source.auth.accessToken.handle : "",
  oauthRefreshProviderId:
    source.auth.kind === "oauth2" && source.auth.refreshToken !== null
      ? source.auth.refreshToken.providerId
      : "",
  oauthRefreshHandle:
    source.auth.kind === "oauth2" && source.auth.refreshToken !== null
      ? source.auth.refreshToken.handle
      : "",
});

const parseJsonStringMap = (label: string, text: string): Record<string, string> | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} must be valid JSON.`);
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object with string values.`);
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      throw new Error(`${label} must only contain string values.`);
    }
    normalized[key] = value;
  }

  return Object.keys(normalized).length === 0 ? null : normalized;
};

const buildAuthPayload = (state: SourceFormState): CreateSourcePayload["auth"] => {
  if (state.authKind === "none") {
    return { kind: "none" };
  }

  const headerName = state.authHeaderName.trim() || "Authorization";
  const prefix = state.authPrefix;

  if (state.authKind === "bearer") {
    const providerId = state.bearerProviderId.trim();
    const handle = state.bearerHandle.trim();
    if (!providerId || !handle) {
      throw new Error("Bearer auth requires a token. Select or create a secret.");
    }

    return {
      kind: "bearer",
      headerName,
      prefix,
      token: {
        providerId,
        handle,
      },
    };
  }

  const accessProviderId = state.oauthAccessProviderId.trim();
  const accessHandle = state.oauthAccessHandle.trim();
  if (!accessProviderId || !accessHandle) {
    throw new Error("OAuth2 auth requires an access token. Select or create a secret.");
  }

  const refreshProviderId = trimToNull(state.oauthRefreshProviderId);
  const refreshHandle = trimToNull(state.oauthRefreshHandle);
  if ((refreshProviderId === null) !== (refreshHandle === null)) {
    throw new Error("OAuth2 refresh token provider ID and handle must be set together.");
  }

  return {
    kind: "oauth2",
    headerName,
    prefix,
    accessToken: {
      providerId: accessProviderId,
      handle: accessHandle,
    },
    refreshToken:
      refreshProviderId === null || refreshHandle === null
        ? null
        : {
            providerId: refreshProviderId,
            handle: refreshHandle,
          },
  };
};

const buildRequestedSourceStatus = (state: SourceFormState): CreateSourcePayload["status"] => {
  if (state.kind !== "mcp" && state.kind !== "openapi" && state.kind !== "graphql") {
    return undefined;
  }

  return state.enabled ? "connected" : "draft";
};

const buildSourcePayload = (state: SourceFormState): CreateSourcePayload => {
  const name = state.name.trim();
  const endpoint = state.endpoint.trim();

  if (!name) {
    throw new Error("Source name is required.");
  }

  if (!endpoint) {
    throw new Error("Source endpoint is required.");
  }

  const shared = {
    name,
    kind: state.kind,
    endpoint,
    status: buildRequestedSourceStatus(state),
    enabled: state.enabled,
    namespace: trimToNull(state.namespace),
    auth: buildAuthPayload(state),
  } satisfies Pick<CreateSourcePayload, "name" | "kind" | "endpoint" | "status" | "enabled" | "namespace" | "auth">;

  if (state.kind === "mcp") {
    return {
      ...shared,
      binding: {
        transport: state.transport === "" ? "auto" : state.transport,
        queryParams: parseJsonStringMap("Query params", state.queryParamsText),
        headers: parseJsonStringMap("Request headers", state.headersText),
      },
    };
  }

  if (state.kind === "openapi") {
    const specUrl = state.specUrl.trim();
    if (!specUrl) {
      throw new Error("OpenAPI sources require a spec URL.");
    }

    return {
      ...shared,
      binding: {
        specUrl,
        defaultHeaders: parseJsonStringMap("Default headers", state.defaultHeadersText),
      },
    };
  }

  if (state.kind === "graphql") {
    return {
      ...shared,
      binding: {
        defaultHeaders: parseJsonStringMap("Default headers", state.defaultHeadersText),
      },
    };
  }

  return {
    ...shared,
    binding: {},
  };
};

const buildUpdatePayload = (state: SourceFormState): UpdateSourcePayload => ({
  ...buildSourcePayload(state),
});

const buildStartSourceOAuthPayload = (state: SourceFormState): StartSourceOAuthPayload => {
  if (state.kind !== "mcp") {
    throw new Error("OAuth sign-in is only available for MCP sources.");
  }

  const endpoint = state.endpoint.trim();
  if (!endpoint) {
    throw new Error("Source endpoint is required before starting OAuth.");
  }

  return {
    provider: "mcp",
    name: trimToNull(state.name),
    endpoint,
    transport: state.transport === "" ? "auto" : state.transport,
    queryParams: parseJsonStringMap("Query params", state.queryParamsText),
    headers: parseJsonStringMap("Request headers", state.headersText),
  };
};

export function NewSourcePage() {
  return <SourceEditor key="create" mode="create" />;
}

export function EditSourcePage(props: { sourceId: string }) {
  const sources = useSources();
  const source = useSource(props.sourceId);
  const missingSource =
    (sources.status === "ready"
      && !sources.data.some((candidate) => candidate.id === props.sourceId))
    || isSourceNotFoundLoadable(source);

  if (missingSource) {
    return <SourceNotFoundState />;
  }

  return (
    <LoadableBlock loadable={source} loading="Loading source...">
      {(loadedSource) => (
        <SourceEditor
          key={`${loadedSource.id}:${loadedSource.updatedAt}`}
          mode="edit"
          source={loadedSource}
        />
      )}
    </LoadableBlock>
  );
}

function SourceEditor(props: { mode: "create" | "edit"; source?: Source }) {
  const navigate = useNavigate();
  const createSource = useCreateSource();
  const startSourceOAuth = useStartSourceOAuth();
  const updateSource = useUpdateSource();
  const removeSource = useRemoveSource();
  const instanceConfig = useInstanceConfig();
  const secrets = useSecrets();
  const refreshSecrets = useRefreshSecrets();
  const [formState, setFormState] = useState<SourceFormState>(() =>
    props.source ? formStateFromSource(props.source) : defaultFormState(),
  );
  const [statusBanner, setStatusBanner] = useState<StatusBannerState | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [oauthPopupBusy, setOauthPopupBusy] = useState(false);
  const [expandedOauthSecretRefTarget, setExpandedOauthSecretRefTarget] = useState<string | null>(null);

  const isSubmitting = createSource.status === "pending" || updateSource.status === "pending";
  const isDeleting = removeSource.status === "pending";
  const isOAuthSubmitting = startSourceOAuth.status === "pending" || oauthPopupBusy;
  const oauthSecretRefTarget =
    formState.authKind === "oauth2" && formState.oauthAccessHandle.trim().length > 0
      ? `${formState.oauthAccessProviderId}:${formState.oauthAccessHandle}:${formState.oauthRefreshProviderId}:${formState.oauthRefreshHandle}`
      : null;
  const showOauthSecretRefs =
    oauthSecretRefTarget !== null && expandedOauthSecretRefTarget === oauthSecretRefTarget;

  const setField = <K extends keyof SourceFormState>(key: K, value: SourceFormState[K]) => {
    setFormState((current) => ({ ...current, [key]: value }));
  };

  const applyTemplate = (template: SourceTemplate) => {
    setSelectedTemplateId(template.id);
    setFormState((current) => ({
      ...defaultFormState(template),
      name: current.name.trim().length > 0 ? current.name : template.name,
      enabled: current.enabled,
    }));
    setStatusBanner({
      tone: "info",
      text: `${template.name} loaded. Add auth if needed, then save.`,
    });
  };

  const handleSubmit = async () => {
    setStatusBanner(null);

    try {
      if (props.mode === "create") {
        const createdSource = await createSource.mutateAsync(buildSourcePayload(formState));
        void navigate({
          to: "/sources/$sourceId",
          params: { sourceId: createdSource.id },
          search: { tab: "model" },
        });
        return;
      }

      if (!props.source) {
        throw new Error("Cannot update a source before it has loaded.");
      }

      const updatedSource = await updateSource.mutateAsync({
        sourceId: props.source.id,
        payload: buildUpdatePayload(formState),
      });
      void navigate({
        to: "/sources/$sourceId",
        params: { sourceId: updatedSource.id },
        search: { tab: "model" },
      });
    } catch (error) {
      setStatusBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed saving source.",
      });
    }
  };

  const handleMcpOAuthConnect = async () => {
    setStatusBanner(null);

    try {
      const result = await startSourceOAuth.mutateAsync(buildStartSourceOAuthPayload(formState));

      setStatusBanner({
        tone: "info",
        text: "Finish OAuth in the popup. Saving will create the source and connect its tools.",
      });

      setOauthPopupBusy(true);
      const auth = await startSourceOAuthPopup({
        authorizationUrl: result.authorizationUrl,
        sessionId: result.sessionId,
      });
      setOauthPopupBusy(false);
      refreshSecrets();
      setExpandedOauthSecretRefTarget(null);
      setFormState((current) => ({
        ...current,
        authKind: "oauth2",
        authHeaderName: auth.headerName,
        authPrefix: auth.prefix,
        oauthAccessProviderId: auth.accessToken.providerId,
        oauthAccessHandle: auth.accessToken.handle,
        oauthRefreshProviderId: auth.refreshToken?.providerId ?? "",
        oauthRefreshHandle: auth.refreshToken?.handle ?? "",
      }));
      setStatusBanner({
        tone: "success",
        text: "OAuth credentials are ready. Save the source to connect and index tools.",
      });
    } catch (error) {
      setOauthPopupBusy(false);
      setStatusBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed starting OAuth.",
      });
    }
  };

  const handleRemove = async () => {
    if (!props.source || isDeleting) {
      return;
    }

    const confirmed = window.confirm(`Remove "${props.source.name}" and its indexed tools?`);
    if (!confirmed) {
      return;
    }

    setStatusBanner(null);

    try {
      const result = await removeSource.mutateAsync(props.source.id);
      if (!result.removed) {
        throw new Error("Source was not removed.");
      }
      void navigate({ to: "/" });
    } catch (error) {
      setStatusBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed removing source.",
      });
    }
  };

  const backLink = props.mode === "edit" && props.source
    ? { to: "/sources/$sourceId" as const, params: { sourceId: props.source.id }, search: { tab: "model" as const } }
    : { to: "/" as const };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8 lg:px-10 lg:py-12">
        {/* Back + title */}
        <Link
          {...backLink}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground mb-6"
        >
          <IconArrowLeft className="size-3.5" />
          {props.mode === "edit" ? "Back to source" : "Back"}
        </Link>

        <div className="flex items-center justify-between gap-4 mb-6">
          <h1 className="font-display text-2xl tracking-tight text-foreground lg:text-3xl">
            {props.mode === "edit" ? "Edit source" : "New source"}
          </h1>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{formState.kind}</Badge>
            <Badge variant={formState.enabled ? "default" : "muted"}>
              {formState.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>
        </div>

        {statusBanner && <StatusBanner state={statusBanner} className="mb-6" />}

        {/* Templates (create mode) */}
        {props.mode === "create" && (
          <Section title="Templates" className="mb-6">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {sourceTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  className={cn(
                    "rounded-xl border px-4 py-3 text-left transition-colors",
                    selectedTemplateId === template.id
                      ? "border-primary/40 bg-primary/8"
                      : "border-border bg-card/70 hover:bg-accent/50",
                  )}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                        <SourceFavicon endpoint={template.endpoint} kind={template.kind} className="size-4" />
                      </div>
                      <span className="truncate text-[13px] font-medium text-foreground">{template.name}</span>
                    </div>
                    <Badge variant="outline" className="text-[9px]">{template.kind}</Badge>
                  </div>
                  <span className="text-[11px] text-muted-foreground line-clamp-1">
                    {template.summary}
                  </span>
                </button>
              ))}
            </div>
          </Section>
        )}

        {/* Form */}
        <div className="space-y-6">
          <Section title="Basics">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <TextInput
                  value={formState.name}
                  onChange={(value) => setField("name", value)}
                  placeholder="GitHub REST"
                />
              </Field>
              <Field label="Kind">
                <SelectInput
                  value={formState.kind}
                  onChange={(value) => setField("kind", value as Source["kind"])}
                  options={kindOptions.map((value) => ({ value, label: value }))}
                />
              </Field>
              <Field
                label="Endpoint"
                className="sm:col-span-2"
              >
                <TextInput
                  value={formState.endpoint}
                  onChange={(value) => setField("endpoint", value)}
                  placeholder={
                    formState.kind === "openapi"
                      ? "https://api.github.com"
                      : formState.kind === "graphql"
                        ? "https://api.linear.app/graphql"
                        : "https://mcp.deepwiki.com/mcp"
                  }
                  mono
                />
              </Field>
              <Field label="Namespace">
                <TextInput
                  value={formState.namespace}
                  onChange={(value) => setField("namespace", value)}
                  placeholder="github"
                />
              </Field>
              <Field label="Status">
                <ToggleButton
                  checked={formState.enabled}
                  onChange={(checked) => setField("enabled", checked)}
                />
              </Field>
            </div>
          </Section>

          {formState.kind === "mcp" && (
            <Section title="Transport">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Transport mode">
                  <SelectInput
                    value={formState.transport || "auto"}
                    onChange={(value) => setField("transport", value as TransportValue)}
                    options={transportOptions.map((value) => ({ value, label: value }))}
                  />
                </Field>
                <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
                  <Field label="Query params (JSON)">
                    <CodeEditor
                      value={formState.queryParamsText}
                      onChange={(value) => setField("queryParamsText", value)}
                      placeholder={'{\n  "workspace": "demo"\n}'}
                    />
                  </Field>
                  <Field label="Headers (JSON)">
                    <CodeEditor
                      value={formState.headersText}
                      onChange={(value) => setField("headersText", value)}
                      placeholder={'{\n  "x-api-key": "..."\n}'}
                    />
                  </Field>
                </div>
              </div>
            </Section>
          )}

          {formState.kind === "openapi" && (
            <Section title="OpenAPI">
              <div className="grid gap-4">
                <Field label="Spec URL">
                  <TextInput
                    value={formState.specUrl}
                    onChange={(value) => setField("specUrl", value)}
                    placeholder="https://raw.githubusercontent.com/.../openapi.yaml"
                    mono
                  />
                </Field>
                <Field label="Default headers (JSON)">
                  <CodeEditor
                    value={formState.defaultHeadersText}
                    onChange={(value) => setField("defaultHeadersText", value)}
                    placeholder={'{\n  "x-api-version": "2026-03-01"\n}'}
                  />
                </Field>
              </div>
            </Section>
          )}

          {formState.kind === "graphql" && (
            <Section title="GraphQL">
              <div className="grid gap-4">
                <Field label="Default headers (JSON)">
                  <CodeEditor
                    value={formState.defaultHeadersText}
                    onChange={(value) => setField("defaultHeadersText", value)}
                    placeholder={'{\n  "x-api-version": "2026-03-01"\n}'}
                  />
                </Field>
              </div>
            </Section>
          )}

          <Section title="Authentication">
            <div className="grid gap-4 sm:grid-cols-2">
              {formState.kind === "mcp" && (
                <div className="sm:col-span-2 rounded-lg border border-border bg-card/70 px-4 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <p className="text-[13px] font-medium text-foreground">Sign in with OAuth</p>
                      <p className="text-[12px] text-muted-foreground">
                        Starts the same MCP connection flow used by `executor.sources.add`.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleMcpOAuthConnect}
                      disabled={isSubmitting || isDeleting || isOAuthSubmitting}
                    >
                      {isOAuthSubmitting ? <IconSpinner className="size-3.5" /> : null}
                      {formState.authKind === "oauth2" && formState.oauthAccessHandle.trim().length > 0
                        ? "Reconnect with OAuth"
                        : "Sign in with OAuth"}
                    </Button>
                  </div>
                  {formState.authKind === "oauth2" && formState.oauthAccessHandle.trim().length > 0 && (
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                      <p className="text-[12px] text-muted-foreground">
                        OAuth tokens are attached to this draft and stay hidden unless you need the raw refs.
                      </p>
                      <button
                        type="button"
                        className="text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() =>
                          setExpandedOauthSecretRefTarget((current) =>
                            current === oauthSecretRefTarget ? null : oauthSecretRefTarget,
                          )}
                      >
                        {showOauthSecretRefs ? "Hide token refs" : "Show token refs"}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <Field label="Auth mode">
                <SelectInput
                  value={formState.authKind}
                  onChange={(value) => setField("authKind", value as Source["auth"]["kind"])}
                  options={authOptions.map((value) => ({ value, label: value }))}
                />
              </Field>
              {formState.authKind !== "none" && (
                <>
                  <Field label="Header name">
                    <TextInput
                      value={formState.authHeaderName}
                      onChange={(value) => setField("authHeaderName", value)}
                      placeholder="Authorization"
                    />
                  </Field>
                  <Field label="Prefix">
                    <TextInput
                      value={formState.authPrefix}
                      onChange={(value) => setField("authPrefix", value)}
                      placeholder="Bearer "
                    />
                  </Field>
                </>
              )}

              {formState.authKind === "bearer" && (
                <Field label="Token" className="sm:col-span-2">
                  <SecretPicker
                    secrets={secrets}
                    providerId={formState.bearerProviderId}
                    handle={formState.bearerHandle}
                    onSelect={(providerId, handle) => {
                      setField("bearerProviderId", providerId);
                      setField("bearerHandle", handle);
                    }}
                  />
                </Field>
              )}

              {formState.authKind === "oauth2"
                && (formState.kind !== "mcp"
                  || formState.oauthAccessHandle.trim().length === 0
                  || showOauthSecretRefs) && (
                <>
                  <Field label="Access token" className="sm:col-span-2">
                    <SecretPicker
                      secrets={secrets}
                      providerId={formState.oauthAccessProviderId}
                      handle={formState.oauthAccessHandle}
                      onSelect={(providerId, handle) => {
                        setField("oauthAccessProviderId", providerId);
                        setField("oauthAccessHandle", handle);
                      }}
                    />
                  </Field>
                  <Field label="Refresh token (optional)" className="sm:col-span-2">
                    <SecretPicker
                      secrets={secrets}
                      providerId={formState.oauthRefreshProviderId}
                      handle={formState.oauthRefreshHandle}
                      onSelect={(providerId, handle) => {
                        setField("oauthRefreshProviderId", providerId);
                        setField("oauthRefreshHandle", handle);
                      }}
                      allowEmpty
                    />
                  </Field>
                </>
              )}
            </div>
          </Section>

          {/* Danger zone (edit mode) */}
          {props.mode === "edit" && props.source && (
            <Section title="Danger zone">
              <Button
                variant="outline"
                className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={handleRemove}
                disabled={isDeleting}
              >
                <IconTrash className="size-3.5" />
                {isDeleting ? "Removing\u2026" : "Remove source"}
              </Button>
            </Section>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 border-t border-border pt-5">
            <Link {...backLink} className="inline-flex">
              <Button variant="ghost" type="button">Cancel</Button>
            </Link>
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {props.mode === "edit" ? <IconPencil className="size-3.5" /> : <IconPlus className="size-3.5" />}
              {isSubmitting
                ? props.mode === "edit"
                  ? "Saving\u2026"
                  : "Creating\u2026"
                : props.mode === "edit"
                  ? "Save"
                  : "Create source"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form building blocks
// ---------------------------------------------------------------------------

function Section(props: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-border bg-card/80", props.className)}>
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">{props.title}</h2>
      </div>
      <div className="p-5">{props.children}</div>
    </section>
  );
}

function Field(props: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("block space-y-1.5", props.className)}>
      <span className="text-[12px] font-medium text-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      className={cn(
        "h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25",
        props.mono && "font-mono text-[12px]",
      )}
    />
  );
}

function SelectInput(props: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <select
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function CodeEditor(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      spellCheck={false}
      className="min-h-28 w-full rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
    />
  );
}

function ToggleButton(props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        "flex h-9 w-full items-center justify-between rounded-lg border px-3 text-[13px] transition-colors",
        props.checked
          ? "border-primary/40 bg-primary/8 text-foreground"
          : "border-input bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      <span>{props.checked ? "Enabled" : "Disabled"}</span>
      <span
        className={cn(
          "size-2 rounded-full",
          props.checked ? "bg-primary" : "bg-muted-foreground/30",
        )}
      />
    </button>
  );
}

function StatusBanner(props: { state: StatusBannerState; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 text-[13px]",
        props.state.tone === "success" && "border-primary/30 bg-primary/8 text-foreground",
        props.state.tone === "info" && "border-border bg-card text-muted-foreground",
        props.state.tone === "error" && "border-destructive/30 bg-destructive/8 text-destructive",
        props.className,
      )}
    >
      {props.state.text}
    </div>
  );
}

const CREATE_NEW_VALUE = "__create_new__";

function SecretPicker(props: {
  secrets: Loadable<ReadonlyArray<SecretListItem>>;
  providerId: string;
  handle: string;
  onSelect: (providerId: string, handle: string) => void;
  allowEmpty?: boolean;
}) {
  const { secrets, providerId, handle, onSelect, allowEmpty } = props;
  const createSecret = useCreateSecret();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  // Build the selected value key: if handle is set, use it (it's the secret ID)
  const selectedValue = handle || "";

  const handleSelectChange = (value: string) => {
    if (value === CREATE_NEW_VALUE) {
      setShowCreate(true);
      setNewName("");
      setNewValue("");
      setCreateError(null);
      return;
    }
    if (value === "") {
      onSelect("", "");
      return;
    }
    // Selecting an existing secret: providerId is always "postgres"
    onSelect("postgres", value);
  };

  const handleCreate = async () => {
    setCreateError(null);
    const trimmedName = newName.trim();
    if (!trimmedName) {
      setCreateError("Name is required.");
      return;
    }
    if (!newValue) {
      setCreateError("Value is required.");
      return;
    }

    try {
      const result = await createSecret.mutateAsync({ name: trimmedName, value: newValue });
      onSelect(result.providerId, result.id);
      setShowCreate(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed creating secret.");
    }
  };

  if (secrets.status !== "ready") {
    return (
      <select
        disabled
        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-muted-foreground outline-none opacity-60"
      >
        <option>Loading…</option>
      </select>
    );
  }

  const items = secrets.data;

  // Check if the current handle matches a known secret
  const matchedSecret = items.find((s) => s.id === handle);
  const isExternalRef = handle && !matchedSecret && providerId !== "postgres";

  return (
    <div className="space-y-2">
      <select
        value={showCreate ? CREATE_NEW_VALUE : selectedValue}
        onChange={(e) => handleSelectChange(e.target.value)}
        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
      >
        {allowEmpty && <option value="">None</option>}
        {!allowEmpty && !selectedValue && <option value="">Select a secret…</option>}
        {items.map((secret) => (
          <option key={secret.id} value={secret.id}>
            {secret.name || secret.id}
          </option>
        ))}
        {isExternalRef && (
          <option value={handle}>
            {providerId}:{handle}
          </option>
        )}
        <option value={CREATE_NEW_VALUE}>+ Create new secret</option>
      </select>

      {showCreate && (
        <div className="rounded-lg border border-primary/20 bg-card/80 p-3 space-y-3">
          {createError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-[12px] text-destructive">
              {createError}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">Name</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="GitHub PAT"
                className="h-8 w-full rounded-lg border border-input bg-background px-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
                autoFocus
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">Value</span>
              <input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="ghp_..."
                className="h-8 w-full rounded-lg border border-input bg-background px-3 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
              />
            </label>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={createSecret.status === "pending"}
            >
              {createSecret.status === "pending" && <IconSpinner className="size-3" />}
              Store & use
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
