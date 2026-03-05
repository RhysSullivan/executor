"use client";

import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import type { SourceCredentialBinding, SourceId } from "@executor-v2/schema";

import { useWorkspace } from "../../lib/hooks/use-workspace";
import {
  credentialBindingsByWorkspace,
  optimisticRemoveSources,
  optimisticSourcesByWorkspace,
  optimisticUpsertSources,
  removeSource,
  sourcesByWorkspace,
  sourcesPendingByWorkspace,
  toCredentialBindingUpsertRequest,
  toCredentialBindingUpsertPayload,
  toRemoveSourceRequest,
  toUpsertSourceRequest,
  upsertCredentialBinding,
  upsertSource,
} from "../../lib/control-plane/atoms";
import {
  formStateFromSource,
  sourceToLegacyRecord,
  upsertPayloadFromForm,
  type LegacySourceFormState,
  type LegacySourceType,
  type LegacyToolSourceRecord,
} from "../../lib/control-plane/legacy-source";
import {
  startMcpOAuthPopup,
  type McpOAuthPopupSuccess,
} from "../../lib/mcp/oauth-popup";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { cn, createLocalId } from "../../lib/utils";
import { SourceFavicon } from "./source-favicon";
import { StatusMessage } from "../shared/status-message";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const kindOptions: ReadonlyArray<LegacySourceType> = ["openapi", "mcp", "graphql"];

type CatalogTemplate = {
  id: string;
  name: string;
  summary: string;
  providerName: string;
  type: LegacySourceType;
  endpoint: string;
  /** Override favicon lookup when the endpoint hostname doesn't match the provider (e.g. raw GitHub URLs). */
  faviconUrl?: string;
};

// ---------------------------------------------------------------------------
// Catalog data
// ---------------------------------------------------------------------------

