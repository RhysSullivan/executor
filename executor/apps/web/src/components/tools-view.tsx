"use client";

import { useState } from "react";
import {
  Wrench,
  Plus,
  Trash2,
  ShieldCheck,
  Globe,
  Server,
  ChevronRight,
  AlertTriangle,
  KeyRound,
  Pencil,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { McpSetupCard } from "@/components/mcp-setup-card";
import { ToolExplorer } from "@/components/tool-explorer";
import { useSession } from "@/lib/session-context";
import { useWorkspaceTools } from "@/hooks/use-workspace-tools";
import { useAction, useMutation, useQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import type {
  ToolSourceRecord,
  ToolDescriptor,
  CredentialRecord,
  CredentialScope,
  OpenApiSourceQuality,
} from "@/lib/types";
import { parse as parseDomain } from "tldts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── API Presets ──

interface ApiPreset {
  name: string;
  label: string;
  description: string;
  type: "openapi" | "mcp" | "graphql";
  spec?: string;
  url?: string;
  endpoint?: string;
  baseUrl?: string;
  authNote?: string;
}

const API_PRESETS: ApiPreset[] = [
  {
    name: "github",
    label: "GitHub",
    description: "Repos, issues, PRs, actions, users, orgs",
    type: "openapi",
    spec: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml",
    baseUrl: "https://api.github.com",
    authNote: "Add a bearer credential with a PAT for authenticated access",
  },
  {
    name: "vercel",
    label: "Vercel",
    description: "Deployments, projects, domains, env vars, teams",
    type: "openapi",
    spec: "https://openapi.vercel.sh",
    baseUrl: "https://api.vercel.com",
    authNote: "Requires API token as bearer credential",
  },
  {
    name: "slack",
    label: "Slack",
    description: "Messages, channels, users, reactions, files",
    type: "openapi",
    spec: "https://api.slack.com/specs/openapi/v2/slack_web.json",
    baseUrl: "https://slack.com/api",
    authNote: "Requires a bot token as bearer credential",
  },
  {
    name: "stripe",
    label: "Stripe",
    description: "Payments, customers, subscriptions, invoices",
    type: "openapi",
    spec: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    baseUrl: "https://api.stripe.com",
    authNote: "Requires API key as bearer credential",
  },

  {
    name: "openai",
    label: "OpenAI",
    description: "Chat completions, embeddings, images, files",
    type: "openapi",
    spec: "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml",
    baseUrl: "https://api.openai.com",
    authNote: "Requires API key as bearer credential",
  },
  {
    name: "cloudflare",
    label: "Cloudflare",
    description: "DNS, zones, workers, KV, R2, firewall",
    type: "openapi",
    spec: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml",
    baseUrl: "https://api.cloudflare.com/client/v4",
    authNote: "Requires API token as bearer credential",
  },
  {
    name: "sentry",
    label: "Sentry",
    description: "Issues, events, projects, releases, alerts",
    type: "openapi",
    spec: "https://raw.githubusercontent.com/getsentry/sentry-api-schema/refs/heads/main/openapi-derefed.json",
    baseUrl: "https://sentry.io/api/0",
    authNote: "Requires auth token as bearer credential",
  },
  {
    name: "jira",
    label: "Jira",
    description: "Issues, projects, boards, sprints, users",
    type: "openapi",
    spec: "https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json",
    baseUrl: "https://your-domain.atlassian.net/rest/api/3",
    authNote: "Requires API token with basic auth (email:token)",
  },
  {
    name: "pagerduty",
    label: "PagerDuty",
    description: "Incidents, services, schedules, escalations",
    type: "openapi",
    spec: "https://raw.githubusercontent.com/PagerDuty/api-schema/main/reference/REST/openapiv3.json",
    baseUrl: "https://api.pagerduty.com",
    authNote: "Requires API key as bearer credential",
  },
  {
    name: "digitalocean",
    label: "DigitalOcean",
    description: "Droplets, databases, domains, apps, spaces",
    type: "openapi",
    spec: "https://api-engineering.nyc3.cdn.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml",
    baseUrl: "https://api.digitalocean.com",
    authNote: "Requires API token as bearer credential",
  },
  {
    name: "twilio",
    label: "Twilio",
    description: "SMS, calls, conversations, verify, phone numbers",
    type: "openapi",
    spec: "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json",
    baseUrl: "https://api.twilio.com",
    authNote: "Requires Account SID + Auth Token as basic auth",
  },
  {
    name: "notion",
    label: "Notion",
    description: "Pages, databases, blocks, search, users",
    type: "openapi",
    spec: "https://developers.notion.com/openapi.json",
    baseUrl: "https://api.notion.com",
    authNote: "Requires integration token as bearer credential",
  },

  {
    name: "resend",
    label: "Resend",
    description: "Send emails, manage domains, API keys",
    type: "openapi",
    spec: "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml",
    baseUrl: "https://api.resend.com",
  },
  {
    name: "linear",
    label: "Linear",
    description: "Issues, projects, teams, cycles, labels",
    type: "graphql",
    endpoint: "https://api.linear.app/graphql",
    authNote: "Requires API key as bearer credential",
  },
];

/** Derive a favicon URL from any URL string via Google's favicon service. */
function faviconForUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch {
    return null;
  }
}

function isTemplateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "example.com" ||
    lower.endsWith(".example.com") ||
    lower.startsWith("your-domain") ||
    lower.includes(".your-domain")
  );
}

