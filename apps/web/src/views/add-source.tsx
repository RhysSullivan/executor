import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type CompleteSourceOAuthResult,
  type ConnectSourceBatchPayload,
  type ConnectSourcePayload,
  type ConnectSourceResult,
  type CreateWorkspaceOauthClientPayload,
  type DiscoverSourcePayload,
  type InstanceConfig,
  type Loadable,
  type SecretListItem,
  type Source,
  type SourceDiscoveryResult,
  type WorkspaceOauthClient,
  useConnectSourceBatch,
  useConnectSource,
  useCreateWorkspaceOauthClient,
  useCreateSecret,
  useDiscoverSource,
  useInvalidateExecutorQueries,
  useInstanceConfig,
  useRefreshSecrets,
  useSecrets,
  useWorkspaceOauthClients,
} from "@executor/react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { LocalMcpInstallCard } from "../components/local-mcp-install-card";
import { SourceFavicon } from "../components/source-favicon";
import {
  IconArrowLeft,
  IconCheck,
  IconDiscover,
  IconPlus,
  IconSpinner,
} from "../components/icons";
import { cn } from "../lib/utils";
import {
  isStdioMcpSourceTemplate,
  sourceTemplates,
  type SourceTemplate,
} from "./source-templates";
import {
  asMcpRemoteTransportValue,
  defaultMcpRemoteTransportFields,
  defaultMcpStdioTransportFields,
  setMcpTransportFieldsTransport,
  type McpRemoteTransportFields,
  type McpStdioTransportFields,
  type McpTransportFields,
  type McpTransportValue,
} from "./mcp-transport-state";
import { parseJsonStringArray, parseJsonStringMap } from "./json-form";
import { getDomain } from "tldts";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type FlowPhase =
  | "idle"
  | "discovering"
  | "editing"
  | "connecting"
  | "connected"
  | "credential_required"
  | "oauth_required";

type ProbeAuthKind = "none" | "bearer" | "basic" | "headers";

type ProbeAuthState = {
  kind: ProbeAuthKind;
  token: string;
  headerName: string;
  prefix: string;
  username: string;
  password: string;
  headersText: string;
};

type ConnectFormBase = {
  kind: "mcp" | "openapi" | "graphql" | "google_discovery";
  endpoint: string;
  specUrl: string;
  service: string;
  version: string;
  discoveryUrl: string;
  name: string;
  namespace: string;
  authKind: "none" | "bearer" | "oauth2";
  authHeaderName: string;
  authPrefix: string;
  oauthAuthorizationEndpoint: string;
  oauthTokenEndpoint: string;
  oauthScopesText: string;
  bearerToken: string;
  bearerProviderId: string;
  bearerHandle: string;
  workspaceOauthClientId: string;
  oauthClientId: string;
  oauthClientSecret: string;
};

type ConnectFormState = ConnectFormBase & McpTransportFields;

type OAuthRequiredInfo = {
  source: Source;
  sessionId: string;
  authorizationUrl: string;
};

type BatchOAuthRequiredInfo = {
  sessionId: string;
  authorizationUrl: string;
  sourceIds: ReadonlyArray<string>;
};

type GoogleDiscoveryConnectPayload = Extract<
  ConnectSourcePayload,
  { kind: "google_discovery" }
>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const kindOptions: ReadonlyArray<ConnectFormState["kind"]> = [
  "mcp",
  "openapi",
  "graphql",
  "google_discovery",
];

const transportOptions: ReadonlyArray<Exclude<McpTransportValue, "">> = [
  "auto",
  "streamable-http",
  "sse",
  "stdio",
];

const authOptions: ReadonlyArray<ConnectFormState["authKind"]> = [
  "none",
  "bearer",
  "oauth2",
];

const probeAuthOptions: ReadonlyArray<ProbeAuthKind> = [
  "none",
  "bearer",
  "basic",
  "headers",
];

const SOURCE_OAUTH_POPUP_RESULT_TIMEOUT_MS = 2 * 60_000;
const SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX = "executor:oauth-result:";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const trimToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const namespaceFromUrl = (url: string): string => {
  try {
    const domain = getDomain(url);
    if (!domain) return "";
    // Strip the TLD: "github.com" -> "github", "linear.app" -> "linear"
    const dot = domain.indexOf(".");
    return dot > 0 ? domain.slice(0, dot) : domain;
  } catch {
    return "";
  }
};

const googleDiscoveryNamespace = (service: string): string =>
  `google.${service
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")}`;

const googleDiscoveryDefaultsFromUrl = (
  value: string,
): {
  service: string;
  version: string;
  discoveryUrl: string;
} | null => {
  try {
    const url = new URL(value);
    const byDirectory = url.pathname.match(
      /^\/discovery\/v1\/apis\/([^/]+)\/([^/]+)\/rest$/,
    );
    if (byDirectory) {
      return {
        service: decodeURIComponent(byDirectory[1] ?? ""),
        version: decodeURIComponent(byDirectory[2] ?? ""),
        discoveryUrl: url.toString(),
      };
    }

    const versionParam = url.searchParams.get("version");
    const version = versionParam ? trimToNull(versionParam) : null;
    const isHostScopedDiscovery =
      url.pathname === "/$discovery/rest" &&
      url.hostname.endsWith(".googleapis.com") &&
      url.hostname !== "www.googleapis.com";
    if (version && isHostScopedDiscovery) {
      return {
        service: url.hostname.split(".")[0] ?? "",
        version,
        discoveryUrl: url.toString(),
      };
    }

    return null;
  } catch {
    return null;
  }
};

const stringifyStringMap = (
  value: Readonly<Record<string, string>> | null | undefined,
): string =>
  !value || Object.keys(value).length === 0
    ? ""
    : JSON.stringify(value, null, 2);

const stringifyStringArray = (
  value: ReadonlyArray<string> | null | undefined,
): string =>
  !value || value.length === 0 ? "" : JSON.stringify(value, null, 2);

const buildSyntheticMcpStdioEndpoint = (input: {
  name?: string | null;
  endpoint?: string | null;
  command?: string | null;
}): string => {
  const label =
    input.name?.trim() ||
    input.endpoint?.trim() ||
    input.command?.trim() ||
    "mcp";
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `stdio://local/${slug || "mcp"}`;
};

// ---------------------------------------------------------------------------
// Derived defaults from discovery result
// ---------------------------------------------------------------------------

const defaultConnectForm = (
  discovery?: SourceDiscoveryResult,
): ConnectFormState => {
  if (!discovery || discovery.detectedKind === "unknown") {
    return {
      kind: "openapi",
      endpoint: discovery?.endpoint ?? "",
      specUrl: discovery?.specUrl ?? "",
      service: "",
      version: "",
      discoveryUrl: "",
      name: discovery?.name ?? "",
      namespace:
        discovery?.namespace || namespaceFromUrl(discovery?.endpoint ?? ""),
      authKind: "none",
      authHeaderName: "Authorization",
      authPrefix: "Bearer ",
      oauthAuthorizationEndpoint: "",
      oauthTokenEndpoint: "",
      oauthScopesText: "",
      bearerToken: "",
      bearerProviderId: "",
      bearerHandle: "",
      workspaceOauthClientId: "",
      oauthClientId: "",
      oauthClientSecret: "",
      ...defaultMcpRemoteTransportFields(),
    };
  }

  const kind = discovery.detectedKind as ConnectFormState["kind"];
  const auth = discovery.authInference;

  // Map auth suggestion to what backend connect supports
  let authKind: ConnectFormState["authKind"] = "none";
  let authHeaderName = "Authorization";
  let authPrefix = "Bearer ";

  if (auth.supported) {
    if (auth.suggestedKind === "bearer" || auth.suggestedKind === "apiKey") {
      authKind = "bearer";
      authHeaderName = auth.headerName ?? "Authorization";
      authPrefix = auth.prefix ?? "Bearer ";
    } else if (auth.suggestedKind === "oauth2") {
      authKind = "oauth2";
      authHeaderName = auth.headerName ?? "Authorization";
      authPrefix = auth.prefix ?? "Bearer ";
    } else if (auth.suggestedKind === "basic") {
      // Backend connect doesn't support basic auth natively; map to bearer
      authKind = "bearer";
      authHeaderName = "Authorization";
      authPrefix = "Basic ";
    }
  }

  const googleDiscoveryDefaults =
    kind === "google_discovery"
      ? googleDiscoveryDefaultsFromUrl(discovery.specUrl ?? discovery.endpoint)
      : null;

  return {
    kind,
    endpoint: discovery.endpoint,
    specUrl: discovery.specUrl ?? "",
    service: googleDiscoveryDefaults?.service ?? "",
    version: googleDiscoveryDefaults?.version ?? "",
    discoveryUrl: googleDiscoveryDefaults?.discoveryUrl ?? "",
    name: discovery.name ?? "",
    namespace: discovery.namespace || namespaceFromUrl(discovery.endpoint),
    authKind,
    authHeaderName,
    authPrefix,
    oauthAuthorizationEndpoint: auth.oauthAuthorizationUrl ?? "",
    oauthTokenEndpoint: auth.oauthTokenUrl ?? "",
    oauthScopesText: auth.oauthScopes.join(" "),
    bearerToken: "",
    bearerProviderId: "",
    bearerHandle: "",
    workspaceOauthClientId: "",
    oauthClientId: "",
    oauthClientSecret: "",
    ...defaultMcpRemoteTransportFields(
      kind === "mcp" ? asMcpRemoteTransportValue(discovery.transport) : "",
    ),
  };
};

