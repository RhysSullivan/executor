import { startTransition, useMemo, useState, type ReactNode } from "react";
import type { Source } from "@executor/react";
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
  Badge,
  IconPencil,
  SourceToolExplorer,
  parseSourceToolExplorerSearch,
  type SourceToolExplorerSearch,
  useSourcePluginNavigation,
  useSourcePluginRouteParams,
  useSourcePluginSearch,
} from "@executor/react/plugins";

import {
  googleDiscoveryHttpApiExtension,
} from "@executor/plugin-google-discovery-http";
import {
  GOOGLE_DISCOVERY_OAUTH_CALLBACK_PATH,
  GOOGLE_DISCOVERY_OAUTH_STORAGE_PREFIX,
  GOOGLE_DISCOVERY_PLUGIN_KEY,
  GOOGLE_DISCOVERY_SOURCE_KIND,
  defaultGoogleDiscoveryUrl,
  type GoogleDiscoveryBatchSourceInput,
  type GoogleDiscoveryConnectInput,
  type GoogleDiscoveryConnectionAuth,
  type GoogleDiscoveryOAuthPopupResult,
  type GoogleDiscoveryStartBatchOAuthInput,
  type GoogleDiscoveryStartOAuthInput,
} from "@executor/plugin-google-discovery-shared";
import { getGoogleDiscoveryIconUrlForService } from "./icons";

const OAUTH_TIMEOUT_MS = 2 * 60_000;

const getGoogleDiscoveryHttpClient =
  defineExecutorPluginHttpApiClient<"GoogleDiscoveryReactHttpClient">()(
    "GoogleDiscoveryReactHttpClient",
    [googleDiscoveryHttpApiExtension] as const,
  );

const defaultGoogleInput = (): GoogleDiscoveryConnectInput => ({
  name: "Google Sheets",
  service: "sheets",
  version: "v4",
  discoveryUrl: defaultGoogleDiscoveryUrl("sheets", "v4"),
  defaultHeaders: null,
  scopes: [],
  auth: {
    kind: "none",
  },
});

type GoogleDiscoveryBatchTemplate = {
  id: string;
  name: string;
  summary: string;
  service: string;
  version: string;
  discoveryUrl: string;
};

const googleDiscoveryTemplate = (
  input: GoogleDiscoveryBatchTemplate,
): GoogleDiscoveryBatchTemplate => ({
  ...input,
  discoveryUrl: input.discoveryUrl || defaultGoogleDiscoveryUrl(input.service, input.version),
});

