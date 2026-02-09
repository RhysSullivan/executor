"use client";

import { useState } from "react";
import {
  Wrench,
  Plus,
  Trash2,
  ShieldCheck,
  Globe,
  Server,
  Zap,
  Search,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useSession } from "@/lib/session-context";
import { useWorkspaceTools } from "@/hooks/use-workspace-tools";
import { useMutation, useQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import type { ToolSourceRecord, ToolDescriptor } from "@/lib/types";
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

function getFaviconUrl(preset: ApiPreset): string | null {
  return faviconForUrl(preset.baseUrl ?? preset.endpoint ?? preset.url);
}

function getSourceFavicon(source: ToolSourceRecord): string | null {
  const url =
    source.type === "mcp"
      ? (source.config.url as string)
      : source.type === "graphql"
        ? (source.config.endpoint as string)
        : (source.config.baseUrl as string) ?? (source.config.spec as string);
  return faviconForUrl(url);
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
  const upsertToolSource = useMutation(convexApi.database.upsertToolSource);
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

function SourceCard({
  source,
}: {
  source: ToolSourceRecord;
}) {
  const { context } = useSession();
  const deleteToolSource = useMutation(convexApi.database.deleteToolSource);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!context) return;
    setDeleting(true);
    try {
      await deleteToolSource({ workspaceId: context.workspaceId, sourceId: source.id });
      toast.success(`Removed "${source.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  const TypeIcon = source.type === "mcp" ? Server : Globe;
  const favicon = getSourceFavicon(source);

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
        </div>
        <span className="text-[11px] text-muted-foreground font-mono truncate block">
          {source.type === "mcp"
            ? (source.config.url as string)
            : source.type === "graphql"
              ? (source.config.endpoint as string)
              : (source.config.spec as string)}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-terminal-red shrink-0"
        onClick={handleDelete}
        disabled={deleting}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ── Tool Inventory ──

function ToolInventory({ tools }: { tools: ToolDescriptor[] }) {
  const [search, setSearch] = useState("");

  const filtered = tools.filter(
    (t) =>
      t.path.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tools..."
          className="h-8 text-xs pl-8 bg-background"
        />
      </div>
      <div className="space-y-1 max-h-[500px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            {search ? "No tools match your search" : "No tools available"}
          </div>
        ) : (
          filtered.map((tool) => (
            <div
              key={tool.path}
              className="flex items-start gap-3 px-3 py-2.5 rounded-md hover:bg-accent/30 transition-colors"
            >
              <Zap className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-mono font-medium">
                    {tool.path}
                  </span>
                  {tool.approval === "required" && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-terminal-amber bg-terminal-amber/10 px-1.5 py-0.5 rounded border border-terminal-amber/20">
                      <ShieldCheck className="h-2.5 w-2.5" />
                      approval
                    </span>
                  )}
                  {tool.source && (
                    <span className="text-[9px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {tool.source}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  {tool.description}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Tools View ──

export function ToolsView() {
  const { context, loading: sessionLoading } = useSession();

  const sources = useQuery(
    convexApi.database.listToolSources,
    context ? { workspaceId: context.workspaceId } : "skip",
  );
  const sourcesLoading = !!context && sources === undefined;

  const { tools, warnings, loading: toolsLoading } = useWorkspaceTools(context ?? null);

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
        description="Manage tool sources and view available tools"
      />

      <Tabs defaultValue="sources" className="w-full">
        <TabsList className="bg-muted/50 h-9">
          <TabsTrigger value="sources" className="text-xs data-[state=active]:bg-background">
            Sources
            {sources && (
              <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
                {sources.length}
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
                <AddSourceDialog existingSourceNames={new Set((sources ?? []).map(s => s.name))} />
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
                        {warnings.slice(0, 3).map((warning, i) => (
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
                  {sources.map((s) => (
                    <SourceCard key={s.id} source={s} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inventory" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                Available Tools
                <span className="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                  {toolsLoading ? "…" : tools.length}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {warnings.length > 0 && !toolsLoading && (
                <div className="mb-3 rounded-md border border-terminal-amber/30 bg-terminal-amber/10 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-terminal-amber">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Some sources failed to load; inventory may be incomplete
                  </div>
                </div>
              )}
              {toolsLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-14" />
                  ))}
                </div>
              ) : (
                <ToolInventory tools={tools} />
              )}
            </CardContent>
          </Card>
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
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