const connectFormFromTemplate = (
  template: SourceTemplate,
): ConnectFormState => ({
  ...defaultConnectForm(),
  kind: template.kind as ConnectFormState["kind"],
  endpoint: template.endpoint ?? "",
  specUrl: "specUrl" in template ? template.specUrl : "",
  service: "service" in template ? template.service : "",
  version: "version" in template ? template.version : "",
  discoveryUrl: "discoveryUrl" in template ? template.discoveryUrl : "",
  name: template.name,
  namespace:
    template.namespace ??
    ("service" in template
      ? googleDiscoveryNamespace(template.service)
      : namespaceFromUrl(template.endpoint ?? "")),
  authKind: template.kind === "google_discovery" ? "oauth2" : "none",
  oauthAuthorizationEndpoint: "",
  oauthTokenEndpoint: "",
  oauthScopesText: "",
  workspaceOauthClientId: "",
  ...(template.kind === "mcp" && template.connectionType === "command"
    ? defaultMcpStdioTransportFields({
        command: template.command ?? "",
        argsText: stringifyStringArray(template.args),
        envText: stringifyStringMap(template.env),
        cwd: template.cwd ?? "",
      })
    : defaultMcpRemoteTransportFields(
        template.kind === "mcp"
          ? asMcpRemoteTransportValue(template.transport)
          : "",
      )),
});

const authKindForSourceKind = (
  currentAuthKind: ConnectFormState["authKind"],
  nextKind: ConnectFormState["kind"],
): ConnectFormState["authKind"] =>
  nextKind === "google_discovery" && currentAuthKind === "none"
    ? "oauth2"
    : currentAuthKind;

const buildProbeAuth = (
  state: ProbeAuthState,
): DiscoverSourcePayload["probeAuth"] => {
  if (state.kind === "none") return { kind: "none" };
  if (state.kind === "bearer") {
    if (!state.token.trim())
      throw new Error("Token is required for bearer probe auth.");
    return {
      kind: "bearer",
      headerName: trimToNull(state.headerName),
      prefix: trimToNull(state.prefix),
      token: state.token.trim(),
    };
  }
  if (state.kind === "basic") {
    if (!state.username.trim())
      throw new Error("Username is required for basic probe auth.");
    return {
      kind: "basic",
      username: state.username.trim(),
      password: state.password,
    };
  }
  // headers
  const headers = parseJsonStringMap("Probe headers", state.headersText);
  if (!headers)
    throw new Error("At least one header is required for headers probe auth.");
  return { kind: "headers", headers };
};

const buildConnectPayload = (form: ConnectFormState): ConnectSourcePayload => {
  if (form.kind === "mcp") {
    if (form.transport === "stdio") {
      const endpoint = buildSyntheticMcpStdioEndpoint({
        name: form.name,
        endpoint: form.endpoint,
        command: form.command,
      });
      if (!form.command.trim()) {
        throw new Error("Command is required for stdio MCP sources.");
      }
      return {
        kind: "mcp",
        endpoint,
        name: trimToNull(form.name),
        namespace: trimToNull(form.namespace),
        transport: "stdio",
        queryParams: null,
        headers: null,
        command: form.command.trim(),
        args: parseJsonStringArray("Args", form.argsText),
        env: parseJsonStringMap("Environment", form.envText),
        cwd: trimToNull(form.cwd),
      };
    }

    const endpoint = form.endpoint.trim();
    if (!endpoint) throw new Error("Endpoint is required.");
    return {
      kind: "mcp",
      endpoint,
      name: trimToNull(form.name),
      namespace: trimToNull(form.namespace),
      transport: form.transport === "" ? "auto" : form.transport,
      queryParams: parseJsonStringMap("Query params", form.queryParamsText),
      headers: parseJsonStringMap("Request headers", form.headersText),
      command: null,
      args: null,
      env: null,
      cwd: null,
    };
  }

  // Build HTTP auth for openapi/graphql
  const auth = buildHttpAuth(form);

  if (form.kind === "openapi") {
    const endpoint = form.endpoint.trim();
    if (!endpoint) throw new Error("Endpoint is required.");
    const specUrl = form.specUrl.trim();
    if (!specUrl) throw new Error("OpenAPI sources require a spec URL.");
    return {
      kind: "openapi",
      endpoint,
      specUrl,
      oauthClient:
        form.authKind === "oauth2"
          ? buildOauthClientInput(form)
          : null,
      oauth2Setup:
        form.authKind === "oauth2"
          ? buildHttpOauth2Setup(form)
          : null,
      name: trimToNull(form.name),
      namespace: trimToNull(form.namespace),
      auth,
    };
  }

  if (form.kind === "google_discovery") {
    const service = form.service.trim();
    const version = form.version.trim();
    if (!service)
      throw new Error("Google Discovery sources require a service name.");
    if (!version)
      throw new Error("Google Discovery sources require a version.");
    if (
      form.authKind === "oauth2" &&
      form.workspaceOauthClientId.trim().length === 0 &&
      form.oauthClientId.trim().length === 0
    ) {
      throw new Error(
        "Google OAuth requires a workspace OAuth client or a new client ID.",
      );
    }
    return {
      kind: "google_discovery",
      service,
      version,
      discoveryUrl: trimToNull(form.discoveryUrl),
      name: trimToNull(form.name),
      namespace: trimToNull(form.namespace),
      scopeOauthClientId:
        form.authKind === "oauth2" &&
        form.workspaceOauthClientId.trim().length > 0
          ? (form.workspaceOauthClientId.trim() as NonNullable<
              GoogleDiscoveryConnectPayload["scopeOauthClientId"]
            >)
          : undefined,
      oauthClient:
        form.authKind === "oauth2" &&
        form.workspaceOauthClientId.trim().length === 0
          ? {
              clientId: form.oauthClientId.trim(),
              clientSecret: trimToNull(form.oauthClientSecret),
            }
          : null,
      auth,
    };
  }

  const endpoint = form.endpoint.trim();
  if (!endpoint) throw new Error("Endpoint is required.");
  return {
    kind: "graphql",
    endpoint,
    oauthClient:
      form.authKind === "oauth2"
        ? buildOauthClientInput(form)
        : null,
    oauth2Setup:
      form.authKind === "oauth2"
        ? buildHttpOauth2Setup(form)
        : null,
    name: trimToNull(form.name),
    namespace: trimToNull(form.namespace),
    auth,
  };
};

const parseScopesText = (value: string): Array<string> =>
  [...new Set(
    value
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  )];

const buildOauthClientInput = (form: ConnectFormState) => {
  const clientId = form.oauthClientId.trim();
  if (!clientId) {
    throw new Error("OAuth requires a client ID.");
  }

  return {
    clientId,
    clientSecret: trimToNull(form.oauthClientSecret),
    redirectMode: "app_callback" as const,
  };
};