const catalogTemplates: ReadonlyArray<CatalogTemplate> = [
  {
    id: "deepwiki-mcp",
    name: "DeepWiki MCP",
    summary: "Read repository docs and ask questions through DeepWiki via MCP.",
    providerName: "DeepWiki",
    type: "mcp",
    endpoint: "https://mcp.deepwiki.com/mcp",
  },
  {
    id: "beeper-mcp",
    name: "Beeper MCP",
    summary: "Connect to your local Beeper Desktop MCP endpoint for chats, messages, and contacts.",
    providerName: "Beeper",
    type: "mcp",
    endpoint: "http://localhost:23373/v0/mcp",
  },
  {
    id: "neon-mcp",
    name: "Neon MCP",
    summary: "Create and manage Postgres branches, projects, and roles with Neon MCP tools.",
    providerName: "Neon",
    type: "mcp",
    endpoint: "https://mcp.neon.tech/mcp",
  },
  {
    id: "axiom-mcp",
    name: "Axiom MCP",
    summary: "Query, analyze, and monitor your Axiom datasets and logs via MCP.",
    providerName: "Axiom",
    type: "mcp",
    endpoint: "https://mcp.axiom.co/mcp",
  },
  {
    id: "neon-openapi",
    name: "Neon API",
    summary: "Manage Neon projects, branches, and organization resources via REST API.",
    providerName: "Neon",
    type: "openapi",
    endpoint: "https://neon.com/api_spec/release/v2.json",
  },
  {
    id: "linear-graphql",
    name: "Linear GraphQL",
    summary: "Query issues, teams, and workflow data from Linear's GraphQL API.",
    providerName: "Linear",
    type: "graphql",
    endpoint: "https://api.linear.app/graphql",
  },
  {
    id: "github-rest",
    name: "GitHub REST API",
    summary: "Manage repositories, pull requests, issues, and org settings.",
    providerName: "GitHub",
    type: "openapi",
    endpoint:
      "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml",
  },
  {
    id: "stripe-api",
    name: "Stripe API",
    summary: "Create payments, manage customers, and handle billing workflows.",
    providerName: "Stripe",
    type: "openapi",
    endpoint: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    faviconUrl: "https://stripe.com",
  },
  {
    id: "openai-api",
    name: "OpenAI API",
    summary: "Generate text, run reasoning models, and process multimodal inputs.",
    providerName: "OpenAI",
    type: "openapi",
    endpoint: "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml",
    faviconUrl: "https://openai.com",
  },
  {
    id: "cloudflare-api",
    name: "Cloudflare API",
    summary: "Control zones, DNS records, workers, and edge configuration.",
    providerName: "Cloudflare",
    type: "openapi",
    endpoint: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml",
    faviconUrl: "https://cloudflare.com",
  },
  {
    id: "vercel-api",
    name: "Vercel API",
    summary: "Manage deployments, projects, domains, and team resources.",
    providerName: "Vercel",
    type: "openapi",
    endpoint: "https://openapi.vercel.sh",
  },
  {
    id: "slack-api",
    name: "Slack API",
    summary: "Work with channels, messages, users, and workspace automation.",
    providerName: "Slack",
    type: "openapi",
    endpoint: "https://api.slack.com/specs/openapi/v2/slack_web.json",
  },
  {
    id: "sentry-api",
    name: "Sentry API",
    summary: "Query issues, releases, projects, and alerting configuration.",
    providerName: "Sentry",
    type: "openapi",
    endpoint:
      "https://raw.githubusercontent.com/getsentry/sentry-api-schema/refs/heads/main/openapi-derefed.json",
    faviconUrl: "https://sentry.io",
  },
  {
    id: "jira-cloud-api",
    name: "Jira Cloud Platform",
    summary: "Manage projects, issues, workflows, and Jira metadata.",
    providerName: "Atlassian",
    type: "openapi",
    endpoint: "https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json",
  },
  {
    id: "kubernetes-api",
    name: "Kubernetes API",
    summary: "Manage pods, deployments, services, and cluster resources.",
    providerName: "Kubernetes",
    type: "openapi",
    endpoint:
      "https://raw.githubusercontent.com/kubernetes/kubernetes/master/api/openapi-spec/swagger.json",
    faviconUrl: "https://kubernetes.io",
  },
  {
    id: "square-api",
    name: "Square API",
    summary: "Process payments, manage inventory, customers, and merchant operations.",
    providerName: "Square",
    type: "openapi",
    endpoint:
      "https://raw.githubusercontent.com/square/connect-api-specification/master/api.json",
    faviconUrl: "https://squareup.com",
  },
  {
    id: "twilio-api",
    name: "Twilio API",
    summary: "Send SMS, make calls, and manage communication workflows.",
    providerName: "Twilio",
    type: "openapi",
    endpoint:
      "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json",
    faviconUrl: "https://twilio.com",
  },
  {
    id: "box-api",
    name: "Box Platform API",
    summary: "Manage files, folders, collaborations, and enterprise content workflows.",
    providerName: "Box",
    type: "openapi",
    endpoint:
      "https://raw.githubusercontent.com/box/box-openapi/main/openapi.json",
    faviconUrl: "https://box.com",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultFormState = (): LegacySourceFormState => ({
  name: "",
  type: "openapi",
  endpoint: "",
  baseUrl: "",
  mcpTransport: "auto",
  authType: "none",
  authMode: "workspace",
  apiKeyHeader: "Authorization",
  enabled: true,
});

type McpOAuthDetectionState = {
  status: "idle" | "checking" | "oauth" | "none" | "error";
  detail: string;
  authorizationServers: ReadonlyArray<string>;
};

const defaultMcpOAuthDetectionState = (): McpOAuthDetectionState => ({
  status: "idle",
  detail: "",
  authorizationServers: [],
});

const normalizeEndpoint = (value: string): string => value.trim();

const TYPE_COLORS: Record<LegacySourceType, { bg: string; text: string; dot: string }> = {
  mcp: { bg: "bg-violet-500/8 dark:bg-violet-400/10", text: "text-violet-700 dark:text-violet-300", dot: "bg-violet-500" },
  openapi: { bg: "bg-emerald-500/8 dark:bg-emerald-400/10", text: "text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  graphql: { bg: "bg-pink-500/8 dark:bg-pink-400/10", text: "text-pink-700 dark:text-pink-300", dot: "bg-pink-500" },
};

// ---------------------------------------------------------------------------
// Panel props
// ---------------------------------------------------------------------------

type SourceManagementPanelProps = {
  /** Pre-populate with an existing source for editing */
  editSource?: LegacyToolSourceRecord;
  /** Called after source is saved or when user cancels edit */
  onDone?: () => void;
};

// ---------------------------------------------------------------------------
// SourceManagementPanel — two views: catalog (default) | form
// ---------------------------------------------------------------------------

export function SourceManagementPanel({ editSource, onDone }: SourceManagementPanelProps) {
  const { workspaceId } = useWorkspace();

  // --- Atoms ---
  const sources = useAtomValue(sourcesByWorkspace(workspaceId));
  const sourcesPending = useAtomValue(sourcesPendingByWorkspace(workspaceId));
  const credentialBindings = useAtomValue(credentialBindingsByWorkspace(workspaceId));
  const setOptimisticSources = useAtomSet(optimisticSourcesByWorkspace(workspaceId));
  const runUpsertSource = useAtomSet(upsertSource, { mode: "promise" });
  const runUpsertCredentialBinding = useAtomSet(upsertCredentialBinding, { mode: "promise" });
  const runRemoveSource = useAtomSet(removeSource, { mode: "promise" });

  // --- View state ---
  type View = "catalog" | "form";
  const [view, setView] = useState<View>(editSource ? "form" : "catalog");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [customUrlInput, setCustomUrlInput] = useState("");
  const urlInputRef = useRef<HTMLInputElement>(null);

  // --- Form state ---
  const [formState, setFormState] = useState<LegacySourceFormState>(
    () => editSource ? formStateFromSource(editSource) : defaultFormState(),
  );
  const [statusText, setStatusText] = useState<string | null>(null);
  const [mcpOAuthDetection, setMcpOAuthDetection] = useState<McpOAuthDetectionState>(
    () => defaultMcpOAuthDetectionState(),
  );
  const [mcpOAuthBusy, setMcpOAuthBusy] = useState(false);
  const [mcpOAuthSession, setMcpOAuthSession] = useState<McpOAuthPopupSuccess | null>(null);

  // Reset when editSource changes
  useEffect(() => {
    if (editSource) {
      setFormState(formStateFromSource(editSource));
      setView("form");
      setStatusText(null);
    }
  }, [editSource]);

  const isEditing = Boolean(formState.id);

  // --- Catalog filtering ---
  const filteredCatalog = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    if (q.length === 0) return catalogTemplates;
    return catalogTemplates.filter((t) =>
      t.name.toLowerCase().includes(q)
      || t.providerName.toLowerCase().includes(q)
      || t.type.includes(q)
      || t.summary.toLowerCase().includes(q),
    );
  }, [catalogSearch]);

  // --- OAuth ---
  const existingMcpOAuthCredential = useMemo(() => {
    if (!formState.id) return null;
    const sourceKey = `source:${formState.id}`;
    return credentialBindings.items.find(
      (b) => b.sourceKey === sourceKey && b.provider === "oauth2",
    ) ?? null;
  }, [credentialBindings.items, formState.id]);

  const mcpOAuthSessionMatchesEndpoint = Boolean(
    mcpOAuthSession
    && normalizeEndpoint(mcpOAuthSession.sourceUrl) === normalizeEndpoint(formState.endpoint),
  );
  const mcpOAuthConnected = formState.type === "mcp"
    && (mcpOAuthSessionMatchesEndpoint || Boolean(existingMcpOAuthCredential));
  const mcpOAuthCanConnect = formState.type === "mcp" && mcpOAuthDetection.status === "oauth";

  // --- Form helpers ---
  const setFormField = <K extends keyof LegacySourceFormState>(key: K, value: LegacySourceFormState[K]) => {
    setFormState((c) => ({ ...c, [key]: value }));
  };

  const resetForm = () => {
    setFormState(defaultFormState());
    setMcpOAuthDetection(defaultMcpOAuthDetectionState());
    setMcpOAuthSession(null);
    setMcpOAuthBusy(false);
    setStatusText(null);
  };

  // MCP OAuth detection
  useEffect(() => {
    const endpoint = normalizeEndpoint(formState.endpoint);
    if (formState.type !== "mcp" || endpoint.length === 0) {
      setMcpOAuthDetection(defaultMcpOAuthDetectionState());
      return;
    }
    const controller = new AbortController();
    setMcpOAuthDetection({ status: "checking", detail: "Checking for OAuth support...", authorizationServers: [] });

    void fetch(`/mcp/oauth/detect?sourceUrl=${encodeURIComponent(endpoint)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        const payload = (await res.json().catch(() => null)) as { oauth?: unknown; authorizationServers?: unknown; detail?: unknown } | null;
        if (controller.signal.aborted) return;
        const oauth = payload?.oauth === true;
        const authorizationServers = Array.isArray(payload?.authorizationServers)
          ? payload.authorizationServers.filter((e): e is string => typeof e === "string").map((e) => e.trim()).filter((e) => e.length > 0)
          : [];
        const detail = typeof payload?.detail === "string" ? payload.detail.trim() : "";
        if (!res.ok) {
          setMcpOAuthDetection({ status: "error", detail: detail || `OAuth detection failed (${res.status})`, authorizationServers });
          return;
        }
        setMcpOAuthDetection({ status: oauth ? "oauth" : "none", detail, authorizationServers });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setMcpOAuthDetection({ status: "error", detail: err instanceof Error ? err.message : "OAuth detection failed", authorizationServers: [] });
      });
    return () => { controller.abort(); };
  }, [formState.endpoint, formState.type]);

  useEffect(() => {
    if (mcpOAuthSession && normalizeEndpoint(mcpOAuthSession.sourceUrl) !== normalizeEndpoint(formState.endpoint)) {
      setMcpOAuthSession(null);
    }
  }, [formState.endpoint, mcpOAuthSession]);

  // --- Handlers ---
  const handleMcpOAuthConnect = () => {
    const endpoint = normalizeEndpoint(formState.endpoint);
    if (endpoint.length === 0 || mcpOAuthBusy) return;
    setMcpOAuthBusy(true);
    void startMcpOAuthPopup(endpoint)
      .then((result) => {
        setMcpOAuthSession(result);
        setFormField("authType", "bearer");
        setFormField("authMode", "workspace");
        setStatusText("OAuth connected. Save source to persist credentials.");
      })
      .catch((err) => { setStatusText(err instanceof Error ? err.message : "OAuth connection failed."); })
      .finally(() => { setMcpOAuthBusy(false); });
  };

  const handleSelectTemplate = useCallback((template: CatalogTemplate) => {
    setMcpOAuthSession(null);
    setMcpOAuthBusy(false);
    setFormState({
      ...defaultFormState(),
      name: template.name,
      type: template.type,
      endpoint: template.endpoint,
    });
    setStatusText(null);
    setView("form");
  }, []);

  const handleCustomUrl = useCallback((e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const url = customUrlInput.trim();
    if (url.length === 0) return;

    // Auto-detect type from URL
    let type: LegacySourceType = "openapi";
    if (url.includes("/mcp") || url.endsWith("/mcp")) type = "mcp";
    else if (url.includes("graphql")) type = "graphql";

    setFormState({
      ...defaultFormState(),
      endpoint: url,
      type,
    });
    setStatusText(null);
    setView("form");
  }, [customUrlInput]);

  const handleBackToCatalog = useCallback(() => {
    resetForm();
    setCustomUrlInput("");
    setView("catalog");
  }, []);

  const handleUpsertSource = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sourcesPending) return;
    if (formState.name.trim().length === 0 || formState.endpoint.trim().length === 0) {
      setStatusText("Name and endpoint are required.");
      return;
    }

    const sourceId = formState.id ?? (createLocalId("src_") as SourceId);
    const payload = upsertPayloadFromForm({ workspaceId, form: formState, sourceId });
    const previousSources = sources.items;
    const optimistic = optimisticUpsertSources(previousSources, workspaceId, payload);
    const endpoint = normalizeEndpoint(formState.endpoint);
    const oauthSessionForEndpoint =
      formState.type === "mcp" && mcpOAuthSession && normalizeEndpoint(mcpOAuthSession.sourceUrl) === endpoint
        ? mcpOAuthSession : null;

    setOptimisticSources({ items: optimistic.items, pendingAck: { kind: "upsert", sourceId: optimistic.sourceId } });

    void runUpsertSource(toUpsertSourceRequest({ workspaceId, payload }))
      .then(async () => {
        let oauthLinked = false;
        let oauthLinkNote: string | null = null;

        if (formState.type === "mcp" && oauthSessionForEndpoint) {
          const sourceKey = `source:${sourceId}`;
          const existingBinding = credentialBindings.items.find(
            (b) => b.sourceKey === sourceKey && b.provider === "oauth2",
          ) ?? null;
          const scopeType = formState.authMode === "organization" ? "organization" : "workspace";
          if (formState.authMode === "account") {
            oauthLinkNote = "Account scope is not supported from this flow; OAuth credential was saved as workspace scope.";
          }
          const oauthExpiresAt =
            typeof oauthSessionForEndpoint.expiresIn === "number"
              ? Date.now() + Math.max(0, Math.floor(oauthSessionForEndpoint.expiresIn)) * 1000
              : null;
          const oauthAuthorizationServer =
            mcpOAuthDetection.authorizationServers[0] ?? null;
          try {
            await runUpsertCredentialBinding(
              toCredentialBindingUpsertRequest({
                workspaceId,
                payload: toCredentialBindingUpsertPayload({
                  ...(existingBinding ? { id: existingBinding.id } : {}),
                  credentialId: (existingBinding?.credentialId ?? createLocalId("conn_")) as SourceCredentialBinding["credentialId"],
                  scopeType,
                  sourceKey,
                  provider: "oauth2",
                  secret: oauthSessionForEndpoint.accessToken,
                  accountId: null,
                  additionalHeadersJson: null,
                  boundAuthFingerprint: null,
                  oauthRefreshToken: oauthSessionForEndpoint.refreshToken ?? null,
                  oauthExpiresAt,
                  oauthScope: oauthSessionForEndpoint.scope ?? null,
                  oauthAuthorizationServer,
                  oauthClientId: oauthSessionForEndpoint.clientId ?? null,
                  oauthSourceUrl: oauthSessionForEndpoint.sourceUrl,
                  oauthClientInformationJson:
                    oauthSessionForEndpoint.clientInformationJson ?? null,
                }),
              }),
            );
            oauthLinked = true;
            setMcpOAuthSession(null);
          } catch {
            oauthLinkNote = "Source saved, but OAuth credential linking failed.";
          }
        }

        const verb = isEditing ? "Updated" : "Added";
        const name = formState.name.trim();
        if (oauthLinked) setStatusText(`${verb} ${name} and linked OAuth credentials.${oauthLinkNote ? ` ${oauthLinkNote}` : ""}`);
        else if (oauthLinkNote) setStatusText(oauthLinkNote.startsWith("Source saved") ? oauthLinkNote : `${verb} ${name}. ${oauthLinkNote}`);
        else setStatusText(`${verb} ${name}.`);

        resetForm();
        onDone?.();
      })
      .catch(() => {
        setStatusText("Source save failed.");
        setOptimisticSources(null);
      });
  };

  const handleRemoveSource = () => {
    if (sourcesPending || !formState.id) return;
    const sourceId = formState.id;
    const previousSources = sources.items;
    const optimistic = optimisticRemoveSources(previousSources, sourceId);
    setOptimisticSources({ items: optimistic.items, pendingAck: { kind: "remove", sourceId: optimistic.sourceId } });

    void runRemoveSource(toRemoveSourceRequest({ workspaceId, sourceId }))
      .then(() => {
        setStatusText("Source removed.");
        resetForm();
        setOptimisticSources(null);
        onDone?.();
      })
      .catch(() => {
        setStatusText("Source removal failed.");
        setOptimisticSources(null);
      });
  };

  const statusVariant: "info" | "error" = statusText?.toLowerCase().includes("failed") ? "error" : "info";

  // =========================================================================
  // Render
  // =========================================================================

  if (view === "catalog") {
    return (
      <CatalogView
        search={catalogSearch}
        onSearchChange={setCatalogSearch}
        filteredCatalog={filteredCatalog}
        onSelectTemplate={handleSelectTemplate}
        customUrlInput={customUrlInput}
        onCustomUrlChange={setCustomUrlInput}
        onCustomUrlSubmit={handleCustomUrl}
        urlInputRef={urlInputRef}
      />
    );
  }

  return (
    <SourceFormView
      formState={formState}
      isEditing={isEditing}
      sourcesPending={sourcesPending}
      statusText={statusText}
      statusVariant={statusVariant}
      mcpOAuthDetection={mcpOAuthDetection}
      mcpOAuthBusy={mcpOAuthBusy}
      mcpOAuthConnected={mcpOAuthConnected}
      mcpOAuthCanConnect={mcpOAuthCanConnect}
      onFormFieldChange={setFormField}
      onSubmit={handleUpsertSource}
      onRemove={isEditing ? handleRemoveSource : undefined}
      onBack={isEditing ? onDone : handleBackToCatalog}
      onMcpOAuthConnect={handleMcpOAuthConnect}
    />
  );
}

// ---------------------------------------------------------------------------
// CatalogView — full-panel browsable API catalog
// ---------------------------------------------------------------------------

function CatalogView({
  search,
  onSearchChange,
  filteredCatalog,
  onSelectTemplate,
  customUrlInput,
  onCustomUrlChange,
  onCustomUrlSubmit,
  urlInputRef,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  filteredCatalog: ReadonlyArray<CatalogTemplate>;
  onSelectTemplate: (t: CatalogTemplate) => void;
  customUrlInput: string;
  onCustomUrlChange: (v: string) => void;
  onCustomUrlSubmit: (e: FormEvent<HTMLFormElement>) => void;
  urlInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* URL input bar */}
      <div className="shrink-0 border-b border-border">
        <div className="px-6 py-5">
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
            Add a source
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Paste an endpoint URL or pick from the catalog below.
          </p>
          <form onSubmit={onCustomUrlSubmit} className="mt-3 flex gap-2">
            <div className="relative flex-1">
              <svg
                viewBox="0 0 16 16"
                fill="none"
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50"
              >
                <path
                  d="M6.5 10.5L4 13a2.12 2.12 0 01-3-3l2.5-2.5a2.12 2.12 0 013 0M9.5 5.5L12 3a2.12 2.12 0 013 3l-2.5 2.5a2.12 2.12 0 01-3 0M5.5 10.5l5-5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <input
                ref={urlInputRef}
                value={customUrlInput}
                onChange={(e) => onCustomUrlChange(e.target.value)}
                placeholder="https://api.example.com/openapi.json"
                className="h-10 w-full rounded-lg border border-input bg-background pl-10 pr-4 text-sm outline-none transition-all placeholder:text-muted-foreground/40 focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
              />
            </div>
            <Button type="submit" disabled={customUrlInput.trim().length === 0} className="h-10 px-5">
              Add
            </Button>
          </form>
        </div>
      </div>

      {/* Catalog grid */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 pt-4 pb-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/60">
              Catalog
            </p>
            <div className="relative">
              <svg
                viewBox="0 0 16 16"
                fill="none"
                className="absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/40"
              >
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <input
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Filter..."
                className="h-7 w-36 rounded-md border border-border/60 bg-transparent pl-7 pr-2 text-[12px] outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-primary/40 focus:w-48"
              />
            </div>
          </div>
        </div>

        <div className="px-6 pb-6">
          {filteredCatalog.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <p className="text-[13px] text-muted-foreground/60">No APIs match your search.</p>
            </div>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {filteredCatalog.map((template) => {
                const colors = TYPE_COLORS[template.type];
                const isHovered = hoveredId === template.id;

                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => onSelectTemplate(template)}
                    onMouseEnter={() => setHoveredId(template.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    className={cn(
                      "group relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all duration-150",
                      isHovered
                        ? "border-primary/30 bg-primary/[0.03] shadow-sm shadow-primary/5 dark:bg-primary/[0.04]"
                        : "border-border/70 bg-card/50 hover:border-border",
                    )}
                  >
                    {/* Favicon */}
                    <div className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
                      colors.bg,
                    )}>
                      <SourceFavicon endpoint={template.faviconUrl ?? template.endpoint} kind={template.type} className="size-4" />
                    </div>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-foreground leading-tight">
                          {template.name}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className={cn("flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide", colors.text)}>
                          <span className={cn("size-1.5 rounded-full", colors.dot)} />
                          {template.type}
                        </span>
                        <span className="text-[10px] text-muted-foreground/40">/</span>
                        <span className="text-[10px] text-muted-foreground/60">{template.providerName}</span>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground/80">
                        {template.summary}
                      </p>
                    </div>

                    {/* Arrow indicator */}
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      className={cn(
                        "absolute right-3 top-3.5 size-3.5 transition-all",
                        isHovered
                          ? "text-primary/60 translate-x-0 opacity-100"
                          : "text-muted-foreground/20 -translate-x-0.5 opacity-0",
                      )}
                    >
                      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SourceFormView — detailed source configuration
// ---------------------------------------------------------------------------

function SourceFormView({
  formState,
  isEditing,
  sourcesPending,
  statusText,
  statusVariant,
  mcpOAuthDetection,
  mcpOAuthBusy,
  mcpOAuthConnected,
  mcpOAuthCanConnect,
  onFormFieldChange,
  onSubmit,
  onRemove,
  onBack,
  onMcpOAuthConnect,
}: {
  formState: LegacySourceFormState;
  isEditing: boolean;
  sourcesPending: boolean;
  statusText: string | null;
  statusVariant: "info" | "error";
  mcpOAuthDetection: McpOAuthDetectionState;
  mcpOAuthBusy: boolean;
  mcpOAuthConnected: boolean;
  mcpOAuthCanConnect: boolean;
  onFormFieldChange: <K extends keyof LegacySourceFormState>(key: K, value: LegacySourceFormState[K]) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onRemove?: () => void;
  onBack?: () => void;
  onMcpOAuthConnect: () => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="flex items-center gap-3 px-6 py-4">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <svg viewBox="0 0 16 16" fill="none" className="size-4">
                <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">
              {isEditing ? "Edit source" : "Configure source"}
            </h2>
            {formState.endpoint ? (
              <p className="mt-0.5 truncate text-[12px] font-mono text-muted-foreground/60">
                {formState.endpoint}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Scrollable form */}
      <div className="flex-1 overflow-y-auto">
        <form className="space-y-5 px-6 py-5" onSubmit={onSubmit}>
          {/* Endpoint */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="sf-endpoint">Endpoint</label>
            <Input
              id="sf-endpoint"
              value={formState.endpoint}
              onChange={(e) => onFormFieldChange("endpoint", e.target.value)}
              placeholder="https://api.example.com/openapi.json"
              required
            />
          </div>

          {/* Name */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="sf-name">Name</label>
            <Input
              id="sf-name"
              value={formState.name}
              onChange={(e) => onFormFieldChange("name", e.target.value)}
              placeholder="My API Source"
              required
            />
          </div>

          {/* Kind */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="sf-kind">Type</label>
            <Select
              id="sf-kind"
              value={formState.type}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => onFormFieldChange("type", e.target.value as LegacySourceType)}
            >
              {kindOptions.map((o) => <option key={o} value={o}>{o === "openapi" ? "OpenAPI" : o === "mcp" ? "MCP Server" : "GraphQL"}</option>)}
            </Select>
          </div>

          {/* OpenAPI base URL */}
          {formState.type === "openapi" ? (
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="sf-base-url">Base URL</label>
              <Input
                id="sf-base-url"
                value={formState.baseUrl}
                onChange={(e) => onFormFieldChange("baseUrl", e.target.value)}
                placeholder="https://api.example.com"
              />
            </div>
          ) : null}

          {/* MCP Transport */}
          {formState.type === "mcp" ? (
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="sf-transport">Transport</label>
              <Select
                id="sf-transport"
                value={formState.mcpTransport}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  onFormFieldChange("mcpTransport", e.target.value as "auto" | "streamable-http" | "sse")
                }
              >
                <option value="auto">Auto-detect</option>
                <option value="streamable-http">Streamable HTTP</option>
                <option value="sse">SSE</option>
              </Select>
            </div>
          ) : null}

          {/* MCP OAuth detection */}
          {formState.type === "mcp" ? (
            <div className="rounded-lg border border-border/70 bg-muted/15 p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="text-[12px] font-semibold text-foreground">OAuth</p>
                    {mcpOAuthConnected ? (
                      <Badge variant="approved" className="text-[9px] uppercase tracking-wider">connected</Badge>
                    ) : null}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {mcpOAuthDetection.status === "checking" ? "Checking endpoint for OAuth support..."
                      : mcpOAuthDetection.status === "oauth" ? "OAuth is supported for this endpoint."
                      : mcpOAuthDetection.status === "none" ? "OAuth was not detected."
                      : mcpOAuthDetection.status === "error" ? "OAuth detection failed."
                      : "Set an MCP endpoint to detect OAuth."}
                  </p>
                </div>
                {mcpOAuthCanConnect ? (
                  <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={onMcpOAuthConnect} disabled={mcpOAuthBusy}>
                    {mcpOAuthBusy ? "Connecting..." : mcpOAuthConnected ? "Reconnect" : "Connect"}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Auth settings */}
          <div className="space-y-3">
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/60">Authentication</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="sf-auth-type">Type</label>
                <Select
                  id="sf-auth-type"
                  value={formState.authType}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => onFormFieldChange("authType", e.target.value as "none" | "bearer" | "apiKey" | "basic")}
                >
                  <option value="none">None</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="apiKey">API Key</option>
                  <option value="basic">Basic Auth</option>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="sf-auth-scope">Scope</label>
                <Select
                  id="sf-auth-scope"
                  value={formState.authMode}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => onFormFieldChange("authMode", e.target.value as "workspace" | "organization" | "account")}
                >
                  <option value="workspace">Workspace</option>
                  <option value="organization">Organization</option>
                  <option value="account">Account</option>
                </Select>
              </div>
            </div>

            {formState.authType === "apiKey" ? (
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="sf-api-header">Header Name</label>
                <Input
                  id="sf-api-header"
                  value={formState.apiKeyHeader}
                  onChange={(e) => onFormFieldChange("apiKeyHeader", e.target.value)}
                  placeholder="Authorization"
                />
              </div>
            ) : null}
          </div>

          {/* Enabled toggle */}
          <label
            htmlFor="sf-enabled"
            className={cn(
              "flex items-center justify-between rounded-lg border border-border bg-muted/25 px-3.5 py-2.5 text-[13px] cursor-pointer transition-colors hover:bg-muted/40",
              formState.enabled ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="font-medium">Enabled</span>
            <input
              id="sf-enabled"
              checked={formState.enabled}
              onChange={(e) => onFormFieldChange("enabled", e.target.checked)}
              type="checkbox"
              className="size-4 rounded border-input bg-background text-primary accent-primary focus:ring-2 focus:ring-ring/60 focus:ring-offset-1"
            />
          </label>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={sourcesPending} className="flex-1">
              {sourcesPending ? "Saving..." : isEditing ? "Save Source" : "Add Source"}
            </Button>
            {onRemove ? (
              <Button type="button" variant="destructive" size="sm" onClick={onRemove} disabled={sourcesPending}>
                Remove
              </Button>
            ) : null}
          </div>

          <StatusMessage message={statusText} variant={statusVariant} className="text-[12px]" />
        </form>
      </div>
    </div>
  );
}