const GOOGLE_DISCOVERY_BATCH_TEMPLATES: ReadonlyArray<GoogleDiscoveryBatchTemplate> = [
  googleDiscoveryTemplate({
    id: "google-calendar",
    name: "Google Calendar",
    summary: "Calendars, events, ACLs, and scheduling workflows.",
    service: "calendar",
    version: "v3",
    discoveryUrl: "https://calendar-json.googleapis.com/$discovery/rest?version=v3",
  }),
  googleDiscoveryTemplate({
    id: "google-drive",
    name: "Google Drive",
    summary: "Files, folders, permissions, comments, and shared drives.",
    service: "drive",
    version: "v3",
    discoveryUrl: defaultGoogleDiscoveryUrl("drive", "v3"),
  }),
  googleDiscoveryTemplate({
    id: "google-gmail",
    name: "Gmail",
    summary: "Messages, threads, labels, drafts, and mailbox automation.",
    service: "gmail",
    version: "v1",
    discoveryUrl: "https://gmail.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-docs",
    name: "Google Docs",
    summary: "Documents, structural edits, text ranges, and formatting.",
    service: "docs",
    version: "v1",
    discoveryUrl: "https://docs.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-sheets",
    name: "Google Sheets",
    summary: "Spreadsheets, values, ranges, formatting, and batch updates.",
    service: "sheets",
    version: "v4",
    discoveryUrl: "https://sheets.googleapis.com/$discovery/rest?version=v4",
  }),
  googleDiscoveryTemplate({
    id: "google-slides",
    name: "Google Slides",
    summary: "Presentations, slides, page elements, and deck updates.",
    service: "slides",
    version: "v1",
    discoveryUrl: "https://slides.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-forms",
    name: "Google Forms",
    summary: "Forms, questions, responses, quizzes, and form metadata.",
    service: "forms",
    version: "v1",
    discoveryUrl: "https://forms.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-search-console",
    name: "Google Search Console",
    summary: "Sites, sitemaps, URL inspection, and search performance.",
    service: "searchconsole",
    version: "v1",
    discoveryUrl: "https://searchconsole.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-people",
    name: "Google People",
    summary: "Contacts, profiles, directory people, and contact groups.",
    service: "people",
    version: "v1",
    discoveryUrl: "https://people.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-tasks",
    name: "Google Tasks",
    summary: "Task lists, task items, notes, and due dates.",
    service: "tasks",
    version: "v1",
    discoveryUrl: "https://tasks.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-chat",
    name: "Google Chat",
    summary: "Spaces, messages, members, reactions, and chat workflows.",
    service: "chat",
    version: "v1",
    discoveryUrl: "https://chat.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-keep",
    name: "Google Keep",
    summary: "Notes, lists, attachments, and collaborative annotations.",
    service: "keep",
    version: "v1",
    discoveryUrl: "https://keep.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-classroom",
    name: "Google Classroom",
    summary: "Courses, rosters, coursework, submissions, and grading data.",
    service: "classroom",
    version: "v1",
    discoveryUrl: "https://classroom.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-admin-directory",
    name: "Google Admin Directory",
    summary: "Users, groups, org units, roles, and directory resources.",
    service: "admin",
    version: "directory_v1",
    discoveryUrl: "https://admin.googleapis.com/$discovery/rest?version=directory_v1",
  }),
  googleDiscoveryTemplate({
    id: "google-admin-reports",
    name: "Google Admin Reports",
    summary: "Audit events, usage reports, and admin activity logs.",
    service: "admin",
    version: "reports_v1",
    discoveryUrl: "https://admin.googleapis.com/$discovery/rest?version=reports_v1",
  }),
  googleDiscoveryTemplate({
    id: "google-apps-script",
    name: "Google Apps Script",
    summary: "Projects, deployments, execution, and script metadata.",
    service: "script",
    version: "v1",
    discoveryUrl: "https://script.googleapis.com/$discovery/rest?version=v1",
  }),
  googleDiscoveryTemplate({
    id: "google-bigquery",
    name: "Google BigQuery",
    summary: "Datasets, tables, jobs, routines, and analytics workflows.",
    service: "bigquery",
    version: "v2",
    discoveryUrl: "https://bigquery.googleapis.com/$discovery/rest?version=v2",
  }),
  googleDiscoveryTemplate({
    id: "google-cloud-resource-manager",
    name: "Google Cloud Resource Manager",
    summary: "Projects, folders, organizations, and IAM hierarchy.",
    service: "cloudresourcemanager",
    version: "v3",
    discoveryUrl: "https://cloudresourcemanager.googleapis.com/$discovery/rest?version=v3",
  }),
  googleDiscoveryTemplate({
    id: "google-youtube-data",
    name: "YouTube Data",
    summary: "Channels, playlists, videos, comments, captions, and uploads.",
    service: "youtube",
    version: "v3",
    discoveryUrl: "https://youtube.googleapis.com/$discovery/rest?version=v3",
  }),
];