function pickFaviconTarget(urls: Array<string | undefined | null>): string | null {
  const parsed = urls
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      try {
        return { value, hostname: new URL(value).hostname };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { value: string; hostname: string } => entry !== null);

  const preferred = parsed.find((entry) => !isTemplateHostname(entry.hostname));
  if (preferred) return preferred.value;
  return parsed[0]?.value ?? null;
}

function getFaviconUrl(preset: ApiPreset): string | null {
  return faviconForUrl(pickFaviconTarget([preset.baseUrl, preset.endpoint, preset.url, preset.spec]));
}

function getSourceFavicon(source: ToolSourceRecord): string | null {
  const urls =
    source.type === "mcp"
      ? [source.config.url as string]
      : source.type === "graphql"
        ? [source.config.endpoint as string]
        : [source.config.baseUrl as string, source.config.spec as string];
  return faviconForUrl(pickFaviconTarget(urls));
}

function sourceKeyForSource(source: ToolSourceRecord): string | null {
  if (source.type === "openapi") return `openapi:${source.name}`;
  if (source.type === "graphql") return `graphql:${source.name}`;
  return null;
}

type SourceAuthType = "none" | "bearer" | "apiKey" | "basic";
type SourceAuthMode = "workspace" | "actor";

function readSourceAuth(source: ToolSourceRecord): {
  type: SourceAuthType;
  mode?: SourceAuthMode;
  header?: string;
} {
  if (source.type !== "openapi" && source.type !== "graphql") {
    return { type: "none" };
  }

  const auth = source.config.auth as Record<string, unknown> | undefined;
  const type =
    auth && typeof auth.type === "string" && ["none", "bearer", "apiKey", "basic"].includes(auth.type)
      ? (auth.type as SourceAuthType)
      : "none";

  const mode =
    auth && typeof auth.mode === "string" && (auth.mode === "workspace" || auth.mode === "actor")
      ? (auth.mode as SourceAuthMode)
      : undefined;

  const header = auth && typeof auth.header === "string" && auth.header.trim().length > 0
    ? auth.header.trim()
    : undefined;

  return {
    type,
    ...(mode ? { mode } : {}),
    ...(header ? { header } : {}),
  };
}

function formatSourceAuthBadge(source: ToolSourceRecord): string | null {
  const auth = readSourceAuth(source);
  if (auth.type === "none") return null;
  const mode = auth.mode ?? "workspace";
  return `${auth.type}:${mode}`;
}

function formatQualityPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function qualityBadgeClass(quality: OpenApiSourceQuality): string {
  if (quality.overallQuality >= 0.95) {
    return "text-terminal-green border-terminal-green/30";
  }
  if (quality.overallQuality >= 0.85) {
    return "text-terminal-amber border-terminal-amber/30";
  }
  return "text-terminal-red border-terminal-red/30";
}

// ── Add Source Dialog ──

const RAW_HOSTS = new Set([
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "raw.github.com",
]);

function inferNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parsed = parseDomain(url);

    if (RAW_HOSTS.has(u.hostname)) {
      const segments = u.pathname.split("/").filter(Boolean);
      if (segments.length > 0) return segments[0].toLowerCase();
    }

    if (parsed.domainWithoutSuffix) {
      return parsed.domainWithoutSuffix;
    }

    if (parsed.domain) {
      return parsed.domain.split(".")[0];
    }

    return u.hostname.replace(/\./g, "-");
  } catch {
    return "";
  }
}