const buildHttpOauth2Setup = (form: ConnectFormState) => {
  const authorizationEndpoint = form.oauthAuthorizationEndpoint.trim();
  const tokenEndpoint = form.oauthTokenEndpoint.trim();
  if (!authorizationEndpoint) {
    throw new Error("OAuth requires an authorization endpoint.");
  }
  if (!tokenEndpoint) {
    throw new Error("OAuth requires a token endpoint.");
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    scopes: parseScopesText(form.oauthScopesText),
    headerName: trimToNull(form.authHeaderName),
    prefix: form.authPrefix.length === 0 ? null : form.authPrefix,
    clientAuthentication: trimToNull(form.oauthClientSecret)
      ? "client_secret_post" as const
      : "none" as const,
  };
};

const buildHttpAuth = (
  form: ConnectFormState,
):
  | { kind: "none" }
  | {
      kind: "bearer";
      headerName?: string | null;
      prefix?: string | null;
      token?: string | null;
      tokenRef?: { providerId: string; handle: string } | null;
    }
  | undefined => {
  if (form.authKind === "none") return { kind: "none" };

  if (form.authKind === "bearer") {
    const headerName = trimToNull(form.authHeaderName);
    const prefix = form.authPrefix.length === 0 ? null : form.authPrefix;

    // Prefer secret ref if set
    if (form.bearerProviderId.trim() && form.bearerHandle.trim()) {
      return {
        kind: "bearer",
        headerName,
        prefix,
        tokenRef: {
          providerId: form.bearerProviderId.trim(),
          handle: form.bearerHandle.trim(),
        },
      };
    }

    // Fall back to inline token
    if (form.bearerToken.trim()) {
      return {
        kind: "bearer",
        headerName,
        prefix,
        token: form.bearerToken.trim(),
      };
    }

    throw new Error(
      "Bearer auth requires a token. Select or create a secret, or enter a token directly.",
    );
  }

  // oauth2 is handled via the connect result flow, not pre-filled
  return undefined;
};

// ---------------------------------------------------------------------------
// OAuth popup helpers (shared with source-editor.tsx)
// ---------------------------------------------------------------------------

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
    }
  | {
      type: "executor:source-oauth-result";
      ok: true;
      sourceId: string;
    }
  | {
      type: "executor:source-oauth-result";
      ok: false;
      error: string;
    };

const readStoredSourceOAuthPopupResult = (
  sessionId: string,
): SourceOAuthPopupMessage | null => {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(
    `${SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX}${sessionId}`,
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SourceOAuthPopupMessage;
  } catch {
    return null;
  }
};

const clearStoredSourceOAuthPopupResult = (sessionId: string): void => {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(
    `${SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX}${sessionId}`,
  );
};