const presetString = (
  search: Record<string, unknown>,
  key: string,
): string | null => {
  const value = search[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

const parsedGoogleDiscoveryInputFromUrl = (
  value: string | null,
): Pick<GoogleDiscoveryConnectInput, "name" | "service" | "version" | "discoveryUrl"> | null => {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const byDirectory = url.pathname.match(/^\/discovery\/v1\/apis\/([^/]+)\/([^/]+)\/rest$/);
    if (byDirectory) {
      const service = decodeURIComponent(byDirectory[1] ?? "");
      const version = decodeURIComponent(byDirectory[2] ?? "");
      const knownTemplate = GOOGLE_DISCOVERY_BATCH_TEMPLATES.find(
        (entry) => entry.service === service && entry.version === version,
      );
      return {
        name: knownTemplate?.name ?? `Google ${service}`,
        service,
        version,
        discoveryUrl: url.toString(),
      };
    }

    const version = url.searchParams.get("version")?.trim() ?? "";
    const isHostScopedDiscovery =
      url.pathname === "/$discovery/rest"
      && url.hostname.endsWith(".googleapis.com")
      && url.hostname !== "www.googleapis.com";
    if (version && isHostScopedDiscovery) {
      const service = url.hostname.split(".")[0] ?? "";
      const knownTemplate = GOOGLE_DISCOVERY_BATCH_TEMPLATES.find(
        (entry) => entry.service === service && entry.version === version,
      );
      return {
        name: knownTemplate?.name ?? `Google ${service}`,
        service,
        version,
        discoveryUrl: url.toString(),
      };
    }
  } catch {}

  return null;
};

const googleInputFromSearch = (
  search: Record<string, unknown>,
): GoogleDiscoveryConnectInput => {
  const defaults = defaultGoogleInput();
  const parsedFromInputUrl = parsedGoogleDiscoveryInputFromUrl(
    presetString(search, "inputUrl")
    ?? presetString(search, "input")
    ?? presetString(search, "url"),
  );
  const service =
    presetString(search, "presetService")
    ?? parsedFromInputUrl?.service
    ?? defaults.service;
  const version =
    presetString(search, "presetVersion")
    ?? parsedFromInputUrl?.version
    ?? defaults.version;

  return {
    ...defaults,
    name:
      presetString(search, "presetName")
      ?? parsedFromInputUrl?.name
      ?? defaults.name,
    service,
    version,
    discoveryUrl:
      presetString(search, "presetDiscoveryUrl")
      ?? parsedFromInputUrl?.discoveryUrl
      ?? defaultGoogleDiscoveryUrl(service, version),
  };
};

const stringifyStringMap = (
  value: Record<string, string> | null | undefined,
): string =>
  !value || Object.keys(value).length === 0
    ? ""
    : JSON.stringify(value, null, 2);

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

const stringifyScopes = (value: ReadonlyArray<string>): string =>
  value.join("\n");

const parseScopes = (value: string): Array<string> =>
  value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const authSecretValue = (
  input: GoogleDiscoveryConnectionAuth,
): string =>
  input.kind === "bearer"
    ? JSON.stringify(input.tokenSecretRef)
    : "";

const clientSecretValue = (
  input: GoogleDiscoveryConnectionAuth,
): string =>
  input.kind === "oauth2" && input.clientSecretRef
    ? JSON.stringify(input.clientSecretRef)
    : "";

const waitForOauthPopupResult = async (
  sessionId: string,
): Promise<GoogleDiscoveryOAuthPopupResult> =>
  new Promise((resolve, reject) => {
    const storageKey = `${GOOGLE_DISCOVERY_OAUTH_STORAGE_PREFIX}${sessionId}`;
    const startedAt = Date.now();

    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearInterval(intervalId);
    };

    const finish = (result: GoogleDiscoveryOAuthPopupResult) => {
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

      const data = event.data as GoogleDiscoveryOAuthPopupResult | undefined;
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
        reject(new Error("Timed out waiting for Google OAuth to finish."));
        return;
      }

      try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) {
          return;
        }

        finish(JSON.parse(raw) as GoogleDiscoveryOAuthPopupResult);
      } catch {
        // Ignore malformed local storage and continue polling.
      }
    }, 400);
  });

