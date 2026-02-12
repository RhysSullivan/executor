"use client";

import { useRef, useState } from "react";
import {
  Wrench,
  Plus,
  Trash2,
  Globe,
  Server,
  ChevronRight,
  AlertTriangle,
  KeyRound,
  Pencil,
  Loader2,
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
  CredentialRecord,
  CredentialScope,
  OpenApiSourceQuality,
} from "@/lib/types";
import { parse as parseDomain } from "tldts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Streamdown } from "streamdown";

interface CatalogCollectionItem {
  id: string;
  name: string;
  summary: string;
  specUrl: string;
  originUrl?: string;
  providerName: string;
  logoUrl?: string;
  categories?: string;
  version?: string;
}

interface CatalogCollectionsResponse {
  items?: CatalogCollectionItem[];
  totalCount?: number;
  hasMore?: boolean;
  error?: string;
  detail?: string;
}

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

function getSourceFavicon(source: ToolSourceRecord): string | null {
  if (source.type === "mcp") {
    return faviconForUrl((source.config.url as string) ?? null);
  }
  if (source.type === "graphql") {
    return faviconForUrl((source.config.endpoint as string) ?? null);
  }
  const spec = source.config.spec as string | undefined;
  if (typeof spec === "string" && spec.startsWith("postman:")) {
    return null;
  }
  const baseUrl = source.config.baseUrl as string | undefined;
  const collectionUrl = source.config.collectionUrl as string | undefined;
  const specUrl = typeof spec === "string" && spec.startsWith("http") ? spec : null;
  return faviconForUrl(baseUrl ?? collectionUrl ?? specUrl);
}

function sourceEndpointLabel(source: ToolSourceRecord): string {
  if (source.type === "mcp") return (source.config.url as string) ?? "";
  if (source.type === "graphql") return (source.config.endpoint as string) ?? "";

  const spec = source.config.spec;
  if (typeof spec === "string" && spec.startsWith("postman:")) {
    const uid = spec.slice("postman:".length).trim();
    if (uid.length > 0) {
      return `catalog:${uid}`;
    }
    return "catalog:collection";
  }

  return (source.config.spec as string) ?? "";
}

function sourceKeyForSource(source: ToolSourceRecord): string | null {
  if (source.type === "openapi") return `source:${source.id}`;
  if (source.type === "graphql") return `source:${source.id}`;
  return null;
}

function toolSourceLabelForSource(source: ToolSourceRecord): string {
  return `${source.type}:${source.name}`;
}