function AddSourceDialog({
  existingSourceNames,
}: {
  existingSourceNames: Set<string>;
}) {
  const { context } = useSession();
  const upsertToolSource = useMutation(convexApi.workspace.upsertToolSource);
  const [open, setOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [type, setType] = useState<"mcp" | "openapi" | "graphql">("mcp");
  const [name, setName] = useState("");
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"auto" | "streamable-http" | "sse">("auto");
  const [mcpActorQueryParamKey, setMcpActorQueryParamKey] = useState("userId");
  const [submitting, setSubmitting] = useState(false);
  const [addingPreset, setAddingPreset] = useState<string | null>(null);

  const handleEndpointChange = (value: string) => {
    setEndpoint(value);
    if (!nameManuallyEdited) {
      const inferred = inferNameFromUrl(value);
      if (inferred) setName(inferred);
    }
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setNameManuallyEdited(true);
  };

  const resetForm = () => {
    setName("");
    setEndpoint("");
    setBaseUrl("");
    setMcpTransport("auto");
    setMcpActorQueryParamKey("userId");
    setNameManuallyEdited(false);
    setPresetsOpen(false);
    setAddingPreset(null);
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) resetForm();
  };

  const addSource = async (
    sourceName: string,
    sourceType: "mcp" | "openapi" | "graphql",
    config: Record<string, unknown>,
  ) => {
    if (!context) return;
    await upsertToolSource({
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      name: sourceName,
      type: sourceType,
      config,
    });
    toast.success(`Source "${sourceName}" added — loading tools…`);
  };

  const handlePresetAdd = async (preset: ApiPreset) => {
    setAddingPreset(preset.name);
    try {
      const config: Record<string, unknown> =
        preset.type === "mcp"
          ? { url: preset.url }
          : preset.type === "graphql"
            ? { endpoint: preset.endpoint }
            : {
                spec: preset.spec,
                ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
              };
      await addSource(preset.name, preset.type, config);
      if (preset.authNote) {
        toast.info(preset.authNote, { duration: 6000 });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add source");
    } finally {
      setAddingPreset(null);
    }
  };

  const handleCustomSubmit = async () => {
    if (!context || !name.trim() || !endpoint.trim()) return;
    setSubmitting(true);
    try {
      const config: Record<string, unknown> =
        type === "mcp"
          ? {
              url: endpoint,
              ...(mcpTransport !== "auto" ? { transport: mcpTransport } : {}),
              ...(mcpActorQueryParamKey.trim() && context.actorId
                ? { queryParams: { [mcpActorQueryParamKey.trim()]: context.actorId } }
                : {}),
            }
          : type === "graphql"
            ? { endpoint: endpoint }
            : { spec: endpoint, ...(baseUrl ? { baseUrl } : {}) };
      await addSource(name.trim(), type, config);
      resetForm();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add source");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 text-xs">
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Source
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border sm:max-w-md p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-sm font-medium">
            Add Tool Source
          </DialogTitle>
        </DialogHeader>

        <div className="p-5 space-y-4">
          {/* Custom source form — always visible */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as "mcp" | "openapi" | "graphql")}
              >
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mcp" className="text-xs">
                    MCP Server
                  </SelectItem>
                  <SelectItem value="openapi" className="text-xs">
                    OpenAPI Spec
                  </SelectItem>
                  <SelectItem value="graphql" className="text-xs">
                    GraphQL
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {type === "mcp" ? "Endpoint URL" : type === "graphql" ? "GraphQL Endpoint" : "Spec URL"}
              </Label>
              <Input
                value={endpoint}
                onChange={(e) => handleEndpointChange(e.target.value)}
                placeholder={
                  type === "mcp"
                    ? "https://mcp-server.example.com/sse"
                    : type === "graphql"
                      ? "https://api.example.com/graphql"
                      : "https://api.example.com/openapi.json"
                }
                className="h-8 text-xs font-mono bg-background"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. my-service"
                className="h-8 text-xs font-mono bg-background"
              />
            </div>
            {type === "openapi" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Base URL (optional)
                </Label>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.example.com"
                  className="h-8 text-xs font-mono bg-background"
                />
              </div>
            )}
            {type === "mcp" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Transport</Label>
                  <Select
                    value={mcpTransport}
                    onValueChange={(v) => setMcpTransport(v as "auto" | "streamable-http" | "sse")}
                  >
                    <SelectTrigger className="h-8 text-xs bg-background">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto" className="text-xs">
                        Auto (streamable, then SSE)
                      </SelectItem>
                      <SelectItem value="streamable-http" className="text-xs">
                        Streamable HTTP
                      </SelectItem>
                      <SelectItem value="sse" className="text-xs">
                        SSE
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Anon actor query key (optional)
                  </Label>
                  <Input
                    value={mcpActorQueryParamKey}
                    onChange={(e) => setMcpActorQueryParamKey(e.target.value)}
                    placeholder="userId"
                    className="h-8 text-xs font-mono bg-background"
                  />
                </div>
              </>
            )}
            <Button
              onClick={handleCustomSubmit}
              disabled={submitting || !name.trim() || !endpoint.trim()}
              className="w-full h-9"
              size="sm"
            >
              {submitting ? "Adding..." : "Add Source"}
            </Button>
          </div>

          {/* Collapsible presets */}
          <Separator />
          <Collapsible open={presetsOpen} onOpenChange={setPresetsOpen}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full py-1 text-xs text-muted-foreground hover:text-foreground transition-colors group">
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform duration-200",
                  presetsOpen && "rotate-90",
                )}
              />
              <span>Quick add from catalog</span>
              <span className="text-[10px] font-mono text-muted-foreground/60">
                {API_PRESETS.length}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-3 space-y-1">
                {API_PRESETS.map((preset) => {
                  const alreadyAdded = existingSourceNames.has(preset.name);
                  return (
                    <button
                      key={preset.name}
                      onClick={() => !alreadyAdded && handlePresetAdd(preset)}
                      disabled={alreadyAdded || addingPreset !== null}
                      className={cn(
                        "flex items-center gap-3 w-full px-3 py-2 rounded-md text-left transition-colors",
                        alreadyAdded
                          ? "opacity-50 cursor-default"
                          : "hover:bg-accent/30 cursor-pointer",
                      )}
                    >
                      <span className="flex items-center justify-center h-6 w-6 rounded bg-muted shrink-0 overflow-hidden">
                        {(() => {
                          const favicon = getFaviconUrl(preset);
                          return favicon ? (
                            <img
                              src={favicon}
                              alt=""
                              width={16}
                              height={16}
                              className="w-4 h-4"
                              loading="lazy"
                            />
                          ) : (
                            <span className="text-[9px] font-bold font-mono text-muted-foreground">
                              {preset.name.slice(0, 2).toUpperCase()}
                            </span>
                          );
                        })()}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-foreground">
                          {preset.label}
                        </span>
                        <span className="text-[11px] text-muted-foreground ml-2">
                          {preset.description}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Source Card ──

function ConfigureSourceAuthDialog({
  source,
}: {
  source: ToolSourceRecord;
}) {
  const { context } = useSession();
  const upsertToolSource = useMutation(convexApi.workspace.upsertToolSource);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const currentAuth = readSourceAuth(source);
  const [authType, setAuthType] = useState<SourceAuthType>(currentAuth.type);
  const [authMode, setAuthMode] = useState<SourceAuthMode>(currentAuth.mode ?? "workspace");
  const [apiKeyHeader, setApiKeyHeader] = useState(currentAuth.header ?? "x-api-key");

  const configurable = source.type === "openapi" || source.type === "graphql";

  const resetFromSource = () => {
    const auth = readSourceAuth(source);
    setAuthType(auth.type);
    setAuthMode(auth.mode ?? "workspace");
    setApiKeyHeader(auth.header ?? "x-api-key");
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      resetFromSource();
    }
  };

  const handleSave = async () => {
    if (!context || !configurable) return;
    setSaving(true);
    try {
      const authConfig: Record<string, unknown> =
        authType === "none"
          ? { type: "none" }
          : authType === "apiKey"
            ? { type: "apiKey", mode: authMode, header: apiKeyHeader.trim() || "x-api-key" }
            : { type: authType, mode: authMode };

      await upsertToolSource({
        id: source.id,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        name: source.name,
        type: source.type,
        config: {
          ...source.config,
          auth: authConfig,
        },
      });

      toast.success(`Updated auth for ${source.name}`);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update auth");
    } finally {
      setSaving(false);
    }
  };

  if (!configurable) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[11px]">
          <Pencil className="h-3 w-3 mr-1.5" />
          Auth
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">Configure Source Auth</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Source</Label>
            <Input value={source.name} readOnly className="h-8 text-xs font-mono bg-background" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Auth Type</Label>
            <Select value={authType} onValueChange={(value) => setAuthType(value as SourceAuthType)}>
              <SelectTrigger className="h-8 text-xs bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs">None</SelectItem>
                <SelectItem value="bearer" className="text-xs">Bearer token</SelectItem>
                <SelectItem value="apiKey" className="text-xs">API key header</SelectItem>
                <SelectItem value="basic" className="text-xs">Basic auth</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {authType !== "none" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Credential Scope</Label>
                <Select value={authMode} onValueChange={(value) => setAuthMode(value as SourceAuthMode)}>
                  <SelectTrigger className="h-8 text-xs bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="workspace" className="text-xs">Workspace</SelectItem>
                    <SelectItem value="actor" className="text-xs">Per-user (actor)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {authType === "apiKey" && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Header Name</Label>
                  <Input
                    value={apiKeyHeader}
                    onChange={(e) => setApiKeyHeader(e.target.value)}
                    placeholder="x-api-key"
                    className="h-8 text-xs font-mono bg-background"
                  />
                </div>
              )}

              <p className="text-[11px] text-muted-foreground">
                Save this first, then add credentials in the Credentials tab using source key
                <code className="ml-1">{sourceKeyForSource(source)}</code>.
              </p>
            </>
          )}

          <Button onClick={handleSave} disabled={saving} className="w-full h-9" size="sm">
            {saving ? "Saving..." : "Save Auth"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourceCard({
  source,
  quality,
  qualityLoading,
}: {
  source: ToolSourceRecord;
  quality?: OpenApiSourceQuality;
  qualityLoading?: boolean;
}) {
  const { context } = useSession();
  const deleteToolSource = useMutation(convexApi.workspace.deleteToolSource);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!context) return;
    setDeleting(true);
    try {
      await deleteToolSource({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        sourceId: source.id,
      });
      toast.success(`Removed "${source.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  const TypeIcon = source.type === "mcp" ? Server : Globe;
  const favicon = getSourceFavicon(source);
  const authBadge = formatSourceAuthBadge(source);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-muted/40 group">
      <div className="h-8 w-8 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden">
        {favicon ? (
          <img src={favicon} alt="" width={20} height={20} className="w-5 h-5" loading="lazy" />
        ) : (
          <TypeIcon className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-medium truncate">
            {source.name}
          </span>
          <Badge
            variant="outline"
            className="text-[9px] font-mono uppercase tracking-wider"
          >
            {source.type}
          </Badge>
          {!source.enabled && (
            <Badge
              variant="outline"
              className="text-[9px] font-mono uppercase tracking-wider text-terminal-red border-terminal-red/30"
            >
              disabled
            </Badge>
          )}
          {authBadge && (
            <Badge
              variant="outline"
              className="text-[9px] font-mono uppercase tracking-wider text-primary border-primary/30"
            >
              {authBadge}
            </Badge>
          )}
          {source.type === "openapi" && quality && (
            <Badge
              variant="outline"
              className={cn("text-[9px] font-mono uppercase tracking-wider", qualityBadgeClass(quality))}
            >
              quality {formatQualityPercent(quality.overallQuality)}
            </Badge>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground font-mono truncate block">
          {source.type === "mcp"
            ? (source.config.url as string)
            : source.type === "graphql"
              ? (source.config.endpoint as string)
              : (source.config.spec as string)}
        </span>
        {source.type === "openapi" && quality && (
          <span className="text-[10px] text-muted-foreground/90 font-mono truncate block mt-0.5">
            args {formatQualityPercent(quality.argsQuality)} | returns {formatQualityPercent(quality.returnsQuality)}
            {quality.unknownReturnsCount > 0
              ? ` | ${quality.unknownReturnsCount} unknown returns`
              : " | fully typed returns"}
          </span>
        )}
        {source.type === "openapi" && !quality && qualityLoading && (
          <span className="text-[10px] text-muted-foreground/70 font-mono truncate block mt-0.5">
            Computing OpenAPI type quality...
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0">
        <ConfigureSourceAuthDialog source={source} />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-terminal-red"
          onClick={handleDelete}
          disabled={deleting}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function formatCredentialSecret(secretJson: Record<string, unknown>): string {
  try {
    return JSON.stringify(secretJson, null, 2);
  } catch {
    return "{}";
  }
}

type SourceOption = { source: ToolSourceRecord; key: string };

function sourceAuthForKey(sourceOptions: SourceOption[], key: string): {
  type: SourceAuthType;
  mode?: SourceAuthMode;
  header?: string;
} {
  const match = sourceOptions.find((entry) => entry.key === key);
  if (!match) {
    return { type: "bearer" };
  }
  return readSourceAuth(match.source);
}

function parseJsonObject(text: string): { value?: Record<string, unknown>; error?: string } {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Credential JSON must be an object" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid credential JSON" };
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function providerLabel(provider: "managed" | "workos-vault"): string {
  return provider === "workos-vault" ? "encrypted" : "managed";
}

function CredentialsPanel({
  sources,
  credentials,
  loading,
}: {
  sources: ToolSourceRecord[];
  credentials: CredentialRecord[];
  loading: boolean;
}) {
  const { context } = useSession();
  const upsertCredential = useAction(convexApi.credentialsNode.upsertCredential);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<CredentialRecord | null>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [scope, setScope] = useState<CredentialScope>("workspace");
  const [actorId, setActorId] = useState("");
  const [provider, setProvider] = useState<"managed" | "workos-vault">("managed");
  const [managedToken, setManagedToken] = useState("");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [basicUsername, setBasicUsername] = useState("");
  const [basicPassword, setBasicPassword] = useState("");
  const [advancedMode, setAdvancedMode] = useState(false);
  const [secretJsonText, setSecretJsonText] = useState("{}");

  const sourceOptions = sources
    .map((source) => ({ source, key: sourceKeyForSource(source) }))
    .filter((entry): entry is { source: ToolSourceRecord; key: string } => entry.key !== null);

  const selectedAuth = sourceAuthForKey(sourceOptions, sourceKey);
  const selectedAuthBadge = selectedAuth.type === "none"
    ? "none"
    : `${selectedAuth.type}:${selectedAuth.mode ?? "workspace"}`;

  const buildDraftSecretFromInputs = (): Record<string, unknown> => {
    if (selectedAuth.type === "apiKey") {
      return { value: apiKeyValue.trim() };
    }
    if (selectedAuth.type === "basic") {
      return {
        username: basicUsername,
        password: basicPassword,
      };
    }
    return { token: managedToken.trim() };
  };

  const setFormFromCredential = (credential: CredentialRecord) => {
    const secret = credential.secretJson;
    setManagedToken(asString(secret.token) || asString(secret.value));
    setApiKeyValue(asString(secret.value) || asString(secret.token));
    setBasicUsername(asString(secret.username));
    setBasicPassword(asString(secret.password));
    setSecretJsonText(formatCredentialSecret(secret));
    setAdvancedMode(false);
  };

  const resetForm = () => {
    const defaultSourceKey = sourceOptions[0]?.key ?? "";
    setSourceKey(defaultSourceKey);
    const defaultAuth = sourceAuthForKey(sourceOptions, defaultSourceKey);
    setScope(defaultAuth.mode ?? "workspace");
    setActorId(context?.actorId ?? "");
    setProvider("managed");
    setManagedToken("");
    setApiKeyValue("");
    setBasicUsername("");
    setBasicPassword("");
    setAdvancedMode(false);
    setSecretJsonText("{}");
    setEditing(null);
  };

  const openForCreate = () => {
    resetForm();
    setOpen(true);
  };

  const openForEdit = (credential: CredentialRecord) => {
    setEditing(credential);
    setSourceKey(credential.sourceKey);
    setScope(credential.scope);
    setActorId(credential.actorId ?? context?.actorId ?? "");
    setProvider(credential.provider === "workos-vault" ? "workos-vault" : "managed");
    setFormFromCredential(credential);
    setOpen(true);
  };

  const handleSourceKeyChange = (nextSourceKey: string) => {
    setSourceKey(nextSourceKey);
    const auth = sourceAuthForKey(sourceOptions, nextSourceKey);
    if (!editing) {
      setScope(auth.mode ?? "workspace");
    }
  };

  const handleProviderChange = (value: "managed" | "workos-vault") => {
    setProvider(value);
  };

  const handleAdvancedModeChange = (next: boolean) => {
    setAdvancedMode(next);
    if (next) {
      setSecretJsonText(formatCredentialSecret(buildDraftSecretFromInputs()));
    }
  };

  const handleSave = async () => {
    if (!context) return;
    if (!sourceKey.trim()) {
      toast.error("Source key is required");
      return;
    }
    if (scope === "actor" && !actorId.trim()) {
      toast.error("Actor ID is required for actor-scoped credentials");
      return;
    }

    let secretJson: Record<string, unknown> = {};
    const keepExistingEncryptedSecret = provider === "workos-vault" && Boolean(editing);

    if (advancedMode) {
      const parsed = parseJsonObject(secretJsonText);
      if (!parsed.value) {
        toast.error(parsed.error ?? "Invalid credential JSON");
        return;
      }
      secretJson = parsed.value;
    } else {
      if (selectedAuth.type === "none") {
        toast.error("Configure source auth before saving credentials");
        return;
      }
      if (selectedAuth.type === "basic") {
        const hasUsername = basicUsername.trim().length > 0;
        const hasPassword = basicPassword.trim().length > 0;
        if (!hasUsername && !hasPassword && keepExistingEncryptedSecret) {
          secretJson = {};
        } else if (!hasUsername || !hasPassword) {
          toast.error("Username and password are required for basic auth");
          return;
        } else {
          secretJson = {
            username: basicUsername,
            password: basicPassword,
          };
        }
      } else if (selectedAuth.type === "apiKey") {
        if (!apiKeyValue.trim()) {
          if (keepExistingEncryptedSecret) {
            secretJson = {};
          } else {
            toast.error("API key value is required");
            return;
          }
        } else {
          secretJson = { value: apiKeyValue.trim() };
        }
      } else {
        if (!managedToken.trim()) {
          if (keepExistingEncryptedSecret) {
            secretJson = {};
          } else {
            toast.error("Token is required");
            return;
          }
        } else {
          secretJson = { token: managedToken.trim() };
        }
      }
    }

    if (provider === "workos-vault" && !editing && Object.keys(secretJson).length === 0) {
      if (selectedAuth.type === "basic") {
        toast.error("Username and password are required");
      } else if (selectedAuth.type === "apiKey") {
        toast.error("API key value is required");
      } else {
        toast.error("Token is required");
      }
      return;
    }

    setSaving(true);
    try {
      await upsertCredential({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        sourceKey: sourceKey.trim(),
        scope,
        ...(scope === "actor" ? { actorId: actorId.trim() } : {}),
        provider,
        secretJson,
      });

      toast.success(editing ? "Credential updated" : "Credential saved");
      setOpen(false);
      resetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save credential");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Credentials
          </CardTitle>
          <Button size="sm" className="h-8 text-xs" onClick={openForCreate}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Credential
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : credentials.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
              <KeyRound className="h-5 w-5 text-muted-foreground/50" />
            </div>
            <p className="text-sm text-muted-foreground">No credentials configured</p>
            <p className="text-[11px] text-muted-foreground/70 text-center max-w-md">
              Configure source auth on an OpenAPI or GraphQL source, then add workspace or actor credentials.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {credentials.map((credential) => (
              <div
                key={`${credential.sourceKey}:${credential.scope}:${credential.actorId ?? "workspace"}`}
                className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-muted/40"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-mono font-medium">{credential.sourceKey}</span>
                    <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                      {credential.scope}
                    </Badge>
                    <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                      {providerLabel(credential.provider === "workos-vault" ? "workos-vault" : "managed")}
                    </Badge>
                    {credential.scope === "actor" && credential.actorId && (
                      <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {credential.actorId}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Updated {new Date(credential.updatedAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => openForEdit(credential)}
                >
                  Edit
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-card border-border sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">
              {editing ? "Edit Credential" : "Add Credential"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Source Key</Label>
              {sourceOptions.length > 0 ? (
                <Select value={sourceKey} onValueChange={handleSourceKeyChange}>
                  <SelectTrigger className="h-8 text-xs bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceOptions.map((entry) => (
                      <SelectItem key={entry.key} value={entry.key} className="text-xs font-mono">
                        {entry.key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={sourceKey}
                  onChange={(e) => handleSourceKeyChange(e.target.value)}
                  placeholder="openapi:github"
                  className="h-8 text-xs font-mono bg-background"
                />
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-muted-foreground">Detected auth</span>
              <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                {selectedAuthBadge}
              </Badge>
              {selectedAuth.type === "apiKey" && selectedAuth.header && (
                <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  header: {selectedAuth.header}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Scope</Label>
                <Select value={scope} onValueChange={(value) => setScope(value as CredentialScope)}>
                  <SelectTrigger className="h-8 text-xs bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="workspace" className="text-xs">Workspace</SelectItem>
                    <SelectItem value="actor" className="text-xs">Per-user (actor)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Provider</Label>
                <Select value={provider} onValueChange={(value) => handleProviderChange(value as "managed" | "workos-vault") }>
                  <SelectTrigger className="h-8 text-xs bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="managed" className="text-xs">Managed storage</SelectItem>
                    <SelectItem value="workos-vault" className="text-xs">Encrypted storage</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {scope === "actor" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Actor ID</Label>
                <Input
                  value={actorId}
                  onChange={(e) => setActorId(e.target.value)}
                  placeholder="actor_123"
                  className="h-8 text-xs font-mono bg-background"
                />
              </div>
            )}

            {provider === "workos-vault" && editing && (
              <p className="text-[11px] text-muted-foreground">
                Stored secret is hidden. Enter a new value below to rotate, or leave fields blank to keep existing.
              </p>
            )}

            {selectedAuth.type === "none" ? (
              <p className="text-[11px] text-terminal-amber">
                This source has auth set to <code>none</code>. Configure source auth first.
              </p>
            ) : selectedAuth.type === "apiKey" ? (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">API Key Value</Label>
                <Input
                  value={apiKeyValue}
                  onChange={(e) => setApiKeyValue(e.target.value)}
                  placeholder="sk_live_..."
                  className="h-8 text-xs font-mono bg-background"
                />
              </div>
            ) : selectedAuth.type === "basic" ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Username</Label>
                  <Input
                    value={basicUsername}
                    onChange={(e) => setBasicUsername(e.target.value)}
                    className="h-8 text-xs font-mono bg-background"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Password</Label>
                  <Input
                    type="password"
                    value={basicPassword}
                    onChange={(e) => setBasicPassword(e.target.value)}
                    className="h-8 text-xs font-mono bg-background"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Bearer Token</Label>
                <Input
                  type="password"
                  value={managedToken}
                  onChange={(e) => setManagedToken(e.target.value)}
                  placeholder="ghp_..."
                  className="h-8 text-xs font-mono bg-background"
                />
              </div>
            )}

            <Collapsible open={advancedMode} onOpenChange={handleAdvancedModeChange}>
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-[11px]">
                  Advanced JSON
                  <ChevronRight className={cn("ml-1.5 h-3 w-3 transition-transform", advancedMode && "rotate-90")} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-1.5">
                <Label className="text-xs text-muted-foreground">Override Secret JSON</Label>
                <Textarea
                  value={secretJsonText}
                  onChange={(e) => setSecretJsonText(e.target.value)}
                  rows={6}
                  className="text-xs font-mono bg-background"
                />
              </CollapsibleContent>
            </Collapsible>

            <Button onClick={handleSave} disabled={saving} className="w-full h-9" size="sm">
              {saving ? "Saving..." : editing ? "Update Credential" : "Save Credential"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Tool Inventory (legacy removed — replaced by ToolExplorer) ──

// ── Tools View ──

export function ToolsView({ initialSource }: { initialSource?: string | null }) {
  const { context, loading: sessionLoading } = useSession();

  const sources = useQuery(
    convexApi.workspace.listToolSources,
    context ? { workspaceId: context.workspaceId, sessionId: context.sessionId } : "skip",
  );
  const sourcesLoading = !!context && sources === undefined;

  const credentials = useQuery(
    convexApi.workspace.listCredentials,
    context ? { workspaceId: context.workspaceId, sessionId: context.sessionId } : "skip",
  );
  const credentialsLoading = !!context && credentials === undefined;

  const { tools, warnings, sourceQuality, loading: toolsLoading } = useWorkspaceTools(context ?? null);

  if (sessionLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tools"
        description="Manage sources, auth, credentials, and available tools"
      />

      <Tabs defaultValue={initialSource ? "inventory" : "sources"} className="w-full">
        <TabsList className="bg-muted/50 h-9">
          <TabsTrigger value="sources" className="text-xs data-[state=active]:bg-background">
            Sources
            {sources && (
              <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
                {sources.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="credentials" className="text-xs data-[state=active]:bg-background">
            Credentials
            {credentials && (
              <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
                {credentials.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="inventory" className="text-xs data-[state=active]:bg-background">
            Inventory
            <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
              {toolsLoading ? "…" : tools.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="mcp" className="text-xs data-[state=active]:bg-background">
            MCP Setup
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sources" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Server className="h-4 w-4 text-muted-foreground" />
                  Tool Sources
                </CardTitle>
                <AddSourceDialog existingSourceNames={new Set((sources ?? []).map((s: any) => s.name))} />
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {sourcesLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-16" />
                  ))}
                </div>
              ) : !sources || sources.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                    <Wrench className="h-6 w-6 text-muted-foreground/40" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    No external tool sources
                  </p>
                  <p className="text-[11px] text-muted-foreground/60">
                    Add MCP, OpenAPI, or GraphQL sources to extend available tools
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {warnings.length > 0 && (
                    <div className="rounded-md border border-terminal-amber/30 bg-terminal-amber/10 px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-terminal-amber">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Source load warnings ({warnings.length})
                      </div>
                      <div className="mt-1.5 space-y-1">
                        {warnings.slice(0, 3).map((warning: any, i: any) => (
                          <p key={`${warning}-${i}`} className="text-[11px] text-terminal-amber/90">
                            {warning}
                          </p>
                        ))}
                        {warnings.length > 3 && (
                          <p className="text-[10px] text-terminal-amber/80">
                            +{warnings.length - 3} more warning{warnings.length - 3 === 1 ? "" : "s"}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  {sources.map((s: any) => {
                    const sourceKey = sourceKeyForSource(s);
                    const quality = sourceKey ? sourceQuality[sourceKey] : undefined;
                    return (
                      <SourceCard
                        key={s.id}
                        source={s}
                        quality={quality}
                        qualityLoading={toolsLoading}
                      />
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="credentials" className="mt-4">
          <CredentialsPanel
            sources={sources ?? []}
            credentials={credentials ?? []}
            loading={credentialsLoading || sourcesLoading}
          />
        </TabsContent>

        <TabsContent value="inventory" className="mt-4">
          <ToolExplorer
            tools={tools}
            sources={sources ?? []}
            loading={toolsLoading}
            warnings={warnings}
            initialSource={initialSource}
          />
        </TabsContent>

        <TabsContent value="mcp" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Server className="h-4 w-4 text-primary" />
                MCP Client Installation
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <McpSetupCard
                workspaceId={context?.workspaceId}
                actorId={context?.actorId}
                sessionId={context?.sessionId}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