const openGoogleOauthPopup = (name: string): Window | null => {
  const popup = window.open("", name, "width=560,height=760");
  if (!popup) {
    return null;
  }

  try {
    popup.document.title = "Sign in with Google";
    popup.document.body.innerHTML = `
      <main style="font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; color: #333;">
        <div style="width: 20px; height: 20px; border: 2px solid #e5e7eb; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.7s linear infinite; margin-bottom: 16px;"></div>
        <p style="margin: 0; font-size: 14px; color: #888;">Redirecting to Google&hellip;</p>
        <style>
          @keyframes spin { to { transform: rotate(360deg); } }
          @media (prefers-color-scheme: dark) {
            main { background: #09090b; color: #fafafa !important; }
            p { color: #a1a1aa !important; }
            div { border-color: #3f3f46 !important; }
          }
        </style>
      </main>
    `;
  } catch {
    // Ignore browsers that don't allow writing to the popup document here.
  }

  return popup;
};

const batchSourceInputFromTemplate = (
  template: GoogleDiscoveryBatchTemplate,
): GoogleDiscoveryBatchSourceInput => ({
  name: template.name,
  service: template.service,
  version: template.version,
  discoveryUrl: template.discoveryUrl,
  defaultHeaders: null,
  scopes: [],
});

function GoogleDiscoverySourceForm(props: {
  initialValue: GoogleDiscoveryConnectInput;
  mode: "create" | "edit";
  onSubmit: (input: GoogleDiscoveryConnectInput) => Promise<void>;
}) {
  const installation = useLocalInstallation();
  const client = getGoogleDiscoveryHttpClient();
  const startOAuth = useAtomSet(
    client.mutation(GOOGLE_DISCOVERY_PLUGIN_KEY, "startOAuth"),
    { mode: "promise" },
  );
  const submitMutation = useExecutorMutation<GoogleDiscoveryConnectInput, void>(props.onSubmit);
  const [name, setName] = useState(props.initialValue.name);
  const [service, setService] = useState(props.initialValue.service);
  const [version, setVersion] = useState(props.initialValue.version);
  const [discoveryUrl, setDiscoveryUrl] = useState(props.initialValue.discoveryUrl ?? "");
  const [headersText, setHeadersText] = useState(
    stringifyStringMap(props.initialValue.defaultHeaders),
  );
  const [scopesText, setScopesText] = useState(
    stringifyScopes(props.initialValue.scopes),
  );
  const [authKind, setAuthKind] = useState<GoogleDiscoveryConnectionAuth["kind"]>(
    props.initialValue.auth.kind,
  );
  const [bearerSecretRef, setBearerSecretRef] = useState(
    authSecretValue(props.initialValue.auth),
  );
  const [clientId, setClientId] = useState(
    props.initialValue.auth.kind === "oauth2" ? props.initialValue.auth.clientId : "",
  );
  const [clientSecretRef, setClientSecretRef] = useState(
    clientSecretValue(props.initialValue.auth),
  );
  const [oauthAuth, setOauthAuth] = useState<
    Extract<GoogleDiscoveryConnectionAuth, { kind: "oauth2" }> | null
  >(props.initialValue.auth.kind === "oauth2" ? props.initialValue.auth : null);
  const [error, setError] = useState<string | null>(null);
  const [oauthStatus, setOauthStatus] = useState<"idle" | "pending" | "connected">(
    props.initialValue.auth.kind === "oauth2" ? "connected" : "idle",
  );

  const runOauth = async () => {
    if (installation.status !== "ready") {
      throw new Error("Workspace is still loading.");
    }

    const popup = openGoogleOauthPopup("executor-google-discovery-oauth");
    if (!popup) {
      throw new Error("Failed opening Google OAuth popup. Allow popups for this site and try again.");
    }

    const payload: GoogleDiscoveryStartOAuthInput = {
      service: service.trim(),
      version: version.trim(),
      discoveryUrl: discoveryUrl.trim() || null,
      defaultHeaders: parseStringMap(headersText),
      scopes: parseScopes(scopesText),
      clientId: clientId.trim(),
      clientSecretRef: clientSecretRef
        ? JSON.parse(clientSecretRef)
        : null,
      clientAuthentication: clientSecretRef ? "client_secret_post" : "none",
      redirectUrl: new URL(
        GOOGLE_DISCOVERY_OAUTH_CALLBACK_PATH,
        window.location.origin,
      ).toString(),
    };

    let started;
    try {
      started = await startOAuth({
        path: {
          workspaceId: installation.data.scopeId,
        },
        payload,
      });
    } catch (cause) {
      popup.close();
      throw cause;
    }

    popup.location.replace(started.authorizationUrl);
    popup.focus();

    const result = await waitForOauthPopupResult(started.sessionId);
    if (!result.ok) {
      throw new Error(result.error);
    }
    if (result.mode !== "single") {
      throw new Error("Unexpected batch OAuth result for single-source Google setup.");
    }

    setScopesText(stringifyScopes(result.auth.scopes));
    setOauthAuth(result.auth);
    setOauthStatus("connected");
  };

  return (
    <div className="space-y-6 rounded-xl border border-border p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 sm:col-span-2">
          <span className="text-xs font-medium text-foreground">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </label>
        <label className="grid gap-2">
          <span className="text-xs font-medium text-foreground">Service</span>
          <input
            value={service}
            onChange={(event) => setService(event.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </label>
        <label className="grid gap-2">
          <span className="text-xs font-medium text-foreground">Version</span>
          <input
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </label>
        <label className="grid gap-2 sm:col-span-2">
          <span className="text-xs font-medium text-foreground">Discovery URL</span>
          <input
            value={discoveryUrl}
            onChange={(event) => setDiscoveryUrl(event.target.value)}
            placeholder={defaultGoogleDiscoveryUrl(service || "sheets", version || "v4")}
            className="h-9 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </label>
      </div>

      <label className="grid gap-2">
        <span className="text-xs font-medium text-foreground">Default Headers</span>
        <textarea
          value={headersText}
          onChange={(event) => setHeadersText(event.target.value)}
          rows={3}
          className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
        />
      </label>

      <label className="grid gap-2">
        <span className="text-xs font-medium text-foreground">Scopes</span>
        <textarea
          value={scopesText}
          onChange={(event) => setScopesText(event.target.value)}
          rows={3}
          placeholder="Leave blank to infer from the discovery document."
          className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
        />
      </label>

      <label className="grid gap-2">
        <span className="text-xs font-medium text-foreground">Auth</span>
        <select
          value={authKind}
          onChange={(event) =>
            setAuthKind(event.target.value as GoogleDiscoveryConnectionAuth["kind"])}
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
        >
          <option value="none">None</option>
          <option value="bearer">Bearer Secret</option>
          <option value="oauth2">Google OAuth</option>
        </select>
      </label>

      {authKind === "bearer" && (
        <div className="border-l-2 border-border pl-4">
          <SecretReferenceField
            label="Secret"
            value={bearerSecretRef}
            emptyLabel="Select a secret"
            draftNamePlaceholder="Google bearer token"
            draftValuePlaceholder="Paste the token value"
            onChange={setBearerSecretRef}
          />
        </div>
      )}

      {authKind === "oauth2" && (
        <div className="space-y-4 border-l-2 border-border pl-4">
          <label className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Client ID</span>
            <input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>
          <SecretReferenceField
            label="Client Secret"
            value={clientSecretRef}
            emptyLabel="Public client / no secret"
            draftNamePlaceholder="Google client secret"
            draftValuePlaceholder="Paste the secret value"
            onChange={setClientSecretRef}
          />
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
                    setError(cause instanceof Error ? cause.message : "Google OAuth failed.");
                    setOauthStatus("idle");
                    return;
                  }
                })();
              }}
              disabled={oauthStatus === "pending"}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50"
            >
              {oauthStatus === "pending"
                ? "Connecting..."
                : oauthStatus === "connected"
                  ? "Reconnect"
                  : "Connect with Google"}
            </button>
            {oauthStatus === "connected" && (
              <span className="text-xs text-primary">Connected</span>
            )}
          </div>
        </div>
      )}

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
                const auth: GoogleDiscoveryConnectionAuth =
                  authKind === "none"
                    ? { kind: "none" }
                    : authKind === "bearer"
                      ? {
                          kind: "bearer",
                          tokenSecretRef: JSON.parse(bearerSecretRef),
                        }
                      : oauthAuth
                        ? oauthAuth
                        : (() => {
                            throw new Error("Complete Google sign-in before saving.");
                          })();

                await submitMutation.mutateAsync({
                  name: name.trim(),
                  service: service.trim(),
                  version: version.trim(),
                  discoveryUrl: discoveryUrl.trim() || null,
                  defaultHeaders: parseStringMap(headersText),
                  scopes: parseScopes(scopesText),
                  auth,
                });
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Failed saving source.",
                );
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