function sourceForCredentialKey(sources: ToolSourceRecord[], sourceKey: string): ToolSourceRecord | null {
  const prefix = "source:";
  if (!sourceKey.startsWith(prefix)) return null;
  const sourceId = sourceKey.slice(prefix.length);
  if (!sourceId) return null;
  return sources.find((source) => source.id === sourceId) ?? null;
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

function credentialStatsForSource(source: ToolSourceRecord, credentials: CredentialRecord[]): {
  workspaceCount: number;
  actorCount: number;
} {
  const sourceKey = sourceKeyForSource(source);
  if (!sourceKey) {
    return { workspaceCount: 0, actorCount: 0 };
  }

  let workspaceCount = 0;
  let actorCount = 0;
  for (const credential of credentials) {
    if (credential.sourceKey !== sourceKey) continue;
    if (credential.scope === "workspace") workspaceCount += 1;
    if (credential.scope === "actor") actorCount += 1;
  }

  return { workspaceCount, actorCount };
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

function sanitizeSourceName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "source";
}

function withUniqueSourceName(baseName: string, takenNames: Set<string>): string {
  const loweredTaken = new Set([...takenNames].map((name) => name.toLowerCase()));
  const candidate = sanitizeSourceName(baseName);
  if (!loweredTaken.has(candidate.toLowerCase())) {
    return candidate;
  }

  let suffix = 2;
  while (true) {
    const next = `${candidate}-${suffix}`;
    if (!loweredTaken.has(next.toLowerCase())) {
      return next;
    }
    suffix += 1;
  }
}

function catalogSourceName(item: CatalogCollectionItem): string {
  const owner = sanitizeSourceName(item.providerName || "catalog");
  const title = sanitizeSourceName(item.name);
  return sanitizeSourceName(`${owner}-${title}`);
}

function AddSourceDialog({
  existingSourceNames,
}: {
  existingSourceNames: Set<string>;
}) {
  const { context } = useSession();
  const upsertToolSource = useMutation(convexApi.workspace.upsertToolSource);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"catalog" | "custom">("catalog");
  const [type, setType] = useState<"mcp" | "openapi" | "graphql">("mcp");
  const [name, setName] = useState("");
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"auto" | "streamable-http" | "sse">("auto");
  const [mcpActorQueryParamKey, setMcpActorQueryParamKey] = useState("userId");
  const [submitting, setSubmitting] = useState(false);
  const [locallyReservedNames, setLocallyReservedNames] = useState<string[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogSort, setCatalogSort] = useState<"popular" | "recent">("popular");
  const [catalogItems, setCatalogItems] = useState<CatalogCollectionItem[]>([]);
  const [catalogOffset, setCatalogOffset] = useState(0);
  const [catalogHasMore, setCatalogHasMore] = useState(true);
  const [catalogTotalCount, setCatalogTotalCount] = useState<number | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [addingCatalogId, setAddingCatalogId] = useState<string | null>(null);
  const catalogRequestIdRef = useRef(0);
  const catalogInFlightRef = useRef(false);

  const CATALOG_PAGE_SIZE = 20;

  const getTakenSourceNames = () => new Set([...existingSourceNames, ...locallyReservedNames]);

  const reserveSourceName = (sourceName: string) => {
    setLocallyReservedNames((current) =>
      current.includes(sourceName)
        ? current
        : [...current, sourceName]
    );
  };

  const getUniqueAutoSourceName = (candidate: string) => {
    return withUniqueSourceName(candidate, getTakenSourceNames());
  };

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

  const resetDialogState = () => {
    catalogRequestIdRef.current += 1;
    catalogInFlightRef.current = false;
    setView("catalog");
    setType("mcp");
    setName("");
    setEndpoint("");
    setBaseUrl("");
    setMcpTransport("auto");
    setMcpActorQueryParamKey("userId");
    setNameManuallyEdited(false);
    setLocallyReservedNames([]);
    setCatalogQuery("");
    setCatalogSort("popular");
    setCatalogItems([]);
    setCatalogOffset(0);
    setCatalogHasMore(true);
    setCatalogTotalCount(null);
    setCatalogLoading(false);
    setCatalogLoadingMore(false);
    setCatalogError(null);
    setAddingCatalogId(null);
  };

  const loadCatalogPage = async ({
    mode,
    query,
    sort,
  }: {
    mode: "reset" | "next";
    query?: string;
    sort?: "popular" | "recent";
  }) => {
    const resolvedQuery = (query ?? catalogQuery).trim();
    const resolvedSort = sort ?? catalogSort;
    const nextOffset = mode === "reset" ? 0 : catalogOffset;

    if (mode === "next") {
      if (catalogLoading || catalogLoadingMore || catalogInFlightRef.current || !catalogHasMore) {
        return;
      }
      setCatalogLoadingMore(true);
    } else {
      setCatalogLoading(true);
      setCatalogLoadingMore(false);
      setCatalogError(null);
    }

    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    catalogInFlightRef.current = true;

    try {
      const params = new URLSearchParams({
        sort: resolvedSort,
        limit: String(CATALOG_PAGE_SIZE),
        offset: String(nextOffset),
      });
      if (resolvedQuery.length > 0) {
        params.set("q", resolvedQuery);
      }

      const catalogBase = process.env.NEXT_PUBLIC_SOURCES_URL ?? "http://127.0.0.1:4343";
      const response = await fetch(`${catalogBase}/collections?${params.toString()}`, {
        cache: "no-store",
      });
      const body = await response.json() as CatalogCollectionsResponse;

      if (requestId !== catalogRequestIdRef.current) {
        return;
      }

      if (!response.ok) {
        throw new Error(body.error || "Failed to load API catalog");
      }

      const nextItems = Array.isArray(body.items) ? body.items : [];
      setCatalogItems((current) => {
        if (mode === "reset") {
          return nextItems;
        }

        const merged = [...current];
        const seen = new Set(current.map((entry) => entry.id));
        for (const item of nextItems) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          merged.push(item);
        }
        return merged;
      });
      setCatalogOffset(nextOffset + nextItems.length);
      setCatalogHasMore(typeof body.hasMore === "boolean" ? body.hasMore : nextItems.length >= CATALOG_PAGE_SIZE);
      setCatalogTotalCount(typeof body.totalCount === "number" ? body.totalCount : null);
      setCatalogError(null);
    } catch (error) {
      if (requestId !== catalogRequestIdRef.current) {
        return;
      }

      if (mode === "reset") {
        setCatalogItems([]);
        setCatalogOffset(0);
      }
      setCatalogHasMore(false);
      setCatalogTotalCount(null);
      setCatalogError(error instanceof Error ? error.message : "Failed to load API catalog");
    } finally {
      if (requestId === catalogRequestIdRef.current) {
        setCatalogLoading(false);
        setCatalogLoadingMore(false);
        catalogInFlightRef.current = false;
      }
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      resetDialogState();
      return;
    }

    resetDialogState();
    void loadCatalogPage({ mode: "reset", query: "", sort: "popular" });
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

  const handleCatalogAdd = async (item: CatalogCollectionItem) => {
    if (!item.specUrl.trim()) {
      toast.error("Missing OpenAPI spec URL for this API source");
      return;
    }

    setAddingCatalogId(item.id);
    try {
      const sourceName = getUniqueAutoSourceName(catalogSourceName(item));
      await addSource(sourceName, "openapi", {
        spec: item.specUrl,
      });
      reserveSourceName(sourceName);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add API source");
    } finally {
      setAddingCatalogId(null);
    }
  };

  const handleCustomSubmit = async () => {
    if (!context || !name.trim() || !endpoint.trim()) return;

    const takenNames = [...getTakenSourceNames()].map((entry) => entry.toLowerCase());
    if (takenNames.includes(name.trim().toLowerCase())) {
      toast.error(`Source name "${name.trim()}" already exists`);
      return;
    }

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
      reserveSourceName(name.trim());
      resetDialogState();
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
          {view === "catalog" ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  value={catalogQuery}
                  onChange={(event) => setCatalogQuery(event.target.value)}
                  placeholder="Search APIs"
                  className="h-8 text-xs font-mono bg-background flex-1 min-w-[150px]"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void loadCatalogPage({ mode: "reset" });
                    }
                  }}
                />
                <Select
                  value={catalogSort}
                  onValueChange={(value) => {
                    const nextSort = value as "popular" | "recent";
                    setCatalogSort(nextSort);
                    void loadCatalogPage({ mode: "reset", sort: nextSort });
                  }}
                >
                  <SelectTrigger className="h-8 w-[105px] text-xs bg-background shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="popular" className="text-xs">Popular</SelectItem>
                    <SelectItem value="recent" className="text-xs">Recent</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-3 text-xs shrink-0"
                  onClick={() => void loadCatalogPage({ mode: "reset" })}
                  disabled={catalogLoading}
                >
                  {catalogLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Search"}
                </Button>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Browse API collections and add them as tool sources.
                {catalogTotalCount !== null ? ` Found ${catalogTotalCount.toLocaleString()} total.` : ""}
              </p>

              <Separator />

              <div
                className="max-h-80 overflow-y-auto overflow-x-hidden space-y-1 pr-1"
                onScroll={(event) => {
                  const target = event.currentTarget;
                  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 120;
                  if (nearBottom) {
                    void loadCatalogPage({ mode: "next" });
                  }
                }}
              >
                <button
                  type="button"
                  onClick={() => setView("custom")}
                  className="w-full max-w-full overflow-hidden text-left px-3 py-2 rounded-md border border-border/70 bg-muted/40 hover:bg-accent/30 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-muted">
                      <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                    <div className="min-w-0 w-0 flex-1 overflow-hidden">
                      <p className="text-xs font-medium">Add custom source</p>
                      <p className="text-[10px] text-muted-foreground">MCP, OpenAPI, or GraphQL endpoint</p>
                    </div>
                  </div>
                </button>

                {catalogItems.map((item) => (
                  <div
                    key={item.id}
                    className="w-full max-w-full overflow-hidden flex items-start gap-2 px-2 py-2 rounded-md border border-border/50"
                  >
                    {item.logoUrl && (
                      <img
                        src={item.logoUrl}
                        alt=""
                        className="w-5 h-5 rounded shrink-0 mt-0.5 object-contain"
                        loading="lazy"
                      />
                    )}
                    <div className="flex-1 min-w-0 w-0 overflow-hidden">
                      <p className="text-xs font-medium truncate">{item.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {item.providerName}
                        {item.version ? ` · v${item.version}` : ""}
                      </p>
                      {item.summary && (
                        <div
                          className="mt-0.5 w-full min-w-0 max-w-full overflow-hidden text-[10px] text-muted-foreground/90 leading-relaxed break-words [overflow-wrap:anywhere] [&_*]:max-w-full [&_*]:min-w-0 [&_*]:break-words [&_a]:break-all [&_a]:whitespace-normal [&_code]:break-all [&_code]:whitespace-pre-wrap [&_p]:m-0 [&_pre]:max-w-full [&_pre]:overflow-x-hidden [&_pre]:whitespace-pre-wrap [&_pre]:break-words line-clamp-2"
                          style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                        >
                          <Streamdown controls={false}>{item.summary}</Streamdown>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => void handleCatalogAdd(item)}
                        disabled={Boolean(addingCatalogId)}
                      >
                        {addingCatalogId === item.id ? "Adding..." : "Add"}
                      </Button>
                    </div>
                  </div>
                ))}

                {catalogLoadingMore && (
                  <div className="flex items-center justify-center py-2 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                    Loading more...
                  </div>
                )}

                {!catalogLoading && !catalogLoadingMore && catalogItems.length === 0 && !catalogError && (
                  <p className="text-[11px] text-muted-foreground px-1 py-1">
                    No collections found for this query.
                  </p>
                )}

                {catalogError && (
                  <p className="text-[11px] text-terminal-red px-1 py-1">
                    {catalogError}
                  </p>
                )}

                {!catalogHasMore && catalogItems.length > 0 && (
                  <p className="text-[10px] text-muted-foreground/70 px-1 py-1">
                    End of results.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setView("catalog")}
              >
                <ChevronRight className="h-3.5 w-3.5 mr-1 rotate-180" />
                Back to API list
              </Button>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Type</Label>
                <Select
                  value={type}
                  onValueChange={(value) => setType(value as "mcp" | "openapi" | "graphql")}
                >
                  <SelectTrigger className="h-8 text-xs bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mcp" className="text-xs">MCP Server</SelectItem>
                    <SelectItem value="openapi" className="text-xs">OpenAPI Spec</SelectItem>
                    <SelectItem value="graphql" className="text-xs">GraphQL</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {type === "mcp" ? "Endpoint URL" : type === "graphql" ? "GraphQL Endpoint" : "Spec URL"}
                </Label>
                <Input
                  value={endpoint}
                  onChange={(event) => handleEndpointChange(event.target.value)}
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
                  onChange={(event) => handleNameChange(event.target.value)}
                  placeholder="e.g. my-service"
                  className="h-8 text-xs font-mono bg-background"
                />
              </div>

              {type === "openapi" && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Base URL (optional)</Label>
                  <Input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
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
                      onValueChange={(value) => setMcpTransport(value as "auto" | "streamable-http" | "sse")}
                    >
                      <SelectTrigger className="h-8 text-xs bg-background">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto" className="text-xs">Auto (streamable, then SSE)</SelectItem>
                        <SelectItem value="streamable-http" className="text-xs">Streamable HTTP</SelectItem>
                        <SelectItem value="sse" className="text-xs">SSE</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Anon actor query key (optional)</Label>
                    <Input
                      value={mcpActorQueryParamKey}
                      onChange={(event) => setMcpActorQueryParamKey(event.target.value)}
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
          )}
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
  credentialStats,
}: {
  source: ToolSourceRecord;
  quality?: OpenApiSourceQuality;
  qualityLoading?: boolean;
  credentialStats: { workspaceCount: number; actorCount: number };
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
  const auth = readSourceAuth(source);
  const hasAuthConfigured = auth.type !== "none";
  const totalCredentials = credentialStats.workspaceCount + credentialStats.actorCount;

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
          {hasAuthConfigured && (
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] font-mono uppercase tracking-wider",
                totalCredentials > 0
                  ? "text-terminal-green border-terminal-green/30"
                  : "text-terminal-amber border-terminal-amber/30",
              )}
            >
              creds ws:{credentialStats.workspaceCount} actor:{credentialStats.actorCount}
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
          {sourceEndpointLabel(source)}
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

type SourceOption = { source: ToolSourceRecord; key: string; label: string };

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

function sourceOptionLabel(source: ToolSourceRecord): string {
  return `${source.name} (${source.type})`;
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
    .map((source) => {
      const key = sourceKeyForSource(source);
      return {
        source,
        key,
        label: sourceOptionLabel(source),
      };
    })
    .filter((entry): entry is SourceOption => entry.key !== null);

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
                {(() => {
                  const source = sourceForCredentialKey(sources, credential.sourceKey);
                  const favicon = source ? getSourceFavicon(source) : null;
                  return (
                    <div className="h-8 w-8 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                      {favicon ? (
                        <img src={favicon} alt="" width={20} height={20} className="w-5 h-5" loading="lazy" />
                      ) : (
                        <KeyRound className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  );
                })()}
                <div className="flex-1 min-w-0">
                  {(() => {
                    const source = sourceForCredentialKey(sources, credential.sourceKey);
                    if (!source) {
                      return (
                        <p className="text-[11px] text-muted-foreground/80 font-mono mb-1">
                          {credential.sourceKey}
                        </p>
                      );
                    }
                    return (
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-sm font-mono font-medium">{source.name}</span>
                        <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                          {source.type}
                        </Badge>
                      </div>
                    );
                  })()}
                  <div className="flex items-center gap-2 flex-wrap">
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
              <Label className="text-xs text-muted-foreground">Source</Label>
              {sourceOptions.length > 0 ? (
                <Select value={sourceKey} onValueChange={handleSourceKeyChange}>
                  <SelectTrigger className="h-8 text-xs bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceOptions.map((entry) => (
                      <SelectItem key={entry.key} value={entry.key} className="text-xs">
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={sourceKey}
                  onChange={(e) => handleSourceKeyChange(e.target.value)}
                  placeholder="source:<source-id>"
                  className="h-8 text-xs font-mono bg-background"
                />
              )}
              {sourceKey && (
                <p className="text-[10px] text-muted-foreground font-mono">key: {sourceKey}</p>
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
  const sourceItems: ToolSourceRecord[] = sources ?? [];
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
    <div className="flex h-full min-h-0 flex-col gap-6">
      <PageHeader
        title="Tools"
        description="Manage sources, auth, credentials, and available tools"
      />

      <Tabs
        defaultValue={initialSource ? "inventory" : "sources"}
        className="w-full min-h-0 flex-1"
      >
        <TabsList className="bg-muted/50 h-9">
          <TabsTrigger value="sources" className="text-xs data-[state=active]:bg-background">
            Sources
            {sources && (
              <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
                {sourceItems.length}
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
                <AddSourceDialog existingSourceNames={new Set(sourceItems.map((s) => s.name))} />
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {sourcesLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-16" />
                  ))}
                </div>
              ) : sourceItems.length === 0 ? (
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
                        {warnings.slice(0, 3).map((warning: string, i: number) => (
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
                  {sourceItems.map((s) => {
                    const quality = sourceQuality[toolSourceLabelForSource(s)];
                    const credentialStats = credentialStatsForSource(s, credentials ?? []);
                    return (
                      <SourceCard
                        key={s.id}
                        source={s}
                        quality={quality}
                        qualityLoading={toolsLoading}
                        credentialStats={credentialStats}
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
            sources={sourceItems}
            credentials={credentials ?? []}
            loading={credentialsLoading || sourcesLoading}
          />
        </TabsContent>

        <TabsContent value="inventory" className="mt-4 min-h-0">
          <ToolExplorer
            tools={tools}
            sources={sourceItems}
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
