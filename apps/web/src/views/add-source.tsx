import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type CompleteSourceOAuthResult,
  type ConnectSourcePayload,
  type ConnectSourceResult,
  type DiscoverSourcePayload,
  type Loadable,
  type SecretListItem,
  type Source,
  type SourceDiscoveryResult,
  useConnectSource,
  useCreateSecret,
  useDiscoverSource,
  useRefreshSecrets,
  useSecrets,
  useStartSourceOAuth,
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
import { sourceTemplates, type SourceTemplate } from "./source-templates";
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

type ConnectFormState = {
  kind: "mcp" | "openapi" | "graphql" | "google_discovery";
  endpoint: string;
  specUrl: string;
  service: string;
  version: string;
  discoveryUrl: string;
  name: string;
  namespace: string;
  transport: "" | "auto" | "streamable-http" | "sse";
  authKind: "none" | "bearer" | "oauth2";
  authHeaderName: string;
  authPrefix: string;
  bearerToken: string;
  bearerProviderId: string;
  bearerHandle: string;
  oauthClientId: string;
  oauthClientSecret: string;
  queryParamsText: string;
  headersText: string;
};

type OAuthRequiredInfo = {
  source: Source;
  sessionId: string;
  authorizationUrl: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const kindOptions: ReadonlyArray<ConnectFormState["kind"]> = [
  "mcp",
  "openapi",
  "graphql",
  "google_discovery",
];

const transportOptions: ReadonlyArray<"auto" | "streamable-http" | "sse"> = [
  "auto",
  "streamable-http",
  "sse",
];

const authOptions: ReadonlyArray<ConnectFormState["authKind"]> = ["none", "bearer", "oauth2"];

const probeAuthOptions: ReadonlyArray<ProbeAuthKind> = ["none", "bearer", "basic", "headers"];

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
  `google.${service.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "")}`;

const googleDiscoveryDefaultsFromUrl = (value: string): {
  service: string;
  version: string;
  discoveryUrl: string;
} | null => {
  try {
    const url = new URL(value);
    const byDirectory = url.pathname.match(/^\/discovery\/v1\/apis\/([^/]+)\/([^/]+)\/rest$/);
    if (byDirectory) {
      return {
        service: decodeURIComponent(byDirectory[1] ?? ""),
        version: decodeURIComponent(byDirectory[2] ?? ""),
        discoveryUrl: url.toString(),
      };
    }

    const versionParam = url.searchParams.get("version");
    const version = versionParam ? trimToNull(versionParam) : null;
    const isHostScopedDiscovery = url.pathname === "/$discovery/rest"
      && url.hostname.endsWith(".googleapis.com")
      && url.hostname !== "www.googleapis.com";
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

const parseJsonStringMap = (label: string, text: string): Record<string, string> | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
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

// ---------------------------------------------------------------------------
// Derived defaults from discovery result
// ---------------------------------------------------------------------------

const defaultConnectForm = (discovery?: SourceDiscoveryResult): ConnectFormState => {
  if (!discovery || discovery.detectedKind === "unknown") {
    return {
      kind: "openapi",
      endpoint: discovery?.endpoint ?? "",
      specUrl: discovery?.specUrl ?? "",
      service: "",
      version: "",
      discoveryUrl: "",
      name: discovery?.name ?? "",
      namespace: discovery?.namespace || namespaceFromUrl(discovery?.endpoint ?? ""),
      transport: "",
      authKind: "none",
      authHeaderName: "Authorization",
      authPrefix: "Bearer ",
      bearerToken: "",
      bearerProviderId: "",
      bearerHandle: "",
      oauthClientId: "",
      oauthClientSecret: "",
      queryParamsText: "",
      headersText: "",
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

  const googleDiscoveryDefaults = kind === "google_discovery"
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
    transport: kind === "mcp" ? (discovery.transport ?? "auto") : "",
    authKind,
    authHeaderName,
    authPrefix,
    bearerToken: "",
    bearerProviderId: "",
    bearerHandle: "",
    oauthClientId: "",
    oauthClientSecret: "",
    queryParamsText: "",
    headersText: "",
  };
};

const connectFormFromTemplate = (template: SourceTemplate): ConnectFormState => ({
  ...defaultConnectForm(),
  kind: template.kind as ConnectFormState["kind"],
  endpoint: template.endpoint,
  specUrl: "specUrl" in template ? template.specUrl : "",
  service: "service" in template ? template.service : "",
  version: "version" in template ? template.version : "",
  discoveryUrl: "discoveryUrl" in template ? template.discoveryUrl : "",
  name: template.name,
  namespace: "service" in template
    ? googleDiscoveryNamespace(template.service)
    : namespaceFromUrl(template.endpoint),
  transport: template.kind === "mcp" ? "auto" : "",
  authKind: template.kind === "google_discovery" ? "oauth2" : "none",
});

const authKindForSourceKind = (
  currentAuthKind: ConnectFormState["authKind"],
  nextKind: ConnectFormState["kind"],
): ConnectFormState["authKind"] =>
  nextKind === "google_discovery" && currentAuthKind === "none"
    ? "oauth2"
    : currentAuthKind;

const buildProbeAuth = (state: ProbeAuthState): DiscoverSourcePayload["probeAuth"] => {
  if (state.kind === "none") return { kind: "none" };
  if (state.kind === "bearer") {
    if (!state.token.trim()) throw new Error("Token is required for bearer probe auth.");
    return {
      kind: "bearer",
      headerName: trimToNull(state.headerName),
      prefix: trimToNull(state.prefix),
      token: state.token.trim(),
    };
  }
  if (state.kind === "basic") {
    if (!state.username.trim()) throw new Error("Username is required for basic probe auth.");
    return {
      kind: "basic",
      username: state.username.trim(),
      password: state.password,
    };
  }
  // headers
  const headers = parseJsonStringMap("Probe headers", state.headersText);
  if (!headers) throw new Error("At least one header is required for headers probe auth.");
  return { kind: "headers", headers };
};

const buildConnectPayload = (form: ConnectFormState): ConnectSourcePayload => {
  if (form.kind === "mcp") {
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
      name: trimToNull(form.name),
      namespace: trimToNull(form.namespace),
      auth,
    };
  }

  if (form.kind === "google_discovery") {
    const service = form.service.trim();
    const version = form.version.trim();
    if (!service) throw new Error("Google Discovery sources require a service name.");
    if (!version) throw new Error("Google Discovery sources require a version.");
    if (form.authKind === "oauth2" && form.oauthClientId.trim().length === 0) {
      throw new Error("Google OAuth requires a client ID.");
    }
    return {
      kind: "google_discovery",
      service,
      version,
      discoveryUrl: trimToNull(form.discoveryUrl),
      name: trimToNull(form.name),
      namespace: trimToNull(form.namespace),
      oauthClient: form.authKind === "oauth2"
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
    name: trimToNull(form.name),
    namespace: trimToNull(form.namespace),
    auth,
  };
};

const buildHttpAuth = (
  form: ConnectFormState,
): { kind: "none" } | { kind: "bearer"; headerName?: string | null; prefix?: string | null; token?: string | null; tokenRef?: { providerId: string; handle: string } | null } | undefined => {
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

    throw new Error("Bearer auth requires a token. Select or create a secret, or enter a token directly.");
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

const readStoredSourceOAuthPopupResult = (sessionId: string): SourceOAuthPopupMessage | null => {
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
  window.localStorage.removeItem(`${SOURCE_OAUTH_POPUP_RESULT_STORAGE_KEY_PREFIX}${sessionId}`);
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
        if (!data.ok && data.sessionId !== null && data.sessionId !== input.sessionId) return;
      } else if (data.type !== "executor:source-oauth-result") {
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
  const secrets = useSecrets();
  const refreshSecrets = useRefreshSecrets();
  const startSourceOAuth = useStartSourceOAuth();

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
  const [discovery, setDiscovery] = useState<SourceDiscoveryResult | null>(null);

  // Editable connect form (populated after discovery)
  const [connectForm, setConnectForm] = useState<ConnectFormState>(defaultConnectForm());

  // Connect result
  const [connectResult, setConnectResult] = useState<ConnectSourceResult | null>(null);

  // OAuth required state
  const [oauthInfo, setOauthInfo] = useState<OAuthRequiredInfo | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);

  // Status banner
  const [statusBanner, setStatusBanner] = useState<{
    tone: "info" | "success" | "error";
    text: string;
  } | null>(null);

  const setFormField = <K extends keyof ConnectFormState>(key: K, value: ConnectFormState[K]) => {
    setConnectForm((current) => ({ ...current, [key]: value }));
  };

  const setSourceKind = (kind: ConnectFormState["kind"]) => {
    setConnectForm((current) => ({
      ...current,
      kind,
      authKind: authKindForSourceKind(current.authKind, kind),
    }));
  };

  const setProbeField = <K extends keyof ProbeAuthState>(key: K, value: ProbeAuthState[K]) => {
    setProbeAuth((current) => ({ ...current, [key]: value }));
  };

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleDiscover = async () => {
    setStatusBanner(null);
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setStatusBanner({ tone: "error", text: "Please enter a URL to discover." });
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
      setDiscovery(result);
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
    setDiscovery(null);
    setConnectForm(defaultConnectForm());
    setPhase("editing");
    setStatusBanner(null);
  };

  const applyTemplate = async (template: SourceTemplate) => {
    const discoveryUrl = "specUrl" in template ? template.specUrl : template.endpoint;
    setUrl(template.endpoint);
    setStatusBanner(null);
    setPhase("discovering");

    try {
      const result = await discoverSource.mutateAsync({ url: discoveryUrl });
      setDiscovery(result);
      const form = defaultConnectForm(result);
      // Prefer the template's own values over whatever discover returned
      form.name = template.name;
      form.endpoint = template.endpoint;
      form.namespace = namespaceFromUrl(template.endpoint);
      if ("specUrl" in template) {
        form.specUrl = template.specUrl;
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
      setDiscovery(null);
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
    if (!oauthInfo) return;
    setStatusBanner(null);
    setOauthBusy(true);

    try {
      await startSourceOAuthPopup({
        authorizationUrl: oauthInfo.authorizationUrl,
        sessionId: oauthInfo.sessionId,
      });

      refreshSecrets();
      setPhase("connected");
      setStatusBanner({
        tone: "success",
        text: `"${oauthInfo.source.name}" connected via OAuth.`,
      });

      setTimeout(() => {
        void navigate({
          to: "/sources/$sourceId",
          params: { sourceId: oauthInfo.source.id },
          search: { tab: "model" },
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
  const isBusy = isDiscovering || isConnecting || oauthBusy;

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
          {phase === "connected" && (
            <Badge variant="default">connected</Badge>
          )}
        </div>

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
                  Enter a URL and we'll auto-detect the source type, endpoint, auth requirements, and more.
                </p>

                <Field label="URL">
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
                      {isDiscovering ? <IconSpinner className="size-3.5" /> : <IconDiscover className="size-3.5" />}
                      {isDiscovering ? "Discovering\u2026" : "Discover"}
                    </Button>
                  </div>
                </Field>

                {/* Probe auth toggle */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowProbeAuth(!showProbeAuth)}
                    className="text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showProbeAuth ? "Hide probe auth" : "Need auth to discover?"}
                  </button>
                </div>

                {showProbeAuth && (
                  <div className="rounded-lg border border-border bg-card/70 p-4 space-y-3">
                    <Field label="Auth type">
                      <SelectInput
                        value={probeAuth.kind}
                        onChange={(v) => setProbeField("kind", v as ProbeAuthKind)}
                        options={probeAuthOptions.map((v) => ({ value: v, label: v }))}
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

                <div className="space-y-3 border-t border-border pt-4">
                  <div>
                    <p className="text-[12px] font-medium text-foreground">Start from a known source</p>
                     <p className="text-[11px] text-muted-foreground">
                       Load a real MCP, OpenAPI, GraphQL, or Google Discovery template without running discovery first.
                     </p>
                   </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {sourceTemplates.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => applyTemplate(template)}
                        disabled={isBusy}
                        className="rounded-xl border border-border bg-card/70 px-4 py-3 text-left transition-colors hover:bg-accent/50 disabled:opacity-60"
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
                        <span className="line-clamp-2 text-[11px] text-muted-foreground">
                          {template.summary}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Section>
          </div>
        )}



        {/* Step 2-4: Editing / Connecting */}
        {(phase === "editing" || phase === "connecting" || phase === "credential_required") && (
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
                    onChange={(v) => setSourceKind(v as ConnectFormState["kind"])}
                    options={kindOptions.map((v) => ({ value: v, label: v }))}
                  />
                </Field>
                {connectForm.kind !== "google_discovery" && (
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
                    <Field label="Discovery URL (optional)" className="sm:col-span-2">
                      <TextInput
                        value={connectForm.discoveryUrl}
                        onChange={(v) => setFormField("discoveryUrl", v)}
                        placeholder="https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest"
                        mono
                      />
                    </Field>
                    <div className="sm:col-span-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-[12px] text-muted-foreground">
                      Common Google API versions: Gmail `v1`, Sheets `v4`, Drive `v3`, Calendar `v3`, Docs `v1`.
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
                      onChange={(v) => setFormField("transport", v as ConnectFormState["transport"])}
                      options={transportOptions.map((v) => ({ value: v, label: v }))}
                    />
                  </Field>
                  <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
                    <Field label="Query params (JSON)">
                      <CodeEditor
                        value={connectForm.queryParamsText}
                        onChange={(v) => setFormField("queryParamsText", v)}
                        placeholder={'{\n  "workspace": "demo"\n}'}
                      />
                    </Field>
                    <Field label="Headers (JSON)">
                      <CodeEditor
                        value={connectForm.headersText}
                        onChange={(v) => setFormField("headersText", v)}
                        placeholder={'{\n  "x-api-key": "..."\n}'}
                      />
                    </Field>
                  </div>
                </div>
              </Section>
            )}

            {/* Auth section (for non-MCP kinds, or when credential_required) */}
            {connectForm.kind !== "mcp" && (
              <Section title="Authentication">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Auth mode">
                    <SelectInput
                      value={connectForm.authKind}
                      onChange={(v) => setFormField("authKind", v as ConnectFormState["authKind"])}
                      options={authOptions.map((v) => ({ value: v, label: v }))}
                    />
                  </Field>
                  {connectForm.kind === "google_discovery" && (
                    <div className="sm:col-span-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-[12px] text-muted-foreground">
                      {connectForm.authKind === "oauth2"
                        ? "OAuth starts after you click Connect. Executor will store the OAuth client secret in the configured secret store, then open the Google sign-in flow for this source."
                        : "Choosing auth mode 'none' skips the Google OAuth popup. Use 'oauth2' if you want executor to start the sign-in flow for you."}
                    </div>
                  )}
                  {connectForm.kind === "google_discovery" && connectForm.authKind === "oauth2" && (
                    <>
                      <Field label="OAuth client ID" className="sm:col-span-2">
                        <TextInput
                          value={connectForm.oauthClientId}
                          onChange={(v) => setFormField("oauthClientId", v)}
                          placeholder="1234567890-abcdef.apps.googleusercontent.com"
                        />
                      </Field>
                      <Field label="OAuth client secret" className="sm:col-span-2">
                        <TextInput
                          value={connectForm.oauthClientSecret}
                          onChange={(v) => setFormField("oauthClientSecret", v)}
                          placeholder="GOCSPX-..."
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
                        secrets={secrets}
                        providerId={connectForm.bearerProviderId}
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
                <Button variant="ghost" type="button" onClick={handleBackToEditing}>
                  Back to edit
                </Button>
              )}
              <Link to="/" className="inline-flex">
                <Button variant="ghost" type="button">Cancel</Button>
              </Link>
              <Button
                onClick={phase === "credential_required" ? handleCredentialConnect : handleConnect}
                disabled={isBusy}
              >
                {isConnecting ? <IconSpinner className="size-3.5" /> : <IconPlus className="size-3.5" />}
                {isConnecting ? "Connecting\u2026" : "Connect"}
              </Button>
            </div>
          </div>
        )}

        {/* Step 5a: OAuth required */}
        {phase === "oauth_required" && oauthInfo && (
          <div className="space-y-6">
            <Section title="OAuth Authentication Required">
              <div className="space-y-4">
                <p className="text-[13px] text-muted-foreground">
                  The source <strong className="text-foreground">{oauthInfo.source.name}</strong> requires OAuth.
                  Click the button below to open a popup and complete authentication.
                </p>
                <div className="flex items-center gap-3">
                  <Button onClick={handleOAuthPopup} disabled={oauthBusy}>
                    {oauthBusy ? <IconSpinner className="size-3.5" /> : null}
                    {oauthBusy ? "Authenticating\u2026" : "Sign in with OAuth"}
                  </Button>
                  <Button variant="ghost" onClick={handleBackToEditing}>
                    Back to edit
                  </Button>
                </div>
              </div>
            </Section>
          </div>
        )}

        {/* Step 5b: Connected */}
        {phase === "connected" && connectResult && (
          <Section title="Connected">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <IconCheck className="size-5" />
              </div>
              <div>
                <p className="text-[14px] font-medium text-foreground">
                  {connectResult.source.name}
                </p>
                <p className="text-[12px] text-muted-foreground">
                  Source connected. Redirecting...
                </p>
              </div>
            </div>
          </Section>
        )}
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

function StatusBanner(props: { state: { tone: "info" | "success" | "error"; text: string }; className?: string }) {
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



// ---------------------------------------------------------------------------
// Secret or inline token picker
// ---------------------------------------------------------------------------

const CREATE_NEW_VALUE = "__create_new__";
const INLINE_TOKEN_VALUE = "__inline_token__";

function SecretOrTokenInput(props: {
  secrets: Loadable<ReadonlyArray<SecretListItem>>;
  providerId: string;
  handle: string;
  inlineToken: string;
  onSelectSecret: (providerId: string, handle: string) => void;
  onChangeToken: (token: string) => void;
}) {
  const { secrets, providerId, handle, inlineToken, onSelectSecret, onChangeToken } = props;
  const createSecret = useCreateSecret();
  const [showCreate, setShowCreate] = useState(false);
  const [useInline, setUseInline] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const selectedValue = showCreate ? CREATE_NEW_VALUE : useInline ? INLINE_TOKEN_VALUE : (handle || "");

  const handleSelectChange = (value: string) => {
    if (value === CREATE_NEW_VALUE) {
      setShowCreate(true);
      setUseInline(false);
      setNewName("");
      setNewValue("");
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
    onSelectSecret("postgres", value);
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
      onSelectSecret(result.providerId, result.id);
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
            {secret.name || secret.id}
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
              <span className="text-[11px] font-medium text-muted-foreground">Name</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="API Key"
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
                placeholder="sk-..."
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