function GoogleDiscoveryBatchConnectPanel(props: {
  onConnected: (sources: ReadonlyArray<{ id: string; name: string }>) => void;
}) {
  const installation = useLocalInstallation();
  const client = getGoogleDiscoveryHttpClient();
  const startBatchOAuth = useAtomSet(
    client.mutation(GOOGLE_DISCOVERY_PLUGIN_KEY, "startBatchOAuth"),
    { mode: "promise" },
  );
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<
    ReadonlyArray<string>
  >([]);
  const [clientId, setClientId] = useState("");
  const [clientSecretRef, setClientSecretRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting">("idle");

  const selectedTemplates = useMemo(
    () =>
      GOOGLE_DISCOVERY_BATCH_TEMPLATES.filter((template) =>
        selectedTemplateIds.includes(template.id)
      ),
    [selectedTemplateIds],
  );

  const toggleTemplate = (templateId: string) => {
    setSelectedTemplateIds((current) =>
      current.includes(templateId)
        ? current.filter((id) => id !== templateId)
        : [...current, templateId]
    );
  };

  const handleConnect = async () => {
    if (installation.status !== "ready") {
      setError("Workspace is still loading.");
      return;
    }
    if (selectedTemplates.length === 0) {
      setError("Select at least one Google API.");
      return;
    }
    if (!clientId.trim()) {
      setError("Client ID is required for batch Google OAuth.");
      return;
    }

    try {
      setError(null);
      setStatus("connecting");
      const popup = openGoogleOauthPopup("executor-google-discovery-batch-oauth");
      if (!popup) {
        throw new Error("Failed opening Google OAuth popup. Allow popups for this site and try again.");
      }

      let started;
      try {
        started = await startBatchOAuth({
          path: {
            workspaceId: installation.data.scopeId,
          },
          payload: {
            sources: selectedTemplates.map(batchSourceInputFromTemplate),
            clientId: clientId.trim(),
            clientSecretRef: clientSecretRef
              ? JSON.parse(clientSecretRef)
              : null,
            clientAuthentication: clientSecretRef ? "client_secret_post" : "none",
            redirectUrl: new URL(
              GOOGLE_DISCOVERY_OAUTH_CALLBACK_PATH,
              window.location.origin,
            ).toString(),
          } satisfies GoogleDiscoveryStartBatchOAuthInput,
        });
      } catch (cause) {
        popup.close();
        throw cause;
      }

      popup.location.replace(started.authorizationUrl);
      popup.focus();

      const result = await waitForOauthPopupResult(started.sessionId);
      if (!result.ok) {
        throw new Error(result.error);
      }
      if (result.mode !== "batch") {
        throw new Error("Unexpected single-source OAuth result for Google batch setup.");
      }

      setSelectedTemplateIds([]);
      props.onConnected(result.sources);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed connecting Google APIs.");
    } finally {
      setStatus("idle");
    }
  };

  return (
    <div className="space-y-6 rounded-xl border border-border p-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Connect multiple Google APIs
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select APIs below and connect them all with a single sign-in.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {selectedTemplates.length === 0
            ? "No Google APIs selected."
            : `${selectedTemplates.length} Google API${selectedTemplates.length === 1 ? "" : "s"} selected.`}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSelectedTemplateIds([])}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() =>
              setSelectedTemplateIds(
                selectedTemplateIds.length === GOOGLE_DISCOVERY_BATCH_TEMPLATES.length
                  ? []
                  : GOOGLE_DISCOVERY_BATCH_TEMPLATES.map((template) => template.id),
              )
            }
            className="inline-flex h-8 items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
          >
            {selectedTemplateIds.length === GOOGLE_DISCOVERY_BATCH_TEMPLATES.length
              ? "Deselect all"
              : "Select all"}
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {GOOGLE_DISCOVERY_BATCH_TEMPLATES.map((template) => {
          const selected = selectedTemplateIds.includes(template.id);
          const iconUrl = getGoogleDiscoveryIconUrlForService(template.service);

          return (
            <button
              key={template.id}
              type="button"
              onClick={() => toggleTemplate(template.id)}
              className={
                selected
                  ? "rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-left transition-colors"
                  : "rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/40"
              }
            >
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {iconUrl
                    ? (
                        <img
                          src={iconUrl}
                          alt=""
                          className="size-5 object-contain"
                        />
                      )
                    : (
                        <span className="text-sm font-semibold text-muted-foreground">
                          {template.name.slice(0, 1)}
                        </span>
                      )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {template.name}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {template.service} {template.version}
                      </div>
                    </div>
                    <div
                      className={
                        selected
                          ? "mt-0.5 size-3 rounded-full bg-primary"
                          : "mt-0.5 size-3 rounded-full border border-border bg-background"
                      }
                    />
                  </div>
                  <div className="mt-2 text-xs leading-5 text-muted-foreground">
                    {template.summary}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 md:col-span-2">
          <span className="text-xs font-medium text-foreground">Client ID</span>
          <input
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="1234567890-abcdef.apps.googleusercontent.com"
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </label>
        <div className="md:col-span-2">
          <SecretReferenceField
            label="Client Secret"
            value={clientSecretRef}
            emptyLabel="Public client / no secret"
            draftNamePlaceholder="Google client secret"
            draftValuePlaceholder="Paste the secret value"
            onChange={setClientSecretRef}
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => {
            void handleConnect();
          }}
          disabled={
            status === "connecting"
            || selectedTemplates.length === 0
            || clientId.trim().length === 0
          }
          className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
        >
          {status === "connecting"
            ? "Connecting..."
            : selectedTemplates.length > 0
              ? `Connect ${selectedTemplates.length} Google API${selectedTemplates.length === 1 ? "" : "s"}`
              : "Connect Google APIs"}
        </button>
      </div>
    </div>
  );
}

export function GoogleDiscoveryAddPage() {
  const navigation = useSourcePluginNavigation();
  const initialValue = googleInputFromSearch(useSourcePluginSearch());
  const installation = useLocalInstallation();
  const client = getGoogleDiscoveryHttpClient();
  const createSource = useAtomSet(
    client.mutation(GOOGLE_DISCOVERY_PLUGIN_KEY, "createSource"),
    { mode: "promise" },
  );

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

  return (
    <div className="space-y-6">
      <GoogleDiscoveryBatchConnectPanel
        onConnected={(sources) => {
          startTransition(() => {
            if (sources.length === 1) {
              void navigation.detail(sources[0]!.id, {
                tab: "model",
              });
              return;
            }

            void navigation.home();
          });
        }}
      />

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <div className="text-xs font-medium text-muted-foreground">
          or add a single API
        </div>
        <div className="h-px flex-1 bg-border" />
      </div>

      <GoogleDiscoverySourceForm
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
  );
}

export function GoogleDiscoveryEditPage(props: {
  source: Source;
}) {
  const navigation = useSourcePluginNavigation();
  const installation = useLocalInstallation();
  const client = getGoogleDiscoveryHttpClient();
  const configResult = useAtomValue(
    installation.status === "ready"
      ? client.query(GOOGLE_DISCOVERY_PLUGIN_KEY, "getSourceConfig", {
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
    client.mutation(GOOGLE_DISCOVERY_PLUGIN_KEY, "updateSource"),
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
    <GoogleDiscoverySourceForm
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

export function GoogleDiscoveryDetailPage(props: {
  source: Source;
}) {
  const navigation = useSourcePluginNavigation();
  const search = parseSourceToolExplorerSearch(
    useSourcePluginSearch(),
  ) satisfies SourceToolExplorerSearch;
  const installation = useLocalInstallation();
  const client = getGoogleDiscoveryHttpClient();
  const removeSource = useAtomSet(
    client.mutation(GOOGLE_DISCOVERY_PLUGIN_KEY, "removeSource"),
    { mode: "promise" },
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const configResult = useAtomValue(
    installation.status === "ready"
      ? client.query(GOOGLE_DISCOVERY_PLUGIN_KEY, "getSourceConfig", {
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
  const summary = useMemo(() => {
    if (!Result.isSuccess(configResult)) {
      return null;
    }

    const config = configResult.value;
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant="muted">{config.service} {config.version}</Badge>
        <div className="font-mono text-foreground">
          {config.discoveryUrl ?? defaultGoogleDiscoveryUrl(config.service, config.version)}
        </div>
      </div>
    );
  }, [configResult]);

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

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

  return (
    <SourceToolExplorer
      sourceId={props.source.id}
      title={props.source.name}
      kind={props.source.kind}
      search={search}
      navigate={(next) => navigation.updateSearch(next)}
      summary={summary}
      actions={(
        <>
          <button
            type="button"
            onClick={() =>
              void navigation.edit(props.source.id)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
          >
            <IconPencil className="size-3.5" />
            Edit
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-destructive">
                Confirm delete?
              </span>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
                className="inline-flex h-9 items-center rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleDelete().catch(() => {});
                }}
                disabled={isDeleting}
                className="inline-flex h-9 items-center rounded-lg border border-destructive/25 bg-destructive/5 px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting}
              className="inline-flex h-9 items-center rounded-lg border border-destructive/25 bg-destructive/5 px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
            >
              Delete
            </button>
          )}
        </>
      )}
    />
  );
}

function GoogleDiscoverySourceRoute(props: {
  children: (source: Source) => ReactNode;
}) {
  const params = useSourcePluginRouteParams<{ sourceId?: string }>();
  const sourceId = typeof params.sourceId === "string" ? params.sourceId : null;
  const source = useSource(sourceId ?? "");

  if (sourceId === null || source.status === "error") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        This Google Discovery source is unavailable.
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

  if (source.data.kind !== GOOGLE_DISCOVERY_SOURCE_KIND) {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        Expected a `{GOOGLE_DISCOVERY_SOURCE_KIND}` source, but received `{source.data.kind}`.
      </div>
    );
  }

  return props.children(source.data);
}

export function GoogleDiscoveryEditRoute() {
  return (
    <GoogleDiscoverySourceRoute>
      {(source) => <GoogleDiscoveryEditPage source={source} />}
    </GoogleDiscoverySourceRoute>
  );
}

export function GoogleDiscoveryDetailRoute() {
  return (
    <GoogleDiscoverySourceRoute>
      {(source) => <GoogleDiscoveryDetailPage source={source} />}
    </GoogleDiscoverySourceRoute>
  );
}