const startSourceOAuthPopup = async (input: {
  authorizationUrl: string;
  sessionId: string;
}): Promise<void> => {
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

  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    let closedPoll = 0;
    let resultTimeout = 0;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      if (closedPoll) window.clearInterval(closedPoll);
      if (resultTimeout) window.clearTimeout(resultTimeout);
      if (!popup.closed) popup.close();
      clearStoredSourceOAuthPopupResult(input.sessionId);
    };

    const settleWithError = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const settleFromPayload = (data: SourceOAuthPopupMessage) => {
      if (!data.ok) {
        settleWithError(data.error || "OAuth failed");
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as SourceOAuthPopupMessage | undefined;
      if (!data) return;
      if (data.type === "executor:oauth-result") {
        if (data.ok && data.sessionId !== input.sessionId) return;
        if (
          !data.ok &&
          data.sessionId !== null &&
          data.sessionId !== input.sessionId
        )
          return;
      } else if (data.type !== "executor:source-oauth-result") {
        return;
      }
      settleFromPayload(data);
    };

    window.addEventListener("message", onMessage);

    resultTimeout = window.setTimeout(() => {
      settleWithError(
        "OAuth popup timed out before completion. Please try again.",
      );
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
          const delayedStored = readStoredSourceOAuthPopupResult(
            input.sessionId,
          );
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

// ---------------------------------------------------------------------------
// Confidence badge helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AddSourcePage() {
  const navigate = useNavigate();
  const discoverSource = useDiscoverSource();
  const connectSource = useConnectSource();
  const connectSourceBatch = useConnectSourceBatch();
  const createWorkspaceOauthClient = useCreateWorkspaceOauthClient();
  const workspaceOauthClients = useWorkspaceOauthClients("google_workspace");
  const instanceConfig = useInstanceConfig();
  const invalidateExecutorQueries = useInvalidateExecutorQueries();
  const secrets = useSecrets();
  const refreshSecrets = useRefreshSecrets();

  // URL input
  const [url, setUrl] = useState("");

  // Probe auth
  const [showProbeAuth, setShowProbeAuth] = useState(false);
  const [probeAuth, setProbeAuth] = useState<ProbeAuthState>({
    kind: "none",
    token: "",
    headerName: "Authorization",
    prefix: "Bearer ",
    username: "",
    password: "",
    headersText: "",
  });

  // Phase
  const [phase, setPhase] = useState<FlowPhase>("idle");

  // Discovery result
  // Editable connect form (populated after discovery)
  const [connectForm, setConnectForm] =
    useState<ConnectFormState>(defaultConnectForm());

  // Connect result
  const [connectResult, setConnectResult] =
    useState<ConnectSourceResult | null>(null);

  // OAuth required state
  const [oauthInfo, setOauthInfo] = useState<OAuthRequiredInfo | null>(null);
  const [batchOauthInfo, setBatchOauthInfo] =
    useState<BatchOAuthRequiredInfo | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [batchConnecting, setBatchConnecting] = useState(false);
  const [selectedGoogleTemplateIds, setSelectedGoogleTemplateIds] = useState<
    ReadonlyArray<string>
  >([]);

  // Status banner
  const [statusBanner, setStatusBanner] = useState<{
    tone: "info" | "success" | "error";
    text: string;
  } | null>(null);

  const setFormField = <K extends keyof ConnectFormBase>(
    key: K,
    value: ConnectFormBase[K],
  ) => {
    setConnectForm((current) => ({ ...current, [key]: value }));
  };

  const setTransport = (transport: McpTransportValue) => {
    setConnectForm((current) => ({
      ...current,
      ...setMcpTransportFieldsTransport(current, transport),
    }));
  };

  const setRemoteTransportField = <
    K extends Exclude<keyof McpRemoteTransportFields, "transport">,
  >(
    key: K,
    value: McpRemoteTransportFields[K],
  ) => {
    setConnectForm((current) =>
      current.transport === "stdio" ? current : { ...current, [key]: value },
    );
  };

  const setStdioTransportField = <
    K extends Exclude<keyof McpStdioTransportFields, "transport">,
  >(
    key: K,
    value: McpStdioTransportFields[K],
  ) => {
    setConnectForm((current) =>
      current.transport === "stdio" ? { ...current, [key]: value } : current,
    );
  };

  const setSourceKind = (kind: ConnectFormState["kind"]) => {
    setConnectForm((current) => ({
      ...current,
      kind,
      authKind: authKindForSourceKind(current.authKind, kind),
      workspaceOauthClientId:
        kind === "google_discovery" ? current.workspaceOauthClientId : "",
    }));
  };

  const setProbeField = <K extends keyof ProbeAuthState>(
    key: K,
    value: ProbeAuthState[K],
  ) => {
    setProbeAuth((current) => ({ ...current, [key]: value }));
  };

  const googleTemplates = sourceTemplates.filter(
    (template) => template.groupId === "google_workspace" && template.batchable,
  );

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleDiscover = async () => {
    setStatusBanner(null);
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setStatusBanner({
        tone: "error",
        text: "Please enter a URL to discover.",
      });
      return;
    }

    setPhase("discovering");

    try {
      const payload: DiscoverSourcePayload = {
        url: trimmedUrl,
        ...(showProbeAuth && probeAuth.kind !== "none"
          ? { probeAuth: buildProbeAuth(probeAuth) }
          : {}),
      };
      const result = await discoverSource.mutateAsync(payload);
      setConnectForm(defaultConnectForm(result));
      setPhase("editing");

      if (result.detectedKind === "unknown") {
        setStatusBanner({
          tone: "info",
          text: "Could not auto-detect the source type. Please configure manually.",
        });
      } else if (result.warnings.length > 0) {
        setStatusBanner({
          tone: "info",
          text: result.warnings.join(" "),
        });
      }
    } catch (error) {
      setPhase("idle");
      setStatusBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Discovery failed.",
      });
    }
  };

  const handleSkipDiscovery = () => {
    setConnectForm(defaultConnectForm());
    setPhase("editing");
    setStatusBanner(null);
  };

  const applyTemplate = async (template: SourceTemplate) => {
    if (template.batchable) {
      setSelectedGoogleTemplateIds((current) =>
        current.includes(template.id)
          ? current.filter((id) => id !== template.id)
          : [...current, template.id],
      );
      setStatusBanner(null);
      return;
    }

    if (isStdioMcpSourceTemplate(template)) {
      setUrl("");
      setConnectForm(connectFormFromTemplate(template));
      setPhase("editing");
      setStatusBanner({
        tone: "info",
        text: `${template.name} loaded. Review the local command, then connect.`,
      });
      return;
    }

    const discoveryUrl =
      "specUrl" in template ? template.specUrl : (template.endpoint ?? "");
    setUrl(template.endpoint ?? "");
    setStatusBanner(null);
    setPhase("discovering");

    try {
      const result = await discoverSource.mutateAsync({ url: discoveryUrl });
      let form: ConnectFormState = {
        ...defaultConnectForm(result),
        name: template.name,
        endpoint: template.endpoint ?? "",
        namespace: template.namespace ?? namespaceFromUrl(template.endpoint ?? ""),
      };
      if (template.kind === "mcp") {
        form = {
          ...form,
          ...(template.connectionType === "command"
            ? defaultMcpStdioTransportFields({
                command: template.command ?? "",
                argsText: stringifyStringArray(template.args),
                envText: stringifyStringMap(template.env),
                cwd: template.cwd ?? "",
              })
            : defaultMcpRemoteTransportFields(
                asMcpRemoteTransportValue(template.transport),
              )),
        };
      }
      if ("specUrl" in template) {
        form = {
          ...form,
          specUrl: template.specUrl,
        };
      }
      setConnectForm(form);
      setPhase("editing");

      if (result.warnings.length > 0) {
        setStatusBanner({
          tone: "info",
          text: result.warnings.join(" "),
        });
      }
    } catch (error) {
      // Discovery failed — fall back to just the template basics
      setConnectForm(connectFormFromTemplate(template));
      setPhase("editing");
      setStatusBanner({
        tone: "error",
        text: `Discovery failed for ${template.name}: ${error instanceof Error ? error.message : "unknown error"}. Configure manually.`,
      });
    }
  };

  const handleConnect = async () => {
    setStatusBanner(null);

    try {
      const payload = buildConnectPayload(connectForm);
      setPhase("connecting");

      const result = await connectSource.mutateAsync(payload);
      setConnectResult(result);

      if (result.kind === "connected") {
        setBatchOauthInfo(null);
        setPhase("connected");
        setStatusBanner({
          tone: "success",
          text: `"${result.source.name}" connected successfully.`,
        });
        // Navigate to source detail after short delay
        setTimeout(() => {
          void navigate({
            to: "/sources/$sourceId",
            params: { sourceId: result.source.id },
            search: { tab: "model" },
          });
        }, 1200);
      } else if (result.kind === "credential_required") {
        setBatchOauthInfo(null);
        setPhase("credential_required");
        setStatusBanner({
          tone: "info",
          text: "This source requires credentials. Configure auth below, then connect again.",
        });
        // Pre-select bearer auth if not already set
        if (connectForm.authKind === "none") {
          setFormField("authKind", "bearer");
        }
      } else if (result.kind === "oauth_required") {
        setBatchOauthInfo(null);
        setPhase("oauth_required");
        setOauthInfo({
          source: result.source,
          sessionId: result.sessionId,
          authorizationUrl: result.authorizationUrl,
        });
        setStatusBanner({
          tone: "info",
          text: "This source requires OAuth authentication. Click the button below to sign in.",
        });
      }
    } catch (error) {
      setPhase("editing");
      setStatusBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Connection failed.",
      });
    }
  };

  const handleOAuthPopup = async () => {
    if (!oauthInfo && !batchOauthInfo) return;
    setStatusBanner(null);
    setOauthBusy(true);

    try {
      await startSourceOAuthPopup({
        authorizationUrl:
          oauthInfo?.authorizationUrl ?? batchOauthInfo!.authorizationUrl,
        sessionId: oauthInfo?.sessionId ?? batchOauthInfo!.sessionId,
      });

      refreshSecrets();
      invalidateExecutorQueries();
      setPhase("connected");
      setStatusBanner({
        tone: "success",
        text: oauthInfo
          ? `"${oauthInfo.source.name}" connected via OAuth.`
          : `Connected ${batchOauthInfo?.sourceIds.length ?? 0} Google source${(batchOauthInfo?.sourceIds.length ?? 0) === 1 ? "" : "s"} via OAuth.`,
      });

      setTimeout(() => {
        if (oauthInfo) {
          void navigate({
            to: "/sources/$sourceId",
            params: { sourceId: oauthInfo.source.id },
            search: { tab: "model" },
          });
          return;
        }

        void navigate({
          to: "/",
        });
      }, 1200);
    } catch (error) {
      setStatusBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "OAuth flow failed.",
      });
    } finally {
      setOauthBusy(false);
    }
  };

  const ensureGoogleWorkspaceOauthClientId = async (): Promise<string> => {
    const selectedClientId = connectForm.workspaceOauthClientId.trim();
    if (selectedClientId.length > 0) {
      return selectedClientId;
    }

    const clientId = connectForm.oauthClientId.trim();
    if (clientId.length === 0) {
      throw new Error(
        "Choose an existing Google workspace OAuth client or enter a new client ID.",
      );
    }

    const created = await createWorkspaceOauthClient.mutateAsync({
      providerKey: "google_workspace",
      label: "Google Workspace",
      oauthClient: {
        clientId,
        clientSecret: trimToNull(connectForm.oauthClientSecret),
      },
    } satisfies CreateWorkspaceOauthClientPayload);

    setFormField("workspaceOauthClientId", created.id);
    return created.id;
  };

  const handleConnectGoogleBatch = async () => {
    if (selectedGoogleTemplateIds.length === 0) {
      return;
    }

    setStatusBanner(null);

    try {
      const workspaceOauthClientId = await ensureGoogleWorkspaceOauthClientId();
      const selectedTemplates = googleTemplates.filter(
        (
          template,
        ): template is Extract<SourceTemplate, { kind: "google_discovery" }> =>
          selectedGoogleTemplateIds.includes(template.id),
      );
      const payload: ConnectSourceBatchPayload = {
        scopeOauthClientId:
          workspaceOauthClientId as WorkspaceOauthClient["id"],
        sources: selectedTemplates.map((template) => ({
          service: template.service,
          version: template.version,
          discoveryUrl: template.discoveryUrl,
          name: template.name,
          namespace: googleDiscoveryNamespace(template.service),
        })),
      };

      setBatchConnecting(true);
      setPhase("connecting");
      const result = await connectSourceBatch.mutateAsync(payload);
      if (result.providerOauthSession) {
        setBatchOauthInfo({
          sessionId: result.providerOauthSession.sessionId,
          authorizationUrl: result.providerOauthSession.authorizationUrl,
          sourceIds: result.providerOauthSession.sourceIds,
        });
        setOauthInfo(null);
        setBatchConnecting(false);
        setPhase("oauth_required");
        setStatusBanner(null);
        return;
      }

      setSelectedGoogleTemplateIds([]);
      setBatchOauthInfo(null);
      setBatchConnecting(false);
      setPhase("connected");
      setStatusBanner({
        tone: "success",
        text: `Connected ${result.results.length} Google source${result.results.length === 1 ? "" : "s"}.`,
      });
      setTimeout(() => {
        void navigate({ to: "/" });
      }, 1200);
    } catch (error) {
      setBatchConnecting(false);
      setPhase("idle");
      setStatusBanner({
        tone: "error",
        text:
          error instanceof Error ? error.message : "Batch connection failed.",
      });
    }
  };

  const handleCredentialConnect = async () => {
    // Re-run connect with the auth now configured
    await handleConnect();
  };

  const handleBackToEditing = () => {
    setPhase("editing");
    setStatusBanner(null);
    setConnectResult(null);
    setOauthInfo(null);
  };

  const isDiscovering = phase === "discovering";
  const isConnecting = phase === "connecting";
  const isBusy =
    isDiscovering ||
    isConnecting ||
    oauthBusy ||
    connectSourceBatch.status === "pending" ||
    createWorkspaceOauthClient.status === "pending";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8 lg:px-10 lg:py-12">
        {/* Back */}
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground mb-6"
        >
          <IconArrowLeft className="size-3.5" />
          Back
        </Link>

        <div className="flex items-center justify-between gap-4 mb-6">
          <h1 className="font-display text-2xl tracking-tight text-foreground lg:text-3xl">
            Add source
          </h1>
          {phase === "editing" && (
            <Badge variant="outline">{connectForm.kind}</Badge>
          )}
        </div>

        {/* Step indicator */}
        {phase !== "idle" && phase !== "discovering" && (
          <div className="mb-6 flex items-center gap-1.5" aria-label="Progress">
            {(["discover", "configure", "connect"] as const).map((step, i) => {
              const stepPhases: Record<string, number> = {
                editing: 1,
                connecting: 2,
                credential_required: 1,
                oauth_required: 2,
                connected: 2,
              };
              const currentStep = stepPhases[phase] ?? 0;
              const isComplete = i < currentStep;
              const isCurrent = i === currentStep;
              return (
                <div key={step} className="flex items-center gap-1.5">
                  {i > 0 && (
                    <div
                      className={cn(
                        "h-px w-6 transition-colors",
                        isComplete || isCurrent ? "bg-primary/40" : "bg-border",
                      )}
                    />
                  )}
                  <div
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.06em] transition-colors",
                      isComplete
                        ? "text-primary"
                        : isCurrent
                          ? "text-foreground bg-muted/50"
                          : "text-muted-foreground/40",
                    )}
                  >
                    {isComplete ? (
                      <IconCheck className="size-2.5" />
                    ) : (
                      <span className="flex size-3.5 items-center justify-center rounded-full border text-[9px] tabular-nums border-current">
                        {i + 1}
                      </span>
                    )}
                    {step}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {statusBanner && <StatusBanner state={statusBanner} className="mb-6" />}

        {(phase === "idle" || phase === "discovering") && (
          <LocalMcpInstallCard
            className="mb-6 rounded-xl border border-border bg-card/80 p-5"
            title="Install this executor as MCP"
            description="Prefer a one-command setup? Install this local executor server into your MCP client, or add an external MCP source below."
          />
        )}
        {/* Step 1: Discovery */}
        {(phase === "idle" || phase === "discovering") && (
          <div className="space-y-6">
            <Section title="Discover">
              <div className="space-y-4">
                <p className="text-[13px] text-muted-foreground">
                  Enter a URL and we'll auto-detect the source type, endpoint,
                  auth requirements, and more.
                </p>

                <Field label="URL">
                  <div className="space-y-0">
                    <div className="flex gap-2">
                      <input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://api.example.com or https://mcp.example.com/mcp"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !isDiscovering) {
                            void handleDiscover();
                          }
                        }}
                        className="h-9 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
                      />
                      <Button onClick={handleDiscover} disabled={isBusy}>
                        {isDiscovering ? (
                          <IconSpinner className="size-3.5" />
                        ) : (
                          <IconDiscover className="size-3.5" />
                        )}
                        {isDiscovering ? "Discovering\u2026" : "Discover"}
                      </Button>
                    </div>
                    {isDiscovering && (
                      <div className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full w-1/4 rounded-full bg-primary/60"
                          style={{
                            animation:
                              "indeterminate-progress 1.2s ease-in-out infinite",
                          }}
                        />
                      </div>
                    )}
                  </div>
                </Field>

                {/* Probe auth toggle */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowProbeAuth(!showProbeAuth)}
                    className="text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showProbeAuth
                      ? "Hide probe auth"
                      : "Need auth to discover?"}
                  </button>
                </div>

                {showProbeAuth && (
                  <div className="rounded-lg border border-border bg-card/70 p-4 space-y-3">
                    <Field label="Auth type">
                      <SelectInput
                        value={probeAuth.kind}
                        onChange={(v) =>
                          setProbeField("kind", v as ProbeAuthKind)
                        }
                        options={probeAuthOptions.map((v) => ({
                          value: v,
                          label: v,
                        }))}
                      />
                    </Field>

                    {probeAuth.kind === "bearer" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Header name">
                          <TextInput
                            value={probeAuth.headerName}
                            onChange={(v) => setProbeField("headerName", v)}
                            placeholder="Authorization"
                          />
                        </Field>
                        <Field label="Prefix">
                          <TextInput
                            value={probeAuth.prefix}
                            onChange={(v) => setProbeField("prefix", v)}
                            placeholder="Bearer "
                          />
                        </Field>
                        <Field label="Token" className="sm:col-span-2">
                          <TextInput
                            value={probeAuth.token}
                            onChange={(v) => setProbeField("token", v)}
                            placeholder="sk-..."
                            mono
                          />
                        </Field>
                      </div>
                    )}

                    {probeAuth.kind === "basic" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Username">
                          <TextInput
                            value={probeAuth.username}
                            onChange={(v) => setProbeField("username", v)}
                            placeholder="user"
                          />
                        </Field>
                        <Field label="Password">
                          <TextInput
                            value={probeAuth.password}
                            onChange={(v) => setProbeField("password", v)}
                            placeholder="pass"
                          />
                        </Field>
                      </div>
                    )}

                    {probeAuth.kind === "headers" && (
                      <Field label="Headers (JSON)">
                        <CodeEditor
                          value={probeAuth.headersText}
                          onChange={(v) => setProbeField("headersText", v)}
                          placeholder={'{\n  "x-api-key": "..."\n}'}
                        />
                      </Field>
                    )}
                  </div>
                )}

                {/* Skip discovery link */}
                <div className="flex items-center justify-end border-t border-border pt-4">
                  <button
                    type="button"
                    onClick={handleSkipDiscovery}
                    disabled={isBusy}
                    className="text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Skip discovery and configure manually
                  </button>
                </div>

                {/* ---- Template catalogue ---- */}
                <div className="space-y-5 border-t border-border pt-5">
                  <div>
                    <p className="text-[13px] font-medium text-foreground">
                      Start from a template
                    </p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      Pick a known source to skip discovery, or select multiple
                      Google APIs for batch connect.
                    </p>
                  </div>

                  {/* -- Popular / non-Google templates -- */}
                  {(() => {
                    const popularTemplates = sourceTemplates.filter(
                      (t) => t.groupId !== "google_workspace",
                    );
                    return (
                      popularTemplates.length > 0 && (
                        <div className="space-y-2.5">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/50">
                            Popular
                          </p>
                          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {popularTemplates.map((template) => (
                              <button
                                key={template.id}
                                type="button"
                                onClick={() => applyTemplate(template)}
                                disabled={isBusy}
                                className="group rounded-xl border border-border bg-card/70 px-4 py-3 text-left transition-all hover:bg-accent/50 hover:border-primary/20 hover:shadow-sm disabled:opacity-60"
                              >
                                <div className="mb-1.5 flex items-center gap-2.5">
                                  <div className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/50">
                                    <SourceFavicon
                                      endpoint={template.endpoint}
                                      kind={template.kind}
                                      className="size-3.5"
                                    />
                                  </div>
                                  <span className="flex-1 truncate text-[13px] font-medium text-foreground group-hover:text-primary transition-colors">
                                    {template.name}
                                  </span>
                                  <Badge
                                    variant="outline"
                                    className="text-[9px] opacity-60 group-hover:opacity-100 transition-opacity"
                                  >
                                    {template.kind}
                                  </Badge>
                                </div>
                                <span className="line-clamp-1 text-[11px] text-muted-foreground/70">
                                  {template.summary}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    );
                  })()}

                  {/* -- Google Workspace batch section -- */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/50">
                        Google Workspace
                      </p>
                      {googleTemplates.length > 0 && (
                        <div className="flex items-center gap-2">
                          {selectedGoogleTemplateIds.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setSelectedGoogleTemplateIds([])}
                              disabled={isBusy}
                              className="text-[11px] font-medium text-muted-foreground/60 transition-colors hover:text-foreground"
                            >
                              Clear
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedGoogleTemplateIds(
                                selectedGoogleTemplateIds.length ===
                                  googleTemplates.length
                                  ? []
                                  : googleTemplates.map((t) => t.id),
                              )
                            }
                            disabled={isBusy}
                            className="text-[11px] font-medium text-muted-foreground/60 transition-colors hover:text-foreground"
                          >
                            {selectedGoogleTemplateIds.length ===
                            googleTemplates.length
                              ? "Deselect all"
                              : "Select all"}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {googleTemplates.map((template) => {
                        const selected = selectedGoogleTemplateIds.includes(
                          template.id,
                        );
                        return (
                          <button
                            key={template.id}
                            type="button"
                            onClick={() => applyTemplate(template)}
                            disabled={isBusy}
                            className={cn(
                              "group flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-all disabled:opacity-60",
                              selected
                                ? "border-primary/40 bg-primary/6 shadow-sm"
                                : "border-border bg-card/50 hover:bg-accent/40 hover:border-border",
                            )}
                          >
                            <div
                              className={cn(
                                "flex size-4 shrink-0 items-center justify-center rounded transition-colors",
                                selected
                                  ? "text-primary"
                                  : "text-muted-foreground/30 group-hover:text-muted-foreground/50",
                              )}
                            >
                              {selected ? (
                                <IconCheck className="size-3.5" />
                              ) : (
                                <SourceFavicon
                                  endpoint={template.endpoint}
                                  kind={template.kind}
                                  className="size-3.5"
                                />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <span
                                className={cn(
                                  "block truncate text-[12px] font-medium transition-colors",
                                  selected
                                    ? "text-foreground"
                                    : "text-foreground/80",
                                )}
                              >
                                {template.name}
                              </span>
                              <span className="block truncate text-[10px] text-muted-foreground/60">
                                {template.summary}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* -- Batch connect panel (slides in when templates selected) -- */}
                    {selectedGoogleTemplateIds.length > 0 && (
                      <div className="rounded-xl border border-primary/20 bg-gradient-to-b from-primary/4 to-transparent overflow-hidden">
                        {/* Header strip */}
                        <div className="flex items-center justify-between gap-3 border-b border-primary/10 px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                              <span className="text-[11px] font-bold tabular-nums">
                                {selectedGoogleTemplateIds.length}
                              </span>
                            </div>
                            <p className="text-[13px] font-medium text-foreground">
                              Connect Google API
                              {selectedGoogleTemplateIds.length === 1
                                ? ""
                                : "s"}
                            </p>
                          </div>
                          <p className="hidden text-[11px] text-muted-foreground/60 sm:block">
                            One consent screen for all
                          </p>
                        </div>

                        {/* Body */}
                        <div className="px-5 py-4 space-y-4">
                          <Field label="Workspace OAuth client">
                            <select
                              value={connectForm.workspaceOauthClientId}
                              onChange={(event) =>
                                setFormField(
                                  "workspaceOauthClientId",
                                  event.target.value,
                                )
                              }
                              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
                            >
                              <option value="">
                                Enter new client credentials
                              </option>
                              {workspaceOauthClients.status === "ready" &&
                                workspaceOauthClients.data.map((client) => (
                                  <option key={client.id} value={client.id}>
                                    {client.label ?? client.clientId}
                                  </option>
                                ))}
                            </select>
                          </Field>
                          {connectForm.workspaceOauthClientId.trim().length ===
                            0 && (
                            <div className="grid gap-3 sm:grid-cols-2">
                              <Field
                                label="Client ID"
                                className="sm:col-span-2"
                              >
                                <TextInput
                                  type="password"
                                  value={connectForm.oauthClientId}
                                  onChange={(v) =>
                                    setFormField("oauthClientId", v)
                                  }
                                  placeholder="1234567890-abcdef.apps.googleusercontent.com"
                                />
                              </Field>
                              <Field
                                label="Client secret"
                                className="sm:col-span-2"
                              >
                                <TextInput
                                  type="password"
                                  value={connectForm.oauthClientSecret}
                                  onChange={(v) =>
                                    setFormField("oauthClientSecret", v)
                                  }
                                  placeholder="GOCSPX-..."
                                />
                              </Field>
                            </div>
                          )}
                          <div className="flex items-center justify-end pt-1">
                            <Button
                              type="button"
                              onClick={handleConnectGoogleBatch}
                              disabled={isBusy}
                            >
                              {isBusy ? (
                                <IconSpinner className="size-3.5" />
                              ) : (
                                <IconPlus className="size-3.5" />
                              )}
                              Connect {selectedGoogleTemplateIds.length} source
                              {selectedGoogleTemplateIds.length === 1
                                ? ""
                                : "s"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Section>
          </div>
        )}

        {/* Batch connecting interstitial */}
        {batchConnecting && phase === "connecting" && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="space-y-5 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-primary/15 bg-primary/6">
                <IconSpinner className="size-6 text-primary" />
              </div>
              <div className="space-y-1.5">
                <h2 className="font-display text-xl tracking-tight text-foreground">
                  Connecting {selectedGoogleTemplateIds.length} source
                  {selectedGoogleTemplateIds.length === 1 ? "" : "s"}
                </h2>
                <p className="text-[13px] text-muted-foreground/70">
                  Setting up Google Workspace APIs\u2026
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Step 2-4: Editing / Connecting */}
        {(phase === "editing" ||
          (phase === "connecting" && !batchConnecting) ||
          phase === "credential_required") && (
          <div className="space-y-6">
            <Section title="Configuration">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name">
                  <TextInput
                    value={connectForm.name}
                    onChange={(v) => setFormField("name", v)}
                    placeholder="My API"
                  />
                </Field>
                <Field label="Kind">
                  <SelectInput
                    value={connectForm.kind}
                    onChange={(v) =>
                      setSourceKind(v as ConnectFormState["kind"])
                    }
                    options={kindOptions.map((v) => ({ value: v, label: v }))}
                  />
                </Field>
                {connectForm.kind !== "google_discovery" &&
                  !(
                    connectForm.kind === "mcp" &&
                    connectForm.transport === "stdio"
                  ) && (
                    <Field label="Endpoint" className="sm:col-span-2">
                      <TextInput
                        value={connectForm.endpoint}
                        onChange={(v) => setFormField("endpoint", v)}
                        placeholder="https://api.example.com"
                        mono
                      />
                    </Field>
                  )}
                <Field label="Namespace">
                  <TextInput
                    value={connectForm.namespace}
                    onChange={(v) => setFormField("namespace", v)}
                    placeholder="example"
                  />
                </Field>
                {connectForm.kind === "openapi" && (
                  <Field label="Spec URL" className="sm:col-span-2">
                    <TextInput
                      value={connectForm.specUrl}
                      onChange={(v) => setFormField("specUrl", v)}
                      placeholder="https://example.com/openapi.yaml"
                      mono
                    />
                  </Field>
                )}
                {connectForm.kind === "google_discovery" && (
                  <>
                    <Field label="Service">
                      <TextInput
                        value={connectForm.service}
                        onChange={(v) => setFormField("service", v)}
                        placeholder="sheets"
                      />
                    </Field>
                    <Field label="Version">
                      <TextInput
                        value={connectForm.version}
                        onChange={(v) => setFormField("version", v)}
                        placeholder="v4"
                      />
                    </Field>
                    <Field
                      label="Discovery URL (optional)"
                      className="sm:col-span-2"
                    >
                      <TextInput
                        value={connectForm.discoveryUrl}
                        onChange={(v) => setFormField("discoveryUrl", v)}
                        placeholder="https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest"
                        mono
                      />
                    </Field>
                    <div className="sm:col-span-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-[12px] text-muted-foreground">
                      Common Google API versions: Gmail `v1`, Sheets `v4`, Drive
                      `v3`, Calendar `v3`, Docs `v1`.
                    </div>
                  </>
                )}
              </div>
            </Section>

            {/* MCP Transport */}
            {connectForm.kind === "mcp" && (
              <Section title="Transport">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Transport mode">
                    <SelectInput
                      value={connectForm.transport || "auto"}
                      onChange={(v) => setTransport(v as McpTransportValue)}
                      options={transportOptions.map((v) => ({
                        value: v,
                        label: v,
                      }))}
                    />
                  </Field>
                  {connectForm.transport === "stdio" ? (
                    <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
                      <Field label="Command">
                        <TextInput
                          value={connectForm.command}
                          onChange={(v) => setStdioTransportField("command", v)}
                          placeholder="npx"
                          mono
                        />
                      </Field>
                      <Field label="Working directory (optional)">
                        <TextInput
                          value={connectForm.cwd}
                          onChange={(v) => setStdioTransportField("cwd", v)}
                          placeholder="/path/to/project"
                          mono
                        />
                      </Field>
                      <Field label="Args (JSON)" className="sm:col-span-2">
                        <CodeEditor
                          value={connectForm.argsText}
                          onChange={(v) =>
                            setStdioTransportField("argsText", v)
                          }
                          placeholder={
                            '[\n  "-y",\n  "chrome-devtools-mcp@latest"\n]'
                          }
                        />
                      </Field>
                      <Field
                        label="Environment (JSON)"
                        className="sm:col-span-2"
                      >
                        <CodeEditor
                          value={connectForm.envText}
                          onChange={(v) => setStdioTransportField("envText", v)}
                          placeholder={
                            '{\n  "CHROME_PATH": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n}'
                          }
                        />
                      </Field>
                    </div>
                  ) : (
                    <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
                      <Field label="Query params (JSON)">
                        <CodeEditor
                          value={connectForm.queryParamsText}
                          onChange={(v) =>
                            setRemoteTransportField("queryParamsText", v)
                          }
                          placeholder={'{\n  "workspace": "demo"\n}'}
                        />
                      </Field>
                      <Field label="Headers (JSON)">
                        <CodeEditor
                          value={connectForm.headersText}
                          onChange={(v) =>
                            setRemoteTransportField("headersText", v)
                          }
                          placeholder={'{\n  "x-api-key": "..."\n}'}
                        />
                      </Field>
                    </div>
                  )}
                </div>
              </Section>
            )}

            {/* Auth section (for non-MCP kinds, or when credential_required) */}
            {phase === "credential_required" && (
              <div className="flex items-start gap-3 rounded-xl border border-amber-300/40 bg-amber-50/50 px-4 py-3.5 dark:border-amber-500/20 dark:bg-amber-950/20">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-amber-100/80 dark:bg-amber-900/40">
                  <svg
                    className="size-3.5 text-amber-600 dark:text-amber-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                </div>
                <div className="space-y-0.5">
                  <p className="text-[12px] font-medium text-amber-900 dark:text-amber-200">
                    Credentials required
                  </p>
                  <p className="text-[11px] leading-relaxed text-amber-800/70 dark:text-amber-300/60">
                    The server responded that this source requires
                    authentication. Add a token or secret below, then try
                    connecting again.
                  </p>
                </div>
              </div>
            )}
            {connectForm.kind !== "mcp" && (
              <Section title="Authentication">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Auth mode">
                    <SelectInput
                      value={connectForm.authKind}
                      onChange={(v) =>
                        setFormField(
                          "authKind",
                          v as ConnectFormState["authKind"],
                        )
                      }
                      options={authOptions.map((v) => ({ value: v, label: v }))}
                    />
                  </Field>
                  {connectForm.kind === "google_discovery" && (
                    <div className="sm:col-span-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-[12px] text-muted-foreground">
                      {connectForm.authKind === "oauth2"
                        ? "OAuth starts after you click Connect. Choose an existing workspace OAuth client or enter a new client once, then reuse it across Google sources."
                        : "Choosing auth mode 'none' skips the Google OAuth popup. Use 'oauth2' if you want executor to start the sign-in flow for you."}
                    </div>
                  )}
                  {(connectForm.kind === "openapi" ||
                    connectForm.kind === "graphql") &&
                    connectForm.authKind === "oauth2" && (
                      <div className="sm:col-span-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-[12px] text-muted-foreground">
                        Executor will start OAuth after you click Connect. Enter
                        the client credentials and provider endpoints below, or
                        adjust the discovery defaults before connecting.
                      </div>
                    )}
                  {connectForm.kind === "google_discovery" &&
                    connectForm.authKind === "oauth2" && (
                      <>
                        <Field
                          label="Workspace OAuth client"
                          className="sm:col-span-2"
                        >
                          <SelectInput
                            value={connectForm.workspaceOauthClientId}
                            onChange={(value) =>
                              setFormField("workspaceOauthClientId", value)
                            }
                            options={[
                              { value: "", label: "Enter new client" },
                              ...(workspaceOauthClients.status === "ready"
                                ? workspaceOauthClients.data.map((client) => ({
                                    value: client.id,
                                    label: client.label ?? client.clientId,
                                  }))
                                : []),
                            ]}
                          />
                        </Field>
                        {connectForm.workspaceOauthClientId.trim().length ===
                          0 && (
                          <>
                            <Field
                              label="New client ID"
                              className="sm:col-span-2"
                            >
                              <TextInput
                                type="password"
                                value={connectForm.oauthClientId}
                                onChange={(v) =>
                                  setFormField("oauthClientId", v)
                                }
                                placeholder="1234567890-abcdef.apps.googleusercontent.com"
                              />
                            </Field>
                            <Field
                              label="New client secret"
                              className="sm:col-span-2"
                            >
                              <TextInput
                                type="password"
                                value={connectForm.oauthClientSecret}
                                onChange={(v) =>
                                  setFormField("oauthClientSecret", v)
                                }
                                placeholder="GOCSPX-..."
                              />
                            </Field>
                          </>
                        )}
                      </>
                    )}
                  {(connectForm.kind === "openapi" ||
                    connectForm.kind === "graphql") &&
                    connectForm.authKind === "oauth2" && (
                      <>
                        <Field
                          label="OAuth client ID"
                          className="sm:col-span-2"
                        >
                          <TextInput
                            type="password"
                            value={connectForm.oauthClientId}
                            onChange={(value) =>
                              setFormField("oauthClientId", value)
                            }
                            placeholder="client-id"
                          />
                        </Field>
                        <Field
                          label="OAuth client secret (optional)"
                          className="sm:col-span-2"
                        >
                          <TextInput
                            type="password"
                            value={connectForm.oauthClientSecret}
                            onChange={(value) =>
                              setFormField("oauthClientSecret", value)
                            }
                            placeholder="client-secret"
                          />
                        </Field>
                        <Field
                          label="Authorization endpoint"
                          className="sm:col-span-2"
                        >
                          <TextInput
                            value={connectForm.oauthAuthorizationEndpoint}
                            onChange={(value) =>
                              setFormField(
                                "oauthAuthorizationEndpoint",
                                value,
                              )
                            }
                            placeholder="https://provider.example.com/oauth/authorize"
                            mono
                          />
                        </Field>
                        <Field
                          label="Token endpoint"
                          className="sm:col-span-2"
                        >
                          <TextInput
                            value={connectForm.oauthTokenEndpoint}
                            onChange={(value) =>
                              setFormField("oauthTokenEndpoint", value)
                            }
                            placeholder="https://provider.example.com/oauth/token"
                            mono
                          />
                        </Field>
                        <Field label="Scopes" className="sm:col-span-2">
                          <TextInput
                            value={connectForm.oauthScopesText}
                            onChange={(value) =>
                              setFormField("oauthScopesText", value)
                            }
                            placeholder="scope.one scope.two"
                          />
                        </Field>
                      </>
                    )}
                  {connectForm.authKind !== "none" && (
                    <>
                      <Field label="Header name">
                        <TextInput
                          value={connectForm.authHeaderName}
                          onChange={(v) => setFormField("authHeaderName", v)}
                          placeholder="Authorization"
                        />
                      </Field>
                      <Field label="Prefix">
                        <TextInput
                          value={connectForm.authPrefix}
                          onChange={(v) => setFormField("authPrefix", v)}
                          placeholder="Bearer "
                        />
                      </Field>
                    </>
                  )}
                  {connectForm.authKind === "bearer" && (
                    <Field label="Token" className="sm:col-span-2">
                      <SecretOrTokenInput
                        instanceConfig={instanceConfig}
                        secrets={secrets}
                        handle={connectForm.bearerHandle}
                        inlineToken={connectForm.bearerToken}
                        onSelectSecret={(providerId, handle) => {
                          setFormField("bearerProviderId", providerId);
                          setFormField("bearerHandle", handle);
                          setFormField("bearerToken", "");
                        }}
                        onChangeToken={(token) => {
                          setFormField("bearerToken", token);
                          setFormField("bearerProviderId", "");
                          setFormField("bearerHandle", "");
                        }}
                      />
                    </Field>
                  )}
                </div>
              </Section>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 border-t border-border pt-5">
              {phase === "credential_required" && (
                <Button
                  variant="ghost"
                  type="button"
                  onClick={handleBackToEditing}
                >
                  Back to edit
                </Button>
              )}
              <Link to="/" className="inline-flex">
                <Button variant="ghost" type="button">
                  Cancel
                </Button>
              </Link>
              <Button
                onClick={
                  phase === "credential_required"
                    ? handleCredentialConnect
                    : handleConnect
                }
                disabled={isBusy}
              >
                {isConnecting ? (
                  <IconSpinner className="size-3.5" />
                ) : (
                  <IconPlus className="size-3.5" />
                )}
                {isConnecting ? "Connecting\u2026" : "Connect"}
              </Button>
            </div>
          </div>
        )}

        {/* Step 5a: OAuth required */}
        {phase === "oauth_required" && (oauthInfo || batchOauthInfo) && (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-full max-w-sm space-y-6 text-center">
              {/* Visual anchor */}
              <div className="mx-auto flex size-16 items-center justify-center rounded-2xl border border-primary/20 bg-gradient-to-b from-primary/10 to-primary/4">
                {oauthBusy ? (
                  <IconSpinner className="size-6 text-primary" />
                ) : (
                  <svg
                    className="size-6 text-primary"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                )}
              </div>

              <div className="space-y-2">
                <h2 className="font-display text-xl tracking-tight text-foreground">
                  {oauthBusy
                    ? "Waiting for sign-in\u2026"
                    : "Sign in to continue"}
                </h2>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {oauthInfo ? (
                    <>
                      <strong className="text-foreground">
                        {oauthInfo.source.name}
                      </strong>{" "}
                      requires OAuth authentication. A popup will open for you
                      to authorize access.
                    </>
                  ) : (
                    <>
                      {batchOauthInfo!.sourceIds.length} Google source
                      {batchOauthInfo!.sourceIds.length === 1 ? "" : "s"} need
                      {batchOauthInfo!.sourceIds.length === 1 ? "s" : ""} OAuth.
                      One consent screen covers all selected APIs.
                    </>
                  )}
                </p>
              </div>

              <div className="flex flex-col items-center gap-3">
                <Button
                  onClick={handleOAuthPopup}
                  disabled={oauthBusy}
                  className="w-full max-w-xs"
                >
                  {oauthBusy ? <IconSpinner className="size-3.5" /> : null}
                  {oauthBusy ? "Authenticating\u2026" : "Open sign-in"}
                </Button>
                {!oauthBusy && (
                  <button
                    type="button"
                    onClick={handleBackToEditing}
                    className="text-[12px] font-medium text-muted-foreground/60 transition-colors hover:text-foreground"
                  >
                    Back to configuration
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Step 5b: Connected */}
        {phase === "connected" && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="space-y-5 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10 ring-4 ring-primary/5">
                <IconCheck className="size-6 text-primary" />
              </div>
              <div className="space-y-1.5">
                <h2 className="font-display text-xl tracking-tight text-foreground">
                  {connectResult
                    ? connectResult.source.name
                    : batchOauthInfo
                      ? `${batchOauthInfo.sourceIds.length} source${batchOauthInfo.sourceIds.length === 1 ? "" : "s"}`
                      : "Source"}{" "}
                  connected
                </h2>
                <p className="text-[13px] text-muted-foreground/70">
                  Redirecting\u2026
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form building blocks
// ---------------------------------------------------------------------------

function Section(props: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card/80",
        props.className,
      )}
    >
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
      <span className="text-[12px] font-medium text-foreground">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

function TextInput(props: {
  type?: "text" | "password";
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type={props.type || "text"}
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

function StatusBanner(props: {
  state: { tone: "info" | "success" | "error"; text: string };
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[13px]",
        props.state.tone === "success" &&
          "border-primary/30 bg-primary/8 text-foreground",
        props.state.tone === "info" &&
          "border-border bg-card text-muted-foreground",
        props.state.tone === "error" &&
          "border-destructive/30 bg-destructive/8 text-destructive",
        props.className,
      )}
    >
      <span className="mt-0.5 shrink-0">
        {props.state.tone === "success" && (
          <IconCheck className="size-3.5 text-primary" />
        )}
        {props.state.tone === "error" && (
          <svg
            className="size-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M15 9l-6 6" />
            <path d="M9 9l6 6" />
          </svg>
        )}
        {props.state.tone === "info" && (
          <svg
            className="size-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
        )}
      </span>
      <span>{props.state.text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secret or inline token picker
// ---------------------------------------------------------------------------

const CREATE_NEW_VALUE = "__create_new__";
const INLINE_TOKEN_VALUE = "__inline_token__";

function SecretOrTokenInput(props: {
  instanceConfig: Loadable<InstanceConfig>;
  secrets: Loadable<ReadonlyArray<SecretListItem>>;
  handle: string;
  inlineToken: string;
  onSelectSecret: (providerId: string, handle: string) => void;
  onChangeToken: (token: string) => void;
}) {
  const {
    instanceConfig,
    secrets,
    handle,
    inlineToken,
    onSelectSecret,
    onChangeToken,
  } = props;
  const createSecret = useCreateSecret();
  const [showCreate, setShowCreate] = useState(false);
  const [useInline, setUseInline] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newProviderId, setNewProviderId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const storableProviders =
    instanceConfig.status === "ready"
      ? instanceConfig.data.secretProviders.filter(
          (provider) => provider.canStore,
        )
      : [];

  useEffect(() => {
    if (newProviderId.length > 0) {
      return;
    }
    if (instanceConfig.status === "ready") {
      setNewProviderId(instanceConfig.data.defaultSecretStoreProvider);
    }
  }, [instanceConfig, newProviderId]);

  const selectedValue = showCreate
    ? CREATE_NEW_VALUE
    : useInline
      ? INLINE_TOKEN_VALUE
      : handle || "";

  const handleSelectChange = (value: string) => {
    if (value === CREATE_NEW_VALUE) {
      setShowCreate(true);
      setUseInline(false);
      setNewName("");
      setNewValue("");
      setNewProviderId(
        instanceConfig.status === "ready"
          ? instanceConfig.data.defaultSecretStoreProvider
          : "",
      );
      setCreateError(null);
      return;
    }
    if (value === INLINE_TOKEN_VALUE) {
      setUseInline(true);
      setShowCreate(false);
      onSelectSecret("", "");
      return;
    }
    if (value === "") {
      setUseInline(false);
      setShowCreate(false);
      onSelectSecret("", "");
      return;
    }
    setUseInline(false);
    setShowCreate(false);
    const matchedSecret =
      secrets.status === "ready"
        ? secrets.data.find((secret) => secret.id === value)
        : null;
    onSelectSecret(matchedSecret?.providerId ?? "local", value);
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
      const result = await createSecret.mutateAsync({
        name: trimmedName,
        value: newValue,
        ...(newProviderId ? { providerId: newProviderId } : {}),
      });
      onSelectSecret(result.providerId, result.id);
      setShowCreate(false);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed creating secret.",
      );
    }
  };

  if (secrets.status !== "ready") {
    return (
      <select
        disabled
        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-muted-foreground outline-none opacity-60"
      >
        <option>Loading...</option>
      </select>
    );
  }

  const items = secrets.data;

  return (
    <div className="space-y-2">
      <select
        value={selectedValue}
        onChange={(e) => handleSelectChange(e.target.value)}
        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
      >
        <option value="">Select a secret...</option>
        {items.map((secret) => (
          <option key={secret.id} value={secret.id}>
            {secret.name || secret.id} ({secret.providerId})
          </option>
        ))}
        <option value={INLINE_TOKEN_VALUE}>Paste token directly</option>
        <option value={CREATE_NEW_VALUE}>+ Create new secret</option>
      </select>

      {useInline && (
        <input
          type="password"
          value={inlineToken}
          onChange={(e) => onChangeToken(e.target.value)}
          placeholder="sk-... or ghp_..."
          className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
          autoFocus
        />
      )}

      {showCreate && (
        <div className="rounded-lg border border-primary/20 bg-card/80 p-3 space-y-3">
          {createError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-[12px] text-destructive">
              {createError}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Name
              </span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="API Key"
                className="h-8 w-full rounded-lg border border-input bg-background px-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
                autoFocus
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Value
              </span>
              <input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="sk-..."
                className="h-8 w-full rounded-lg border border-input bg-background px-3 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Store in
              </span>
              <select
                value={newProviderId}
                onChange={(e) => setNewProviderId(e.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-background px-3 text-[12px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
              >
                {storableProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
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
              {createSecret.status === "pending" && (
                <IconSpinner className="size-3" />
              )}
              Store & use
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
