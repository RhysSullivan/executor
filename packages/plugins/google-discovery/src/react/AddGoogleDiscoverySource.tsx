import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue, useAtomRefresh, Result } from "@effect-atom/atom-react";

import { secretsAtom, setSecret } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { SecretPicker, type SecretPickerSecret } from "@executor/react/plugins/secret-picker";
import { SecretId } from "@executor/sdk";
import { Badge } from "@executor/react/components/badge";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import {
  SourceIdentityFields,
  slugifyNamespace,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@executor/react/components/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@executor/react/components/field";
import { FilterTabs } from "@executor/react/components/filter-tabs";
import { FloatActions } from "@executor/react/components/float-actions";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { RadioGroup, RadioGroupItem } from "@executor/react/components/radio-group";
import { IOSSpinner, Spinner } from "@executor/react/components/spinner";
import { addGoogleDiscoverySource, probeGoogleDiscovery, startGoogleDiscoveryOAuth } from "./atoms";

type GoogleAuthKind = "none" | "oauth2";

// ---------------------------------------------------------------------------
// Inline secret creation
// ---------------------------------------------------------------------------

function InlineCreateSecret(props: {
  headerName: string;
  suggestedId: string;
  onCreated: (secretId: string) => void;
  onCancel: () => void;
}) {
  const [secretId, setSecretIdValue] = useState(props.suggestedId);
  const [secretName, setSecretName] = useState(props.headerName);
  const [secretValue, setSecretValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeId = useScope();
  const doSet = useAtomSet(setSecret, { mode: "promise" });
  const refreshSecrets = useAtomRefresh(secretsAtom(scopeId));

  const handleSave = async () => {
    if (!secretId.trim() || !secretValue.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await doSet({
        path: { scopeId },
        payload: {
          id: SecretId.make(secretId.trim()),
          name: secretName.trim() || secretId.trim(),
          value: secretValue.trim(),
          purpose: `Google OAuth: ${props.headerName}`,
        },
      });
      refreshSecrets();
      props.onCreated(secretId.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save secret");
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.02] p-3 space-y-2.5">
      <p className="text-[11px] font-semibold text-primary tracking-wide uppercase">New secret</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">ID</Label>
          <Input
            value={secretId}
            onChange={(e) => setSecretIdValue((e.target as HTMLInputElement).value)}
            placeholder="google-client-secret"
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Label
          </Label>
          <Input
            value={secretName}
            onChange={(e) => setSecretName((e.target as HTMLInputElement).value)}
            placeholder="Client Secret"
            className="h-8 text-xs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Value</Label>
        <Input
          type="password"
          value={secretValue}
          onChange={(e) => setSecretValue((e.target as HTMLInputElement).value)}
          placeholder="paste your client secret…"
          className="h-8 text-xs font-mono"
        />
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex gap-1.5 pt-0.5">
        <Button variant="outline" size="xs" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={handleSave}
          disabled={!secretId.trim() || !secretValue.trim() || saving}
        >
          {saving ? "Saving…" : "Create & use"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client secret field with inline creation
// ---------------------------------------------------------------------------

function SecretBackedField(props: {
  label: string;
  suggestedSecretId: string;
  headerName: string;
  secretId: string | null;
  onSelect: (secretId: string | null) => void;
  secretList: readonly SecretPickerSecret[];
  placeholder: string;
  clearable?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const { label, secretId, onSelect, secretList, placeholder, clearable = true } = props;

  if (creating) {
    return (
      <div className="space-y-2">
        <Label>{label}</Label>
        <InlineCreateSecret
          headerName={props.headerName}
          suggestedId={props.suggestedSecretId}
          onCreated={(id) => {
            onSelect(id);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <SecretPicker
            value={secretId}
            onSelect={onSelect}
            secrets={secretList}
            placeholder={placeholder}
          />
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setCreating(true)}>
          + New
        </Button>
        {clearable && secretId && (
          <Button variant="outline" onClick={() => onSelect(null)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

type GoogleDiscoveryTemplate = {
  id: string;
  name: string;
  summary: string;
  service: string;
  version: string;
  discoveryUrl: string;
};

const defaultGoogleDiscoveryUrl = (service: string, version: string): string =>
  `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;

const googleDiscoveryTemplate = (template: GoogleDiscoveryTemplate): GoogleDiscoveryTemplate => ({
  ...template,
  discoveryUrl:
    template.discoveryUrl || defaultGoogleDiscoveryUrl(template.service, template.version),
});

const GOOGLE_DISCOVERY_TEMPLATES: readonly GoogleDiscoveryTemplate[] = [
  googleDiscoveryTemplate({
    id: "google-calendar",
    name: "Google Calendar",
    summary: "Calendars, events, ACLs, and scheduling workflows.",
    service: "calendar",
    version: "v3",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
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
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
  }),
  googleDiscoveryTemplate({
    id: "google-docs",
    name: "Google Docs",
    summary: "Documents, structural edits, text ranges, and formatting.",
    service: "docs",
    version: "v1",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/docs/v1/rest",
  }),
  googleDiscoveryTemplate({
    id: "google-sheets",
    name: "Google Sheets",
    summary: "Spreadsheets, values, ranges, formatting, and batch updates.",
    service: "sheets",
    version: "v4",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
  }),
  googleDiscoveryTemplate({
    id: "google-slides",
    name: "Google Slides",
    summary: "Presentations, slides, page elements, and deck updates.",
    service: "slides",
    version: "v1",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/slides/v1/rest",
  }),
  googleDiscoveryTemplate({
    id: "google-forms",
    name: "Google Forms",
    summary: "Forms, questions, responses, quizzes, and form metadata.",
    service: "forms",
    version: "v1",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/forms/v1/rest",
  }),
  googleDiscoveryTemplate({
    id: "google-people",
    name: "Google People",
    summary: "Contacts, profiles, directory people, and contact groups.",
    service: "people",
    version: "v1",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/people/v1/rest",
  }),
  googleDiscoveryTemplate({
    id: "google-tasks",
    name: "Google Tasks",
    summary: "Task lists, task items, notes, and due dates.",
    service: "tasks",
    version: "v1",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest",
  }),
  googleDiscoveryTemplate({
    id: "google-chat",
    name: "Google Chat",
    summary: "Spaces, messages, members, reactions, and chat workflows.",
    service: "chat",
    version: "v1",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/chat/v1/rest",
  }),
  googleDiscoveryTemplate({
    id: "google-bigquery",
    name: "Google BigQuery",
    summary: "Datasets, tables, jobs, routines, and analytics workflows.",
    service: "bigquery",
    version: "v2",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/bigquery/v2/rest",
  }),
  googleDiscoveryTemplate({
    id: "google-youtube",
    name: "YouTube Data",
    summary: "Channels, playlists, videos, comments, captions, and uploads.",
    service: "youtube",
    version: "v3",
    discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest",
  }),
];

const GOOGLE_SERVICE_ICON_URLS: Record<string, string> = {
  calendar: "https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v8/192px.svg",
  drive: "https://fonts.gstatic.com/s/i/productlogos/drive_2020q4/v8/192px.svg",
  gmail:
    "https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v8/web-96dp/logo_gmail_2020q4_color_2x_web_96dp.png",
  docs: "https://fonts.gstatic.com/s/i/productlogos/docs_2020q4/v12/192px.svg",
  sheets: "https://fonts.gstatic.com/s/i/productlogos/sheets_2020q4/v8/192px.svg",
  slides: "https://fonts.gstatic.com/s/i/productlogos/slides_2020q4/v12/192px.svg",
  forms: "https://fonts.gstatic.com/s/i/productlogos/forms_2020q4/v6/192px.svg",
  people: "https://fonts.gstatic.com/s/i/productlogos/contacts/v9/192px.svg",
  tasks: "https://fonts.gstatic.com/s/i/productlogos/tasks/v10/192px.svg",
  chat: "https://fonts.gstatic.com/s/i/productlogos/chat_2020q4/v8/192px.svg",
  bigquery: "https://fonts.gstatic.com/s/i/productlogos/cloud/v8/192px.svg",
  youtube: "https://fonts.gstatic.com/s/i/productlogos/youtube/v9/192px.svg",
};

function GoogleServiceIcon(props: { readonly service: string; readonly className?: string }) {
  const { service, className = "size-11" } = props;
  const src = GOOGLE_SERVICE_ICON_URLS[service] ?? GOOGLE_SERVICE_ICON_URLS.bigquery;

  return (
    <img
      alt=""
      aria-hidden="true"
      className={`${className} shrink-0 object-contain`}
      decoding="async"
      draggable={false}
      loading="lazy"
      src={src}
    />
  );
}

type ProbeOperation = {
  toolPath: string;
  method: string;
  pathTemplate: string;
  description: string | null;
};

type ProbeResult = {
  name: string;
  title: string | null;
  service: string;
  version: string;
  toolCount: number;
  scopes: readonly string[];
  operations: readonly ProbeOperation[];
};

type OAuthAuth = {
  kind: "oauth2";
  clientIdSecretId: string;
  clientSecretSecretId: string | null;
  accessTokenSecretId: string;
  refreshTokenSecretId: string | null;
  tokenType: string;
  expiresAt: number | null;
  scope: string | null;
  scopes: string[];
};

type OAuthPopupResult =
  | ({
      type: "executor:oauth-result";
      ok: true;
      sessionId: string;
    } & OAuthAuth)
  | {
      type: "executor:oauth-result";
      ok: false;
      sessionId: null;
      error: string;
    };

const OAUTH_RESULT_CHANNEL = "executor:google-discovery-oauth-result";

const isOAuthPopupResult = (value: unknown): value is OAuthPopupResult =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "executor:oauth-result";

function openOAuthPopup(
  url: string,
  onResult: (data: OAuthPopupResult) => void,
  onOpenFailed?: () => void,
): () => void {
  const w = 640;
  const h = 760;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;

  let settled = false;
  const channel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(OAUTH_RESULT_CHANNEL) : null;
  const settle = () => {
    if (settled) return;
    settled = true;
    window.removeEventListener("message", onMessage);
    channel?.close();
  };

  const handleResult = (data: unknown) => {
    if (!isOAuthPopupResult(data) || settled) return;
    settle();
    onResult(data);
  };

  const onMessage = (event: MessageEvent) => {
    if (event.origin === window.location.origin) handleResult(event.data);
  };
  window.addEventListener("message", onMessage);
  if (channel) channel.onmessage = (event) => handleResult(event.data);

  const popup = window.open(
    url,
    "google-discovery-oauth",
    `width=${w},height=${h},left=${left},top=${top},popup=1`,
  );
  if (!popup && !settled) {
    settle();
    queueMicrotask(() => onOpenFailed?.());
  }
  return settle;
}

export default function AddGoogleDiscoverySource(props: {
  readonly onComplete: () => void;
  readonly onCancel: () => void;
  readonly initialUrl?: string;
}) {
  const defaultTemplate =
    GOOGLE_DISCOVERY_TEMPLATES.find((template) => template.id === "google-sheets") ??
    GOOGLE_DISCOVERY_TEMPLATES[0]!;
  const [discoveryUrl, setDiscoveryUrl] = useState(
    props.initialUrl ?? defaultTemplate.discoveryUrl,
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    props.initialUrl ? "" : defaultTemplate.id,
  );
  const selectedTemplate =
    GOOGLE_DISCOVERY_TEMPLATES.find((template) => template.id === selectedTemplateId) ?? null;
  const [authKind, setAuthKind] = useState<GoogleAuthKind>("oauth2");
  const [clientIdSecretId, setClientIdSecretId] = useState<string | null>(null);
  const [clientSecretSecretId, setClientSecretSecretId] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const identity = useSourceIdentity({
    fallbackName: probe?.name ?? selectedTemplate?.name ?? "",
  });
  const [oauthAuth, setOauthAuth] = useState<OAuthAuth | null>(null);
  const [loadingProbe, setLoadingProbe] = useState(false);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScopes, setShowScopes] = useState(false);

  const scopeId = useScope();
  const doProbe = useAtomSet(probeGoogleDiscovery, { mode: "promise" });
  const doAdd = useAtomSet(addGoogleDiscoverySource, { mode: "promise" });
  const doStartOAuth = useAtomSet(startGoogleDiscoveryOAuth, { mode: "promise" });
  const secrets = useAtomValue(secretsAtom(scopeId));

  const canUseOAuth = useMemo(() => (probe?.scopes.length ?? 0) > 0, [probe]);
  const secretList: readonly SecretPickerSecret[] = Result.match(secrets, {
    onInitial: () => [] as SecretPickerSecret[],
    onFailure: () => [] as SecretPickerSecret[],
    onSuccess: ({ value }) =>
      value.map((secret) => ({
        id: secret.id,
        name: secret.name,
        provider: secret.provider ? String(secret.provider) : undefined,
      })),
  });

  const applyTemplate = useCallback(
    (template: GoogleDiscoveryTemplate) => {
      setSelectedTemplateId(template.id);
      setDiscoveryUrl(template.discoveryUrl);
      identity.reset();
      setClientSecretSecretId(null);
      setProbe(null);
      setOauthAuth(null);
      setError(null);
      setShowScopes(false);
      setAuthKind("oauth2");
    },
    [identity],
  );

  const handleProbe = useCallback(async () => {
    setLoadingProbe(true);
    setError(null);
    setOauthAuth(null);
    setShowScopes(false);
    try {
      const result = await doProbe({
        path: { scopeId },
        payload: { discoveryUrl: discoveryUrl.trim() },
      });
      setProbe({
        ...result,
        scopes: [...result.scopes],
        operations: [...result.operations],
      });
      if (result.scopes.length === 0) {
        setAuthKind("none");
      }
    } catch (e) {
      setProbe(null);
      setError(e instanceof Error ? e.message : "Failed to inspect discovery document");
    } finally {
      setLoadingProbe(false);
    }
  }, [discoveryUrl, doProbe, scopeId]);

  // Keep the latest handleProbe in a ref so the debounced effect can call it
  // without depending on its identity (which changes every render).
  const handleProbeRef = useRef(handleProbe);
  handleProbeRef.current = handleProbe;

  // Auto-probe whenever the discovery URL changes (debounced). Clearing the
  // previous probe in the onChange handler resets the preview so a new run
  // will be triggered.
  useEffect(() => {
    const trimmed = discoveryUrl.trim();
    if (!trimmed) return;
    if (probe) return;
    const handle = setTimeout(() => {
      handleProbeRef.current();
    }, 400);
    return () => clearTimeout(handle);
  }, [discoveryUrl, probe]);

  const oauthCleanup = useRef<(() => void) | null>(null);

  const handleStartOAuth = useCallback(async () => {
    if (!probe || !clientIdSecretId) return;
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setStartingOAuth(true);
    setError(null);
    try {
      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          name: identity.name.trim() || probe.name,
          discoveryUrl: discoveryUrl.trim(),
          clientIdSecretId,
          clientSecretSecretId,
          redirectUrl: `${window.location.origin}/api/google-discovery/oauth/callback`,
          scopes: probe.scopes,
        },
      });

      oauthCleanup.current = openOAuthPopup(
        response.authorizationUrl,
        (result) => {
          oauthCleanup.current = null;
          setStartingOAuth(false);
          if (result.ok) {
            setOauthAuth({
              kind: "oauth2",
              clientIdSecretId: result.clientIdSecretId,
              clientSecretSecretId: result.clientSecretSecretId,
              accessTokenSecretId: result.accessTokenSecretId,
              refreshTokenSecretId: result.refreshTokenSecretId,
              tokenType: result.tokenType,
              expiresAt: result.expiresAt,
              scope: result.scope,
              scopes: [...result.scopes],
            });
            setError(null);
          } else {
            setError(result.error);
          }
        },
        () => {
          oauthCleanup.current = null;
          setStartingOAuth(false);
          setError("OAuth popup was blocked");
        },
      );
    } catch (e) {
      setStartingOAuth(false);
      setError(e instanceof Error ? e.message : "Failed to start OAuth");
    }
  }, [probe, doStartOAuth, scopeId, identity, discoveryUrl, clientIdSecretId, clientSecretSecretId]);

  const handleCancelOAuth = useCallback(() => {
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setStartingOAuth(false);
  }, []);

  const handleAdd = useCallback(async () => {
    if (!probe) return;
    setAdding(true);
    setError(null);
    try {
      await doAdd({
        path: { scopeId },
        payload: {
          name: identity.name.trim() || probe.name,
          discoveryUrl: discoveryUrl.trim(),
          namespace: slugifyNamespace(identity.namespace) || undefined,
          auth:
            authKind === "oauth2"
              ? (oauthAuth ?? { kind: "none" as const })
              : { kind: "none" as const },
        },
      });
      props.onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    }
  }, [probe, doAdd, identity, discoveryUrl, authKind, oauthAuth, props, scopeId]);

  const addDisabled =
    !probe || adding || (authKind === "oauth2" && (!canUseOAuth || oauthAuth === null));

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add Google Discovery Source</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Connect a Google API from its Discovery document and register its methods as tools.
        </p>
      </div>

      <FieldGroup>
        <FieldSet>
          <FieldLegend variant="label">Presets</FieldLegend>
          <FieldDescription>Select a Google API to prefill the source.</FieldDescription>
          <RadioGroup
            value={selectedTemplateId}
            onValueChange={(value) => {
              const template = GOOGLE_DISCOVERY_TEMPLATES.find((t) => t.id === value);
              if (template) applyTemplate(template);
            }}
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            {GOOGLE_DISCOVERY_TEMPLATES.map((template) => {
              const inputId = `google-discovery-preset-${template.id}`;
              return (
                <FieldLabel key={template.id} htmlFor={inputId}>
                  <Field orientation="horizontal">
                    <GoogleServiceIcon service={template.service} className="size-8" />
                    <FieldContent>
                      <FieldTitle>{template.name}</FieldTitle>
                      <FieldDescription className="line-clamp-2">
                        {template.summary}
                      </FieldDescription>
                    </FieldContent>
                    <RadioGroupItem id={inputId} value={template.id} />
                  </Field>
                </FieldLabel>
              );
            })}
          </RadioGroup>
        </FieldSet>
      </FieldGroup>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Discovery URL">
            <div className="relative">
              <Input
                value={discoveryUrl}
                onChange={(e) => {
                  setSelectedTemplateId("");
                  setDiscoveryUrl((e.target as HTMLInputElement).value);
                  setProbe(null);
                  setOauthAuth(null);
                  setError(null);
                }}
                placeholder="https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest"
                className="w-full pr-9 font-mono text-sm"
              />
              {loadingProbe && (
                <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                  <IOSSpinner className="size-4" />
                </div>
              )}
            </div>
          </CardStackEntryField>

        </CardStackContent>
      </CardStack>

      <SourceIdentityFields
        identity={identity}
        namePlaceholder="Google Sheets"
        namespacePlaceholder="google_sheets"
      />

      {probe && (
        <section className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background/80 shadow-xs">
                <GoogleServiceIcon
                  service={selectedTemplate?.service ?? probe.service}
                  className="size-5"
                />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{probe.title ?? probe.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {probe.service} · {probe.version}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Badge variant="secondary">{probe.toolCount} tools</Badge>
              <Badge variant="outline">{probe.scopes.length} scopes</Badge>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Authentication</FieldLabel>
          <FilterTabs<GoogleAuthKind>
            tabs={[
              { value: "none", label: "None" },
              { value: "oauth2", label: "OAuth" },
            ]}
            value={authKind}
            onChange={setAuthKind}
          />
        </div>

        {authKind === "oauth2" && (
          <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
            <SecretBackedField
              label="OAuth Client ID"
              headerName="Client ID"
              suggestedSecretId="google-oauth-client-id"
              secretId={clientIdSecretId}
              onSelect={setClientIdSecretId}
              secretList={secretList}
              placeholder="Pick or create a secret"
              clearable={false}
            />
            <SecretBackedField
              label="OAuth Client Secret"
              headerName="Client Secret"
              suggestedSecretId="google-oauth-client-secret"
              secretId={clientSecretSecretId}
              onSelect={setClientSecretSecretId}
              secretList={secretList}
              placeholder="Optional for confidential clients"
            />
            <Collapsible open={showScopes} onOpenChange={setShowScopes} className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {canUseOAuth
                      ? `${probe?.scopes.length ?? 0} scopes will be requested from Google.`
                      : "This API does not advertise OAuth scopes."}
                  </p>
                  {canUseOAuth && (probe?.scopes.length ?? 0) > 0 && (
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="link"
                        type="button"
                        className="h-auto p-0 text-xs font-medium text-primary hover:underline"
                      >
                        {showScopes ? "Hide scopes" : "View scopes"}
                      </Button>
                    </CollapsibleTrigger>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={handleStartOAuth}
                    disabled={!probe || !clientIdSecretId || !canUseOAuth || startingOAuth}
                  >
                    {startingOAuth ? (
                      <>
                        <Spinner className="size-3.5" /> Waiting…
                      </>
                    ) : oauthAuth ? (
                      "Re-authenticate"
                    ) : (
                      "Connect Google"
                    )}
                  </Button>
                  {startingOAuth && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCancelOAuth}
                      className="h-8 px-2 text-xs"
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
              <CollapsibleContent>
                <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
                  <ul className="space-y-1">
                    {(probe?.scopes ?? []).map((scope) => (
                      <li
                        key={scope}
                        className="break-all font-mono text-[11px] text-muted-foreground"
                      >
                        {scope}
                      </li>
                    ))}
                  </ul>
                </div>
              </CollapsibleContent>
            </Collapsible>
            {oauthAuth && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                Connected. Access token stored as secret `{oauthAuth.accessTokenSecretId}`.
              </div>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={addDisabled}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding…" : "Add Source"}
        </Button>
      </FloatActions>
    </div>
  );
}
